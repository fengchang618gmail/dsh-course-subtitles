// Host half of dsh-course-subtitles: a cordis plugin that
//  - registers the `course-subtitles` settings namespace (settings.yaml) for the
//    non-secret configuration, and reads every secret through the credentials
//    store (`$DSH_HOME/.credentials.yaml`) instead of a plugin-local config file;
//  - exposes the engine as same-origin HTTP routes AND as agent-facing tools
//    (course_subtitles_run / course_subtitles_status). There is no GUI
//    configuration page: invocation uses the stored configuration as-is.
import crypto from 'node:crypto';
import z from '@deepseek-ai/schemastery';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { runPipeline, runOutlinePipeline } from '../engine/pipeline.js';
import { DEFAULT_CONFIG } from '../engine/config.js';
import { hasLlmCredential, describeCandidates, llmCandidates, probeCandidate } from '../engine/llm.js';
import { proxyState, resetProxyCache } from '../engine/proxy.js';

export const name = 'course-subtitles';
export const inject = ['webServer', 'credentials', 'tools'];

/** Settings namespace owning the plugin's non-secret configuration. */
export const NS = 'course-subtitles';

/**
 * Credential references backing the plugin's secrets. The values live in the
 * harness credentials store (`$DSH_HOME/.credentials.yaml`) — the same refs the
 * rest of the deployment uses — so no secret ever rides the settings document
 * or a private config file.
 */
export const CREDENTIAL_REFS = {
  feishuAppId: credentialRef('FEISHU_APP_ID'),
  feishuAppSecret: credentialRef('FEISHU_APP_SECRET'),
  llmApiKey: credentialRef('DEEPSEEK_API_KEY'),
  courseraCookie: credentialRef('COURSERA_COOKIE'),
};

/** Non-secret settings schema; engine defaults double as schema defaults. */
const Config = z.object({
  courseUrl: z.string().default(DEFAULT_CONFIG.courseUrl),
  courseDisplayName: z.string().default(DEFAULT_CONFIG.courseDisplayName),
  feishuDomain: z.string().default(DEFAULT_CONFIG.feishuDomain),
  feishuParent: z.string().default(DEFAULT_CONFIG.feishuParent),
  groupByWeek: z.boolean().default(true),
  weekNames: z.dict(z.string()).default(DEFAULT_CONFIG.weekNames),
  groupNames: z.dict(z.string()).default({}),
  outlineSource: z.string().default(DEFAULT_CONFIG.outlineSource),
  outlineTypes: z.array(z.string()).default([...DEFAULT_CONFIG.outlineTypes]),
  outlineIncludeSubtopics: z.boolean().default(true),
  outlineTitle: z.string().default(''),
  outlineLinks: z.boolean().default(false),
  llmBaseUrl: z.string().default(DEFAULT_CONFIG.llmBaseUrl),
  llmModel: z.string().default(DEFAULT_CONFIG.llmModel),
  llmProviders: z.array(z.any()).default([]),
  llmTemperature: z.number().default(DEFAULT_CONFIG.llmTemperature),
  translateChunkSize: z.number().default(DEFAULT_CONFIG.translateChunkSize),
  llmConcurrency: z.number().default(DEFAULT_CONFIG.llmConcurrency),
  cacheDir: z.string().default(''),
  lessons: z.string().default(''),
  force: z.boolean().default(false),
  updateDoc: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  skipTranslate: z.boolean().default(false),
  skipSections: z.boolean().default(false),
  skipFeishu: z.boolean().default(false),
  segmentSentences: z.boolean().default(true),
  proxyUrl: z.string().default(''),
  proxyMode: z.string().default(DEFAULT_CONFIG.proxyMode),
  proxyBypass: z.string().default(''),
  proxyProbePorts: z.string().default(''),
  ytDlpPath: z.string().default(''),
  youtubeYtDlp: z.boolean().default(true),
  zhTitles: z.dict(z.string()).default({}),
  lessonTitles: z.dict(z.string()).default({}),
});

