// ─────────────────────────────────────────────────────────────────────────────
// v1.11.5 — expiry cron must revoke Hy2 AND federation (prod bug).
//
// Bug (found on prod): the every-5-min expiry cron deleted the user and rebuilt
// ONLY the Caddyfile (Naive) + Mita (Mieru). It predates Hy2 + federation, so:
//   • Hysteria2 kept the expired credential in config.yaml + the running daemon
//     until some UNRELATED user CRUD rewrote it → expired users kept using Hy2
//     (YouTube etc.) for days; Karing caches its profile on a /sub 404.
//   • On federation nodes the expired user was never removed → lived forever.
//
// Fix: the cron now calls applyAllConfigsAsync() (rebuilds Caddy + Mita +
// Hysteria2 in one place, same path as every other mutation) and
// broadcastDeprovision(email) for each expired user.
//
// This test extracts the cron callback from source and runs it in a vm sandbox
// with mocked helpers, asserting: expired users are deleted, applyAllConfigsAsync
// is called (Hy2 path), broadcastDeprovision is called per expired email, and a
// non-expired user is left untouched. It also statically asserts the old
// Naive-only path (buildCaddyfile/reloadCaddy without Hy2) is gone.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  \u2713 ' + m); } else { fail++; console.log('  \u2717 ' + m); } };

const ROOT      = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(ROOT, 'panel', 'server', 'index.js'), 'utf8');

// ── Extract the '*/5 * * * *' cron callback body ──────────────────────────────
// Grab from `cron.schedule('*/5 * * * *', async () => {` to its matching `});`.
const startMarker = "cron.schedule('*/5 * * * *', async () => {";
const start = serverSrc.indexOf(startMarker);
ok(start >= 0, "expiry cron is now an async callback (so it can await deprovision)");
// brace-match from the first '{' of the arrow body
let i = serverSrc.indexOf('{', start + startMarker.length - 1);
let depth = 0, bodyStart = i, end = -1;
for (; i < serverSrc.length; i++) {
  if (serverSrc[i] === '{') depth++;
  else if (serverSrc[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
}
const cbBody = serverSrc.slice(bodyStart, end);   // includes outer { ... }

// ── Build a runnable callback in a sandbox with mocked helpers ────────────────
const calls = { deleted: [], applyAll: 0, deprovision: [] };
const sandbox = {
  console: { log() {}, error() {} },
  Date,
  getAllUsers: () => ([
    { id: 1, username: 'alice', email: 'alice@x.com', expiry: '2000-01-01T00:00:00.000Z' }, // expired
    { id: 2, username: 'bob',   email: 'bob@x.com',   expiry: '2999-01-01T00:00:00.000Z' }, // active
    { id: 3, username: 'carol', email: '',            expiry: '2000-01-01T00:00:00.000Z' }, // expired, no email
  ]),
  deleteUser: (id) => { calls.deleted.push(id); },
  applyAllConfigsAsync: () => { calls.applyAll++; },
  broadcastDeprovision: async (email) => { calls.deprovision.push(email); return { email, results: [] }; },
  // Present so a regression to the OLD body wouldn't silently no-op in the test:
  buildCaddyfile: () => { calls.oldCaddy = (calls.oldCaddy || 0) + 1; return ''; },
  writeCaddyfileAtomic: () => {},
  reloadCaddy: () => {},
  applyMitaConfig: () => { calls.oldMita = (calls.oldMita || 0) + 1; },
  cfg: {},
};
vm.createContext(sandbox);
// Wrap the extracted body into an async function we can invoke and await.
vm.runInContext(`globalThis.__cronCb = async () => ${cbBody};`, sandbox);

(async () => {
  await sandbox.__cronCb();

  console.log('\n[1] expired users removed, active user kept');
  ok(calls.deleted.includes(1) && calls.deleted.includes(3), 'both expired users (alice, carol) deleted');
  ok(!calls.deleted.includes(2), 'active user (bob) NOT deleted');

  console.log('\n[2] Hy2 revoked via the full apply path');
  ok(calls.applyAll === 1, 'applyAllConfigsAsync() called once (rebuilds Caddy+Mita+Hysteria2)');

  console.log('\n[3] federation deprovision per expired email');
  ok(calls.deprovision.includes('alice@x.com'), 'broadcastDeprovision called for alice@x.com');
  ok(!calls.deprovision.includes(''), 'no deprovision for the empty-email expired user (carol)');
  ok(calls.deprovision.length === 1, 'exactly one federation deprovision (only emails collected)');

  console.log('\n[4] source no longer uses the Naive-only rebuild in the cron');
  // The old body called buildCaddyfile + reloadCaddy + applyMitaConfig directly.
  ok(!/buildCaddyfile\(/.test(cbBody), 'cron no longer calls buildCaddyfile() directly (uses applyAllConfigsAsync)');
  ok(!/reloadCaddy\(/.test(cbBody),   'cron no longer calls reloadCaddy() directly');
  ok(/applyAllConfigsAsync\(\)/.test(cbBody), 'cron calls applyAllConfigsAsync()');
  ok(/broadcastDeprovision\(/.test(cbBody),   'cron calls broadcastDeprovision()');
  ok(/expiredEmails/.test(cbBody),            'cron collects expired emails before delete');

  console.log('\n[5] install.sh accepts Ubuntu 26.04');
  const installSrc = fs.readFileSync(path.join(ROOT, 'install.sh'), 'utf8');
  ok(/20\.04\|22\.04\|24\.04\|26\.04\)/.test(installSrc), 'Ubuntu version case includes 26.04');

  console.log(`\n${fail === 0 ? '\u2705' : '\u274c'} bug-expiry-cron-hy2-federation: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
