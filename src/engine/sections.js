// Section-heading generation: ONE pass over the English transcript per lesson
// (never re-feeding the translation), producing bilingual (EN + ZH) H2 titles
// with start line indices validated/snapped to existing lines — and always to a
// line that starts a sentence, so a heading never lands inside a sentence.
import { chatText, parseJsonLoose } from './llm.js';
import { endsWithSentenceEnd, sanitizeText } from './text.js';

const SYSTEM = `You are a study-notes assistant. Given a numbered video transcript, divide it into logical sections and give each section a bilingual title (English + Simplified Chinese).
Rules:
- Every numbered line is one complete sentence.
- "start" must be one of the line numbers present in the transcript, and it must start a new section (use the line where the new topic begins).
- Choose 3-10 sections depending on content length.
- Titles must be concise noun phrases suitable as document headings. Do not add emoji or special characters.
- Output ONLY JSON: {"sections":[{"start":<line number>,"title_en":"...","title_zh":"..."}]}.`;

export async function generateSections(cfg, enLines, { onRetry } = {}) {
  const prompt = 'Divide this video transcript into logical sections and return section titles (EN + ZH). Return JSON with "sections".\n\n' +
    enLines.map((en, i) => `${i}\t${normalize(en)}`).join('\n');
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
  if (!parsed || !Array.isArray(parsed.sections)) throw new Error('bad sections response: ' + String(text).slice(0, 200));
  return validateSections(parsed.sections, enLines.length);
}

function normalize(text) {
  return sanitizeText(text);
}

export function validateSections(sections, lineCount) {
  const valid = new Set(Array.from({ length: lineCount }, (_, i) => i));
  const seen = new Set();
  const out = [];
  for (const s of sections) {
    let start = s.start;
    if (!valid.has(start)) {
      const arr = [...valid];
      if (!arr.length) continue;
      start = arr.reduce((best, x) => (Math.abs(x - s.start) < Math.abs(best - s.start) ? x : best), arr[0]);
    }
    if (seen.has(start)) continue;
    seen.add(start);
    out.push({ start, title_en: sanitizeText(s.title_en), title_zh: sanitizeText(s.title_zh) });
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

/**
 * Keep only headings that can sit on a paragraph boundary: a section may start
 * at line i only when line i-1 finishes its sentence. A heading that would land
 * inside a sentence is moved to the next sentence start (or dropped when there
 * is none). Transcripts without sentence punctuation are left untouched.
 */
export function normalizeSectionStarts(pairs, sections, { onAdjust } = {}) {
  const list = Array.isArray(sections) ? sections : [];
  const n = Array.isArray(pairs) ? pairs.length : 0;
  if (!n || !list.length) return [];

  const ends = pairs.filter((p) => endsWithSentenceEnd(p?.en)).length;
  const reliable = ends >= 2 && ends >= 0.3 * n;
  if (!reliable) return validateSections(list, n);

  const safe = (i) => i === 0 || endsWithSentenceEnd(pairs[i - 1]?.en);
  const seen = new Set();
  const out = [];
  const moved = [];
  for (const s of list) {
    let start = Math.max(0, Math.min(n - 1, Math.round(Number(s.start)) || 0));
    if (!safe(start)) {
      let found = -1;
      for (let j = start + 1; j < n && found === -1; j++) if (safe(j)) found = j;
      if (found === -1) for (let j = start - 1; j >= 0 && found === -1; j--) if (safe(j)) found = j;
      if (found === -1) continue; // nowhere safe: drop the heading rather than cut a sentence
      moved.push({ from: start, to: found });
      start = found;
    }
    if (seen.has(start)) continue;
    seen.add(start);
    out.push({ ...s, start });
  }
  out.sort((a, b) => a.start - b.start);
  if (moved.length) onAdjust?.(moved);
  return out;
}
