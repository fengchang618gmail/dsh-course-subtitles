// Config resolution: built-in defaults (public examples only) < config file < env < CLI.
//
// Nothing in this file is machine-specific: no API key, no Feishu tenant, no wiki
// token, no account id. Secrets are resolved at run time through the environment
// or the harness credential store (see llm.js and credentialsFromStore()).
import fs from 'node:fs';
import path from 'node:path';
import { credentialsFromStore } from './llm.js';

export const DEFAULT_CONFIG = {
  // Course input — a public example course, overridden by config/env/CLI
  courseUrl: 'https://learn.deeplearning.ai/courses/generative-ai-for-everyone',
  courseDisplayName: 'Generative AI for Everyone 给所有人的生成式AI课',
  // Feishu output — all of it comes from the operator's own config
  feishuAppId: '',
  feishuDomain: '', // empty -> derived from feishuParent
  feishuParent: '', // wiki node token or doc URL (required for run/outline)
  groupByWeek: true,
  weekNames: {},
  // Optional overrides for week/module folder titles, keyed by group key
  // ("week-1", "module-module1") or by the source title.
  groupNames: {},
  // Course Outline export (one Feishu doc listing the video entries)
  outlineSource: 'auto', // auto (home page, verified against the lesson tree) | homepage | learn
  outlineTypes: ['video'], // entry types to keep; "all" keeps everything
  outlineIncludeSubtopics: true,
  outlineTitle: '', // empty -> "<Course> · Course Outline 课程大纲"
  outlineLinks: false, // false = entries are plain text (no hyperlink runs in the doc)
  // LLM (translation + section headings + ASR sentence grouping).
  // llmApiKey/llmBaseUrl/llmModel describe the credential the operator picked on
  // purpose; when it is absent (or fails) the engine walks every other credential
  // the machine has — see llmCandidates() in llm.js.
  llmBaseUrl: 'https://api.deepseek.com',
  llmModel: 'deepseek-chat',
  llmApiKey: '',
  llmKeySource: '', // where llmApiKey came from (env | config file | credentials.yaml) — for diagnostics
  // Extra providers to try after the configured one, e.g.
  // [{ name: 'my-relay', baseUrl: 'https://relay.example.com/v1', model: 'deepseek-chat', apiKeyEnv: 'MY_RELAY_KEY' }]
  llmProviders: [],
  llmTemperature: 0.3,
  translateChunkSize: 60,
  llmConcurrency: 3,
  // Behaviour
  cacheDir: '', // empty -> <pluginDir>/cache
  lessons: '', // e.g. "1-10,12" to process a subset; empty = all
  force: false,
  // Network / proxy. No proxy address is hardcoded: proxyUrl '' means "discover
  // it" (HTTPS_PROXY/HTTP_PROXY/ALL_PROXY -> Windows system proxy -> probe of the
  // well-known local ports of v2rayN/Clash/sing-box/...).
  proxyUrl: '', // e.g. "http://127.0.0.1:10809" or "socks5://127.0.0.1:10808"
  proxyMode: 'auto', // auto (direct first, proxy on failure) | always | off
  proxyBypass: '', // comma-separated hosts that always go direct (else NO_PROXY)
  proxyProbePorts: '', // '' = built-in well-known local proxy ports
  // YouTube caption fallback through a locally installed yt-dlp ('' = auto-detect)
  ytDlpPath: '',
  youtubeYtDlp: true,
  // Rewrite the body of docs that already exist (same URL) using cached content
  updateDoc: false,
  dryRun: false,
  skipTranslate: false,
  skipSections: false,
  skipFeishu: false,
  // Merge caption fragments into complete sentences (speech-aware) before translating
  segmentSentences: true,
  // Coursera (only needed for the coursera adapter)
  courseraCookie: '',
  // Lesson Chinese name overrides (slug -> 中文名)
  zhTitles: {},
};

function deepMerge(base, over) {
  if (!over || typeof over !== 'object') return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined || v === null) continue;
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Parse a "1-10,12,15-18" lesson range into a Set of 1-based seq numbers. */
export function parseLessonRange(spec) {
  const set = new Set();
  if (!spec) return set;
  for (const part of String(spec).split(',')) {
    const p = part.trim();
    if (!p) continue;
    const m = p.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) throw new Error(`invalid lesson range part: ${p}`);
    const a = parseInt(m[1], 10);
    const b = m[2] ? parseInt(m[2], 10) : a;
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) set.add(i);
  }
  return set;
}

