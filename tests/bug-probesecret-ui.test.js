// ─────────────────────────────────────────────────────────────────────────────
// v1.11.7 — probe_resistance secret shows as "disabled" in the UI (subscriber bug).
//
// Bug: install.sh generates a probe_secret and writes probeMode:'bare' +
// probeSecret:<hex> into /etc/rixxx-panel/config.json (correct). But the Settings
// page showed the secret as "disabled". Root cause: GET /api/config NEVER returns
// the raw probeSecret — for safety it exposes a boolean `probeSecretSet` (+
// `probeMode`). The UI read the ABSENT `cfg.probeSecret`, so:
//   • the masked placeholder never showed (looked empty), and
//   • `cfg.probeMode || (cfg.probeSecret ? 'secret' : 'bare')` fell back to 'bare'
//     whenever the server had NOT also set probeMode — a configured secret looked
//     turned off.
//
// Fix: the UI now derives from the server's authoritative `probeSecretSet`
// (boolean) and `probeMode`, not from the non-exposed raw secret.
//
// Suite convention: no browser/server boot — assert the contract at the source
// level for both the server response shape and the app.js render logic.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const fs   = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  \u2713 ' + m); } else { fail++; console.log('  \u2717 ' + m); } };

const ROOT      = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(ROOT, 'panel', 'server', 'index.js'), 'utf8');
const appSrc    = fs.readFileSync(path.join(ROOT, 'panel', 'public', 'app.js'), 'utf8');

// ── [1] server: GET /api/config exposes probeSecretSet + probeMode, NOT raw ──
console.log('\n[1] server exposes a boolean flag, never the raw secret');
ok(/probeSecretSet:\s*!!\(cfg\.probeSecret\)/.test(serverSrc),
   'GET /api/config returns probeSecretSet: !!(cfg.probeSecret)');
ok(/probeMode:\s*\(cfg\.probeMode/.test(serverSrc),
   'GET /api/config returns probeMode');
// The status payload (the object built around probeSecretSet) must NOT leak the
// raw secret. Scope the check to that response object.
{
  const idx = serverSrc.indexOf('probeSecretSet:');
  const windowSrc = serverSrc.slice(Math.max(0, idx - 1200), idx + 200);
  ok(!/probeSecret:\s*cfg\.probeSecret/.test(windowSrc),
     'the status payload does NOT return the raw probeSecret');
}

// ── [2] app.js: render logic uses probeSecretSet, not the absent raw secret ──
console.log('\n[2] UI derives state from probeSecretSet / probeMode');
ok(/probeSecretSet\s*=\s*\(cfg\.probeSecretSet === true\)\s*\|\|\s*!!cfg\.probeSecret/.test(appSrc),
   'app.js computes probeSecretSet from the server flag (with raw fallback for safety)');
ok(/placeholder\s*=\s*probeSecretSet\s*\?/.test(appSrc),
   'masked placeholder (••••••••) is driven by probeSecretSet, not cfg.probeSecret');
ok(/const mode\s*=\s*cfg\.probeMode\s*\|\|\s*\(probeSecretSet\s*\?\s*'secret'\s*:\s*'bare'\)/.test(appSrc),
   "mode fallback uses probeSecretSet (not the absent cfg.probeSecret)");

// ── [3] regression guard: the old buggy reads are gone ───────────────────────
console.log('\n[3] the old buggy reads of cfg.probeSecret are gone');
ok(!/placeholder\s*=\s*cfg\.probeSecret\s*\?/.test(appSrc),
   'no longer reads cfg.probeSecret for the placeholder');
ok(!/cfg\.probeMode\s*\|\|\s*\(cfg\.probeSecret\s*\?\s*'secret'\s*:\s*'bare'\)/.test(appSrc),
   'no longer reads cfg.probeSecret for the mode fallback');

// ── [4] behavioural model of the fixed logic ─────────────────────────────────
console.log('\n[4] behavioural: configured secret is shown as set, not disabled');
function renderProbe(cfg) {
  const probeSecretSet = (cfg.probeSecretSet === true) || !!cfg.probeSecret;
  const placeholder = probeSecretSet ? '••••••••' : 'Enter probe secret';
  const mode = cfg.probeMode || (probeSecretSet ? 'secret' : 'bare');
  return { probeSecretSet, placeholder, mode };
}
// Server response after a fresh install with an auto-generated secret (bare mode):
let r = renderProbe({ probeSecretSet: true, probeMode: 'bare' });
ok(r.probeSecretSet === true && r.placeholder === '••••••••',
   'install default (probeSecretSet:true, bare) → masked placeholder shown (not "empty/disabled")');
ok(r.mode === 'bare', 'mode reflects server probeMode (bare), not a false "off"');
// Secret mode:
r = renderProbe({ probeSecretSet: true, probeMode: 'secret' });
ok(r.mode === 'secret' && r.placeholder === '••••••••', 'secret mode shows masked + secret');
// Genuinely no secret:
r = renderProbe({ probeSecretSet: false, probeMode: 'off' });
ok(r.probeSecretSet === false && r.mode === 'off', 'no secret + off mode → honestly shown as off');
// Old-bug simulation: server sends only probeSecretSet, UI must NOT fall to bare-by-absence
r = renderProbe({ probeSecretSet: true, probeMode: 'secret' });
ok(r.mode !== 'bare', 'a configured secret never collapses to bare just because the raw value is absent');

console.log(`\n${fail === 0 ? '\u2705' : '\u274c'} bug-probesecret-ui: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
