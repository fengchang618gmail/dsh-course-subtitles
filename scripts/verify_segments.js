// Verify the paragraph/sentence integrity guarantees:
//   1. caption fragments become complete sentences — a unit never ends mid-sentence
//   2. section headings are only placed on a sentence boundary
//   3. rebuilding units never adds, drops or alters text
// Offline by default (real captions are embedded as a fixture).
// `--cache <dir>` additionally replays every cached caption track.
import fs from 'node:fs';
import path from 'node:path';
import {
  splitText,
  splitIntoAtoms,
  deriveSentences,
  unitsFromBoundaries,
  punctuationIsReliable,
} from '../src/engine/segment.js';
import { normalizeSectionStarts, validateSections } from '../src/engine/sections.js';
import { buildDocBlocks } from '../src/engine/feishu.js';
import { endsWithSentenceEnd, isSentenceAbbrev } from '../src/engine/text.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// Real DeepLearning.AI captions ("Build with Andrew" · ping-pong lesson). This
// is the transcript that used to break: the LLM cut sentences in the middle.
const CAPTIONS = [
  "Using the skills you now have in prompting, let's build another app. This time, a ping-pong game.",
  "Because of AI, it's now possible to go from an idea to a working app, sometimes in minutes.",
  'One of the earliest video games in computer history was a game called Pong, which was sort',
  'of a two-person ping-pong game, and that had taken the team weeks to build. But now, thanks to AI,',
  "you can build something like this in minutes. Let's apply the prompting techniques we learned.",
  "I'm going to start quickly and write a moderately specific prompt and say,",
  'build me a table tennis game as a single HTML file, use a place against computer,',
  'move the paddle to the arrow keys. And if you do that, you might get a first version of the app',
  "that looks like this. I go, okay, that's a good start, but I wanted to add three difficulty levels",
  'and let the user specify the number of points required to win, and also have it keep score.',
  'And this builds me a second version like that. And this now looks like a fun game,',
  "but I want the graphics to be fancier. So I'm going to say, make the playground green,",
  'paddle beige, ball white, and I\'m going to tell it to insert this image into the background.',
  "And so I end up with a game that looks like this. And here is the game. It's actually pretty,",
  'pretty fun. The ball is bouncing back and forth. I could actually play this for quite a long time,',
  "maybe longer than you'd actually want to watch me playing it, but I hope you will have fun with",
  'this. As a reminder, being specific in how you write your prompt gets you better results. And so',
  'you can look over the prompts I was using, and it was fairly specific in a number of details,',
  "like the color, the points, and so on. If you're not sure what to include in the prompt,",
  'think about the building blocks. Do you want to specify the goal, the output, the input,',
  'the layout, the features as a set of things to consider including. And lastly, use your chatbot',
  "to iterate, improve, and troubleshoot. You don't need to get it right the first time. You can tell",
  'what you already know, what you already have in mind, see what you get, and then use that to',
  'further refine what you tell the AI to do. I actually enjoy ping pong in real life, and now',
  'you can build a game to play it also with your computer. Please go to the next learning item',
  'to give this a shot yourself. And in addition, beyond building a birthday card generator or',
  'ping pong game, if you have an idea for something else you want to try to build, give it a shot.',
  "It may or may not work, but it's by practicing and exploring our ideas that all of us get better",
  'at building things.',
];

// The sentence boundaries the LLM produced for this lesson (each one cuts a
// sentence in half: "…the app" | "that looks like this.", "…fun game," | "but I…").
const LLM_BOUNDARIES = [
  { start: 0, end: 1 },
  { start: 2, end: 4 },
  { start: 5, end: 7 },
  { start: 8, end: 10 },
  { start: 11, end: 13 },
  { start: 14, end: 16 },
  { start: 17, end: 18 },
  { start: 19, end: 20 },
  { start: 21, end: 23 },
  { start: 24, end: 25 },
  { start: 26, end: 28 },
];

const items = CAPTIONS.map((text, i) => ({ i, text }));

console.log('\n[1] sentence-end helpers');
check("endsWithSentenceEnd('a sentence.')", endsWithSentenceEnd('This is a sentence.') === true);
check("endsWithSentenceEnd('ends with the app') = false", endsWithSentenceEnd('ends with the app') === false);
check("endsWithSentenceEnd('…and say,') = false", endsWithSentenceEnd('and then he said,') === false);
check("endsWithSentenceEnd('I met Dr.') = false", endsWithSentenceEnd('I met Dr.') === false);
check("endsWithSentenceEnd('the U.S.') = false", endsWithSentenceEnd('the U.S.') === false);
check("endsWithSentenceEnd('Read chapter 3.') = false", endsWithSentenceEnd('Read chapter 3.') === false);
check("endsWithSentenceEnd('pi is 3.5') = false", endsWithSentenceEnd('pi is 3.5') === false);
check('endsWithSentenceEnd(\'She said "go home."\')', endsWithSentenceEnd('She said "go home."') === true);
check("endsWithSentenceEnd('Really?!')", endsWithSentenceEnd('Really?!') === true);
check("isSentenceAbbrev('Dr') / ('etc') / ('build')", isSentenceAbbrev('Dr') && isSentenceAbbrev('etc') && !isSentenceAbbrev('build'));

