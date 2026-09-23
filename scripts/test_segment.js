// Manual check of sentence segmentation on a real course lesson.
// Prints which strategy was used and verifies that no unit ends mid-sentence.
import * as deeplearning from '../src/engine/adapters/deeplearning.js';
import { segmentSentences } from '../src/engine/segment.js';
import { endsWithSentenceEnd } from '../src/engine/text.js';
import { loadConfig } from '../src/engine/config.js';

const { config } = loadConfig('../../course-subtitles.config.json');

const lessons = await deeplearning.discover(config.courseUrl);
const lesson = lessons[0];
const captions = await deeplearning.getCaptions(lesson);
console.log(`lesson: ${lesson.name} | fragments: ${captions.length}`);

const t0 = Date.now();
const sentences = await segmentSentences(config, captions, {
  onInfo: (info) => console.log(`strategy: ${info.method} (atoms=${info.atoms})`),
});
console.log(`segmented in ${Date.now() - t0}ms -> ${sentences.length} sentences`);

// integrity check: a paragraph must never end in the middle of a sentence
const open = sentences.slice(0, -1).filter((s) => !endsWithSentenceEnd(s.text));
console.log(`paragraphs ending mid-sentence: ${open.length} (must be 0)`);
for (const s of open) console.log(`  !! ${s.text.slice(-70)}`);

// words preserved?
const same = (a) => a.replace(/\s+/g, ' ').trim();
const lossless = same(sentences.map((s) => s.text).join(' ')) === same(captions.map((c) => c.text).join(' '));
console.log(`text preserved verbatim: ${lossless}`);

console.log('\n--- first 12 sentences ---');
for (const s of sentences.slice(0, 12)) {
  console.log(`[${s.startLine}-${s.endLine}] ${s.text}`);
}
if (open.length || !lossless) process.exit(1);
