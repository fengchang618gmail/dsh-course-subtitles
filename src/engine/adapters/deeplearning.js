// DeepLearning.AI adapter.
//
// Two course URL shapes are supported:
//   - https://learn.deeplearning.ai/courses/<slug>       (classroom: lesson tree + captions)
//   - https://www.deeplearning.ai/courses/<slug>         (home page: "Course Outline" block)
// Both share one slug, so either URL can drive captions or the outline export.
//
// Captions come from the platform-api caption.json endpoint (one light call per
// video). The Course Outline export reads the home page's "Course Outline"
// block; because that block is partly client-rendered on some courses, the
// platform lesson tree is used to verify/complete it (see discoverOutline).
import { getTextFollowRedirects, getJson } from '../http.js';
import { parseCourseOutline, outlineFromLearnPayload } from '../outline.js';
import { normalizeText } from '../text.js';

/** Lesson/frame titles arrive padded with U+3164 (HANGUL FILLER) and stray spaces. */
function cleanName(s) {
  return normalizeText(String(s ?? '').replace(/\u3164/g, ''));
}

export const NEXUS = 'https://learn.deeplearning.ai';
export const HOME = 'https://www.deeplearning.ai';

export const id = 'deeplearning';
export const name = 'DeepLearning.AI';

function splitUrl(url) {
  try {
    const u = new URL(String(url).trim());
    return { host: u.hostname.toLowerCase(), path: u.pathname.replace(/\/+$/, '') || '/', href: u.href };
  } catch {
    return { host: '', path: '', href: '' };
  }
}

