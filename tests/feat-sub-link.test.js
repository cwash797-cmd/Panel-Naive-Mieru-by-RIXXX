// ─────────────────────────────────────────────────────────────────────────────
// v1.8.7 — Subscription link FUNCTIONAL test.
//
// The main index.js has heavy startup side-effects (opens /etc + /var paths,
// binds a port) that need root, so — like the rest of this repo's suite — we do
// NOT boot the server. Instead we extract the PURE builder functions
// (buildNaiveLink, buildMierusLink, buildHy2Link, buildUserUris,
// buildSingboxConfig, detectSubClient, buildSubUserinfo, subBaseUrl) from the
// source and evaluate them in an isolated vm context with a mocked `cfg`,
// `parseUserRow`, `pickMieruPort`, `crypto`, and `encodeURIComponent`. This gives
// real behavioural coverage of the format/UA/filter logic that regex cannot.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  \u2713 ' + m); } else { fail++; console.log('  \u2717 ' + m); } };

const ROOT      = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(ROOT, 'panel', 'server', 'index.js'), 'utf8');

// ── Extract the named function sources by brace-matching from `function <name>(` ──
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('function not found: ' + name);
  // Find the end of the parameter list: the ')' that closes the '(' right after
  // the name (params can themselves contain '{ }' for destructuring, so we brace
  // /paren-count from the opening paren rather than naively grabbing the 1st '{').
  let p = src.indexOf('(', start);
  let pdepth = 0, j = p;
  for (; j < src.length; j++) {
    if (src[j] === '(') pdepth++;
    else if (src[j] === ')') { pdepth--; if (pdepth === 0) { j++; break; } }
  }
  // The function BODY opens at the first '{' after the parameter list.
  let i = src.indexOf('{', j);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

const NAMES = ['buildMierusLink', 'buildHy2Link', 'buildNaiveLink',
               'buildShadowrocketHttpsLink',
               'buildUserUris', 'buildSingboxConfig', 'detectSubClient',
               'buildSubUserinfo', 'subBaseUrl',
               // v1.9.2: buildSingboxConfig now folds the user's enabled bonus
               // links into the sing-box JSON, so its dependency chain
               // (normalizeBonusLinks → enabledBonusUrls → bonusUrlToSingboxOutbound)
               // must be present in the sandbox too.
               'normalizeBonusLinks', 'enabledBonusUrls', 'bonusUrlToSingboxOutbound'];

// Mocked runtime environment.
const sandbox = {
  encodeURIComponent,
  parseInt,
  parseFloat,
  Number,
  Math,
  Buffer,
  isNaN,
  Array,
  Date,
  String,
  URL,          // v1.9.2: bonusUrlToSingboxOutbound() parses URIs via new URL()
  JSON,         // v1.9.2: bonusUrlToSingboxOutbound() decodes vmess base64 JSON
  crypto: require('crypto'),
  // parseUserRow: the real one just JSON-parses protocols.
  parseUserRow(u) {
    return { ...u, protocols: typeof u.protocols === 'string'
      ? JSON.parse(u.protocols) : (u.protocols || []) };
  },
  // pickMieruPort: mirror the real clamp-to-range behaviour.
  pickMieruPort(requested, start, end) {
    const p = parseInt(requested, 10);
    if (Number.isInteger(p) && p >= start && p <= end) return p;
    return start;
  },
  cfg: {
    domain: 'sv.example.com',
    serverIp: '87.120.196.141',
    naivePort: 443,
    mieruPortStart: 2012, mieruPortEnd: 2022,
    hy2Port: 443,
    stack: { naive: true, mieru: true, hy2: true },
    subBaseUrl: ''
  }
};
vm.createContext(sandbox);
// v1.9.2: detectSubClient() references the module-level SINGBOX_FAMILY_UA const;
// define it in the sandbox first so the extracted function can close over it.
{
  const m = serverSrc.match(/const SINGBOX_FAMILY_UA\s*=\s*\[[^\]]*\];/);
  if (m) vm.runInContext(m[0], sandbox);
}
for (const n of NAMES) vm.runInContext(extractFn(serverSrc, n), sandbox);

const mkUser = (protocols, extra = {}) => ({
  username: 'ivan', password: 'siyIjCBwaUr08dxS',
  protocols: JSON.stringify(protocols),
  usedMB: 0, quotaMB: 0, expiry: null, ...extra
});

