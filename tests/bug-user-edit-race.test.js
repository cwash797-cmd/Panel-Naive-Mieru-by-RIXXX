// ─────────────────────────────────────────────────────────────────────────────
// v1.9.7 — BUG FIX: editing an existing user shows "failed" even though the
// edit actually saved (visible after a manual F5).
//
// Root cause (BUG-176 async-apply race): a user CRUD (PUT/POST /api/users)
// responds instantly and then regenerates the Caddyfile + restarts caddy/mita/hy2
// in the BACKGROUND (applyAllConfigsAsync). saveUser() then immediately does
// `await loadUsers()`, whose GETs go through Caddy — and if they land inside the
// reload window, fetch() rejects with a transport TypeError ("Failed to fetch").
// The old code surfaced that as a save error, even though the write persisted.
//
// Fix (client-side, no server change):
//   • api() gains an opt-in SILENT, retrying GET (transport errors only; never
//     retries mutations, never hides real HTTP 4xx/5xx).
//   • loadUsers(opts) forwards { retry, silent } and re-throws on a failed
//     background refresh instead of painting the table red.
//   • saveUser() closes the modal first, refreshes with loadUsers({retry:3}),
//     and on refresh failure shows a gentle "savedRefreshHint" — NOT a save error.
//
// Strategy (suite convention): (1) run the REAL api() extracted from app.js in a
// vm sandbox against a live throwaway http server that fails the first N GET
// attempts at the TRANSPORT level, proving the silent retry recovers; and
// (2) assert the saveUser/loadUsers/i18n contracts by source inspection.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const fs   = require('fs');
const path = require('path');
const http = require('http');
const net  = require('net');
const vm   = require('vm');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  \u2713 ' + m); } else { fail++; console.log('  \u2717 ' + m); } };

const ROOT   = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(ROOT, 'panel', 'public', 'app.js'), 'utf8');
const ru     = JSON.parse(fs.readFileSync(path.join(ROOT, 'panel', 'public', 'locales', 'ru.json'), 'utf8'));
const en     = JSON.parse(fs.readFileSync(path.join(ROOT, 'panel', 'public', 'locales', 'en.json'), 'utf8'));

// Extract a named function's SOURCE (from `async function NAME(` or `function NAME(`
// to its matching closing brace) so we can run the real thing in a sandbox.
function extractFn(src, name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const m = re.exec(src);
  if (!m) throw new Error('function not found: ' + name);
  // Skip the parameter list first (it may itself contain {}/() — e.g. a default
  // like `apiOpts = {}`), by paren-matching from the opening '(' of the signature.
  let k = src.indexOf('(', m.index);
  let pdepth = 0, bodyStart = -1;
  for (let j = k; j < src.length; j++) {
    const ch = src[j];
    if (ch === '(') pdepth++;
    else if (ch === ')') { pdepth--; if (pdepth === 0) { bodyStart = src.indexOf('{', j); break; } }
  }
  if (bodyStart < 0) throw new Error('signature end not found for ' + name);
  let depth = 0;
  for (let j = bodyStart; j < src.length; j++) {
    const ch = src[j];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(m.index, j + 1); }
  }
  throw new Error('unbalanced braces for ' + name);
}

