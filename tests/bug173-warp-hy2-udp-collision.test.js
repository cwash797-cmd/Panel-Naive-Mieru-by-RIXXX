// ─────────────────────────────────────────────────────────────────────────────
// v1.8.8 — BUG-173 (CRITICAL): after the v1.8.0 "Hy2 WARP UDP return-path" change,
// enabling WARP became FLAKY — the panel hung 3-4 minutes and then reported
// `blocked_return` (rx≈92B, tx≫0, "provider blocks WARP"), yet a SECOND attempt
// minutes later succeeded. Reported by multiple users right after updating.
//
// ROOT CAUSE: v1.8.0 added a UDP twin of the BUG-171 TCP return-path rule, but
// UNSCOPED on OUTPUT:
//     iptables -t mangle -A OUTPUT -p udp -j CONNMARK --restore-mark
// Unlike the TCP twin, this is fatal: WireGuard's OWN encrypted envelope IS udp.
// WireGuard fwmarks its envelope with WG_FWMARK so the `not fwmark WG_FWMARK →
// WARP` rule keeps it on the native route to Cloudflare. But the unscoped OUTPUT
// restore fires on that envelope too: during a FRESH handshake, before
// POSTROUTING has saved WG_FWMARK onto the endpoint conntrack, the restore copies
// mark 0 onto the envelope, wiping WireGuard's fwmark → the envelope is mis-routed
// INTO the WARP table (loop) and the return path black-holes (rx≈92B). Warm
// conntrack on a later retry is consistent, so it "works the second time".
//
// THE FIX (BUG-173): scope BOTH the inbound set-mark and the OUTPUT restore to
// the Hy2 service port only (dport on the inbound leg, sport on the reply leg =
// HY2_PORT, injected by the panel via WARP_HY2_PORT, default 443). WireGuard's
// envelope (dst 2408/500/1701/4500, src ephemeral) never matches, so its fwmark
// is untouched → WARP is stable with or without Hy2, and with or without cascade.
// Teardown purges BOTH the new port-scoped shape and the old broad v1.8.0 shape.
//
// Also: the healthcheck now waits for a real `wg` handshake before probing, so
// the first (best) endpoint port 2408 is tested on a warm tunnel instead of
// racing — killing the "cycle through 4 ports for 3-4 minutes" false failure.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const fs   = require('fs');
const path = require('path');
const cp   = require('child_process');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  \u2713 ' + m); } else { fail++; console.log('  \u2717 ' + m); } };

const SCRIPT = path.join(__dirname, '..', 'panel', 'scripts', 'warp_egress.sh');
const src = fs.readFileSync(SCRIPT, 'utf8');

const SERVER = path.join(__dirname, '..', 'panel', 'server', 'index.js');
const serverSrc = fs.readFileSync(SERVER, 'utf8');

function fnBody(name) {
  const re = new RegExp('^' + name + '\\(\\) \\{[\\s\\S]*?\\n\\}', 'm');
  const m = src.match(re);
  return m ? m[0] : '';
}
const routeUp   = fnBody('route_up');
const routeDown = fnBody('route_down');
const health    = fnBody('warp_healthcheck');

console.log('\n[1] bash valid');
{
  const r = cp.spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
  ok(r.status === 0, 'bash -n warp_egress.sh passes (' + (r.stderr || 'clean') + ')');
}

console.log('\n[2] BUG-173: the UDP return-path rules are PORT-SCOPED (never all-udp)');
{
  ok(routeUp.length > 0, 'route_up() body located');
  // inbound leg: NEW udp to HY2_PORT from a non-warp iface → connmark
  ok(/-A PREROUTING ! -i "\$dev" -p udp --dport "\$HY2_PORT" -m conntrack --ctstate NEW -j CONNMARK --set-mark "\$MARK_CONN"/.test(routeUp),
     'route_up: inbound UDP mark is scoped to --dport HY2_PORT');
  // reply leg: restore only on udp FROM HY2_PORT (the Hy2 socket's replies)
  ok(/-A OUTPUT -p udp --sport "\$HY2_PORT" -j CONNMARK --restore-mark/.test(routeUp),
     'route_up: OUTPUT UDP restore is scoped to --sport HY2_PORT (not all udp)');
  // idempotent install (-C before -A)
  ok(/-C OUTPUT -p udp --sport "\$HY2_PORT" -j CONNMARK --restore-mark/.test(routeUp),
     'route_up: -C check before -A for the scoped OUTPUT restore (idempotent)');
}

