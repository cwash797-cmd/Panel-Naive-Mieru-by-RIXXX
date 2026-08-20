// ─────────────────────────────────────────────────────────────────────────────
// v1.10.0 — FEATURE: Federation broadcast provision (PR-3b: "довыпуск").
//
// Builds on PR-3a (read + aggregation). Adds a WRITE path so a hub can push
// (create-or-update, keyed by email) a user to EVERY enabled federation node
// with one click. Topology stays hub→node one-way; email stays the cross-server
// key. Nothing about the read path changes.
//
//   • Node role: POST /api/federation/provision — hardened IDENTICALLY to
//     /api/federation/fetch (feature off ⇒ 404, bearer + constant-time compare,
//     POST-only, rate-limited via fedLimiter). Upserts by email: existing user →
//     UPDATE protocols/quota/expiry (password + sub_token untouched); new user →
//     CREATE with a RANDOM local password + fresh sub_token. Returns
//     { ok, action:'created'|'updated', username, subLink }.
//   • Hub role: broadcastProvision(user) POSTs to each ENABLED node in PARALLEL
//     with a hard per-node timeout; a dead/old/wrong-token node becomes
//     { ok:false, error } and NEVER fails the whole broadcast. Returns a
//     per-node result summary.
//   • Admin route: POST /api/users/:id/federation/deploy (requireAuth) → 404 if
//     no such local user, 400 if the user has no email / no enabled nodes, else
//     200 with { ok, email, results:[...] }.
//
// Test strategy (suite convention): NO full server boot. We (1) run the REAL
// broadcastProvision() extracted from source in a vm sandbox against live
// throwaway http node servers, and (2) assert endpoint/route/UI/i18n contracts
// by source inspection.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const fs     = require('fs');
const path   = require('path');
const http   = require('http');
const crypto = require('crypto');
const vm     = require('vm');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  \u2713 ' + m); } else { fail++; console.log('  \u2717 ' + m); } };

const ROOT      = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(ROOT, 'panel', 'server', 'index.js'), 'utf8');
const appSrc    = fs.readFileSync(path.join(ROOT, 'panel', 'public', 'app.js'), 'utf8');
const htmlSrc   = fs.readFileSync(path.join(ROOT, 'panel', 'public', 'index.html'), 'utf8');
const ru        = JSON.parse(fs.readFileSync(path.join(ROOT, 'panel', 'public', 'locales', 'ru.json'), 'utf8'));
const en        = JSON.parse(fs.readFileSync(path.join(ROOT, 'panel', 'public', 'locales', 'en.json'), 'utf8'));

const NODE_TOKEN = 'test-node-token-' + crypto.randomBytes(8).toString('hex');

// Same constant-time compare the server uses (mirror so the throwaway node can
// authenticate exactly like the real endpoint).
function safeTokenEqual(a, b) {
  try {
    const ha = crypto.createHash('sha256').update(String(a || ''), 'utf8').digest();
    const hb = crypto.createHash('sha256').update(String(b || ''), 'utf8').digest();
    return crypto.timingSafeEqual(ha, hb);
  } catch { return false; }
}

