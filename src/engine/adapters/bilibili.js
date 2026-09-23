// Bilibili adapter: multi-part videos, subtitle tracks via the wbi-signed player API.
// Subtitles are only available when the uploader provided a track; otherwise an
// explicit, actionable error is raised instead of failing silently.
import { getJson, getText } from '../http.js';
import crypto from 'node:crypto';

export const id = 'bilibili';
export const name = 'Bilibili';

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];

const BILI_HEADERS = { Referer: 'https://www.bilibili.com/' };

export function match(url) {
  return /bilibili\.com\/video\//.test(url || '');
}

function bvidFrom(url) {
  const m = String(url).match(/\/video\/(BV[\w]+)/);
  return m ? m[1] : null;
}

async function getWbiMixinKey() {
  const j = await getJson('https://api.bilibili.com/x/web-interface/nav', { headers: BILI_HEADERS });
  const img = j.data?.wbi_img?.img_url;
  const sub = j.data?.wbi_img?.sub_url;
  if (!img || !sub) throw new Error('bilibili wbi keys unavailable');
  const imgKey = img.slice(img.lastIndexOf('/') + 1).split('.')[0];
  const subKey = sub.slice(sub.lastIndexOf('/') + 1).split('.')[0];
  const hex = crypto.createHash('md5').update(imgKey + subKey).digest('hex');
  let mixin = '';
  for (const i of MIXIN_KEY_ENC_TAB) mixin += hex[i];
  return mixin;
}

function wbiSign(params, mixinKey) {
  const wts = Math.floor(Date.now() / 1000);
  const all = { ...params, wts };
  const qs = Object.keys(all).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(all[k])}`).join('&');
  const wRid = crypto.createHash('md5').update(qs + mixinKey).digest('hex');
  return `${qs}&w_rid=${wRid}`;
}

/**
 * Discover lessons: one per video part (P1/P2/...).
 */
export async function discover(courseUrl, { http = {} } = {}) {
  const bvid = bvidFrom(courseUrl);
  if (!bvid) throw new Error('not a bilibili video URL: ' + courseUrl);
  const j = await getJson(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, { headers: BILI_HEADERS });
  if (j.code !== 0) throw new Error(`bilibili view error ${j.code}: ${j.message}`);
  const d = j.data;
  const pages = d.pages || [];
  return pages.map((p, i) => ({
    videoId: String(p.cid),
    bvid,
    name: p.part || d.title,
    slug: `${bvid}_p${i + 1}`,
    type: 'video',
    time: p.duration,
    week: null,
    weekName: null,
    subtopic: null,
    index: i + 1,
  }));
}

/**
 * Get captions for one part via the wbi-signed player/v2 subtitle list.
 */
export async function getCaptions(lesson, { http = {} } = {}) {
  const bvid = lesson.bvid;
  const cid = lesson.videoId;
  const mixin = await getWbiMixinKey();
  const qs = wbiSign({ bvid, cid }, mixin);
  const j = await getJson(`https://api.bilibili.com/x/player/wbi/v2?${qs}`, { headers: BILI_HEADERS });
  if (j.code !== 0) throw new Error(`bilibili player error ${j.code}: ${j.message}`);
  const subs = j.data?.subtitle?.subtitles || [];
  if (!subs.length) {
    throw new Error(`no subtitle track for part "${lesson.name}" (bilibili subtitles must be uploaded by the author; burned-in subs are not extractable)`);
  }
  // prefer zh or en track
  const track = subs.find((s) => /^(zh|en)/i.test(s.lan || '')) || subs[0];
  const text = await getText(track.subtitle_url, { headers: BILI_HEADERS });
  const data = JSON.parse(text);
  const body = data.body || [];
  return body.map((b) => ({ startInSeconds: b.from, endInSeconds: b.to, text: (b.content || '').trim() }));
}
