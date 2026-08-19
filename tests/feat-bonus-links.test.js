// ─────────────────────────────────────────────────────────────────────────────
// v1.9.0 — Personal "bonus links" FUNCTIONAL + regression test.
//
// Feature: the admin may manually attach arbitrary extra links (primarily
// vless:// from 3x-ui, but ANY string) to a SPECIFIC user's subscription. They
// are stored per-user in a nullable `bonus_links` JSON column and are appended
// to that user's `/sub/:token` base64 URI list AFTER the standard Naive/Mieru/
// Hy2 URIs, joined with the same '\n' separator. Only ENABLED entries are mixed
// in. A user with no (enabled) bonuses must produce a BYTE-IDENTICAL response.
//
// Like the rest of the suite we do NOT boot the server (root-only side-effects);
// we extract the pure functions (normalizeBonusLinks, enabledBonusUrls,
// buildUserUris + friends) and run them in a vm sandbox with a mocked runtime.
// We also assert the presence of the idempotent DB migration + the /sub route
// append at the SOURCE level so we can never silently regress the wiring.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  \u2713 ' + m); } else { fail++; console.log('  \u2717 ' + m); } };

const ROOT      = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(ROOT, 'panel', 'server', 'index.js'), 'utf8');

// ── Extract a named function's source by brace-matching (same as sub-link test) ──
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('function not found: ' + name);
  let p = src.indexOf('(', start);
  let pdepth = 0, j = p;
  for (; j < src.length; j++) {
    if (src[j] === '(') pdepth++;
    else if (src[j] === ')') { pdepth--; if (pdepth === 0) { j++; break; } }
  }
  let i = src.indexOf('{', j);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

// Functions under test + their dependencies.
const NAMES = ['normalizeBonusLinks', 'enabledBonusUrls',
               'buildMierusLink', 'buildHy2Link', 'buildNaiveLink',
               'buildShadowrocketHttpsLink', 'buildUserUris', 'parseUserRow',
               // v1.9.4: buildUserUris labels configs via applyServerFlag().
               'applyServerFlag'];

