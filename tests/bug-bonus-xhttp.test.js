// ─────────────────────────────────────────────────────────────────────────────
// v1.11.3 — issue #106: bonus vless:// with type=xhttp must keep its transport.
//
// Bug: bonusUrlToSingboxOutbound() translated only ws/grpc for vless/trojan/
// vmess. A `type=xhttp` (or `splithttp`) link produced an outbound with NO
// transport → sing-box/Karing treats it as plain TCP → the xhttp server rejects
// it and the bonus link silently fails. Unknown transports were also silently
// downgraded to TCP.
//
// Fix: a shared buildV2rayTransport() now emits ws/grpc/httpupgrade/http and
// xhttp (splithttp→xhttp), folding the `extra` JSON (incl. xmux) into the xhttp
// transport, and REFUSES (returns null outbound) on an unknown transport rather
// than silently downgrading to TCP.
//
// We do NOT boot the server (root side-effects). We extract the pure functions
// and run them in a vm sandbox with Buffer/URL/decodeURIComponent available.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  \u2713 ' + m); } else { fail++; console.log('  \u2717 ' + m); } };

const ROOT      = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(ROOT, 'panel', 'server', 'index.js'), 'utf8');

function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('function not found: ' + name);
  let p = src.indexOf('(', start);
  let pdepth = 0, j = p;
  for (; j < src.length; j++) {
    if (src[j] === '(') pdepth++;
    else if (src[j] === ')') { pdepth--; if (pdepth === 0) { j++; break; } }
  }
  let i = src.indexOf('{', j);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

const NAMES = ['parseXhttpExtra', 'buildV2rayTransport', 'bonusUrlToSingboxOutbound'];
const sandbox = { Buffer, URL, URLSearchParams, decodeURIComponent, JSON, String, console };
vm.createContext(sandbox);
for (const n of NAMES) vm.runInContext(extractFn(serverSrc, n) + '\n', sandbox);

const conv = (u) => vm.runInContext(`bonusUrlToSingboxOutbound(${JSON.stringify(u)}, 'b1')`, sandbox);

// ── [1] the bug: vless type=xhttp keeps an xhttp transport ────────────────────
console.log('\n[1] vless type=xhttp');
const xhttpUrl = 'vless://11111111-1111-1111-1111-111111111111@example.com:443?security=tls&sni=example.com&type=xhttp&mode=auto&path=%2Fapi&host=cdn.example.com#bonus';
const o1 = conv(xhttpUrl);
ok(o1 && o1.type === 'vless', 'vless xhttp still parses to a vless outbound');
ok(o1 && o1.transport && o1.transport.type === 'xhttp', 'transport.type === "xhttp" (was previously MISSING → TCP)');
ok(o1 && o1.transport && o1.transport.mode === 'auto', 'xhttp mode carried');
ok(o1 && o1.transport && o1.transport.path === '/api', 'xhttp path carried (URL-decoded)');
ok(o1 && o1.transport && o1.transport.host === 'cdn.example.com', 'xhttp host carried');
ok(o1 && o1.tls && o1.tls.enabled === true, 'tls preserved');

// ── [2] splithttp normalizes to xhttp ────────────────────────────────────────
console.log('\n[2] type=splithttp normalizes to xhttp');
const spl = conv('vless://11111111-1111-1111-1111-111111111111@h:443?security=tls&type=splithttp&path=/x#b');
ok(spl && spl.transport && spl.transport.type === 'xhttp', 'splithttp → xhttp');

// ── [3] extra JSON with xmux is folded in ────────────────────────────────────
console.log('\n[3] xhttp extra (JSON + base64url) with xmux');
const extraJson = encodeURIComponent(JSON.stringify({ xmux: { maxConcurrency: 8, maxConnections: 0 }, xPaddingBytes: '100-1000' }));
const oExtra = conv(`vless://u@h:443?security=tls&type=xhttp&extra=${extraJson}#b`);
ok(oExtra && oExtra.transport && oExtra.transport.xmux && oExtra.transport.xmux.maxConcurrency === 8, 'xmux folded from URL-encoded JSON extra');
ok(oExtra && oExtra.transport && oExtra.transport.xPaddingBytes === '100-1000', 'other extra knob preserved');
// base64url form
const b64 = Buffer.from(JSON.stringify({ xmux: { maxConcurrency: 4 } }), 'utf8').toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const oB64 = conv(`vless://u@h:443?security=tls&type=xhttp&extra=${b64}#b`);
ok(oB64 && oB64.transport && oB64.transport.xmux && oB64.transport.xmux.maxConcurrency === 4, 'xmux folded from base64url JSON extra');

