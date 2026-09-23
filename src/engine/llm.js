// LLM access with ZERO hardcoded credentials.
//
// The engine never ships a key, a tenant host, or an account id. Instead it
// builds an ordered candidate chain and walks it until one provider answers:
//
//   1. the explicit config  (llmApiKey + llmBaseUrl + llmModel, from CLI/config
//      file/env — the value the operator picked on purpose)
//   2. any extra providers declared in the config file under `llmProviders`
//   3. every provider from KNOWN_PROVIDERS whose API key is present in the
//      process environment or in the harness credential store
//      ($DSH_HOME/.credentials.yaml) — the keys the local DeepSeek Harness
//      already has, tried one by one.
//
// A candidate carries its own baseUrl + model + wire protocol, so switching
// credentials also switches endpoint and model (a relay key must not be sent to
// api.deepseek.com).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { postJsonRetry } from './http.js';

/** Harness home directory (holds .credentials.yaml and settings.yaml). */
export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/**
 * Read every `NAME: value` scalar out of the harness credential store. The file
 * is a small YAML document; only flat, single-line scalar refs are meaningful
 * here, so a tolerant line scan is enough (and avoids a YAML dependency).
 */
export function credentialsFromStore(file = path.join(dshHome(), '.credentials.yaml')) {
  const out = {};
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*:\s*(.+?)\s*$/);
    if (!m) continue;
    const value = m[2].replace(/^["']|["']$/g, '');
    if (!value || /^[[{>|]/.test(value)) continue; // nested block, not a scalar
    out[m[1]] = value;
  }
  return out;
}

/** Where a credential came from — env always wins over the stored file. */
export function credentialValue(name, store = null) {
  if (process.env[name]) return { value: process.env[name], source: 'env' };
  const s = store || credentialsFromStore();
  if (s[name]) return { value: s[name], source: 'credentials.yaml' };
  return null;
}

/**
 * Providers this plugin knows how to talk to, keyed by the credential that
 * authenticates them. Order = preference order for the fallback chain.
 * Nothing secret lives here — only public endpoints and model ids.
 */
export const KNOWN_PROVIDERS = [
  { label: 'deepseek', env: 'DEEPSEEK_API_KEY', baseUrl: 'https://api.deepseek.com', api: 'openai-completions', model: 'deepseek-chat', envBaseUrl: 'DEEPSEEK_BASE_URL', envModel: 'DEEPSEEK_MODEL' },
  { label: 'qimingxing', env: 'QIMINGXING_API_KEY', baseUrl: 'https://api.aisj.ai', api: 'openai-responses', model: 'deepseek-v4.1-flash' },
  { label: 'glm', env: 'GLM5_API_KEY', baseUrl: 'https://api.aisj.ai', api: 'openai-completions', model: 'glm-5.3' },
  { label: 'kimi', env: 'KIMIK3QIMINGXING_API_KEY', baseUrl: 'https://api.aisj.ai', api: 'anthropic-messages', model: 'kimi-k3' },
  { label: 'agnes-cn', env: 'AGNES_AI_CN_API_KEY', baseUrl: 'https://api.agnes-ai.cn/v1', api: 'openai-completions', model: 'agnes-3.0-flash' },
  { label: 'agnes', env: 'AGNES_AI_API_KEY', baseUrl: 'https://apihub.agnes-ai.com/v1', api: 'openai-completions', model: 'agnes-3.0-flash' },
  { label: 'tulong', env: 'TULONG_API_KEY', baseUrl: 'https://codex.artemisproperties.org/v1', api: 'openai-completions', model: 'gpt-5.6-sol' },
];

/** `llmProviders` entries may be written either as an object map or an array. */
function declaredProviders(cfg = {}) {
  const raw = cfg.llmProviders;
  if (!raw) return [];
  const list = Array.isArray(raw)
    ? raw.map((v, i) => [v?.label || v?.name || `provider-${i + 1}`, v])
    : Object.entries(raw);
  const out = [];
  for (const [label, v] of list) {
    if (!v || typeof v !== 'object') continue;
    const keyRef = v.apiKey || (v.apiKeyEnv ? process.env[v.apiKeyEnv] || credentialsFromStore()[v.apiKeyEnv] : '');
    if (!keyRef || !v.baseUrl) continue; // a provider without a key is simply skipped
    out.push({
      label,
      baseUrl: v.baseUrl,
      api: v.api || 'openai-completions',
      model: v.model || 'deepseek-chat',
      apiKey: keyRef,
      source: v.apiKey ? 'config' : `env:${v.apiKeyEnv}`,
    });
  }
  return out;
}

const sameCandidate = (a, b) => a.baseUrl === b.baseUrl && a.model === b.model && a.apiKey === b.apiKey;

/**
 * Build the ordered candidate chain for this run.
 * @returns {Array<{label:string, baseUrl:string, api:string, model:string, apiKey:string, source:string}>}
 */
export function llmCandidates(cfg = {}) {
  const store = credentialsFromStore();
  const out = [];
  const push = (c) => {
    if (!c || !c.apiKey || !c.baseUrl) return;
    if (out.some((x) => sameCandidate(x, c))) return;
    out.push(c);
  };

  // 1) the explicit configuration
  if (cfg.llmApiKey) {
    push({
      label: cfg.llmLabel || 'configured',
      baseUrl: cfg.llmBaseUrl || KNOWN_PROVIDERS[0].baseUrl,
      api: cfg.llmApi || 'openai-completions',
      model: cfg.llmModel || KNOWN_PROVIDERS[0].model,
      apiKey: cfg.llmApiKey,
      source: cfg.llmKeySource || 'config',
    });
  }

  // 2) providers declared in the config file
  for (const c of declaredProviders(cfg)) push(c);

  // 3) every known provider whose credential the machine actually has
  for (const p of KNOWN_PROVIDERS) {
    const found = credentialValue(p.env, store);
    if (!found) continue;
    push({
      label: p.label,
      baseUrl: (p.envBaseUrl && process.env[p.envBaseUrl]) || p.baseUrl,
      api: p.api,
      model: (p.envModel && process.env[p.envModel]) || (cfg.llmModelFor?.[p.label]) || p.model,
      apiKey: found.value,
      source: found.source,
    });
  }
  return out;
}

/** Short human-readable summary of the chain, with no secret material. */
export function describeCandidates(cfg = {}) {
  const list = llmCandidates(cfg);
  if (!list.length) return 'none (no LLM credential found)';
  return list.map((c) => `${c.label}[${c.model} @ ${c.baseUrl}, key from ${c.source}]`).join(' -> ');
}

/**
 * Build the request URL for a candidate. Relays that serve several protocols
 * under one host answer an HTML page (HTTP 200!) on the un-versioned path, so a
 * bare origin always resolves to the `/v1` route — and a base that already names
 * the full endpoint is left alone.
 */
function endpoint(baseUrl, api) {
  const base = String(baseUrl).replace(/\/+$/, '');
  const suffix = api === 'anthropic-messages' ? '/messages'
    : api === 'openai-responses' ? '/responses'
      : '/chat/completions';
  if (base.endsWith(suffix)) return base;
  const v1 = /\/v1$/.test(base) ? base : `${base}/v1`;
  return `${v1}${suffix}`;
}

function textFromResponse(api, j) {
  if (api === 'anthropic-messages') {
    const parts = Array.isArray(j?.content) ? j.content.filter((c) => c?.type === 'text' && c.text) : [];
    return parts.map((c) => c.text).join('');
  }
  if (api === 'openai-responses') {
    if (typeof j?.output_text === 'string' && j.output_text) return j.output_text;
    const parts = [];
    for (const item of Array.isArray(j?.output) ? j.output : []) {
      for (const c of Array.isArray(item?.content) ? item.content : []) {
        if (typeof c?.text === 'string') parts.push(c.text);
      }
    }
    return parts.join('');
  }
  return j?.choices?.[0]?.message?.content ?? '';
}

async function callProvider(c, { messages, temperature, maxTokens, json, timeoutMs, onRetry }) {
  const url = endpoint(c.baseUrl, c.api);
  const headers = c.api === 'anthropic-messages'
    ? { 'x-api-key': c.apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }
    : { Authorization: `Bearer ${c.apiKey}`, 'Content-Type': 'application/json' };

  const build = (withJsonMode) => {
    if (c.api === 'anthropic-messages') {
      const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
      return {
        model: c.model,
        max_tokens: maxTokens,
        temperature: temperature ?? 0.3,
        ...(system ? { system } : {}),
        messages: messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content })),
      };
    }
    if (c.api === 'openai-responses') {
      return {
        model: c.model,
        input: messages.map((m) => ({ role: m.role, content: m.content })),
        temperature: temperature ?? 0.3,
        max_output_tokens: maxTokens,
      };
    }
    return {
      model: c.model,
      messages,
      temperature: temperature ?? 0.3,
      max_tokens: maxTokens,
      ...(withJsonMode ? { response_format: { type: 'json_object' } } : {}),
    };
  };

  const opts = {
    headers,
    retries: 2,
    baseWaitMs: 1200,
    timeoutMs,
    // postJsonRetry reports (attempt, status, wait); callers of chatText only
    // need one human-readable line, so normalize the shape here.
    onRetry: onRetry ? (attempt, status, wait) => onRetry(`${c.label}: retry ${attempt} after HTTP ${status} (waiting ${wait}ms)`) : undefined,
  };
  let j;
  if (json && c.api === 'openai-completions') {
    try {
      j = await postJsonRetry(url, build(true), opts);
    } catch (e) {
      // Some OpenAI-compatible relays reject response_format; the prompt already
      // asks for JSON, so one retry without it is the right fallback.
      if (!/response_format|json_object|400/i.test(e.message)) throw e;
      j = await postJsonRetry(url, build(false), opts);
    }
  } else {
    j = await postJsonRetry(url, build(false), opts);
  }
  const text = textFromResponse(c.api, j);
  if (!text) throw new Error(`empty completion from ${c.label}`);
  return text;
}

