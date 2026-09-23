// Sentence segmentation: caption fragments -> complete sentences (one sentence
// per unit), so a sentence can never be split across two paragraphs.
//
// Two strategies, chosen automatically per transcript:
//  1. "punctuation" — the captions delimit their own sentences (DeepLearning.AI,
//     most course platforms). Fragments are cut at real sentence ends and merged
//     until the sentence is complete. Fully deterministic, no LLM call, and the
//     result is guaranteed to contain whole sentences only.
//  2. "llm" — auto-generated captions without sentence punctuation (YouTube ASR).
//     The model groups the fragments; its boundaries are then snapped onto
//     caption boundaries and any group that stops mid-sentence is merged into
//     the next one, whenever the transcript has sentence ends to align with.
//
// The sentence TEXT is always rebuilt programmatically from the original
// fragments: no word is ever added, dropped or altered.
import { chatText, parseJsonLoose } from './llm.js';
import { normalizeText, endsWithSentenceEnd, isSentenceDot } from './text.js';

// Punctuation is trusted when the transcript shows enough sentence ends.
const MIN_SENTENCE_ENDS = 2;
const MIN_END_RATIO = 0.15;

const SYSTEM = `You are a transcript editor. Caption fragments of a video are given as numbered lines (fragment index TAB text).
Group consecutive fragments into complete, self-contained sentences.
Rules:
- NEVER cut in the middle of a sentence: a group must not end while the grammatical unit is unfinished.
- A group ends where the sentence ends (., ! or ?). If a caption break happens mid-sentence, keep adding the following fragments until that sentence is finished.
- Do not merge two separate sentences into one group either; one group = one sentence.
- Only the very last group may end unfinished, and only if the video itself stops mid-sentence.
- Cover every fragment exactly once: groups must be contiguous, non-overlapping and in order.
- "start" = index of the first fragment of the group; "end" = index of the last fragment (inclusive).
- Output ONLY JSON: {"sentences":[{"start":<int>,"end":<int>}]}. No "text" field.`;

/**
 * Merge caption fragments into complete sentences.
 * @param cfg
 * @param fragments - [{text, ...}]
 * @param options.onInfo - called once with {method, fragments, sentences}
 * @returns [{startLine, endLine, text, endSentence}] — text rebuilt from fragments
 */
export async function segmentSentences(cfg, fragments, { onRetry, onInfo } = {}) {
  const items = fragments.map((f, i) => ({ i, text: normalizeText(f.text || '') }));
  const atoms = splitIntoAtoms(items);
  if (!atoms.length) return [];

  if (punctuationIsReliable(items, atoms)) {
    const units = deriveSentences(atoms);
    onInfo?.({ method: 'punctuation', fragments: items.length, atoms: atoms.length, sentences: units.length });
    return units;
  }

  const boundaries = await requestBoundaries(cfg, items, onRetry);
  const units = unitsFromBoundaries(atoms, boundaries);
  onInfo?.({ method: 'llm', fragments: items.length, atoms: atoms.length, sentences: units.length });
  return units;
}

async function requestBoundaries(cfg, items, onRetry) {
  const prompt =
    'Group these caption fragments into complete sentences. Return JSON with "sentences" (start/end indices only).\n\n' +
    items.map((l) => `${l.i}\t${l.text}`).join('\n');

  const { text } = await chatText(cfg, {
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: prompt },
    ],
    temperature: cfg.llmTemperature ?? 0.2,
    maxTokens: 4096,
    json: true,
    timeoutMs: 120000,
    onRetry,
  });
  const parsed = parseJsonLoose(text);
  if (!parsed || !Array.isArray(parsed.sentences)) throw new Error('bad segmentation response: ' + String(text).slice(0, 200));
  return parsed.sentences;
}

/**
 * Split every caption fragment into atoms: pieces that never cut a sentence in
 * half. An atom that contains more than one sentence is split at its internal
 * sentence ends (abbreviation/initial/number safe), and a piece that stops in
 * the middle of a sentence is marked endSentence=false so it gets merged with
 * what follows.
 */
export function splitIntoAtoms(items) {
  const atoms = [];
  for (const item of items) {
    const text = normalizeText(item.text || '');
    if (!text) continue;
    for (const piece of splitText(text)) {
      atoms.push({ i: atoms.length, startLine: item.i, text: piece.text, endSentence: piece.endSentence });
    }
  }
  return atoms;
}

