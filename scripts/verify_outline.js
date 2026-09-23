// Course Outline feature self-test.
//
//   node scripts/verify_outline.js                       # offline fixture assertions
//   node scripts/verify_outline.js --live <courseUrl>    # + parse a real course page
//   node scripts/verify_outline.js --live <url> --json   # machine-readable
import { parseCourseOutline, filterOutline, outlineToReport, slugifyName, isVideoType, matchesType } from '../src/engine/outline.js';
import { buildOutlineBlocks, encodeLinkUrl } from '../src/engine/feishu.js';
import { match as dlMatch, slugFromUrl, learnCourseUrl, homeCourseUrls } from '../src/engine/adapters/deeplearning.js';
import { pickAdapter } from '../src/engine/adapters/index.js';

let passed = 0;
const failures = [];
function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ---------------------------------------------------------------- fixtures
const MODULE_PAGE = `<!doctype html><html><head>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Course","name":"Agentic AI"}</script>
</head><body>
<header><details><summary>For Business</summary><ul><li><a href="/business">Overview</a></li></ul></details></header>
<section id="course-outline" class="dlai-anchor-section"></section><h2 class="subtitle1 mb-5">Course Outline</h2>
<div class="mx-auto w-full max-w-3xl"><div class="space-y-5 pb-1">
<h3 class="text-neutral text-base leading-5 font-semibold">Agentic AI</h3>
<div class="space-y-5">
<div><details class="collapse w-full rounded-lg border shadow-sm"><summary class="collapse-title w-full p-0"><div class="flex items-center justify-between gap-2 p-4"><div class="text-neutral text-base leading-5 font-semibold">Module 1: Introduction to Agentic Workflows</div><svg viewBox="0 0 24 24"><path d="M12 13.17"/></svg></div></summary>
<div class="collapse-content py-0"><ul><div class="">
<li class="hover:bg-base-200 cursor-pointer px-2 py-2.5"><a class="flex w-full items-start gap-2" href="https://learn.deeplearning.ai/courses/agentic-ai/lesson/pu5xbv/welcome!"><svg viewBox="0 0 24 24"><path d="M16 12"/></svg><div class="grid gap-1"><div class="body2 text-left">Welcome!</div><div class="text-base-content-secondary label1 flex flex-wrap"><div>Video</div><div>・</div><div>1m</div></div></div></a></li>
<li class="hover:bg-base-200 cursor-pointer px-2 py-2.5"><a class="flex w-full items-start gap-2" href="https://learn.deeplearning.ai/courses/agentic-ai/lesson/nae3i1/what-is-agentic-ai%3F"><svg viewBox="0 0 24 24"><path d="M16 12"/></svg><div class="grid gap-1"><div class="body2 text-left">What is agentic AI?</div><div class="text-base-content-secondary label1 flex flex-wrap"><div>Video</div><div>・</div><div>5m</div></div></div></a></li>
<li class="hover:bg-base-200 cursor-pointer px-2 py-2.5"><a class="flex w-full items-start gap-2" href="https://learn.deeplearning.ai/courses/agentic-ai/lesson/rm9bgm2/optional-reading"><svg viewBox="0 0 24 24"><path d="M16 12"/></svg><div class="grid gap-1"><div class="body2 text-left">Optional reading</div><div class="text-base-content-secondary label1 flex flex-wrap"><div>Reading</div><div>・</div><div>10m</div></div></div></a></li>
<li class="hover:bg-base-200 cursor-pointer px-2 py-2.5"><a class="flex w-full items-start gap-2" href="https://learn.deeplearning.ai/courses/agentic-ai/lesson/79cpr2i/quiz"><svg viewBox="0 0 24 24"><path d="M16 12"/></svg><div class="grid gap-1"><div class="body2 text-left">Graded quiz</div><div class="text-base-content-secondary label1 flex flex-wrap"><div><div>Graded</div>・Quiz</div><div>・</div><div>10m</div></div></div></a></li>
</div></ul></div></details></div>
<div><details class="collapse w-full"><summary class="collapse-title w-full p-0"><div class="flex items-center justify-between gap-2 p-4"><div class="text-neutral text-base leading-5 font-semibold">Module 2: Reflection Design Pattern</div><svg viewBox="0 0 24 24"><path d="M12 13.17"/></svg></div></summary>
<div class="collapse-content py-0"><ul><div class="">
<li class="hover:bg-base-200 cursor-pointer px-2 py-2.5"><a class="flex w-full items-start gap-2" href="https://learn.deeplearning.ai/courses/agentic-ai/lesson/shknq1/reflection-to-improve-outputs-of-a-task"><svg viewBox="0 0 24 24"><path d="M16 12"/></svg><div class="grid gap-1"><div class="body2 text-left">Reflection to improve outputs of a task</div><div class="text-base-content-secondary label1 flex flex-wrap"><div>Video</div><div>・</div><div>9m</div></div></div></a></li>
<li class="hover:bg-base-200 cursor-pointer px-2 py-2.5"><a class="flex w-full items-start gap-2" href="https://learn.deeplearning.ai/courses/agentic-ai/lesson/uz37v2/why-not-just-direct-generation%3F"><svg viewBox="0 0 24 24"><path d="M16 12"/></svg><div class="grid gap-1"><div class="body2 text-left">Why not just direct generation?</div><div class="text-base-content-secondary label1 flex flex-wrap"><div>Video</div><div>・</div><div>6m</div></div></div></a></li>
</div></ul></div></details></div>
</div></div></div>
<div class="mt-8"><a href="https://www.deeplearning.ai/syllabus.pdf">Download the syllabus</a></div>
<section id="instructors"><h2>Instructors</h2><p>Andrew Ng</p></section>
</body></html>`;

