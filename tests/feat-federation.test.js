// ─────────────────────────────────────────────────────────────────────────────
// v1.9.5 — FEATURE: Federation (multi-panel link, PR-3a: read + aggregation).
//
// One "hub" panel pulls configs from other "node" panels so a single /sub link
// delivers configs from several servers. Users are matched across servers by
// their EMAIL. Topology is hub→node, one-way pull.
//
//   • Node role: POST /api/federation/fetch — bearer token == cfg.federationToken,
//     POST-only, 404 on ANYTHING suspicious (feature off / no header / bad token),
//     constant-time compare, rate-limited. Returns { uris: [...] } for the user
//     matched by email (unknown email ⇒ 200 empty list).
//   • Hub role: cfg.federationNodes[] = { id,name,url,token,enabled }. /sub calls
//     each ENABLED node in parallel with a hard timeout; dead/erroring/wrong-token
//     nodes are SILENTLY skipped so a subscription never breaks.
//   • Secrets never leak: GET /api/config masks cfg.federationToken → boolean
//     federationTokenSet, and each node.token → boolean tokenSet. POST preserves
//     unchanged node tokens by id.
//
// Test strategy (suite convention): NO full server boot. We (1) run the REAL
// fetchFederatedUris() extracted from source in a vm sandbox against a live
// throwaway http node server, and (2) assert endpoint/UI/i18n contracts by
// source inspection.
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
const htmlSrc   = fs.readFileSync(path.join(ROOT, 'panel', 'public', 'index.html'), 'utf8');
const appSrc    = fs.readFileSync(path.join(ROOT, 'panel', 'public', 'app.js'), 'utf8');
const ru        = JSON.parse(fs.readFileSync(path.join(ROOT, 'panel', 'public', 'locales', 'ru.json'), 'utf8'));
const en        = JSON.parse(fs.readFileSync(path.join(ROOT, 'panel', 'public', 'locales', 'en.json'), 'utf8'));

// ── [1] config defaults ──────────────────────────────────────────────────────
console.log('\n[1] server: config defaults for federation roles');
ok(/federationToken:\s*''/.test(serverSrc),
   'federationToken defaults to empty string (node role off)');
ok(/federationNodes:\s*\[\]/.test(serverSrc),
   'federationNodes defaults to an empty list (hub role off)');

