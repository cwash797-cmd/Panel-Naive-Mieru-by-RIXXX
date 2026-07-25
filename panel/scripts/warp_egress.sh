#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# warp_egress.sh — Cloudflare WARP as a server-wide EGRESS mode for RIXXX panel.
#
# Goal: route the server's OUTBOUND traffic through Cloudflare WARP so the real
# server IP is hidden from upstream destinations (privacy + IP-block evasion).
#
# BUG-162 (CRITICAL): in v1.5.1 enabling WARP routed EVERYTHING (AllowedIPs
#   0.0.0.0/0, wg-quick Table=auto) into the tunnel — including the SSH and panel
#   MANAGEMENT channels — so the operator lost all access (only the hoster console
#   recovered the box). Worse, the unit was `systemctl enable`d, so a reboot
#   brought the server down AGAIN automatically.
#
#   Fix: we NO LONGER let wg-quick install a blanket default route. Instead we use
#   `Table = off` (wg-quick touches NOTHING in the routing tables) and install our
#   OWN policy routing in PostUp/PreDown:
#     • a dedicated route table (RT_TABLE) whose default route is the WARP iface
#     • a low-priority ip rule that sends traffic to that table
#     • HIGH-PRIORITY exception rules (evaluated FIRST) that keep the management
#       plane on the MAIN table: SSH port, panel port, the local subnet, the
#       default gateway, the WARP endpoint itself, and — crucially — replies to
#       any INBOUND/ESTABLISHED connection (so SSH/panel sessions never break).
#   Result: only locally-originated egress (the proxy's upstream traffic) goes via
#   WARP; the control channel always uses the native route. If the tunnel dies,
#   management access SURVIVES (the exception rules + main table remain).
#
# Mode is server-wide (NOT per-user, NOT per-key). It is MUTUALLY EXCLUSIVE with
# the Mieru cascade — the panel guarantees only one egress mode is ever active.
#
# Autostart: NOT enabled by default (BUG-162). The unit is only `systemctl enable`d
#   when WARP_PERSIST=1 is set (the panel sets it only on explicit operator
#   confirmation). Otherwise WARP does not come back after a reboot, so a bad
#   tunnel can never silently re-down the box on restart.
#
# Usage:
#   warp_egress.sh setup            # register (if needed) + generate + wg up
#   warp_egress.sh teardown         # wg down + remove route artifacts (idempotent)
#   warp_egress.sh status           # JSON-ish status incl. measured egress IP
#   warp_egress.sh egress-ip        # just print the current public egress IP
#
# Env (optional, supplied by the panel):
#   WARP_SSH_PORT    SSH port to keep on the native route   (default: detected/22)
#   WARP_PANEL_PORT  panel port to keep on the native route (default: 3000)
#   WARP_PERSIST     "1" → enable autostart on boot         (default: off)
#
# Idempotent: re-running setup re-applies cleanly; teardown leaves a clean host
# with NO leftover routes / rules / interfaces (lesson from BUG-150).
# ─────────────────────────────────────────────────────────────────────────────
set -o pipefail

# Absolute path to THIS script — embedded into the wg conf PostUp/PreDown so
# wg-quick (run by systemd at boot too) can call back for policy routing.
WARP_SELF="$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || echo "$0")"

WG_IFACE="warp"
WG_CONF="/etc/wireguard/${WG_IFACE}.conf"
WGCF_DIR="/etc/rixxx-panel/warp"
WGCF_ACCOUNT="${WGCF_DIR}/wgcf-account.toml"
WGCF_PROFILE="${WGCF_DIR}/wgcf-profile.conf"
WARP_ENDPOINT_HOST="engage.cloudflareclient.com"

# BUG-164: WARP over Cloudflare needs a reduced MTU (1280). With the default
#   1420/1500 the encrypted reply packets get dropped on the return path, so the
#   tunnel handshakes but no data comes back ("sent MiB / received ~0 B").
WARP_MTU="${WARP_MTU:-1280}"
# BUG-164: Cloudflare's WARP edge listens on several UDP ports. Some hosters
#   block 2408 inbound; if the health-check fails we retry the alternative ports.
WARP_ENDPOINT_PORTS="${WARP_ENDPOINT_PORTS:-2408 500 1701 4500}"
# BUG-164: after bring-up we verify the tunnel actually carries return traffic by
#   fetching our egress IP THROUGH the warp interface. If it doesn't answer in
#   time we auto-roll-back so the box never sits in a black-hole.
WARP_HEALTH_TIMEOUT="${WARP_HEALTH_TIMEOUT:-5}"

# BUG-170 (HIGH): with MTU=1280 and NO TCP MSS clamping, clients connect through
#   WARP but heavy sites/video stall ("connected, nothing loads"). Proven on the
#   box: `ping -M do -s 1400 -I warp 1.1.1.1` → "message too long, mtu=1280", 100%
#   loss; `-s 1200` → 0% loss. A real client is DOUBLE-encapsulated
#   (client → Naive/Mieru → WARP), so the effective MTU is even lower; with DF set
#   the kernel drops oversized segments and (PMTUD being unreliable across the
#   proxy/ICMP-filtered paths) the sender never shrinks them → large flows hang.
#   Fix: clamp TCP MSS on everything that egresses via the warp interface, on BOTH
#   the FORWARD path (forwarded client egress) and the OUTPUT path (caddy-naive /
#   mita are LOCAL processes, their packets are OUTPUT not FORWARD).
#   WARP_MSS: hard MSS ceiling for the doubly-encapsulated path. 1280 - 20 (IPv4)
#   - 20 (TCP) = 1240. We pin --set-mss 1240 (deterministic, survives broken PMTUD)
#   AND add --clamp-mss-to-pmtu as a belt-and-suspenders lower bound.
WARP_MSS="${WARP_MSS:-1240}"

# BUG-162/169 policy-routing constants.
#
# BUG-169 (CRITICAL): our v1.5.2–1.5.4 hand-rolled scheme broke the WARP RETURN
#   path (rx≈92B handshake-only, tx huge). A bare Table=off tunnel with NO policy
#   routing works perfectly on the same host/endpoint — so the breakage was OURS,
#   not the provider's. Root cause: we never adopted the kernel mechanism that
#   makes WireGuard-over-policy-routing actually carry return traffic:
#     1. WireGuard must fwmark its OWN encrypted envelope packets (`wg set fwmark`)
#        so they can be kept OUT of the tunnel table (else a routing loop).
#     2. `ip rule add not fwmark <T> table <T>` sends everything EXCEPT the
#        envelope into the tunnel table.
#     3. conntrack save/restore of that fwmark on the UDP envelope
#        (POSTROUTING --save-mark / PREROUTING --restore-mark) so the RETURN
#        encrypted packets are associated and delivered back to the wg socket.
#     4. `sysctl net.ipv4.conf.all.src_valid_mark=1` so marked packets survive
#        reverse-path filtering.
#   This is exactly what wg-quick's own `add_default()` does with Table=auto. We
#   now replicate it (table = fwmark = 51820) and ADD our management-plane
#   exceptions on top (suppress_prefixlength + SSH/panel sport → main).
RT_TABLE="51820"            # dedicated route table id == WireGuard fwmark
RT_NAME="warp"
WG_FWMARK="51820"           # BUG-169: WireGuard's own envelope fwmark (== table)
PRIO_EXCEPT_BASE="9000"     # management-plane exception rules (evaluated first)
PRIO_SUPPRESS="9400"        # `suppress_prefixlength 0` (let specific main routes win)
PRIO_DEFAULT="9500"         # "not fwmark <WG_FWMARK> → WARP table" rule
MARK_CONN="0x5152"          # connmark for ANY locally-terminated inbound TCP
                            # connection (client→caddy/mita, SSH, panel) so its
                            # replies stay on the native route — BUG-171.

