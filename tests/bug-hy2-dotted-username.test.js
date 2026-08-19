// ─────────────────────────────────────────────────────────────────────────────
// v1.9.1 — SUBSCRIBER BUG: a Hy2 user whose username contains a DOT (e.g.
// "ivan.petrov") took DOWN Hysteria2 entirely.
//
// ROOT CAUSE: buildHy2AuthBlock() emitted the username as a BARE YAML map key:
//     auth:
//       type: userpass
//       userpass:
//         ivan.petrov: "password"     ← bare key
// The value (password) was already yamlQuote()'d, but the KEY was not. A dot in
// a bare YAML key is a classic footgun — several YAML tools/loaders reinterpret
// `a.b` as a nested path or otherwise mis-handle it; a single such entry
// corrupts the WHOLE auth.userpass map, so Hysteria rejects the config on reload
// and the service falls over for EVERY Hy2 client (not just the dotted user).
// The panel ALSO advertises `.` as allowed (USERNAME_RE = [a-zA-Z0-9_.-]), so
// the promise and the behaviour disagreed.
//
// FIX (server-side, honour the promise): quote the KEY too, exactly like the
// value — `"ivan.petrov": "password"`. In YAML a double-quoted key and a bare
// key denote the identical string for plain names, so existing installs auth
// byte-identically; only dotted / leading-digit / leading-dash names get
// repaired. The username validator is UNCHANGED (dot stays allowed).
//
// This test extracts the pure yamlQuote() + buildHy2AuthBlock() from source and
// runs them in a vm sandbox (crypto mocked), then asserts the emitted block.
// No root / no live Hysteria needed.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  \u2713 ' + m); } else { fail++; console.log('  \u2717 ' + m); } };

const ROOT      = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(ROOT, 'panel', 'server', 'index.js'), 'utf8');

function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('function not found: ' + name);
  let p = src.indexOf('(', start), pdepth = 0, j = p;
  for (; j < src.length; j++) {
    if (src[j] === '(') pdepth++;
    else if (src[j] === ')') { pdepth--; if (pdepth === 0) { j++; break; } }
  }
  let i = src.indexOf('{', j), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

const sandbox = { String, Set, crypto: require('crypto') };
vm.createContext(sandbox);
for (const n of ['yamlQuote', 'buildHy2AuthBlock']) vm.runInContext(extractFn(serverSrc, n), sandbox);

const build = users =>
  vm.runInContext(`buildHy2AuthBlock(${JSON.stringify(users)})`, sandbox);

// A deliberately small YAML "userpass map" reader that mirrors how a strict
// loader tokenises `  <key>: <value>` lines. It requires the key to be a single
// double-quoted scalar OR a bare token WITHOUT a dot — this is exactly the
// ambiguity the fix removes. We use it only to PROVE the shape is unambiguous.
function parseUserpass(block) {
  const out = {};
  const lines = block.split('\n');
  let inMap = false;
  for (const raw of lines) {
    if (/^\s*userpass:\s*$/.test(raw)) { inMap = true; continue; }
    if (!inMap) continue;
    if (!/^\s{4}\S/.test(raw)) continue;           // only the 4-space entries
    const body = raw.slice(4);
    // key is either "quoted" or a bare token up to the first ': '
    let key, rest;
    if (body[0] === '"') {
      // read a double-quoted scalar (with \" escapes)
      let i = 1, k = '';
      for (; i < body.length; i++) {
        if (body[i] === '\\') { k += body[i + 1]; i++; continue; }
        if (body[i] === '"') { i++; break; }
        k += body[i];
      }
      key = k; rest = body.slice(i).replace(/^:\s*/, '');
    } else {
      const m = body.match(/^([^:]+):\s*(.*)$/);
      key = m ? m[1] : body; rest = m ? m[2] : '';
      // a bare key with a dot is the AMBIGUOUS case we forbid post-fix
      if (key.includes('.')) throw new Error('AMBIGUOUS bare dotted key: ' + key);
    }
    out[key] = rest;
  }
  return out;
}