const sandbox = {
  encodeURIComponent,
  parseInt, parseFloat, Number, Math, Buffer, isNaN, Array, Date, JSON,
  crypto: require('crypto'),
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
// NOTE: we use the REAL parseUserRow/normalizeBonusLinks from source (not a mock)
// so the test tracks the shipped behaviour.
for (const n of NAMES) vm.runInContext(extractFn(serverSrc, n), sandbox);

const mkUser = (protocols, extra = {}) => ({
  username: 'ivan', password: 'siyIjCBwaUr08dxS',
  protocols: JSON.stringify(protocols),
  usedMB: 0, quotaMB: 0, expiry: null, ...extra
});

// Mirror of the ONE line the /sub route runs (buildUserUris + append + base64).
function subBody(user) {
  const uris = vm.runInContext(`buildUserUris(${JSON.stringify(user)}, {})`, sandbox);
  const bonus = vm.runInContext(`enabledBonusUrls(${JSON.stringify(user)})`, sandbox);
  for (const u of bonus) uris.push(u);
  return Buffer.from(uris.join('\n'), 'utf8').toString('base64');
}

console.log('[bonus] normalizeBonusLinks tolerates every shape');
{
  const call = arg => vm.runInContext(`normalizeBonusLinks(${JSON.stringify(arg)})`, sandbox);
  const callRaw = expr => vm.runInContext(`normalizeBonusLinks(${expr})`, sandbox);
  ok(JSON.stringify(callRaw('null')) === '[]', 'NULL → []');
  ok(JSON.stringify(callRaw('undefined')) === '[]', 'undefined → []');
  ok(JSON.stringify(call('')) === '[]', 'empty string → []');
  ok(JSON.stringify(call('not json')) === '[]', 'garbage string → [] (never throws)');
  ok(JSON.stringify(call('[]')) === '[]', 'empty JSON array string → []');

  const strForm = call('["vless://abc","vless://def"]');
  ok(strForm.length === 2 && strForm[0].url === 'vless://abc' && strForm[0].enabled === true,
     'array of bare strings → {url,enabled:true}');

  const objForm = call(JSON.stringify([{ url: 'vless://x', enabled: false }, { url: 'vless://y' }]));
  ok(objForm.length === 2 && objForm[0].enabled === false && objForm[1].enabled === true,
     'objects keep enabled flag; missing enabled defaults true');

  const dirty = call(JSON.stringify([{ url: '   ' }, { foo: 'bar' }, 'vless://z', 42]));
  ok(dirty.length === 1 && dirty[0].url === 'vless://z',
     'blank/objectless/non-string entries dropped');

  // Already-parsed array (mem fallback path) is accepted as-is.
  const parsed = vm.runInContext('normalizeBonusLinks([{url:"vless://m",enabled:true}])', sandbox);
  ok(parsed.length === 1 && parsed[0].url === 'vless://m', 'accepts an already-parsed array (mem fallback)');
}

console.log('\n[bonus] enabledBonusUrls only returns enabled URLs, in order');
{
  const u = mkUser(['naive'], { bonus_links: JSON.stringify([
    { url: 'vless://one', enabled: true },
    { url: 'vless://two', enabled: false },
    { url: 'vless://three', enabled: true },
  ]) });
  const got = vm.runInContext(`enabledBonusUrls(${JSON.stringify(u)})`, sandbox);
  ok(JSON.stringify(got) === JSON.stringify(['vless://one', 'vless://three']),
     'disabled entry skipped; order preserved');

  const none = vm.runInContext(`enabledBonusUrls(${JSON.stringify(mkUser(['naive']))})`, sandbox);
  ok(JSON.stringify(none) === '[]', 'user with no bonus_links → []');
}

console.log('\n[bonus] REGRESSION — empty bonuses give a BYTE-IDENTICAL sub body');
{
  // Same user, once with the column absent and once with an explicit empty list
  // and once with only DISABLED bonuses. All three MUST equal the pre-feature
  // body (= base64 of just the standard URIs). This is the "nothing broke" test.
  const base   = mkUser(['naive', 'mieru', 'hy2']);
  const stdUris = vm.runInContext(`buildUserUris(${JSON.stringify(base)}, {})`, sandbox);
  const baseline = Buffer.from(stdUris.join('\n'), 'utf8').toString('base64');

  const noCol    = subBody(mkUser(['naive', 'mieru', 'hy2']));
  const emptyArr = subBody(mkUser(['naive', 'mieru', 'hy2'], { bonus_links: '[]' }));
  const nullCol  = subBody(mkUser(['naive', 'mieru', 'hy2'], { bonus_links: null }));
  const disabled = subBody(mkUser(['naive', 'mieru', 'hy2'], {
    bonus_links: JSON.stringify([{ url: 'vless://off', enabled: false }]) }));

  ok(noCol    === baseline, 'no bonus_links column → identical base64 (pre-feature output)');
  ok(emptyArr === baseline, 'bonus_links="[]" → identical base64');
  ok(nullCol  === baseline, 'bonus_links=null → identical base64');
  ok(disabled === baseline, 'only DISABLED bonuses → identical base64');
}

console.log('\n[bonus] enabled bonuses are appended AFTER the standard URIs');
{
  const u = mkUser(['naive', 'mieru', 'hy2'], { bonus_links: JSON.stringify([
    { url: 'vless://uuid@host:443?type=tcp#Extra', enabled: true },
  ]) });
  const stdUris = vm.runInContext(`buildUserUris(${JSON.stringify(u)}, {})`, sandbox);
  const body    = subBody(u);
  const lines   = Buffer.from(body, 'base64').toString('utf8').split('\n');

  ok(lines.length === stdUris.length + 1, '4 nodes (3 standard + 1 bonus) in one sub-link');
  ok(lines[lines.length - 1] === 'vless://uuid@host:443?type=tcp#Extra',
     'bonus vless:// is the LAST line (appended after standard URIs)');
  // The standard portion is untouched.
  ok(lines.slice(0, stdUris.length).join('\n') === stdUris.join('\n'),
     'standard Naive/Mieru/Hy2 lines are unchanged');
  ok(lines.some(l => l.startsWith('hysteria2://')), 'Hy2 still present');
  ok(lines.some(l => l.startsWith('mierus://')),     'Mieru still present');
  ok(lines.some(l => l.startsWith('https://') && !l.startsWith('https://t.me')), 'Naive still present');
}

console.log('\n[bonus] bonuses are PERSONAL — one user\'s links never leak to another');
{
  const alice = mkUser(['naive'], { username: 'alice',
    bonus_links: JSON.stringify([{ url: 'vless://ALICE', enabled: true }]) });
  const bob   = mkUser(['naive'], { username: 'bob' }); // no bonuses

  const aBody = Buffer.from(subBody(alice), 'base64').toString('utf8');
  const bBody = Buffer.from(subBody(bob),   'base64').toString('utf8');
  ok(aBody.includes('vless://ALICE'),  "alice's sub contains her bonus");
  ok(!bBody.includes('vless://ALICE'), "bob's sub does NOT contain alice's bonus");
}

console.log('\n[bonus] arbitrary formats are stored AS-IS (no validation)');
{
  const weird = 'this is not even a url $$$ 你好';
  const u = mkUser(['naive'], { bonus_links: JSON.stringify([{ url: weird, enabled: true }]) });
  const lines = Buffer.from(subBody(u), 'base64').toString('utf8').split('\n');
  ok(lines[lines.length - 1] === weird, 'non-URL string passed through verbatim (admin owns correctness)');
}

console.log('\n[bonus] SOURCE — DB migration + route append are wired');
{
  ok(/ALTER TABLE users ADD COLUMN bonus_links TEXT/.test(serverSrc),
     'idempotent ALTER TABLE users ADD COLUMN bonus_links TEXT present');
  // The migration is wrapped in the try{}catch{} idempotent pattern.
  ok(/try\s*\{\s*db\.exec\(`ALTER TABLE users ADD COLUMN bonus_links TEXT`\);\s*\}\s*catch\s*\{\}/.test(serverSrc),
     'bonus_links migration uses the try/catch idempotent pattern (update.sh-safe)');
  ok(/for \(const url of enabledBonusUrls\(user\)\) uris\.push\(url\);/.test(serverSrc),
     '/sub route appends enabledBonusUrls(user) before join+base64');
  ok(/function parseUserRow[\s\S]{0,600}bonus_links:\s*normalizeBonusLinks/.test(serverSrc),
     'parseUserRow normalizes bonus_links');
  ok(/app\.get\('\/api\/users\/:id\/bonus-links'/.test(serverSrc), 'GET bonus-links endpoint present');
  ok(/app\.put\('\/api\/users\/:id\/bonus-links'/.test(serverSrc), 'PUT bonus-links endpoint present');
  // Perms/owner of the DB file must NOT be touched by this feature.
  ok(!/chmod[\s\S]{0,40}bonus/.test(serverSrc), 'feature does not chmod anything (DB stays 600 root:root)');
}

console.log('\nResult: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