# Management ports to keep on the native route (overridable via env from panel).
SSH_PORT="${WARP_SSH_PORT:-}"
PANEL_PORT="${WARP_PANEL_PORT:-3000}"
# BUG-173 (CRITICAL): the Hysteria2 (QUIC/UDP) service port whose inbound
#   connections need the native-route return mark. Scoping the UDP return-path
#   rules to THIS port (instead of ALL udp) is what keeps them from colliding
#   with WireGuard's own encrypted UDP envelope. Default 443 (the Hy2 default).
HY2_PORT="${WARP_HY2_PORT:-443}"

log() { echo "[warp] $*"; }
err() { echo "[warp][ERROR] $*" >&2; }
die() { err "$*"; exit 1; }

# Detect the active SSH port(s) from sshd config / listening sockets; default 22.
detect_ssh_port() {
  local p=""
  p="$(awk '/^[[:space:]]*Port[[:space:]]+[0-9]+/{print $2}' /etc/ssh/sshd_config 2>/dev/null | head -1)"
  [[ -z "$p" ]] && p="$(ss -tlnp 2>/dev/null | awk '/sshd/{split($4,a,":"); print a[length(a)]}' | head -1)"
  [[ -z "$p" ]] && p="22"
  echo "$p"
}

# ── arch → wgcf release asset ────────────────────────────────────────────────
wgcf_arch() {
  case "$(uname -m)" in
    x86_64|amd64)  echo "linux_amd64" ;;
    aarch64|arm64) echo "linux_arm64" ;;
    armv7l|armv7)  echo "linux_armv7" ;;
    *)             echo "linux_amd64" ;;
  esac
}

# ── lazy install: wgcf + wireguard-tools + resolvconf ────────────────────────
ensure_packages() {
  if ! command -v wg-quick &>/dev/null; then
    log "installing wireguard-tools…"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq 2>/dev/null || true
    apt-get install -y -qq wireguard-tools 2>/dev/null || apt-get install -y wireguard-tools || \
      die "failed to install wireguard-tools"
  fi
  # resolvconf lets wg-quick apply DNS = … without clobbering the system resolver.
  command -v resolvconf &>/dev/null || \
    apt-get install -y -qq openresolv 2>/dev/null || apt-get install -y -qq resolvconf 2>/dev/null || true

  if ! command -v wgcf &>/dev/null; then
    log "installing wgcf…"
    local arch ver url tmp
    arch="$(wgcf_arch)"
    # Pin to a known wgcf release; fall back to 'latest' redirect if the API is reachable.
    ver="2.2.22"
    url="https://github.com/ViRb3/wgcf/releases/download/v${ver}/wgcf_${ver}_${arch}"
    tmp="$(mktemp)"
    if ! curl -fsSL --max-time 60 -o "$tmp" "$url" 2>/dev/null; then
      # Try latest as a fallback.
      url="https://github.com/ViRb3/wgcf/releases/latest/download/wgcf_${ver}_${arch}"
      curl -fsSL --max-time 60 -o "$tmp" "$url" 2>/dev/null || die "failed to download wgcf"
    fi
    install -m 0755 "$tmp" /usr/local/bin/wgcf || die "failed to install wgcf binary"
    rm -f "$tmp"
  fi
}

# ── ensure WARP account + WireGuard profile exist ─────────────────────────────
# BUG-164: a one-way tunnel (handshake OK but received ≈ 0 B) is frequently caused
#   by a key that was GENERATED but never actually REGISTERED with Cloudflare. We
#   make registration robust: the account file must exist AND be non-trivial.
#
# BUG-166: a real wgcf-account.toml (wgcf 2.2.x) looks like:
#     access_token = '…'
#     device_id    = '…'
#     private_key  = '…'
#     license_key  = '…'
#   The keys can be single/double-quoted and may have leading spaces. We accept
#   any quoting. The validity gate verifies device_id + private_key + access_token
#   are all present and non-empty.
account_is_valid() {
  local f="${1:-$WGCF_ACCOUNT}"
  [[ -s "$f" ]] || return 1
  # Each key must be present AND have a non-empty value after `=`. Accept
  #   single/double quotes and surrounding whitespace.
  local k
  for k in device_id private_key access_token; do
    grep -qiE "^[[:space:]]*${k}[[:space:]]*=[[:space:]]*['\"]?[^'\"[:space:]]+" "$f" 2>/dev/null \
      || return 1
  done
  return 0
}

# BUG-166: register the WARP account WITHOUT the `yes |` pipe.
#   Root cause of the false "wgcf register failed": the script runs under
#   `set -o pipefail`, and `yes | wgcf register` makes `yes` receive SIGPIPE
#   (exit 141) the instant wgcf closes its stdin — even on a fully SUCCESSFUL
#   registration. pipefail then propagates 141 as the pipeline status, so the
#   `|| die` fired despite "Successfully created Cloudflare Warp account".
#   We pass `--accept-tos` (no prompt → no pipe needed) and an explicit
#   `--config` path so the account is always written/read at $WGCF_ACCOUNT
#   regardless of CWD. We also judge success by the FILE, not the exit code.
wgcf_register() {
  rm -f "$WGCF_ACCOUNT"
  # --accept-tos answers the only interactive prompt; no `yes` pipe required.
  # Run from $WGCF_DIR and pass --config so both CWD-relative and absolute
  # resolutions land on the same file (belt and suspenders for BUG-166).
  ( cd "$WGCF_DIR" && wgcf --config "$WGCF_ACCOUNT" register --accept-tos ) \
    >/dev/null 2>&1 || true
  # Some wgcf builds ignore --config for register and write ./wgcf-account.toml.
  if [[ ! -s "$WGCF_ACCOUNT" && -s "${WGCF_DIR}/wgcf-account.toml" ]]; then
    mv -f "${WGCF_DIR}/wgcf-account.toml" "$WGCF_ACCOUNT" 2>/dev/null || true
  fi
  # Success is judged by the account file Cloudflare actually wrote — NOT by the
  # pipeline exit code (BUG-166).
  account_is_valid "$WGCF_ACCOUNT"
}

