// Proxy resolution + tunnelling for the engine's HTTPS traffic.
//
// No proxy address is hardcoded: every run resolves it from, in order
//   1. config.proxyUrl        (settings.yaml `course-subtitles.proxyUrl`, --proxy, config file)
//   2. HTTPS_PROXY / HTTP_PROXY / ALL_PROXY  (+ NO_PROXY / proxyBypass)
//   3. the Windows system proxy (WinINET) — what v2rayN / Clash / sing-box set
//      when their "system proxy" switch is on
//   4. a liveness probe of the well-known local proxy ports (v2rayN 10809/10808,
//      Clash 7890/7891/7897, …); a candidate is only used after it really answers
//      a CONNECT (http) or a SOCKS5 handshake for the target host.
//
// proxyMode controls *when* a resolved proxy is used:
//   auto   (default) — direct first; only a failed direct connection is retried
//                      through the proxy, so working paths are untouched;
//   always           — tunnel through the proxy (ordinary HTTP_PROXY semantics);
//   off              — never proxy.
//
// Everything is memoized per process (per target host); call resetProxyCache()
// to force a re-probe (used by the proxy status report).
import net from 'node:net';
import tls from 'node:tls';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

/** Well-known local proxy ports, probed in this order when nothing is configured. */
export const WELL_KNOWN_PORTS = [10809, 7890, 7897, 10808, 7891, 1080, 8888, 20171, 2080, 7078, 8080];

const CACHE_TTL_MS = 5 * 60 * 1000;

let cfg = {};
const resolvedCache = new Map(); // "host:port" -> {proxy, at}
let systemProxyCache;
let ytDlpCache;

export function configureProxy(next = {}) {
  cfg = next || {};
  systemProxyCache = undefined;
  resolvedCache.clear();
}

/** The config the proxy layer is currently using (pipeline sets it per run). */
export function proxyConfig() {
  return cfg;
}

export function resetProxyCache() {
  resolvedCache.clear();
  systemProxyCache = undefined;
}

export function proxyMode(source = cfg) {
  const m = String(source.proxyMode || 'auto').toLowerCase();
  return m === 'always' || m === 'off' ? m : 'auto';
}

// ---------------------------------------------------------------- parsing ---

/**
 * Parse a proxy URL/token into {url, kind, host, port, auth}.
 * Accepts "127.0.0.1:10809", "http://user:pass@host:8080", "socks5://host:1080".
 */
export function parseProxyUrl(raw, source = 'config') {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`;
  let u;
  try {
    u = new URL(withScheme);
  } catch {
    return null;
  }
  const protocol = u.protocol.replace(':', '').toLowerCase();
  const kind = protocol.startsWith('socks') ? 'socks5' : protocol === 'http' || protocol === 'https' ? 'http' : null;
  if (!kind || !u.hostname) return null;
  const port = Number(u.port) || (protocol === 'https' ? 443 : kind === 'socks5' ? 1080 : 80);
  const auth = u.username ? { user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password || '') } : null;
  return { url: `${kind === 'socks5' ? 'socks5' : 'http'}://${u.hostname}:${port}`, kind, host: u.hostname, port, auth, source };
}

/** "http=a:1;https=b:2" / "a:1" / "socks=c:3" -> the value worth using. */
export function parseSystemProxyValue(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  if (!s.includes('=')) return s;
  const map = {};
  for (const part of s.split(';')) {
    const [k, v] = part.split('=');
    if (k && v) map[k.trim().toLowerCase()] = v.trim();
  }
  return map.https || map.http || map.socks || null;
}

function readWindowsSystemProxy() {
  if (process.platform !== 'win32') return { server: null, enabled: false, pac: null };
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
    const value = (name) => {
      const m = out.match(new RegExp(`${name}\\s+REG_\\w+\\s+(.*)`, 'i'));
      return m ? m[1].trim() : null;
    };
    return {
      server: parseSystemProxyValue(value('ProxyServer')),
      enabled: value('ProxyEnable') === '0x1' || value('ProxyEnable') === '1',
      pac: value('AutoConfigURL'),
    };
  } catch {
    return { server: null, enabled: false, pac: null, error: 'registry read failed' };
  }
}

