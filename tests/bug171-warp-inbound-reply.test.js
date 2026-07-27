// ─────────────────────────────────────────────────────────────────────────────
// v1.5.7 — BUG-171 (CRITICAL): with WARP enabled, client Naive/Mieru sessions
// never establish — every inbound TCP sits in SYN-RECV, nothing loads. Proven on
// server 192187 (WARP egress healthy: curl --interface warp → 104.28.197.7):
//   ss -tunap → tcp SYN-RECV [client]:xxxxx → caddy-naive :443 / mita :2012
//
// ROOT CAUSE: the BUG-169 policy routing sends EVERYTHING except WireGuard's own
// envelope into the WARP table (`ip rule … not fwmark <WG> lookup 51820`).
// That includes the SYN-ACK replies our LOCAL listening sockets (caddy-naive:443,
// mita:2012/:443) send back to clients on ARBITRARY external IPs. Our old
// exceptions only covered SSH/panel by --dport and the local subnet/gateway — NOT
// replies to random client IPs. So the SYN-ACK went into Cloudflare instead of
// back to the client → handshake never completes → SYN-RECV forever.
//
// THE FIX (user's Path 1 — mark by CONNECTION ORIGIN, not port):
//   • PREROUTING ! -i warp -p tcp -m conntrack --ctstate NEW -j CONNMARK
//       --set-mark MARK_CONN      → tag every NEW inbound connection (a client/
//                                    SSH/panel hitting one of OUR sockets).
//   • OUTPUT -p tcp -j CONNMARK --restore-mark   (UNCONDITIONAL — no
//       `-m connmark --mark` match!)  → the reply (SYN-ACK …) carries the mark.
//   • ip rule fwmark MARK_CONN lookup main (already present, prio 9000)
//                                 → those replies route NATIVELY to the client.
//
// ⚠ v2 correction (the fix that ACTUALLY works): the OUTPUT restore must be
//   UNCONDITIONAL. The first attempt matched `-m connmark --mark MARK_CONN` on
//   the OUTPUT rule, but that matches the PACKET nfmark — which on a freshly
//   generated local SYN-ACK is still 0 (the restore is what copies the conntrack
//   mark onto it). So the rule never fired, the SYN-ACK stayed unmarked, and the
//   default `not fwmark → WARP` rule swallowed it → SYN-RECV persisted.
//   `CONNMARK --restore-mark` is a no-op when the conntrack carries no mark, so
//   restoring on every local TCP packet only marks inbound-connection replies.
//   Connections the proxies ORIGINATE outbound (egress) start at OUTPUT with no
//   inbound conntrack, get no mark, and fall through to the WARP table → the
//   proxy egress still shows the Cloudflare IP. SSH + panel are a strict subset
//   of "inbound connections" so they remain reachable.
//
// Teardown removes the new rules symmetrically (BUG-150 idempotency).
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const fs   = require('fs');
const path = require('path');
const cp   = require('child_process');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  \u2713 ' + m); } else { fail++; console.log('  \u2717 ' + m); } };

const SCRIPT = path.join(__dirname, '..', 'panel', 'scripts', 'warp_egress.sh');
const src = fs.readFileSync(SCRIPT, 'utf8');

function fnBody(name) {
  const re = new RegExp('^' + name + '\\(\\) \\{[\\s\\S]*?\\n\\}', 'm');
  const m = src.match(re);
  return m ? m[0] : '';
}
const routeUp   = fnBody('route_up');
const routeDown = fnBody('route_down');

console.log('\n[1] bash valid');
{
  const r = cp.spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
  ok(r.status === 0, 'bash -n warp_egress.sh passes (' + (r.stderr || 'clean') + ')');
}

