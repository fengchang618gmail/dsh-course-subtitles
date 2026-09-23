// Token-efficient line-by-line translation through whatever LLM credential this
// machine has (see llm.js: the chain walks the configured key first, then every
// key the local harness credential store exposes). Batches numbered lines per
// request, JSON-aligned output, bounded concurrency, retries with backoff, and
// single-line refills for gaps.
import { chatText, parseJsonLoose } from './llm.js';
import { sanitizeText } from './text.js';

const SYSTEM = `You are a professional translator of English video subtitles into natural Simplified Chinese.
Translate each line faithfully and concisely, preserving meaning, tone, and proper nouns (keep English technical terms in parentheses when helpful).
Do not add explanations, markdown, emoji, or reorder lines.
Output ONLY a JSON object: {"lines":[{"i":<original index>,"zh":"<Chinese translation>"}]}.`;

function normalize(text) {
  return sanitizeText(text);
}

async function chatCompletion(cfg, messages, { maxTokens = 8192, onRetry } = {}) {
  const { text } = await chatText(cfg, {
    messages,
    temperature: cfg.llmTemperature ?? 0.3,
    maxTokens,
    json: true,
    timeoutMs: 120000,
    onRetry,
  });
  return parseJsonLoose(text);
}

async function translateChunk(cfg, chunk, onRetry) {
  const prompt = 'Translate these subtitle lines into Simplified Chinese. Return the JSON object with one entry per line.\n\n' +
    chunk.map((l) => `${l.i}\t${l.en}`).join('\n');
  const parsed = await chatCompletion(cfg, [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: prompt },
  ], { onRetry });
  if (!parsed || !Array.isArray(parsed.lines)) throw new Error('bad translate response: ' + JSON.stringify(parsed).slice(0, 200));
  return parsed.lines;
}

async function translateOne(cfg, i, en, onRetry) {
  const parsed = await chatCompletion(
    cfg,
    [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Translate this single subtitle line to Simplified Chinese. Return JSON: {"lines":[{"i":${i},"zh":"..."}]}\n\n${i}\t${en}` },
    ],
    { maxTokens: 1024, onRetry }
  );
  return parsed?.lines?.[0] ?? null;
}

/**
 * Translate a short English title/heading into Simplified Chinese.
 * Returns just the translated string (no JSON wrapper).
 */
export async function translateTitle(cfg, enTitle) {
  if (!enTitle || !enTitle.trim()) return '';
  const { text } = await chatText(cfg, {
    messages: [
      { role: 'system', content: 'You are a professional translator. Translate the following short English title or heading into natural, concise Simplified Chinese. Keep English technical terms and proper nouns as-is. Output ONLY the translated text, nothing else.' },
      { role: 'user', content: enTitle },
    ],
    temperature: cfg.llmTemperature ?? 0.3,
    maxTokens: 256,
    timeoutMs: 30000,
  });
  return sanitizeText(text.trim());
}

/**
 * Translate an array of English subtitle lines.
 * @returns {Promise<Array<{en:string, zh:string}>>} same length as input; zh may be '' only if retries exhausted.
 */
export async function translateLines(cfg, enLines, { onProgress, onRetry } = {}) {
  const lines = enLines.map((en, i) => ({ i, en: normalize(en) }));
  const out = new Array(lines.length).fill(null);
  const CHUNK = cfg.translateChunkSize || 60;

  const chunks = [];
  for (let start = 0; start < lines.length; start += CHUNK) chunks.push(lines.slice(start, start + CHUNK));

  let done = 0;
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, cfg.llmConcurrency || 3) }, async () => {
    while (cursor < chunks.length) {
      const chunk = chunks[cursor++];
      try {
        const resp = await translateChunk(cfg, chunk, onRetry);
        for (const o of resp) {
          if (o && typeof o.i === 'number' && out[o.i] === null) {
            out[o.i] = { en: lines[o.i].en, zh: sanitizeText(o.zh ?? '') };
          }
        }
      } catch (e) {
        if (onRetry) onRetry(e.message);
      }
      done++;
      if (onProgress) onProgress(done, chunks.length);
    }
  });
  await Promise.all(workers);

  // refill missing single lines
  for (let i = 0; i < out.length; i++) {
    if (out[i]) continue;
    try {
      const o = await translateOne(cfg, i, lines[i].en, onRetry);
      if (o?.zh) out[i] = { en: lines[i].en, zh: sanitizeText(o.zh) };
    } catch (e) {
      if (onRetry) onRetry(`line ${i}: ${e.message}`);
    }
  }
  for (let i = 0; i < out.length; i++) {
    if (!out[i]) out[i] = { en: lines[i].en, zh: '' };
  }
  return out;
}
