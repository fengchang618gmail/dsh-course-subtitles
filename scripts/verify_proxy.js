// Proxy layer self-test.
//
//   node scripts/verify_proxy.js            offline assertions (parsing, bypass,
//                                           candidate order, handshake bytes, yt-dlp args)
//   node scripts/verify_proxy.js --live     additionally probe the local proxy and
//                                           print the real state of this machine
//
// No proxy address is asserted to exist: the live part only *reports* what the
// resolution finds (v2rayN / Clash / sing-box / ... or nothing).
import {
  WELL_KNOWN_PORTS,
  bypassList,
  httpConnectRequest,
  isBypassed,
  parseProxyUrl,
  parseSystemProxyValue,
  proxyCandidates,
  proxyState,
  socks5ConnectRequest,
  systemProxy,
  ytDlpArgs,
} from '../src/engine/proxy.js';
import { isNetworkError } from '../src/engine/http.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}`);
}

console.log('proxy URL parsing');
const p1 = parseProxyUrl('127.0.0.1:10809');
eq('bare host:port -> http', [p1.kind, p1.host, p1.port, p1.url], ['http', '127.0.0.1', 10809, 'http://127.0.0.1:10809']);
const p2 = parseProxyUrl('http://user:p%40ss@10.0.0.1:8080');
eq('auth is decoded', [p2.auth.user, p2.auth.pass, p2.port], ['user', 'p@ss', 8080]);
eq('socks5 scheme', parseProxyUrl('socks5://127.0.0.1:10808').kind, 'socks5');
eq('socks5h scheme', [parseProxyUrl('socks5h://127.0.0.1:1080').kind, parseProxyUrl('socks5h://127.0.0.1:1080').port], ['socks5', 1080]);
eq('empty -> null', parseProxyUrl(''), null);
eq('garbage -> null', parseProxyUrl('::://'), null);

console.log('windows system proxy value');
eq('plain server', parseSystemProxyValue('127.0.0.1:10809'), '127.0.0.1:10809');
eq('per-scheme list prefers https', parseSystemProxyValue('http=127.0.0.1:7890;https=127.0.0.1:7891'), '127.0.0.1:7891');
eq('empty -> null', parseSystemProxyValue(''), null);

console.log('bypass rules');
const bypassCfg = { proxyBypass: 'localhost, .feishu.cn, 127.0.0.1' };
check('localhost bypassed', isBypassed('localhost', bypassCfg));
check('suffix match', isBypassed('open.feishu.cn', bypassCfg));
check('apex match', isBypassed('feishu.cn', bypassCfg));
check('youtube not bypassed', !isBypassed('www.youtube.com', bypassCfg));
check('wildcard bypasses everything', isBypassed('www.youtube.com', { proxyBypass: '*' }));
eq('bypass list parsed', bypassList(bypassCfg), ['localhost', '.feishu.cn', '127.0.0.1']);

console.log('candidate order');
const saved = { ...process.env };
process.env.HTTPS_PROXY = 'http://127.0.0.1:7890';
const cands = proxyCandidates({ proxyUrl: 'socks5://127.0.0.1:10808' });
eq('config first', [cands[0].url, cands[0].source], ['socks5://127.0.0.1:10808', 'config']);
eq('env second', [cands[1].url, cands[1].source], ['http://127.0.0.1:7890', 'env']);
check('no duplicate candidates', new Set(cands.map((c) => c.url)).size === cands.length);
check('well-known ports are probed', cands.some((c) => c.source === 'probe' && c.port === WELL_KNOWN_PORTS[0]));
process.env = saved;
// The assertion must look at PROBE-sourced candidates only: this machine may
// legitimately serve one of the well-known ports as its real env/system proxy,
// and that must not read as "the built-in probe list leaked through".
for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'all_proxy']) delete process.env[k];
const explicitOnly = proxyCandidates({ proxyUrl: 'http://127.0.0.1:1234', proxyProbePorts: '4321' });
const probes = explicitOnly.filter((c) => c.source === 'probe');
check('proxyProbePorts overrides the built-in list', probes.some((c) => c.port === 4321) && !probes.some((c) => c.port === WELL_KNOWN_PORTS[0]));

console.log('handshake bytes');
const connect = httpConnectRequest('example.com', 443);
check('CONNECT line', connect.startsWith('CONNECT example.com:443 HTTP/1.1\r\n'));
check('no auth header without credentials', !connect.includes('Proxy-Authorization'));
check('basic auth header', httpConnectRequest('a:1', 80, { user: 'user', pass: 'pass' }).includes('Proxy-Authorization: Basic dXNlcjpwYXNz'));
eq('socks5 domain request', [...socks5ConnectRequest('example.com', 443).subarray(0, 5)], [5, 1, 0, 3, 11]);
eq('socks5 domain request length', socks5ConnectRequest('example.com', 443).length, 5 + 11 + 2);
eq('socks5 ipv4 request', [...socks5ConnectRequest('1.2.3.4', 443)], [5, 1, 0, 1, 1, 2, 3, 4, 1, 187]);

console.log('yt-dlp arguments');
const withProxy = ytDlpArgs({ videoId: 'KXIdYEdOPys', proxy: 'http://127.0.0.1:10809', outDir: 'C:/tmp/x' });
check('proxy passed through', withProxy.includes('--proxy') && withProxy.includes('http://127.0.0.1:10809'));
check('watch URL last', withProxy[withProxy.length - 1] === 'https://www.youtube.com/watch?v=KXIdYEdOPys');
check('auto-subs requested', withProxy.includes('--write-auto-subs') && withProxy.includes('json3'));
check('no --proxy without a proxy', !ytDlpArgs({ videoId: 'x', outDir: 'C:/tmp/x' }).includes('--proxy'));

console.log('network error classification');
check('ECONNRESET is a network error', isNetworkError(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })));
check('socket hang up is a network error', isNetworkError(new Error('socket hang up')));
check('fetch failed is a network error', isNetworkError(new Error('fetch failed')));
check('an HTTP status error is not', !isNetworkError(new Error('POST https://x -> 500: oops')));

if (process.platform === 'win32') {
  console.log('windows registry read');
  const sys = systemProxy();
  check('returns a state object', sys && typeof sys === 'object' && 'server' in sys, JSON.stringify(sys));
}

if (process.argv.includes('--live')) {
  console.log('\nlive proxy state (this machine)');
  const state = await proxyState({}, { host: 'www.youtube.com', port: 443 });
  console.log(JSON.stringify(state, null, 2));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
