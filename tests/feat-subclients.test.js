// ─────────────────────────────────────────────────────────────────────────────
// v1.9.2 — FEATURE: expand subscription client support beyond Karing/Shadowrocket.
//
// The sing-box-family clients — Karing, NekoBox (android), Exclave (android)
// and Throne — all consume the SAME sing-box JSON we already emit for Karing.
// This test validates the PURE helpers extracted from panel/server/index.js
// (no server boot, no DB), matching the rest of the suite:
//
//   • detectSubClient(req)              → routes UA + ?client= to the right format
//   • bonusUrlToSingboxOutbound(url,tag)→ turns an admin bonus URI into a
//                                         sing-box outbound (vless/vmess/trojan/
//                                         ss/hysteria2), or null when unparseable
//
// It also asserts the CONTRACT that the manually-added bonus link (e.g. vless)
// is delivered to sing-box clients too — the exact thing the base64 path did but
// the JSON path previously did NOT.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const fs   = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  \u2713 ' + m); } else { fail++; console.log('  \u2717 ' + m); } };

const SERVER = path.join(__dirname, '..', 'panel', 'server', 'index.js');
const src = fs.readFileSync(SERVER, 'utf8');

function extract(name) {
  const re = new RegExp('function ' + name + '\\s*\\([\\s\\S]*?\\n\\}', 'm');
  const m = src.match(re);
  ok(!!m, name + '() present in server source');
  // eslint-disable-next-line no-eval
  return m ? eval('(' + m[0].replace(new RegExp('^function ' + name), 'function') + ')') : null;
}

// detectSubClient() closes over the module-level SINGBOX_FAMILY_UA array; the
// eval-extracted function needs that binding in scope. We re-derive it from the
// source (rather than hardcode) so the test tracks any future edits to the list.
const _famMatch = src.match(/const SINGBOX_FAMILY_UA\s*=\s*(\[[^\]]*\]);/);
ok(!!_famMatch, 'SINGBOX_FAMILY_UA present in server source');
// eslint-disable-next-line no-eval
const SINGBOX_FAMILY_UA = _famMatch ? eval(_famMatch[1]) : [];

const detectSubClient          = extract('detectSubClient');
const bonusUrlToSingboxOutbound = extract('bonusUrlToSingboxOutbound');

// Helper to fake an Express-ish request.
const mkReq = (ua, query = {}) => ({ headers: { 'user-agent': ua || '' }, query });

// ── detectSubClient: UA auto-detection ───────────────────────────────────────
console.log('\n[1] detectSubClient — User-Agent auto-detection');
ok(detectSubClient(mkReq('Karing/1.0'))       === 'karing',       'Karing UA → karing (sing-box JSON)');
ok(detectSubClient(mkReq('sing-box 1.9'))      === 'karing',       'sing-box UA → karing');
ok(detectSubClient(mkReq('NekoBox/1.3.6'))     === 'karing',       'NekoBox UA → karing (sing-box JSON)');
ok(detectSubClient(mkReq('Exclave/2.0'))       === 'karing',       'Exclave UA → karing (sing-box JSON)');
ok(detectSubClient(mkReq('Throne/1.0 android')) === 'karing',      'Throne UA → karing (sing-box JSON)');
ok(detectSubClient(mkReq('Shadowrocket/2.2'))  === 'shadowrocket', 'Shadowrocket UA → base64 URI list');
ok(detectSubClient(mkReq('curl/8.0'))          === 'shadowrocket', 'unknown UA → safe default base64');
ok(detectSubClient(mkReq(''))                  === 'shadowrocket', 'empty UA → safe default base64');

// ── detectSubClient: ?client= manual force (for support/testing) ─────────────
console.log('\n[2] detectSubClient — ?client= manual force');
ok(detectSubClient(mkReq('curl', { client: 'nekobox' })) === 'karing',       '?client=nekobox forces sing-box JSON');
ok(detectSubClient(mkReq('curl', { client: 'exclave' })) === 'karing',       '?client=exclave forces sing-box JSON');
ok(detectSubClient(mkReq('curl', { client: 'throne'  })) === 'karing',       '?client=throne  forces sing-box JSON');
ok(detectSubClient(mkReq('curl', { client: 'karing'  })) === 'karing',       '?client=karing  forces sing-box JSON');
ok(detectSubClient(mkReq('curl', { client: 'sr'      })) === 'shadowrocket', '?client=sr forces base64');
ok(detectSubClient(mkReq('curl', { client: 'shadowrocket' })) === 'shadowrocket', '?client=shadowrocket forces base64');
ok(detectSubClient(mkReq('curl', { format: 'singbox' })) === 'karing',       '?format=singbox forces sing-box JSON');
// A force must WIN over a conflicting UA.
ok(detectSubClient(mkReq('Shadowrocket', { client: 'nekobox' })) === 'karing', 'force beats a conflicting Shadowrocket UA');

// ── bonusUrlToSingboxOutbound: parse the common schemes ──────────────────────
console.log('\n[3] bonusUrlToSingboxOutbound — scheme parsing');

const vless = bonusUrlToSingboxOutbound(
  'vless://11111111-2222-3333-4444-555555555555@vl.example.com:443?security=tls&sni=vl.example.com&type=ws&path=%2Fws&host=cdn.example.com&flow=xtls-rprx-vision#MyVLESS',
  'bonus-1');
