// Pipeline orchestrator: adapter -> captions -> (sentence segmentation) -> translation -> sections -> Feishu docs.
// Everything is cached to disk; re-runs only do the missing work (token-efficient).
//
// Two modes share the engine:
//   runPipeline        - one Feishu doc per lesson with bilingual subtitles
//   runOutlinePipeline - one Feishu doc listing the course outline (video entries
//                        with their links, grouped by week/module)
import path from 'node:path';
import fs from 'node:fs';
import { makeCache } from './cache.js';
import { pickAdapter } from './adapters/index.js';
import { translateLines, translateTitle } from './translate.js';
import { generateSections, normalizeSectionStarts } from './sections.js';
import { segmentSentences } from './segment.js';
import { makeFeishuClient, buildDocBlocks, buildOutlineBlocks, resolveSpaceId, feishuWikiUrl, richTextBlock, textRun } from './feishu.js';
import { configureProxy, proxySummary } from './proxy.js';
import { parseLessonRange, feishuTokenFrom } from './config.js';
import { sanitizeText, endsWithSentenceEnd } from './text.js';
import { filterOutline, outlineToReport, DEFAULT_TYPES } from './outline.js';

/** Titles are compared with collapsed whitespace so padding never creates a duplicate doc. */
function normTitle(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/** Grouping frame of a lesson: the week/module block its Feishu doc belongs to. */
function lessonGroup(cfg, lesson) {
  if (lesson.group?.key) {
    const override =
      cfg.groupNames?.[lesson.group.key] ||
      cfg.groupNames?.[lesson.group.name] ||
      (lesson.week != null ? cfg.weekNames?.[lesson.week] : undefined);
    return { key: lesson.group.key, kind: lesson.group.kind, name: override || lesson.group.name };
  }
  if (lesson.week != null) {
    return { key: `week-${lesson.week}`, kind: 'week', name: cfg.weekNames?.[lesson.week] || lesson.weekName || `Week ${lesson.week}` };
  }
  if (lesson.module) {
    return { key: `module-${lesson.module}`, kind: 'module', name: lesson.moduleName || lesson.module };
  }
  return null;
}

export async function runPipeline(cfg, { onEvent = () => {} } = {}) {
  configureProxy(cfg);
  const cache = makeCache(cfg.cacheDir || path.join(process.cwd(), '.course-subtitles-cache'));
  const adapter = pickAdapter(cfg.courseUrl);
  const courseKey = String(cfg.courseUrl).replace(/[^a-z0-9]+/gi, '_').slice(0, 80);

  onEvent({ type: 'adapter', adapter: adapter.id });
  // Report the network route this run will take (proxy auto-detection + yt-dlp),
  // so a GUI run says *why* a platform is or is not reachable.
  let proxy = null;
  if (adapter.id === 'youtube') {
    try {
      proxy = await proxySummary(cfg);
      onEvent({ type: 'proxy', ...proxy });
    } catch (e) {
      onEvent({ type: 'warning', message: `proxy detection failed: ${e.message}` });
    }
  }

  // 1) discover
  const discoverKey = `discover:${adapter.id}:${courseKey}:v4`;
  let lessons = cache.get(discoverKey);
  if (!lessons || cfg.force) {
    lessons = await adapter.discover(cfg.courseUrl, { cookie: cfg.courseraCookie });
    cache.set(discoverKey, lessons);
  }
  const wanted = parseLessonRange(cfg.lessons);
  const videos = lessons.filter((l, i) => !wanted.size || wanted.has(i + 1));
  onEvent({ type: 'discovered', total: lessons.length, selected: videos.length });

  // 2) per lesson: captions -> translate -> sections -> feishu
  const report = { adapter: adapter.id, course: cfg.courseUrl, proxy, lessons: [] };
  const client = cfg.skipFeishu || cfg.dryRun ? null : makeFeishuClient(cfg);
  const spaceId = client ? await resolveSpaceId(cfg, client) : null;
  if (client) cfg.feishuSpaceId = spaceId;

  // week/module nodes (grouping)
  const groupNodes = {}; // group key -> node token
  const groups = new Map(); // group key -> display name (document order)
  for (const l of videos) {
    const g = lessonGroup(cfg, l);
    if (g && !groups.has(g.key)) groups.set(g.key, g.name);
  }
  if (client && cfg.groupByWeek !== false) {
    const parent = feishuTokenFrom(cfg.feishuParent);
    const children = await client.listChildren(parent);
    for (const [key, name] of groups) {
      const existing = children.find((c) => normTitle(c.title) === normTitle(name));
      if (existing) {
        groupNodes[key] = existing.node_token;
      } else {
        const docId = await client.createDoc(name);
        await client.addBlocks(docId, []);
        groupNodes[key] = await client.moveToWiki(docId, parent, name);
      }
      onEvent({ type: 'group', key, name, node: groupNodes[key] });
    }
  }

  for (let i = 0; i < videos.length; i++) {
    const lesson = videos[i];
    const configuredTitle = cfg.lessonTitles?.[lesson.slug || lesson.videoId];
    if (configuredTitle) lesson.name = configuredTitle;
    const seq = i + 1;
    try {
      const entry = await processLesson({ cfg, cache, adapter, client, lesson, seq, spaceId, groupNodes, courseKey, onEvent });
      report.lessons.push(entry);
    } catch (e) {
      onEvent({ type: 'error', seq, lesson: lesson.name, error: e.message });
      report.lessons.push({ seq, lesson: lesson.name, error: e.message });
    }
  }
  // An adapter can enrich a discovered lesson while fetching captions (the
  // youtube adapter fills in the duration). Persist that, so an all-cache re-run
  // still titles the document and renders the meta line correctly.
  if (lessons.some((l) => l.name || l.time)) cache.set(discoverKey, lessons);
  onEvent({ type: 'done', report });
  return report;
}

/**
 * Course Outline mode: read the course home page's "Course Outline" block, keep
 * the requested entry types (default: videos) and their links, keep the
 * week/module nesting, and publish ONE Feishu doc listing them.
 */
export async function runOutlinePipeline(cfg, { onEvent = () => {} } = {}) {
  configureProxy(cfg);
  const adapter = pickAdapter(cfg.courseUrl);
  if (typeof adapter.discoverOutline !== 'function') {
    throw new Error(`the ${adapter.id} adapter cannot export a course outline yet (supported: deeplearning)`);
  }
  onEvent({ type: 'adapter', adapter: adapter.id, mode: 'outline' });

  const outline = await adapter.discoverOutline(cfg.courseUrl, { source: cfg.outlineSource || 'auto' });
  for (const message of outline.warnings || []) onEvent({ type: 'warning', message });

  const types = normalizeTypes(cfg.outlineTypes);
  const filtered = filterOutline(outline, { types, includeSubtopics: cfg.outlineIncludeSubtopics !== false });
  onEvent({
    type: 'outline',
    source: outline.source,
    sourceUrl: outline.sourceUrl,
    groups: filtered.stats.groups,
    subtopics: filtered.stats.subgroups,
    videos: filtered.stats.videos,
    skipped: filtered.skipped,
  });
  if (!filtered.stats.videos) {
    throw new Error(`no ${types.join('/')} entries found in the Course Outline of ${outline.sourceUrl || cfg.courseUrl}`);
  }

  const docTitle = cfg.outlineTitle || `${outline.courseTitle || 'Course'} · Course Outline 课程大纲`;
  const meta = outlineMeta(filtered, outline);
  const withLinks = cfg.outlineLinks === true;
  const blocks = buildOutlineBlocks({ outline: filtered, docTitle, meta, links: withLinks });
  if (outline.warnings?.length) {
    blocks.splice(2, 0, richTextBlock([textRun(`注：${outline.warnings.join('；')}`)]));
  }

  const report = {
    mode: 'outline',
    adapter: adapter.id,
    course: cfg.courseUrl,
    source: outline.source,
    sourceUrl: outline.sourceUrl,
    homeUrl: outline.homeUrl ?? null,
    homeVideoCount: outline.homeVideoCount ?? null,
    learnVideoCount: outline.learnVideoCount ?? null,
    docTitle,
    types,
    links: withLinks,
    warnings: outline.warnings || [],
    stats: filtered.stats,
    skipped: filtered.skipped,
    groups: outlineToReport(filtered).groups,
    blocks: blocks.length,
    status: 'dry-run',
  };

  if (cfg.dryRun || cfg.skipFeishu) {
    onEvent({ type: 'preview', mode: 'outline', docTitle, blocks: blocks.length, videos: filtered.stats.videos });
    return report;
  }

  const client = makeFeishuClient(cfg);
  cfg.feishuSpaceId = await resolveSpaceId(cfg, client);
  const parent = feishuTokenFrom(cfg.feishuParent);
  if (!parent) throw new Error('feishuParent is not configured — pass a Feishu wiki/doc link or token');

  const children = await client.listChildren(parent);
  const existing = children.find((c) => normTitle(c.title) === normTitle(docTitle));
  const rebuild = !!(cfg.force || cfg.updateDoc);
  if (existing && !rebuild) {
    const url = feishuWikiUrl(existing.node_token, cfg);
    onEvent({ type: 'skipped', mode: 'outline', docTitle, url });
    return { ...report, status: 'skipped', docId: existing.obj_token, nodeToken: existing.node_token, url };
  }

  // rebuild the existing doc in place so its URL keeps working
  if (existing && existing.obj_token) {
    try {
      const added = await client.replaceBlocks(existing.obj_token, blocks);
      if (existing.node_token && existing.title !== docTitle) {
        try { await client.updateNodeTitle(existing.node_token, docTitle); } catch { /* best effort */ }
      }
      const url = feishuWikiUrl(existing.node_token, cfg);
      onEvent({ type: 'updated', mode: 'outline', docTitle, url });
      return { ...report, status: 'updated', docId: existing.obj_token, nodeToken: existing.node_token, url, added };
    } catch (e) {
      onEvent({ type: 'warning', mode: 'outline', docTitle, message: `in-place rebuild failed (${e.message}); recreating the doc` });
    }
  }

  const docId = await client.createDoc(docTitle);
  const added = await client.addBlocks(docId, blocks);
  const nodeToken = await client.moveToWiki(docId, parent, docTitle);
  if (existing && rebuild) {
    try {
      await client.deleteDoc(existing.obj_token);
    } catch { /* the wiki node is already replaced; ignore stale-doc cleanup failures */ }
  }
  const url = feishuWikiUrl(nodeToken, cfg);
  onEvent({ type: 'created', mode: 'outline', docTitle, url });
  return { ...report, status: 'created', docId, nodeToken, url, added };
}

/** Requested outline entry types: array, comma-separated string, or empty -> ['video']. */
function normalizeTypes(spec) {
  const list = Array.isArray(spec) ? spec : String(spec ?? '').split(',');
  const cleaned = list.map((t) => String(t).trim()).filter(Boolean);
  return cleaned.length ? cleaned : [...DEFAULT_TYPES];
}

function outlineMeta(outline, source) {
  const parts = [`视频清单 · 来源：${source.sourceUrl || ''}`];
  parts.push(`${outline.stats.groups} 个章节 / ${outline.stats.videos} 个视频`);
  if (outline.stats.subgroups) parts.push(`${outline.stats.subgroups} 个小节`);
  if (outline.skipped) parts.push(`已过滤 ${outline.skipped} 条非视频条目`);
  parts.push(`收录类型：${(outline.types || DEFAULT_TYPES).join(', ')}`);
  parts.push(`生成时间：${new Date().toISOString().slice(0, 10)}`);
  return parts.join(' · ');
}

async function processLesson({ cfg, cache, adapter, client, lesson, seq, spaceId, groupNodes, courseKey, onEvent }) {
  const slug = lesson.slug || String(lesson.videoId || seq);
  const baseKey = `${adapter.id}:${courseKey}:${slug}`;
  const segOn = cfg.segmentSentences !== false;

  // captions
  const captionsKey = `captions:${baseKey}`;
  let captions = cache.get(captionsKey);
  if (!captions || cfg.force) {
    captions = await adapter.getCaptions(lesson, { cookie: cfg.courseraCookie, cfg });
    if (!captions.length) throw new Error('no captions available for this video');
    cache.set(captionsKey, captions);
  }
  const fragments = captions.map((c) => ({ text: sanitizeText(c.text || ''), startInSeconds: c.startInSeconds, endInSeconds: c.endInSeconds }));

  // sentence segmentation (merge caption fragments into complete sentences)
  // v2: units are complete sentences, so a paragraph never ends mid-sentence
  let segments = null;
  if (segOn && !cfg.skipTranslate) {
    const segKey = `segments:${baseKey}:v2`;
    segments = cache.get(segKey);
    if (!segments || cfg.force) {
      onEvent({ type: 'segment', seq, lesson: lesson.name, fragments: fragments.length });
      segments = await segmentSentences(cfg, fragments, {
        onInfo: (info) => onEvent({ type: 'segment-method', seq, lesson: lesson.name, ...info }),
      });
      cache.set(segKey, segments);
    }
  }

  // the cache tag follows the basis actually used for the lines below, so a
  // translation/section cache can never be reused against a different basis
  const segTag = segments ? ':seg2' : ':raw';

  // translation source: sentences (segmented) or raw fragments
  const enLines = segments ? segments.map((s) => s.text) : fragments.map((f) => f.text);

  // translation
  let pairs = null;
  if (cfg.skipTranslate) {
    pairs = enLines.map((en) => ({ en, zh: '' }));
  } else {
    const trKey = `bilingual:${baseKey}:${cfg.llmModel}${segTag}`;
    pairs = cache.get(trKey);
    if (!pairs || pairs.length !== enLines.length || cfg.force) {
      onEvent({ type: 'translate', seq, lesson: lesson.name, lines: enLines.length, segmented: !!segments });
      pairs = await translateLines(cfg, enLines, {
        onProgress: (done, total) => onEvent({ type: 'translate-progress', seq, done, total }),
      });
      cache.set(trKey, pairs);
    }
  }

  // sections
  let sections = [];
  if (!cfg.skipSections) {
    const secKey = `sections:${baseKey}:${cfg.llmModel}${segTag}`;
    sections = cache.get(secKey);
    if (!sections || cfg.force) {
      onEvent({ type: 'sections', seq, lesson: lesson.name });
      sections = await generateSections(cfg, enLines);
      cache.set(secKey, sections);
    }
    // a heading may only start where the previous paragraph ends its sentence,
    // so a section title can never appear inside a sentence
    const before = sections.length;
    sections = normalizeSectionStarts(pairs, sections, {
      onAdjust: (moved) => onEvent({ type: 'sections-moved', seq, lesson: lesson.name, moved: moved.length }),
    });
    if (sections.length !== before) {
      onEvent({ type: 'sections-dropped', seq, lesson: lesson.name, dropped: before - sections.length });
    }
  }

  // feishu
  const zhTitles = loadZhTitles(cfg);
  let zhName = sanitizeText(zhTitles[lesson.slug] || '');
  // auto-translate title if no pre-configured Chinese title
  if (!zhName && !cfg.skipTranslate) {
    const titleTrKey = `title:${baseKey}`;
    zhName = cache.get(titleTrKey);
    if (!zhName || cfg.force) {
      onEvent({ type: 'translate-title', seq, lesson: lesson.name });
      zhName = await translateTitle(cfg, lesson.name);
      cache.set(titleTrKey, zhName);
    }
  }
  const group = lessonGroup(cfg, lesson);
  const parts = [cfg.courseDisplayName || 'Course'];
  if (group) parts.push(group.name);
  parts.push(`视频时长 ${fmt(lesson.time)}`);
  const meta = parts.join(' · ');
  const blocks = buildDocBlocks({ lesson: { ...lesson, zhName }, pairs, sections, meta });

  let result = { seq, slug, name: lesson.name, zhName, pairs: pairs.length, blocks: blocks.length, sections: sections.length, segments: segments ? segments.length : null, incompleteEnds: segments ? segments.filter((s) => !endsWithSentenceEnd(s.text)).length : null, week: lesson.week ?? null, group: group?.name ?? null };
  if (client && !cfg.dryRun) {
    const parent = group && groupNodes[group.key] ? groupNodes[group.key] : feishuTokenFrom(cfg.feishuParent);
    const title = `${String(seq).padStart(2, '0')} ${lesson.name}${zhName ? ' ' + zhName : ''}`;
    // idempotency
    const children = await client.listChildren(parent);
    const existing = children.find((c) => normTitle(c.title) === normTitle(title));
    const rebuild = !!(cfg.force || cfg.updateDoc);
    if (existing && !rebuild) {
      result = { ...result, status: 'skipped', url: feishuWikiUrl(existing.node_token, cfg) };
      onEvent({ type: 'skipped', seq, lesson: lesson.name });
      return result;
    }
    // rebuild an existing doc in place: the wiki URL keeps working
    if (existing && existing.obj_token) {
      try {
        const added = await client.replaceBlocks(existing.obj_token, blocks);
        if (existing.node_token && existing.title !== title) {
          try { await client.updateNodeTitle(existing.node_token, title); } catch { /* best effort */ }
        }
        result = { ...result, status: 'updated', docId: existing.obj_token, nodeToken: existing.node_token, url: feishuWikiUrl(existing.node_token, cfg), added };
        onEvent({ type: 'updated', seq, lesson: lesson.name, url: result.url });
        return result;
      } catch (e) {
        onEvent({ type: 'warning', seq, lesson: lesson.name, message: `in-place rebuild failed (${e.message}); recreating the doc` });
      }
    }
    const docId = await client.createDoc(title);
    const added = await client.addBlocks(docId, blocks);
    const nodeToken = await client.moveToWiki(docId, parent, title);
    if (existing && rebuild) {
      try {
        await client.deleteDoc(existing.obj_token);
      } catch {}
    }
    result = { ...result, status: 'created', docId, nodeToken, url: feishuWikiUrl(nodeToken, cfg), added };
    onEvent({ type: 'created', seq, lesson: lesson.name, url: result.url });
  } else {
    result = { ...result, status: 'dry-run' };
    onEvent({ type: 'preview', seq, lesson: lesson.name, blocks: blocks.length });
  }
  return result;
}

function fmt(sec) {
  if (!sec && sec !== 0) return '--:--';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function loadZhTitles(cfg) {
  if (cfg.zhTitles && Object.keys(cfg.zhTitles).length) return cfg.zhTitles;
  // built-in seed for the default course (deeplearning: generative-ai-for-everyone)
  try {
    const f = new URL('../data/zh_titles.json', import.meta.url);
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {}
  return {};
}
