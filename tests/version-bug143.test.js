#!/usr/bin/env node
/* ==============================================================================
 * tests/version-bug143.test.js — Regression test for BUG-143 (stale UI version)
 *
 * BUG-143 (recurring): after `update.sh` the header kept showing the OLD version
 * (e.g. v1.4.2 while 1.4.3 was installed) because the UI read the version from a
 * source that lagged behind (in-memory cfg / config.json not reloaded).
 *
 * Fix: a single source of truth read LIVE on each request. update.sh/install.sh
 * write the repo VERSION into /etc/rixxx-panel/version (`panel_version=X.Y.Z`)
 * AND config.json; the panel's readPanelVersion() reads them with precedence:
 *   1) /etc/rixxx-panel/version   2) bundled VERSION   3) config.json   4) fallback
 *
 * This test verifies the parse + precedence logic used by readPanelVersion()
 * (replicated here so it can run without booting the server), and that the
 * `panel_version=` file format written by the shell scripts is parsed correctly.
 *
 * Run: node tests/version-bug143.test.js   (exit 0 = pass)
 * ============================================================================ */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
function ok(c, m) { if (c) { console.log('  \u2713', m); pass++; } else { console.error('  \u2717', m); fail++; } }

// Replica of readPanelVersion() with injectable paths/cfg (logic must match
// panel/server/index.js exactly).
function makeReader(versionFile, bundledVersionPaths, cfg, fallback) {
  return function readPanelVersion() {
    try {
      const raw = fs.readFileSync(versionFile, 'utf8');
      const m = raw.match(/panel_version\s*=\s*([^\s#]+)/);
      const v = (m ? m[1] : raw.split('\n')[0]).trim();
      if (v) return v;
    } catch {}
    for (const p of bundledVersionPaths) {
      try { const v = fs.readFileSync(p, 'utf8').trim(); if (v) return v; } catch {}
    }
    if (cfg && cfg.version) return String(cfg.version).trim();
    return fallback;
  };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ver143-'));
const verFile = path.join(tmp, 'version');
// Keep this name distinct from `version` even on case-insensitive filesystems
// (e.g. the default macOS APFS setup), where `version` and `VERSION` alias.
const bundled = path.join(tmp, 'bundled-VERSION');

console.log('BUG-143 version single-source regression test');

console.log('\n[1] /etc/rixxx-panel/version (panel_version=X.Y.Z) wins');
fs.writeFileSync(verFile, 'panel_version=1.4.4\n');
fs.writeFileSync(bundled, '9.9.9\n');
let read = makeReader(verFile, [bundled], { version: '1.0.0' }, 'FB');
ok(read() === '1.4.4', `parsed panel_version=1.4.4 from version file (got ${read()})`);

console.log('\n[2] version file with comment + spacing parses cleanly');
fs.writeFileSync(verFile, '# written by update.sh\npanel_version = 1.4.5  # release\n');
read = makeReader(verFile, [bundled], { version: '1.0.0' }, 'FB');
ok(read() === '1.4.5', `parsed 1.4.5 ignoring comment/whitespace (got ${read()})`);

console.log('\n[3] missing version file -> falls back to bundled VERSION');
fs.unlinkSync(verFile);
fs.writeFileSync(bundled, '1.4.6\n');
read = makeReader(verFile, [bundled], { version: '1.0.0' }, 'FB');
ok(read() === '1.4.6', `fell back to bundled VERSION 1.4.6 (got ${read()})`);

console.log('\n[4] no files -> config.json version');
fs.unlinkSync(bundled);
read = makeReader(verFile, [bundled], { version: '1.4.7' }, 'FB');
ok(read() === '1.4.7', `fell back to config.json 1.4.7 (got ${read()})`);

console.log('\n[5] nothing available -> hard fallback');
read = makeReader(verFile, [bundled], {}, '1.4.4');
ok(read() === '1.4.4', `hard fallback used (got ${read()})`);

console.log('\n[6] the live read picks up a NEW version after a simulated update.sh');
// Simulate the panel running, then update.sh rewriting the version file.
fs.writeFileSync(verFile, 'panel_version=1.4.3\n');
read = makeReader(verFile, [bundled], { version: '1.4.2' }, 'FB');  // stale cfg.version=1.4.2
ok(read() === '1.4.3', 'before update: live read shows 1.4.3 (not stale cfg 1.4.2)');
fs.writeFileSync(verFile, 'panel_version=1.4.4\n');                 // update.sh runs
ok(read() === '1.4.4', 'after update: SAME reader now returns 1.4.4 with no restart');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