/** Windows system proxy (WinINET) state — memoized, cheap. */
export function systemProxy() {
  if (systemProxyCache === undefined) systemProxyCache = readWindowsSystemProxy();
  return systemProxyCache;
}

function envProxyValue() {
  const e = process.env;
  return e.HTTPS_PROXY || e.https_proxy || e.HTTP_PROXY || e.http_proxy || e.ALL_PROXY || e.all_proxy || '';
}

/** Hosts that must never be proxied (config.proxyBypass, else NO_PROXY). */
export function bypassList(source = cfg) {
  const raw = source.proxyBypass || process.env.NO_PROXY || process.env.no_proxy || '';
  return String(raw)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isBypassed(host, source = cfg) {
  const h = String(host || '').toLowerCase();
  for (const rule of bypassList(source)) {
    if (rule === '*') return true;
    const bare = rule.includes(':') && !rule.startsWith('[') ? rule.split(':')[0] : rule;
    if (h === bare.replace(/^\./, '')) return true;
    if (bare.startsWith('.') && h.endsWith(bare)) return true;
    if (h.endsWith('.' + bare.replace(/^\./, ''))) return true;
  }
  return false;
}

/**
 * Ordered proxy candidates: explicit config, environment, the Windows system
 * proxy, then the well-known local ports (http first, socks5 as the backup for
 * socks-only setups such as a v2rayN inbound).
 */
export function proxyCandidates(source = cfg) {
  const out = [];
  const seen = new Set();
  const push = (raw, src) => {
    const p = parseProxyUrl(raw, src);
    if (p && !seen.has(p.url)) {
      seen.add(p.url);
      out.push(p);
    }
  };
  push(source.proxyUrl, 'config');
  push(envProxyValue(), 'env');
  if (process.platform === 'win32') {
    const sys = systemProxy();
    if (sys?.server && sys.enabled !== false) push(sys.server, 'system (WinINET)');
    else if (sys?.server) push(sys.server, 'system (WinINET, off)');
  }
  const ports = String(source.proxyProbePorts || '')
    .split(',')
    .map((p) => Number(p.trim()))
    .filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
  for (const port of ports.length ? ports : WELL_KNOWN_PORTS) {
    push(`http://127.0.0.1:${port}`, 'probe');
    push(`socks5://127.0.0.1:${port}`, 'probe');
  }
  return out;
}

// ------------------------------------------------------------- handshakes ---

/** Buffer a socket until `isDone` is satisfied (or the timeout fires). */
function collect(socket, isDone, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('end', onEnd);
      socket.off('close', onEnd);
    };
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (isDone(buf)) {
        cleanup();
        resolve(buf);
      }
    };
    const onError = (e) => {
      cleanup();
      reject(e);
    };
    const onEnd = () => {
      cleanup();
      reject(new Error(`${label}: connection closed by the proxy`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${label}: proxy handshake timeout`));
    }, timeoutMs);
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('end', onEnd);
    socket.on('close', onEnd);
  });
}

/** HTTP proxy tunnel request (CONNECT). */
export function httpConnectRequest(host, port, auth) {
  const basic = auth ? `Proxy-Authorization: Basic ${Buffer.from(`${auth.user}:${auth.pass}`).toString('base64')}\r\n` : '';
  return `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${basic}\r\n`;
}

export async function httpConnectHandshake(socket, host, port, auth, timeoutMs = 8000) {
  const pending = collect(socket, (b) => b.includes('\r\n\r\n'), timeoutMs, 'CONNECT');
  socket.write(httpConnectRequest(host, port, auth));
  const buf = await pending;
  const status = Number((buf.toString('latin1').match(/^HTTP\/1\.[01] (\d{3})/) || [])[1]);
  if (status !== 200) throw new Error(`proxy CONNECT ${host}:${port} -> ${status || 'no response'}`);
  return socket;
}

/** SOCKS5 CONNECT request bytes (IPv4 or domain name). */
export function socks5ConnectRequest(host, port) {
  const portBuf = Buffer.from([(port >> 8) & 0xff, port & 0xff]);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return Buffer.concat([Buffer.from([5, 1, 0, 1]), Buffer.from(host.split('.').map(Number)), portBuf]);
  }
  const name = Buffer.from(host, 'utf8');
  return Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, portBuf]);
}

const SOCKS5_ERRORS = {
  1: 'general failure',
  2: 'connection not allowed',
  3: 'network unreachable',
  4: 'host unreachable',
  5: 'connection refused',
  6: 'TTL expired',
  7: 'command not supported',
  8: 'address type not supported',
};

export async function socks5Handshake(socket, host, port, auth, timeoutMs = 8000) {
  socket.write(Buffer.from(auth ? [5, 2, 0, 2] : [5, 1, 0]));
  let buf = await collect(socket, (b) => b.length >= 2, timeoutMs, 'SOCKS5 greeting');
  if (buf[0] !== 5) throw new Error('not a SOCKS5 proxy');
  if (buf[1] === 0x02) {
    if (!auth) throw new Error('SOCKS5 proxy requires authentication');
    const user = Buffer.from(auth.user, 'utf8');
    const pass = Buffer.from(auth.pass, 'utf8');
    const pending = collect(socket, (b) => b.length >= 2, timeoutMs, 'SOCKS5 auth');
    socket.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]));
    buf = await pending;
    if (buf[1] !== 0) throw new Error('SOCKS5 authentication failed');
  } else if (buf[1] !== 0x00) {
    throw new Error(`SOCKS5 proxy rejected the offered auth methods (0x${Number(buf[1]).toString(16)})`);
  }
  const pending = collect(socket, (b) => b.length >= 4, timeoutMs, 'SOCKS5 CONNECT');
  socket.write(socks5ConnectRequest(host, port));
  buf = await pending;
  if (buf[1] !== 0) throw new Error(`SOCKS5 CONNECT ${host}:${port} -> ${SOCKS5_ERRORS[buf[1]] || buf[1]}`);
  return socket;
}

// --------------------------------------------------------------- resolution --

function tcpAlive(cand, timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: cand.host, port: cand.port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('error', () => done(false));
    socket.once('connect', () => done(true));
  });
}

/**
 * Probe every candidate against a real target: a TCP check first (fast, so a
 * machine without any local proxy costs ~0.4s), then a real handshake for the
 * ports that are actually open.
 */
export async function probeCandidates(source = cfg, target = { host: 'www.youtube.com', port: 443 }, { timeoutMs = 8000 } = {}) {
  const candidates = proxyCandidates(source);
  const alive = await Promise.all(candidates.map((c) => tcpAlive(c)));
  return Promise.all(
    candidates.map(async (cand, i) => {
      if (!alive[i]) return { ...cand, alive: false, usable: false, error: 'port closed' };
      const socket = net.connect({ host: cand.host, port: cand.port });
      try {
        await new Promise((resolve, reject) => {
          socket.setTimeout(2000, () => reject(new Error('connect timeout')));
          socket.once('connect', resolve);
          socket.once('error', reject);
        });
        if (cand.kind === 'socks5') await socks5Handshake(socket, target.host, target.port, cand.auth, timeoutMs);
        else await httpConnectHandshake(socket, target.host, target.port, cand.auth, timeoutMs);
        return { ...cand, alive: true, usable: true, error: null };
      } catch (e) {
        return { ...cand, alive: true, usable: false, error: e.message };
      } finally {
        socket.destroy();
      }
    })
  );
}

/**
 * The proxy to use for host:port — null when everything must go direct.
 * Memoized for CACHE_TTL_MS; the port probe is only paid once per host.
 */
export async function resolveProxy(source = cfg, host = 'www.youtube.com', port = 443) {
  if (proxyMode(source) === 'off') return null;
  if (isBypassed(host, source)) return null;
  const key = `${host}:${port}`;
  const hit = resolvedCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.proxy;
  const results = await probeCandidates(source, { host, port });
  const proxy = results.find((r) => r.usable) || null;
  resolvedCache.set(key, { proxy, at: Date.now() });
  return proxy;
}

/**
 * An https.Agent that tunnels through the resolved proxy, or null for a direct
 * connection. Used by http.js so every engine request (adapters, Feishu, LLM)
 * can opt into the same resolution.
 */
export async function agentFor(host, port = 443, source = cfg) {
  const proxy = await resolveProxy(source, host, port);
  if (!proxy) return null;
  const agent = new https.Agent({ keepAlive: false, maxSockets: 4 });
  agent.createConnection = (options, callback) => {
    let settled = false;
    const finish = (err, socket) => {
      if (settled) return;
      settled = true;
      if (callback) callback(err, socket);
    };
    const socket = net.connect({ host: proxy.host, port: proxy.port });
    socket.setTimeout(15000, () => {
      socket.destroy();
      finish(new Error(`proxy ${proxy.url} timed out`));
    });
    socket.once('error', (e) => finish(e));
    socket.once('connect', async () => {
      try {
        if (proxy.kind === 'socks5') await socks5Handshake(socket, host, port, proxy.auth);
        else await httpConnectHandshake(socket, host, port, proxy.auth);
        socket.setTimeout(0);
        const tlsSocket = tls.connect({ socket, servername: net.isIP(host) ? undefined : host, host, port });
        tlsSocket.once('secureConnect', () => finish(null, tlsSocket));
        tlsSocket.once('error', (e) => finish(e));
      } catch (e) {
        socket.destroy();
        finish(e);
      }
    });
    return undefined;
  };
  return agent;
}

/** Human/JSON readable proxy state — used by the status route and the CLI. */
export async function proxyState(source = cfg, target = { host: 'www.youtube.com', port: 443 }) {
  resetProxyCache();
  const candidates = await probeCandidates(source, target);
  const selected = candidates.find((c) => c.usable) || null;
  const sys = process.platform === 'win32' ? systemProxy() : null;
  return {
    mode: proxyMode(source),
    configured: source.proxyUrl || '',
    target: `${target.host}:${target.port}`,
    env: {
      HTTPS_PROXY: process.env.HTTPS_PROXY || process.env.https_proxy || '',
      HTTP_PROXY: process.env.HTTP_PROXY || process.env.http_proxy || '',
      ALL_PROXY: process.env.ALL_PROXY || process.env.all_proxy || '',
      NO_PROXY: process.env.NO_PROXY || process.env.no_proxy || '',
    },
    windowsSystemProxy: sys,
    bypass: bypassList(source),
    selected: selected ? { url: selected.url, kind: selected.kind, source: selected.source } : null,
    candidates: candidates.map(({ url, kind, source: src, alive, usable, error }) => ({ url, kind, source: src, alive, usable, error })),
    ytDlp: await detectYtDlp(source),
    ytDlpError: ytDlpDiagnostic || '',
  };
}

/** Compact one-line form for run events / reports. */
export async function proxySummary(source = cfg, target = { host: 'www.youtube.com', port: 443 }) {
  const state = await proxyState(source, target);
  return {
    mode: state.mode,
    selected: state.selected,
    systemProxy: state.windowsSystemProxy?.server || null,
    candidatesUsable: state.candidates.filter((c) => c.usable).map((c) => `${c.url} (${c.source})`),
    ytDlp: state.ytDlp ? `${state.ytDlp.command} ${state.ytDlp.version || ''}`.trim() : null,
  };
}

// ----------------------------------------------------------------- yt-dlp ---

/** Standard yt-dlp install locations (PATH is not always inherited by a host process). */
function ytDlpInstallPaths() {
  const out = [];
  const home = os.homedir();
  const add = (p) => {
    if (p && fs.existsSync(p)) out.push(p);
  };
  add(process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'yt-dlp.exe'));
  add(path.join(home, 'scoop', 'shims', 'yt-dlp.exe'));
  add('C:\\ProgramData\\chocolatey\\bin\\yt-dlp.exe');
  for (const root of [process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Python'), process.env.APPDATA && path.join(process.env.APPDATA, 'Python')]) {
    if (!root) continue;
    let dirs = [];
    try {
      dirs = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const dir of dirs) {
      add(path.join(root, dir, 'Scripts', 'yt-dlp.exe'));
      add(path.join(root, dir, 'Scripts', 'yt-dlp'));
    }
  }
  return out;
}

let ytDlpDiagnostic = '';

/** Locate a usable yt-dlp: config.ytDlpPath, PATH, standard install dirs, `python -m yt_dlp`. */
export async function detectYtDlp(source = cfg) {
  if (ytDlpCache !== undefined) return ytDlpCache;
  const explicit = String(source.ytDlpPath || '').trim();
  const candidates = [];
  const seen = new Set();
  const push = (command, args = []) => {
    const key = `${command} ${args.join(' ')}`;
    if (command && !seen.has(key)) {
      seen.add(key);
      candidates.push({ command, args });
    }
  };
  if (explicit) push(explicit);
  push('yt-dlp.exe');
  push('yt-dlp');
  for (const p of ytDlpInstallPaths()) push(p);
  if (process.platform === 'win32') push('py', ['-m', 'yt_dlp']);
  push('python', ['-m', 'yt_dlp']);
  push('python3', ['-m', 'yt_dlp']);

  const failures = [];
  for (const cand of candidates) {
    const r = await run(cand.command, [...cand.args, '--version'], { timeoutMs: 20000 });
    const version = r.code === 0 ? r.stdout.trim().split(/\r?\n/)[0] : null;
    if (version) {
      ytDlpDiagnostic = '';
      ytDlpCache = { ...cand, version, path: cand.command };
      return ytDlpCache;
    }
    failures.push(`${cand.command}: ${String(r.stderr || '').trim().split(/\r?\n/).filter(Boolean).pop() || `exit ${r.code}`}`);
  }
  ytDlpDiagnostic = failures.join(' ; ');
  ytDlpCache = null;
  return null;
}

/** Why yt-dlp was not usable (empty when it is). */
export function ytDlpError() {
  return ytDlpDiagnostic;
}

/** Spawn a command, collect stdout/stderr, never throw on a non-zero exit. */
export function run(command, args, { timeoutMs = 120000, cwd } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: e.message });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ code: -1, stdout, stderr: `${stderr}\n${command}: timeout after ${timeoutMs}ms`.trim() });
    }, timeoutMs);
    child.stdout?.on('data', (c) => {
      stdout += c.toString('utf8');
    });
    child.stderr?.on('data', (c) => {
      stderr += c.toString('utf8');
    });
    child.once('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}\n${e.message}`.trim() });
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

function tmpBase() {
  return path.join(os.tmpdir(), 'course-subtitles');
}

/** Build the yt-dlp argument list for downloading caption tracks (exported for tests). */
export function ytDlpArgs({ videoId, proxy = null, outDir, langs = 'en.*' }) {
  const args = [
    '--no-playlist',
    '--skip-download',
    '--write-auto-subs',
    '--write-subs',
    '--sub-langs',
    langs,
    '--sub-format',
    'json3',
    '--no-warnings',
    '--no-progress',
    // --print implies --simulate, which would skip writing the subtitle file
    '--no-simulate',
    '--socket-timeout',
    '30',
    '--retries',
    '3',
    '--print',
    '%(title)s\t%(duration)s',
    '-o',
    path.join(outDir, '%(id)s.%(ext)s'),
  ];
  if (proxy) args.push('--proxy', proxy);
  args.push(`https://www.youtube.com/watch?v=${videoId}`);
  return args;
}

export { tmpBase };
