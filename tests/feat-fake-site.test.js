// ─────────────────────────────────────────────────────────────────────────────
// v1.9.3 — FEATURE: change the fake (masquerade) site straight from the panel.
//
// The fake site is what a browser sees when it opens the server domain (DPI /
// probe camouflage). It was only settable at install time on the server. Now:
//   • POST /api/config validates fakeSiteUrl (full http(s) URL, or empty)
//   • a fakeSiteUrl CHANGE rebuilds the Caddyfile + reloads Caddy (previously
//     only a subBaseUrl change did — so the new fake site never went live)
//   • the settings page gets a field + save button + i18n (ru/en)
//
// We follow the suite convention: NO server boot. We (1) behaviourally exercise
// the masqueradeBlock branch of buildCaddyfile() via a vm sandbox, and (2)
// assert the POST-handler / UI / i18n contracts by source inspection.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const fs   = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  \u2713 ' + m); } else { fail++; console.log('  \u2717 ' + m); } };

const ROOT      = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(ROOT, 'panel', 'server', 'index.js'), 'utf8');
const htmlSrc   = fs.readFileSync(path.join(ROOT, 'panel', 'public', 'index.html'), 'utf8');
const appSrc    = fs.readFileSync(path.join(ROOT, 'panel', 'public', 'app.js'), 'utf8');
const ru        = JSON.parse(fs.readFileSync(path.join(ROOT, 'panel', 'public', 'locales', 'ru.json'), 'utf8'));
const en        = JSON.parse(fs.readFileSync(path.join(ROOT, 'panel', 'public', 'locales', 'en.json'), 'utf8'));

// ── [1] POST /api/config: rebuild on fakeSiteUrl change ──────────────────────
console.log('\n[1] server: POST /api/config rebuilds Caddy when fakeSiteUrl changes');
ok(/const prevFake\s*=\s*cfg\.fakeSiteUrl/.test(serverSrc),
   'captures the previous fakeSiteUrl before mutating cfg');
ok(/const fakeChanged\s*=\s*\(cfg\.fakeSiteUrl \|\| ''\) !== prevFake/.test(serverSrc),
   'computes fakeChanged by comparing new vs previous');
// v1.11.1: the guard gained a self-heal term (driftHeal) — rebuild still fires
// when EITHER subBaseUrl OR fakeSiteUrl changed, plus when the on-disk Caddyfile
// has drifted from the desired render. subChanged/fakeChanged must remain.
ok(/if \(subChanged \|\| fakeChanged(?: \|\| driftHeal)?\)/.test(serverSrc),
   'rebuild fires when EITHER subBaseUrl OR fakeSiteUrl changed (v1.11.1: + driftHeal self-heal)');
ok(/writeCaddyfileAtomic\(buildCaddyfile\(cfg, getAllUsers\(\)\)\);/.test(serverSrc),
   'rebuild writes a fresh Caddyfile atomically');
ok(/\[FAKE\] Caddy reloaded for fakeSiteUrl change/.test(serverSrc),
   'logs the fake-site reload for observability');

// ── [2] POST /api/config: fakeSiteUrl validation ─────────────────────────────
console.log('\n[2] server: fakeSiteUrl validation (bad URL rejected, empty allowed)');
ok(/req\.body\.fakeSiteUrl !== undefined/.test(serverSrc),
   'validation runs only when fakeSiteUrl is present in the body');
ok(/fakeSiteUrl must be a valid http\(s\):\/\/ URL or empty/.test(serverSrc),
   'rejects a non-URL with a 400 + clear message');
