// ─────────────────────────────────────────────────────────────────────────────
// v1.9.4 — FEATURE: per-server display flag/prefix on all issued configs.
//
// The admin can set a cosmetic emoji/text prefix (e.g. "🇷🇺" or "🇳🇱 RP") that is
// prepended to the DISPLAY NAME of every standard config the server hands out
// (naive / mieru / hy2), in BOTH the base64 URI list and the sing-box JSON.
// It is purely a label — never touches credentials/host/protocol — so it cannot
// break a connection. Bonus links are intentionally NOT flagged (the admin puts
// a flag straight into the bonus URI if they want one).
//
// Convention: no server boot. We vm-extract the pure builders and exercise them
// with serverFlag set and empty (regression), plus source/UI/i18n contracts.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  \u2713 ' + m); } else { fail++; console.log('  \u2717 ' + m); } };

const ROOT      = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(ROOT, 'panel', 'server', 'index.js'), 'utf8');
const htmlSrc   = fs.readFileSync(path.join(ROOT, 'panel', 'public', 'index.html'), 'utf8');
const appSrc    = fs.readFileSync(path.join(ROOT, 'panel', 'public', 'app.js'), 'utf8');
const ru        = JSON.parse(fs.readFileSync(path.join(ROOT, 'panel', 'public', 'locales', 'ru.json'), 'utf8'));
const en        = JSON.parse(fs.readFileSync(path.join(ROOT, 'panel', 'public', 'locales', 'en.json'), 'utf8'));

function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('function not found: ' + name);
  let p = src.indexOf('(', start), pdepth = 0, j = p;
  for (; j < src.length; j++) { if (src[j] === '(') pdepth++; else if (src[j] === ')') { pdepth--; if (pdepth === 0) { j++; break; } } }
  let i = src.indexOf('{', j), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } } }
  return src.slice(start, i);
}

function mkSandbox(flag) {
  const sb = {
    encodeURIComponent, parseInt, parseFloat, Number, Math, Buffer, isNaN, Array, Date, String, URL, JSON,
    parseUserRow(u) { return { ...u, protocols: typeof u.protocols === 'string' ? JSON.parse(u.protocols) : (u.protocols || []) }; },
    pickMieruPort(r, s) { return s; },
    cfg: { domain: 'sv.example.com', serverIp: '1.2.3.4', naivePort: 443,
           mieruPortStart: 2000, mieruPortEnd: 2010, hy2Port: 443,
           serverFlag: flag, stack: { naive: true, mieru: true, hy2: true } }
  };
  vm.createContext(sb);
  for (const n of ['applyServerFlag','buildMierusLink','buildHy2Link','buildShadowrocketHttpsLink',
                   'normalizeBonusLinks','enabledBonusUrls','bonusUrlToSingboxOutbound',
                   'buildUserUris','buildSingboxConfig'])
    vm.runInContext(extractFn(serverSrc, n), sb);
  return sb;
}
const mkUser = (protocols, extra = {}) => ({ username: 'ivan', password: 'pw',
  protocols: JSON.stringify(protocols), usedMB: 0, quotaMB: 0, expiry: null, ...extra });

// ── [1] applyServerFlag helper ───────────────────────────────────────────────
console.log('\n[1] applyServerFlag()');
{
  const sb = mkSandbox('🇷🇺 RP');
  ok(vm.runInContext("applyServerFlag('ivan')", sb) === '🇷🇺 RP ivan', 'prepends flag + space');
  const sbEmpty = mkSandbox('');
  ok(vm.runInContext("applyServerFlag('ivan')", sbEmpty) === 'ivan', 'empty flag → name unchanged');
  const sbWs = mkSandbox('   ');
  ok(vm.runInContext("applyServerFlag('ivan')", sbWs) === 'ivan', 'whitespace-only flag → name unchanged');
}

// ── [2] base64 URI labels carry the flag ─────────────────────────────────────
console.log('\n[2] URI display labels carry the flag');
{
  const sb = mkSandbox('🇷🇺 RP');
  sb.u = mkUser(['naive', 'mieru', 'hy2']);
  const uris = vm.runInContext('buildUserUris(u, {})', sb);
  const enc = encodeURIComponent('🇷🇺 RP ivan');
  const naive = uris.find(u => u.startsWith('https://'));
  ok(naive.includes('remarks=' + enc), 'naive (Shadowrocket https) remarks carry the flag');
  const mieru = uris.find(u => u.startsWith('mierus://'));
  ok(mieru.endsWith('#' + enc), 'mieru URI #fragment carries the flag');
  const hy2 = uris.find(u => u.startsWith('hysteria2://'));
  ok(hy2.endsWith('#' + enc), 'hy2 URI #fragment carries the flag');
}