console.log('[sub-link] URI builders');
{
  const naive = vm.runInContext("buildNaiveLink({username:'ivan',password:'p@ss word',domain:'d.com',port:443})", sandbox);
  ok(naive === 'naive+https://ivan:p%40ss%20word@d.com:443', 'buildNaiveLink percent-encodes password (Karing JSON path)');

  const hy2 = vm.runInContext("buildHy2Link({username:'ivan',password:'pw',domain:'d.com',port:443})", sandbox);
  ok(hy2 === 'hysteria2://ivan:pw@d.com:443?sni=d.com&insecure=0#ivan', 'buildHy2Link canonical form');

  // v1.8.8: Shadowrocket-native Naive URI (its HTTPS proxy scheme).
  const srLink = vm.runInContext(
    "buildShadowrocketHttpsLink({username:'ivan',password:'siyIjCBwaUr08dxS',domain:'d.com',port:443,name:'ivan'})",
    sandbox);
  ok(srLink.startsWith('https://'), 'buildShadowrocketHttpsLink uses the https:// scheme');
  ok(/\?remarks=ivan$/.test(srLink), 'buildShadowrocketHttpsLink appends ?remarks=<name>');
  ok(!/naive\+https/.test(srLink),   'buildShadowrocketHttpsLink is NOT naive+https:// (Shadowrocket ignores that)');
  // Round-trip: strip scheme+query, url-safe-b64-decode → user:pass@host:port.
  {
    const body = srLink.slice('https://'.length).split('?')[0]
      .replace(/-/g, '+').replace(/_/g, '/');
    const dec = Buffer.from(body, 'base64').toString('utf8');
    ok(dec === 'ivan:siyIjCBwaUr08dxS@d.com:443',
       'buildShadowrocketHttpsLink base64 decodes to user:pass@host:port');
  }
}

console.log('\n[sub-link] buildUserUris respects the protocol checkboxes');
{
  sandbox.__u3 = mkUser(['naive', 'mieru', 'hy2']);
  const three = vm.runInContext('buildUserUris(__u3, {})', sandbox);
  ok(three.length === 3, '3 checkboxes → 3 URIs');
  // v1.8.8: naive URI is now the Shadowrocket-native HTTPS scheme, NOT
  // naive+https:// (which Shadowrocket silently drops from a subscription).
  ok(three.some(u => u.startsWith('https://') && !u.startsWith('https://t.me')),
     'includes Shadowrocket-native Naive URI (https:// scheme)');
  ok(!three.some(u => u.startsWith('naive+https://')),
     'buildUserUris no longer emits naive+https:// (Shadowrocket cannot parse it)');
  ok(three.some(u => u.startsWith('mierus://')),      'includes mieru URI');
  ok(three.some(u => u.startsWith('hysteria2://')),   'includes hy2 URI (was the bug!)');

  sandbox.__u2 = mkUser(['naive', 'hy2']);
  const two = vm.runInContext('buildUserUris(__u2, {})', sandbox);
  ok(two.length === 2, '2 checkboxes → 2 URIs');
  ok(!two.some(u => u.startsWith('mierus://')), 'mieru omitted when unchecked');

  sandbox.__u1 = mkUser(['mieru']);
  const one = vm.runInContext('buildUserUris(__u1, {})', sandbox);
  ok(one.length === 1 && one[0].startsWith('mierus://'), '1 checkbox → 1 URI (mieru only)');
}

console.log('\n[sub-link] Hy2 excluded when the server stack has no Hy2 installed');
{
  const saved = sandbox.cfg.stack.hy2;
  sandbox.cfg.stack.hy2 = false;
  sandbox.__uh = mkUser(['naive', 'mieru', 'hy2']);
  const uris = vm.runInContext('buildUserUris(__uh, {})', sandbox);
  ok(!uris.some(u => u.startsWith('hysteria2://')), 'hy2 URI dropped when stack.hy2=false');
  sandbox.cfg.stack.hy2 = saved;
}