// ── [1] node endpoint: security contract (source) ────────────────────────────
console.log('\n[1] server: /api/federation/provision security contract');
ok(/app\.post\('\/api\/federation\/provision', fedLimiter,/.test(serverSrc),
   'endpoint is POST-only and rate-limited (fedLimiter, reused from /fetch)');
{
  // Isolate the provision handler body for the hardening asserts below.
  // v1.11.0: deprovision now sits between provision and the pull-configs comment,
  // so anchor the slice end on the deprovision header (was the pull comment).
  const seg = serverSrc.slice(serverSrc.indexOf("app.post('/api/federation/provision'"),
                               serverSrc.indexOf("// ── v1.11.0 (PR-3c): POST /api/federation/deprovision"));
  ok(/const nodeToken = String\(cfg\.federationToken \|\| ''\)\.trim\(\);\s*\n\s*if \(!nodeToken\) return notFound\(\);/.test(seg),
     'feature off (no node token) ⇒ 404, indistinguishable from missing route');
  ok(/if \(!m\) return notFound\(\);/.test(seg),
     'missing/malformed bearer header ⇒ 404 (never 401/403)');
  ok(/if \(!safeTokenEqual\(m\[1\]\.trim\(\), nodeToken\)\) return notFound\(\);/.test(seg),
     'wrong token ⇒ 404 via constant-time compare');
  ok(/if \(!email \|\| !EMAIL_RE\.test\(email\)\)/.test(seg),
     'missing/invalid email ⇒ 400 (email is the cross-server key)');
  ok(/const existing = getUserByEmail\(email\);/.test(seg),
     'upsert is keyed by email (getUserByEmail)');
  ok(/action: 'updated'/.test(seg),
     'existing user → action:updated');
  ok(/crypto\.randomBytes\(24\)\.toString\('hex'\)/.test(seg),
     'new user gets a RANDOM local password per node (24-byte hex)');
  ok(/passHash:\s*bcrypt\.hashSync\(password, 12\)/.test(seg),
     'the random password is bcrypt-hashed (never stored plaintext-only)');
  ok(/let baseName = String\(\(req\.body && req\.body\.username\) \|\| ''\)\.trim\(\);/.test(seg),
     'the node prefers the SAME username the hub sent (not a random name)');
  ok(/baseName = email\.split\('@'\)\[0\]/.test(seg),
     'falls back to the email local-part only when the hub sent no usable username');
  ok(/for \(let i = 2; getUserByUsername\(username\); i\+\+\)/.test(seg),
     'username is de-collided ONLY on a genuine clash so a provision never 409s');
  ok(/subLink: token \? `\$\{subBaseUrl\(\)\}\/sub\/\$\{token\}`/.test(seg),
     'returns the ready-to-share sub link for this node');
  ok(/catch \(e\) \{[\s\S]*provision failed on node/.test(seg),
     'internal errors are caught → clean JSON 500 (never throws to the peer)');
  // The UPDATE branch must NOT touch password/sub_token (each node keeps its own).
  const updBranch = seg.slice(seg.indexOf('if (existing)'), seg.indexOf('// CREATE'));
  ok(!/passHash:/.test(updBranch) && !/password:/.test(updBranch),
     'update branch leaves the existing password untouched');
  ok(/const token = updated\.sub_token \|\| existing\.sub_token;/.test(seg),
     'update keeps the existing sub_token (link is stable across re-provisions)');
}

// ── [2] hub broadcastProvision(): source contract ────────────────────────────
console.log('\n[2] server: broadcastProvision() contract');
ok(/async function broadcastProvision\(user\)/.test(serverSrc),
   'broadcastProvision(user) exists');
{
  // v1.11.0: broadcastDeprovision now follows broadcastProvision, so anchor the
  // slice end on the deprovision header (was app.get('/sub/:token')).
  const seg = serverSrc.slice(serverSrc.indexOf('async function broadcastProvision(user)'),
                               serverSrc.indexOf('// ── v1.11.0 (PR-3c): broadcastDeprovision'));
  ok(/if \(!email\) return \{ email: null, results: \[\], skipped: 'no-email' \};/.test(seg),
     'no email ⇒ nothing to broadcast');
  ok(/const active = nodes\.filter\(n => n && n\.enabled !== false && n\.url && n\.token\);/.test(seg),
     'only enabled nodes with a url + token are targeted');
  ok(/Promise\.all\(active\.map/.test(seg),
     'nodes are POSTed in parallel');
  ok(/new AbortController\(\)/.test(seg) && /setTimeout\(\(\) => ctrl\.abort\(\), FED_FETCH_TIMEOUT_MS\)/.test(seg),
     'each node has a hard per-node timeout (AbortController)');
  ok(/\/api\/federation\/provision`/.test(seg),
     'posts to the node /api/federation/provision endpoint');
  ok(/'Authorization': `Bearer \$\{n\.token\}`/.test(seg),
     'authenticates with that node\u2019s bearer token');
  // The outbound payload object literal must not carry a password: key (the
  // node mints its own local one). We check the `const payload = { ... }` block.
  {
    const pl = seg.slice(seg.indexOf('const payload = {'), seg.indexOf('const results = await'));
    ok(!/\bpassword:/.test(pl),
       'the outbound payload has NO password: key (each node mints its own)');
  }
  ok(/catch \(e\) \{[\s\S]*ok: false/.test(seg),
     'a dead/erroring node becomes { ok:false } — never throws');
  ok(/const why = describeFetchError\(e\);/.test(seg),
     'v1.10.2: broadcast surfaces the REAL transport cause via describeFetchError');
  ok(/console\.warn\(`\[FED\] provision → node/.test(seg),
     'v1.10.2: each failing node is logged server-side (journalctl) with the cause');
}

// ── [2d] node endpoint: /api/federation/deprovision security contract ────────
// v1.11.0 (PR-3c): the DELETE counterpart of /provision. Hardened identically.
console.log('\n[2d] server: /api/federation/deprovision security contract');
ok(/app\.post\('\/api\/federation\/deprovision', fedLimiter,/.test(serverSrc),
   'deprovision endpoint is POST-only and rate-limited (fedLimiter)');
{
  const seg = serverSrc.slice(serverSrc.indexOf("app.post('/api/federation/deprovision'"),
                               serverSrc.indexOf("// v1.9.5: pull configs for THIS user"));
  ok(/const nodeToken = String\(cfg\.federationToken \|\| ''\)\.trim\(\);\s*\n\s*if \(!nodeToken\) return notFound\(\);/.test(seg),
     'feature off (no node token) ⇒ 404 (single-server installs never delete)');
  ok(/if \(!m\) return notFound\(\);/.test(seg),
     'missing/malformed bearer ⇒ 404 (never 401/403)');
  ok(/if \(!safeTokenEqual\(m\[1\]\.trim\(\), nodeToken\)\) return notFound\(\);/.test(seg),
     'wrong token ⇒ 404 via constant-time compare');
  ok(/if \(!email \|\| !EMAIL_RE\.test\(email\)\)/.test(seg),
     'missing/invalid email ⇒ 400 (email is the cross-server key)');
  ok(/const existing = getUserByEmail\(email\);/.test(seg),
     'delete is keyed by email (getUserByEmail)');
  ok(/if \(!existing\) \{[\s\S]*?action: 'absent'/.test(seg),
     'unknown email ⇒ idempotent no-op success { action:\'absent\' }');
  ok(/deleteUser\(existing\.id\);/.test(seg),
     'existing user ⇒ deletes ONLY that row (by id resolved from the email)');
  ok(/action: 'deleted'/.test(seg),
     'existing user ⇒ action:deleted');
  ok(/applyAllConfigsAsync\(\);/.test(seg),
     'a successful delete rebuilds the node proxy configs');
  ok(/catch \(e\) \{[\s\S]*deprovision failed on node/.test(seg),
     'internal errors are caught → clean JSON 500 (never throws to the peer)');
}

// ── [2e] hub broadcastDeprovision(): source contract ─────────────────────────
console.log('\n[2e] server: broadcastDeprovision() contract');
ok(/async function broadcastDeprovision\(email\)/.test(serverSrc),
   'broadcastDeprovision(email) exists');
{
  const seg = serverSrc.slice(serverSrc.indexOf('async function broadcastDeprovision(email)'),
                               serverSrc.indexOf("app.get('/sub/:token'"));
  ok(/if \(!key\) return \{ email: null, results: \[\], skipped: 'no-email' \};/.test(seg),
     'no email ⇒ nothing to broadcast');
  ok(/const active = nodes\.filter\(n => n && n\.enabled !== false && n\.url && n\.token\);/.test(seg),
     'only enabled nodes with a url + token are targeted');
  ok(/Promise\.all\(active\.map/.test(seg),
     'nodes are POSTed in parallel');
  ok(/new AbortController\(\)/.test(seg) && /setTimeout\(\(\) => ctrl\.abort\(\), FED_FETCH_TIMEOUT_MS\)/.test(seg),
     'each node has a hard per-node timeout (AbortController)');
  ok(/\/api\/federation\/deprovision`/.test(seg),
     'posts to the node /api/federation/deprovision endpoint');
  ok(/'Authorization': `Bearer \$\{n\.token\}`/.test(seg),
     'authenticates with that node\u2019s bearer token');
  ok(/JSON\.stringify\(\{ email: key \}\)/.test(seg),
     'the only payload is the email key (no other user data leaks on revoke)');
  ok(/const why = describeFetchError\(e\);/.test(seg),
     'a dead/erroring node surfaces the real cause and never throws');
  ok(/console\.warn\(`\[FED\] deprovision → node/.test(seg),
     'each failing node is logged server-side (journalctl) with the cause');
}

// ── [2f] admin route: POST /api/users/:id/federation/undeploy ────────────────
console.log('\n[2f] server: POST /api/users/:id/federation/undeploy (auth-gated)');
ok(/app\.post\('\/api\/users\/:id\/federation\/undeploy', requireAuth,/.test(serverSrc),
   'undeploy route is behind requireAuth');
{
  const seg = serverSrc.slice(serverSrc.indexOf("app.post('/api/users/:id/federation/undeploy'"),
                               serverSrc.indexOf('// ── v1.9.0: personal bonus links'));
  ok(/const bodyEmail = \(req\.body && req\.body\.email && String\(req\.body\.email\)\.trim\(\)\) \|\| '';/.test(seg),
     'accepts an explicit email fallback (revoke a locally-deleted user)');
  ok(/if \(!user && !bodyEmail\)\s*\n\s*return res\.status\(404\)/.test(seg),
     'unknown local user AND no fallback email ⇒ 404');
  ok(/if \(!email\)\s*\n\s*return res\.status\(400\)/.test(seg),
     'no usable email ⇒ 400 (email is the only cross-server key)');
  ok(/if \(!active\.length\)\s*\n\s*return res\.status\(400\)/.test(seg),
     'no enabled federation nodes ⇒ 400');
  ok(/await broadcastDeprovision\(email\)/.test(seg),
     'delegates to broadcastDeprovision(email)');
  ok(/return res\.json\(\{ ok: true, email, results \}\);/.test(seg),
     '200 with a per-node results summary');
}

// ── [2g] SAFETY: local DELETE /api/users/:id is UNCHANGED (no auto-cascade) ───
// The mandate is "nothing breaks for single-server installs". Deleting a user
// locally must NOT silently reach out to the mesh — revocation is an explicit,
// separate action. Assert the local delete route does not call the broadcast.
console.log('\n[2g] server: local DELETE /api/users/:id does NOT auto-broadcast');
{
  const seg = serverSrc.slice(serverSrc.indexOf("app.delete('/api/users/:id', requireAuth"),
                               serverSrc.indexOf("app.delete('/api/users/:id', requireAuth") + 400);
  ok(!/broadcastDeprovision/.test(seg),
     'local delete never calls broadcastDeprovision (no surprise cascade)');
}

// ── [2b] describeFetchError(): maps a bare "fetch failed" to a real reason ───
console.log('\n[2b] server: describeFetchError() classifies transport failures');
ok(/function describeFetchError\(err\)/.test(serverSrc),
   'describeFetchError(err) exists');
{
  const t  = serverSrc.match(/const FED_FETCH_TIMEOUT_MS = (\d+);/);
  const pr = serverSrc.match(/const PROBE_RESISTANCE_CODES = new Set\(\[[\s\S]*?\]\);/);
  const f  = serverSrc.match(/function describeFetchError\(err\) \{[\s\S]*?\n\}/);
  const ip = serverSrc.match(/function isProbeResistance\(err\) \{[\s\S]*?\n\}/);
  ok(!!(t && f), 'describeFetchError extracted from source');
  ok(!!pr, 'v1.10.3: PROBE_RESISTANCE_CODES set exists');
  ok(!!ip, 'v1.10.3: isProbeResistance() helper exists');
  if (t && f && pr && ip) {
    const sandbox = { String, Object, Set };
    vm.createContext(sandbox);
    vm.runInContext(
      `const FED_FETCH_TIMEOUT_MS = ${t[1]};\n${pr[0]}\n${f[0]}\n${ip[0]}\n` +
      `this.describeFetchError = describeFetchError; this.isProbeResistance = isProbeResistance;`,
      sandbox);
    const d = sandbox.describeFetchError;
    const p = sandbox.isProbeResistance;
    ok(/DNS/.test(d({ cause: { code: 'ENOTFOUND' } })), 'ENOTFOUND → DNS message');
    ok(/refused/.test(d({ cause: { code: 'ECONNREFUSED' } })), 'ECONNREFUSED → refused message');
    ok(/TLS/.test(d({ cause: { code: 'CERT_HAS_EXPIRED' } })), 'CERT_HAS_EXPIRED → TLS message');
    ok(/timed out/.test(d({ name: 'AbortError' })), 'AbortError → timed out message');
    ok(d({ message: 'fetch failed' }) !== 'fetch failed',
       'a bare "fetch failed" (no cause) is rephrased to something actionable');
    // v1.10.3: a NaiveProxy node's probe_resistance aborts our plain TLS probe —
    // this must be recognized as "node up", NOT a transport failure.
    const tlsAlert = { cause: { code: 'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR' } };
    ok(/probe_resistance/i.test(d(tlsAlert)),
       'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR → probe_resistance (node reachable) message');
    ok(/reachable/i.test(d(tlsAlert)),
       'probe_resistance message reassures the node is reachable');
    ok(p(tlsAlert) === true,
       'isProbeResistance() is TRUE for the TLS internal_error alert');
    ok(p({ cause: { code: 'ENOTFOUND' } }) === false,
       'isProbeResistance() is FALSE for a real DNS failure');
    ok(p({ cause: { code: 'ECONNREFUSED' } }) === false,
       'isProbeResistance() is FALSE for a refused connection');
  }
}

// ── [2c] node connectivity self-test endpoint ────────────────────────────────
console.log('\n[2c] server: POST /api/federation/nodes/test (auth-gated, read-only)');
ok(/app\.post\('\/api\/federation\/nodes\/test', requireAuth,/.test(serverSrc),
   'connectivity-test route exists and is behind requireAuth');
{
  const segStart = serverSrc.indexOf("app.post('/api/federation/nodes/test'");
  const seg = serverSrc.slice(segStart, serverSrc.indexOf("// BUG-155: a valid bcrypt token", segStart));
  ok(/\/api\/federation\/fetch`/.test(seg),
     'probes the read-only /fetch endpoint (never mutates a node)');
  ok(/connectivity-probe@federation\.local/.test(seg),
     'uses a probe email that cannot match a real user');
  ok(/r\.status === 404/.test(seg) && /reached the node but got 404/.test(seg),
     '404 ⇒ classified as reachable-but-wrong-token / node-not-updated');
  ok(/reachable: false/.test(seg) && /describeFetchError\(e\)/.test(seg),
     'transport error ⇒ reachable:false with a human-readable cause');
  // v1.10.3: probe_resistance (NaiveProxy node aborting our plain TLS probe) is
  // NOT a failure — the node is up and the authenticated federation still works.
  ok(/isProbeResistance\(e\)/.test(seg),
     'v1.10.3: nodes/test detects probe_resistance instead of crying wolf');
  ok(/probeResistance: true/.test(seg) && /reachable: true/.test(seg),
     'v1.10.3: probe_resistance ⇒ reachable:true + probeResistance:true (non-alarming)');
}

// ── [3] admin route: POST /api/users/:id/federation/deploy ───────────────────
console.log('\n[3] server: POST /api/users/:id/federation/deploy (auth-gated)');
ok(/app\.post\('\/api\/users\/:id\/federation\/deploy', requireAuth,/.test(serverSrc),
   'route is behind requireAuth');
{
  const seg = serverSrc.slice(serverSrc.indexOf("app.post('/api/users/:id/federation/deploy'"),
                               serverSrc.indexOf("app.get('/sub/:token'") > 0
                                 ? serverSrc.length : serverSrc.length);
  ok(/if \(!user\) return res\.status\(404\)/.test(seg),
     'unknown local user ⇒ 404');
  ok(/if \(!email\)\s*\n\s*return res\.status\(400\)/.test(seg),
     'user without email ⇒ 400');
  ok(/if \(!active\.length\)\s*\n\s*return res\.status\(400\)/.test(seg),
     'no enabled nodes ⇒ 400');
  ok(/const \{ results \} = await broadcastProvision\(user\);/.test(seg),
     'delegates the actual push to broadcastProvision()');
  ok(/return res\.json\(\{ ok: true, email, results \}\);/.test(seg),
     'returns a per-node result summary');
}

// ── [3b] Caddy: /api/federation/* prefix exposed on the sub-domain block ─────
console.log('\n[3b] Caddy: sub-block exposes the /api/federation/* prefix (fetch + provision)');
{
  let caddyTemplate;
  try { caddyTemplate = require(path.join(ROOT, 'panel', 'server', 'caddyTemplate.js')); } catch (e) {}
  ok(!!caddyTemplate && typeof caddyTemplate.renderSubBlock === 'function',
     'caddyTemplate.renderSubBlock is available');
  if (caddyTemplate && caddyTemplate.renderSubBlock) {
    const block = caddyTemplate.renderSubBlock({ subBaseUrl: 'https://sub.example.com', adminEmail: 'a@b.c', panelPort: 3000 });
    ok(/handle \/api\/federation\/\* \{/.test(block),
       'canonical sub-block proxies the /api/federation/* prefix (so /provision is reachable)');
    ok(!/handle \/api\/federation\/fetch \{/.test(block),
       'canonical sub-block no longer pins /fetch alone');
  }
  ok(/handle \/api\/federation\/\* \{\\n\s*reverse_proxy 127\.0\.0\.1:\$\{panelPort\}/.test(serverSrc),
     'index.js inline sub-block also uses the /api/federation/* prefix');
}

// ── [4] UI + i18n contracts ──────────────────────────────────────────────────
console.log('\n[4] UI: deploy button + handler + i18n');
ok(/data-action="deploy-user"/.test(appSrc),
   'the users table renders a deploy-user action');
ok(/case 'deploy-user':\s*deployUser\(/.test(appSrc),
   'the click dispatcher routes deploy-user → deployUser()');
ok(/async function deployUser\(id, username\)/.test(appSrc),
   'deployUser(id, username) exists');
ok(/\/api\/users\/\$\{id\}\/federation\/deploy/.test(appSrc),
   'deployUser posts to the deploy endpoint');
ok(/const hasFedNodes = fedNodes\.some\(n => n && n\.enabled !== false && n\.url\);/.test(appSrc),
   'the deploy button is gated on having an enabled federation node');
ok(/const canDeploy\s*=\s*hasFedNodes && !!\(u\.email/.test(appSrc),
   'the deploy button also requires the user to have an email');
ok(/confirm\(t\('federation\.deployConfirm'/.test(appSrc),
   'deploy asks for confirmation (idempotent but explicit)');
ok(/b\.disabled = true;/.test(appSrc) && /b\.disabled = false;/.test(appSrc),
   'the button is disabled during the in-flight broadcast and re-enabled after');
// v1.11.0 (PR-3c): undeploy (revoke) button + handler
ok(/data-action="undeploy-user"/.test(appSrc),
   'the users table renders an undeploy-user action');
ok(/case 'undeploy-user':\s*undeployUser\(/.test(appSrc),
   'the click dispatcher routes undeploy-user → undeployUser()');
ok(/async function undeployUser\(id, username, email\)/.test(appSrc),
   'undeployUser(id, username, email) exists');
ok(/\/api\/users\/\$\{id\}\/federation\/undeploy/.test(appSrc),
   'undeployUser posts to the undeploy endpoint');
ok(/confirm\(t\('federation\.undeployConfirm'/.test(appSrc),
   'undeploy asks for explicit confirmation (it revokes access on peers)');
ok(/const undeployBtn = canDeploy/.test(appSrc),
   'undeploy button uses the SAME visibility gate as deploy (nodes + email)');
// v1.10.2: connectivity self-test button + handler
ok(/data-action="test-federation-nodes"/.test(htmlSrc || ''),
   'federation page has a "Test connections" button');
ok(/case 'test-federation-nodes':\s*testFederationNodes\(/.test(appSrc),
   'dispatcher routes test-federation-nodes → testFederationNodes()');
ok(/async function testFederationNodes\(\)/.test(appSrc),
   'testFederationNodes() exists');
ok(/\/api\/federation\/nodes\/test/.test(appSrc),
   'testFederationNodes posts to the connectivity-test endpoint');
// v1.10.3: the results renderer has a distinct (non-red) probe_resistance state.
ok(/probeResistance/.test(appSrc),
   'v1.10.3: testFederationNodes renders a distinct probe_resistance state');
ok(/federation\.testProbeResistance/.test(appSrc),
   'v1.10.3: probe_resistance state uses the testProbeResistance i18n label');

for (const [lang, dict] of [['ru', ru], ['en', en]]) {
  const f = dict.federation || {};
  ok(typeof f.deploy === 'string' && f.deploy.length > 0,
     `${lang}: federation.deploy label present`);
  // v1.10.2: t() interpolates DOUBLE braces {{var}} (matching the rest of the
  // locale, e.g. users.deleteConfirm). PR-3b shipped single {var} which never
  // interpolated → the toast literally read "{ok}/{total}". Assert the fix.
  ok(typeof f.deployConfirm === 'string' && /\{\{name\}\}/.test(f.deployConfirm),
     `${lang}: federation.deployConfirm interpolates {{name}} (double-brace)`);
  ok(typeof f.deployOk === 'string' && /\{\{ok\}\}/.test(f.deployOk) && /\{\{total\}\}/.test(f.deployOk),
     `${lang}: federation.deployOk interpolates {{ok}}/{{total}} (double-brace)`);
  ok(typeof f.deployPartial === 'string' && /\{\{ok\}\}/.test(f.deployPartial) && /\{\{total\}\}/.test(f.deployPartial),
     `${lang}: federation.deployPartial interpolates {{ok}}/{{total}} (double-brace)`);
  // v1.11.0 (PR-3c): undeploy (revoke) keys — same double-brace contract.
  ok(typeof f.undeploy === 'string' && f.undeploy.length > 0,
     `${lang}: federation.undeploy label present`);
  ok(typeof f.undeployConfirm === 'string' && /\{\{name\}\}/.test(f.undeployConfirm),
     `${lang}: federation.undeployConfirm interpolates {{name}} (double-brace)`);
  ok(typeof f.undeployOk === 'string' && /\{\{ok\}\}/.test(f.undeployOk) && /\{\{total\}\}/.test(f.undeployOk),
     `${lang}: federation.undeployOk interpolates {{ok}}/{{total}} (double-brace)`);
  ok(typeof f.undeployPartial === 'string' && /\{\{ok\}\}/.test(f.undeployPartial) && /\{\{total\}\}/.test(f.undeployPartial),
     `${lang}: federation.undeployPartial interpolates {{ok}}/{{total}} (double-brace)`);
  // Detect a stray single-brace {var}: remove every {{...}} first, then any
  // remaining {word} is a bug (would never interpolate).
  const stripped = ([f.deployConfirm, f.deployOk, f.deployPartial,
                     f.undeployConfirm, f.undeployOk, f.undeployPartial].join('\u0000'))
    .replace(/\{\{[a-z]+\}\}/g, '');
  ok(!/\{[a-z]+\}/.test(stripped),
     `${lang}: no leftover single-brace {var} placeholders in deploy/undeploy strings`);
  // test-connection diagnostic keys
  ok(typeof f.testConns === 'string' && f.testConns.length > 0,
     `${lang}: federation.testConns label present`);
  ok(typeof f.testOk === 'string' && f.testOk.length > 0,
     `${lang}: federation.testOk label present`);
  // v1.10.3: probe_resistance explanatory label (shown when a NaiveProxy node
  // rejects the plain TLS probe but is actually up).
  ok(typeof f.testProbeResistance === 'string' && f.testProbeResistance.length > 0,
     `${lang}: federation.testProbeResistance label present`);
  ok(/probe_resistance/i.test(f.testProbeResistance),
     `${lang}: testProbeResistance mentions probe_resistance`);
  ok(typeof f.deployNoNodes === 'string' && f.deployNoNodes.length > 0,
     `${lang}: federation.deployNoNodes present`);
  ok(typeof f.deployNoEmail === 'string' && f.deployNoEmail.length > 0,
     `${lang}: federation.deployNoEmail present`);
}

// ── [5] LIVE broadcastProvision() against throwaway node servers ─────────────
// A HEALTHY node that authenticates like the real endpoint and echoes an
// action based on a tiny in-memory "already has this email?" check.
const nodeSeenEmails = new Set(['known@example.com']);   // pretend this email exists
function makeProvisionNode() {
  return http.createServer((req, res) => {
    const notFound = () => { res.statusCode = 404; res.setHeader('Content-Type', 'text/plain'); res.end('Not found'); };
    if (req.method !== 'POST' || req.url !== '/api/federation/provision') return notFound();
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      if (!NODE_TOKEN) return notFound();
      const m = String(req.headers['authorization'] || '').match(/^Bearer\s+(.+)$/i);
      if (!m || !safeTokenEqual(m[1].trim(), NODE_TOKEN)) return notFound();
      let parsed = {}; try { parsed = JSON.parse(body || '{}'); } catch {}
      const email = String(parsed.email || '').trim();
      if (!email) { res.statusCode = 400; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: 'email required' })); return; }
      // The hub must NEVER send a password.
      const sentPassword = parsed.password !== undefined;
      const action = nodeSeenEmails.has(email) ? 'updated' : 'created';
      // v1.10.1: echo back the exact username the hub sent (the real node uses
      // it verbatim unless it clashes), so the hub-side test can assert that the
      // broadcast carries the SAME username as on the hub.
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, action, username: parsed.username || email.split('@')[0],
                               subLink: `https://sub.node.example.com/sub/deadbeef`, _sawPassword: sentPassword }));
    });
  });
}

function extractBroadcastProvision() {
  const t  = serverSrc.match(/const FED_FETCH_TIMEOUT_MS = (\d+);/);
  const f  = serverSrc.match(/async function broadcastProvision\(user\) \{[\s\S]*?\n\}/);
  // v1.10.2: broadcastProvision now calls describeFetchError() in its catch, so
  // the sandbox must include it too.
  const df = serverSrc.match(/function describeFetchError\(err\) \{[\s\S]*?\n\}/);
  if (!t || !f || !df) return null;
  const sandbox = { cfg: {}, fetch, AbortController, setTimeout, clearTimeout, console,
                    Promise, Set, Array, String, JSON, Object };
  vm.createContext(sandbox);
  vm.runInContext(`const FED_FETCH_TIMEOUT_MS = ${t[1]};\n${df[0]}\n${f[0]}\nthis.broadcastProvision = broadcastProvision;`, sandbox);
  return { fn: sandbox.broadcastProvision, sandbox };
}

// v1.11.0 (PR-3c): a throwaway node that authenticates like the real endpoint
// and reports 'deleted' for a known email, 'absent' otherwise (idempotent).
const nodeDelEmails = new Set(['known@example.com']);
function makeDeprovisionNode() {
  return http.createServer((req, res) => {
    const notFound = () => { res.statusCode = 404; res.setHeader('Content-Type', 'text/plain'); res.end('Not found'); };
    if (req.method !== 'POST' || req.url !== '/api/federation/deprovision') return notFound();
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      if (!NODE_TOKEN) return notFound();
      const m = String(req.headers['authorization'] || '').match(/^Bearer\s+(.+)$/i);
      if (!m || !safeTokenEqual(m[1].trim(), NODE_TOKEN)) return notFound();
      let parsed = {}; try { parsed = JSON.parse(body || '{}'); } catch {}
      const email = String(parsed.email || '').trim();
      if (!email) { res.statusCode = 400; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: 'email required' })); return; }
      const existed = nodeDelEmails.has(email);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, action: existed ? 'deleted' : 'absent',
                               username: existed ? email.split('@')[0] : null }));
    });
  });
}

