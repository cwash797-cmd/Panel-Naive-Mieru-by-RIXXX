// ─────────────────────────────────────────────────────────────────────────────
// v1.11.2 — update.sh must emit the subscription sub-domain block.
//
// Bug (subscriber report): update.sh's rebuild_caddyfile_direct() rebuilt the
// Caddyfile via caddyTemplate.render({...}) but FORGOT to pass `subBaseUrl`. So
// on a server with subBaseUrl configured in config.json, an update / --repair
// produced a Caddyfile WITHOUT the sub-domain block (handle /sub/* + handle
// /api/federation/*). The sub host then had no TLS cert and /sub returned a
// "TLS internal error" until the panel rebuilt at runtime. index.js's
// buildCaddyfile() passed subBaseUrl correctly — only update.sh was missing it,
// in BOTH the tpl.render() path and the inline fallback.
//
// This test (1) statically asserts update.sh now passes subBaseUrl in the
// tpl.render() call AND builds a subBlock in the inline fallback, and (2)
// functionally proves the shared template emits the sub host only when
// subBaseUrl is present (guards against a future omission).
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const fs   = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  \u2713 ' + m); } else { fail++; console.log('  \u2717 ' + m); } };

const ROOT      = path.join(__dirname, '..');
const updateSrc = fs.readFileSync(path.join(ROOT, 'update.sh'), 'utf8');
const tpl       = require(path.join(ROOT, 'panel', 'server', 'caddyTemplate.js'));

// Isolate the embedded node rebuild script (between the first quoted heredoc
// `cat > "$rebuild_js" <<'NODE_EOF'` and its closing NODE_EOF) so assertions are
// scoped to the rebuild logic, not unrelated heredocs later in the file.
const hStart = updateSrc.indexOf("cat > \"$rebuild_js\" <<'NODE_EOF'");
ok(hStart >= 0, "rebuild_caddyfile_direct heredoc found in update.sh");
const hEnd = updateSrc.indexOf('\nNODE_EOF', hStart);
const rebuild = updateSrc.slice(hStart, hEnd > 0 ? hEnd : undefined);

console.log('\n[1] update.sh passes subBaseUrl in the tpl.render() path');
ok(/tpl\.render\(\{[\s\S]*subBaseUrl:\s*cfg\.subBaseUrl\s*\|\|\s*''[\s\S]*\},\s*naiveUsers\)/.test(rebuild),
   'tpl.render({...}) includes subBaseUrl: cfg.subBaseUrl || \'\'');

console.log('\n[2] update.sh inline fallback builds a sub-block');
ok(/let\s+subBlock\s*=\s*''/.test(rebuild),
   'inline fallback declares a subBlock');
ok(/cfg\.subBaseUrl/.test(rebuild.slice(rebuild.indexOf('let subBlock'))),
   'inline fallback reads cfg.subBaseUrl');
ok(/handle \/api\/federation\/\*/.test(rebuild),
   'inline fallback sub-block exposes /api/federation/*');
ok(/handle \/sub\/\*/.test(rebuild),
   'inline fallback sub-block exposes /sub/*');
ok(/\]\.join\('\\n'\)\s*\+\s*panelBlock\s*\+\s*subBlock/.test(rebuild),
   'inline fallback appends subBlock to the rendered content');

console.log('\n[3] functional: shared template emits sub host iff subBaseUrl set');
const base = {
  adminEmail: 'a@b.com', domain: 'main.example.com', naivePort: 443,
  fakeSiteDir: '/var/www/fake', fakeSiteUrl: '', probeSecret: '', probeMode: 'bare',
  logFile: '/var/log/caddy-naive/access.log', upstream: '',
  exposePanel: false, panelDomain: '', panelBasicAuthUser: '', panelBasicAuthHash: '',
  webBasePath: '', panelStubPage: '/x', panelPort: 3000,
};
const users = [{ username: 'u1', password: 'p1' }];

const withSub = tpl.render({ ...base, subBaseUrl: 'sub.example.com' }, users);
ok(withSub.includes('sub.example.com {'),
   'render() WITH subBaseUrl emits the sub host block');
ok(withSub.includes('handle /api/federation/*') && withSub.includes('handle /sub/*'),
   'render() WITH subBaseUrl exposes /sub/* and /api/federation/*');

const noSub = tpl.render({ ...base, subBaseUrl: '' }, users);
ok(!noSub.includes('sub.example.com {'),
   'render() WITHOUT subBaseUrl emits NO sub host (single-server unaffected)');

// The main forward_proxy block must still be present either way (no regression).
ok(withSub.includes('forward_proxy') && noSub.includes('forward_proxy'),
   'main forward_proxy block always present (Naive unaffected)');

console.log(`\n${fail === 0 ? '\u2705' : '\u274c'} bug-update-sub-block: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