console.log('\n[2] BUG-171: mark by CONNECTION ORIGIN, not by port');
{
  ok(routeUp.length > 0, 'route_up() body located');
  // NEW inbound connection from a non-WARP iface → connmark
  ok(/-A PREROUTING ! -i "\$dev" -p tcp -m conntrack --ctstate NEW -j CONNMARK --set-mark "\$MARK_CONN"/.test(routeUp),
     'route_up: marks every NEW inbound TCP conn (! -i warp) — covers ANY client IP');
  // restore on OUTPUT so the SYN-ACK carries the mark — UNCONDITIONAL (no
  // `-m connmark --mark` match, which would never fire on the unmarked SYN-ACK)
  ok(/-A OUTPUT -p tcp -j CONNMARK --restore-mark/.test(routeUp),
     'route_up: restores the mark UNCONDITIONALLY on OUTPUT (SYN-ACK carries it)');
  ok(!/-A OUTPUT -p tcp -m connmark --mark "\$MARK_CONN" -j CONNMARK --restore-mark/.test(routeUp),
     'route_up: OUTPUT restore has NO `-m connmark --mark` match (the v1 bug that never fired)');
  // the ip rule that sends marked replies to main
  ok(/ip rule add prio "\$p" fwmark "\$MARK_CONN" lookup main/.test(routeUp),
     'route_up: fwmark MARK_CONN → main (replies routed natively, not into WARP)');
  // idempotent install (-C before -A) for the new rules
  ok(/-C PREROUTING ! -i "\$dev" -p tcp -m conntrack --ctstate NEW -j CONNMARK --set-mark "\$MARK_CONN"/.test(routeUp),
     'route_up: -C check before -A for the inbound-mark rule (idempotent)');
}

console.log('\n[3] BUG-171: NOT scoped to ports any more (the old narrow bug)');
{
  // The fix must NOT rely on --dport SSH/panel for the data-plane reply path;
  // that was exactly what missed arbitrary client IPs.
  ok(!/-A INPUT -p tcp --dport "\$SSH_PORT" -j CONNMARK --set-mark/.test(routeUp),
     'route_up: no longer depends on a per-port --dport INPUT mark for replies');
  ok(/! -i "\$dev"/.test(routeUp),
     'route_up: inbound mark is interface-scoped (exempts decrypted WARP-return traffic)');
}

console.log('\n[4] BUG-171: proxy egress is still tunneled (only INBOUND replies are excepted)');
{
  // The default rule still pushes everything-but-the-envelope into WARP; the new
  // exception is keyed on the inbound-origin connmark, so locally-INITIATED
  // outbound (the proxy egress) is untouched and still goes via WARP.
  ok(/ip rule add prio "\$PRIO_DEFAULT" not fwmark "\$WG_FWMARK" lookup "\$RT_TABLE"/.test(routeUp),
     'route_up: default `not fwmark → WARP` rule intact (proxy egress still tunneled)');
}

console.log('\n[4b] Subscription /sub reply-path is NATIVE under WARP (single-server, no cascade)');
{
  // A client fetching https://<sub|panel domain>/sub/:token opens a TCP
  // connection that TERMINATES LOCALLY at Caddy (:443, from a NON-warp iface) and
  // is reverse_proxied to the panel over LOOPBACK (127.0.0.1:panelPort). Both legs
  // are covered by the connection-origin reply-path fix:
  //   • the inbound leg is a NEW tcp conn from `! -i warp` → gets MARK_CONN;
  //   • the reply (the base64 subscription body) is restored on OUTPUT and
  //     routed via `fwmark MARK_CONN → main`, i.e. NATIVELY, never into WARP.
  // The internal Caddy↔panel hop is loopback and never touches the WARP table.
  // So enabling WARP on a single server does NOT break serving the sub-link.
  // This asserts the generic (port-agnostic) shape that guarantees it.
  ok(/-A PREROUTING ! -i "\$dev" -p tcp -m conntrack --ctstate NEW -j CONNMARK --set-mark "\$MARK_CONN"/.test(routeUp),
     'inbound HTTPS (Caddy :443) → tagged MARK_CONN regardless of port → /sub connection covered');
  ok(/-A OUTPUT -p tcp -j CONNMARK --restore-mark/.test(routeUp),
     'the /sub base64 reply (locally generated TCP) is restored on OUTPUT → routed to main, not WARP');
  ok(/ip rule add prio "\$p" fwmark "\$MARK_CONN" lookup main/.test(routeUp),
     'fwmark MARK_CONN → main sends the sub-link reply out the NATIVE NIC (client receives it)');
}

