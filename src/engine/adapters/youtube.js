// YouTube adapter: single video or playlist, official captions via the public
// innertube player endpoint (no API key needed for public caption tracks).
//
// Caption acquisition is layered, because YouTube increasingly answers the plain
// WEB client with "Sign in to confirm you're not a bot" (observed on this machine
// for both the player endpoint and the watch page):
//   1. innertube player endpoint (fast path, works for most videos)
//   2. the watch page's signed captionTracks
//   3. a locally installed yt-dlp (it rotates player clients and gets past the
//      bot gate that the WEB client hits) — used whenever 1/2 produced nothing
//   4. the optional `youtube-transcript` package, if it happens to be installed
// Every request goes through http.js, so the engine's proxy resolution applies
// (auto-detected; see proxy.js) — including the yt-dlp child process.
import fs from 'node:fs';
import path from 'node:path';
import { getJson, postJsonRetry, request } from '../http.js';
import { detectYtDlp, proxyConfig, proxyMode, resolveProxy, run, tmpBase, ytDlpArgs } from '../proxy.js';

export const id = 'youtube';
export const name = 'YouTube';

const INNERTUBE_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8'; // public web client key
const CLIENT = { clientName: 'WEB', clientVersion: '2.20250101.00.00', hl: 'en' };

export function match(url) {
  return /youtube\.com\/(watch|playlist|shorts)|youtu\.be\//.test(url || '');
}

function videoIdFrom(url) {
  const m = String(url).match(/[?&]v=([\w-]{11})|youtu\.be\/([\w-]{11})|shorts\/([\w-]{11})/);
  return m ? m[1] || m[2] || m[3] : null;
}