console.log('\n[sub-link] buildSingboxConfig (Karing) includes a Hysteria2 outbound');
{
  sandbox.__su = mkUser(['naive', 'mieru', 'hy2']);
  const cfgOut = vm.runInContext('buildSingboxConfig(__su, {})', sandbox);
  const tags = cfgOut.outbounds.map(o => o.tag);
  ok(tags.includes('naive-out'), 'sing-box has naive-out');
  ok(tags.includes('mieru-out'), 'sing-box has mieru-out (Karing needs Mieru as JSON)');
  ok(tags.includes('hy2-out'),   'sing-box has hy2-out (universal Hy2 fix)');
  const hy2Ob = cfgOut.outbounds.find(o => o.tag === 'hy2-out');
  ok(hy2Ob && hy2Ob.type === 'hysteria2', 'hy2-out is type hysteria2');
  // v1.8.8 FIX (Karing red triangle): server auth is userpass, and sing-box has
  // no userpass alias → the hy2 password MUST be the combined username:password.
  ok(hy2Ob.password === 'ivan:siyIjCBwaUr08dxS',
     'hy2-out password is combined username:password (userpass → sing-box fix)');
  ok(hy2Ob.tls && hy2Ob.tls.enabled === true && hy2Ob.tls.server_name === 'sv.example.com',
     'hy2-out TLS enabled with SNI pinned to domain');
  const sel = cfgOut.outbounds.find(o => o.type === 'urltest');
  ok(sel && sel.outbounds.length === 3, 'urltest selector lists all 3 enabled tags');

  // Only naive → selector has 1 tag, no mieru/hy2 outbounds.
  sandbox.__sn = mkUser(['naive']);
  const cfgN = vm.runInContext('buildSingboxConfig(__sn, {})', sandbox);
  const tagsN = cfgN.outbounds.map(o => o.tag);
  ok(!tagsN.includes('mieru-out') && !tagsN.includes('hy2-out'), 'disabled protocols absent from sing-box');
}

console.log('\n[sub-link] detectSubClient: User-Agent + overrides');
{
  const call = (ua, query = {}) =>
    vm.runInContext(`detectSubClient(${JSON.stringify({ headers: { 'user-agent': ua }, query })})`, sandbox);
  ok(call('Shadowrocket/2.2.0') === 'shadowrocket', 'Shadowrocket UA → shadowrocket');
  ok(call('Karing/1.0')         === 'karing',       'Karing UA → karing');
  ok(call('sing-box 1.8')       === 'karing',       'sing-box UA → karing');
  ok(call('curl/8.0')           === 'shadowrocket', 'unknown UA → shadowrocket (safe default)');
  ok(call('curl/8.0', { client: 'karing' }) === 'karing', '?client=karing override');
  ok(call('Karing/1.0', { client: 'shadowrocket' }) === 'shadowrocket', '?client=shadowrocket override wins over UA');
  ok(call('curl/8.0', { format: 'singbox' }) === 'karing', '?format=singbox → karing');
}

console.log('\n[sub-link] base64 body round-trips to the URI list');
{
  sandbox.__b = mkUser(['naive', 'hy2']);
  const uris = vm.runInContext('buildUserUris(__b, {})', sandbox);
  const b64  = Buffer.from(uris.join('\n'), 'utf8').toString('base64');
  const back = Buffer.from(b64, 'base64').toString('utf8').split('\n');
  ok(back.length === 2 && back[0] === uris[0] && back[1] === uris[1], 'base64 decodes back to the exact URIs');
}

console.log('\n[sub-link] Subscription-Userinfo header (traffic + expiry)');
{
  const u = mkUser(['naive'], { usedMB: 100, quotaMB: 1024, expiry: '2030-01-01T00:00:00.000Z' });
  sandbox.__ui = u;
  const hdr = vm.runInContext('buildSubUserinfo(__ui)', sandbox);
  ok(/download=104857600/.test(hdr), 'used 100MB → download bytes correct');
  ok(/total=1073741824/.test(hdr),   'quota 1024MB → total bytes correct');
  const expTs = Math.floor(Date.parse('2030-01-01T00:00:00.000Z') / 1000);
  ok(hdr.includes('expire=' + expTs), 'expiry → unix timestamp in header');

  const u2 = mkUser(['naive'], { usedMB: 0, quotaMB: 0, expiry: null });
  sandbox.__ui2 = u2;
  const hdr2 = vm.runInContext('buildSubUserinfo(__ui2)', sandbox);
  ok(/total=0/.test(hdr2) && !/expire=/.test(hdr2), 'unlimited (total=0) + no expiry omits expire=');
}

console.log('\n[sub-link] subBaseUrl resolution (dedicated domain vs panel fallback)');
{
  sandbox.cfg.subBaseUrl = '';
  ok(vm.runInContext('subBaseUrl()', sandbox) === 'https://sv.example.com', 'empty → panel domain');
  sandbox.cfg.subBaseUrl = 'https://sub.example.com/';
  ok(vm.runInContext('subBaseUrl()', sandbox) === 'https://sub.example.com', 'dedicated domain, trailing slash stripped');
  sandbox.cfg.subBaseUrl = 'sub.example.com';
  ok(vm.runInContext('subBaseUrl()', sandbox) === 'https://sub.example.com', 'bare host → https:// prefixed');
  sandbox.cfg.subBaseUrl = '';
}

console.log('\nResult: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
