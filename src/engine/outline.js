// Course Outline extraction: read the "Course Outline" block of a course home
// page (e.g. www.deeplearning.ai/courses/<slug>), keep the video entries only,
// and preserve the week/module (and optional subtopic) nesting of that page.
//
// Output shape (stable, JSON-serializable — also what the CLI/host report):
//   {
//     found, source: 'homepage'|'learn', sourceUrl, courseTitle,
//     groups: [
//       { kind: 'week'|'module'|'section'|null, title,
//         children: [ item | { kind:'subgroup', title, children: [item] } ],
//         items: [item], subgroups: [subgroup] }
//     ],
//     stats: { groups, subgroups, items, videos, skipped }
//   }
// item = { seq, text, url, type, duration }
import { stripTags, attr, absolutize, balancedInner, regionAfterHeading, findJsonLd } from './html.js';
import { sanitizeText, normalizeText } from './text.js';

export const DEFAULT_TYPES = ['video'];

const LEARN = 'https://learn.deeplearning.ai';
const HOME = 'https://www.deeplearning.ai';

/** One left-to-right scan of the outline region: groups, subtopics, entries. */
const SCAN_RE =
  /<details\b[^>]*>|<\/details\s*>|<span\b[^>]*\bsubtitle[0-9]\b[^>]*>([\s\S]*?)<\/span>|<a\b([^>]*)>([\s\S]*?)<\/a>/gi;

const GROUP_KINDS = [
  [/^week\b/i, 'week'],
  [/^module\b/i, 'module'],
  [/^(unit|chapter|part|section|day|stage)\b/i, 'section'],
];

/** Lesson-type labels of the learn.deeplearning.ai payload -> home-page labels. */
const LEARN_TYPE_LABELS = {
  video: 'Video',
  video_notebook: 'Video',
  reading_material: 'Reading',
  reading: 'Reading',
  quiz: 'Graded・Quiz',
  notebook: 'Code Example',
  paid_notebook: 'Code Example',
  graded_notebook: 'Graded・Code Assignment',
};

export function groupKindFromTitle(title) {
  const t = normalizeText(title);
  for (const [re, kind] of GROUP_KINDS) if (re.test(t)) return kind;
  return null;
}

/** True for the "Video" / "Video (optional)" / "video_notebook" labels. */
export function isVideoType(type) {
  const t = normalizeText(type).toLowerCase().replace(/[\s_-]+/g, '_');
  if (!t) return false;
  if (t === 'video' || t === 'videos' || t === 'video_notebook') return true;
  return /^videos?_/.test(t); // "video_(optional)"
}

function normType(s) {
  return normalizeText(s).toLowerCase().replace(/\s+/g, ' ');
}

/** Does an item's type label count as one of the requested types? */
export function matchesType(type, wanted) {
  const w = normType(wanted);
  if (!w || w === 'all' || w === '*') return true;
  const t = normType(type);
  if (t === w) return true;
  if (t.startsWith(`${w} `)) return true; // "Video (optional)" matches "video"
  return t.replace(/[\s_-]+/g, '') === w.replace(/[\s_-]+/g, '');
}

function emptyStats() {
  return { groups: 0, subgroups: 0, items: 0, videos: 0, skipped: 0 };
}

// DeepLearning.AI pads some course titles with U+3164 (HANGUL FILLER) for looks;
// it is invisible in HTML but would ride along in JSON-sourced titles.
function cleanTitle(value) {
  return sanitizeText(String(value ?? '').replace(/\u3164/g, ''));
}

function makeGroup(title) {
  return { kind: groupKindFromTitle(title), title: cleanTitle(title), children: [], items: [], subgroups: [] };
}

function makeSubgroup(title) {
  return { kind: 'subgroup', title: cleanTitle(title), children: [], items: [] };
}

export function computeStats(outline) {
  let groups = 0;
  let subgroups = 0;
  let items = 0;
  let videos = 0;
  for (const g of outline.groups || []) {
    groups++;
    for (const it of g.items || []) {
      items++;
      if (isVideoType(it.type)) videos++;
    }
    for (const s of g.subgroups || []) {
      subgroups++;
      for (const it of s.items || []) {
        items++;
        if (isVideoType(it.type)) videos++;
      }
    }
  }
  return { groups, subgroups, items, videos, skipped: items - videos };
}

