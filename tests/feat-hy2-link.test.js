// ─────────────────────────────────────────────────────────────────────────────
// v1.7.0 — FEATURE: Hysteria2 (Hy2) integration into the shared user pool.
//
// Hy2 becomes a THIRD protocol alongside naive+mieru. A user has Hy2 access iff
// its `protocols` array contains "hy2" (shared pool, NOT a separate list).
//
// This test validates the PURE helpers extracted from panel/server/index.js —
// no server boot, no DB — matching the rest of the suite:
//   • buildHy2Link()        → canonical hysteria2:// share link
//   • buildHy2AuthBlock()   → auth.userpass YAML map from the shared pool
//   • spliceHy2Auth()       → replaces ONLY the auth: block, preserves the rest
//   • hy2ConfigLooksValid() → structural sanity gate before writing
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const fs   = require('fs');
const path = require('path');
// buildHy2AuthBlock() uses crypto.randomBytes for the disabled sentinel entry;
// the eval-extracted function closes over this in-scope binding.
const crypto = require('crypto');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  \u2713 ' + m); } else { fail++; console.log('  \u2717 ' + m); } };

const SERVER = path.join(__dirname, '..', 'panel', 'server', 'index.js');
const src = fs.readFileSync(SERVER, 'utf8');

function extract(name) {
  const re = new RegExp('function ' + name + '\\s*\\([\\s\\S]*?\\n\\}', 'm');
  const m = src.match(re);
  ok(!!m, name + '() present in server source');
  // eslint-disable-next-line no-eval
  return m ? eval('(' + m[0].replace(new RegExp('^function ' + name), 'function') + ')') : null;
}

const buildHy2Link       = extract('buildHy2Link');
const buildHy2AuthBlock  = extract('buildHy2AuthBlock');
const yamlQuote          = extract('yamlQuote');
const spliceHy2Auth      = extract('spliceHy2Auth');
const hy2ConfigLooksValid= extract('hy2ConfigLooksValid');

// ── buildHy2Link ─────────────────────────────────────────────────────────────
const link = buildHy2Link({ username: 'alice', password: 's3cret', domain: 'vpn.example.com', port: 443 });
console.log('  → ' + link);
ok(link.startsWith('hysteria2://'), 'scheme is hysteria2://');
ok(link.includes('alice:s3cret@'), 'userinfo carries username:password');
ok(link.includes('@vpn.example.com:443?'), 'host:port present (domain + configured port)');
ok(/[?&]sni=vpn\.example\.com/.test(link), 'sni param equals domain');
ok(/[?&]insecure=0/.test(link), 'insecure=0 (real trusted cert)');
ok(link.endsWith('#alice'), 'fragment carries the username label');

const linkPort = buildHy2Link({ username: 'bob', password: 'pw', domain: 'd.io', port: 8443 });
ok(linkPort.includes('@d.io:8443?'), 'configurable port is honoured (8443)');

const linkEnc = buildHy2Link({ username: 'u', password: 'p@ss w/rd', domain: 'd.io', port: 443 });
ok(linkEnc.includes('p%40ss%20w%2Frd'), 'odd password is percent-encoded');

// ── buildHy2AuthBlock ────────────────────────────────────────────────────────
const block = buildHy2AuthBlock([
  { username: 'alice', password: 'aaa' },
  { username: 'bob',   password: 'bbb' },
  { username: 'nopw',  password: '' },        // skipped (no plaintext)
  { username: 'alice', password: 'dup' },     // duplicate skipped
]);
ok(/^auth:/m.test(block), 'block starts with auth:');
ok(/^  type: userpass$/m.test(block), 'type: userpass present');
ok(/^  userpass:$/m.test(block), 'userpass: map present');
// v1.9.1: the map KEY is now double-quoted too (dotted-username fix). For plain
// names a quoted key == a bare key in YAML, so this is a pure hardening.
ok(/^    "alice": "aaa"$/m.test(block), 'alice mapped to quoted password (quoted key)');
ok(/^    "bob": "bbb"$/m.test(block), 'bob mapped (quoted key)');
ok(!/nopw/.test(block), 'user without plaintext password is skipped');
ok((block.match(/"alice":/g) || []).length === 1, 'duplicate username emitted once');

const emptyBlock = buildHy2AuthBlock([]);
// v1.8.2 anti-crash: Hy2 FATALs on an empty userpass map, so instead of a bare
// `{}` we now emit a disabled sentinel entry with a random password → the map
// is genuinely non-empty and the service stays up with zero real clients.
ok(!/\{\}/.test(emptyBlock), 'empty pool no longer emits a bare `{}` (would FATAL)');
ok(/^    "__disabled_no_hy2_users__": ".+"$/m.test(emptyBlock),
   'empty pool emits a disabled sentinel entry (non-empty map → Hy2 stays up)');

// ── spliceHy2Auth ────────────────────────────────────────────────────────────
const cfgText = [
  'listen: :443',
  '',
  'auth:',
  '  type: userpass',
  '  userpass:',
  '    old: "x"',
  '',
  'masquerade:',
  '  type: file',
  '  file:',
  '    dir: /var/www/html',
  '',
  'tls:',
  '  cert: /c.crt',
  '  key: /c.key',
  ''
].join('\n');

const newBlock = buildHy2AuthBlock([{ username: 'newuser', password: 'np' }]);
const spliced = spliceHy2Auth(cfgText, newBlock);
ok(spliced.includes('"newuser": "np"'), 'splice inserts new users');
ok(!spliced.includes('old: "x"'), 'splice removes the old userpass entries');
ok(spliced.includes('listen: :443'), 'splice preserves listen: directive');
ok(spliced.includes('masquerade:'), 'splice preserves masquerade block');
ok(spliced.includes('tls:') && spliced.includes('/c.crt'), 'splice preserves tls block');
ok(/^auth:/m.test(spliced), 'exactly one auth: block remains');
ok((spliced.match(/^auth:/gm) || []).length === 1, 'no duplicate auth: block');

// ── hy2ConfigLooksValid ──────────────────────────────────────────────────────
ok(hy2ConfigLooksValid(spliced), 'valid config (listen+tls+auth) passes');
ok(!hy2ConfigLooksValid('auth:\n  userpass:\n'), 'missing listen fails');
ok(!hy2ConfigLooksValid('listen: :443\nauth:\n'), 'missing tls/acme fails');
ok(hy2ConfigLooksValid('listen: :443\nacme:\n  domains: [d]\nauth:\n  type: userpass\n'),
   'acme (standalone) instead of tls also passes');

// ── VALID_PROTOCOLS includes hy2 ─────────────────────────────────────────────
ok(/const VALID_PROTOCOLS\s*=\s*\[[^\]]*'hy2'[^\]]*\]/.test(src),
   "VALID_PROTOCOLS includes 'hy2' (shared pool)");

console.log('\nResult: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