console.log('[hy2-dot] dotted username is emitted as a QUOTED key (bug fix)');
{
  const block = build([{ username: 'ivan.petrov', password: 'siyIjCBwaUr08dxS', protocols: ['hy2'] }]);
  ok(/^\s{4}"ivan\.petrov":\s*"siyIjCBwaUr08dxS"\s*$/m.test(block),
     'username with a dot → `"ivan.petrov": "…"` (key is double-quoted)');
  ok(!/^\s{4}ivan\.petrov:/m.test(block),
     'never emits the bare unquoted `ivan.petrov:` key that corrupted the map');
  // The block parses UNAMBIGUOUSLY now.
  const map = parseUserpass(block);
  ok(Object.keys(map).length === 1 && map['ivan.petrov'] === '"siyIjCBwaUr08dxS"',
     'userpass map parses to exactly ONE entry keyed by the full dotted name');
}

console.log('\n[hy2-dot] plain usernames are byte-identical in meaning (no regression)');
{
  const block = build([
    { username: 'john_doe', password: 'abc12345', protocols: ['hy2'] },
    { username: 'alice',    password: 'def67890', protocols: ['hy2'] },
  ]);
  ok(/^\s{4}"john_doe":\s*"abc12345"\s*$/m.test(block), 'john_doe quoted key present');
  ok(/^\s{4}"alice":\s*"def67890"\s*$/m.test(block),    'alice quoted key present');
  const map = parseUserpass(block);
  ok(map['john_doe'] === '"abc12345"' && map['alice'] === '"def67890"',
     'both plain users parse to their passwords (a quoted key == bare key for plain names)');
  ok(/^auth:\n {2}type: userpass\n {2}userpass:\n/.test(block),
     'auth: / type: userpass / userpass: header shape unchanged');
}

console.log('\n[hy2-dot] other edge-case names that break bare YAML keys are also safe');
{
  // leading digit, leading dash, and a value with special chars.
  const block = build([
    { username: '1user',    password: 'p1p1p1p1', protocols: ['hy2'] },
    { username: '-dash',    password: 'p2p2p2p2', protocols: ['hy2'] },
    { username: 'a.b.c.d',  password: 'p3p3p3p3', protocols: ['hy2'] },
  ]);
  const map = parseUserpass(block);   // throws if any bare dotted key slipped through
  ok(map['1user']   === '"p1p1p1p1"', 'leading-digit username quoted + parsed');
  ok(map['-dash']   === '"p2p2p2p2"', 'leading-dash username quoted + parsed');
  ok(map['a.b.c.d'] === '"p3p3p3p3"', 'multi-dot username quoted + parsed as one key');
}

console.log('\n[hy2-dot] empty pool still emits the disabled sentinel (service stays UP)');
{
  const block = build([]);   // nobody has hy2
  ok(/"__disabled_no_hy2_users__":\s*"disabled-[0-9a-f]+"/.test(block),
     'disabled sentinel entry present (now also quoted-key) when no Hy2 users');
  ok(/^auth:\n {2}type: userpass\n {2}userpass:\n {4}"__disabled_no_hy2_users__":/.test(block),
     'sentinel keeps the map non-empty so Hysteria does not reject the config');
}

console.log('\n[hy2-dot] SOURCE — the key is quoted at the emit site');
{
  ok(/lines\.push\(`\s*\$\{yamlQuote\(u\.username\)\}:\s*\$\{yamlQuote\(pw\)\}`\)/.test(serverSrc),
     'buildHy2AuthBlock emits `${yamlQuote(u.username)}: ${yamlQuote(pw)}`');
  // USERNAME_RE must STILL allow the dot (we honour the promise, not remove it).
  ok(/const USERNAME_RE\s*=\s*\/\^\[a-zA-Z0-9_\.-\]\{1,64\}\$\//.test(serverSrc),
     'USERNAME_RE still permits the dot (validator unchanged — dot stays allowed)');
}

console.log('\nResult: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