const WEEK_SUBTOPIC_PAGE = `<!doctype html><html><head>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Course","name":"Generative AI for Everyone\u3164"}</script>
</head><body>
<h2>Course Outline</h2><div><div>
<h3 class="text-neutral">Generative AI for Everyone\u3164</h3>
<div class="space-y-5"><div><details><summary><div><div>Week 1: Introduction to Generative AI</div></div></summary>
<div class="collapse-content py-0"><ul><div class="flex flex-col gap-y-3">
<div class="w-full"><button type="button" aria-expanded="false" class="hover:bg-base-200 flex w-full items-center gap-2"><svg viewBox="0 0 24 24"><path d="M4 4"/></svg><span class="subtitle3 text-neutral text-left">What is Generative AI?</span></button></div>
<li class="cursor-pointer px-2 py-2.5"><a class="flex w-full items-start gap-2" href="https://learn.deeplearning.ai/courses/generative-ai-for-everyone/lesson/iz3ogs/what-is-generative-ai"><svg viewBox="0 0 24 24"><path d="M16 12"/></svg><div class="grid gap-1"><div class="body2 text-left">What is Generative AI?</div><div class="text-base-content-secondary label1 flex flex-wrap"><div>Video</div><div>・</div><div>4m</div></div></div></a></li>
<li class="cursor-pointer px-2 py-2.5"><a class="flex w-full items-start gap-2" href="https://learn.deeplearning.ai/courses/generative-ai-for-everyone/lesson/9a58ed/how-generative-ai-works"><svg viewBox="0 0 24 24"><path d="M16 12"/></svg><div class="grid gap-1"><div class="body2 text-left">How Generative AI works</div><div class="text-base-content-secondary label1 flex flex-wrap"><div>Video</div><div>・</div><div>9m</div></div></div></a></li>
<div class="w-full"><button type="button" aria-expanded="false" class="hover:bg-base-200 flex w-full items-center gap-2"><svg viewBox="0 0 24 24"><path d="M4 4"/></svg><span class="subtitle3 text-neutral text-left">Resources</span></button></div>
<li class="cursor-pointer px-2 py-2.5"><a class="flex w-full items-start gap-2" href="https://learn.deeplearning.ai/courses/generative-ai-for-everyone/lesson/iz3ogz/forum"><svg viewBox="0 0 24 24"><path d="M16 12"/></svg><div class="grid gap-1"><div class="body2 text-left">Join the forum</div><div class="text-base-content-secondary label1 flex flex-wrap"><div>Reading</div><div>・</div><div>1m</div></div></div></a></li>
</div></ul></div></details></div>
<div><details><summary><div><div>Week 2: Generative AI Projects</div></div></summary>
<div class="collapse-content py-0"><ul><div>
<li class="cursor-pointer px-2 py-2.5"><a class="flex w-full items-start gap-2" href="https://learn.deeplearning.ai/courses/generative-ai-for-everyone/lesson/aa11bb/lifecycle-of-a-project"><svg viewBox="0 0 24 24"><path d="M16 12"/></svg><div class="grid gap-1"><div class="body2 text-left">Lifecycle of a generative AI project</div><div class="text-base-content-secondary label1 flex flex-wrap"><div>Video</div><div>・</div><div>11m</div></div></div></a></li>
</div></ul></div></details></div>
</div></div></div>
<section><h2>Instructors</h2></section></body></html>`;