console.log('\n[5] BUG-171: teardown removes the inbound-mark rules (idempotent)');
{
  ok(routeDown.length > 0, 'route_down() body located');
  ok(/-D PREROUTING ! -i "\$dev" -p tcp -m conntrack --ctstate NEW -j CONNMARK --set-mark "\$MARK_CONN"/.test(routeDown),
     'route_down: removes the inbound NEW-connection mark');
  ok(/-D OUTPUT -p tcp -j CONNMARK --restore-mark/.test(routeDown),
     'route_down: removes the unconditional OUTPUT reply-restore (v2 shape)');
  ok(/-D OUTPUT -p tcp -m connmark --mark "\$MARK_CONN" -j CONNMARK --restore-mark/.test(routeDown),
     'route_down: also purges the legacy v1 conditional OUTPUT restore (upgrade cleanliness)');
  // legacy per-port shapes still purged so an upgrade leaves no orphans
  ok(/--dport "\$\{SSH_PORT:-22\}"/.test(routeDown),
     'route_down: still purges legacy per-port SSH mark (upgrade cleanliness)');
}

console.log('\n[6] BUG-171 LIVE: full rule set installs idempotently and tears down clean');
{
  // The sandbox kernel typically lacks xt_CONNMARK / xt_conntrack, so we drive
  // the script with a MOCK iptables that records rules in memory and honours
  // -C/-A/-D. This validates the real control flow: -C-before-A idempotency, the
  // exact rule shapes, and that route_down deletes every one. (The real CONNMARK
  // targets run on the server.) Requires root only for the dummy link + ip rule.
  const isRoot = cp.spawnSync('sh', ['-c', '[ "$(id -u)" = 0 ]']).status === 0;
  if (!isRoot) {
    console.log('  \u26a0 skipped (needs root for dummy link + ip rule)');
  } else {
    const dir = fs.mkdtempSync('/tmp/b171mock-');
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
      'export PANEL_PORT="3000"; export SSH_PORT="22"',
      'log(){ :; }; err(){ :; }; detect_ssh_port(){ echo 22; }',
      'local_subnet(){ echo ""; }; default_gw(){ echo ""; }',
      `eval "$(sed '/^ACTION=/,$d' '${SCRIPT}')"`,
      // The eval (re)sets WG_IFACE to the script default. Pin it to our dummy
      // link AFTER the eval so route_up (arg) and route_down (uses $WG_IFACE)
      // operate on the SAME interface — otherwise teardown deletes nothing.
      'export WG_IFACE="warp171t"',
      `: > "${dir}/rules.txt"`,
      'for q in $(seq "$PRIO_EXCEPT_BASE" $((PRIO_EXCEPT_BASE+10))) "$PRIO_SUPPRESS" "$PRIO_DEFAULT"; do',
      '  r="$(ip rule show 2>/dev/null||true)"; n=0',
      '  while [[ $\'\\n\'"$r" == *$\'\\n\'"$q:"* ]]; do ip rule del prio "$q" 2>/dev/null||true; n=$((n+1)); [ $n -ge 30 ]&&break; r="$(ip rule show 2>/dev/null||true)"; done',
      'done',
      'ip link add warp171t type dummy 2>/dev/null||true; ip link set warp171t up 2>/dev/null||true',
      'route_up warp171t >/dev/null 2>&1; route_up warp171t >/dev/null 2>&1',  // twice → idempotency
      `UP=$(wc -l < "${dir}/rules.txt")`,
      `INMARK=$(grep -c "PREROUTING ! -i warp171t -p tcp -m conntrack --ctstate NEW -j CONNMARK --set-mark 0x5152" "${dir}/rules.txt")`,
      `REPLY=$(grep -c "OUTPUT -p tcp -j CONNMARK --restore-mark" "${dir}/rules.txt")`,
      'route_down >/dev/null 2>&1',
      `DOWN=$(wc -l < "${dir}/rules.txt")`,
      'ip link del warp171t 2>/dev/null||true',
      'echo "UP=$UP INMARK=$INMARK REPLY=$REPLY DOWN=$DOWN"',
    ].join('\n');
    const r = cp.spawnSync('bash', ['-c', harness], { encoding: 'utf8' });
    const m = (r.stdout || '').match(/UP=(\d+) INMARK=(\d+) REPLY=(\d+) DOWN=(\d+)/);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
    ok(!!m, 'live mock-kernel run executed (' + (r.stdout || r.stderr || '').trim() + ')');
    if (m) {
      ok(m[2] === '1', 'inbound NEW-connection mark installed exactly once (idempotent)');
      ok(m[3] === '1', 'OUTPUT reply-restore installed exactly once (idempotent)');
      ok(parseInt(m[1], 10) >= 6, 'full mangle rule set present after route_up x2 (' + m[1] + ' rules)');
      ok(m[4] === '0', 'route_down removed ALL mangle rules (0 left)');
    }
  }
}

console.log('\nResult: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