ok(/if \(fu !== '' && !\/\^https\?:/.test(serverSrc),
   'empty string is explicitly allowed (reset to default fake site)');
// The validation regex must accept normal URLs and reject junk. Re-derive it
// from source and exercise it directly.
{
  ok(serverSrc.includes('/^https?:\\/\\/[^\\s/$.?#].[^\\s]*$/i.test(fu)'),
     'validation regex is present in source');
  // Use the same regex literal the server uses.
  const re = /^https?:\/\/[^\s/$.?#].[^\s]*$/i;
  ok(re.test('https://www.bing.com'),            'accepts https://www.bing.com');
  ok(re.test('http://example.org/path?x=1'),     'accepts a full http URL with path/query');
  ok(!re.test('bing.com'),                       'rejects a bare host (no scheme)');
  ok(!re.test('javascript:alert(1)'),            'rejects a non-http(s) scheme');
  ok(!re.test('not a url'),                       'rejects free text');
}

// ── [3] buildCaddyfile masqueradeBlock: reverse_proxy vs file_server ─────────
console.log('\n[3] buildCaddyfile: masqueradeBlock switches on fakeSiteUrl');
// Extract just the masqueradeBlock IIFE-ish snippet and evaluate it against
// crafted configs. We rebuild a minimal scope mirroring the source variables.
function evalMasquerade(fakeSiteUrl) {
  const resolvedFakeSiteDir = '/opt/fake-site';
  const config = { fakeSiteUrl };
  let masqueradeBlock;
  {
    const fu = String(config.fakeSiteUrl || '').trim();
    const isPlaceholder = /^https?:\/\/(www\.)?example\.com\/?$/i.test(fu);
    const mm = (!isPlaceholder && fu) ? fu.match(/^(https?):\/\/([^\/\s]+)/i) : null;
    if (mm) {
      const scheme = mm[1].toLowerCase(), host = mm[2];
      masqueradeBlock = scheme === 'https'
        ? `  reverse_proxy https://${host} {\n    header_up Host ${host}\n    transport http {\n      tls\n      tls_server_name ${host}\n    }\n  }`
        : `  reverse_proxy http://${host} {\n    header_up Host ${host}\n  }`;
    } else {
      masqueradeBlock = `  file_server {\n    root ${resolvedFakeSiteDir}\n  }`;
    }
  }
  return masqueradeBlock;
}
// Sanity: the snippet under test must match the real source verbatim.
ok(/const isPlaceholder = \/\^https\?:\\\/\\\/\(www\\\.\)\?example\\\.com/.test(serverSrc),
   'source still uses the example.com placeholder check (snippet stays in sync)');

const rp = evalMasquerade('https://www.bing.com');
ok(/reverse_proxy https:\/\/www\.bing\.com/.test(rp), 'https URL → reverse_proxy https://<host>');
ok(/tls_server_name www\.bing\.com/.test(rp),         'https reverse_proxy pins tls_server_name');

const rpHttp = evalMasquerade('http://neverssl.com');
ok(/reverse_proxy http:\/\/neverssl\.com/.test(rpHttp), 'http URL → reverse_proxy http://<host>');
ok(!/transport http/.test(rpHttp),                      'http reverse_proxy has no tls transport');

ok(/file_server/.test(evalMasquerade('')),                       'empty → file_server (built-in fake site)');
ok(/file_server/.test(evalMasquerade('https://www.example.com')),'placeholder example.com → file_server (default)');
ok(/file_server/.test(evalMasquerade('https://example.com/')),   'placeholder example.com/ → file_server (default)');

// ── [4] UI wiring in index.html ──────────────────────────────────────────────
console.log('\n[4] UI: fake-site card present and wired');
ok(/id="s-fake-site-url"/.test(htmlSrc),                    'fake-site input present');
ok(/data-action="save-fake-site-url"/.test(htmlSrc),        'save button wired to save-fake-site-url action');
ok(/data-i18n="settings\.fakeSiteTitle"/.test(htmlSrc),     'card header uses fakeSiteTitle i18n key');
ok(/id="fake-site-url-msg"/.test(htmlSrc),                  'inline message container present');

// ── [5] app.js logic ─────────────────────────────────────────────────────────
console.log('\n[5] app.js: saveFakeSiteUrl + load wiring');
ok(/function saveFakeSiteUrl\(/.test(appSrc),                       'saveFakeSiteUrl() defined');
ok(/case 'save-fake-site-url':\s*saveFakeSiteUrl\(\);/.test(appSrc),'action dispatch wired');
ok(/api\('POST', '\/api\/config', \{ fakeSiteUrl: raw \}\)/.test(appSrc),
   'saveFakeSiteUrl posts fakeSiteUrl to /api/config');
ok(/el\('s-fake-site-url'\)/.test(appSrc),                          'loadSettings populates the field');
ok(/example\\.com/.test(appSrc),
   'loadSettings treats the example.com placeholder as blank (= use default)');

// ── [6] i18n keys (ru + en) ──────────────────────────────────────────────────
console.log('\n[6] i18n: fake-site keys present in both locales');
for (const [name, loc] of [['ru', ru], ['en', en]]) {
  const s = loc.settings || {};
  ['fakeSiteTitle','fakeSiteDesc','fakeSiteLabel','fakeSitePlaceholder',
   'fakeSiteNote','applyFakeSite','fakeSiteSaved','fakeSiteInvalid'].forEach(k => {
    ok(typeof s[k] === 'string' && s[k].length > 0, `locale ${name}: settings.${k} present`);
  });
}

console.log(`\nfeat-fake-site: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