const NO_OUTLINE_PAGE = `<!doctype html><html><body><h1>Some Course</h1><section><h2>Overview</h2><p>No outline here.</p></section></body></html>`;

console.log('\n[1] module-based home page (video entries + links, segments kept)');
const moduleOutline = parseCourseOutline(MODULE_PAGE, { url: 'https://www.deeplearning.ai/courses/agentic-ai' });
check('outline found', moduleOutline.found);
check('course title from ld+json', moduleOutline.courseTitle === 'Agentic AI', moduleOutline.courseTitle);
check('2 module groups', moduleOutline.stats.groups === 2, `got ${moduleOutline.stats.groups}`);
check('group kind = module', moduleOutline.groups.every((g) => g.kind === 'module'));
check('group titles preserved', moduleOutline.groups[0].title === 'Module 1: Introduction to Agentic Workflows', moduleOutline.groups[0].title);
check('6 entries parsed (incl. non-video)', moduleOutline.stats.items === 6, `got ${moduleOutline.stats.items}`);
check('4 videos detected', moduleOutline.stats.videos === 4, `got ${moduleOutline.stats.videos}`);
check('syllabus link ignored', !JSON.stringify(moduleOutline).includes('syllabus.pdf'));
check('title text is clean of the meta label', moduleOutline.groups[0].items[0].text === 'Welcome!', moduleOutline.groups[0].items[0].text);
check('duration parsed', moduleOutline.groups[0].items[1].duration === '5m', moduleOutline.groups[0].items[1].duration);
check('graded label parsed', moduleOutline.groups[0].items[3].type === 'Graded', moduleOutline.groups[0].items[3].type);
check('link kept verbatim', moduleOutline.groups[0].items[1].url === 'https://learn.deeplearning.ai/courses/agentic-ai/lesson/nae3i1/what-is-agentic-ai%3F');

const videosOnly = filterOutline(moduleOutline, { types: ['video'] });
check('filter keeps 4 videos', videosOnly.stats.videos === 4, `got ${videosOnly.stats.videos}`);
check('filter reports skipped non-video', videosOnly.skipped === 2, `got ${videosOnly.skipped}`);
check('filter drops the Reading entry', !(videosOnly.groups[0].items || []).some((i) => i.type === 'Reading'));
check('filter keeps module blocks', videosOnly.groups.length === 2 && videosOnly.groups[1].items.length === 2);
check('filter keeps entry order', videosOnly.groups[0].items.map((i) => i.text).join('|') === 'Welcome!|What is agentic AI?');

const allTypes = filterOutline(moduleOutline, { types: ['all'] });
check('types=all keeps everything', allTypes.stats.items === 6, `got ${allTypes.stats.items}`);

