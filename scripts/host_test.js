// Host plugin route test with a fake webServer + req/res.
import os from 'node:os';
import path from 'node:path';
import { apply } from '../src/host/index.js';

function fakeRes() {
  return {
    _status: 200,
    _body: null,
    writeHead(s, h) { this._status = s; this._headers = h; },
    end(b) { this._body = b; },
  };
}
function fakeReq(method, body) {
  const req = { method };
  if (body !== undefined) {
    req._body = JSON.stringify(body);
    req.on = (ev, cb) => {
      if (ev === 'data' && req._body) { cb(Buffer.from(req._body)); req._body = null; }
      if (ev === 'end') cb();
      if (ev === 'error') {}
    };
  } else {
    req.on = () => {};
  }
  return req;
}

const routes = {};
const ctx = {
  webServer: { register: (r) => { routes[r.path] = r; } },
  logger: { info: () => {} },
  tools: { register: () => {} },
  // settings service is optional in the real deployment; the fake never mounts
  // it, so `scope` stays null and secrets come only from overrides/credentials.
  inject: () => {},
  credentials: {
    resolve: async () => undefined,
    describe: async () => ({ configured: false, writable: true }),
    set: async () => {},
  },
};
apply(ctx, {});

async function call(path, req) {
  const res = fakeRes();
  await routes[path].handler(req, res);
  return { status: res._status, json: JSON.parse(res._body) };
}

// 1) adapters
const a = await call('/api/course-subtitles/adapters', fakeReq('GET'));
console.log('adapters:', a.json.adapters.map((x) => x.id).join(','), '| status', a.status);

// 2) config GET (may read stored file from DSH_HOME; redact check)
const g = await call('/api/course-subtitles/config', fakeReq('GET'));
console.log('config GET:', 'courseUrl=' + (g.json.config && g.json.config.courseUrl), '| secret masked:', g.json.config && g.json.config.feishuAppSecret ? g.json.config.feishuAppSecret.endsWith('***') : 'n/a');

// 3) status GET (empty)
const s = await call('/api/course-subtitles/status', fakeReq('GET'));
console.log('status GET: running=' + s.json.running, 'runs=' + s.json.runs.length);

// 3b) proxy state (must answer even when no proxy is running or spawning is blocked)
const px = await call('/api/course-subtitles/proxy', fakeReq('GET'));
console.log(
  'proxy GET: status', px.status,
  '| mode', px.json.mode,
  '| selected', px.json.selected ? `${px.json.selected.url} (${px.json.selected.source})` : 'none',
  '| candidates', Array.isArray(px.json.candidates) ? px.json.candidates.length : 'n/a',
  '| yt-dlp', px.json.ytDlp ? px.json.ytDlp.version : 'not found'
);
if (px.status !== 200 || !Array.isArray(px.json.candidates)) throw new Error('proxy route did not report a candidate list');

// 4) run (dry-run + skip translate/sections, lesson 1 only) — should start a background run
process.env.DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const run = await call('/api/course-subtitles/run', fakeReq('POST', {
  config: {
    courseUrl: 'https://learn.deeplearning.ai/courses/generative-ai-for-everyone',
    feishuParent: 'PLACEHOLDER_WIKI_NODE_TOKEN',
    feishuAppSecret: 'YOUR_FEISHU_APP_SECRET',
    llmApiKey: 'sk-test-not-really',
    lessons: '1',
    dryRun: true,
    skipTranslate: true,
    skipSections: true,
    cacheDir: '.test-cache',
  },
  saveConfig: false,
}));
console.log('run POST:', run.status, run.json.runId ? 'runId=' + run.json.runId : JSON.stringify(run.json));

// 5) outline export (dry-run): home page Course Outline -> video entries + links
const outline = await call('/api/course-subtitles/outline', fakeReq('POST', {
  config: {
    courseUrl: 'https://www.deeplearning.ai/courses/agentic-ai',
    feishuParent: 'PLACEHOLDER_WIKI_NODE_TOKEN',
    feishuAppSecret: 'YOUR_FEISHU_APP_SECRET',
    dryRun: true,
  },
  saveConfig: false,
}));
console.log('outline POST:', outline.status, outline.json.runId ? 'runId=' + outline.json.runId : JSON.stringify(outline.json));

// 6) poll status until every run settles (max 60s)
for (let i = 0; i < 120; i++) {
  await new Promise((r) => setTimeout(r, 500));
  const st = await call('/api/course-subtitles/status', fakeReq('GET'));
  if (st.json.runs.some((r) => r.status === 'running')) continue;
  for (const r of st.json.runs) {
    console.log(`run ${r.runId} [${r.mode}] ${r.status}${r.error ? ' error=' + r.error : ''} | events: ${r.events.map((e) => e.type).join(',')}`);
    if (!r.report) continue;
    if (r.report.mode === 'outline') {
      const first = r.report.groups[0];
      console.log(`  outline: source=${r.report.source} groups=${r.report.stats.groups} videos=${r.report.stats.videos} skipped=${r.report.skipped} blocks=${r.report.blocks}`);
      console.log(`  first block: ${first ? `${first.title} -> ${first.videos[0]?.text} <${first.videos[0]?.url}>` : 'n/a'}`);
      if (!r.report.stats.videos) throw new Error('outline run produced no videos');
      if (!first?.videos?.[0]?.url) throw new Error('outline entries carry no links');
    } else {
      console.log('  report lessons:', JSON.stringify(r.report.lessons.map((l) => ({ seq: l.seq, status: l.status || 'n/a' }))));
    }
  }
  process.exit(0);
}
console.log('runs still running after 60s (unexpected)');
process.exit(1);