/** Split one fragment's text into atoms (see splitIntoAtoms). */
export function splitText(text) {
  const out = [];
  let cursor = 0;
  const re = /([.!?]+)(["'”’)\]]*)(\s+)/g;
  let m;
  while ((m = re.exec(text))) {
    const punctEnd = m.index + m[1].length; // just after the punctuation run
    const pieceEnd = punctEnd + m[2].length; // include closing quotes/brackets
    const nextStart = m.index + m[0].length; // after the whitespace run
    if (!canEndSentenceAt(text, punctEnd, text.slice(nextStart))) continue;
    pushPiece(out, text.slice(cursor, pieceEnd), true);
    cursor = nextStart;
    re.lastIndex = nextStart;
  }
  pushPiece(out, text.slice(cursor), endsWithSentenceEnd(text.slice(cursor)));
  return out;
}

function canEndSentenceAt(text, punctEnd, rest) {
  const punct = text[punctEnd - 1];
  if (punct === '.') {
    if (!isSentenceDot(text, punctEnd - 1)) return false;
  } else if (punct !== '!' && punct !== '?') {
    return false;
  }
  const next = String(rest || '').replace(/^[\s"'“”‘’([{]+/, '');
  if (!next) return true;
  return /[A-Z0-9]/.test(next[0]);
}

function pushPiece(out, raw, endSentence) {
  const text = normalizeText(raw);
  if (!text) return;
  out.push({ text, endSentence });
}

/** Are the captions punctuated well enough to derive sentences ourselves? */
export function punctuationIsReliable(items, atoms) {
  const ends = atoms.filter((a) => a.endSentence).length;
  return ends >= MIN_SENTENCE_ENDS && ends >= MIN_END_RATIO * Math.max(1, items.length);
}

/** One sentence per unit: cut after every atom that ends a sentence. */
export function deriveSentences(atoms) {
  const units = [];
  let buf = [];
  for (const atom of atoms) {
    buf.push(atom);
    if (atom.endSentence) {
      units.push(toUnit(buf));
      buf = [];
    }
  }
  // A trailing unfinished sentence has nothing to merge with, so it stays whole.
  if (buf.length) units.push(toUnit(buf));
  return units;
}

/**
 * Rebuild contiguous units from LLM boundary decisions. Groups that stop
 * mid-sentence are merged into the following group so that every paragraph
 * (except possibly the last) ends with a finished sentence.
 */
export function unitsFromBoundaries(atoms, boundaries) {
  const n = atoms.length;
  if (!n) return [];
  const lines = atoms.map((a) => a.startLine);
  const atomOfStart = (line) => {
    const k = lines.findIndex((l) => l >= line);
    return k === -1 ? n - 1 : k;
  };
  const atomOfEnd = (line) => {
    let k = -1;
    for (let i = 0; i < n; i++) if (lines[i] <= line) k = i;
    return k === -1 ? 0 : k;
  };
  const bounds = (boundaries || [])
    .map((b) => ({
      start: atomOfStart(Math.max(0, Math.round(Number(b.start)) || 0)),
      end: atomOfEnd(Math.max(0, Math.round(Number(b.end)) || 0)),
    }))
    .filter((b) => b.start <= b.end)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const assigns = bounds.length ? assignGroups(n, bounds) : deriveAssigns(atoms);
  return groupUnits(atoms, assigns, { enforce: atoms.some((a) => a.endSentence) });
}

/** Backwards-compatible entry point: items = [{i, text}], boundaries in item indices. */
export function rebuildSentences(items, boundaries) {
  return unitsFromBoundaries(splitIntoAtoms(items), boundaries);
}

function assignGroups(n, bounds) {
  const assigns = new Array(n).fill(-1);
  bounds.forEach((b, gi) => {
    for (let i = b.start; i <= b.end; i++) if (assigns[i] === -1) assigns[i] = gi;
  });
  // fill gaps with the nearest boundary
  for (let i = 0; i < n; i++) {
    if (assigns[i] !== -1) continue;
    let best = 0;
    let bestDist = Infinity;
    bounds.forEach((b, gi) => {
      const d = Math.min(Math.abs(i - b.start), Math.abs(i - b.end));
      if (d < bestDist) {
        bestDist = d;
        best = gi;
      }
    });
    assigns[i] = best;
  }
  return assigns;
}

function deriveAssigns(atoms) {
  const assigns = [];
  let g = 0;
  for (const atom of atoms) {
    assigns.push(g);
    if (atom.endSentence) g++;
  }
  return assigns;
}

function groupUnits(atoms, assigns, { enforce }) {
  const groups = [];
  for (let i = 0; i < atoms.length; i++) {
    const g = assigns[i];
    if (!groups.length || groups[groups.length - 1].g !== g) groups.push({ g, items: [] });
    groups[groups.length - 1].items.push(atoms[i]);
  }
  if (enforce) {
    for (let i = 0; i < groups.length - 1; i++) {
      while (i < groups.length - 1 && !groups[i].items[groups[i].items.length - 1].endSentence) {
        groups[i + 1].items = groups[i].items.concat(groups[i + 1].items);
        groups.splice(i, 1);
      }
    }
  }
  return groups.map((g) => toUnit(g.items));
}

function toUnit(list) {
  const last = list[list.length - 1];
  return {
    startLine: list[0].startLine,
    endLine: last.startLine,
    text: list.map((a) => a.text).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim(),
    endSentence: !!last.endSentence,
  };
}
