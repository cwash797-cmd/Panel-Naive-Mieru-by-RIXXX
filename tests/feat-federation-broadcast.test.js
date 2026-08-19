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
  const seg = serverSrc.slice(serverSrc.indexOf("app.post('/api/federation/provision'"),
                               serverSrc.indexOf("// v1.9.5: pull configs for THIS user"));
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
  const seg = serverSrc.slice(serverSrc.indexOf('async function broadcastProvision(user)'),
                               serverSrc.indexOf("app.get('/sub/:token'"));
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

// ── [2b] describeFetchError(): maps a bare "fetch failed" to a real reason ───
console.log('\n[2b] server: describeFetchError() classifies transport failures');
ok(/function describeFetchError\(err\)/.test(serverSrc),
   'describeFetchError(err) exists');
{
  const t = serverSrc.match(/const FED_FETCH_TIMEOUT_MS = (\d+);/);
  const f = serverSrc.match(/function describeFetchError\(err\) \{[\s\S]*?\n\}/);
  ok(!!(t && f), 'describeFetchError extracted from source');
  if (t && f) {
    const sandbox = { String, Object };
    vm.createContext(sandbox);
    vm.runInContext(`const FED_FETCH_TIMEOUT_MS = ${t[1]};\n${f[0]}\nthis.describeFetchError = describeFetchError;`, sandbox);
    const d = sandbox.describeFetchError;
    ok(/DNS/.test(d({ cause: { code: 'ENOTFOUND' } })), 'ENOTFOUND → DNS message');
    ok(/refused/.test(d({ cause: { code: 'ECONNREFUSED' } })), 'ECONNREFUSED → refused message');
    ok(/TLS/.test(d({ cause: { code: 'CERT_HAS_EXPIRED' } })), 'CERT_HAS_EXPIRED → TLS message');
    ok(/timed out/.test(d({ name: 'AbortError' })), 'AbortError → timed out message');
    ok(d({ message: 'fetch failed' }) !== 'fetch failed',
       'a bare "fetch failed" (no cause) is rephrased to something actionable');
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
// v1.10.2: connectivity self-test button + handler
ok(/data-action="test-federation-nodes"/.test(htmlSrc || ''),
   'federation page has a "Test connections" button');
ok(/case 'test-federation-nodes':\s*testFederationNodes\(/.test(appSrc),
   'dispatcher routes test-federation-nodes → testFederationNodes()');
ok(/async function testFederationNodes\(\)/.test(appSrc),
   'testFederationNodes() exists');
ok(/\/api\/federation\/nodes\/test/.test(appSrc),
   'testFederationNodes posts to the connectivity-test endpoint');

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
  // Detect a stray single-brace {var}: remove every {{...}} first, then any
  // remaining {word} is a bug (would never interpolate).
  const stripped = (f.deployConfirm + '\u0000' + f.deployOk + '\u0000' + f.deployPartial)
    .replace(/\{\{[a-z]+\}\}/g, '');
  ok(!/\{[a-z]+\}/.test(stripped),
     `${lang}: no leftover single-brace {var} placeholders in deploy strings`);
  // test-connection diagnostic keys
  ok(typeof f.testConns === 'string' && f.testConns.length > 0,
     `${lang}: federation.testConns label present`);
  ok(typeof f.testOk === 'string' && f.testOk.length > 0,
     `${lang}: federation.testOk label present`);
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