/**
 * Send one chat request, walking the credential chain until a provider answers.
 * @returns {Promise<{text:string, provider:string}>}
 */
export async function chatText(cfg = {}, { messages, temperature, maxTokens = 4096, json = false, timeoutMs = 120000, onRetry } = {}) {
  const candidates = llmCandidates(cfg);
  if (!candidates.length) {
    throw new Error(
      'no LLM credential available — set LLM_API_KEY / DEEPSEEK_API_KEY, declare `llmProviders` in the config, ' +
      `or store a key in ${path.join(dshHome(), '.credentials.yaml')}`
    );
  }
  const failures = [];
  for (const c of candidates) {
    try {
      const text = await callProvider(c, { messages, temperature, maxTokens, json, timeoutMs, onRetry });
      return { text, provider: c.label };
    } catch (e) {
      const msg = String(e?.message || e).replace(/\s+/g, ' ').slice(0, 160);
      failures.push(`${c.label}: ${msg}`);
      if (candidates.length > 1) onRetry?.(`LLM ${c.label} failed (${msg}) — trying the next credential`);
    }
  }
  throw new Error(`all LLM credentials failed:\n  ${failures.join('\n  ')}`);
}

/**
 * Tolerant JSON extraction: providers that ignore JSON mode often wrap the
 * object in a ```json fence or add a sentence around it.
 */
export function parseJsonLoose(text) {
  const s = String(text ?? '').trim();
  try {
    return JSON.parse(s);
  } catch { /* fall through to repair */ }
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch { /* keep trying */ }
  }
  const first = s.search(/[[{]/);
  const last = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
  if (first >= 0 && last > first) return JSON.parse(s.slice(first, last + 1));
  throw new Error('response was not JSON: ' + s.slice(0, 200));
}

/** True when at least one credential is usable (used for early, friendly errors). */
export function hasLlmCredential(cfg = {}) {
  return llmCandidates(cfg).length > 0;
}

/**
 * Ping ONE candidate on its own (no chain walking), so a diagnostic can show
 * which credentials answer and which do not. Never returns key material.
 */
export async function probeCandidate(c, { timeoutMs = 20000 } = {}) {
  const started = Date.now();
  try {
    await callProvider(c, { messages: [{ role: 'user', content: 'ping' }], maxTokens: 16, temperature: 0, timeoutMs });
    return { ok: true, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, error: String(e?.message || e).replace(/\s+/g, ' ').slice(0, 200) };
  }
}