ensure_profile() {
  mkdir -p "$WGCF_DIR"
  chmod 700 "$WGCF_DIR"
  if account_is_valid "$WGCF_ACCOUNT"; then
    log "existing WARP account looks valid — reusing it"
  else
    log "registering a free Cloudflare WARP account (no valid account on disk)…"
    if ! wgcf_register; then
      die "wgcf register did not produce a valid account (registration with Cloudflare failed)"
    fi
    log "WARP account registered"
  fi
  log "generating WireGuard profile…"
  # Generate against the explicit account path; tolerate a SIGPIPE-style false
  #   non-zero by re-checking the produced profile file.
  ( cd "$WGCF_DIR" && wgcf --config "$WGCF_ACCOUNT" generate --profile "$WGCF_PROFILE" ) >/dev/null 2>&1 || true
  if [[ ! -s "$WGCF_PROFILE" && -s "${WGCF_DIR}/wgcf-profile.conf" ]]; then
    mv -f "${WGCF_DIR}/wgcf-profile.conf" "$WGCF_PROFILE" 2>/dev/null || true
  fi
  [[ -s "$WGCF_PROFILE" ]] || die "wgcf profile not generated"
}

# ── build /etc/wireguard/warp.conf from the wgcf profile ─────────────────────
# We take the wgcf profile and harden it for a server egress:
#   • Table = auto    → wg-quick installs default routes + fwmark suppress rules,
#                       which is exactly what protects inbound sockets & endpoint.
#   • PostUp/PreDown  → add/remove an explicit RETURN-style exclusion is NOT
#                       needed because wg-quick already excludes the endpoint, but
#                       we DISABLE the wg-quick DNS push on low-RAM/headless boxes
#                       only if resolvconf is missing (avoids a hard failure).
# BUG-161 (v1.5.1): detect whether the host actually has working IPv6. Many VPS
#   are IPv4-only (IPv6 disabled in the kernel). The wgcf profile always ships an
#   IPv6 Address + `AllowedIPs = ::/0`; wg-quick then runs `ip -6 address add …`
#   which fails ("IPv6 is disabled on this device") and rolls the WHOLE interface
#   back, so the tunnel never comes up. We strip every IPv6 bit from the conf when
#   the host has no IPv6, bringing WARP up IPv4-only.
host_has_ipv6() {
  # Kernel IPv6 fully disabled?
  if [[ -f /proc/sys/net/ipv6/conf/all/disable_ipv6 ]] \
     && [[ "$(cat /proc/sys/net/ipv6/conf/all/disable_ipv6 2>/dev/null)" == "1" ]]; then
    return 1
  fi
  # No /proc/net/if_inet6 → no IPv6 stack at all.
  [[ -e /proc/net/if_inet6 ]] || return 1
  # Need at least one usable (global or link) IPv6 address on some interface.
  # NB: snapshot into a var then match in pure bash — piping into `grep -q` under
  #     `set -o pipefail` can yield 141 (SIGPIPE when grep closes the pipe early)
  #     and produce a FALSE "no IPv6" verdict (which would wrongly strip ::/0 on a
  #     dual-stack host — see BUG-167). Same SIGPIPE/pipefail class as BUG-166.
  local v6
  v6="$(ip -6 addr show scope global 2>/dev/null || true)"
  [[ "$v6" == *inet6* ]] && return 0
  v6="$(ip -6 addr show 2>/dev/null || true)"
  [[ "$v6" == *inet6* ]] && return 0
  return 1
}

build_wg_conf() {
  [[ -f "$WGCF_PROFILE" ]] || die "no wgcf profile to build from"
  mkdir -p /etc/wireguard

  [[ -z "$SSH_PORT" ]] && SSH_PORT="$(detect_ssh_port)"

  # 1) start from the wgcf [Interface]/[Peer] keys, dropping DNS (we manage our
  #    own routing and don't want resolvconf surprises on headless boxes) and the
  #    profile's Address/AllowedIPs (we rebuild them below, hardened).
  local IFACE_PRIV IFACE_ADDR4 PEER_PUB PEER_PSK PEER_EP
  IFACE_PRIV="$(awk -F'=' '/^[[:space:]]*PrivateKey[[:space:]]*=/{sub(/^[^=]*=[[:space:]]*/,"",$0);print;exit}' "$WGCF_PROFILE")"
  PEER_PUB="$(awk -F'=' '/^[[:space:]]*PublicKey[[:space:]]*=/{sub(/^[^=]*=[[:space:]]*/,"",$0);print;exit}' "$WGCF_PROFILE")"
  PEER_PSK="$(awk -F'=' '/^[[:space:]]*PresharedKey[[:space:]]*=/{sub(/^[^=]*=[[:space:]]*/,"",$0);print;exit}' "$WGCF_PROFILE")"
  PEER_EP="$(awk -F'=' '/^[[:space:]]*Endpoint[[:space:]]*=/{sub(/^[^=]*=[[:space:]]*/,"",$0);print;exit}' "$WGCF_PROFILE")"
  # IPv4 interface address only (BUG-161: skip IPv6 to avoid the failing add).
  IFACE_ADDR4="$(awk '/^[[:space:]]*Address[[:space:]]*=/{sub(/^[^=]*=[[:space:]]*/,"",$0); n=split($0,a,/[[:space:]]*,[[:space:]]*/); for(i=1;i<=n;i++){if(index(a[i],":")==0){print a[i]; exit}}}' "$WGCF_PROFILE")"
  [[ -z "$IFACE_ADDR4" ]] && IFACE_ADDR4="172.16.0.2/32"
  [[ -z "$IFACE_PRIV" || -z "$PEER_PUB" || -z "$PEER_EP" ]] && die "wgcf profile missing keys/endpoint"

  local v6=0
  host_has_ipv6 && v6=1
  [[ "$v6" == "1" ]] && log "IPv6 detected (kept IPv4-only routing anyway for safety)" \
                     || log "no usable IPv6 on host — IPv4-only WARP config"

  # 2) write a self-contained conf with Table=off (wg-quick must NOT touch the
  #    routing tables) and our own PostUp/PreDown policy routing.
  #    AllowedIPs stays 0.0.0.0/0 (the crypto-routing scope: which dst the peer
  #    accepts) but Table=off means it does NOT become a default route — WE add a
  #    scoped default only in RT_TABLE, with management exceptions in main.
  {
    echo "# Generated by warp_egress.sh (BUG-162: Table=off + scoped policy routing)"
    echo "# BUG-164: MTU=1280 — WARP over Cloudflare requires a reduced MTU. With the"
    echo "#   default 1420/1500 the encapsulated reply packets exceed the path MTU and"
    echo "#   are silently dropped, producing the classic 'sent MiB / received ~0 B'"
    echo "#   one-way-tunnel symptom (handshake OK but no return traffic)."
    echo "[Interface]"
    echo "PrivateKey = ${IFACE_PRIV}"
    echo "Address = ${IFACE_ADDR4}"
    echo "MTU = ${WARP_MTU}"
    echo "Table = off"
    echo "PostUp = ${WARP_SELF} route-up %i"
    echo "PreDown = ${WARP_SELF} route-down %i"
    echo ""
    echo "[Peer]"
    echo "PublicKey = ${PEER_PUB}"
    [[ -n "$PEER_PSK" ]] && echo "PresharedKey = ${PEER_PSK}"
    echo "AllowedIPs = 0.0.0.0/0"
    echo "Endpoint = ${PEER_EP}"
    echo "PersistentKeepalive = 25"
  } > "$WG_CONF"

  chmod 600 "$WG_CONF"
  log "wrote ${WG_CONF} (Table=off, SSH=${SSH_PORT}, panel=${PANEL_PORT})"
}