/**
 * Resolve config from, in order: built-in defaults, config file (JSON), env vars.
 * Returns { config, configPath }.
 */
export function loadConfig(configPath) {
  let cfg = { ...DEFAULT_CONFIG };

  const fileCandidates = [];
  if (configPath) fileCandidates.push(configPath);
  fileCandidates.push(path.join(process.cwd(), 'course-subtitles.config.json'));
  fileCandidates.push(path.join(process.cwd(), 'config.json'));

  let loadedPath = null;
  let fileCfg = null;
  for (const f of fileCandidates) {
    if (f && fs.existsSync(f)) {
      fileCfg = JSON.parse(fs.readFileSync(f, 'utf8'));
      cfg = deepMerge(cfg, fileCfg);
      loadedPath = f;
      break;
    }
  }

  // env overrides
  const envMap = {
    FEISHU_APP_ID: 'feishuAppId',
    FEISHU_APP_SECRET: 'feishuAppSecret',
    COURSE_SUBTITLES_PARENT: 'feishuParent',
    LLM_API_KEY: 'llmApiKey',
    DEEPSEEK_API_KEY: 'llmApiKey',
    LLM_BASE_URL: 'llmBaseUrl',
    LLM_MODEL: 'llmModel',
    COURSE_URL: 'courseUrl',
    COURSERA_COOKIE: 'courseraCookie',
  };
  for (const [env, key] of Object.entries(envMap)) {
    if (process.env[env]) cfg[key] = process.env[env];
  }

  // If still no LLM key, fall back to the harness credential store (this machine):
  // the CURRENT DSH key, so a stale stored key never wins over the live one. Any
  // further credentials the store holds are added by the fallback chain in llm.js.
  if (process.env.LLM_API_KEY || process.env.DEEPSEEK_API_KEY) {
    cfg.llmKeySource = 'env';
  } else if (fileCfg && fileCfg.llmApiKey) {
    cfg.llmKeySource = 'config file';
  }
  if (!cfg.llmApiKey) {
    const store = credentialsFromStore();
    const key = store.DEEPSEEK_API_KEY || store.LLM_API_KEY;
    if (key) {
      cfg.llmApiKey = key;
      cfg.llmKeySource = 'credentials.yaml';
    }
  }
  // Feishu app credentials: env/config first, then the harness credential store.
  if (!cfg.feishuAppSecret || !cfg.feishuAppId) {
    const store = credentialsFromStore();
    if (!cfg.feishuAppId && store.FEISHU_APP_ID) cfg.feishuAppId = store.FEISHU_APP_ID;
    if (!cfg.feishuAppSecret && store.FEISHU_APP_SECRET) cfg.feishuAppSecret = store.FEISHU_APP_SECRET;
  }
  if (loadedPath) {
    const secFile = path.join(path.dirname(loadedPath), '.course-subtitles.secrets.json');
    if (fs.existsSync(secFile)) {
      try {
        const sec = JSON.parse(fs.readFileSync(secFile, 'utf8'));
        if (!cfg.feishuAppSecret && sec.feishuAppSecret) cfg.feishuAppSecret = sec.feishuAppSecret;
        if (!cfg.llmApiKey && sec.llmApiKey) cfg.llmApiKey = sec.llmApiKey;
      } catch { /* ignore malformed secrets file */ }
    }
  }

  if (!cfg.feishuDomain) cfg.feishuDomain = feishuDomainOf(cfg);
  return { config: cfg, configPath: loadedPath };
}

/** Feishu tenant host used to build human-facing wiki links. */
export function feishuDomainOf(cfg = {}) {
  const explicit = String(cfg.feishuDomain || '').trim();
  if (explicit) return explicit;
  const fromParent = String(cfg.feishuParent || '').match(/^https?:\/\/([^/]+)/i);
  if (fromParent) return fromParent[1];
  return 'feishu.cn';
}

/** Extract a wiki node token (or docx token) from a Feishu wiki/doc URL or raw token. */
export function feishuTokenFrom(input) {
  if (!input) return '';
  const m = String(input).match(/\/wiki\/([A-Za-z0-9]{20,})|\/docx\/([A-Za-z0-9]{20,})/);
  if (m) return m[1] || m[2];
  return String(input).trim();
}