// ── [live] silent GET retry survives a transport drop ────────────────────────
async function run() {
  console.log('\n[live] api() silent retry recovers from a transport-level GET failure');

  const apiFnSrc = extractFn(appSrc, 'api');

  // A server that REFUSES the first `failFor` requests at the transport level
  // (socket destroyed → fetch() rejects with a TypeError), then answers 200 JSON.
  let hits = 0;
  const failFor = 2;
  const server = http.createServer((req, res) => {
    hits++;
    if (hits <= failFor) { req.socket.destroy(); return; }   // transport failure
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, hits }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  let toasts = [];
  const sandbox = {
    fetch,
    setTimeout,
    console,
    apiUrl: (p) => base + p,
    toast: (msg, kind) => toasts.push({ msg, kind }),
    location: { href: '' },
    document: { cookie: '' },
  };
  vm.createContext(sandbox);
  vm.runInContext(apiFnSrc + '\nthis.__api = api;', sandbox);
  const api = sandbox.__api;

  // (A) A silent, retrying GET must eventually succeed despite the early drops.
  toasts = [];
  const data = await api('GET', '/api/users', null, { retry: 3, retryDelay: 5, silent: true });
  ok(data && data.ok === true, 'silent retrying GET succeeds after transport drops');
  ok(hits === failFor + 1, `retried past ${failFor} drops (server saw ${hits} hits)`);
  ok(toasts.length === 0, 'no error toast shown while silently retrying');

  // (B) A plain GET with NO retry must reject on the very first transport drop.
  hits = 0;
  toasts = [];
  let threw = false;
  try { await api('GET', '/api/users'); } catch (_) { threw = true; }
  ok(threw, 'a GET without retry still throws on a transport failure');
  ok(hits === 1, 'no-retry GET makes exactly one attempt');

  // (C) A mutation (PUT) must NEVER be retried even if retry is (mis)passed —
  //     retrying a write could double-apply. One attempt, then throw.
  hits = 0;
  let mutThrew = false;
  try { await api('PUT', '/api/users/1', { x: 1 }, { retry: 5, retryDelay: 5 }); }
  catch (_) { mutThrew = true; }
  ok(mutThrew, 'a PUT still throws on transport failure (write is idempotent-safe)');
  ok(hits === 1, 'mutation is NOT retried (exactly one attempt) even with retry set');

  server.close();
}

// ── [static] saveUser / loadUsers / i18n contracts ──────────────────────────
function staticChecks() {
  console.log('\n[static] saveUser(): a failed refresh is not a save error');
  const saveUserSrc = extractFn(appSrc, 'saveUser');
  ok(/closeUserModal\(\)/.test(saveUserSrc),
     'saveUser closes the modal after the write succeeds');
  ok(/loadUsers\(\s*\{\s*retry:\s*3\s*\}\s*\)/.test(saveUserSrc),
     'saveUser refreshes with loadUsers({ retry: 3 })');
  // the refresh must be wrapped so its failure shows a soft hint, not "failed"
  ok(/try\s*\{[\s\S]*loadUsers\(\s*\{\s*retry:\s*3\s*\}\s*\)[\s\S]*\}\s*catch[\s\S]*savedRefreshHint/.test(saveUserSrc),
     'a failed refresh shows users.savedRefreshHint (never a save error)');

  console.log('\n[static] loadUsers(opts): forwards the silent-retry option');
  const loadUsersSrc = extractFn(appSrc, 'loadUsers');
  ok(/function loadUsers\(\s*opts\s*=\s*\{\}\s*\)/.test(loadUsersSrc),
     'loadUsers accepts an opts object');
  ok(/retry:\s*opts\.retry/.test(loadUsersSrc) && /silent:\s*!!opts\.retry/.test(loadUsersSrc),
     'loadUsers builds { retry, silent } from opts');
  ok(/api\('GET',\s*'\/api\/users',\s*null,\s*apiOpts\)/.test(loadUsersSrc),
     'loadUsers forwards apiOpts to GET /api/users');
  ok(/api\('GET',\s*'\/api\/stats\/users',\s*null,\s*apiOpts\)/.test(loadUsersSrc),
     'loadUsers forwards apiOpts to GET /api/stats/users');
  ok(/if\s*\(\s*opts\.retry\s*\)\s*throw\s+err/.test(loadUsersSrc),
     'a failed background refresh re-throws instead of painting the table red');

  console.log('\n[static] api(): opt-in silent retry for GET transport errors only');
  const apiSrc = extractFn(appSrc, 'api');
  ok(/function api\(method,\s*path,\s*body,\s*apiOpts\s*=\s*\{\}\)/.test(apiSrc),
     'api() gained an apiOpts param (default {} — existing callers unchanged)');
  ok(/method\s*===\s*'GET'\s*&&\s*apiOpts\.retry/.test(apiSrc),
     'retries are gated to GET + explicit apiOpts.retry');
  ok(/catch\s*\(\s*netErr\s*\)/.test(apiSrc),
     'retry loop catches transport (network) errors');
  ok(/if\s*\(!apiOpts\.silent\)\s*toast\(/.test(apiSrc),
     'HTTP-error toast is suppressed when apiOpts.silent (real 4xx/5xx still throws)');

  console.log('\n[static] i18n: users.savedRefreshHint present & non-empty (ru/en parity)');
  ok(ru.users && typeof ru.users.savedRefreshHint === 'string' && ru.users.savedRefreshHint.trim(),
     'ru.users.savedRefreshHint present and non-empty');
  ok(en.users && typeof en.users.savedRefreshHint === 'string' && en.users.savedRefreshHint.trim(),
     'en.users.savedRefreshHint present and non-empty');
}

// ── run ──────────────────────────────────────────────────────────────────────
run().then(() => {
  staticChecks();
  console.log(`\nbug-user-edit-race: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}).catch(e => { console.error(e); process.exit(1); });