/** Parse one `<a>` entry: linked title + meta label ("Video・1m") from its body. */
function parseAnchor(attrs, inner, base) {
  const href = absolutize(attr(attrs, 'href'), base);
  if (!href || /^(javascript:|#)/i.test(href)) return null;

  let body = inner;
  let type = '';
  let duration = '';
  const labelWord = /\blabel1\b/i.exec(body);
  if (labelWord) {
    const start = body.lastIndexOf('<div', labelWord.index);
    const label = start >= 0 ? balancedInner(body, start, 'div') : null;
    if (label) {
      const parts = stripTags(label.inner)
        .split('・')
        .map((p) => p.trim())
        .filter(Boolean);
      type = parts[0] || '';
      if (parts.length > 1) duration = parts[parts.length - 1];
      body = `${body.slice(0, label.start)} ${body.slice(label.end)}`;
    }
  }

  const text = stripTags(body);
  if (!text) return null;
  // A real outline entry carries the meta label or links to a lesson page;
  // anything else (e.g. "Download the syllabus") is not a course item.
  if (!labelWord && !/\/lesson\//.test(href)) return null;

  return { seq: 0, text, url: href, type: normalizeText(type), duration: normalizeText(duration) };
}

function assignSeq(outline) {
  let seq = 0;
  for (const g of outline.groups) {
    for (const it of g.items) it.seq = ++seq;
    for (const s of g.subgroups) for (const it of s.items) it.seq = ++seq;
  }
  return outline;
}

/**
 * Parse the Course Outline block of a course home page.
 * @param {string} html course home page markup
 * @param {{url?:string, base?:string}} [opts]
 */
export function parseCourseOutline(html, { url = '', base = HOME } = {}) {
  const src = String(html ?? '');
  const ldCourse = findJsonLd(src, 'Course');
  let courseTitle = cleanTitle(ldCourse?.name || '');
  const region = regionAfterHeading(src, /^course outline$/i);

  if (!region) {
    return { found: false, source: 'homepage', sourceUrl: url, courseTitle, groups: [], stats: emptyStats() };
  }
  if (!courseTitle) {
    const h3 = region.text.match(/<h3\b[^>]*>([\s\S]*?)<\/h3\s*>/i);
    courseTitle = h3 ? cleanTitle(stripTags(h3[1])) : '';
  }

  const groups = [];
  const stack = []; // currently open <details> groups (innermost last)
  let subgroup = null; // current subtopic of the innermost open group
  let loose = null; // entries that appear outside any group

  const owner = () => stack[stack.length - 1] || loose;

  const openGroup = (index) => {
    let title = '';
    const summaryRel = src.slice(index).match(/<summary\b[^>]*>/i);
    if (summaryRel) {
      const summary = balancedInner(src, index + summaryRel.index, 'summary');
      if (summary) title = stripTags(summary.inner);
    }
    const group = makeGroup(title);
    const parent = owner();
    if (parent && parent !== group) {
      // nested <details> (e.g. a week inside a module) becomes a subtopic block
      const sub = makeSubgroup(title);
      sub._group = group;
      parent.subgroups.push(sub);
      parent.children.push(sub);
      group._sub = sub;
    } else {
      groups.push(group);
    }
    stack.push(group);
    subgroup = null;
  };

  const closeGroup = () => {
    const group = stack.pop();
    if (!group) return;
    if (group._sub) {
      // promote the nested group's content into its subtopic wrapper
      group._sub.children = group.children;
      group._sub.items = group.items;
    }
    subgroup = null;
  };

  SCAN_RE.lastIndex = 0;
  let hit;
  while ((hit = SCAN_RE.exec(src))) {
    if (hit.index < region.start) continue;
    const raw = hit[0];
    if (/^<\/details/i.test(raw)) {
      closeGroup();
      continue;
    }
    if (/^<details/i.test(raw)) {
      openGroup(hit.index);
      continue;
    }
    if (hit[1] !== undefined) {
      // subtopic marker
      const ownerGroup = stack[stack.length - 1];
      if (!ownerGroup) continue;
      subgroup = makeSubgroup(stripTags(hit[1]));
      if (!subgroup.title) {
        subgroup = null;
        continue;
      }
      ownerGroup.subgroups.push(subgroup);
      ownerGroup.children.push(subgroup);
      continue;
    }
    if (hit[2] !== undefined) {
      const item = parseAnchor(hit[2], hit[3], base);
      if (!item) continue;
      let group = stack[stack.length - 1];
      if (!group) {
        if (!loose) {
          loose = makeGroup(courseTitle || 'Course');
          groups.push(loose);
        }
        group = loose;
      }
      if (subgroup && group.subgroups.includes(subgroup)) {
        subgroup.items.push(item);
        subgroup.children.push(item);
      } else {
        group.items.push(item);
        group.children.push(item);
      }
    }
  }

  // ---- fallback for pages that do not use one <details> per block: headings
  if (!groups.length) {
    const headingRe = /<h([3-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi;
    const marks = [];
    let h;
    while ((h = headingRe.exec(region.text))) {
      const title = stripTags(h[2]);
      if (title && title !== courseTitle) marks.push({ index: h.index, title });
    }
    const fallbackGroups = marks.map((mk) => makeGroup(mk.title));
    if (!fallbackGroups.length) fallbackGroups.push(makeGroup(courseTitle || 'Course'));
    const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
    let a;
    while ((a = anchorRe.exec(region.text))) {
      const item = parseAnchor(a[1], a[2], base);
      if (!item) continue;
      let idx = -1;
      for (let i = 0; i < marks.length; i++) if (a.index > marks[i].index) idx = i;
      const target = fallbackGroups[Math.min(idx + 1, fallbackGroups.length - 1)] || fallbackGroups[0];
      target.items.push(item);
      target.children.push(item);
    }
    groups.push(...fallbackGroups.filter((g) => g.items.length));
  }

  const cleaned = groups
    .map((g) => {
      const children = g.children.filter((c) => (c.kind === 'subgroup' ? c.items.length > 0 : true));
      const subgroups = g.subgroups.filter((s) => s.items.length > 0);
      return { kind: g.kind, title: g.title, children, items: g.items, subgroups };
    })
    .filter((g) => g.items.length || g.subgroups.length);

  const outline = { found: cleaned.length > 0, source: 'homepage', sourceUrl: url, courseTitle, groups: cleaned, stats: emptyStats() };
  outline.stats = computeStats(outline);
  return assignSeq(outline);
}

/** learn.deeplearning.ai lesson URLs use lowercased, percent-encoded name slugs. */
export function slugifyName(name) {
  return encodeURIComponent(sanitizeText(name || '').toLowerCase()).replace(/%20/g, '-');
}

/**
 * Build an outline from a learn.deeplearning.ai course payload (its `lessons`,
 * `subtopics` and `listing` tree) — the fallback when a course home page has no
 * Course Outline block. Lesson types are mapped onto the home-page labels.
 */
export function outlineFromLearnPayload(payload, { url = '', courseSlug = '' } = {}) {
  const lessons = payload?.lessons || {};
  const subtopics = payload?.subtopics || {};
  const listing = payload?.listing || [];
  const slug = courseSlug || payload?.slug || '';
  const groups = [];
  let week = 0;

  const makeItem = (key, lesson) => ({
    seq: 0,
    text: cleanTitle(lesson.name || ''),
    url: `${LEARN}/courses/${slug}/lesson/${key}/${slugifyName(lesson.name)}`,
    type: LEARN_TYPE_LABELS[lesson.type] || normalizeText(lesson.type || ''),
    duration: lesson.time ? `${Math.max(1, Math.round(lesson.time / 60))}m` : '',
  });

  for (const frame of listing) {
    let label = cleanTitle(frame.name || '');
    if (frame.moduleLabel) label = `${frame.moduleLabel}: ${frame.name}`;
    else if (frame.timeFrame === 'week') {
      week++;
      label = `Week ${week}${frame.name ? ': ' + frame.name : ''}`;
    }
    const group = makeGroup(label);
    if (frame.timeFrame === 'week') group.kind = 'week';
    for (const entry of frame.content || []) {
      if (entry.type === 'subtopic') {
        const st = subtopics[entry.key];
        if (!st) continue;
        const sub = makeSubgroup(st.name || '');
        for (const key of st.lessonKeys || []) {
          const lesson = lessons[key];
          if (lesson) {
            sub.items.push(makeItem(key, lesson));
            sub.children.push(sub.items[sub.items.length - 1]);
          }
        }
        if (sub.items.length) {
          group.subgroups.push(sub);
          group.children.push(sub);
        }
        continue;
      }
      const lesson = lessons[entry.key];
      if (!lesson) continue;
      const item = makeItem(entry.key, lesson);
      group.items.push(item);
      group.children.push(item);
    }
    if (group.items.length || group.subgroups.length) groups.push(group);
  }

  if (!groups.length) {
    const group = makeGroup(payload?.name || 'Course');
    const entries = Object.entries(lessons).sort((a, b) => (a[1].index || 0) - (b[1].index || 0));
    for (const [key, lesson] of entries) {
      const item = makeItem(key, lesson);
      group.items.push(item);
      group.children.push(item);
    }
    if (group.items.length) groups.push(group);
  }

  const outline = {
    found: groups.length > 0,
    source: 'learn',
    sourceUrl: url,
    courseTitle: cleanTitle(payload?.name || ''),
    groups,
    stats: emptyStats(),
  };
  outline.stats = computeStats(outline);
  return assignSeq(outline);
}

/** Keep only the requested types (default: video) while preserving the nesting. */
export function filterOutline(outline, { types = DEFAULT_TYPES, includeSubtopics = true } = {}) {
  const wanted = (Array.isArray(types) ? types : [types]).map((t) => String(t)).filter(Boolean);
  const keep = (item) => wanted.some((t) => matchesType(item.type, t));

  const filterChildren = (children) => {
    const out = [];
    for (const child of children || []) {
      if (child.kind === 'subgroup') {
        const keptItems = child.items.filter(keep);
        if (!keptItems.length) continue;
        // without the subtopic level the entries move up under their week/module
        if (includeSubtopics) out.push({ ...child, children: keptItems, items: keptItems });
        else out.push(...keptItems);
      } else if (keep(child)) {
        out.push(child);
      }
    }
    return out;
  };

  const groups = (outline.groups || [])
    .map((g) => {
      const children = filterChildren(g.children?.length ? g.children : [...(g.items || []), ...(g.subgroups || [])]);
      return {
        ...g,
        kind: g.kind ?? groupKindFromTitle(g.title),
        children,
        items: children.filter((c) => c.kind !== 'subgroup'),
        subgroups: children.filter((c) => c.kind === 'subgroup'),
      };
    })
    .filter((g) => g.children.length);

  const filtered = { ...outline, groups, types: wanted, includeSubtopics };
  filtered.stats = computeStats(filtered);
  filtered.skipped = Math.max(0, (outline.stats?.items || 0) - filtered.stats.items);
  return filtered;
}

/** Flatten a (filtered) outline to rows: [{ group, subgroup, item }]. */
export function flattenOutline(outline) {
  const rows = [];
  for (const g of outline.groups || []) {
    for (const it of g.items || []) rows.push({ group: g.title, subgroup: null, item: it });
    for (const s of g.subgroups || []) {
      for (const it of s.items || []) rows.push({ group: g.title, subgroup: s.title, item: it });
    }
  }
  return rows;
}

/** Compact JSON form for reports: groups -> videos with text + link. */
export function outlineToReport(outline) {
  return {
    courseTitle: outline.courseTitle,
    source: outline.source,
    sourceUrl: outline.sourceUrl,
    types: outline.types,
    stats: outline.stats,
    skipped: outline.skipped ?? 0,
    groups: (outline.groups || []).map((g) => ({
      kind: g.kind,
      title: g.title,
      videos: (g.items || []).map((it) => ({ seq: it.seq, text: it.text, url: it.url })),
      subgroups: (g.subgroups || []).map((s) => ({
        title: s.title,
        videos: (s.items || []).map((it) => ({ seq: it.seq, text: it.text, url: it.url })),
      })),
    })),
  };
}

/** Human-readable outline tree (CLI / status output). */
export function formatOutline(outline, { showUrl = true } = {}) {
  const lines = [];
  if (outline.courseTitle) lines.push(`${outline.courseTitle} — Course Outline (source: ${outline.source})`);
  for (const g of outline.groups || []) {
    lines.push(`  ${g.title}${g.kind ? ` [${g.kind}]` : ''}`);
    for (const it of g.items || []) lines.push(`    - ${it.text}${showUrl ? `\n        ${it.url}` : ''}`);
    for (const s of g.subgroups || []) {
      lines.push(`    · ${s.title}`);
      for (const it of s.items || []) lines.push(`      - ${it.text}${showUrl ? `\n          ${it.url}` : ''}`);
    }
  }
  const st = outline.stats || emptyStats();
  lines.push(`  (${st.groups} groups, ${st.subgroups} subtopics, ${st.items} entries kept, ${outline.skipped ?? st.skipped} non-matching entries skipped)`);
  return lines.join('\n');
}