console.log('\n[3] BUG-173: the fatal UNSCOPED all-udp OUTPUT restore is GONE');
{
  // This exact shape is what collided with WireGuard's own UDP envelope.
  ok(!/-A OUTPUT -p udp -j CONNMARK --restore-mark\b/.test(routeUp),
     'route_up: NO unscoped `-A OUTPUT -p udp -j CONNMARK --restore-mark` (the v1.8.0 collision)');
  ok(!/-A PREROUTING ! -i "\$dev" -p udp -m conntrack --ctstate NEW -j CONNMARK --set-mark "\$MARK_CONN"\s*$/m.test(routeUp),
     'route_up: NO unscoped inbound all-udp NEW mark either');
}

console.log('\n[4] BUG-173: WireGuard envelope handling is intact (still routes native)');
{
  // WG fwmarks its own envelope; the PREROUTING envelope restore + POSTROUTING
  // save must remain so the WARP return path keeps working.
  ok(/wg set "\$dev" fwmark "\$WG_FWMARK"/.test(routeUp),
     'route_up: WireGuard still fwmarks its own envelope (WG_FWMARK)');
  ok(/-A POSTROUTING -m mark --mark "\$WG_FWMARK" -p udp -j CONNMARK --save-mark/.test(routeUp),
     'route_up: envelope fwmark still saved onto the endpoint conntrack (POSTROUTING)');
  ok(/ip rule add prio "\$PRIO_DEFAULT" not fwmark "\$WG_FWMARK" lookup "\$RT_TABLE"/.test(routeUp),
     'route_up: default `not fwmark WG_FWMARK → WARP` rule intact');
}

console.log('\n[5] BUG-173: teardown removes BOTH the new scoped and old broad shapes');
{
  ok(routeDown.length > 0, 'route_down() body located');
  ok(/-D OUTPUT -p udp --sport "\$HY2_PORT" -j CONNMARK --restore-mark/.test(routeDown),
     'route_down: removes the new scoped OUTPUT UDP restore');
  ok(/-D PREROUTING ! -i "\$dev" -p udp --dport "\$HY2_PORT" -m conntrack --ctstate NEW -j CONNMARK --set-mark "\$MARK_CONN"/.test(routeDown),
     'route_down: removes the new scoped inbound UDP mark');
  ok(/-D OUTPUT -p udp -j CONNMARK --restore-mark/.test(routeDown),
     'route_down: PURGES the old broad all-udp OUTPUT restore (upgrade cleanliness)');
  ok(/-D PREROUTING ! -i "\$dev" -p udp -m conntrack --ctstate NEW -j CONNMARK --set-mark "\$MARK_CONN"/.test(routeDown),
     'route_down: purges the old broad inbound all-udp NEW mark (upgrade cleanliness)');
}

console.log('\n[6] BUG-173: HY2_PORT is configurable and the panel injects it');
{
  ok(/HY2_PORT="\$\{WARP_HY2_PORT:-443\}"/.test(src),
     'script: HY2_PORT defaults to 443, overridable via WARP_HY2_PORT');
  ok(/WARP_HY2_PORT:\s*String\(opts\.hy2Port\s*\|\|\s*cfg\.hy2Port\s*\|\|\s*443\)/.test(serverSrc),
     'server: runWarpEgress injects WARP_HY2_PORT from cfg.hy2Port');
}

console.log('\n[7] BUG-173: healthcheck waits for a real handshake before probing');
{
  ok(health.length > 0, 'warp_healthcheck() body located');
  ok(/wg show "\$dev" latest-handshakes/.test(health),
     'healthcheck: polls `wg latest-handshakes` before the egress probe (warm tunnel)');
  // the handshake wait loop must precede the curl egress probe
  const hsIdx  = health.indexOf('latest-handshakes');
  const curlIdx = health.indexOf('api.ipify.org');
  ok(hsIdx > 0 && curlIdx > hsIdx,
     'healthcheck: handshake wait comes BEFORE the curl egress probe');
}