function videoIdsFrom(url) {
  const ids = [];
  const re = /[?&]v=([\w-]{11})|youtu\.be\/([\w-]{11})|shorts\/([\w-]{11})/g;
  let m;
  while ((m = re.exec(String(url)))) {
    const id = m[1] || m[2] || m[3];
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

function playlistIdFrom(url) {
  const m = String(url).match(/[?&]list=([\w-]+)/);
  return m ? m[1] : null;
}

async function innertube(endpoint, body) {
  try {
    return await postJsonRetry(`https://www.youtube.com/youtubei/v1/${endpoint}?key=${INNERTUBE_KEY}&prettyPrint=false`, {
      context: { client: CLIENT },
      ...body,
    });
  } catch (e) {
    throw new Error(`youtube api unreachable (${e.message}) — check that youtube.com is reachable from this network`);
  }
}

/**
 * Discover lessons. Playlist URL -> one lesson per video; watch URL -> single lesson.
 */
export async function discover(courseUrl, { http = {} } = {}) {
  const pid = playlistIdFrom(courseUrl);
  const vids = videoIdsFrom(courseUrl);
  const vid = vids[0] || videoIdFrom(courseUrl);
  const lessons = [];
  if (vids.length > 1) {
    for (const id of vids) lessons.push({ videoId: id, name: null, slug: id, type: 'video', time: null, week: null, weekName: null, subtopic: null, index: lessons.length + 1 });
  } else if (pid) {
    // browse the playlist ("VL" prefix) and walk continuations
    let browseId = 'VL' + pid;
    let continuation = null;
    let guard = 0;
    do {
      const body = continuation ? { continuation } : { browseId };
      const j = await innertube('browse', body);
      const raw = JSON.stringify(j);
      // videoRenderer entries carry videoId + title (+ lengthText)
      const re = /"videoRenderer":\{"videoId":"([\w-]{11})"[^}]*?"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/g;
      let m;
      while ((m = re.exec(raw))) {
        const id = m[1];
        const title = m[2].replace(/\\u0026/g, '&').replace(/\\(.)/g, '$1');
        if (!lessons.some((l) => l.videoId === id)) lessons.push({ videoId: id, name: title, slug: id, type: 'video', time: null, week: null, weekName: null, subtopic: null, index: lessons.length + 1 });
      }
      continuation = extractContinuation(j);
      guard++;
    } while (continuation && guard < 30);
    if (!lessons.length) throw new Error('playlist returned no videos (private/region-blocked?)');
  } else if (vid) {
    // A single watch URL carries no title. Resolve it here (oEmbed is not behind
    // the bot gate) so the discovered lesson — and therefore the cache entry and
    // the Feishu doc title — is complete even when the captions come from cache.
    lessons.push({ videoId: vid, name: await titleFromOembed(vid), slug: vid, type: 'video', time: null, week: null, weekName: null, subtopic: null, index: 1 });
  } else {
    throw new Error('not a YouTube video/playlist URL: ' + courseUrl);
  }
  return lessons;
}

/**
 * Video title via the public oEmbed endpoint. Unlike the player endpoint and the
 * watch page this one is not behind the "confirm you're not a bot" gate, so a
 * single-video course still gets a proper title before the caption lookup runs.
 */
async function titleFromOembed(videoId) {
  try {
    const j = await getJson(`https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`);
    return j?.title || null;
  } catch (e) {
    if (process.env.CS_DEBUG) console.error(`[cs-debug] oembed ${videoId}: ${e.message}`);
    return null;
  }
}

function extractContinuation(j) {
  try {
    const sections = j.onResponseReceivedCommands?.[0]?.appendContinuationItemsAction?.continuationItems || [];
    for (const s of sections) {
      if (s.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token) {
        return s.continuationItemRenderer.continuationEndpoint.continuationCommand.token;
      }
    }
  } catch {}
  return null;
}

/**
 * Get captions for a lesson. Routes are tried in order; the first one that
 * yields fragments wins. Throws an actionable error when every route came up
 * empty (including the proxy/yt-dlp state, which is what usually explains it).
 */
export async function getCaptions(lesson, { cfg = null } = {}) {
  if (!lesson.videoId) return [];
  const config = cfg || proxyConfig();
  const notes = [];
  let tracks = [];
  let html = null;

  try {
    const j = await innertube('player', { videoId: lesson.videoId });
    tracks = j.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    if (j.playabilityStatus?.status && j.playabilityStatus.status !== 'OK') {
      notes.push(`innertube: ${j.playabilityStatus.status}${j.playabilityStatus.reason ? ` (${j.playabilityStatus.reason})` : ''}`);
    }
    if (!lesson.name && j.videoDetails?.title) lesson.name = j.videoDetails.title;
    if (!lesson.time && j.videoDetails?.lengthSeconds) lesson.time = Number(j.videoDetails.lengthSeconds);
    if (!tracks.length && !j.playabilityStatus?.status) notes.push('innertube: no captionTracks');
  } catch (e) {
    notes.push(`innertube: ${e.message}`);
  }

  if (!tracks.length) {
    try {
      const page = await fetchWatchPage(lesson.videoId);
      tracks = page.tracks;
      html = page.html;
      if (page.cookie) for (const track of tracks) track._cookie = page.cookie;
      if (!lesson.name && page.title) lesson.name = page.title;
      if (!tracks.length) notes.push('watch page: no captionTracks in the player response');
    } catch (e) {
      notes.push(`watch page: ${e.message}`);
    }
  }

  let parsed = await downloadTracks(tracks, lesson, notes);

  // yt-dlp fallback: the WEB client's bot gate hides captionTracks entirely, but
  // yt-dlp rotates clients (tv/android/ios) and still gets the track.
  if (!parsed.length && config.youtubeYtDlp !== false) {
    try {
      parsed = await captionsFromYtDlp(lesson, config);
      if (parsed.length) notes.push('captions via yt-dlp');
    } catch (e) {
      notes.push(`yt-dlp: ${e.message}`);
    }
  }

  // Optional last resort (package may not be installed; it ignores the engine proxy).
  if (!parsed.length) {
    try {
      const { YoutubeTranscript } = await import('youtube-transcript');
      const rows = await YoutubeTranscript.fetchTranscript(lesson.videoId, { lang: 'en' });
      parsed = rows.map((row) => ({
        startInSeconds: Number(row.offset || 0) / 1000,
        endInSeconds: (Number(row.offset || 0) + Number(row.duration || 0)) / 1000,
        text: row.text || '',
      }));
      if (parsed.length) notes.push('captions via youtube-transcript');
    } catch (e) {
      notes.push(`youtube-transcript: ${e.message}`);
    }
  }

  if (process.env.CS_DEBUG) {
    console.error(`[cs-debug] youtube ${lesson.videoId}: tracks=${tracks.length} fragments=${parsed.length} html=${html ? html.length : 0} notes=${notes.join(' | ')}`);
  }
  if (!parsed.length) {
    throw new Error(`no YouTube captions for ${lesson.videoId}: ${notes.join(' | ')}${await proxyHint(config)}`);
  }
  return parsed;
}

/** Download + parse the first usable caption track of a signed track list. */
async function downloadTracks(tracks, lesson, notes) {
  if (!tracks.length) return [];
  // prefer English
  const track =
    tracks.find((t) => /^en/i.test(t.languageCode || '')) ||
    tracks.find((t) => /^en[-_]/.test(t.languageCode || '')) ||
    tracks[0];
  let url = track.baseUrl;
  if (!url) return [];
  if (!url.includes('fmt=')) url += (url.includes('?') ? '&' : '?') + 'fmt=json3';
  const headers = {
    'user-agent': 'Mozilla/5.0',
    'accept-language': 'en-US,en;q=0.9',
    referer: `https://www.youtube.com/watch?v=${lesson.videoId}`,
  };
  if (track._cookie) headers.cookie = track._cookie;
  try {
    const r = await request('GET', url, { headers, timeoutMs: 60000 });
    if (r.status < 200 || r.status >= 300) {
      notes.push(`timedtext: HTTP ${r.status}`);
      return [];
    }
    const out = parseTimedText(r.body);
    if (!out.length) notes.push(`timedtext: empty body (${r.body.length} bytes)`);
    return out;
  } catch (e) {
    notes.push(`timedtext: ${e.message}`);
    return [];
  }
}

/** Download the caption track with a locally installed yt-dlp. */
async function captionsFromYtDlp(lesson, cfg = {}) {
  const tool = await detectYtDlp(cfg);
  if (!tool) throw new Error('yt-dlp not found (install yt-dlp or set config.ytDlpPath)');
  const proxy = proxyMode(cfg) === 'off' ? null : await resolveProxy(cfg, 'www.youtube.com', 443);
  const base = tmpBase();
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, `${lesson.videoId}-`));
  try {
    const r = await run(tool.command, ytDlpArgs({ videoId: lesson.videoId, proxy: proxy?.url || null, outDir: dir }), { timeoutMs: 300000 });
    const file = ['en.json3', 'en-orig.json3'].map((f) => path.join(dir, `${lesson.videoId}.${f}`)).find((f) => fs.existsSync(f))
      || fs.readdirSync(dir).filter((f) => f.endsWith('.json3')).map((f) => path.join(dir, f))[0];
    if (!file) {
      const tail = (s) => String(s || '').split(/\r?\n/).filter(Boolean).slice(-2).join(' ');
      const detail = [tail(r.stderr), tail(r.stdout)].filter(Boolean).join(' ');
      throw new Error(detail || `yt-dlp exited with ${r.code} and produced no subtitle file`);
    }
    const parsed = parseJson3(JSON.parse(fs.readFileSync(file, 'utf8')));
    const meta = r.stdout.trim().split(/\r?\n/).filter(Boolean).pop() || '';
    const [title, duration] = meta.split('\t');
    if (!lesson.name && title) lesson.name = title.trim();
    if (!lesson.time && Number(duration) > 0) lesson.time = Math.round(Number(duration));
    if (!parsed.length) throw new Error('yt-dlp produced an empty subtitle file');
    return parsed;
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

/** One extra diagnostic line: which proxy the engine would use. */
async function proxyHint(cfg) {
  try {
    const proxy = proxyMode(cfg) === 'off' ? null : await resolveProxy(cfg, 'www.youtube.com', 443);
    const tool = await detectYtDlp(cfg);
    return ` | proxy: ${proxy ? `${proxy.url} (${proxy.source})` : 'none usable — check that v2rayN/Clash is running with its system proxy or an http inbound enabled'} | yt-dlp: ${tool ? tool.version : 'not found'}`;
  } catch (e) {
    return ` | proxy detection failed: ${e.message}`;
  }
}

async function fetchWatchPage(videoId) {
  const r = await request('GET', `https://www.youtube.com/watch?v=${videoId}&hl=en`, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
      'accept-language': 'en-US,en;q=0.9',
    },
    timeoutMs: 45000,
  });
  if (r.status < 200 || r.status >= 300) throw new Error(`YouTube watch page -> ${r.status}`);
  const html = r.body;
  const m = html.match(/"captionTracks":(\[[\s\S]*?\]),"audioTracks"/);
  let tracks = [];
  if (m) {
    try {
      tracks = JSON.parse(m[1]);
    } catch (e) {
      if (process.env.CS_DEBUG) console.error(`[cs-debug] YouTube captionTracks JSON: ${e.message}`);
    }
  }
  if (process.env.CS_DEBUG) console.error(`[cs-debug] YouTube watch page ${videoId}: bytes=${html.length} captionMatch=${!!m} tracks=${tracks.length}`);
  const tm = html.match(/<title>([\s\S]*?)<\/title>/i);
  const title = tm ? tm[1].replace(/\s*-\s*YouTube\s*$/i, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim() : null;
  const rawCookies = r.headers['set-cookie'] || [];
  const cookie = (Array.isArray(rawCookies) ? rawCookies : [rawCookies]).map((v) => String(v).split(';', 1)[0]).join('; ');
  return { tracks, title, cookie, html };
}

function parseTimedText(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('{')) {
    try {
      return parseJson3(JSON.parse(trimmed));
    } catch {
      /* fall through to XML */
    }
  }
  const out = [];
  const re = /<text start="([\d.]+)" dur="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
  let m;
  while ((m = re.exec(trimmed))) {
    const txt = m[3].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\n+/g, ' ').trim();
    if (!txt) continue;
    const start = parseFloat(m[1]);
    out.push({ startInSeconds: start, endInSeconds: start + parseFloat(m[2] || 0), text: txt });
  }
  return out;
}

/** json3 (the shape yt-dlp writes and timedtext returns with fmt=json3). */
export function parseJson3(j) {
  const out = [];
  for (const ev of j?.events || []) {
    if (!ev.segs?.length) continue;
    const txt = ev.segs.map((s) => s.utf8 || '').join('').replace(/\n+/g, ' ').trim();
    if (!txt) continue;
    const start = (ev.tStartMs || 0) / 1000;
    out.push({ startInSeconds: start, endInSeconds: start + (ev.dDurationMs || 0) / 1000, text: txt });
  }
  return out;
}
