// ─────────────────────────────────────────────────────────────────────────────
// v1.11.1 — Caddyfile SELF-HEAL regression test.
//
// Bug (found on a live node): POST /api/config only rebuilt the Caddyfile when
// subBaseUrl / fakeSiteUrl CHANGED (prev !== new). If config.json and the
// on-disk Caddyfile drifted out of sync (subBaseUrl present in config but the
// sub-domain block — incl. /api/federation/* — missing from the Caddyfile),
// re-saving the SAME value was a no-op and the stale Caddyfile could never
// self-correct. That left hub Deploy/Undeploy failing 0/N against a
// probe_resistance node, because the federation request fell through to the
// forward_proxy block.
//
// Fix: POST /api/config additionally renders the DESIRED Caddyfile and compares
// it byte-for-byte to what is on disk; on ANY drift it rewrites + reloads, in
// addition to the existing subChanged || fakeChanged guards.
//
// This test does NOT boot the server (root side-effects). It (1) verifies the
// self-heal decision LOGIC by modelling it exactly, including the critical
// "same value re-save must still heal a stale file" case, and (2) statically
// asserts the source actually wires the drift check into the rebuild guard so
// the guarantee can't silently regress.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const fs   = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  \u2713 ' + m); } else { fail++; console.log('  \u2717 ' + m); } };

const ROOT      = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(ROOT, 'panel', 'server', 'index.js'), 'utf8');

// ── [1] Model the exact rebuild decision from POST /api/config ───────────────
// rebuild happens when: subChanged || fakeChanged || driftHeal
// where driftHeal = (desiredCaddyfile !== onDiskCaddyfile).
function shouldRebuild({ prevSub, newSub, prevFake, newFake, desired, onDisk }) {
  const subChanged  = (newSub  || '') !== (prevSub  || '');
  const fakeChanged = (newFake || '') !== (prevFake || '');
  const driftHeal   = desired !== onDisk;
  return subChanged || fakeChanged || driftHeal;
}

console.log('\n[1] self-heal decision logic');

// The ORIGINAL bug: subBaseUrl unchanged, but Caddyfile stale → old code = NO
// rebuild. New code MUST rebuild because desired !== onDisk.
ok(shouldRebuild({
  prevSub: 'sub.example.com', newSub: 'sub.example.com',   // SAME value re-saved
  prevFake: '', newFake: '',
  desired: 'GOOD_CADDYFILE_WITH_SUB_BLOCK',
  onDisk:  'STALE_CADDYFILE_NO_SUB_BLOCK',                 // drifted
}), 're-saving the SAME subBaseUrl still rebuilds when the Caddyfile is stale (the bug)');

// Healthy single-server install: nothing changed AND file already correct →
// MUST NOT rebuild (idempotent, no needless reload / cert churn).
ok(!shouldRebuild({
  prevSub: '', newSub: '',
  prevFake: '', newFake: '',
  desired: 'IDENTICAL_CADDYFILE',
  onDisk:  'IDENTICAL_CADDYFILE',
}), 'healthy install with no changes and matching file does NOT rebuild (no-break guarantee)');

// Same, but a sub-domain IS configured and already correctly rendered → still
// no rebuild (we only heal true drift, not every save).
ok(!shouldRebuild({
  prevSub: 'sub.example.com', newSub: 'sub.example.com',
  prevFake: '', newFake: '',
  desired: 'GOOD_CADDYFILE_WITH_SUB_BLOCK',
  onDisk:  'GOOD_CADDYFILE_WITH_SUB_BLOCK',                // already in sync
}), 'configured-and-in-sync sub-domain re-save is a no-op (idempotent)');

// Normal change path still works: subBaseUrl actually changed.
ok(shouldRebuild({
  prevSub: '', newSub: 'sub.example.com',
  prevFake: '', newFake: '',
  desired: 'X', onDisk: 'X',                               // even if strings equal…
}), 'a real subBaseUrl change rebuilds via subChanged (unchanged behaviour)');

// fakeSiteUrl change path still works.
ok(shouldRebuild({
  prevSub: '', newSub: '',
  prevFake: '', newFake: 'https://real.site',
  desired: 'X', onDisk: 'X',
}), 'a real fakeSiteUrl change rebuilds via fakeChanged (unchanged behaviour)');

// probeMode drift (had NO change-guard before) now heals via drift check.
ok(shouldRebuild({
  prevSub: 'sub.example.com', newSub: 'sub.example.com',
  prevFake: '', newFake: '',
  desired: 'CADDYFILE_probe_resistance_secret',
  onDisk:  'CADDYFILE_probe_resistance_bare',              // probeMode drifted
}), 'probeMode/probeSecret drift (previously unguarded) now triggers a heal');

// ── [2] Static wiring assertions — the fix must stay wired in ────────────────
console.log('\n[2] source wiring (guards against silent regression)');

// Isolate the POST /api/config handler body for scoped assertions.
const cfgStart = serverSrc.indexOf("app.post('/api/config',");
ok(cfgStart >= 0, "POST /api/config handler present");
const cfgSlice = serverSrc.slice(cfgStart, cfgStart + 8000);

ok(/const\s+subChanged\s*=/.test(cfgSlice),
   'subChanged guard still present (back-compat)');
ok(/const\s+fakeChanged\s*=/.test(cfgSlice),
   'fakeChanged guard still present (back-compat)');
ok(/driftHeal/.test(cfgSlice),
   'driftHeal self-heal variable is wired into POST /api/config');
ok(/desiredCaddyfile\s*=\s*buildCaddyfile\(/.test(cfgSlice),
   'desired Caddyfile is rendered for the drift comparison');
ok(/readFileSync\(\s*resolvedCaddyFile/.test(cfgSlice),
   'on-disk Caddyfile is read for the drift comparison');
ok(/if\s*\(\s*subChanged\s*\|\|\s*fakeChanged\s*\|\|\s*driftHeal\s*\)/.test(cfgSlice),
   'rebuild guard is subChanged || fakeChanged || driftHeal');
ok(/writeCaddyfileAtomic\(\s*desiredCaddyfile\s*\|\|/.test(cfgSlice),
   'rebuild reuses the already-rendered desiredCaddyfile (no double build)');
ok(/\[HEAL\]/.test(cfgSlice),
   'self-heal path logs a distinct [HEAL] marker');

// The drift check must be best-effort (never block the save / crash the route).
ok(/drift check failed/i.test(cfgSlice),
   'drift check is wrapped best-effort (cannot break the config save)');

// ── summary ──────────────────────────────────────────────────────────────────
console.log(`\n${fail === 0 ? '\u2705' : '\u274c'} bug-caddyfile-selfheal: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
