#!/usr/bin/env node
// course-subtitles CLI: run the course->subtitles->translation->sections->Feishu pipeline,
// or export a course outline (video entries + links, week/module grouped) to one Feishu doc.
// Zero dependencies (Node >= 18 built-ins only).
import { loadConfig, feishuTokenFrom } from '../src/engine/config.js';
import { hasLlmCredential, llmCandidates, probeCandidate } from '../src/engine/llm.js';
import { adapters } from '../src/engine/adapters/index.js';
import { runPipeline, runOutlinePipeline } from '../src/engine/pipeline.js';
import { formatOutline } from '../src/engine/outline.js';
import { proxyState, resetProxyCache } from '../src/engine/proxy.js';

function usage() {
  console.log(`course-subtitles — extract course video subtitles, translate line-by-line (EN/ZH),
generate section headings, and publish Feishu docs. Also exports a course outline.

Usage:
  course-subtitles run [options]      subtitles pipeline (one Feishu doc per lesson)
  course-subtitles outline [options]  Course Outline export (ONE Feishu doc: video text + links)
  course-subtitles adapters           list supported platform adapters
  course-subtitles proxy [options]    show the proxy the engine would use (auto-detected)
  course-subtitles llm [--probe]      list the LLM credentials that will be tried, in order
  course-subtitles config [--show]    print resolved config (secrets redacted)

Options (run):
  --course <url>              course URL (learn.deeplearning.ai / youtube / bilibili / coursera)
  --parent <url|token>        Feishu parent wiki/doc to place lesson docs under
  --config <path>             path to a JSON config file
  --proxy <url>               force a proxy (e.g. http://127.0.0.1:10809 or
                              socks5://127.0.0.1:10808); default: auto-detect from
                              HTTPS_PROXY / the Windows system proxy / local ports
  --proxy-mode <mode>         auto (default; direct first, proxy on failure) | always | off
  --no-proxy                  never use a proxy (same as --proxy-mode off)
  --lessons <spec>            process subset, e.g. "1-5,8"
  --force                     recompute everything from scratch and rebuild the
                              existing docs in place (same URL)
  --update-doc                rewrite the existing docs in place (same URL) from
                              cached content; no re-download, no re-translation
  --dry-run                   fetch/translate/section only; do not write Feishu
  --no-group                  disable week/module grouping (flat under parent)
  --no-segment                keep raw caption fragments (no sentence merging)
  --skip-translate            keep English only (zh lines empty)
  --skip-sections             no section headings
  --skip-feishu               no Feishu output at all
  --cache-dir <path>          override cache directory
  --json                      print machine-readable report JSON

Options (outline):
  --course <url>              course home page (www.deeplearning.ai/courses/<slug>) or learn URL
  --parent <url|token>        Feishu parent wiki node for the outline doc
  --types <list>              entry types to keep (default: video; "all" keeps everything)
  --title <text>              Feishu doc title (default: "<Course> · Course Outline 课程大纲")
  --source <auto|homepage|learn>
                              where the outline comes from (default: auto = home page,
                              verified/completed against the platform lesson tree)
  --no-subtopics              drop the subtopic level (weeks/modules only)
  --outline-links             make video titles clickable again (default: plain
                              text bullets, no hyperlink runs in the doc)
  --update-doc                rewrite an existing outline doc in place (same URL)
  --force / --dry-run / --json / --config as above
`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const raw = a.slice(2);
    const key = raw.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

async function main() {
  const [cmdRaw, ...rest] = process.argv.slice(2);
  const cmd = cmdRaw && !cmdRaw.startsWith('--') ? cmdRaw : 'run';
  const args = parseArgs(cmdRaw && !cmdRaw.startsWith('--') ? rest : process.argv.slice(2));

  if (cmd === 'adapters') {
    for (const a of adapters) {
      console.log(`${a.id.padEnd(12)} ${a.name}${typeof a.hasOutline === 'boolean' ? `   outline: ${a.hasOutline ? 'yes' : 'no'}` : ''}`);
    }
    return;
  }

  const { config, configPath } = loadConfig(args.config);
  if (cmd === 'proxy') {
    config.proxyUrl = args.proxy || config.proxyUrl;
    resetProxyCache();
    const target = String(args.target || 'www.youtube.com:443');
    const idx = target.lastIndexOf(':');
    const state = await proxyState(config, { host: idx > 0 ? target.slice(0, idx) : target, port: idx > 0 ? Number(target.slice(idx + 1)) || 443 : 443 });
    if (args.json) {
      console.log(JSON.stringify(state, null, 2));
      return;
    }
    console.log(`mode: ${state.mode}${state.configured ? ` (configured: ${state.configured})` : ' (auto-detected)'}`);
    console.log(`target: ${state.target}`);
    const sys = state.windowsSystemProxy;
    console.log(`windows system proxy: ${sys ? `${sys.server || 'none'}${sys.enabled ? '' : ' (disabled)'}${sys.error ? ` (${sys.error})` : ''}${sys.pac ? ` pac=${sys.pac}` : ''}` : 'n/a'}`);
    console.log(`env: HTTPS_PROXY=${state.env.HTTPS_PROXY || '-'} HTTP_PROXY=${state.env.HTTP_PROXY || '-'} ALL_PROXY=${state.env.ALL_PROXY || '-'} NO_PROXY=${state.env.NO_PROXY || '-'}`);
    console.log(`bypass: ${state.bypass.length ? state.bypass.join(', ') : '-'}`);
    console.log(`selected: ${state.selected ? `${state.selected.url} (${state.selected.source})` : 'none — direct only'}`);
    console.log(`yt-dlp: ${state.ytDlp ? `${state.ytDlp.command} ${state.ytDlp.version}` : `not found${state.ytDlpError ? ` (${state.ytDlpError})` : ''}`}`);
    console.log('candidates:');
    for (const c of state.candidates) {
      console.log(`  ${c.usable ? 'OK  ' : c.alive ? 'FAIL' : '----'} ${c.url.padEnd(28)} ${c.source.padEnd(16)} ${c.error || ''}`.trimEnd());
    }
    return;
  }
  if (cmd === 'config') {
    const redacted = { ...config };
    if (redacted.feishuAppSecret) redacted.feishuAppSecret = redacted.feishuAppSecret.slice(0, 4) + '***';
    if (redacted.feishuAppId) redacted.feishuAppId = redacted.feishuAppId.slice(0, 4) + '***';
    if (redacted.llmApiKey) redacted.llmApiKey = redacted.llmApiKey.slice(0, 4) + '***';
    if (redacted.courseraCookie) redacted.courseraCookie = '***';
    console.log(JSON.stringify({ configPath, config: redacted }, null, 2));
    return;
  }
  if (cmd === 'llm') {
    const chain = llmCandidates(config);
    if (!chain.length) {
      console.log('no LLM credential found.');
      console.log('Set LLM_API_KEY / DEEPSEEK_API_KEY, declare `llmProviders` in the config file,');
      console.log('or store a key in $DSH_HOME/.credentials.yaml — then re-run.');
      return;
    }
    console.log(`chain (${chain.length} candidate${chain.length > 1 ? 's' : ''}, tried in order):`);
    for (const [i, c] of chain.entries()) {
      console.log(`  ${i + 1}. ${c.label.padEnd(12)} ${c.model.padEnd(22)} ${c.baseUrl}  [${c.api}, key from ${c.source}]`);
      if (args.probe) {
        const r = await probeCandidate(c);
        console.log(`      -> ${r.ok ? `OK (${r.ms}ms)` : `FAIL (${r.ms}ms): ${r.error}`}`);
      }
    }
    if (!args.probe) console.log('(pass --probe to ping each credential)');
    return;
  }

  if (cmd !== 'run' && cmd !== 'outline') {
    usage();
    process.exit(2);
  }

  // CLI overrides
  if (args.course) config.courseUrl = args.course;
  if (args.parent) config.feishuParent = args.parent;
  if (args.lessons) config.lessons = args.lessons;
  if (args.force) config.force = true;
  if (args.updateDoc) config.updateDoc = true;
  if (args.dryRun) config.dryRun = true;
  if (args.noGroup) config.groupByWeek = false;
  if (args.noSegment) config.segmentSentences = false;
  if (args.skipTranslate) config.skipTranslate = true;
  if (args.skipSections) config.skipSections = true;
  if (args.skipFeishu) config.skipFeishu = true;
  if (args.cacheDir) config.cacheDir = args.cacheDir;
  if (args.proxy) config.proxyUrl = args.proxy;
  if (args.proxyMode) config.proxyMode = args.proxyMode;
  if (args.noProxy) config.proxyMode = 'off';
  if (args.ytDlp) config.ytDlpPath = args.ytDlp;
  if (args.noYtDlp) config.youtubeYtDlp = false;
  // outline-specific
  if (args.types) config.outlineTypes = String(args.types).split(',').map((t) => t.trim()).filter(Boolean);
  if (args.title) config.outlineTitle = args.title;
  if (args.source) config.outlineSource = args.source;
  if (args.noSubtopics) config.outlineIncludeSubtopics = false;
  if (args.outlineLinks) config.outlineLinks = true;

  if (!config.courseUrl) { console.error('missing --course'); usage(); process.exit(2); }
  const needFeishu = !config.dryRun && !config.skipFeishu;
  if (needFeishu && !config.feishuAppSecret) { console.error('missing feishuAppSecret (set FEISHU_APP_SECRET env or config)'); process.exit(2); }
  if (needFeishu && !feishuTokenFrom(config.feishuParent)) { console.error('missing --parent (Feishu wiki/doc link or token)'); usage(); process.exit(2); }
  if (cmd === 'run' && !config.skipTranslate && !config.skipSections && !hasLlmCredential(config)) {
    console.error('no LLM credential found (set LLM_API_KEY / DEEPSEEK_API_KEY, declare `llmProviders`,');
    console.error('or store a key in $DSH_HOME/.credentials.yaml). Run `course-subtitles llm` to see the chain.');
    process.exit(2);
  }

  const run = cmd === 'outline' ? runOutlinePipeline : runPipeline;
  const report = await run(config, {
    onEvent: (e) => {
      if (args.json) return;
      const line = fmtEvent(e);
      if (line) console.log(line);
    },
  });

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (cmd === 'outline') {
    console.log(`\n${formatOutline(reportOutline(report))}`);
    const st = report.stats || {};
    console.log(`\nCourse Outline: ${st.videos ?? 0} video(s) in ${st.groups ?? 0} block(s) (source: ${report.source}, ${report.status}).`);
    if (report.url) console.log(`Feishu doc: ${report.url}`);
    if (report.warnings?.length) for (const w of report.warnings) console.log(`note: ${w}`);
    return;
  }

  const ok = report.lessons.filter((l) => !l.error).length;
  const failed = report.lessons.filter((l) => l.error).length;
  console.log(`\nDone: ${ok} ok, ${failed} failed (adapter=${report.adapter})`);
}

/** Report groups ({ videos: [{text,url}] }) back into the outline shape for printing. */
function reportOutline(report) {
  return {
    courseTitle: '',
    source: report.source,
    groups: (report.groups || []).map((g) => ({
      title: g.title,
      kind: g.kind,
      items: g.videos || [],
      subgroups: (g.subgroups || []).map((s) => ({ title: s.title, items: s.videos || [] })),
    })),
    stats: report.stats,
    skipped: report.skipped,
  };
}

function fmtEvent(e) {
  switch (e.type) {
    case 'adapter': return `adapter: ${e.adapter}${e.mode ? ` (${e.mode})` : ''}`;
    case 'proxy': return `proxy: ${e.selected ? `${e.selected.url} (${e.selected.source})` : 'none — direct only'}${e.systemProxy ? `, system proxy ${e.systemProxy}` : ''}${e.ytDlp ? `, yt-dlp ${e.ytDlp}` : ''}`;
    case 'discovered': return `discovered ${e.selected}/${e.total} video lessons`;
    case 'group': return `group ${e.key}: ${e.name} -> ${e.node}`;
    case 'week': return `week ${e.week}: ${e.name} -> ${e.node}`;
    case 'outline': return `outline: ${e.groups} blocks (${e.subtopics} subtopics), ${e.videos} entries kept, ${e.skipped} filtered — ${e.sourceUrl || e.source}`;
    case 'warning': return `warning: ${e.message}`;
    case 'segment': return `[${String(e.seq).padStart(2, '0')}] segment ${e.fragments} fragments -> sentences: ${e.lesson}`;
    case 'segment-method': return e.method === 'punctuation'
      ? `  whole sentences from caption punctuation (${e.fragments} fragments -> ${e.sentences} sentences, no LLM)`
      : `  sentence grouping via LLM (${e.fragments} fragments -> ${e.sentences} sentences)`;
    case 'sections-moved': return `  ${e.moved} section heading(s) moved to a sentence start`;
    case 'sections-dropped': return `  ${e.dropped} section heading(s) dropped (no sentence boundary available)`;
    case 'translate': return `[${String(e.seq).padStart(2, '0')}] translating ${e.lines} ${e.segmented ? 'sentences' : 'lines'}: ${e.lesson}`;
    case 'translate-progress': return `  translate chunk ${e.done}/${e.total}`;
    case 'sections': return `[${String(e.seq).padStart(2, '0')}] sections: ${e.lesson}`;
    case 'created': return `[${e.mode === 'outline' ? 'outline' : String(e.seq).padStart(2, '0')}] created ${e.docTitle || e.lesson} -> ${e.url}`;
    case 'updated': return `[${e.mode === 'outline' ? 'outline' : String(e.seq).padStart(2, '0')}] rebuilt in place ${e.docTitle || e.lesson} -> ${e.url}`;
    case 'skipped': return `[${e.mode === 'outline' ? 'outline' : String(e.seq).padStart(2, '0')}] skipped (exists) ${e.docTitle || e.lesson}`;
    case 'preview': return `[${e.mode === 'outline' ? 'outline' : String(e.seq).padStart(2, '0')}] dry-run ${e.docTitle || e.lesson} (${e.blocks} blocks)`;
    case 'error': return `[${String(e.seq).padStart(2, '0')}] ERROR ${e.lesson}: ${e.error}`;
    case 'done': return '';
    default: return null;
  }
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