// ── [4] ws / grpc still work (no regression) ─────────────────────────────────
console.log('\n[4] ws/grpc unchanged');
const ws = conv('vless://u@h:443?security=tls&type=ws&path=/vl&host=cdn.h#b');
ok(ws && ws.transport && ws.transport.type === 'ws' && ws.transport.path === '/vl' && ws.transport.headers.Host === 'cdn.h', 'ws transport unchanged');
const grpc = conv('vless://u@h:443?security=tls&type=grpc&serviceName=GunSvc#b');
ok(grpc && grpc.transport && grpc.transport.type === 'grpc' && grpc.transport.service_name === 'GunSvc', 'grpc transport unchanged');

// ── [5] plain tcp → NO transport key (byte-compat) ───────────────────────────
console.log('\n[5] tcp emits no transport key');
const tcp = conv('vless://u@h:443?security=tls&type=tcp#b');
ok(tcp && tcp.type === 'vless' && tcp.transport === undefined, 'tcp → no transport key (unchanged output)');
const noType = conv('vless://u@h:443?security=tls#b');
ok(noType && noType.transport === undefined, 'missing type → no transport key');

// ── [6] unknown transport is REFUSED, not downgraded to TCP ───────────────────
console.log('\n[6] unknown transport refused');
const unknown = conv('vless://u@h:443?security=tls&type=kcp#b');
ok(unknown === null, 'unknown transport (kcp) → null (NOT a silent TCP downgrade)');

// ── [7] trojan xhttp also works ──────────────────────────────────────────────
console.log('\n[7] trojan xhttp');
const trx = conv('trojan://pass@h:443?type=xhttp&mode=auto&path=/t&host=cdn.t#b');
ok(trx && trx.type === 'trojan' && trx.transport && trx.transport.type === 'xhttp' && trx.transport.path === '/t', 'trojan xhttp transport built');
const trUnknown = conv('trojan://pass@h:443?type=kcp#b');
ok(trUnknown === null, 'trojan unknown transport → null');

// ── [8] vmess net=xhttp works + unknown refused ──────────────────────────────
console.log('\n[8] vmess net=xhttp');
const vmXhttp = 'vmess://' + Buffer.from(JSON.stringify({ add:'h', port:443, id:'u', net:'xhttp', mode:'auto', path:'/v', host:'cdn.v', tls:'tls' }), 'utf8').toString('base64');
const ovm = conv(vmXhttp);
ok(ovm && ovm.type === 'vmess' && ovm.transport && ovm.transport.type === 'xhttp' && ovm.transport.path === '/v', 'vmess xhttp transport built');
const vmKcp = 'vmess://' + Buffer.from(JSON.stringify({ add:'h', port:443, id:'u', net:'kcp' }), 'utf8').toString('base64');
ok(conv(vmKcp) === null, 'vmess unknown net → null');
const vmWs = 'vmess://' + Buffer.from(JSON.stringify({ add:'h', port:443, id:'u', net:'ws', path:'/w', host:'cdn.w' }), 'utf8').toString('base64');
const ovmws = conv(vmWs);
ok(ovmws && ovmws.transport && ovmws.transport.type === 'ws' && ovmws.transport.path === '/w', 'vmess ws unchanged');

// ── [9] non-vless schemes unaffected (hy2/ss return their outbound) ──────────
console.log('\n[9] other schemes unaffected');
const hy2 = conv('hysteria2://pw@h:443?sni=h#b');
ok(hy2 && hy2.type === 'hysteria2', 'hysteria2 still parses');

console.log(`\n${fail === 0 ? '\u2705' : '\u274c'} bug-bonus-xhttp: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