# ── default gateway / local subnet / WARP endpoint helpers ───────────────────
default_gw()    { ip route show default 2>/dev/null | awk '/default/{print $3; exit}'; }
default_dev()   { ip route show default 2>/dev/null | awk '/default/{print $5; exit}'; }
local_subnet()  {
  local dev; dev="$(default_dev)"
  [[ -z "$dev" ]] && return 0
  ip -o -4 addr show dev "$dev" 2>/dev/null | awk '{print $4; exit}'
}
warp_endpoint_ip() {
  # The literal endpoint IP must stay on the NATIVE route (anti-loop).
  local ep host; ep="$(awk -F'=' '/^[[:space:]]*Endpoint[[:space:]]*=/{sub(/^[^=]*=[[:space:]]*/,"",$0);print;exit}' "$WG_CONF" 2>/dev/null)"
  host="${ep%%:*}"
  if [[ "$host" =~ ^[0-9.]+$ ]]; then echo "$host"
  else getent hosts "$host" 2>/dev/null | awk '{print $1; exit}'; fi
}

# ── BUG-169: install policy routing that ACTUALLY carries WARP return traffic ──
#   This mirrors wg-quick's proven `add_default()` (the bare Table=off tunnel that
#   the operator confirmed works) and layers our management-plane exceptions on
#   top. The pieces that were missing in v1.5.2–1.5.4 (and broke the return path):
#     • WireGuard fwmarks its own envelope (`wg set <iface> fwmark <T>`)
#     • `not fwmark <T> table <T>` (envelope stays native; everything else tunnels)
#     • conntrack save/restore of the UDP envelope mark (return packets delivered)
#     • src_valid_mark=1 (marked packets pass reverse-path filtering)
#   Management exceptions (HIGHER priority, evaluated first): SSH/panel sport →
#   main, local subnet/gateway → main, and `suppress_prefixlength 0` so specific
#   main routes (incl. the on-link endpoint route) win.
route_up() {
  local dev="${1:-$WG_IFACE}"
  [[ -z "$SSH_PORT" ]] && SSH_PORT="$(detect_ssh_port)"

  # 0) Tell WireGuard to fwmark its OWN encrypted envelope packets. This is THE
  #    key piece: it lets us keep the envelope OUT of the tunnel table (no loop)
  #    and lets conntrack tag the return packets so they reach the wg socket.
  wg set "$dev" fwmark "$WG_FWMARK" 2>/dev/null || true

  # 1) WARP default route lives ONLY in our dedicated table (== the fwmark).
  ip route replace default dev "$dev" table "$RT_TABLE" 2>/dev/null \
    || ip route add default dev "$dev" table "$RT_TABLE" 2>/dev/null || true

  # 2) conntrack save/restore of the envelope mark on the UDP carrier. THIS is
  #    the return-path fix: the outgoing encrypted UDP carries WG_FWMARK; we save
  #    it onto the conntrack entry (POSTROUTING) and restore it on the incoming
  #    reply UDP (PREROUTING) so the kernel routes the reply back to the wg
  #    socket instead of dropping it. Plus src_valid_mark so it survives rp_filter.
  if command -v iptables &>/dev/null; then
    iptables -t mangle -C POSTROUTING -m mark --mark "$WG_FWMARK" -p udp -j CONNMARK --save-mark 2>/dev/null \
      || iptables -t mangle -A POSTROUTING -m mark --mark "$WG_FWMARK" -p udp -j CONNMARK --save-mark 2>/dev/null || true
    iptables -t mangle -C PREROUTING -p udp -j CONNMARK --restore-mark 2>/dev/null \
      || iptables -t mangle -A PREROUTING -p udp -j CONNMARK --restore-mark 2>/dev/null || true

    # 2a) BUG-171 (CRITICAL): keep the REPLY path of every locally-terminated
    #     inbound connection on the NATIVE route. Previously we only excepted
    #     SSH/panel by --dport, so SYN-ACKs from caddy-naive (:443) and mita
    #     (:2012/:443) to ARBITRARY client IPs were swallowed by the default
    #     `not fwmark → WARP table` rule and sent into Cloudflare instead of back
    #     to the client → every client TCP session stuck in SYN-RECV, nothing
    #     loads. The proxies' OWN outbound dials (egress) must still go via WARP.
    #
    #     Distinguish by CONNECTION ORIGIN, not by port: mark every NEW inbound
    #     TCP connection that ENTERS from a non-WARP interface (a client/SSH/panel
    #     hitting one of OUR listening sockets), save it onto the conntrack entry,
    #     and restore that mark on OUTPUT so the SYN-ACK/replies carry it. The
    #     `fwmark MARK_CONN → main` ip rule (below) then routes those replies
    #     natively. Connections the proxy ORIGINATES outbound start at OUTPUT (no
    #     inbound PREROUTING/NEW), never get the mark, and fall through to WARP.
    #     `! -i <warp>` so decrypted traffic returning via the tunnel is exempt.
    #
    #   ⚠ BUG-171 v2 (the fix that ACTUALLY unsticks SYN-RECV): the OUTPUT restore
    #     MUST be unconditional. The previous shape matched `-m connmark --mark
    #     MARK_CONN` on the OUTPUT rule — but that matches the *packet nfmark*,
    #     which on a freshly-generated local SYN-ACK is still 0 (the conntrack
    #     mark hasn't been copied onto the packet yet — that's literally what this
    #     rule is supposed to do). So the restore NEVER fired, the SYN-ACK stayed
    #     unmarked, and rule 9500 (`not fwmark 0xca6c → WARP`) swallowed it into
    #     Cloudflare → client stuck in SYN-RECV. We restore on EVERY locally-
    #     generated TCP packet: `CONNMARK --restore-mark` is a no-op when the
    #     conntrack entry carries no mark (proxy-originated egress dials), so it
    #     only ever marks replies of inbound (client/SSH/panel) connections.
    #     This is the canonical wg-quick / sshuttle return-path recipe.
    iptables -t mangle -C PREROUTING ! -i "$dev" -p tcp -m conntrack --ctstate NEW -j CONNMARK --set-mark "$MARK_CONN" 2>/dev/null \
      || iptables -t mangle -A PREROUTING ! -i "$dev" -p tcp -m conntrack --ctstate NEW -j CONNMARK --set-mark "$MARK_CONN" 2>/dev/null || true
    iptables -t mangle -C OUTPUT -p tcp -j CONNMARK --restore-mark 2>/dev/null \
      || iptables -t mangle -A OUTPUT -p tcp -j CONNMARK --restore-mark 2>/dev/null || true

    # 2a-udp) HY2 (Hysteria2 / QUIC over UDP): identical return-path fix as the
    #     BUG-171 TCP rule above, but for UDP. Hysteria2 listens on udp/${HY2_PORT}
    #     (default 443); a client's QUIC packets ENTER from a non-WARP interface
    #     and hit our local UDP socket. Its replies are locally generated on
    #     OUTPUT — without marking them they fall through the `not fwmark → WARP
    #     table` rule and get sent into Cloudflare, so the handshake never
    #     completes for the client.
    #
    #   ⚠ BUG-173 (CRITICAL, regression introduced in v1.8.0): the first cut of
    #     this rule matched ALL udp on OUTPUT — `-p udp CONNMARK --restore-mark`
    #     with NO port scope. That is fatal here (unlike the TCP twin) because
    #     WireGuard's OWN encrypted envelope IS udp. WireGuard fwmarks its
    #     envelope with WG_FWMARK (§0) so the `not fwmark WG_FWMARK → WARP` rule
    #     keeps it on the native route to reach Cloudflare. But an unscoped
    #     OUTPUT restore fires on that very envelope: before POSTROUTING has
    #     saved WG_FWMARK onto the endpoint conntrack (fresh handshake race), the
    #     restore copies mark 0 onto the envelope, wiping the fwmark WireGuard
    #     set → the envelope gets mis-routed INTO the WARP table (loop) and the
    #     return path black-holes (the classic rx≈92B / tx≫0 "handshake OK, no
    #     return traffic" symptom). It looked provider-blocked and rolled back;
    #     a second (warm-conntrack) attempt then succeeded — exactly the flaky
    #     "hangs 3-4 min then works on retry" report.
    #
    #     Fix: scope BOTH the inbound set-mark and the OUTPUT restore to the Hy2
    #     service port only (source port on the reply leg = HY2_PORT). WireGuard's
    #     envelope (dst 2408/500/1701/4500, src ephemeral) never matches, so its
    #     fwmark is untouched. `! -i <warp>` still exempts decrypted tunnel
    #     traffic. Hy2's own outbound proxy dials start at OUTPUT with no inbound
    #     NEW, never get the mark, and still egress via WARP. This makes WARP
    #     stable with or without Hy2, and with or without cascade.
    iptables -t mangle -C PREROUTING ! -i "$dev" -p udp --dport "$HY2_PORT" -m conntrack --ctstate NEW -j CONNMARK --set-mark "$MARK_CONN" 2>/dev/null \
      || iptables -t mangle -A PREROUTING ! -i "$dev" -p udp --dport "$HY2_PORT" -m conntrack --ctstate NEW -j CONNMARK --set-mark "$MARK_CONN" 2>/dev/null || true
    iptables -t mangle -C OUTPUT -p udp --sport "$HY2_PORT" -j CONNMARK --restore-mark 2>/dev/null \
      || iptables -t mangle -A OUTPUT -p udp --sport "$HY2_PORT" -j CONNMARK --restore-mark 2>/dev/null || true

    # 2b) BUG-170: TCP MSS clamping for everything egressing via WARP. Without it
    #     clients connect but heavy traffic stalls (segments > MTU-1280 get DF-
    #     dropped, PMTUD unreliable through the double Naive/Mieru→WARP wrap). We
    #     pin a hard MSS (--set-mss WARP_MSS, deterministic) AND add
    #     --clamp-mss-to-pmtu as a lower bound. Match SYN/SYN-ACK only (where MSS
    #     is negotiated). Cover BOTH:
    #       • FORWARD -o warp : forwarded client egress
    #       • OUTPUT  -o warp : caddy-naive / mita are LOCAL procs → OUTPUT path
    local chain
    for chain in FORWARD OUTPUT; do
      iptables -t mangle -C "$chain" -o "$dev" -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --set-mss "$WARP_MSS" 2>/dev/null \
        || iptables -t mangle -A "$chain" -o "$dev" -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --set-mss "$WARP_MSS" 2>/dev/null || true
      iptables -t mangle -C "$chain" -o "$dev" -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu 2>/dev/null \
        || iptables -t mangle -A "$chain" -o "$dev" -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu 2>/dev/null || true
    done
  fi
  # rp_filter: allow locally-generated marked (WireGuard) traffic. wg-quick sets
  #   this exact sysctl; without it the decrypted return packets fail the reverse
  #   path check on the warp interface and are dropped (the rx≈92B symptom).
  sysctl -q net.ipv4.conf.all.src_valid_mark=1 2>/dev/null || true

  # 3) HIGH-PRIORITY management exceptions (evaluated FIRST) → main table.
  local p="$PRIO_EXCEPT_BASE"
  # 3a. BUG-171: replies of ANY locally-terminated inbound connection (the SYN-ACK
  #     from caddy-naive/mita/SSH/panel back to the client) carry MARK_CONN via
  #     the conntrack restore above → route them natively, NOT into WARP. THIS is
  #     the rule that unsticks SYN-RECV: without it the SYN-ACK to an arbitrary
  #     client IP fell through to the default `not fwmark → WARP` rule.
  ip rule add prio "$p" fwmark "$MARK_CONN" lookup main 2>/dev/null || true; p=$((p+1))
  # 3b. belt-and-suspenders: locally-originated SSH/panel server replies (sport) →
  #     main even before conntrack is established (covers the very first packets).
  ip rule add prio "$p" ipproto tcp sport "$SSH_PORT"   lookup main 2>/dev/null || true; p=$((p+1))
  ip rule add prio "$p" ipproto tcp sport "$PANEL_PORT" lookup main 2>/dev/null || true; p=$((p+1))
  # 3c. local subnet + default gateway → main (never tunnel LAN/gw)
  local sub gw
  sub="$(local_subnet)"; gw="$(default_gw)"
  [[ -n "$sub" ]] && { ip rule add prio "$p" to "$sub" lookup main 2>/dev/null || true; p=$((p+1)); }
  [[ -n "$gw"  ]] && { ip rule add prio "$p" to "${gw}/32" lookup main 2>/dev/null || true; p=$((p+1)); }

  # 4) `suppress_prefixlength 0` on main: consult main for any SPECIFIC (non-
  #    default) route first — this is how wg-quick keeps the on-link route to the
  #    WARP endpoint (and any other specific routes) working, so the envelope
  #    exits via the native NIC. The endpoint no longer needs an explicit rule.
  ip rule add prio "$PRIO_SUPPRESS" table main suppress_prefixlength 0 2>/dev/null || true

  # 5) FINALLY: everything EXCEPT WireGuard's own envelope → WARP table. The
  #    `not fwmark` is what prevents the encrypted packets from looping back into
  #    the tunnel (they go out native to the endpoint instead).
  ip rule add prio "$PRIO_DEFAULT" not fwmark "$WG_FWMARK" lookup "$RT_TABLE" 2>/dev/null || true

  ip route flush cache 2>/dev/null || true
  log "policy routing installed (wg-quick-style fwmark=${WG_FWMARK}; control plane preserved: SSH ${SSH_PORT}, panel ${PANEL_PORT}, subnet ${sub:-?}, gw ${gw:-?})"
}