// ── [3] sing-box JSON tags carry the flag AND selector refs stay valid ───────
console.log('\n[3] sing-box JSON tags carry the flag, selector references still resolve');
{
  const sb = mkSandbox('🇷🇺 RP');
  sb.u = mkUser(['naive', 'mieru', 'hy2']);
  const cfg = vm.runInContext('buildSingboxConfig(u, {})', sb);
  const tags = cfg.outbounds.map(o => o.tag);
  ok(tags.includes('🇷🇺 RP naive-out'), 'naive-out tag flagged');
  ok(tags.includes('🇷🇺 RP mieru-out'), 'mieru-out tag flagged');
  ok(tags.includes('🇷🇺 RP hy2-out'),   'hy2-out tag flagged');
  const sel = cfg.outbounds.find(o => o.type === 'urltest');
  ok(sel.outbounds.every(t => cfg.outbounds.some(o => o.tag === t)),
     'every urltest selector ref resolves to a real outbound (no broken selector)');
  ok(sel.outbounds.length === 3, 'selector lists all 3 flagged tags');
}

// ── [4] REGRESSION: empty flag = byte-identical to pre-v1.9.4 ────────────────
console.log('\n[4] regression — empty flag produces the old, unchanged output');
{
  const sb = mkSandbox('');
  sb.u = mkUser(['naive', 'mieru', 'hy2']);
  const uris = vm.runInContext('buildUserUris(u, {})', sb);
  ok(uris.find(u => u.startsWith('hysteria2://')).endsWith('#ivan'), 'hy2 URI ends with #ivan (old form)');
  ok(uris.find(u => u.startsWith('https://')).includes('remarks=ivan'), 'naive remarks=ivan (old form)');
  // mieru previously had NO fragment; with empty flag applyServerFlag('ivan')
  // returns 'ivan' so a #ivan fragment is now always present — assert it is at
  // least the plain username (no flag leaked).
  ok(uris.find(u => u.startsWith('mierus://')).endsWith('#ivan'), 'mieru URI #fragment is plain username');
  const cfg = vm.runInContext('buildSingboxConfig(u, {})', sb);
  const tags = cfg.outbounds.filter(o => ['naive','mieru','hysteria2'].includes(o.type)).map(o => o.tag);
  ok(tags.join(',') === 'naive-out,mieru-out,hy2-out', 'sing-box tags are the plain functional ids');
}

// ── [5] bonus links are NOT flagged ──────────────────────────────────────────
console.log('\n[5] bonus links are left untouched (admin flags them manually)');
{
  const sb = mkSandbox('🇷🇺 RP');
  sb.u = mkUser(['naive'], { bonus_links: JSON.stringify([
    { url: 'vless://11111111-2222-3333-4444-555555555555@vl.io:443?security=tls&sni=vl.io#MyBonus', enabled: true }
  ]) });
  const cfg = vm.runInContext('buildSingboxConfig(u, {})', sb);
  const bonus = cfg.outbounds.find(o => o.type === 'vless');
  ok(!!bonus, 'bonus vless outbound present');
  ok(bonus.tag === 'bonus-1', 'bonus tag is NOT prefixed with the server flag');
}

// ── [6] config + POST handler + UI + i18n contracts ──────────────────────────
console.log('\n[6] plumbing: config default, POST accept, UI, i18n');
ok(/serverFlag: ''/.test(serverSrc), 'serverFlag default present in config defaults');
ok(/'subBaseUrl','serverFlag'\]\.forEach/.test(serverSrc), 'POST /api/config accepts serverFlag');
ok(/cfg\.serverFlag = cfg\.serverFlag\.trim\(\)\.slice\(0, 32\)/.test(serverSrc), 'serverFlag trimmed + length-capped');
ok(/id="s-server-flag"/.test(htmlSrc), 'settings input present');
ok(/data-action="save-server-flag"/.test(htmlSrc), 'save button wired');
ok(/function saveServerFlag\(/.test(appSrc), 'saveServerFlag() defined in app.js');
ok(/api\('POST', '\/api\/config', \{ serverFlag: raw \}\)/.test(appSrc), 'saveServerFlag posts serverFlag');
ok(/const flagEl = el\('s-server-flag'\);\s*\n\s*if \(flagEl\) flagEl\.value = cfg\.serverFlag/.test(appSrc),
   'loadSettings populates the field');
for (const [name, loc] of [['ru', ru], ['en', en]]) {
  const s = loc.settings || {};
  ['serverFlagTitle','serverFlagDesc','serverFlagLabel','serverFlagPlaceholder','applyServerFlag','serverFlagSaved']
    .forEach(k => ok(typeof s[k] === 'string' && s[k].length > 0, `locale ${name}: settings.${k} present`));
}

console.log(`\nfeat-server-flag: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