console.log('\n[2] week + subtopic home page');
const weekOutline = parseCourseOutline(WEEK_SUBTOPIC_PAGE, { url: 'https://www.deeplearning.ai/courses/generative-ai-for-everyone' });
check('outline found', weekOutline.found);
check('U+3164 stripped from the course title', weekOutline.courseTitle === 'Generative AI for Everyone', JSON.stringify(weekOutline.courseTitle));
check('2 week groups', weekOutline.stats.groups === 2, `got ${weekOutline.stats.groups}`);
check('week kind detected', weekOutline.groups.every((g) => g.kind === 'week'));
check('2 subtopics detected', weekOutline.stats.subgroups === 2, `got ${weekOutline.stats.subgroups}`);
check('subtopic title preserved', weekOutline.groups[0].subgroups[0].title === 'What is Generative AI?');
check('subtopic holds its videos', weekOutline.groups[0].subgroups[0].items.length === 2);
check('non-video entry stays inside its subtopic', weekOutline.groups[0].subgroups[1].items[0].text === 'Join the forum');
check('week without subtopics keeps direct entries', weekOutline.groups[1].items.length === 1, `got ${weekOutline.groups[1].items.length}`);
const weekVideos = filterOutline(weekOutline, { types: ['video'] });
check('video filter: 3 videos', weekVideos.stats.videos === 3, `got ${weekVideos.stats.videos}`);
check('video filter drops the empty "Resources" subtopic', weekVideos.groups[0].subgroups.length === 1, `got ${weekVideos.groups[0].subgroups.length}`);
const noSub = filterOutline(weekOutline, { types: ['video'], includeSubtopics: false });
check('--no-subtopics flattens entries up into the week', noSub.groups[0].items.length === 2 && noSub.groups[0].subgroups.length === 0 && noSub.stats.videos === 3,
  `items=${noSub.groups[0].items.length} subgroups=${noSub.groups[0].subgroups.length} videos=${noSub.stats.videos}`);

console.log('\n[3] pages without a Course Outline block');
const none = parseCourseOutline(NO_OUTLINE_PAGE, { url: 'https://www.deeplearning.ai/courses/none' });
check('found = false', none.found === false);
check('no groups', none.groups.length === 0);

console.log('\n[4] Feishu blocks: plain-text entries by default');
const blocks = buildOutlineBlocks({ outline: videosOnly, docTitle: 'Agentic AI · Course Outline 课程大纲', meta: 'meta' });
const bullets = blocks.filter((b) => b.block_type === 12);
const runOf = (b) => b.bullet.elements[0].text_run;
check('one bullet per video', bullets.length === 4, `got ${bullets.length}`);
check('entry text kept verbatim', runOf(bullets[0]).content === videosOnly.groups[0].items[0].text, runOf(bullets[0]).content);
check('no hyperlink run anywhere in the doc', !JSON.stringify(blocks).includes('"link"'));
check('no lesson URL leaks into the doc blocks', !JSON.stringify(blocks).includes('learn.deeplearning.ai'));
check('bullet style is empty (plain text)', Object.keys(runOf(bullets[0]).text_element_style).length === 0, JSON.stringify(runOf(bullets[0]).text_element_style));
check('H1 doc title first', blocks[0].block_type === 3 && blocks[0].heading1.elements[0].text_run.content.startsWith('Agentic AI · Course Outline'));
check('H2 per module block', blocks.some((b) => b.block_type === 4 && b.heading2.elements[0].text_run.content === 'Module 2: Reflection Design Pattern'));
check('H3 subtopic blocks still kept, also plain text', (() => {
  const weekBlocks = buildOutlineBlocks({ outline: weekVideos, docTitle: 'x', meta: 'meta' });
  return weekBlocks.some((b) => b.block_type === 5) && !JSON.stringify(weekBlocks).includes('"link"');
})());

console.log('\n[4b] outlineLinks = true restores clickable titles');
const linked = buildOutlineBlocks({ outline: videosOnly, docTitle: 'Agentic AI · Course Outline 课程大纲', meta: 'meta', links: true });
const linkedBullets = linked.filter((b) => b.block_type === 12);
check('same number of bullets', linkedBullets.length === bullets.length);
const link = linkedBullets[1].bullet.elements[0].text_run.text_element_style.link.url;
check('link is percent-encoded', link === encodeURIComponent('https://learn.deeplearning.ai/courses/agentic-ai/lesson/nae3i1/what-is-agentic-ai%3F'), link);
check('link decodes to the source URL', decodeURIComponent(link) === videosOnly.groups[0].items[1].url);
check('text unchanged by the links mode', linkedBullets[1].bullet.elements[0].text_run.content === bullets[1].bullet.elements[0].text_run.content);

