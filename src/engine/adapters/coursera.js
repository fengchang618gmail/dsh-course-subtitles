// Coursera adapter (experimental): requires a logged-in `CA` cookie in config.
// Without a cookie it raises an actionable error; with one it walks the standard
// onDemand materials tree to video subtitle assets. Not exercised end-to-end here.
import { getJson, request } from '../http.js';

export const id = 'coursera';
export const name = 'Coursera';

export function match(url) {
  return /coursera\.org\/(learn|specializations)/.test(url || '');
}

function slugFrom(url) {
  const m = String(url).match(/coursera\.org\/learn\/([a-z0-9-]+)/i);
  return m ? m[1] : null;
}

function cookieHeader(cookie) {
  return cookie ? { Cookie: cookie } : {};
}

export async function discover(courseUrl, { http = {}, cookie = '' } = {}) {
  const slug = slugFrom(courseUrl);
  if (!slug) throw new Error('not a coursera course URL: ' + courseUrl);
  if (!cookie) {
    throw new Error(
      'Coursera requires a login cookie: put the `CA` cookie value in config.courseraCookie (export COURSERA_COOKIE=...) and re-run.'
    );
  }
  const headers = cookieHeader(cookie);
  const meta = await getJson(`https://www.coursera.org/api/courses.v1?q=slug&slug=${slug}`, { headers, ...http });
  const courseId = meta.elements?.[0]?.id;
  if (!courseId) throw new Error('course not found for slug: ' + slug);

  const tree = await getJson(
    `https://www.coursera.org/api/onDemandCourseMaterials.v2/v1/courses/${courseId}?includes=modules%2Citems%2Cassetz%2Cvideos&fields=onDemandCourseMaterialModules.v1%2Cid%2Cslug%2Cname%2Citems%2ConDemandCourseMaterialItems.v2%2Cid%2Cslug%2Cname%2CtypeName%2Ccontent%2CtrackId%2ConDemandCourseMaterialAssets.v1%2Cid%2Cname%2CtypeName%2Cdefinition&showLockedItems=false`,
    { headers, ...http }
  );
  const linked = tree.linked || {};
  const modules = (tree.elements?.[0]?.modules || []).map((r) => linked['onDemandCourseMaterialModules.v1']?.[r.id]).filter(Boolean);
  const lessons = [];
  let week = 0;
  for (const mod of modules) {
    week++;
    const items = (mod.items || []).map((r) => linked['onDemandCourseMaterialItems.v2']?.[r.id]).filter(Boolean);
    for (const it of items) {
      if (it.typeName !== 'lecture' && it.typeName !== 'video') continue;
      const assetId = it.content?.video;
      if (!assetId) continue;
      const video = linked['videos.v1']?.[assetId];
      lessons.push({
        videoId: assetId,
        slug: it.slug || it.id,
        name: it.name,
        type: 'video',
        time: video?.duration ? Math.round(video.duration) : null,
        week,
        weekName: `Week ${week}: ${mod.name || ''}`.trim(),
        subtopic: null,
        index: lessons.length + 1,
      });
    }
  }
  if (!lessons.length) throw new Error('no lecture videos found (cookie may be expired or the course structure changed)');
  return lessons;
}

export async function getCaptions(lesson, { http = {}, cookie = '' } = {}) {
  if (!cookie) return [];
  const headers = cookieHeader(cookie);
  // subtitle asset proxy for the lecture video
  const j = await getJson(`https://www.coursera.org/api/onDemandVideos.v2/v1/videos/${lesson.videoId}?fields=subtitles`, { headers, ...http });
  const subs = j.elements?.[0]?.subtitles || [];
  const track = subs.find((s) => /^en/i.test(s.language || s.code || '')) || subs[0];
  if (!track) return [];
  const r = await request('GET', track.vttUrl || track.url, { headers });
  if (r.status < 200 || r.status >= 300) throw new Error(`GET subtitle track -> ${r.status}`);
  return parseVtt(r.body);
}

function parseVtt(vtt) {
  const out = [];
  const re = /(\d{2}:\d{2}:\d{2}[.,]\d{3}) --> (\d{2}:\d{2}:\d{2}[.,]\d{3})[^\n]*\n([\s\S]*?)(?=\n\n|\n$|$)/g;
  let m;
  while ((m = re.exec(vtt))) {
    const start = ts(m[1]);
    const end = ts(m[2]);
    const text = m[3].replace(/<[^>]+>/g, '').replace(/\n+/g, ' ').trim();
    if (text) out.push({ startInSeconds: start, endInSeconds: end, text });
  }
  return out;
}
function ts(s) {
  const [h, mi, sec] = s.replace(',', '.').split(':');
  return parseFloat(h) * 3600 + parseFloat(mi) * 60 + parseFloat(sec);
}
