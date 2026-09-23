// Text hygiene: normalize whitespace and strip characters that corrupt docs
// (lone surrogates, control chars, U+FFFD replacement chars). Applied on the
// way in (captions/LLM output) and again as the final gate before Feishu.
export function normalizeText(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

export function sanitizeText(s) {
  if (typeof s !== 'string') return '';
  return String(s)
    // C0/C1 control characters except \t and \n
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
    // lone surrogates (unpaired halves of emoji etc.) -> they become U+FFFD on JSON round-trips
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    // any replacement char that already leaked in
    .replace(/\uFFFD/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function sanitizePair(p) {
  if (!p) return p;
  return { en: sanitizeText(p.en), zh: sanitizeText(p.zh) };
}

// ---------------------------------------------------------------------------
// Sentence-boundary helpers (shared by segmentation and section placement).
// They are deliberately conservative: when a break is uncertain we report "not
// a sentence end", so callers merge rather than cut a sentence in half.
// ---------------------------------------------------------------------------

// Tokens whose trailing dot is NOT a sentence end.
const SENTENCE_ABBREV = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'mt', 'vs', 'etc', 'inc', 'ltd', 'co', 'corp',
  'no', 'fig', 'figs', 'approx', 'dept', 'univ', 'sec', 'gen', 'col', 'capt', 'lt', 'sgt', 'rev',
  'hon', 'est', 'min', 'max', 'avg', 'al', 'ed', 'vol', 'pp', 'cf', 'resp', 'eg', 'ie', 'am', 'pm',
  'us', 'uk', 'eu', 'un', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
]);

export function isSentenceAbbrev(word) {
  const w = String(word || '').replace(/[^A-Za-z0-9.]/g, '').toLowerCase();
  if (!w) return false;
  return SENTENCE_ABBREV.has(w) || SENTENCE_ABBREV.has(w.replace(/\./g, ''));
}

/** Word immediately before `end` (exclusive): latin letters or digits. */
export function wordBefore(text, end) {
  const m = String(text ?? '').slice(0, Math.max(0, end)).match(/([A-Za-z]+|\d+)$/);
  return m ? m[1] : '';
}

/** Is the "." at `dotIndex` a real end-of-sentence dot (not "Dr." / "U.S." / "3.")? */
export function isSentenceDot(text, dotIndex) {
  const word = wordBefore(text, dotIndex);
  if (!word) return false;
  if (/^\d+$/.test(word)) return false; // numbered list marker or measurement
  if (word.length === 1 && /[A-Za-z]/.test(word)) return false; // dotted initial ("J.")
  return !isSentenceAbbrev(word);
}

/**
 * Does this text finish a sentence? "…done." / "…done!" / "…done?" -> true;
 * "…done," / "…the app" / "…Dr." -> false. Trailing quotes/brackets are ignored.
 */
export function endsWithSentenceEnd(text) {
  const raw = String(text ?? '').trim().replace(/[)"'”’\]}]+$/, '');
  if (!raw) return false;
  const last = raw[raw.length - 1];
  if (last === '!' || last === '?') return true;
  if (last !== '.') return false;
  return isSentenceDot(raw, raw.length - 1);
}