ok(vless && vless.type === 'vless',                  'vless:// → type vless');
ok(vless && vless.server === 'vl.example.com',        'vless server parsed');
ok(vless && vless.server_port === 443,                'vless port parsed');
ok(vless && vless.uuid === '11111111-2222-3333-4444-555555555555', 'vless uuid parsed');
ok(vless && vless.tls && vless.tls.enabled === true,  'vless tls enabled');
ok(vless && vless.tls.server_name === 'vl.example.com','vless sni parsed');
ok(vless && vless.transport && vless.transport.type === 'ws', 'vless ws transport parsed');
ok(vless && vless.transport.path === '/ws',           'vless ws path decoded');
ok(vless && vless.flow === 'xtls-rprx-vision',        'vless flow parsed');
ok(vless && vless.tag === 'bonus-1',                  'vless tag honours the passed tag');

const trojan = bonusUrlToSingboxOutbound('trojan://p%40ss@tr.example.com:8443?sni=tr.example.com#T', 'bonus-2');
ok(trojan && trojan.type === 'trojan',                'trojan:// → type trojan');
ok(trojan && trojan.password === 'p@ss',              'trojan password percent-decoded');
ok(trojan && trojan.server_port === 8443,             'trojan port parsed');
ok(trojan && trojan.tls.server_name === 'tr.example.com', 'trojan sni parsed');

const hy2 = bonusUrlToSingboxOutbound('hysteria2://user%3Apass@hy.example.com:443?sni=hy.example.com&insecure=1#H', 'bonus-3');
ok(hy2 && hy2.type === 'hysteria2',                   'hysteria2:// → type hysteria2');
ok(hy2 && hy2.server === 'hy.example.com',            'hy2 server parsed');
ok(hy2 && hy2.password === 'user:pass',               'hy2 userpass password decoded');
ok(hy2 && hy2.tls.insecure === true,                  'hy2 insecure=1 honoured');

const hy2alias = bonusUrlToSingboxOutbound('hy2://pw@h.io:8443#x', 'bonus-4');
ok(hy2alias && hy2alias.type === 'hysteria2',         'hy2:// alias normalised to hysteria2');

// SIP002 ss:// with base64 userinfo
const ssUserinfo = Buffer.from('aes-256-gcm:sspass', 'utf8').toString('base64');
const ss = bonusUrlToSingboxOutbound('ss://' + ssUserinfo + '@ss.example.com:8388#S', 'bonus-5');
ok(ss && ss.type === 'shadowsocks',                   'ss:// → type shadowsocks');
ok(ss && ss.method === 'aes-256-gcm',                 'ss method decoded from base64 userinfo');
ok(ss && ss.password === 'sspass',                    'ss password decoded from base64 userinfo');

// vmess base64(json)
const vmessJson = Buffer.from(JSON.stringify({
  v: '2', ps: 'V', add: 'vm.example.com', port: '443', id: 'aaaa-bbbb',
  aid: '0', net: 'ws', path: '/vm', host: 'cdn.example.com', tls: 'tls', sni: 'vm.example.com'
}), 'utf8').toString('base64');
const vmess = bonusUrlToSingboxOutbound('vmess://' + vmessJson, 'bonus-6');
ok(vmess && vmess.type === 'vmess',                   'vmess:// → type vmess');
ok(vmess && vmess.server === 'vm.example.com',        'vmess server parsed');
ok(vmess && vmess.uuid === 'aaaa-bbbb',               'vmess uuid parsed');
ok(vmess && vmess.transport.type === 'ws',            'vmess ws transport parsed');
ok(vmess && vmess.tls && vmess.tls.enabled === true,  'vmess tls enabled');

// ── bonusUrlToSingboxOutbound: malformed / unknown → null (never throws) ─────
console.log('\n[4] bonusUrlToSingboxOutbound — malformed/unknown are skipped, not fatal');
ok(bonusUrlToSingboxOutbound('', 'x')                     === null, 'empty string → null');
ok(bonusUrlToSingboxOutbound('   ', 'x')                  === null, 'whitespace → null');
ok(bonusUrlToSingboxOutbound('https://example.com', 'x')  === null, 'plain http(s) URL → null (unknown scheme)');
ok(bonusUrlToSingboxOutbound('wireguard://nope', 'x')     === null, 'unsupported scheme → null');
ok(bonusUrlToSingboxOutbound('vless://@:0', 'x')          === null, 'vless with no host/uuid → null');
ok(bonusUrlToSingboxOutbound('vmess://not-base64-!!!', 'x') === null, 'vmess with bad base64 → null (no throw)');
let threw = false;
try { bonusUrlToSingboxOutbound('vless://', 'x'); } catch { threw = true; }
ok(!threw, 'a garbage bonus link never throws (soft-skip)');

// ── buildSingboxConfig: bonus links reach sing-box clients (source contract) ──
console.log('\n[5] source contract — bonus links flow into the sing-box JSON path');
ok(/const bonusUrls = enabledBonusUrls\(user\);/.test(src),
   'buildSingboxConfig iterates the user\'s enabled bonus links');
ok(/bonusUrlToSingboxOutbound\(bonusUrls\[i\]/.test(src),
   'each bonus link is converted via bonusUrlToSingboxOutbound()');
ok(/proxyOutbounds\.push\(ob\);\s*selectTags\.push\(ob\.tag\);/.test(src),
   'parsed bonus outbound is added to outbounds AND the urltest selector');
ok(/SINGBOX_FAMILY_UA\s*=\s*\[[^\]]*'nekobox'[^\]]*'exclave'[^\]]*'throne'/.test(src),
   'NekoBox/Exclave/Throne are registered in the sing-box UA family list');

console.log(`\nfeat-subclients: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
