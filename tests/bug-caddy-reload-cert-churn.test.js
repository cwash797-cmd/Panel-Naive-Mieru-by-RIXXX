// ─────────────────────────────────────────────────────────────────────────────
// v1.9.9 — BUG FIX: subscription download fails with a TLS handshake error
// (TLSV1_ALERT_INTERNAL_ERROR) after heavy user editing; both the main and the
// federated nodes "disappear" from the client.
//
// Root cause: applyCaddyConfig() (called after EVERY user CRUD) did a FULL
// `systemctl restart caddy-naive`. On a box with a dedicated subscription
// sub-domain (cfg.subBaseUrl), every restart tears down the listeners and makes
// Caddy re-provision / re-load its TLS certs. During a burst of edits (e.g.
// adding emails to many users while wiring up federation) that restart-storm can
// leave the sub-domain without a live cert mid-flight → clients pulling the /sub
// link get a TLS handshake failure and the whole subscription looks broken.
//
// Fix: prefer a GRACEFUL reload. The caddy-naive.service unit already ships
// `ExecReload=/bin/kill -USR1 $MAINPID`, and per the official Caddy docs a
// SIGUSR1 has "the same effect as caddy reload with the currently loaded config"
// — it hot-swaps the just-written Caddyfile WITHOUT dropping listeners or certs,
// and works even with `admin off`. applyCaddyConfig() now:
//   1. validates the Caddyfile first (unchanged),
//   2. if the service is active → `systemctl reload` (graceful, no cert churn),
//   3. only FALLS BACK to a full restart if reload isn't possible / fails,
//   4. verifies the service is active afterwards (both paths).
//
// Strategy (suite convention): source inspection of the real applyCaddyConfig()
// plus a check that the systemd unit provides ExecReload (so `reload` works).
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const fs   = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  \u2713 ' + m); } else { fail++; console.log('  \u2717 ' + m); } };

const ROOT      = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(ROOT, 'panel', 'server', 'index.js'), 'utf8');
const installSh = fs.readFileSync(path.join(ROOT, 'install.sh'), 'utf8');
const updateSh  = fs.readFileSync(path.join(ROOT, 'update.sh'), 'utf8');

// Extract the applyCaddyConfig() body for targeted assertions.
function extractFn(src, name) {
  const re = new RegExp('function\\s+' + name + '\\s*\\(');
  const m = re.exec(src);
  if (!m) throw new Error('function not found: ' + name);
  let k = src.indexOf('(', m.index), pdepth = 0, bodyStart = -1;
  for (let j = k; j < src.length; j++) {
    const ch = src[j];
    if (ch === '(') pdepth++;
    else if (ch === ')') { pdepth--; if (pdepth === 0) { bodyStart = src.indexOf('{', j); break; } }
  }
  let depth = 0;
  for (let j = bodyStart; j < src.length; j++) {
    const ch = src[j];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(m.index, j + 1); }
  }
  throw new Error('unbalanced braces for ' + name);
}

console.log('\n[1] applyCaddyConfig(): graceful reload preferred over full restart');
const fn = extractFn(serverSrc, 'applyCaddyConfig');

ok(/validateCaddyfile\(\)/.test(fn),
   'still validates the Caddyfile first (never act on an invalid config)');
ok(/systemctl reload caddy-naive/.test(fn),
   'attempts a GRACEFUL `systemctl reload` (no cert re-provision / no TLS gap)');
ok(/systemctl restart caddy-naive/.test(fn),
   'still has a full-restart fallback');

// The reload must be tried BEFORE the restart (order matters — reload is primary).
const reloadIdx  = fn.indexOf('systemctl reload caddy-naive');
const restartIdx = fn.indexOf('systemctl restart caddy-naive');
ok(reloadIdx > -1 && restartIdx > -1 && reloadIdx < restartIdx,
   'reload is attempted BEFORE restart (restart is only the fallback)');

// Reload is only attempted when the service is actually active (else restart).
ok(/is-active caddy-naive/.test(fn),
   'checks the service is active before choosing reload');
ok(/if \(isActive\(\) === 'active'\)/.test(fn),
   'reload path is gated on an active service');

// The restart fallback must still guard against the "repeated too quickly" storm.
ok(/reset-failed caddy-naive/.test(fn),
   'restart fallback still clears a prior failure storm (reset-failed)');

// A reload failure must NOT be fatal on its own — it falls through to restart.
ok(/graceful reload failed, falling back to restart/.test(fn),
   'a failed reload logs and falls back (not a hard error)');

// Final verification still happens on BOTH paths.
const lastActive = fn.lastIndexOf('isActive()');
ok(lastActive > restartIdx,
   'service liveness is re-verified after the reload/restart step');

console.log('\n[2] systemd unit provides ExecReload (so `systemctl reload` works)');
// install.sh and update.sh both write caddy-naive.service; both must define
// ExecReload with SIGUSR1 (Caddy: "same effect as caddy reload").
ok(/ExecReload=\/bin\/kill -USR1 \\\$MAINPID/.test(installSh),
   'install.sh caddy-naive.service defines ExecReload=/bin/kill -USR1 $MAINPID');
ok(/ExecReload=\/bin\/kill -USR1 \\\$MAINPID/.test(updateSh),
   'update.sh caddy-naive.service defines ExecReload=/bin/kill -USR1 $MAINPID');

console.log(`\nbug-caddy-reload-cert-churn: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