console.log('\n[2] intra-fragment splitting never cuts a sentence');
const split1 = splitText('move the paddle to the arrow keys. And if you do that, you might get a first version of the app');
check('two pieces around "keys."', split1.length === 2, JSON.stringify(split1));
check('piece 1 is a whole sentence', split1[0].endSentence === true && split1[0].text.endsWith('arrow keys.'));
check('piece 2 stays open', split1[1].endSentence === false && split1[1].text.startsWith('And if you do that'));
const split2 = splitText('I met Dr. Smith at 3.30 p.m. yesterday. It was fine.');
check('abbreviations do not split ("Dr." / "p.m." / "3.30")', split2.length === 2, JSON.stringify(split2.map((p) => p.text)));
check('kept "Dr." and "p.m." inside the same piece', split2[0].text === 'I met Dr. Smith at 3.30 p.m. yesterday.');
const split3 = splitText('no punctuation here at all');
check('unpunctuated text stays one piece', split3.length === 1 && split3[0].endSentence === false);

console.log('\n[3] real captions -> complete sentences');
const atoms = splitIntoAtoms(items);
const reliable = punctuationIsReliable(items, atoms);
check('punctuated captions are detected (no LLM needed)', reliable === true);
const units = deriveSentences(atoms);
check(`sentences derived (${units.length} units from ${CAPTIONS.length} fragments)`, units.length >= 20 && units.length < CAPTIONS.length);
const openUnits = units.slice(0, -1).filter((u) => !endsWithSentenceEnd(u.text));
check('NO unit ends mid-sentence (the reported bug)', openUnits.length === 0, openUnits.map((u) => `"${u.text.slice(-60)}"`).join(' | '));
check('units that finish a sentence are flagged endSentence', units.slice(0, -1).every((u) => u.endSentence === true));
check(
  'words preserved exactly (no drop / no reorder)',
  norm(units.map((u) => u.text).join(' ')) === norm(CAPTIONS.join(' '))
);
check(
  'caption break "which was sort | of a two-person…" is inside one sentence',
  units.some((u) => u.text.includes('which was sort of a two-person ping-pong game'))
);
check('no unit ends at that broken caption break', !units.some((u) => u.text.endsWith('which was sort')));

console.log('\n[4] LLM boundaries are repaired, not trusted');
const brokenBreaks = LLM_BOUNDARIES.slice(1).filter((b) => !endsWithSentenceEnd(CAPTIONS[b.start - 1]));
check(`the model cut ${brokenBreaks.length} sentences in half (fixture sanity)`, brokenBreaks.length >= 5);
const repaired = unitsFromBoundaries(atoms, LLM_BOUNDARIES);
const openRepaired = repaired.slice(0, -1).filter((u) => !endsWithSentenceEnd(u.text));
check('every repaired unit ends with a finished sentence', openRepaired.length === 0, openRepaired.map((u) => `"${u.text.slice(-50)}"`).join(' | '));
check('repaired units keep all the text', norm(repaired.map((u) => u.text).join(' ')) === norm(CAPTIONS.join(' ')));
check('repaired units are contiguous (startLine order)', repaired.every((u, i) => i === 0 || u.startLine >= repaired[i - 1].endLine));

console.log('\n[5] unpunctuated captions (auto-generated ASR)');
const asrTexts = [
  'so today we are going to talk about agents',
  'the first thing is the model itself',
  'then we add tools',
  'and finally memory',
  'let us start with the model',
];
const asrItems = asrTexts.map((text, i) => ({ i, text }));
const asrAtoms = splitIntoAtoms(asrItems);
check('punctuation is not trusted -> LLM path', punctuationIsReliable(asrItems, asrAtoms) === false);
const asrPerFragment = unitsFromBoundaries(asrAtoms, asrTexts.map((_, i) => ({ start: i, end: i })));
check('no cascading merge when there is nothing to align to', asrPerFragment.length === asrTexts.length, `got ${asrPerFragment.length}`);
const asrSingle = unitsFromBoundaries(asrAtoms, [{ start: 0, end: 4 }]);
check('explicit single group is respected', asrSingle.length === 1);