console.log('\n[5] adapter URL handling');
check('learn URL matches', dlMatch('https://learn.deeplearning.ai/courses/agentic-ai'));
check('home URL matches', dlMatch('https://www.deeplearning.ai/courses/agentic-ai'));
check('lesson deep link matches', dlMatch('https://learn.deeplearning.ai/courses/agentic-ai/lesson/pu5xbv/welcome!'));
check('course index does NOT match', !dlMatch('https://www.deeplearning.ai/courses'));
check('blog URL does NOT match', !dlMatch('https://www.deeplearning.ai/the-batch'));
check('youtube URL uses another adapter', pickAdapter('https://www.youtube.com/watch?v=abc').id === 'youtube');
check('slug from both shapes', slugFromUrl('https://learn.deeplearning.ai/courses/agentic-ai/lesson/x/y') === 'agentic-ai' && slugFromUrl('https://www.deeplearning.ai/courses/agentic-ai') === 'agentic-ai');
check('learn URL derived from the slug', learnCourseUrl('agentic-ai') === 'https://learn.deeplearning.ai/courses/agentic-ai');
check('home candidates include short-courses', homeCourseUrls('x').join(',') === 'https://www.deeplearning.ai/courses/x,https://www.deeplearning.ai/short-courses/x');
check('deeplearning adapter exposes discoverOutline', typeof pickAdapter('https://www.deeplearning.ai/courses/agentic-ai').discoverOutline === 'function');

console.log('\n[6] helpers');
check('isVideoType(Video)', isVideoType('Video'));
check('isVideoType(Video (optional))', isVideoType('Video (optional)'));
check('isVideoType(Reading) = false', !isVideoType('Reading'));
check('matchesType(Video (optional), video)', matchesType('Video (optional)', 'video'));
check('matchesType(Reading, video) = false', !matchesType('Reading', 'video'));
check('slugifyName matches learn slugs',
  slugifyName('Task decomposition: Identifying the steps in a workflow') === 'task-decomposition%3A-identifying-the-steps-in-a-workflow' &&
  slugifyName('Evaluating agentic AI (evals)') === 'evaluating-agentic-ai-(evals)' &&
  slugifyName('Welcome!') === 'welcome!');
check('encodeLinkUrl escapes reserved chars', encodeLinkUrl('https://a/b?c=d') === 'https%3A%2F%2Fa%2Fb%3Fc%3Dd');
check('report shape exposes text + url', (() => {
  const r = outlineToReport(videosOnly);
  return r.groups[0].videos[0].text === 'Welcome!' && r.groups[0].videos[0].url.startsWith('https://learn.deeplearning.ai/');
})());

// ---------------------------------------------------------------- live
const liveIdx = process.argv.indexOf('--live');
if (liveIdx >= 0) {
  const url = process.argv[liveIdx + 1];
  if (!url) {
    console.error('--live needs a course URL');
    process.exit(2);
  }
  console.log(`\n[live] ${url}`);
  const adapter = pickAdapter(url);
  const outline = await adapter.discoverOutline(url, { source: process.argv[process.argv.indexOf('--source') + 1] || 'auto' });
  const mixed = filterOutline(outline, { types: ['video'] });
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(outlineToReport(mixed), null, 2));
  } else {
    console.log(`title:  ${outline.courseTitle}`);
    console.log(`source: ${outline.source} <${outline.sourceUrl}>`);
    console.log(`home video count: ${outline.homeVideoCount ?? 'n/a'} / lesson-tree video count: ${outline.learnVideoCount ?? 'n/a'}`);
    for (const w of outline.warnings || []) console.log(`warning: ${w}`);
    for (const g of mixed.groups) {
      console.log(`  ${g.title}  (${g.items.length} videos, ${g.subgroups.length} subtopics)`);
      for (const it of g.items) console.log(`      - ${it.text}\n        ${it.url}`);
      for (const s of g.subgroups) {
        console.log(`      · ${s.title} (${s.items.length})`);
        for (const it of s.items) console.log(`          - ${it.text}\n            ${it.url}`);
      }
    }
    console.log(`  total: ${mixed.stats.videos} videos / ${mixed.stats.groups} blocks / ${mixed.skipped} non-video entries filtered`);
  }
}

console.log(`\n${passed} checks passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