# ── remove every policy-routing artifact we added (idempotent) ────────────────
# BUG-169 + BUG-150 lesson: teardown MUST mirror route_up() exactly and be safe to
# call repeatedly even on a partially-applied state, so we never strand fwmark/
# rules/mangle entries that would silently break the next tunnel's return path.
route_down() {
  local dev="${WG_IFACE}"
  # 0) clear WireGuard's own envelope fwmark (no-op if iface already gone).
  wg set "$dev" fwmark 0 2>/dev/null || true

  # 1) delete our ip rules by priority. Covers management exceptions (9000-9010),
  #    suppress_prefixlength (PRIO_SUPPRESS) and the `not fwmark` default
  #    (PRIO_DEFAULT). Loop because several rules can share a priority slot.
  #    NB1: do NOT pipe `ip rule show | grep -q` as the loop condition — under
  #         `set -o pipefail` (active in this script) `grep -q` closes the pipe
  #         on first match, `ip rule show` gets SIGPIPE (141), pipefail makes the
  #         pipeline non-zero, and the `while` wrongly evaluates FALSE so the
  #         rule is never deleted (same SIGPIPE/pipefail class as BUG-166;
  #         observed live to strand prio 9000). We snapshot the table into a var
  #         and grep that instead.
  #    NB2: `|| true` (NOT `|| break`) + a bounded counter — a transient del
  #         hiccup must not abort cleanup, and the counter prevents infinite spin.
  local p n rules
  for p in $(seq "$PRIO_EXCEPT_BASE" $((PRIO_EXCEPT_BASE+10))) "$PRIO_SUPPRESS" "$PRIO_DEFAULT"; do
    n=0
    rules="$(ip rule show 2>/dev/null || true)"
    # pure-bash substring match (no pipe → no SIGPIPE/pipefail trap at all)
    while [[ $'\n'"$rules" == *$'\n'"${p}:"* ]]; do
      ip rule del prio "$p" 2>/dev/null || true
      n=$((n+1)); [ "$n" -ge 16 ] && break
      rules="$(ip rule show 2>/dev/null || true)"
    done
  done

  # 2) drop the WARP route table.
  ip route flush table "$RT_TABLE" 2>/dev/null || true

  # 3) remove every mangle rule we installed (WG envelope conntrack save/restore +
  #    BUG-171 inbound-connection connmark + BUG-170 MSS clamping). Mirrors
  #    route_up() step 2/2a/2b. Loop the MSS deletes: each chain may hold >1 copy
  #    if a prior partial run re-added them.
  if command -v iptables &>/dev/null; then
    iptables -t mangle -D POSTROUTING -m mark --mark "$WG_FWMARK" -p udp -j CONNMARK --save-mark 2>/dev/null || true
    iptables -t mangle -D PREROUTING -p udp -j CONNMARK --restore-mark 2>/dev/null || true
    # BUG-171: inbound-connection mark (PREROUTING) + its unconditional OUTPUT
    #   restore (the v2 shape that actually fires — no `-m connmark --mark` match).
    iptables -t mangle -D PREROUTING ! -i "$dev" -p tcp -m conntrack --ctstate NEW -j CONNMARK --set-mark "$MARK_CONN" 2>/dev/null || true
    iptables -t mangle -D OUTPUT -p tcp -j CONNMARK --restore-mark 2>/dev/null || true
    # HY2/QUIC (UDP) return-path mark — mirror of the TCP rules above (Hysteria2).
    #   BUG-173: current port-scoped shape (sport/dport = HY2_PORT).
    iptables -t mangle -D PREROUTING ! -i "$dev" -p udp --dport "$HY2_PORT" -m conntrack --ctstate NEW -j CONNMARK --set-mark "$MARK_CONN" 2>/dev/null || true
    iptables -t mangle -D OUTPUT -p udp --sport "$HY2_PORT" -j CONNMARK --restore-mark 2>/dev/null || true
    # BUG-173: purge the ORIGINAL broad v1.8.0 shape (unscoped `-p udp` on OUTPUT
    #   collided with WireGuard's own UDP envelope). An in-place upgrade or a
    #   partial prior run may have left it installed — delete it unconditionally
    #   so no orphan can keep black-holing the WARP return path.
    iptables -t mangle -D PREROUTING ! -i "$dev" -p udp -m conntrack --ctstate NEW -j CONNMARK --set-mark "$MARK_CONN" 2>/dev/null || true
    iptables -t mangle -D OUTPUT -p udp -j CONNMARK --restore-mark 2>/dev/null || true
    # legacy BUG-171 v1 (broken, ≤ first 1.5.7 build) + ≤v1.5.6 per-port shapes —
    #   purge so an upgrade from any prior build leaves no orphan mangle rules.
    iptables -t mangle -D OUTPUT -p tcp -m connmark --mark "$MARK_CONN" -j CONNMARK --restore-mark 2>/dev/null || true
    iptables -t mangle -D OUTPUT -m connmark --mark "$MARK_CONN" -j CONNMARK --restore-mark 2>/dev/null || true
    iptables -t mangle -D INPUT -p tcp --dport "${SSH_PORT:-22}"   -j CONNMARK --set-mark "$MARK_CONN" 2>/dev/null || true
    iptables -t mangle -D INPUT -p tcp --dport "${PANEL_PORT:-3000}" -j CONNMARK --set-mark "$MARK_CONN" 2>/dev/null || true
    # BUG-170: remove the TCP MSS clamping rules from BOTH chains.
    local c m
    for c in FORWARD OUTPUT; do
      for m in 1 2 3 4; do
        iptables -t mangle -D "$c" -o "$dev" -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --set-mss "$WARP_MSS" 2>/dev/null || true
        iptables -t mangle -D "$c" -o "$dev" -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu 2>/dev/null || true
      done
    done
    # legacy (pre-1.5.5) rule shapes — purge so an upgrade leaves no orphans.
    iptables -t mangle -D OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j CONNMARK --restore-mark 2>/dev/null || true
  fi

  ip route flush cache 2>/dev/null || true
  log "policy routing removed"
}