console.log('\n[6] section headings only on sentence boundaries');
const pairs = units.map((u) => ({ en: u.text, zh: '中文译文' }));
const legacySections = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((start) => ({ start, title_en: `Section ${start}`, title_zh: `小节 ${start}` }));
const placed = normalizeSectionStarts(pairs, legacySections);
check(`headings kept (${placed.length}/${legacySections.length})`, placed.length >= 3 && placed.length <= legacySections.length);
check(
  'every heading starts at a sentence boundary',
  placed.every((s) => s.start === 0 || endsWithSentenceEnd(pairs[s.start - 1].en)),
  JSON.stringify(placed.map((s) => s.start))
);
const midPairs = [
  { en: 'This is one complete sentence.' },
  { en: 'This one is cut in the middle' },
  { en: 'because it continues here.' },
  { en: 'Another one.' },
];
const moved = normalizeSectionStarts(midPairs, [{ start: 2, title_en: 'T', title_zh: '中' }]);
check('heading inside a sentence is moved to the next sentence start', moved.length === 1 && moved[0].start === 3, JSON.stringify(moved.map((s) => s.start)));
const outOfRange = normalizeSectionStarts(pairs, [{ start: 9999, title_en: 'T', title_zh: '中' }]);
check('out-of-range heading still lands on a real line', outOfRange.length === 1 && outOfRange[0].start < pairs.length);
check('validateSections still snaps bad indices', validateSections([{ start: 42, title_en: 'T', title_zh: '中' }], 5)[0].start === 4);

console.log('\n[7] Feishu blocks never place a heading inside a sentence');
const blocks = buildDocBlocks({
  lesson: { name: 'Ping pong', zhName: '乒乓球' },
  pairs,
  sections: legacySections,
  meta: 'meta',
});
const textOf = (b) => (b.text?.elements || []).map((e) => e.text_run?.content || '').join('');
check('document starts with H1 + meta line', blocks[0].block_type === 3 && blocks[1].block_type === 2);
const body = blocks.slice(2); // drop H1 + meta so [en, zh] pairs line up
let expect = 'en'; // each pair is emitted as [en, zh]
let lastEn = null;
let h2 = 0;
let headingAfterOpenSentence = 0;
let headingInsidePair = 0;
for (const b of body) {
  if (b.block_type === 2) {
    if (expect === 'en') {
      lastEn = textOf(b);
      expect = 'zh';
    } else {
      expect = 'en';
    }
  } else if (b.block_type === 4) {
    h2 += 1;
    if (expect === 'zh') headingInsidePair += 1;
    if (lastEn !== null && !endsWithSentenceEnd(lastEn)) headingAfterOpenSentence += 1;
    expect = 'en';
  }
}
check(`document has H2 headings (${h2}, H1 not counted)`, h2 >= 3);
check('no heading follows an unfinished sentence', headingAfterOpenSentence === 0, `got ${headingAfterOpenSentence}`);
check('no heading is inserted between the EN/ZH line of one sentence', headingInsidePair === 0);
check('blocks = H1 + meta + 2 paragraphs per sentence + H2', blocks.length === pairs.length * 2 + h2 + 2, `blocks=${blocks.length} pairs=${pairs.length} h2=${h2}`);

// optional: replay every cached caption track
const cacheIdx = process.argv.indexOf('--cache');
if (cacheIdx !== -1 && process.argv[cacheIdx + 1]) {
  const dir = process.argv[cacheIdx + 1];
  console.log(`\n[8] replay cached caption tracks (${dir})`);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  let tracks = 0;
  let violations = 0;
  let llmTracks = 0;
  for (const f of files) {
    const entry = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (!entry.key.startsWith('captions:')) continue;
    tracks += 1;
    const cachedItems = entry.data.map((c, i) => ({ i, text: c.text || '' }));
    const cachedAtoms = splitIntoAtoms(cachedItems);
    if (!punctuationIsReliable(cachedItems, cachedAtoms)) {
      llmTracks += 1;
      continue;
    }
    const cachedUnits = deriveSentences(cachedAtoms);
    const open = cachedUnits.slice(0, -1).filter((u) => !endsWithSentenceEnd(u.text));
    violations += open.length;
    const lossy = norm(cachedUnits.map((u) => u.text).join(' ')) !== norm(cachedItems.map((i2) => i2.text).join(' '));
    console.log(
      `  ${entry.key.split(':').pop()}  fragments=${cachedItems.length} sentences=${cachedUnits.length} open=${open.length}${lossy ? ' TEXT-LOSS!' : ''}`
    );
    if (open.length) console.log(`      ${open.map((u) => `"${u.text.slice(-50)}"`).join(' | ')}`);
    if (lossy) violations += 1;
  }
  check(`${tracks} cached tracks: no mid-sentence paragraph breaks`, violations === 0, `violations=${violations}`);
  console.log(`  (${llmTracks} track(s) have no sentence punctuation -> LLM grouping path)`);
}

console.log(`\n${pass} checks passed, ${fail} failed`);
if (fail) process.exit(1);
