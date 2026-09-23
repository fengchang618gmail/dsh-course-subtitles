// Minimal zero-dependency HTTPS helpers (Node built-ins only).
// Note: on this machine Windows schannel (curl/PowerShell) is broken; Node's
// OpenSSL stack works, so everything uses https.request.
//
// Every request goes through proxy.js: in the default "auto" mode it is sent
// direct first and only retried through the resolved local proxy when the direct
// connection fails (TLS reset / timeout / DNS) — so hosts that are reachable
// directly are never routed through a proxy, while blocked ones (YouTube here)
// transparently use whatever proxy the machine actually has.

import https from 'node:https';
import { URL } from 'node:url';
import { agentFor, proxyMode } from './proxy.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

/** Socket-level failures that justify a proxy retry (HTTP errors never do). */
export function isNetworkError(e) {
  const code = e?.code || e?.cause?.code || '';
  const network = [
    'ECONNRESET',
    'ECONNREFUSED',
    'ECONNABORTED',
    'ETIMEDOUT',
    'EPROTO',
    'EPIPE',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ENETDOWN',
    'EAI_AGAIN',
    'ENOTFOUND',
    'EADDRNOTAVAIL',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_SOCKET',
  ];
  if (network.includes(code)) return true;
  const msg = String(e?.message || '');
  return /timeout after|socket hang up|fetch failed|Client network socket disconnected|tunneling socket/i.test(msg);
}

function rawRequest(method, url, { headers = {}, body, timeoutMs = 30000, agent } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    // Send an explicit Content-Length: with only req.write() Node uses chunked
    // transfer-encoding, which some gateways (Feishu's, notably on DELETE)
    // reject as a malformed request — and the half-read body then corrupts the
    // keep-alive connection, making the following requests fail with an HTML 400.
    const payload = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = https.request(
      {
        method,
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        agent,
        headers: {
          'User-Agent': UA,
          ...(payload !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      }
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs}ms: ${method} ${url}`)));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

export function request(method, url, opts = {}) {
  return (async () => {
    const mode = proxyMode();
    const u = new URL(url);
    const port = Number(u.port) || 443;

    if (mode === 'always') {
      const agent = await agentFor(u.hostname, port);
      if (agent) {
        try {
          return await rawRequest(method, url, { ...opts, agent });
        } catch (e) {
          if (!isNetworkError(e)) throw e;
          // the proxy itself is unusable -> direct is the last resort
        }
      }
      return rawRequest(method, url, opts);
    }

    try {
      return await rawRequest(method, url, opts);
    } catch (e) {
      if (mode !== 'auto' || !isNetworkError(e)) throw e;
      const agent = await agentFor(u.hostname, port);
      if (!agent) throw e;
      return rawRequest(method, url, { ...opts, agent });
    }
  })();
}

export async function getText(url, opts = {}) {
  const r = await request('GET', url, opts);
  if (r.status < 200 || r.status >= 300) throw new Error(`GET ${url} -> ${r.status}`);
  return r.body;
}

export async function getJson(url, opts = {}) {
  return JSON.parse(await getText(url, opts));
}

export async function postJson(url, body, opts = {}) {
  const r = await request('POST', url, { ...opts, body });
  if (r.status < 200 || r.status >= 300) throw new Error(`POST ${url} -> ${r.status}: ${r.body.slice(0, 200)}`);
  return JSON.parse(r.body);
}

/** GET with redirect following (up to N hops). */
export async function getTextFollowRedirects(url, opts = {}, hops = 5) {
  let cur = url;
  for (let i = 0; i < hops; i++) {
    const r = await request('GET', cur, opts);
    if (r.status >= 300 && r.status < 400 && r.headers.location) {
      cur = new URL(r.headers.location, cur).href;
      continue;
    }
    if (r.status < 200 || r.status >= 300) throw new Error(`GET ${cur} -> ${r.status}`);
    return r.body;
  }
  throw new Error(`too many redirects for ${url}`);
}

/** POST with exponential-backoff retry on transient failures. */
export async function postJsonRetry(url, body, { headers = {}, retries = 5, baseWaitMs = 1500, timeoutMs = 120000, onRetry } = {}) {
  let wait = baseWaitMs;
  for (let attempt = 0; ; attempt++) {
    const r = await request('POST', url, { headers, body, timeoutMs });
    if (r.status >= 200 && r.status < 300) return JSON.parse(r.body);
    if (attempt >= retries) throw new Error(`POST ${url} -> ${r.status}: ${r.body.slice(0, 300)}`);
    const w = r.status === 429 ? Math.max(wait, 3000) : wait;
    if (onRetry) onRetry(attempt + 1, r.status, w);
    await new Promise((res) => setTimeout(res, w));
    wait *= 2;
  }
}