# ── BUG-164: verify the tunnel actually carries RETURN traffic ────────────────
# A one-way tunnel handshakes fine but `received` stays ≈ 0 B, so anything routed
# into the WARP table black-holes. We bind a probe to the warp interface and ask
# for our public egress IP; a Cloudflare IP back within the timeout proves the
# tunnel is bidirectional. We also sanity-check `wg show` transfer counters.
#
# Returns 0 (healthy) only if we get an egress IP through the interface.
warp_healthcheck() {
  local dev="${1:-$WG_IFACE}" ip="" rx=""
  # BUG-173: a freshly-registered WARP account needs a moment before its
  #   WireGuard endpoint reliably returns traffic. Previously we probed almost
  #   immediately (only a 1s sleep between curls), so the FIRST — and best —
  #   endpoint port (2408) frequently "failed" the handshake race, the loop
  #   cycled to inferior ports (500/1701/4500), and the whole run took 3-4 min
  #   before a false blocked_return. Wait (up to ~8s) for wg to record a real
  #   handshake FIRST, so the subsequent egress probe tests a warm tunnel.
  local h=""
  local w
  for w in 1 2 3 4 5 6 7 8; do
    h="$(wg show "$dev" latest-handshakes 2>/dev/null | awk '{print $2; exit}')"
    [[ "${h:-0}" =~ ^[0-9]+$ && "${h:-0}" -gt 0 ]] && break
    sleep 1
  done
  # Now probe the public egress IP THROUGH the warp interface (proves the tunnel
  # is bidirectional, not just handshaked).
  local i
  for i in 1 2 3; do
    ip="$(curl -s --interface "$dev" --max-time "$WARP_HEALTH_TIMEOUT" https://api.ipify.org 2>/dev/null)"
    [[ -z "$ip" ]] && ip="$(curl -s --interface "$dev" --max-time "$WARP_HEALTH_TIMEOUT" https://ifconfig.me 2>/dev/null)"
    [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] && break
    sleep 1
  done
  # Did we get a public IPv4 back through the tunnel?
  if [[ ! "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    err "healthcheck: no egress IP via ${dev} within ${WARP_HEALTH_TIMEOUT}s (one-way tunnel?)"
    rx="$(wg show "$dev" transfer 2>/dev/null | awk '{print $2; exit}')"
    [[ -n "$rx" ]] && err "healthcheck: wg received bytes = ${rx} (expect non-trivial)"
    return 1
  fi
  log "healthcheck OK — egress IP via ${dev}: ${ip}"
  echo "$ip"
  return 0
}

# Rewrite the [Peer] Endpoint port in the live conf (used by port-fallback).
set_endpoint_port() {
  local port="$1"
  [[ -f "$WG_CONF" ]] || return 1
  sed -i -E "s#^([[:space:]]*Endpoint[[:space:]]*=[[:space:]]*[^:]+):[0-9]+#\1:${port}#" "$WG_CONF"
}

# ── bring the interface up (no autostart, no healthcheck) ────────────────────
# Just (re)start wg-quick@warp and confirm the interface exists. Autostart is
# enabled ONLY later, AFTER the healthcheck passes (BUG-162 + BUG-164), so a bad
# tunnel can never be persisted into the boot path.
warp_iface_up() {
  systemctl stop "wg-quick@${WG_IFACE}" 2>/dev/null || true
  ip link del "$WG_IFACE" 2>/dev/null || true
  route_down  # clear any stale rules before re-applying
  if ! systemctl start "wg-quick@${WG_IFACE}" 2>/dev/null; then
    # Fall back to a direct wg-quick up if the unit is unavailable.
    wg-quick up "$WG_IFACE" 2>/dev/null || true
  fi
  ip link show "$WG_IFACE" &>/dev/null
}

# ── bring the tunnel up, VERIFY it, and only then (optionally) persist ────────
# BUG-164: the real failure was a ONE-WAY tunnel (handshake OK, received ≈ 0 B):
#   everything routed into the WARP table black-holed, the panel looked dead and
#   `curl ipify` on the server hung. We now:
#     1. bring the interface up,
#     2. run a healthcheck (egress IP via the warp iface within a few seconds),
#     3. if it fails, retry across the alternative Cloudflare endpoint ports,
#     4. if STILL unhealthy, AUTO-ROLL-BACK (warp_down) so the box is never left
#        in a black-hole — the panel & SSH stay reachable on the native route,
#     5. enable autostart ONLY for a proven-healthy tunnel (and only if
#        WARP_PERSIST=1). A bad tunnel is therefore never persisted.
#
# Prints the verified egress IP on success; dies (after rollback) on failure.
warp_up() {
  # BUG-162: never persist before we know the tunnel works.
  systemctl disable "wg-quick@${WG_IFACE}" 2>/dev/null || true

  # BUG-168: track the BEST outcome across all port attempts so we can classify
  #   the failure for the operator (provider block vs no connectivity vs success).
  local ok="" egress="" port first=1
  local any_handshake=0 best_rx=0 best_tx=0
  for port in $WARP_ENDPOINT_PORTS; do
    if [[ "$first" != "1" ]]; then
      log "healthcheck failed — retrying with WARP endpoint port ${port}…"
      warp_iface_down_soft
      set_endpoint_port "$port"
    fi
    first=0

    if ! warp_iface_up; then
      err "wg-quick up failed on port ${port} (interface not present)"
      continue
    fi
    # Scoped policy routing is installed by the conf's PostUp (route-up). Probe
    # the egress IP through the warp interface itself, so the healthcheck works
    # regardless of routing and proves the tunnel is bidirectional.

    if egress="$(warp_healthcheck "$WG_IFACE")"; then
      ok=1
      break
    fi

    # Failed on this port — record diagnostics for classification.
    local hs rx tx
    hs="$(wg show "$WG_IFACE" latest-handshakes 2>/dev/null | awk '{print $2; exit}')"
    rx="$(wg show "$WG_IFACE" transfer 2>/dev/null | awk '{print $2; exit}')"
    tx="$(wg show "$WG_IFACE" transfer 2>/dev/null | awk '{print $3; exit}')"
    [[ "${hs:-0}" =~ ^[0-9]+$ && "${hs:-0}" -gt 0 ]] && any_handshake=1
    [[ "${rx:-0}" =~ ^[0-9]+$ && "${rx:-0}" -gt "$best_rx" ]] && best_rx="$rx"
    [[ "${tx:-0}" =~ ^[0-9]+$ && "${tx:-0}" -gt "$best_tx" ]] && best_tx="$tx"
  done

  if [[ "$ok" != "1" ]]; then
    # BUG-164: do NOT leave a black-holed tunnel up. Roll everything back so the
    # operator keeps native access; surfaces as a clear error to the panel.
    warp_down
    # BUG-168: emit a STRUCTURED, machine-readable classification line the panel
    #   parses to show a friendly (non-error) explanation. The two failure modes:
    #     • handshake OK but no return data  → provider blocks WARP return traffic
    #     • no handshake on any port         → provider blocks UDP / no reachability
    if [[ "$any_handshake" == "1" ]]; then
      echo "WARP_RESULT=blocked_return handshake=ok rx=${best_rx} tx=${best_tx} ports=${WARP_ENDPOINT_PORTS}"
      die "WARP handshake succeeded but no return traffic on any port (provider blocks Cloudflare WARP/WireGuard return); rolled back — server access preserved (rx=${best_rx}B tx=${best_tx}B)"
    else
      echo "WARP_RESULT=no_handshake handshake=none rx=${best_rx} tx=${best_tx} ports=${WARP_ENDPOINT_PORTS}"
      die "WARP could not connect to Cloudflare on any port (${WARP_ENDPOINT_PORTS}) — provider likely blocks UDP; rolled back — server access preserved"
    fi
  fi

  # Healthy tunnel → now it is safe to (optionally) enable autostart.
  if [[ "${WARP_PERSIST:-0}" == "1" ]]; then
    systemctl enable "wg-quick@${WG_IFACE}" 2>/dev/null || true
    log "autostart ENABLED (WARP_PERSIST=1, healthy tunnel)"
  else
    log "autostart DISABLED (default) — WARP will NOT survive reboot"
  fi
  # BUG-168: structured success line for the panel (shows the CF egress IP green).
  echo "WARP_RESULT=ok egressIP=${egress} port=${port}"
  log "WARP egress is UP and verified (egress IP ${egress})"
}

# Soft interface-down used between port-fallback attempts: stop the tunnel and
# remove routing, but keep the generated conf (we just rewrite its port).
warp_iface_down_soft() {
  route_down
  systemctl stop "wg-quick@${WG_IFACE}" 2>/dev/null || true
  wg-quick down "$WG_IFACE" 2>/dev/null || true
  ip link del "$WG_IFACE" 2>/dev/null || true
}

# ── full, idempotent teardown — leave NO artifacts ────────────────────────────
warp_down() {
  systemctl stop "wg-quick@${WG_IFACE}" 2>/dev/null || true
  systemctl disable "wg-quick@${WG_IFACE}" 2>/dev/null || true
  # PreDown in the conf calls route-down, but call it again here so teardown is
  # robust even if the interface is already gone / conf was removed.
  route_down
  # Direct down in case it was started outside systemd.
  wg-quick down "$WG_IFACE" 2>/dev/null || true
  # Hard-remove the interface if anything is left behind.
  ip link del "$WG_IFACE" 2>/dev/null || true
  # Legacy cleanup: v1.5.1 used wg-quick Table=auto with fwmark 0xca6c — remove
  # any lingering rule/table from a box that ran the old (broken) version.
  local legacy="0xca6c" lrules ln=0
  lrules="$(ip rule show 2>/dev/null || true)"
  while [[ "$lrules" == *"fwmark ${legacy}"* ]]; do
    ip rule del fwmark "${legacy}" 2>/dev/null || true
    ln=$((ln+1)); [ "$ln" -ge 16 ] && break
    lrules="$(ip rule show 2>/dev/null || true)"
  done
  ip route flush table "$((16#ca6c))" 2>/dev/null || true
  # Remove the generated interface config so a stale conf can't be re-applied.
  rm -f "$WG_CONF"
  ip route flush cache 2>/dev/null || true
  log "WARP egress torn down (interface, routes, rules, marks, conf removed)"
}

# ── measure the public egress IP (what the world sees) ───────────────────────
measure_egress_ip() {
  local ip=""
  ip="$(curl -s --max-time 8 https://api.ipify.org 2>/dev/null)"
  [[ -z "$ip" ]] && ip="$(curl -s --max-time 8 https://ifconfig.me 2>/dev/null)"
  echo "$ip"
}

# Cloudflare's own trace endpoint reports warp=on/off + the egress IP.
warp_trace() {
  curl -s --max-time 8 https://www.cloudflare.com/cdn-cgi/trace 2>/dev/null
}

# ─────────────────────────────────────────────────────────────────────────────
do_setup() {
  ensure_packages
  ensure_profile
  build_wg_conf
  warp_up
  sleep 2
  do_status || true
}

do_teardown() {
  warp_down
}

do_status() {
  local active="inactive" handshake="" egress="" warp_flag="" rx="" tx=""
  if ip link show "$WG_IFACE" &>/dev/null; then
    active="active"
    handshake="$(wg show "$WG_IFACE" latest-handshakes 2>/dev/null | awk '{print $2}' | head -1)"
    # BUG-164: surface the transfer counters so a one-way tunnel is obvious
    #   (rx ≈ 0 with tx large == black-hole).
    rx="$(wg show "$WG_IFACE" transfer 2>/dev/null | awk '{print $2; exit}')"
    tx="$(wg show "$WG_IFACE" transfer 2>/dev/null | awk '{print $3; exit}')"
  fi
  egress="$(measure_egress_ip)"
  warp_flag="$(warp_trace | awk -F= '/^warp=/{print $2}')"
  echo "iface        : ${WG_IFACE}"
  echo "state        : ${active}"
  echo "handshake    : ${handshake:-none}"
  echo "rxBytes      : ${rx:-0}"
  echo "txBytes      : ${tx:-0}"
  echo "egressIP     : ${egress:-unknown}"
  echo "warp         : ${warp_flag:-unknown}"
  echo "mtu          : ${WARP_MTU}"
  echo "mss          : ${WARP_MSS}"
  # exit 0 if the interface is up; non-zero otherwise (callers may ignore).
  [[ "$active" == "active" ]]
}

ACTION="${1:-}"
case "$ACTION" in
  setup)      do_setup ;;
  teardown)   do_teardown ;;
  status)     do_status ;;
  egress-ip)  measure_egress_ip ;;
  healthcheck) warp_healthcheck "${2:-$WG_IFACE}" ;;
  # Called by wg-quick PostUp/PreDown (%i = interface). Internal use.
  route-up)   route_up "${2:-$WG_IFACE}" ;;
  route-down) route_down ;;
  *) die "unknown action '$ACTION' (use: setup|teardown|status|egress-ip|healthcheck)" ;;
esac
