// Minimal zero-dependency HTML helpers (Node built-ins only) — enough to read
// structured page fragments such as DeepLearning.AI's "Course Outline" block.
// Not a general-purpose parser: it targets server-rendered markup, keeps the
// source order of nodes, and tolerates unbalanced/void tags.

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
};

function fromCodePoint(code) {
  try {
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/** Decode numeric + common named HTML entities. Unknown entities are left as-is. */
export function decodeEntities(input) {
  return String(input ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (m, hex) => fromCodePoint(parseInt(hex, 16)) || m)
    .replace(/&#(\d+);/g, (m, dec) => fromCodePoint(parseInt(dec, 10)) || m)
    .replace(/&([a-z][a-z0-9]{1,10});/gi, (m, name) => {
      const hit = NAMED_ENTITIES[name.toLowerCase()];
      return hit === undefined ? m : hit;
    });
}

/**
 * Visible text of an HTML fragment: scripts/styles dropped, tags replaced by a
 * space (so `<div>a</div><div>b</div>` never becomes `ab`), entities decoded,
 * whitespace collapsed. U+3164 (HANGUL FILLER, used by the DL.AI course titles
 * as visual padding) is removed too.
 */
export function stripTags(input) {
  return decodeEntities(
    String(input ?? '')
      .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]*>/g, ' ')
  )
    .replace(/\u3164/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Read one attribute out of a raw tag string (`<a href="...">` or `href="..."`). */
export function attr(tagOrAttrs, name) {
  const re = new RegExp(
    `\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`,
    'i'
  );
  const m = String(tagOrAttrs ?? '').match(re);
  if (!m) return '';
  return decodeEntities(m[1] ?? m[2] ?? m[3] ?? '').trim();
}

/** Resolve a possibly relative href against a base URL. */
export function absolutize(href, base) {
  const raw = String(href ?? '').trim();
  if (!raw) return '';
  try {
    return new URL(raw, base).href;
  } catch {
    return raw;
  }
}

/**
 * Content of a balanced element starting at `start` (the index of its `<`).
 * Returns { inner, start, end } in the source string, or null when unbalanced.
 * Depth counting is what makes nested `<div>` labels ("Graded・Quiz・1h")
 * readable without a full tree.
 */
export function balancedInner(html, start, tag = 'div') {
  const src = String(html ?? '');
  if (start < 0 || start >= src.length) return null;
  const tagRe = new RegExp(`<${tag}\\b[^>]*>|</${tag}\\s*>`, 'gi');
  tagRe.lastIndex = start;
  let depth = 0;
  let contentStart = -1;
  let m;
  while ((m = tagRe.exec(src))) {
    if (m[0][1] === '/') {
      depth--;
      if (depth === 0) return { inner: src.slice(contentStart, m.index), start, end: tagRe.lastIndex };
      if (depth < 0) return null;
    } else {
      depth++;
      if (contentStart < 0) contentStart = tagRe.lastIndex;
    }
  }
  return null;
}

/**
 * Region between the heading matching `titleRe` and the next heading of the
 * same (or higher) rank — e.g. everything from "Course Outline" up to the
 * "Instructors" section.
 * @returns {{text:string,start:number,end:number}|null}
 */
export function regionAfterHeading(html, titleRe = /^course outline$/i) {
  const src = String(html ?? '');
  const headingRe = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi;
  let m;
  while ((m = headingRe.exec(src))) {
    if (!titleRe.test(stripTags(m[2]))) continue;
    const level = Number(m[1]);
    const start = m.index + m[0].length;
    const rest = src.slice(start);
    const next = new RegExp(`<h[1-${level}]\\b`, 'i').exec(rest);
    const end = start + (next ? next.index : rest.length);
    return { text: src.slice(start, end), start, end };
  }
  return null;
}

/** First `application/ld+json` object whose @type matches (used for the course name). */
export function findJsonLd(html, type) {
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(String(html ?? '')))) {
    try {
      const j = JSON.parse(m[1]);
      const list = Array.isArray(j) ? j : [j];
      for (const item of list) {
        if (String(item?.['@type'] ?? '').toLowerCase() === String(type).toLowerCase()) return item;
      }
    } catch {
      /* ignore malformed ld+json blocks */
    }
  }
  return null;
}