/** Namespace fields that belong in the settings document (the rest are secrets). */
const CONFIG_KEYS = [
  'courseUrl', 'courseDisplayName', 'feishuDomain', 'feishuParent', 'groupByWeek', 'weekNames',
  'groupNames', 'outlineSource', 'outlineTypes', 'outlineIncludeSubtopics', 'outlineTitle', 'outlineLinks',
  'llmBaseUrl', 'llmModel', 'llmProviders', 'llmTemperature', 'translateChunkSize', 'llmConcurrency',
  'cacheDir', 'lessons', 'force', 'updateDoc', 'dryRun', 'skipTranslate', 'skipSections',
  'skipFeishu', 'segmentSentences', 'proxyUrl', 'proxyMode', 'proxyBypass', 'proxyProbePorts',
  'ytDlpPath', 'youtubeYtDlp', 'zhTitles', 'lessonTitles',
];

/** A value the old UI round-tripped through its mask — never store it. */
const MASKED_VALUE = /\*\*\*$/;

function maskSecrets(cfg) {
  const c = { ...cfg };
  if (c.feishuAppSecret) c.feishuAppSecret = c.feishuAppSecret.slice(0, 4) + '***';
  if (c.llmApiKey) c.llmApiKey = c.llmApiKey.slice(0, 4) + '***';
  if (c.feishuAppId) c.feishuAppId = c.feishuAppId.slice(0, 4) + '***';
  if (c.courseraCookie) c.courseraCookie = '***';
  return c;
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

export function apply(ctx, config = {}) {
  const runs = new Map(); // runId -> {status, events, report, startedAt, finishedAt, error}
  // Effective settings value: engine defaults + resolved settings namespace.
  let source = () => ({ ...DEFAULT_CONFIG, ...config });

  // Register the settings namespace (manual installSettingsSection so the HTTP
  // routes can also write the document). When no settings service is mounted,
  // `scope` stays null and the routes keep serving the composition defaults.
  let scope = null;
  ctx.inject(['settings'], (sctx) => {
    scope = sctx.settings.register(NS, Config, { base: config });
    source = () => ({ ...DEFAULT_CONFIG, ...scope.get() });
    sctx.effect(() => () => {
      source = () => ({ ...DEFAULT_CONFIG, ...config });
    });
    scope.watch(() => {});
  });

  /** Settings value plus secrets resolved from the credentials store. */
  async function resolveSecrets(overrides = {}) {
    const base = source();
    const clean = { ...overrides };
    // An empty or masked override means "not provided": it must never clobber
    // the stored settings value or the live credential.
    for (const [k, v] of Object.entries(clean)) {
      if (typeof v === 'string' && (v.length === 0 || MASKED_VALUE.test(v))) delete clean[k];
    }
    const merged = {};
    for (const [field, ref] of Object.entries(CREDENTIAL_REFS)) {
      const override = clean[field];
      if (typeof override === 'string' && override.length > 0) {
        merged[field] = override;
        continue;
      }
      const entry = await ctx.credentials.resolve(ref);
      merged[field] = entry?.value ?? base[field] ?? '';
    }
    return { ...base, ...merged, ...clean };
  }

  /** Persist one body: non-secret fields to settings, secrets to credentials. */
  async function persist(body = {}) {
    const settingsPatch = {};
    for (const key of CONFIG_KEYS) if (body[key] !== undefined) settingsPatch[key] = body[key];
    if (scope && Object.keys(settingsPatch).length > 0) await scope.update(settingsPatch);
    for (const [field, ref] of Object.entries(CREDENTIAL_REFS)) {
      const value = body[field];
      if (typeof value !== 'string' || value.length === 0 || MASKED_VALUE.test(value)) continue;
      await ctx.credentials.set(ref, value);
    }
  }

  function startRun(cfg, mode = 'subtitles') {
    const runId = crypto.randomUUID().slice(0, 8);
    const state = { mode, status: 'running', events: [], report: null, startedAt: Date.now(), finishedAt: null, error: null };
    runs.set(runId, state);
    const run = mode === 'outline' ? runOutlinePipeline : runPipeline;
    run(cfg, { onEvent: (e) => state.events.push(e) })
      .then((report) => {
        state.status = 'done';
        state.report = report;
        state.finishedAt = Date.now();
      })
      .catch((e) => {
        state.status = 'error';
        state.error = e.message;
        state.finishedAt = Date.now();
      });
    return runId;
  }

  // NOTE: must call as a method — destructuring `const { register } = ctx.webServer`
  // loses the `this` binding and crashes the real implementation (this.exact).
  const register = (route) => ctx.webServer.register(route);

  function projectRuns() {
    return [...runs.entries()].slice(-10).map(([id, s]) => ({
      runId: id,
      mode: s.mode,
      status: s.status,
      events: s.events.slice(-200),
      report: s.report,
      error: s.error,
      startedAt: s.startedAt,
      finishedAt: s.finishedAt,
    }));
  }

  register({
    kind: 'exact',
    path: '/api/course-subtitles/status',
    handler: (req, res) => {
      sendJson(res, 200, { running: [...runs.values()].some((s) => s.status === 'running'), runs: projectRuns() });
    },
  });

  register({
    kind: 'exact',
    path: '/api/course-subtitles/run',
    handler: async (req, res) => {
      try {
        const raw = await readBody(req);
        const body = raw ? JSON.parse(raw) : {};
        const cfg = await resolveSecrets(body.config || {});
        if (!cfg.courseUrl || !cfg.feishuParent) {
          sendJson(res, 400, { error: 'missing courseUrl / feishuParent — set them under `course-subtitles:` in settings.yaml (secrets live in .credentials.yaml)' });
          return;
        }
        if (!cfg.feishuAppSecret) {
          sendJson(res, 400, { error: 'missing feishuAppSecret — store FEISHU_APP_SECRET in .credentials.yaml' });
          return;
        }
        if (!hasLlmCredential(cfg)) {
          sendJson(res, 400, { error: 'missing an LLM credential — store DEEPSEEK_API_KEY / LLM_API_KEY in .credentials.yaml, or declare `llmProviders`' });
          return;
        }
        if (body.saveConfig) {
          await persist(body.config || {});
        }
        const runId = startRun(cfg);
        sendJson(res, 200, { runId });
      } catch (e) {
        sendJson(res, 400, { error: e.message });
      }
    },
  });

  // Course Outline export: ONE doc listing the video entries (text + link) of the
  // course, grouped by week/module. No LLM calls involved.
  register({
    kind: 'exact',
    path: '/api/course-subtitles/outline',
    handler: async (req, res) => {
      try {
        const raw = await readBody(req);
        const body = raw ? JSON.parse(raw) : {};
        const cfg = await resolveSecrets(body.config || {});
        if (!cfg.courseUrl || !cfg.feishuParent) {
          sendJson(res, 400, { error: 'missing courseUrl / feishuParent — set them under `course-subtitles:` in settings.yaml' });
          return;
        }
        if (!cfg.feishuAppSecret) {
          sendJson(res, 400, { error: 'missing feishuAppSecret — store FEISHU_APP_SECRET in .credentials.yaml' });
          return;
        }
        if (body.saveConfig) await persist(body.config || {});
        const runId = startRun(cfg, 'outline');
        sendJson(res, 200, { runId });
      } catch (e) {
        sendJson(res, 400, { error: e.message });
      }
    },
  });

  register({
    kind: 'exact',
    path: '/api/course-subtitles/config',
    handler: async (req, res) => {
      try {
        if (req.method === 'POST') {
          const raw = await readBody(req);
          const body = raw ? JSON.parse(raw) : {};
          await persist(body);
          const cfg = await resolveSecrets();
          sendJson(res, 200, { ok: true, config: maskSecrets(cfg) });
        } else {
          const cfg = await resolveSecrets();
          const credentials = {};
          for (const [field, ref] of Object.entries(CREDENTIAL_REFS)) {
            credentials[field] = await ctx.credentials.describe(ref);
          }
          sendJson(res, 200, { config: maskSecrets(cfg), credentials, llm: { chain: describeCandidates(cfg) } });
        }
      } catch (e) {
        sendJson(res, 400, { error: e.message });
      }
    },
  });

  // Proxy state: which local proxy (v2rayN / Clash / sing-box / ...) the engine
  // would use, how it was discovered, and whether it really carries traffic.
  register({
    kind: 'exact',
    path: '/api/course-subtitles/proxy',
    handler: async (req, res) => {
      try {
        const cfg = await resolveSecrets();
        resetProxyCache();
        const q = new URL(req.url || '', 'http://localhost').searchParams;
        const target = q.get('target') || 'www.youtube.com:443';
        const [host, port] = [target.slice(0, target.lastIndexOf(':')), Number(target.slice(target.lastIndexOf(':') + 1)) || 443];
        sendJson(res, 200, await proxyState(cfg, { host, port }));
      } catch (e) {
        sendJson(res, 400, { error: e.message });
      }
    },
  });

  register({
    kind: 'exact',
    path: '/api/course-subtitles/adapters',
    handler: (_req, res) => {
      sendJson(res, 200, {
        adapters: [
          { id: 'deeplearning', name: 'DeepLearning.AI', match: 'learn.deeplearning.ai/courses/..., www.deeplearning.ai/courses/...', needs: 'none', outline: true },
          { id: 'youtube', name: 'YouTube', match: 'youtube.com/watch|playlist, youtu.be', needs: 'network to youtube.com (auto-detected local proxy; yt-dlp fallback gets past the WEB bot gate)', outline: false },
          { id: 'bilibili', name: 'Bilibili', match: 'bilibili.com/video/...', needs: 'uploader-provided subtitle track', outline: false },
          { id: 'coursera', name: 'Coursera', match: 'coursera.org/learn/...', needs: 'login cookie (config.courseraCookie)', outline: false },
        ],
      });
    },
  });

  // Agent-facing tools: invoke the pipeline with the STORED configuration, so
  // the caller never has to supply courseUrl / feishuParent (settings.yaml) or
  // secrets (.credentials.yaml) — every parameter is an optional override.
  const str = (required = false) => ({ type: 'string', ...(required ? { required: true } : {}) });
  const bool = (required = false) => ({ type: 'boolean', ...(required ? { required: true } : {}) });
  const output = (properties) => ({
    schema: { type: 'object', additionalProperties: false, properties },
    render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  });

  ctx.tools.register(defineTool({
    name: 'course_subtitles_run',
    description: 'Run the course-subtitles pipeline (fetch video captions, translate EN/ZH, generate section headings, publish one Feishu doc per lesson under the configured parent) using the stored course-subtitles configuration. courseUrl and feishuParent default to the configured values in settings.yaml; secrets come from .credentials.yaml — all parameters are optional overrides. Returns a run id; poll course_subtitles_status for progress and results.',
    parameters: {
      courseUrl: str(),
      feishuParent: str(),
      lessons: str(),
      dryRun: bool(),
      force: bool(),
      updateDoc: bool(),
    },
    output: output({ runId: str(true) }),
    timeoutMs: 20000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const cfg = await resolveSecrets(args);
      if (!cfg.courseUrl) throw new Error('courseUrl is not configured — set it under `course-subtitles:` in settings.yaml, or pass courseUrl');
      if (!cfg.feishuParent) throw new Error('feishuParent is not configured — set it under `course-subtitles:` in settings.yaml, or pass feishuParent');
      if (!cfg.feishuAppSecret) throw new Error('missing feishuAppSecret — store FEISHU_APP_SECRET in .credentials.yaml');
      if (!hasLlmCredential(cfg)) {
        throw new Error('missing an LLM credential — store DEEPSEEK_API_KEY / LLM_API_KEY in .credentials.yaml, or declare `llmProviders`');
      }
      const runId = startRun(cfg);
      return { runId };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'course_outline_run',
    description: 'Export a course outline to ONE Feishu doc: read the "Course Outline" block of the course home page (www.deeplearning.ai/courses/<slug>, or the matching learn.deeplearning.ai course), keep only the requested entry types (default: video), list every video title as PLAIN TEXT (no hyperlink runs; the links stay in the JSON report, and outlineLinks=true makes the titles clickable again), preserve the week/module (and subtopic) blocks, and publish the listing under the configured parent node. No LLM calls. Returns a run id; poll course_subtitles_status for progress and the resulting doc URL.',
    parameters: {
      courseUrl: str(),
      feishuParent: str(),
      types: str(),
      title: str(),
      source: str(),
      outlineLinks: bool(),
      dryRun: bool(),
      force: bool(),
      updateDoc: bool(),
    },
    output: output({ runId: str(true) }),
    timeoutMs: 20000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const overrides = { ...args };
      if (overrides.types) overrides.outlineTypes = overrides.types;
      if (overrides.title) overrides.outlineTitle = overrides.title;
      if (overrides.source) overrides.outlineSource = overrides.source;
      delete overrides.types;
      delete overrides.title;
      delete overrides.source;
      const cfg = await resolveSecrets(overrides);
      if (!cfg.courseUrl) throw new Error('courseUrl is not configured — set it under `course-subtitles:` in settings.yaml, or pass courseUrl');
      if (!cfg.feishuParent) throw new Error('feishuParent is not configured — set it under `course-subtitles:` in settings.yaml, or pass feishuParent');
      if (!cfg.feishuAppSecret) throw new Error('missing feishuAppSecret — store FEISHU_APP_SECRET in .credentials.yaml');
      const runId = startRun(cfg, 'outline');
      return { runId };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'course_subtitles_status',
    description: 'Get the status of course-subtitles / course-outline runs: whether one is running, and the most recent runs with their event logs and reports.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    },
    timeoutMs: 10000,
    isConcurrencySafe: () => true,
    async execute() {
      const lines = [`running: ${[...runs.values()].some((s) => s.status === 'running')}`];
      for (const [id, s] of [...runs.entries()].slice(-10)) {
        lines.push(`- ${id} [${s.mode}] ${s.status}${s.error ? ' error=' + s.error : ''}`);
        for (const e of s.events.slice(-50)) {
          lines.push(`    ${e.type} ${e.lesson ?? e.docTitle ?? e.message ?? ''}${e.error ? ' ' + e.error : ''}`.trimEnd());
        }
        if (s.report) {
          const summary = s.report.mode === 'outline'
            ? {
                mode: 'outline',
                status: s.report.status,
                source: s.report.source,
                docTitle: s.report.docTitle,
                groups: s.report.stats?.groups,
                videos: s.report.stats?.videos,
                skipped: s.report.skipped,
                warnings: s.report.warnings,
                url: s.report.url,
              }
            : {
                proxy: s.report.proxy?.selected ? `${s.report.proxy.selected.url} (${s.report.proxy.selected.source})` : null,
                lessons: s.report.lessons.map((l) => ({ seq: l.seq, status: l.status ?? l.error ?? 'n/a', url: l.url })),
              };
          lines.push(`    report: ${JSON.stringify(summary)}`);
        }
      }
      return lines.join('\n');
    },
  }));

  // Network diagnosis: which local proxy the engine will use for a platform
  // (auto-detected; nothing hardcoded) and whether yt-dlp is available.
  ctx.tools.register(defineTool({
    name: 'course_proxy_status',
    description: 'Report the proxy state this machine would use for course/video downloads: the proxy resolved from config/env/Windows system proxy/local port probe, which candidates answer a real CONNECT or SOCKS5 handshake, and whether yt-dlp is installed. Read-only diagnosis — use it when a YouTube/Bilibili/Coursera run fails to reach the network.',
    parameters: { target: str() },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    },
    timeoutMs: 30000,
    isConcurrencySafe: () => true,
    async execute(args = {}) {
      const cfg = await resolveSecrets();
      resetProxyCache();
      const raw = String(args.target || 'www.youtube.com:443');
      const idx = raw.lastIndexOf(':');
      const state = await proxyState(cfg, { host: idx > 0 ? raw.slice(0, idx) : raw, port: idx > 0 ? Number(raw.slice(idx + 1)) || 443 : 443 });
      const lines = [
        `mode: ${state.mode}${state.configured ? ` (configured: ${state.configured})` : ' (auto-detected)'}`,
        `target: ${state.target}`,
        `windows system proxy: ${state.windowsSystemProxy ? `${state.windowsSystemProxy.server || 'none'}${state.windowsSystemProxy.enabled ? '' : ' (disabled)'}${state.windowsSystemProxy.error ? ` (${state.windowsSystemProxy.error})` : ''}${state.windowsSystemProxy.pac ? ` pac=${state.windowsSystemProxy.pac}` : ''}` : 'n/a'}`,
        `env: HTTPS_PROXY=${state.env.HTTPS_PROXY || '-'} HTTP_PROXY=${state.env.HTTP_PROXY || '-'} ALL_PROXY=${state.env.ALL_PROXY || '-'} NO_PROXY=${state.env.NO_PROXY || '-'}`,
        `bypass: ${state.bypass.length ? state.bypass.join(', ') : '-'}`,
        `selected: ${state.selected ? `${state.selected.url} (${state.selected.source})` : 'none — direct only'}`,
        `yt-dlp: ${state.ytDlp ? `${state.ytDlp.command} ${state.ytDlp.version}` : `not found${state.ytDlpError ? ` (${state.ytDlpError})` : ''}`}`,
        'candidates:',
      ];
      for (const c of state.candidates) {
        lines.push(`  ${c.usable ? 'OK  ' : c.alive ? 'FAIL' : '----'} ${c.url.padEnd(28)} ${c.source.padEnd(16)} ${c.error || ''}`.trimEnd());
      }
      return lines.join('\n');
    },
  }));

  // Credential diagnosis: which LLM credentials this machine exposes, in the
  // order the engine will try them, and (optionally) whether each one answers.
  ctx.tools.register(defineTool({
    name: 'course_llm_status',
    description: 'List the LLM credentials the engine would try, in order, for translation/section work: the configured key first, then every known provider whose API key is present in the environment or in the harness credential store ($DSH_HOME/.credentials.yaml). With probe=true each candidate is pinged individually so a dead or rate-limited credential is visible. Read-only, and never returns key material — use it when a run reports "all LLM credentials failed".',
    parameters: { probe: bool() },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    },
    timeoutMs: 180000,
    isConcurrencySafe: () => true,
    async execute(args = {}) {
      const cfg = await resolveSecrets();
      const chain = llmCandidates(cfg);
      if (!chain.length) {
        return `no LLM credential found — set LLM_API_KEY / DEEPSEEK_API_KEY, declare \`llmProviders\` in settings.yaml, or store a key in $DSH_HOME/.credentials.yaml`;
      }
      const lines = [`chain (${chain.length} candidate${chain.length > 1 ? 's' : ''}, tried in order):`];
      for (const [i, c] of chain.entries()) {
        lines.push(`  ${i + 1}. ${c.label.padEnd(12)} ${c.model.padEnd(22)} ${c.baseUrl}  [${c.api}, key from ${c.source}]`);
        if (args.probe) {
          const r = await probeCandidate(c);
          lines.push(`      -> ${r.ok ? `OK (${r.ms}ms)` : `FAIL (${r.ms}ms): ${r.error}`}`);
        }
      }
      if (!args.probe) lines.push('(pass probe=true to ping each credential)');
      return lines.join('\n');
    },
  }));

  if (ctx.on) {
    ctx.on('dispose', () => {
      for (const s of runs.values()) if (s.status === 'running') s.status = 'stopped';
    });
  }

  ctx.logger?.info?.('[course-subtitles] host ready (settings ns: %s, secrets: %s)', NS, Object.values(CREDENTIAL_REFS).join(', '));
  ctx.logger?.info?.('[course-subtitles] LLM chain: %s', describeCandidates(source()));
}

export default { name, inject, apply };