// ── [2] node-side token generate endpoint ────────────────────────────────────
console.log('\n[2] server: GET /api/federation/token/generate (auth-gated, random)');
ok(/app\.get\('\/api\/federation\/token\/generate', requireAuth,/.test(serverSrc),
   'generate endpoint is behind requireAuth');
ok(/federationToken:\s*crypto\.randomBytes\(32\)\.toString\('hex'\)/.test(serverSrc),
   'generates a 64-hex (32-byte) random token');

// ── [3] POST /api/config: accept + validate + normalize federation fields ─────
console.log('\n[3] server: POST /api/config federation handling');
ok(/'federationToken','federationNodes'/.test(serverSrc),
   'federationToken + federationNodes are in the accepted-keys list');
ok(/federationNodes must be an array/.test(serverSrc),
   'rejects a non-array federationNodes with 400');
ok(/each federation node needs a valid http\(s\):\/\/ url/.test(serverSrc),
   'rejects a node without a valid http(s) url with 400');
ok(/const prevFedNodes = Array\.isArray\(cfg\.federationNodes\)/.test(serverSrc),
   'captures previous nodes so tokens can be preserved by id');
ok(/if \(!token && prevById\.has\(id\)\) token = String\(prevById\.get\(id\)\.token/.test(serverSrc),
   'preserves an existing node token when the incoming token is blank');
ok(/enabled:\s*n\.enabled !== false/.test(serverSrc),
   'node enabled defaults to true (only explicit false disables)');

// ── [4] GET /api/config: mask federation secrets ─────────────────────────────
console.log('\n[4] server: GET /api/config never leaks federation secrets');
ok(/safe\.federationTokenSet = !!federationToken/.test(serverSrc),
   'node token replaced by boolean federationTokenSet');
ok(/delete safe\.federationToken/.test(serverSrc),
   'raw federationToken deleted from the safe payload');
ok(/return \{ \.\.\.meta, tokenSet: !!token \}/.test(serverSrc),
   'each node token replaced by boolean tokenSet');

// ── [5] POST /api/federation/fetch: security contract (source) ───────────────
console.log('\n[5] server: /api/federation/fetch security contract');
ok(/app\.post\('\/api\/federation\/fetch', fedLimiter,/.test(serverSrc),
   'endpoint is POST-only and rate-limited (fedLimiter)');
ok(/const fedLimiter = rateLimit\(\{ windowMs: 60 \* 1000, max: 120/.test(serverSrc),
   'fedLimiter caps requests per minute');
ok(/if \(!nodeToken\) return notFound\(\);/.test(serverSrc),
   'feature off (no node token) ⇒ 404, indistinguishable from missing route');
ok(/if \(!m\) return notFound\(\);/.test(serverSrc),
   'missing/malformed bearer header ⇒ 404 (never 401/403)');
ok(/if \(!safeTokenEqual\(presented, nodeToken\)\) return notFound\(\);/.test(serverSrc),
   'wrong token ⇒ 404 via constant-time compare');
ok(/crypto\.timingSafeEqual\(ha, hb\)/.test(serverSrc),
   'token compare is constant-time (timingSafeEqual over sha256 digests)');
ok(/const user = getUserByEmail\(email\);\s*\n\s*if \(!user\) return res\.json\(\{ uris: \[\] \}\);/.test(serverSrc),
   'unknown email ⇒ 200 with an empty list (not an error)');
ok(/for \(const url of enabledBonusUrls\(user\)\) uris\.push\(url\);/.test(serverSrc),
   'node returns standard URIs + the user\'s enabled bonus links');

// ── [6] /sub: async + aggregation, soft-skip ─────────────────────────────────
console.log('\n[6] server: /sub aggregates peer nodes without ever breaking');
ok(/app\.get\('\/sub\/:token', subLimiter, async \(req, res\)/.test(serverSrc),
   '/sub handler is async (needed for network pulls)');
ok(/const FED_FETCH_TIMEOUT_MS = \d+;/.test(serverSrc),
   'a hard per-node fetch timeout is defined');
ok(/if \(!email\) return \[\];/.test(serverSrc),
   'no email ⇒ no federation pull (empty)');
ok(/if \(!active\.length\) return \[\];/.test(serverSrc),
   'no enabled nodes ⇒ empty (byte-identical /sub to before)');
ok(/new AbortController\(\)/.test(serverSrc) && /ctrl\.abort\(\)/.test(serverSrc),
   'each peer fetch is abortable on timeout');
ok(/console\.warn\(`\[FED\] node "\$\{n\.name \|\| n\.url\}" skipped:`/.test(serverSrc),
   'a dead/slow peer is soft-skipped (logged, not thrown)');
ok(/const ob = bonusUrlToSingboxOutbound\(fedUris\[i\], `fed-\$\{i \+ 1\}`\)/.test(serverSrc),
   'sing-box path translates peer URIs into outbounds (fed-N tags)');
ok(/for \(const sel of selectors\) sel\.outbounds\.push\(ob\.tag\)/.test(serverSrc),
   'sing-box selector/urltest members are extended so refs resolve');

// ── [7] LIVE: fetchFederatedUris against a real throwaway node server ────────
console.log('\n[7] LIVE: hub fetchFederatedUris ↔ real node /api/federation/fetch');

// Re-derive the node's constant-time compare from source (identical body).
function safeTokenEqual(a, b) {
  try {
    const ha = crypto.createHash('sha256').update(String(a || ''), 'utf8').digest();
    const hb = crypto.createHash('sha256').update(String(b || ''), 'utf8').digest();
    return crypto.timingSafeEqual(ha, hb);
  } catch { return false; }
}
ok(/function safeTokenEqual\(a, b\) \{[\s\S]*?crypto\.timingSafeEqual\(ha, hb\)/.test(serverSrc),
   'source safeTokenEqual matches the reference used in this test');

const NODE_TOKEN = crypto.randomBytes(32).toString('hex');
const nodeUsers  = { 'ivan@example.com': ['naive-node-uri', 'mieru-node-uri'] };

// Throwaway node server mirroring the real endpoint's security semantics.
const nodeSrv = http.createServer((req, res) => {
  const notFound = () => { res.statusCode = 404; res.setHeader('Content-Type', 'text/plain'); res.end('Not found'); };
  if (req.method !== 'POST' || req.url !== '/api/federation/fetch') return notFound();
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    if (!NODE_TOKEN) return notFound();
    const m = String(req.headers['authorization'] || '').match(/^Bearer\s+(.+)$/i);
    if (!m) return notFound();
    if (!safeTokenEqual(m[1].trim(), NODE_TOKEN)) return notFound();
    let parsed = {}; try { parsed = JSON.parse(body || '{}'); } catch {}
    const email = String(parsed.email || '').trim();
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ uris: nodeUsers[email] || [] }));
  });
});

function extractFetchFederatedUris() {
  const t = serverSrc.match(/const FED_FETCH_TIMEOUT_MS = (\d+);/);
  const f = serverSrc.match(/async function fetchFederatedUris\(user, localUris = \[\], opts = \{\}\) \{[\s\S]*?\n\}/);
  if (!t || !f) return null;
  const sandbox = { cfg: {}, fetch, AbortController, setTimeout, clearTimeout, console,
                    Promise, Set, Array, String, JSON };
  vm.createContext(sandbox);
  vm.runInContext(`const FED_FETCH_TIMEOUT_MS = ${t[1]};\n${f[0]}\nthis.fetchFederatedUris = fetchFederatedUris;`, sandbox);
  return { fn: sandbox.fetchFederatedUris, sandbox };
}

function run() {
  return new Promise((resolve) => {
    nodeSrv.listen(0, '127.0.0.1', async () => {
      const nodeUrl = `http://127.0.0.1:${nodeSrv.address().port}`;
      const ex = extractFetchFederatedUris();
      ok(!!(ex && ex.fn), 'fetchFederatedUris extracted from source and runnable');
      if (!ex || !ex.fn) { nodeSrv.close(); return resolve(); }
      const { fn, sandbox } = ex;

      // A: enabled node + valid token + known email → peer configs merged
      sandbox.cfg.federationNodes = [{ id: 'n1', name: 'NL', url: nodeUrl, token: NODE_TOKEN, enabled: true }];
      let r = await fn({ email: 'ivan@example.com' }, [], {});
      ok(JSON.stringify(r) === JSON.stringify(['naive-node-uri', 'mieru-node-uri']),
         'A: known email pulls the node\'s URIs');

      // B: user with no email → no network, empty
      r = await fn({ email: '' }, [], {});
      ok(r.length === 0, 'B: user without email → no pull');

      // C: node disabled → empty
      sandbox.cfg.federationNodes = [{ id: 'n1', url: nodeUrl, token: NODE_TOKEN, enabled: false }];
      r = await fn({ email: 'ivan@example.com' }, [], {});
      ok(r.length === 0, 'C: disabled node contributes nothing');

      // D: unknown email → node 200 [] → empty
      sandbox.cfg.federationNodes = [{ id: 'n1', url: nodeUrl, token: NODE_TOKEN, enabled: true }];
      r = await fn({ email: 'nobody@example.com' }, [], {});
      ok(r.length === 0, 'D: unknown email → empty (not an error)');

      // E: wrong token → node 404 → soft-skip (subscription survives)
      sandbox.cfg.federationNodes = [{ id: 'n1', url: nodeUrl, token: 'wrong', enabled: true }];
      r = await fn({ email: 'ivan@example.com' }, [], {});
      ok(r.length === 0, 'E: wrong token → 404 → soft-skipped');

      // F: dead node (unreachable port) → soft-skip, never throws
      sandbox.cfg.federationNodes = [{ id: 'n1', url: 'http://127.0.0.1:1', token: NODE_TOKEN, enabled: true }];
      let threw = false;
      try { r = await fn({ email: 'ivan@example.com' }, [], {}); } catch { threw = true; }
      ok(!threw && r.length === 0, 'F: dead node → soft-skipped, no throw');

      // G: de-dup against local URIs
      sandbox.cfg.federationNodes = [{ id: 'n1', url: nodeUrl, token: NODE_TOKEN, enabled: true }];
      r = await fn({ email: 'ivan@example.com' }, ['naive-node-uri'], {});
      ok(JSON.stringify(r) === JSON.stringify(['mieru-node-uri']),
         'G: URIs already present locally are not duplicated');

      // H: node endpoint — missing auth → 404
      let resp = await fetch(`${nodeUrl}/api/federation/fetch`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      ok(resp.status === 404, 'H: node POST without bearer → 404');

      // I: node endpoint — wrong verb → 404
      resp = await fetch(`${nodeUrl}/api/federation/fetch`, { method: 'GET' });
      ok(resp.status === 404, 'I: node GET → 404 (POST-only)');

      nodeSrv.close();
      resolve();
    });
  });
}

// ── [8] UI: nav item + federation page + user email hint ─────────────────────
function staticChecks() {
  console.log('\n[8] UI: federation nav item + page + email hint');
  ok(/data-page="federation"/.test(htmlSrc),
     'left-nav has a dedicated Federation item (separate menu entry)');
  ok(/data-i18n="nav\.federation"/.test(htmlSrc),
     'nav item is i18n-bound (nav.federation)');
  ok(/<section id="page-federation" class="content-page">/.test(htmlSrc),
     'a #page-federation content section exists');
  ok(/id="s-federation-token"/.test(htmlSrc),
     'node-token input is present');
  ok(/data-action="gen-federation-token"/.test(htmlSrc) &&
     /data-action="copy-federation-token"/.test(htmlSrc) &&
     /data-action="save-federation-token"/.test(htmlSrc),
     'generate / copy / save node-token buttons are wired');
  ok(/id="federation-nodes-list"/.test(htmlSrc),
     'peer-node list container is present');
  ok(/data-action="add-federation-node"/.test(htmlSrc),
     'add-peer-node button is wired');
  ok(/data-i18n="users\.emailFedHint"/.test(htmlSrc),
     'the user form shows the federation email hint');

  console.log('\n[9] app.js: page + action wiring');
  ok(/case 'federation':\s*loadFederation\(\);/.test(appSrc),
     'navigateTo routes the federation page to loadFederation()');
  ok(/federation:\s*t\('nav\.federation'\)/.test(appSrc),
     'buildTitles includes a federation title');
  ok(/case 'gen-federation-token':\s*genFederationToken\(\);/.test(appSrc),
     'gen-federation-token action dispatched');
  ok(/case 'save-federation-token':\s*saveFederationToken\(\);/.test(appSrc),
     'save-federation-token action dispatched');
  ok(/case 'add-federation-node':\s*addFederationNode\(\);/.test(appSrc),
     'add-federation-node action dispatched');
  ok(/case 'toggle-federation-node':/.test(appSrc) && /case 'remove-federation-node':/.test(appSrc),
     'toggle + remove node actions dispatched');
  ok(/async function loadFederation\(\)/.test(appSrc),
     'loadFederation() defined');
  ok(/tokenEl\.value = '';/.test(appSrc),
     'node-token input starts blank (never pre-filled with a secret)');
  ok(/token:\s*''\s*\/\/ '' = keep/.test(appSrc) || /token:\s*''/.test(appSrc),
     'existing nodes are re-sent with a blank token (backend preserves it)');

  console.log('\n[10] i18n: ru + en parity for federation keys');
  ok(!!(ru.nav && ru.nav.federation) && !!(en.nav && en.nav.federation),
     'nav.federation present in both locales');
  ok(!!(ru.users && ru.users.emailFedHint) && !!(en.users && en.users.emailFedHint),
     'users.emailFedHint present in both locales');
  ok(!!ru.federation && !!en.federation,
     'a federation object exists in both locales');
  const reqKeys = ['title','intro','nodeTokenTitle','nodeTokenLabel','generate','copy',
                   'saveNodeToken','nodesTitle','addName','addUrl','addToken','addNode',
                   'remove','confirmRemove','enable','disable','noNodes'];
  const missRu = reqKeys.filter(k => !(ru.federation && ru.federation[k]));
  const missEn = reqKeys.filter(k => !(en.federation && en.federation[k]));
  ok(missRu.length === 0, 'ru.federation has all required keys' + (missRu.length ? ' (missing: ' + missRu.join(',') + ')' : ''));
  ok(missEn.length === 0, 'en.federation has all required keys' + (missEn.length ? ' (missing: ' + missEn.join(',') + ')' : ''));
  const ruK = Object.keys(ru.federation).sort();
  const enK = Object.keys(en.federation).sort();
  ok(JSON.stringify(ruK) === JSON.stringify(enK),
     'ru.federation and en.federation have identical key sets');
}

// ── run ──────────────────────────────────────────────────────────────────────
run().then(() => {
  staticChecks();
  console.log(`\nfeat-federation: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
});