/** Course slug from either URL shape ("" when the URL is not a course page). */
export function slugFromUrl(url) {
  const { path } = splitUrl(url);
  const m = path.match(/^\/(?:courses|short-courses)\/([^/]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

export function match(url) {
  const { host, path } = splitUrl(url);
  if (!host || !slugFromUrl(url)) return false;
  if (host === 'learn.deeplearning.ai') return /^\/courses\/[^/]+/.test(path);
  return host === 'www.deeplearning.ai' || host === 'deeplearning.ai';
}

export function learnCourseUrl(slug) {
  return `${NEXUS}/courses/${slug}`;
}

export function homeCourseUrls(slug) {
  return [`${HOME}/courses/${slug}`, `${HOME}/short-courses/${slug}`];
}

function extractNextData(html) {
  const m = String(html).match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('no __NEXT_DATA__ found in course page (is this a learn.deeplearning.ai course URL?)');
  return JSON.parse(m[1]);
}

/** The `course.getCourseBySlug` payload (lessons / subtopics / listing). */
export function courseDataFromHtml(html) {
  const data = extractNextData(html);
  const queries = data?.props?.pageProps?.trpcState?.json?.queries || [];
  const courseQuery = queries.find((q) => JSON.stringify(q.queryKey?.[0] ?? []) === JSON.stringify(['course', 'getCourseBySlug']));
  if (!courseQuery?.state?.data?.lessons) throw new Error('course data not found in page payload');
  return courseQuery.state.data;
}

async function fetchLearnCourse(slug, http = {}) {
  const html = await getTextFollowRedirects(learnCourseUrl(slug), http);
  return courseDataFromHtml(html);
}

/**
 * Grouping frame of one listing entry: a week, a module, or nothing.
 * `key` is stable across runs and is what the pipeline groups Feishu docs by.
 */
/** "Module 1" + "Tool use" -> "Module 1: Tool use"; missing parts never leave a dangling separator. */
function joinLabel(label, title) {
  const l = String(label || '').trim();
  const t = String(title || '').trim();
  if (!l) return t;
  if (!t) return l;
  return /[:：\-–—]$/.test(l) ? `${l} ${t}` : `${l}: ${t}`;
}

function groupOfFrame(frame, weekNumber) {
  if (!frame) return { group: null, week: null, weekName: null, module: null, moduleName: null };
  const label = cleanName(frame.moduleLabel);
  const title = cleanName(frame.name);
  if (frame.timeFrame === 'week') {
    const name = label ? joinLabel(label, title) : `Week ${weekNumber}${title ? ': ' + title : ''}`;
    return { group: { key: `week-${weekNumber}`, kind: 'week', name }, week: weekNumber, weekName: name, module: null, moduleName: null };
  }
  if (label || title) {
    const name = joinLabel(label, title);
    const key = label ? `module-${label.replace(/\s+/g, '').toLowerCase()}` : `section-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
    return { group: { key, kind: 'module', name }, week: null, weekName: name, module: label || null, moduleName: name };
  }
  return { group: null, week: null, weekName: null, module: null, moduleName: null };
}

/**
 * Discover all video lessons of a course (captions pipeline).
 * @returns {Promise<Array<{slug,name,type,videoId,time,week,weekName,module,moduleName,group,subtopic,index}>>}
 */
export async function discover(courseUrl, { http = {} } = {}) {
  const slug = slugFromUrl(courseUrl);
  if (!slug) throw new Error(`not a learn.deeplearning.ai course URL: ${courseUrl}`);

  const d = await fetchLearnCourse(slug, http);
  const lessons = d.lessons;
  const subtopics = d.subtopics || {};
  const listing = d.listing || [];

  const out = [];
  let week = 0;
  for (const frame of listing || []) {
    if (frame.timeFrame === 'week') week++;
    const info = groupOfFrame(frame, week);
    for (const item of frame.content || []) {
      let keys = [];
      if (item.type === 'subtopic') {
        const st = subtopics[item.key];
        if (!st) continue;
        keys = st.lessonKeys || [];
      } else if (item.type === 'lesson') {
        keys = [item.key];
      }
      for (const k of keys) {
        const l = lessons[k];
        if (!l) continue;
        // captions only exist for video lessons
        if (l.type !== 'video' && l.type !== 'video_notebook') continue;
        out.push({
          slug: l.slug || k,
          name: cleanName(l.name),
          type: l.type,
          videoId: l.videoId,
          time: l.time,
          week: info.week,
          weekName: info.weekName,
          module: info.module,
          moduleName: info.moduleName,
          group: info.group,
          subtopic: item.type === 'subtopic' ? cleanName(subtopics[item.key]?.name) || null : null,
          index: l.index,
        });
      }
    }
  }
  // fallback: if the listing is missing/unusable, use all video lessons in index order
  if (!out.length) {
    for (const [k, l] of Object.entries(lessons).sort((a, b) => (a[1].index || 0) - (b[1].index || 0))) {
      if (l.type !== 'video' && l.type !== 'video_notebook') continue;
      out.push({
        slug: k, name: cleanName(l.name), type: l.type, videoId: l.videoId, time: l.time,
        week: null, weekName: null, module: null, moduleName: null, group: null, subtopic: null, index: l.index,
      });
    }
  }
  out.sort((a, b) => (a.index || 0) - (b.index || 0));
  return out;
}

async function fetchHomeOutline(slug) {
  const tried = [];
  for (const url of homeCourseUrls(slug)) {
    try {
      const html = await getTextFollowRedirects(url, {});
      const outline = parseCourseOutline(html, { url });
      outline.homeUrl = url;
      return outline;
    } catch (e) {
      tried.push(`${url} (${e.message})`);
    }
  }
  throw new Error(`could not fetch the course home page: ${tried.join(', ')}`);
}

/**
 * Course Outline export: video entries only, week/module (and subtopic) blocks
 * preserved, taken from the course home page's "Course Outline" block.
 *
 * Some home pages render part of that block client-side (subtopic lists stay
 * collapsed), so by default the platform lesson tree is fetched once as well
 * and wins only when the home page is clearly incomplete.
 *
 * @param {string} courseUrl either URL shape
 * @param {{source?: 'auto'|'homepage'|'learn'}} [opts]
 */
export async function discoverOutline(courseUrl, { source = 'auto', http = {} } = {}) {
  const slug = slugFromUrl(courseUrl);
  if (!slug) throw new Error(`not a deeplearning.ai course URL: ${courseUrl}`);

  const warnings = [];
  let home = null;
  let learn = null;
  let learnError = null;

  if (source !== 'learn') {
    try {
      home = await fetchHomeOutline(slug);
      if (!home.found) warnings.push(`no "Course Outline" block found on ${home.homeUrl}`);
    } catch (e) {
      warnings.push(`home page unavailable: ${e.message}`);
    }
  }
  if (source !== 'homepage') {
    try {
      learn = outlineFromLearnPayload(await fetchLearnCourse(slug, http), { url: learnCourseUrl(slug), courseSlug: slug });
    } catch (e) {
      learnError = e;
    }
  }

  const decorate = (outline, extra) => Object.assign(outline, { slug, warnings, ...extra });

  if (source === 'homepage') {
    if (!home?.found) throw new Error(warnings[0] || `no Course Outline block found for ${slug}`);
    return decorate(home, { homeVideoCount: home.stats.videos, learnVideoCount: null });
  }
  if (source === 'learn') {
    if (!learn?.found) throw new Error(`course lesson tree unavailable for ${slug}${learnError ? `: ${learnError.message}` : ''}`);
    return decorate(learn, { homeVideoCount: null, learnVideoCount: learn.stats.videos });
  }

  const homeVideos = home?.found ? home.stats.videos : -1;
  const learnVideos = learn?.found ? learn.stats.videos : -1;

  if (home?.found && (learnVideos < 0 || homeVideos >= learnVideos)) {
    return decorate(home, { homeVideoCount: homeVideos, learnVideoCount: learnVideos < 0 ? null : learnVideos });
  }
  if (learn?.found) {
    if (!home?.found) warnings.push('home page outline unusable — built from the platform lesson tree');
    else if (homeVideos < 0) warnings.push('home page outline unusable — built from the platform lesson tree');
    else
      warnings.push(
        `home page Course Outline lists ${homeVideos} video(s) while the course has ${learnVideos} (part of that block is rendered client-side) — the platform lesson tree was used`
      );
    return decorate(learn, { homeVideoCount: homeVideos < 0 ? null : homeVideos, learnVideoCount: learnVideos });
  }
  if (home?.found) {
    warnings.push(`platform lesson tree unavailable${learnError ? `: ${learnError.message}` : ''} — home page outline used as-is`);
    return decorate(home, { homeVideoCount: homeVideos, learnVideoCount: null });
  }
  throw new Error(
    `no Course Outline could be extracted for ${slug}: ${warnings.join(' | ')}${learnError ? ` | ${learnError.message}` : ''}`
  );
}

/**
 * Get captions for a lesson: [{startInSeconds, endInSeconds, text}].
 */
export async function getCaptions(lesson, { http = {} } = {}) {
  if (!lesson.videoId) return [];
  const url = `https://platform-api.dlai.link/videos/${lesson.videoId}/caption.json?v=None`;
  const j = await getJson(url, http);
  if (j.code !== 200) throw new Error(`caption api error ${j.code}: ${j.message}`);
  return j.data?.captions || [];
}