function extractBroadcastDeprovision() {
  const t  = serverSrc.match(/const FED_FETCH_TIMEOUT_MS = (\d+);/);
  const f  = serverSrc.match(/async function broadcastDeprovision\(email\) \{[\s\S]*?\n\}/);
  const df = serverSrc.match(/function describeFetchError\(err\) \{[\s\S]*?\n\}/);
  if (!t || !f || !df) return null;
  const sandbox = { cfg: {}, fetch, AbortController, setTimeout, clearTimeout, console,
                    Promise, Set, Array, String, JSON, Object };
  vm.createContext(sandbox);
  vm.runInContext(`const FED_FETCH_TIMEOUT_MS = ${t[1]};\n${df[0]}\n${f[0]}\nthis.broadcastDeprovision = broadcastDeprovision;`, sandbox);
  return { fn: sandbox.broadcastDeprovision, sandbox };
}

function run() {
  return new Promise((resolve) => {
    const nodeSrv = makeProvisionNode();
    nodeSrv.listen(0, '127.0.0.1', async () => {
      const nodeUrl = `http://127.0.0.1:${nodeSrv.address().port}`;
      console.log('\n[5] live: broadcastProvision() against throwaway node servers');
      const ex = extractBroadcastProvision();
      ok(!!(ex && ex.fn), 'broadcastProvision extracted from source and runnable');
      if (!ex || !ex.fn) { nodeSrv.close(); return resolve(); }
      const { fn, sandbox } = ex;

      // A: no email ⇒ skipped, empty results, no throw.
      {
        sandbox.cfg.federationNodes = [{ id: 'n1', name: 'N1', url: nodeUrl, token: NODE_TOKEN, enabled: true }];
        const r = await fn({ email: '' });
        ok(Array.isArray(r.results) && r.results.length === 0 && r.skipped === 'no-email',
           'A: no email ⇒ skipped with empty results');
      }

      // B: no enabled nodes ⇒ empty results.
      {
        sandbox.cfg.federationNodes = [{ id: 'n1', name: 'N1', url: nodeUrl, token: NODE_TOKEN, enabled: false }];
        const r = await fn({ email: 'x@example.com' });
        ok(Array.isArray(r.results) && r.results.length === 0,
           'B: all nodes disabled ⇒ empty results');
      }

      // C: healthy node, NEW email ⇒ created.
      {
        sandbox.cfg.federationNodes = [{ id: 'n1', name: 'N1', url: nodeUrl, token: NODE_TOKEN, enabled: true }];
        const r = await fn({ email: 'new@example.com', username: 'newbie', protocols: ['naive'], quotaMB: 100 });
        ok(r.results.length === 1 && r.results[0].ok === true && r.results[0].action === 'created',
           'C: new email ⇒ node reports action:created, ok:true');
        ok(typeof r.results[0].subLink === 'string' && /\/sub\//.test(r.results[0].subLink),
           'C: per-node result carries the returned sub link');
        ok(r.results[0].username === 'newbie',
           'C: the node used the SAME username the hub sent (not a random one)');
      }

      // D: healthy node, KNOWN email ⇒ updated (idempotent re-deploy).
      {
        const r = await fn({ email: 'known@example.com', username: 'known' });
        ok(r.results.length === 1 && r.results[0].ok === true && r.results[0].action === 'updated',
           'D: known email ⇒ node reports action:updated (idempotent)');
      }

      // E: the hub sends NO password (verified by the node echo).
      {
        let sawPassword = null;
        const probe = http.createServer((req, res) => {
          let body = ''; req.on('data', c => body += c);
          req.on('end', () => {
            let p = {}; try { p = JSON.parse(body || '{}'); } catch {}
            sawPassword = p.password !== undefined;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true, action: 'created', username: 'x', subLink: 'https://s/sub/x' }));
          });
        });
        await new Promise(r2 => probe.listen(0, '127.0.0.1', r2));
        sandbox.cfg.federationNodes = [{ id: 'p', name: 'P', url: `http://127.0.0.1:${probe.address().port}`, token: NODE_TOKEN, enabled: true }];
        await fn({ email: 'nopw@example.com', username: 'nopw', password: 'should-not-be-sent' });
        ok(sawPassword === false, 'E: broadcast payload contains NO password field');
        probe.close();
      }

      // F: wrong token ⇒ node returns 404 ⇒ { ok:false }, whole broadcast still ok.
      {
        sandbox.cfg.federationNodes = [{ id: 'n1', name: 'N1', url: nodeUrl, token: 'WRONG-TOKEN', enabled: true }];
        let threw = false; let r;
        try { r = await fn({ email: 'a@example.com' }); } catch { threw = true; }
        ok(!threw && r.results.length === 1 && r.results[0].ok === false,
           'F: wrong token ⇒ per-node { ok:false }, broadcast never throws');
      }

      // G: dead peer ⇒ soft { ok:false } with an error, never throws.
      {
        sandbox.cfg.federationNodes = [{ id: 'dead', name: 'Dead', url: 'http://127.0.0.1:1', token: NODE_TOKEN, enabled: true }];
        let threw = false; let r;
        try { r = await fn({ email: 'a@example.com' }); } catch { threw = true; }
        ok(!threw && r.results.length === 1 && r.results[0].ok === false && typeof r.results[0].error === 'string',
           'G: dead peer ⇒ { ok:false, error }, no throw');
      }

      // H: mixed mesh (healthy + dead) ⇒ partial success, both reported.
      {
        sandbox.cfg.federationNodes = [
          { id: 'n1', name: 'Good', url: nodeUrl, token: NODE_TOKEN, enabled: true },
          { id: 'dead', name: 'Dead', url: 'http://127.0.0.1:1', token: NODE_TOKEN, enabled: true },
        ];
        const r = await fn({ email: 'mix@example.com', username: 'mix' });
        const good = r.results.find(x => x.name === 'Good');
        const dead = r.results.find(x => x.name === 'Dead');
        ok(r.results.length === 2 && good && good.ok === true && dead && dead.ok === false,
           'H: mixed mesh ⇒ good node ok, dead node failed, both surfaced');
      }

      // ── v1.11.0 (PR-3c): LIVE broadcastDeprovision() against a throwaway node ──
      const delSrv = makeDeprovisionNode();
      await new Promise(r2 => delSrv.listen(0, '127.0.0.1', r2));
      const delUrl = `http://127.0.0.1:${delSrv.address().port}`;
      const dex = extractBroadcastDeprovision();
      ok(!!(dex && dex.fn), 'broadcastDeprovision extracted from source and runnable');
      if (dex && dex.fn) {
        const { fn: dfn, sandbox: dsb } = dex;

        // I: no email ⇒ skipped, empty results, no throw.
        {
          dsb.cfg.federationNodes = [{ id: 'n1', name: 'N1', url: delUrl, token: NODE_TOKEN, enabled: true }];
          const r = await dfn('');
          ok(Array.isArray(r.results) && r.results.length === 0 && r.skipped === 'no-email',
             'I: no email ⇒ skipped with empty results');
        }

        // J: known email ⇒ node reports action:deleted, ok:true.
        {
          dsb.cfg.federationNodes = [{ id: 'n1', name: 'N1', url: delUrl, token: NODE_TOKEN, enabled: true }];
          const r = await dfn('known@example.com');
          ok(r.results.length === 1 && r.results[0].ok === true && r.results[0].action === 'deleted',
             'J: known email ⇒ node reports action:deleted, ok:true');
        }

        // K: unknown email ⇒ idempotent action:absent (still ok:true).
        {
          const r = await dfn('ghost@example.com');
          ok(r.results.length === 1 && r.results[0].ok === true && r.results[0].action === 'absent',
             'K: unknown email ⇒ idempotent action:absent (ok:true)');
        }

        // L: wrong token ⇒ node 404 ⇒ { ok:false }, broadcast never throws.
        {
          dsb.cfg.federationNodes = [{ id: 'n1', name: 'N1', url: delUrl, token: 'WRONG', enabled: true }];
          let threw = false; let r;
          try { r = await dfn('known@example.com'); } catch { threw = true; }
          ok(!threw && r.results.length === 1 && r.results[0].ok === false,
             'L: wrong token ⇒ per-node { ok:false }, never throws');
        }

        // M: dead peer ⇒ soft { ok:false } with an error, never throws.
        {
          dsb.cfg.federationNodes = [{ id: 'dead', name: 'Dead', url: 'http://127.0.0.1:1', token: NODE_TOKEN, enabled: true }];
          let threw = false; let r;
          try { r = await dfn('known@example.com'); } catch { threw = true; }
          ok(!threw && r.results.length === 1 && r.results[0].ok === false && typeof r.results[0].error === 'string',
             'M: dead peer ⇒ { ok:false, error }, no throw');
        }

        // N: mixed mesh (healthy + dead) ⇒ partial success, both reported.
        {
          dsb.cfg.federationNodes = [
            { id: 'n1', name: 'Good', url: delUrl, token: NODE_TOKEN, enabled: true },
            { id: 'dead', name: 'Dead', url: 'http://127.0.0.1:1', token: NODE_TOKEN, enabled: true },
          ];
          const r = await dfn('known@example.com');
          const good = r.results.find(x => x.name === 'Good');
          const dead = r.results.find(x => x.name === 'Dead');
          ok(r.results.length === 2 && good && good.ok === true && dead && dead.ok === false,
             'N: mixed mesh ⇒ good node revoked, dead node failed, both surfaced');
        }
      }
      delSrv.close();

      nodeSrv.close();
      resolve();
    });
  });
}

run().then(() => {
  console.log(`\n─────────────────────────────────────`);
  console.log(`feat-federation-broadcast: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
});