console.log('\n[8] BUG-173 LIVE: scoped rules install idempotently and tear down clean');
{
  // Reuse the BUG-171 mock-kernel harness: a fake iptables that honours -C/-A/-D
  // in a text store, so we validate the REAL control flow (idempotency + exact
  // rule shapes + full teardown) without needing xt_CONNMARK in the sandbox.
  const isRoot = cp.spawnSync('sh', ['-c', '[ "$(id -u)" = 0 ]']).status === 0;
  if (!isRoot) {
    console.log('  \u26a0 skipped (needs root for dummy link + ip rule)');
  } else {
    const dir = fs.mkdtempSync('/tmp/b173mock-');
    const mock = path.join(dir, 'iptables');
    fs.writeFileSync(mock, [
      '#!/usr/bin/env bash',
      `STORE="${dir}/rules.txt"; touch "$STORE"`,
      'args=("$@"); table=""; op=""; rest=(); i=0',
      'while [ $i -lt ${#args[@]} ]; do a="${args[$i]}";',
      '  case "$a" in -t) i=$((i+1)); table="${args[$i]}";; -A|-C|-D) op="$a";; *) rest+=("$a");; esac; i=$((i+1)); done',
      'key="${table}|${rest[*]}"',
      'case "$op" in',
      '  -C) grep -qxF "$key" "$STORE" && exit 0 || exit 1 ;;',
      '  -A) grep -qxF "$key" "$STORE" || echo "$key" >> "$STORE"; exit 0 ;;',
      '  -D) grep -vxF "$key" "$STORE" > "$STORE.tmp" 2>/dev/null || true; mv "$STORE.tmp" "$STORE"; exit 0 ;;',
      '  *) exit 0 ;; esac',
    ].join('\n'));
    fs.chmodSync(mock, 0o755);

    const harness = [
      'set -o pipefail',
      `export PATH="${dir}:$PATH"`,
      'export PANEL_PORT="3000"; export SSH_PORT="22"; export WARP_HY2_PORT="443"',
      'log(){ :; }; err(){ :; }; detect_ssh_port(){ echo 22; }',
      'local_subnet(){ echo ""; }; default_gw(){ echo ""; }',
      `eval "$(sed '/^ACTION=/,$d' '${SCRIPT}')"`,
      'export WG_IFACE="warp173t"; export HY2_PORT="443"',
      `: > "${dir}/rules.txt"`,
      'for q in $(seq "$PRIO_EXCEPT_BASE" $((PRIO_EXCEPT_BASE+10))) "$PRIO_SUPPRESS" "$PRIO_DEFAULT"; do',
      '  r="$(ip rule show 2>/dev/null||true)"; n=0',
      '  while [[ $\'\\n\'"$r" == *$\'\\n\'"$q:"* ]]; do ip rule del prio "$q" 2>/dev/null||true; n=$((n+1)); [ $n -ge 30 ]&&break; r="$(ip rule show 2>/dev/null||true)"; done',
      'done',
      'ip link add warp173t type dummy 2>/dev/null||true; ip link set warp173t up 2>/dev/null||true',
      'route_up warp173t >/dev/null 2>&1; route_up warp173t >/dev/null 2>&1',  // twice → idempotency
      `SCOPED=$(grep -c "OUTPUT -p udp --sport 443 -j CONNMARK --restore-mark" "${dir}/rules.txt")`,
      `BROAD=$(grep -cE "OUTPUT -p udp -j CONNMARK --restore-mark$" "${dir}/rules.txt")`,
      `INMARK=$(grep -c "PREROUTING ! -i warp173t -p udp --dport 443 -m conntrack --ctstate NEW -j CONNMARK --set-mark 0x5152" "${dir}/rules.txt")`,
      'route_down >/dev/null 2>&1',
      `DOWN=$(wc -l < "${dir}/rules.txt")`,
      'ip link del warp173t 2>/dev/null||true',
      'echo "SCOPED=$SCOPED BROAD=$BROAD INMARK=$INMARK DOWN=$DOWN"',
    ].join('\n');
    const r = cp.spawnSync('bash', ['-c', harness], { encoding: 'utf8' });
    const m = (r.stdout || '').match(/SCOPED=(\d+) BROAD=(\d+) INMARK=(\d+) DOWN=(\d+)/);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
    ok(!!m, 'live mock-kernel run executed (' + (r.stdout || r.stderr || '').trim() + ')');
    if (m) {
      ok(m[1] === '1', 'scoped OUTPUT --sport 443 restore installed exactly once (idempotent)');
      ok(m[2] === '0', 'NO unscoped all-udp OUTPUT restore ever installed');
      ok(m[3] === '1', 'scoped inbound --dport 443 mark installed exactly once (idempotent)');
      ok(m[4] === '0', 'route_down removed ALL mangle rules (0 left)');
    }
  }
}

console.log('\nResult: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
