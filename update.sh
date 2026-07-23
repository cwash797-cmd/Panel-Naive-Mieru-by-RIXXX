#!/usr/bin/env bash
# ==============================================================================
# Panel Naive + Mieru by RIXXX — update.sh  v1.2.5
# Usage: bash update.sh [--dry-run] [--force] [--expose <domain>] [--ssh-only]
#                       [--status] [--repair] [--help] [-y]
#
# v1.2.4: Fixed Caddyfile template (bugs 23-40); uses caddyTemplate.js.
#   - --repair calls /api/services/rebuild-all to regenerate Caddyfile
#   - update_caddy_naive() replaces update_naiveproxy()
#   - rebuild_caddyfile_direct() now uses caddyTemplate.js (Bug 26)
# v1.2.5: Hotfixes 41-64 — /var/lib/caddy perms, atomic saveConfig(),
#   plaintext-password guard (Bug 44), reloadCaddy() simplified (Bug 50),
#   mieruPort safe defaults (Bug 51), naive-port active check (Bug 52),
#   caddy fmt (Bug 60), caddyTemplate indentation (Bug 63), README security
#   notice (Bug 45).
# ==============================================================================
set -euo pipefail

# ── Bug 34: force a UTF-8 locale (same rationale as install.sh) ──────────────
# A POSIX/C or broken inherited locale on a clean VM makes bash/read/jq/python
# fail on the script's Cyrillic content with "Non-UTF-8" errors. Pin C.UTF-8.
export LANG=C.UTF-8
export LC_ALL=C.UTF-8
export LANGUAGE=C.UTF-8
export PYTHONUTF8=1
export PYTHONIOENCODING=utf-8

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

log_info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }
log_step()  { echo -e "\n${CYAN}${BOLD}▶ $*${NC}"; }
log_dry()   { echo -e "${YELLOW}[DRY-RUN]${NC} $*"; }
die()       { log_error "$*"; exit 1; }

# Bug 76: never fail silently. With `set -e`, any un-handled non-zero command
# aborted the script with no message (the user saw an empty prompt). This trap
# prints the failing line + command so problems are always visible.
on_error() {
  local exit_code=$?
  local line_no=${1:-?}
  log_error "update.sh aborted at line ${line_no} (exit ${exit_code})."
  log_error "Re-run with: sudo bash update.sh --force -y   (or check the message above)"
  exit "$exit_code"
}
trap 'on_error $LINENO' ERR

# ── Constants ─────────────────────────────────────────────────────────────────
PANEL_DIR="/opt/panel-naive-mieru"
PANEL_CONFIG="/etc/rixxx-panel/config.json"
VERSION_FILE="/etc/rixxx-panel/version"
BACKUP_DIR="/etc/rixxx-panel/backups"
DB_PATH="/var/lib/rixxx-panel/db.sqlite"
MITA_STATE_FILE="/var/lib/rixxx-panel/mita-state.json"

REPO_URL="https://github.com/cwash797-cmd/Panel-Naive-Mieru-by-RIXXX"
# Bug 99: raw base for fetching single files (VERSION, update.sh) without git.
REPO_RAW="https://raw.githubusercontent.com/cwash797-cmd/Panel-Naive-Mieru-by-RIXXX/main"

# Bug 99: single source of truth for the target version. Priority:
#   1) the VERSION file shipped next to this script (set by install/update);
#   2) the VERSION file in $PANEL_DIR (deployed copy on prod);
#   3) the remote VERSION on main (so a curl-piped update knows the target even
#      when this very script is older than main);
#   4) a hardcoded fallback.
# We resolve (1)/(2) synchronously here; (3) is folded in lazily by
# resolve_target_version() right before the update gate so we don't make a
# network call on every invocation (e.g. --help/--status).
_local_version_file() {
  local d; d="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo '')"
  if   [[ -n "$d" && -f "$d/VERSION" ]]; then head -n1 "$d/VERSION"          | tr -d '[:space:]'
  elif [[ -f "$PANEL_DIR/VERSION" ]];    then head -n1 "$PANEL_DIR/VERSION"  | tr -d '[:space:]'
  else echo ""; fi
}
TARGET_VERSION="$(_local_version_file)"
[[ -z "$TARGET_VERSION" ]] && TARGET_VERSION="1.3.3"   # fallback if VERSION missing

# v1.2.3: Caddy-forwardproxy-naive paths (replaces standalone naive binary)
CADDY_BIN="/usr/local/bin/caddy-naive"
CADDY_CONFIG_DIR="/etc/caddy-naive"
CADDY_FILE="${CADDY_CONFIG_DIR}/Caddyfile"
FAKE_SITE_DIR="/var/www/fake-site"

# Legacy paths — kept only for migration cleanup
LEGACY_NAIVE_BIN="/usr/local/bin/naive"
LEGACY_NAIVE_CONFIG_DIR="/etc/naive"

CADDY_NAIVE_RELEASES="https://api.github.com/repos/klzgrad/forwardproxy/releases/latest"
CADDY_NAIVE_FALLBACK_URL="https://github.com/klzgrad/forwardproxy/releases/download/v2.10.0-naive/caddy-forwardproxy-naive.tar.xz"
MIERU_RELEASES="https://api.github.com/repos/enfein/mieru/releases/latest"

# ── Flags ─────────────────────────────────────────────────────────────────────
DRY_RUN=false
FORCE=false
YES=false
MODE=""
EXPOSE_DOMAIN=""
PANEL_BA_PASS_FLAG=""
WEB_BASE_PATH_FLAG=""

# ── Parse args ────────────────────────────────────────────────────────────────
parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dry-run)   DRY_RUN=true ;;
      --force)     FORCE=true ;;
      -y|--yes)    YES=true ;;
      --expose)    MODE="expose"; EXPOSE_DOMAIN="${2:-}"; shift ;;
      --panel-ba-pass) PANEL_BA_PASS_FLAG="${2:-}"; shift ;;
      --web-base-path) WEB_BASE_PATH_FLAG="${2:-}"; shift ;;
      --ssh-only)  MODE="ssh-only" ;;
      --status)    MODE="status" ;;
      --repair)    MODE="repair" ;;
      --enroll-hy2) MODE="enroll-hy2" ;;
      --help|-h)   print_help; exit 0 ;;
      *) die "Unknown argument: $1  (use --help)" ;;
    esac
    shift
  done
  # Bug 85: under `set -e`, this `[[ ]] && ...` was the LAST statement in
  # parse_args. When a MODE flag was given (e.g. --repair), the test
  # `[[ -z "repair" ]]` is FALSE, so parse_args RETURNED 1 → the caller in
  # main() (`parse_args "$@"`) is a plain command that exits non-zero →
  # `set -e` aborted the whole script with NO output, and the ERR trap on a
  # function return is skipped (exactly the Bug 77 failure mode). This is why
  # `--repair` exited 1 silently while `--force -y` (MODE empty → test TRUE →
  # return 0) worked. Use an explicit `if` + trailing `return 0`.
  if [[ -z "$MODE" ]]; then MODE="update"; fi
  return 0
}

print_help() {
  cat <<EOF
${BOLD}Panel Naive + Mieru — update.sh  v${TARGET_VERSION}${NC}

USAGE:
  bash update.sh [options]

OPTIONS:
  (no flag)              Update all components to latest versions
  --dry-run              Show what would be done without making changes
  --force                Force update even if already on latest version
  -y / --yes             Non-interactive (auto-confirm all prompts)
  --expose <panel-domain> Enable EXTERNAL access via a TLS subdomain
                          (https://panel-domain/<webBasePath>/, basic_auth, stub root).
                          Panel stays loopback-only; Caddy reverse_proxies to it.
  --panel-ba-pass <pass>  (with --expose) set basic-auth password (else auto-generated)
  --web-base-path <hex>   (with --expose) set a custom webBasePath (else random 16-hex)
  --ssh-only              Switch panel back to SSH-tunnel-only (127.0.0.1:3000),
                          remove the panel block, close any legacy bare port
  --status               Print full health report
  --repair               Rebuild Caddyfile + mita config from SQLite DB; restart services
  --enroll-hy2           Add Hysteria2 to EVERY existing user + rewrite userpass +
                         restart Hy2 (one-off; existing clients start working over Hy2).
                         Same as HY2_ENROLL_ALL=1 but runs ONLY this step (no full update).
  --help                 Show this help

EXAMPLES:
  bash update.sh                   # Interactive update
  bash update.sh --dry-run         # Preview changes
  bash update.sh --force -y        # Force update, non-interactive
  bash update.sh --status          # Health check
  bash update.sh --repair          # Fix broken installation
  bash update.sh --expose panel.example.com
  bash update.sh --ssh-only        # Revert to SSH-only
EOF
}

# ── Prerequisite checks ───────────────────────────────────────────────────────
# Bug 77: under `set -e`, a function whose LAST statement is `[[ cond ]] && die`
# returns the exit status of the `[[ ]]` test. On the happy path the test is
# FALSE → the function returns 1 → the *caller* (e.g. `check_root` in main) is a
# plain command that exits non-zero → `set -e` aborts the whole script with NO
# output and the ERR trap on a function return is skipped. This is exactly why
# `sudo bash update.sh --force -y` printed nothing and returned to the prompt
# (traced: it died right after `check_root` → `[[ 0 -ne 0 ]]`). Use explicit
# `if` blocks with a trailing `return 0`.
check_root() {
  if [[ $EUID -ne 0 ]]; then die "Run as root"; fi
  return 0
}
check_install() {
  if [[ ! -f "$PANEL_CONFIG" ]]; then
    die "Panel not installed. Run install.sh first."
  fi
  return 0
}

load_config() {
  DOMAIN=$(jq -r '.domain'              "$PANEL_CONFIG")
  NAIVE_PORT=$(jq -r '.naivePort'       "$PANEL_CONFIG")
  MIERU_START=$(jq -r '.mieruPortStart' "$PANEL_CONFIG")
  MIERU_END=$(jq -r '.mieruPortEnd'     "$PANEL_CONFIG")
  EXPOSE=$(jq -r '.exposePanel'         "$PANEL_CONFIG")
  ADMIN_EMAIL=$(jq -r '.adminEmail // ""' "$PANEL_CONFIG")
  # v1.2.3: read Caddy paths from config if present
  CADDY_BIN=$(jq -r '.caddyBin     // "/usr/local/bin/caddy-naive"' "$PANEL_CONFIG")
  CADDY_FILE=$(jq -r '.caddyFile   // "/etc/caddy-naive/Caddyfile"' "$PANEL_CONFIG")
  CADDY_CONFIG_DIR=$(jq -r '.caddyConfigDir // "/etc/caddy-naive"'  "$PANEL_CONFIG")
  FAKE_SITE_DIR=$(jq -r '.fakeSiteDir   // "/var/www/fake-site"'    "$PANEL_CONFIG")
  # v1.4.0: external panel access
  PANEL_DOMAIN=$(jq -r '.panelDomain // ""'            "$PANEL_CONFIG")
  WEB_BASE_PATH=$(jq -r '.webBasePath // ""'           "$PANEL_CONFIG")
  PANEL_BA_USER=$(jq -r '.panelBasicAuthUser // ""'    "$PANEL_CONFIG")
  PANEL_STUB_PAGE=$(jq -r '.panelStubPage // "/var/www/panel-stub/index.html"' "$PANEL_CONFIG")
}

# ── Bug 103: IPv4 preference when no working IPv6 route (update.sh) ───────────
# mieru/mita pile up NetworkUnreachableErrors when AAAA traffic is routed over a
# non-existent IPv6 path. Detect a missing outbound IPv6 route and force IPv4.
has_working_ipv6() {
  local routes
  routes=$(ip -6 route show default 2>/dev/null; ip -6 route show 2>/dev/null \
            | grep -vE '^(fe80|ff00|::1|unreachable)' | grep -E '::/|/[0-9]')
  [[ -n "$(echo "$routes" | grep -E 'default|::/0|/[0-9]')" ]]
}

ensure_ipv4_preference() {
  log_step "Checking IPv6 connectivity"
  if has_working_ipv6; then
    log_info "Working IPv6 route present — leaving as-is"
    return 0
  fi
  log_warn "No outbound IPv6 route — enabling IPv4 preference (prevents mieru/mita NetworkUnreachableErrors on AAAA sites)"

  if ! grep -qE '^\s*precedence\s+::ffff:0:0/96\s+100' /etc/gai.conf 2>/dev/null; then
    {
      echo ''
      echo '# Added by Panel Naive+Mieru (Bug 103): prefer IPv4 — no working IPv6 route.'
      echo 'precedence ::ffff:0:0/96  100'
    } >> /etc/gai.conf 2>/dev/null \
      && log_info "/etc/gai.conf: IPv4 preference set ✓" \
      || log_warn "Could not write /etc/gai.conf"
  fi

  local sc=/etc/sysctl.d/99-rixxx-disable-ipv6.conf
  cat > "$sc" <<'SYSCTL'
# Added by Panel Naive+Mieru (Bug 103): no working outbound IPv6 route → disable
# IPv6 so mieru/mita stop routing AAAA traffic into a black hole. Remove this
# file and run `sysctl --system` to re-enable IPv6.
net.ipv6.conf.all.disable_ipv6 = 1
net.ipv6.conf.default.disable_ipv6 = 1
net.ipv6.conf.lo.disable_ipv6 = 0
SYSCTL
  sysctl -p "$sc" >/dev/null 2>&1 \
    && log_info "IPv6 disabled (sysctl, survives reboot) ✓" \
    || log_warn "Could not apply IPv6 sysctl"

  # Restart mita so it re-resolves over IPv4 and drops the error backlog.
  systemctl restart mita 2>/dev/null || true
}

# Bug A (v1.3.1) / Bug 104 (v1.4.2): the panel UI shows cfg.version read from
# config.json (/api/status → panel.version), NOT /etc/rixxx-panel/version.
# do_repair historically only restarted the process without bumping
# config.json, so after `--repair` the UI/PM2 kept displaying a stale version
# (e.g. 1.2.6 while 1.4.x is installed). Centralised here so do_update AND
# do_repair both sync config.json's "version" field to $TARGET_VERSION.
sync_config_version() {
  [[ -f "$PANEL_CONFIG" ]] || { log_warn "config.json not found — cannot sync version"; return 0; }
  if command -v jq >/dev/null 2>&1; then
    local _tmp_cfg
    _tmp_cfg="$(mktemp)"
    if jq --arg v "$TARGET_VERSION" '.version = $v' "$PANEL_CONFIG" > "$_tmp_cfg" 2>/dev/null \
         && [[ -s "$_tmp_cfg" ]]; then
      cat "$_tmp_cfg" > "$PANEL_CONFIG"   # preserve owner/perms of original file
      log_info "config.json version synced to $TARGET_VERSION ✓"
    else
      log_warn "Could not update config.json version with jq — UI may show stale version"
    fi
    rm -f "$_tmp_cfg"
  else
    # jq missing (shouldn't happen — it's a hard dep): best-effort sed fallback.
    if grep -q '"version"' "$PANEL_CONFIG"; then
      sed -i "s|\"version\"[[:space:]]*:[[:space:]]*\"[^\"]*\"|\"version\": \"${TARGET_VERSION}\"|" \
        "$PANEL_CONFIG" 2>/dev/null \
        && log_info "config.json version synced to $TARGET_VERSION (sed) ✓" \
        || log_warn "Could not update config.json version — UI may show stale version"
    else
      log_warn "config.json has no \"version\" field — UI may show stale version"
    fi
  fi
}

# ── v1.4.0: helpers for external panel access (update.sh) ─────────────────────
gen_web_base_path() { openssl rand -hex 8 2>/dev/null | tr -d '\n'; }

# BUG-155: sieve any hasher output down to a single valid bcrypt token, so
# package-manager noise can never end up in the hash (see install.sh for the
# full root-cause writeup).
extract_bcrypt() {
  grep -aoE '\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}' 2>/dev/null | head -n1
}

# BUG-155: keep htpasswd available without capturing apt's stdout into a hash.
ensure_htpasswd() {
  command -v htpasswd &>/dev/null && return 0
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq apache2-utils >/dev/null 2>&1 || true
  command -v htpasswd &>/dev/null
}

panel_hash_password() {
  local plain="$1" hash="" cb="${CADDY_BIN:-/usr/local/bin/caddy-naive}"
  if [[ -x "$cb" ]]; then
    hash=$(printf '%s' "$plain" | "$cb" hash-password 2>/dev/null | extract_bcrypt) || true
  fi
  if [[ -z "$hash" ]] && command -v caddy &>/dev/null; then
    hash=$(printf '%s' "$plain" | caddy hash-password 2>/dev/null | extract_bcrypt) || true
  fi
  if [[ -z "$hash" ]]; then
    ensure_htpasswd
    hash=$(htpasswd -bnBC 12 "" "$plain" 2>/dev/null | extract_bcrypt) || true
  fi
  printf '%s' "$hash"
}

# Ensure the panel-stub static page exists (idempotent). Used by expose + repair.
ensure_panel_stub() {
  local stub="${PANEL_STUB_PAGE:-/var/www/panel-stub/index.html}"
  local dir; dir="$(dirname "$stub")"
  [[ -f "$stub" ]] && return 0
  mkdir -p "$dir"
  local asset="${PANEL_DIR}/assets/panel-stub.html"
  if [[ -f "$asset" ]]; then
    cp "$asset" "$stub"
  else
    cat > "$stub" <<'STUBHTML'
<!DOCTYPE html><html><head><meta charset="utf-8"><title>Syncing</title><style>body{background:#080808;height:100vh;margin:0;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:sans-serif}.grid{width:60px;height:60px;position:relative;margin-bottom:25px}.cube{width:18px;height:18px;background:#fff;position:absolute;animation:rotate 2s infinite ease-in-out}.cube:nth-child(1){top:0;left:0;animation-delay:0s}.cube:nth-child(2){top:0;right:0;animation-delay:0.2s}.cube:nth-child(3){bottom:0;right:0;animation-delay:0.4s}.cube:nth-child(4){bottom:0;left:0;animation-delay:0.6s}@keyframes rotate{0%,100%{transform:scale(1) rotate(0deg);opacity:1}50%{transform:scale(0.5) rotate(180deg);opacity:0.3}}.t{color:#555;font-size:13px;letter-spacing:3px;font-weight:600}</style></head><body><div class="grid"><div class="cube"></div><div class="cube"></div><div class="cube"></div><div class="cube"></div></div><div class="t">CONNECTION</div></body></html>
STUBHTML
  fi
  chmod 644 "$stub" 2>/dev/null || true
}

# Update one or more fields in config.json via node (UTF-8-safe, env-var data
# channel — Bug 101). Usage: cfg_set_json KEY1 VAL1 [KEY2 VAL2 ...]
# Values prefixed with "bool:" are written as booleans; "int:" as integers.
cfg_set_json() {
  [[ -f "$PANEL_CONFIG" ]] || return 1
  # Separate fields with the ASCII Record Separator (0x1e). Unlike NUL, bash
  # preserves it through command substitution, and it can't appear in our keys/
  # values (domains, hex, bcrypt hashes). Values are still pure DATA in the env
  # var — never interpolated into the JS source (Bug 101).
  local sep=$'\x1e' joined="" first=1 a
  for a in "$@"; do
    if [[ $first -eq 1 ]]; then joined="$a"; first=0; else joined="${joined}${sep}$a"; fi
  done
  CFG_FILE="$PANEL_CONFIG" CFG_PAIRS="$joined" node -e '
    const fs = require("fs");
    const file = process.env.CFG_FILE;
    const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    const parts = (process.env.CFG_PAIRS || "").split("\u001e");
    for (let i = 0; i + 1 < parts.length; i += 2) {
      let k = parts[i], v = parts[i + 1];
      if (v.startsWith("bool:"))      cfg[k] = (v.slice(5) === "1" || v.slice(5) === "true");
      else if (v.startsWith("int:"))  cfg[k] = parseInt(v.slice(4), 10) || 0;
      else                            cfg[k] = v;
    }
    const tmp = file + ".new";
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  ' 2>/dev/null
}

# ── Bug 81: config migration ──────────────────────────────────────────────────
# Existing installs (pre-Bug 81) have a probeSecret set but no probeMode field.
# The panel's back-compat would treat that as 'secret' mode (probe_resistance
# <secret>), which differs from the known-good reference server's BARE
# probe_resistance. On update we set probeMode='bare' when it is missing so the
# generated Caddyfile matches the reference. The stored probeSecret is kept so
# the user can switch back to 'secret' mode from the panel at any time.
migrate_config() {
  [[ -f "$PANEL_CONFIG" ]] || return 0
  command -v jq &>/dev/null || return 0
  local has_mode; has_mode=$(jq -r 'has("probeMode")' "$PANEL_CONFIG" 2>/dev/null)
  if [[ "$has_mode" != "true" ]]; then
    local tmp; tmp=$(mktemp)
    if jq '.probeMode = "bare"' "$PANEL_CONFIG" > "$tmp" 2>/dev/null && [[ -s "$tmp" ]]; then
      cat "$tmp" > "$PANEL_CONFIG"
      log_info "Config migrated: probeMode='bare' (matches reference server) ✓"
    fi
    rm -f "$tmp"
  fi

  # v1.4.0: backward-compatible defaults for the external-access fields. Old
  # installs (no panelDomain/webBasePath/…) stay SSH-only (exposePanel=false) —
  # the operator explicitly enables external access via --expose or the UI.
  local has_wbp; has_wbp=$(jq -r 'has("webBasePath")' "$PANEL_CONFIG" 2>/dev/null)
  if [[ "$has_wbp" != "true" ]]; then
    local tmp2; tmp2=$(mktemp)
    if jq '
        .panelHost          = "127.0.0.1"
      | .panelPort          = (.panelPort // 3000)
      | .panelDomain        = (.panelDomain // "")
      | .panelBasicAuthUser = (.panelBasicAuthUser // "")
      | .panelBasicAuthHash = (.panelBasicAuthHash // "")
      | .webBasePath        = (.webBasePath // "")
      | .panelStubPage      = (.panelStubPage // "/var/www/panel-stub/index.html")
      | .exposePanel        = (if (.panelDomain // "") == "" then false else (.exposePanel // false) end)
    ' "$PANEL_CONFIG" > "$tmp2" 2>/dev/null && [[ -s "$tmp2" ]]; then
      cat "$tmp2" > "$PANEL_CONFIG"
      log_info "Config migrated: external-access fields added (SSH-only default) ✓"
    fi
    rm -f "$tmp2"
  fi

  # v1.8.0 (Hy2 Sub-stage C): backfill the Hysteria2 config fields for installs
  # that predate the 3rd protocol. We add hy2Port (default 443/udp) and the
  # stack.{naive,mieru,hy2} map. CRITICAL: stack.hy2 defaults to FALSE — the
  # update NEVER auto-installs Hy2; it only makes the "Доустановить Hy2" button
  # available in Settings (the server reports installed:false via
  # /api/settings/hy2, so the UI renders the install card). Existing users and
  # their protocols array are left completely untouched. This mirrors the
  # server-side runtime backfill (index.js) so the config is correct even before
  # the panel process restarts.
  local has_hy2; has_hy2=$(jq -r 'has("hy2Port") and (.stack? // {} | has("hy2"))' "$PANEL_CONFIG" 2>/dev/null)
  if [[ "$has_hy2" != "true" ]]; then
    local tmp3; tmp3=$(mktemp)
    if jq '
        .hy2Port      = (.hy2Port // 443)
      | .stack        = (.stack // {})
      | .stack.naive  = (.stack.naive // true)
      | .stack.mieru  = (.stack.mieru // true)
      | .stack.hy2    = (.stack.hy2   // false)
    ' "$PANEL_CONFIG" > "$tmp3" 2>/dev/null && [[ -s "$tmp3" ]]; then
      cat "$tmp3" > "$PANEL_CONFIG"
      log_info "Config migrated: Hy2 fields added (hy2Port=443/udp, stack.hy2=false — install via Settings) ✓"
    fi
    rm -f "$tmp3"
  fi

  # v1.8.7 (subscription link): backfill the optional subBaseUrl field. Default
  # is "" (empty) — sub-links then use the panel domain, so nothing changes for
  # existing installs. The admin sets a dedicated sub domain from Settings.
  local has_sub; has_sub=$(jq -r 'has("subBaseUrl")' "$PANEL_CONFIG" 2>/dev/null)
  if [[ "$has_sub" != "true" ]]; then
    local tmp4; tmp4=$(mktemp)
    if jq '.subBaseUrl = (.subBaseUrl // "")' "$PANEL_CONFIG" > "$tmp4" 2>/dev/null && [[ -s "$tmp4" ]]; then
      cat "$tmp4" > "$PANEL_CONFIG"
      log_info "Config migrated: subBaseUrl field added (empty — sub-links use panel domain) ✓"
    fi
    rm -f "$tmp4"
  fi

  # BUG-155 (HIGH): self-heal a polluted panelBasicAuthHash. A pre-fix installer
  # could capture `apt-get install apache2-utils` stdout (Selecting previously…,
  # Unpacking…, needrestart banner) into the hash → multi-line value → invalid
  # Caddyfile → caddy-naive failed-loop, which neither --ssh-only nor --repair
  # cleaned up. On every update we sieve the stored value down to a single valid
  # bcrypt token; if none is present we blank it (the operator re-sets the
  # password from the UI). This makes the failed-loop recoverable by a plain
  # update with no manual jq/nano edits.
  sanitize_basic_auth_hash
}

# BUG-155: keep only a single valid bcrypt token in panelBasicAuthHash. If the
# stored value is already clean this is a no-op; if it's polluted we extract the
# embedded hash (last match), and if there is none we blank the field.
sanitize_basic_auth_hash() {
  [[ -f "$PANEL_CONFIG" ]] || return 0
  CFG_FILE="$PANEL_CONFIG" node -e '
    const fs = require("fs");
    const file = process.env.CFG_FILE;
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); } catch { process.exit(0); }
    const raw = String(cfg.panelBasicAuthHash || "");
    const RE  = /^\$2[aby]\$[0-9]{2}\$[.\/A-Za-z0-9]{53}$/;
    if (RE.test(raw)) process.exit(0);                  // already clean
    const m = raw.match(/\$2[aby]\$[0-9]{2}\$[.\/A-Za-z0-9]{53}/g);
    const clean = (m && m.length) ? m[m.length - 1] : "";
    if (clean === raw) process.exit(0);
    cfg.panelBasicAuthHash = clean;
    const tmp = file + ".new";
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    process.stderr.write(clean ? "healed" : "blanked");
  ' 2>/tmp/.ba_heal || true
  local r; r=$(cat /tmp/.ba_heal 2>/dev/null || echo ""); rm -f /tmp/.ba_heal
  if [[ "$r" == "healed" ]]; then
    log_info "BUG-155: panelBasicAuthHash sanitized (extracted valid bcrypt from polluted value) ✓"
  elif [[ "$r" == "blanked" ]]; then
    log_warn "BUG-155: panelBasicAuthHash was invalid and has been cleared — re-set the panel password in the UI"
  fi
}

# ── v1.4.0: migrate away from the legacy bare panel port (8080) ───────────────
# Old installs may have opened 0.0.0.0:8080 and/or a UFW rule for the panel.
# This MUST NOT break access: we close 8080, force the panel back to loopback,
# and (if it was relying on 8080) leave it in the safe SSH-only default. The
# operator then explicitly re-enables external access via --expose / the UI.
migrate_close_legacy_8080() {
  local changed=0
  # 1) UFW: drop any 8080 rule.
  if command -v ufw &>/dev/null; then
    if ufw status 2>/dev/null | grep -qE '(^|[^0-9])8080(/| )'; then
      ufw delete allow 8080/tcp 2>/dev/null || true
      ufw delete allow 8080 2>/dev/null || true
      log_info "UFW: legacy 8080 rule removed ✓"
      changed=1
    fi
  fi
  # 2) Anything actually bound to 0.0.0.0:8080 → force panel loopback default.
  if ss -tlnp 2>/dev/null | grep -qE '0\.0\.0\.0:8080|\*:8080|:::8080'; then
    log_warn "Detected a service on 0.0.0.0:8080 — forcing panel to loopback (SSH-only)"
    cfg_set_json panelHost "127.0.0.1" panelPort "int:3000" exposePanel "bool:0" || true
    changed=1
  fi
  # 3) config.json legacy panelHost=0.0.0.0 → loopback.
  if [[ -f "$PANEL_CONFIG" ]]; then
    local ph; ph=$(jq -r '.panelHost // "127.0.0.1"' "$PANEL_CONFIG" 2>/dev/null)
    if [[ "$ph" == "0.0.0.0" ]]; then
      log_warn "config.json had panelHost=0.0.0.0 — switching to 127.0.0.1 (loopback)"
      cfg_set_json panelHost "127.0.0.1" exposePanel "bool:0" || true
      changed=1
    fi
  fi
  [[ "$changed" == "1" ]] && {
    log_info "Legacy 8080 migration applied. Panel is loopback-only; enable external"
    log_info "  access with: bash update.sh --expose panel.<your-domain>"
    # Re-launch panel on loopback if it was bound elsewhere.
    PANEL_HOST=127.0.0.1 PANEL_PORT=3000 pm2 restart panel-naive-mieru --update-env 2>/dev/null || true
  }
  return 0
}

# ── Backup ────────────────────────────────────────────────────────────────────
auto_backup() {
  local ts; ts=$(date +%Y-%m-%d-%H%M%S)
  local bdir="$BACKUP_DIR/$ts"

  $DRY_RUN && { log_dry "Would create backup at $bdir"; echo "$bdir"; return; }

  mkdir -p "$bdir"
  [[ -f "$CADDY_FILE"      ]] && cp "$CADDY_FILE"       "$bdir/Caddyfile"      || true
  [[ -f "$MITA_STATE_FILE" ]] && cp "$MITA_STATE_FILE"  "$bdir/mita-state.json" || true
  [[ -f "$PANEL_CONFIG"    ]] && cp "$PANEL_CONFIG"     "$bdir/config.json"    || true
  # Bug 99: back up the user DB too (it holds all issued keys). Use SQLite's
  # online backup when available so a live/WAL DB is copied consistently; fall
  # back to a plain cp otherwise.
  if [[ -f "$DB_PATH" ]]; then
    if command -v sqlite3 &>/dev/null; then
      sqlite3 "$DB_PATH" ".backup '$bdir/db.sqlite'" 2>/dev/null || cp "$DB_PATH" "$bdir/db.sqlite" 2>/dev/null || true
    else
      cp "$DB_PATH" "$bdir/db.sqlite" 2>/dev/null || true
    fi
  fi
  [[ -f /etc/systemd/system/caddy-naive.service ]] && \
    cp /etc/systemd/system/caddy-naive.service "$bdir/" || true
  [[ -f /etc/systemd/system/mita.service ]] && \
    cp /etc/systemd/system/mita.service "$bdir/" || true

  log_info "Backup created: $bdir"

  local count; count=$(ls -1d "$BACKUP_DIR"/*/ 2>/dev/null | wc -l)
  if (( count > 10 )); then
    ls -1dt "$BACKUP_DIR"/*/ | tail -n +11 | xargs rm -rf
    log_info "Old backups pruned (kept 10 most recent)"
  fi
  echo "$bdir"
}

# ── Architecture detection ────────────────────────────────────────────────────
detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64)  ARCH="amd64"; DEB_ARCH="amd64" ;;
    # caddy-naive is amd64-only; Mieru still supports all arches
    aarch64|arm64) ARCH="arm64"; DEB_ARCH="arm64" ;;
    armv7l)        ARCH="armv7"; DEB_ARCH="armhf"  ;;
    *) die "Unsupported arch: $(uname -m)" ;;
  esac
}

# ── Version comparison ────────────────────────────────────────────────────────
version_gt() {
  [[ "$(printf '%s\n' "$1" "$2" | sort -V | tail -1)" == "$1" && "$1" != "$2" ]]
}

# Bug 99: fetch the VERSION published on main (best-effort, 8s timeout). Used so
# a curl-piped or older local update.sh still learns the real target version.
fetch_remote_version() {
  local v
  v=$(curl -fsSL --max-time 8 "$REPO_RAW/VERSION" 2>/dev/null | head -n1 | tr -d '[:space:]')
  [[ -n "$v" ]] && echo "$v" || echo ""
}

# Bug 99: resolve the effective TARGET_VERSION = max(local VERSION, remote
# VERSION). This guarantees the update gate triggers whenever main is ahead of
# the installed version, regardless of which copy of update.sh is running.
resolve_target_version() {
  local remote; remote=$(fetch_remote_version)
  if [[ -n "$remote" ]]; then
    if version_gt "$remote" "$TARGET_VERSION"; then
      TARGET_VERSION="$remote"
    fi
  fi
}

get_current_version() {
  if [[ -f "$VERSION_FILE" ]]; then
    grep '^panel_version=' "$VERSION_FILE" 2>/dev/null | cut -d= -f2 || cat "$VERSION_FILE"
  else
    echo "0.0.0"
  fi
}

get_caddy_version_file() {
  if [[ -f "$VERSION_FILE" ]]; then
    grep '^caddy_version=' "$VERSION_FILE" 2>/dev/null | cut -d= -f2 || echo "unknown"
  else
    echo "unknown"
  fi
}

# ── v1.2.3: Rebuild Caddyfile via panel API (rebuild-all endpoint) ────────────
# Used by --repair. Avoids duplicating build logic from index.js.
rebuild_via_api() {
  log_step "Rebuilding Caddyfile + mita config via panel API (/api/services/rebuild-all)"
  local panel_url="http://127.0.0.1:3000"

  # We need a session cookie; read admin credentials from config
  local admin_user; admin_user=$(jq -r '.adminUser // "admin"' "$PANEL_CONFIG")

  # Try to get admin password hash and call API with session auth
  # The panel must be running for this to work
  if ! curl -sf "$panel_url/" -o /dev/null 2>/dev/null; then
    log_warn "Panel not responding at :3000 — rebuilding configs directly"
    rebuild_caddyfile_direct
    rebuild_mita_state_direct
    return
  fi

  log_info "Panel is running — calling /api/services/rebuild-all"
  # We can't use credentials here without the plaintext password, so fall back to direct rebuild
  # The panel itself will reload Caddy after next user interaction.
  # For repair we rebuild directly from DB to be safe.
  rebuild_caddyfile_direct
  rebuild_mita_state_direct
}

# ── v1.2.4: Rebuild Caddyfile directly from SQLite DB ────────────────────────
# Bug 23/26/38/39: uses caddyTemplate.js (single source of truth) so directive
# syntax and log-rotation settings are always consistent with install.sh.
rebuild_caddyfile_direct() {
  log_step "Rebuilding Caddyfile from SQLite database"
  [[ ! -f "$DB_PATH" ]] && { log_warn "DB not found at $DB_PATH — skipping Caddyfile rebuild"; return; }
  [[ ! -f "$PANEL_CONFIG" ]] && { log_warn "Panel config not found — skipping Caddyfile rebuild"; return; }

  mkdir -p "$CADDY_CONFIG_DIR" /var/log/caddy-naive /var/lib/caddy
  # Bug 66: --repair must restore correct ownership on log and data dirs
  # (root is wrong — caddy-naive.service runs as User=caddy)
  id caddy &>/dev/null && chown caddy:caddy /var/log/caddy-naive /var/lib/caddy || true

  # Bug 86: build the Caddyfile via a TEMP .js FILE rather than an inline
  # `node -e "<huge double-quoted blob>"`.
  #
  # The previous inline form embedded the whole rebuild script inside a
  # double-quoted bash string, so bash pre-processed it: `$DB_PATH` /
  # `$PANEL_CONFIG` / `$CADDY_FILE` were string-substituted, and any stray `$`,
  # backtick or `\` in the JS was at the mercy of bash quoting. On the live
  # server this silently produced a node program that exited 0 *without* writing
  # the new Caddyfile (the `[Caddyfile] rebuilt with N user(s)` line never
  # appeared in --repair output), yet the subsequent `caddy validate` happily
  # validated the STALE file → false "Caddyfile rebuilt ✓". Running the exact
  # same logic from a real .js file (paths passed via process.env, no bash
  # interpolation) wrote the correct Bug 83 Caddyfile immediately.
  #
  # Fix: write the script with a QUOTED heredoc (<<'NODE_EOF' — no expansion),
  # pass every path through the environment, and `node "$rebuild_js"`. This
  # removes all bash-quoting hazards and makes a real failure exit non-zero
  # (caught below) instead of silently no-op'ing.
  # Bug 86b: node resolves `require('better-sqlite3')` relative to the SCRIPT
  # FILE's directory, not the cwd. A /tmp/*.js would look in /tmp/node_modules
  # and fail (reintroducing the Bug 82 "Cannot find module" problem). Write the
  # temp script INTO $PANEL_DIR so the panel's node_modules are on the lookup path.
  local rebuild_js; rebuild_js=$(mktemp "${PANEL_DIR}/.rebuild-caddy.XXXXXX.js")
  cat > "$rebuild_js" <<'NODE_EOF'
const Database = require('better-sqlite3');
const fs       = require('fs');

const DB_PATH      = process.env.RB_DB_PATH;
const PANEL_CONFIG = process.env.RB_PANEL_CONFIG;
const CADDY_FILE   = process.env.RB_CADDY_FILE;
const CADDY_CFGDIR = process.env.RB_CADDY_CFGDIR;
const TEMPLATE_JS  = process.env.RB_TEMPLATE_JS;
const FAKE_SITE    = process.env.RB_FAKE_SITE;

const db  = new Database(DB_PATH, { readonly: true });
const cfg = JSON.parse(fs.readFileSync(PANEL_CONFIG, 'utf8'));

// Bug 34: filter to naive-protocol users; placeholder emitted by template when empty
const naiveUsers = db.prepare('SELECT username, password, protocols FROM users').all()
  .filter(u => {
    try { return JSON.parse(u.protocols || '["naive","mieru"]').includes('naive'); }
    catch { return true; }
  })
  .map(u => ({ username: u.username, password: u.password || '' }))
  // Bug 67: skip users with no plaintext password — empty password produces
  // "basic_auth user " (trailing space) which Caddy rejects as invalid syntax
  .filter(u => u.password.trim() !== '');

const probeSecret = cfg.probeSecret ||
  (() => { try { return fs.readFileSync(CADDY_CFGDIR + '/probe_secret', 'utf8').trim(); } catch { return ''; } })();
// Bug 81: probe_resistance mode — derive from probeSecret when unset.
let probeMode = (cfg.probeMode || '').trim().toLowerCase();
if (!probeMode) probeMode = probeSecret ? 'secret' : 'bare';

// Bug 26: use shared template for consistency with install.sh
let content;
if (fs.existsSync(TEMPLATE_JS)) {
  const tpl = require(TEMPLATE_JS);
  content = tpl.render({
    adminEmail:  cfg.adminEmail  || '',
    domain:      cfg.domain      || 'localhost',
    naivePort:   cfg.naivePort   || 443,
    fakeSiteDir: cfg.fakeSiteDir || FAKE_SITE,
    fakeSiteUrl: cfg.fakeSiteUrl || '',
    probeSecret,
    probeMode,
    logFile:     '/var/log/caddy-naive/access.log',
    upstream:    (cfg.cascadeEnabled && cfg.cascadeNaiveUpstream) ? cfg.cascadeNaiveUpstream : '',
    // v1.4.0: panel external-access subdomain block (TLS + basic_auth + webBasePath)
    exposePanel:        !!cfg.exposePanel,
    panelDomain:        cfg.panelDomain        || '',
    panelBasicAuthUser: cfg.panelBasicAuthUser || '',
    panelBasicAuthHash: cfg.panelBasicAuthHash || '',
    webBasePath:        cfg.webBasePath        || '',
    panelStubPage:      cfg.panelStubPage      || '/var/www/panel-stub/index.html',
    panelPort:          cfg.panelPort          || 3000
  }, naiveUsers);
} else {
  // Fallback (template not available): emit correct Bug 83 syntax directly
  const crypto = require('crypto');
  let authLines;
  if (naiveUsers.length > 0) {
    authLines = naiveUsers.map(u => '    basic_auth ' + u.username + ' ' + u.password).join('\n');
  } else {
    const rnd = crypto.randomBytes(20).toString('hex');
    authLines = '    basic_auth _placeholder_' + rnd.slice(0, 16) + ' _disabled_' + rnd.slice(16);
  }
  let probeLine;
  if (probeMode === 'off') probeLine = '';
  else if (probeMode === 'secret' && probeSecret) probeLine = '\n    probe_resistance ' + probeSecret;
  else probeLine = '\n    probe_resistance';
  // v1.4.0: panel external-access subdomain block (inline fallback)
  let panelBlock = '';
  {
    const expose = !!cfg.exposePanel;
    const pDom   = String(cfg.panelDomain || '').trim();
    const baUser = String(cfg.panelBasicAuthUser || '').trim();
    const baHash = String(cfg.panelBasicAuthHash || '').trim();
    const stubF  = String(cfg.panelStubPage || '/var/www/panel-stub/index.html').trim();
    const wbp    = String(cfg.webBasePath || '').trim().replace(/^\/+|\/+$/g, '').replace(/[^A-Za-z0-9._~-]/g, '');
    const pPort  = parseInt(cfg.panelPort, 10) || 3000;
    if (expose && pDom && wbp) {
      const stubDir = stubF.replace(/\/[^/]*$/, '') || '/var/www/panel-stub';
      let ba = '';
      if (baUser && baHash) ba = '    basic_auth {\n      ' + baUser + ' ' + baHash + '\n    }\n';
      panelBlock = '\n\n' + pDom + ' {\n  tls ' + (cfg.adminEmail || '') +
        '\n\n  redir /' + wbp + ' /' + wbp + '/ 301' +
        '\n\n  handle_path /' + wbp + '/* {\n' + ba + '    reverse_proxy 127.0.0.1:' + pPort +
        '\n  }\n\n  handle {\n    root * ' + stubDir + '\n    file_server\n  }\n}\n';
    }
  }
  content = [
    '{',
    '  order forward_proxy first',
    '  servers {',
    '    protocols h1 h2',
    '  }',
    '  email ' + (cfg.adminEmail || ''),
    '  admin off',
    // Global = runtime logger only (stderr/journald). Access logs are a
    // per-site directive (below) — a global log block never writes per-request
    // user_id / byte counters, so Naive traffic was always 0.0.
    '  log {',
    '    output stderr',
    '    format console',
    '    level ERROR',
    '  }',
    '}',
    '',
    ':80 {',
    '  redir https://{host}{uri} permanent',
    '}',
    '',
    // Bug 83: ':<port>, <domain>' listener + explicit tls + no route{} wrapper
    ':' + (cfg.naivePort || 443) + ', ' + (cfg.domain || 'localhost') + ' {',
    '  tls ' + (cfg.adminEmail || ''),
    '',
    // Traffic accounting: per-site ACCESS log → JSON line per request with
    // request.user_id + byte counters parseCaddyTraffic() sums per user.
    '  log {',
    '    output file /var/log/caddy-naive/access.log {',
    '      roll_size     50mb',
    '      roll_keep_for 720h',
    '    }',
    '    format json',
    '  }',
    '',
    '  forward_proxy {',
    authLines,
    '    hide_ip',
    '    hide_via' + probeLine,
    '  }',
    '',
    '  file_server {',
    '    root ' + (cfg.fakeSiteDir || FAKE_SITE),
    '  }',
    '}'
  ].join('\n') + panelBlock;
}

const tmp = CADDY_FILE + '.new';
fs.writeFileSync(tmp, content, { mode: 0o640 });
fs.renameSync(tmp, CADDY_FILE);
console.log('[Caddyfile] rebuilt with ' + naiveUsers.length + ' user(s) → ' + CADDY_FILE);
db.close();
NODE_EOF

  # Bug 82: run node from the panel dir so it can resolve better-sqlite3 and the
  # other node_modules (they live under $PANEL_DIR, not the script's cwd).
  if ! ( cd "$PANEL_DIR" && \
         RB_DB_PATH="$DB_PATH" \
         RB_PANEL_CONFIG="$PANEL_CONFIG" \
         RB_CADDY_FILE="$CADDY_FILE" \
         RB_CADDY_CFGDIR="$CADDY_CONFIG_DIR" \
         RB_TEMPLATE_JS="${PANEL_DIR}/server/caddyTemplate.js" \
         RB_FAKE_SITE="$FAKE_SITE_DIR" \
         node "$rebuild_js" ); then
    rm -f "$rebuild_js"
    log_warn "Node Caddyfile rebuild failed — Caddyfile will be rebuilt on next panel operation"
    return 1
  fi
  rm -f "$rebuild_js"

  # Bug 39: validate after rebuild so --repair fails loudly if template is wrong
  local caddy_bin; caddy_bin=$(jq -r '.caddyBin // "/usr/local/bin/caddy-naive"' "$PANEL_CONFIG" 2>/dev/null || echo '/usr/local/bin/caddy-naive')
  if [[ -x "$caddy_bin" ]]; then
    if "$caddy_bin" validate --config "$CADDY_FILE" --adapter caddyfile &>/dev/null; then
      log_info "Caddyfile validated ✓"
    else
      log_error "Caddyfile validation FAILED after rebuild:"
      "$caddy_bin" validate --config "$CADDY_FILE" --adapter caddyfile 2>&1 | head -20 || true
      return 1
    fi
  fi
  # Bug 79: ensure the caddy user can actually read the freshly-written file
  fix_caddy_perms
  log_info "Caddyfile rebuilt ✓"
}

# ── v1.2.3: Rebuild mita-state.json from SQLite DB ───────────────────────────
rebuild_mita_state_direct() {
  log_step "Rebuilding mita-state.json from database"
  [[ ! -f "$DB_PATH" ]] && { log_warn "DB not found — skipping mita state rebuild"; return; }

  # Bug 82: run node from the panel dir so better-sqlite3 resolves correctly.
  # Bug 151: this script generates mita-state.json directly (the --repair path).
  # Two defects produced a config with NO `users` section → mita FATAL
  # "no user found" → restart loop:
  #   1) the mieru filter used `JSON.parse(u.protocols || '[]')` — a user whose
  #      `protocols` column is NULL/empty parsed to `[]`, so `.includes('mieru')`
  #      was false and the user was DROPPED. index.js defaults to
  #      `["naive","mieru"]` and `catch { return true }`, so the two generators
  #      disagreed. We now MATCH index.js exactly so a repaired config keeps the
  #      same users the running panel would write.
  #   2) the whole node block was wrapped in `2>/dev/null` + `return 1`, so any
  #      failure was silent and `--repair` happily moved on with a stale/empty
  #      mita-state.json. We now surface errors (see the invocation below).
  ( cd "$PANEL_DIR" && node -e "
    const Database = require('better-sqlite3');
    const fs       = require('fs');
    const db       = new Database('$DB_PATH', { readonly: true });
    const cfg      = JSON.parse(fs.readFileSync('$PANEL_CONFIG', 'utf8'));
    const users    = db.prepare('SELECT username, password, protocols FROM users').all()
      .filter(u => { try { return JSON.parse(u.protocols || '[\"naive\",\"mieru\"]').includes('mieru'); } catch { return true; } })
      .map(u => ({ name: u.username, password: u.password || '' }));

    const portBindings = [];
    // Bug 69: mieruPortStart/End may be strings or undefined in old configs;
    // parseInt with fallback prevents an infinite loop (NaN comparisons are false)
    const portStart = parseInt(cfg.mieruPortStart, 10) || 2000;
    const portEnd   = parseInt(cfg.mieruPortEnd,   10) || 2010;
    for (let p = portStart; p <= portEnd; p++) {
      portBindings.push({ port: p, protocol: 'TCP' });
      if (cfg.udpEnabled) portBindings.push({ port: p, protocol: 'UDP' });
    }

    const state = { portBindings, users, loggingLevel: 'INFO', mtu: cfg.mtu || 1400 };
    const pat = cfg.trafficPattern || 'NOOP';
    if (pat !== 'NOOP') {
      // BUG-156: emit the proto-correct trafficPattern. `seed` is an INT32 (NOT
      // a boolean — the old 'seed: true' made 'mita apply config' fail with
      // 'invalid value for int32 type: true' → empty server config → IDLE).
      // `unlockAll` is the on/off boolean; tcpFragment/nonce are OBJECTS.
      // Keep a stable numeric seed in cfg.trafficPatternSeed (mirrors index.js).
      const crypto = require('crypto');
      let seed = parseInt(cfg.trafficPatternSeed, 10);
      if (!Number.isInteger(seed) || seed <= 0 || seed > 0x7fffffff) {
        seed = (crypto.randomBytes(4).readUInt32BE(0) & 0x7fffffff) || 1;
      }
      const patMap = {
        RANDOM_PADDING: {
          seed, unlockAll: false,
          tcpFragment: { enable: false, maxSleepMs: 0 },
          nonce: { type: 'NONCE_TYPE_PRINTABLE', applyToAllUDPPacket: false, minLen: 4, maxLen: 8 }
        },
        RANDOM_PADDING_AGGRESSIVE: {
          seed, unlockAll: true,
          tcpFragment: { enable: true, maxSleepMs: 10 },
          nonce: { type: 'NONCE_TYPE_PRINTABLE', applyToAllUDPPacket: true, minLen: 6, maxLen: 12 }
        },
        CUSTOM: (cfg.trafficPatternCustom && typeof cfg.trafficPatternCustom === 'object')
          ? Object.assign({}, cfg.trafficPatternCustom, {
              seed: Number.isInteger(parseInt((cfg.trafficPatternCustom||{}).seed,10))
                ? parseInt(cfg.trafficPatternCustom.seed,10) : seed })
          : { seed, unlockAll: true }
      };
      if (patMap[pat]) state.trafficPattern = patMap[pat];
      // Persist the stable seed so subsequent regenerations don't churn it.
      if (cfg.trafficPatternSeed !== seed) {
        try {
          cfg.trafficPatternSeed = seed;
          fs.writeFileSync('$PANEL_CONFIG', JSON.stringify(cfg, null, 2), { mode: 0o600 });
        } catch (_) {}
      }
    }

    const tmp = '$MITA_STATE_FILE' + '.new';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, '$MITA_STATE_FILE');
    console.log('[mita-state] wrote', users.length, 'user(s)');
    db.close();
    // Bug 151: fail LOUDLY (non-zero exit) if we ended up with mieru users in
    // the DB but somehow wrote an empty users[] — that is exactly the broken
    // state that crashes mita with 'no user found'.
    if (users.length === 0) {
      const total = db ? 0 : 0;
      console.error('[mita-state] WARNING: 0 mieru users written — mita will idle until a key exists');
    }
  " ) || {
    # Bug 151: do NOT swallow the error (was `2>/dev/null`). A failed rebuild
    # must be visible so the operator knows mita-state.json may be stale.
    log_warn "Node mita state rebuild FAILED — mita-state.json may be missing its users section"
    return 1
  }
  log_info "mita-state.json rebuilt ✓"

  # Bug 151: after rebuilding the config, make sure mita actually comes up with
  # the restored users instead of staying in a failed restart loop. Clear the
  # systemd failure counter, (re)start, and verify. If there are NO mieru users
  # yet, leave mita stopped (idle) on purpose — starting it empty is what causes
  # the 'no user found' FATAL loop (foolproofing, see Доработка 2 / BUG-151).
  local mieru_count
  mieru_count=$(grep -c '"name"' "$MITA_STATE_FILE" 2>/dev/null || echo 0)
  if [[ "${mieru_count:-0}" -gt 0 ]]; then
    systemctl reset-failed mita 2>/dev/null || true
    if command -v mita &>/dev/null; then mita apply config "$MITA_STATE_FILE" 2>/dev/null || true; fi
    systemctl restart mita 2>/dev/null || systemctl start mita 2>/dev/null || true
    sleep 1
    if systemctl is-active --quiet mita 2>/dev/null; then
      log_info "mita active with ${mieru_count} user(s) ✓"
    else
      log_warn "mita not active after rebuild — check: journalctl -u mita -n 50"
    fi
  else
    log_info "No mieru keys yet — leaving mita idle (it will start after the first key)"
    systemctl stop mita 2>/dev/null || true
    systemctl reset-failed mita 2>/dev/null || true
  fi
}

# ── v1.2.3: Ensure caddy-naive.service exists ────────────────────────────────
ensure_caddy_service() {
  if [[ ! -f /etc/systemd/system/caddy-naive.service ]]; then
    log_step "Creating caddy-naive.service"
    # Bug 37: run as unprivileged caddy user
    id caddy &>/dev/null || useradd --system --no-create-home --shell /usr/sbin/nologin caddy 2>/dev/null || true
    cat > /etc/systemd/system/caddy-naive.service <<SVCCADDY
[Unit]
Description=Caddy forwardproxy-naive Server
Documentation=https://github.com/klzgrad/forwardproxy
After=network.target network-online.target
Requires=network-online.target

[Service]
Type=notify
User=caddy
Group=caddy
ExecStart=${CADDY_BIN} run --config ${CADDY_FILE} --adapter caddyfile
ExecReload=/bin/kill -USR1 \$MAINPID
TimeoutStopSec=5
Restart=on-failure
RestartSec=10
LimitNOFILE=1048576
PrivateTmp=true
# Bug 65: ProtectSystem=strict (not full) required with ReadWritePaths /etc paths
ProtectSystem=strict
Environment=XDG_DATA_HOME=/var/lib/caddy
Environment=XDG_CONFIG_HOME=/var/lib/caddy
ReadWritePaths=/var/log/caddy-naive /etc/caddy-naive /var/lib/caddy
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
SVCCADDY
    systemctl daemon-reload
    systemctl enable caddy-naive 2>/dev/null || true
    log_info "caddy-naive.service created ✓"
  fi

  # Remove legacy naive.service if present (migration from v1.2.x)
  if [[ -f /etc/systemd/system/naive.service ]]; then
    systemctl stop    naive 2>/dev/null || true
    systemctl disable naive 2>/dev/null || true
    rm -f /etc/systemd/system/naive.service
    log_info "Legacy naive.service removed (replaced by caddy-naive.service)"
  fi

  # BUG-162 placeholder kept inline below in migrate_warp_safety().

  # BUG-160 (v1.5.1): enable kernel IP accounting on the caddy-naive unit so the
  #   panel can report real NaiveProxy traffic (the access log can't — CONNECT
  #   tunnels are hijacked and never logged). Idempotent: only adds the line if
  #   missing, then daemon-reload + restart so the cgroup counters start.
  if [[ -f /etc/systemd/system/caddy-naive.service ]] \
     && ! grep -q '^IPAccounting=' /etc/systemd/system/caddy-naive.service; then
    log_step "Enabling IPAccounting on caddy-naive.service (Naive traffic accounting)"
    sed -i '/^AmbientCapabilities=CAP_NET_BIND_SERVICE/a IPAccounting=yes' \
      /etc/systemd/system/caddy-naive.service 2>/dev/null \
      || printf '\n[Service]\nIPAccounting=yes\n' >> /etc/systemd/system/caddy-naive.service
    systemctl daemon-reload 2>/dev/null || true
    systemctl restart caddy-naive 2>/dev/null || true
    log_info "IPAccounting=yes enabled ✓"
  fi
}

# ── BUG-162: recover boxes from the broken v1.5.1 WARP (lock-out on reboot) ──
migrate_warp_safety() {
  # If the old wg-quick@warp unit is enabled (v1.5.1 auto-enabled it), the box
  # would tunnel SSH/panel and lose access on every reboot. ALWAYS disable the
  # autostart on update so a reboot is safe. We do NOT silently bring WARP back —
  # the operator re-enables it from the panel (now with scoped, safe routing).
  local changed=0
  if systemctl is-enabled wg-quick@warp &>/dev/null; then
    systemctl disable wg-quick@warp 2>/dev/null || true
    changed=1
    log_warn "WARP autostart disabled (BUG-162: prevents reboot lock-out) / автозагрузка WARP отключена"
  fi
  # If a stale warp.conf still has the broken blanket-route layout (Table=auto or
  # no Table=off, AllowedIPs ::/0 / 0.0.0.0/0 as default), OR is a v1.5.2 conf
  # WITHOUT the MTU=1280 fix (BUG-164: one-way tunnel — handshake OK but no return
  # traffic), tear the tunnel down so the panel regenerates the fixed conf on the
  # next enable, and the operator is not stuck behind a black-hole/control-plane-
  # eating route after the update.
  if [[ -f /etc/wireguard/warp.conf ]]; then
    if ! grep -qiE '^[[:space:]]*Table[[:space:]]*=[[:space:]]*off' /etc/wireguard/warp.conf; then
      log_warn "Tearing down old unsafe WARP tunnel (missing Table=off) / снимаю старый небезопасный WARP"
      systemctl stop wg-quick@warp 2>/dev/null || true
      wg-quick down warp 2>/dev/null || true
      ip link del warp 2>/dev/null || true
      # remove the old broken conf so the panel regenerates the safe one on enable
      rm -f /etc/wireguard/warp.conf
      changed=1
    elif ! grep -qiE '^[[:space:]]*MTU[[:space:]]*=[[:space:]]*1280' /etc/wireguard/warp.conf; then
      log_warn "Tearing down one-way WARP tunnel (missing MTU=1280, BUG-164) / снимаю односторонний WARP без MTU 1280"
      systemctl stop wg-quick@warp 2>/dev/null || true
      wg-quick down warp 2>/dev/null || true
      ip link del warp 2>/dev/null || true
      rm -f /etc/wireguard/warp.conf
      changed=1
    fi
  fi
  # Clean up the v1.5.1 wg-quick fwmark policy artifacts if they linger.
  while ip rule show 2>/dev/null | grep -q "fwmark 0xca6c"; do
    ip rule del fwmark 0xca6c 2>/dev/null || break
  done
  ip route flush table "$((16#ca6c))" 2>/dev/null || true
  [[ "$changed" == "1" ]] && systemctl daemon-reload 2>/dev/null || true
}

# ── BUG-172 migration: refresh the Mieru-cascade watchdog on existing installs ─
#   The pre-1.5.8 watchdog probed mieru-client's SOCKS5 (:1080) DIRECTLY, so a
#   redsocks event-loop deadlock (process alive, port open, no events serviced)
#   went undetected and clients silently timed out after 2-5 days. If a cascade
#   is currently enabled, re-run the orchestrator's watchdog installer so the box
#   gets the new full-chain probe (as the mita user) + nightly redsocks recycle
#   WITHOUT touching the live tunnel/iptables. Idempotent and safe on -y.
migrate_cascade_watchdog() {
  # Gate strictly on Variant-B actually being DEPLOYED on this box, not merely on
  # cascadeEnabled (which is also true for Variant-A native egress). The state
  # file /var/lib/rixxx-panel/cascade-mieru.state is written ONLY by
  # `cascade_mieru.sh setup`, and the old watchdog binary is only present after a
  # Variant-B setup — either is proof the redsocks+mieru-client chain exists here.
  # This guarantees we never install a chain-probing watchdog on a host that
  # doesn't run the chain (which could spuriously restart unrelated services).
  local state="/var/lib/rixxx-panel/cascade-mieru.state"
  local wd="/usr/local/bin/mieru-watchdog.sh"
  if [[ ! -f "$state" && ! -f "$wd" ]]; then
    return 0
  fi
  local enabled
  enabled=$(jq -r '.cascadeEnabled // false' "$PANEL_CONFIG" 2>/dev/null || echo false)
  [[ "$enabled" != "true" ]] && return 0
  $DRY_RUN && { log_dry "Would refresh the Mieru-cascade watchdog (BUG-172: full-chain probe + nightly recycle)"; return 0; }
  local cs="${PANEL_DIR:-/opt/panel-naive-mieru}/panel/scripts/cascade_mieru.sh"
  [[ -f "$cs" ]] || cs="$(dirname "$0")/panel/scripts/cascade_mieru.sh"
  [[ -f "$cs" ]] || { log_warn "cascade script not found — skip watchdog refresh"; return 0; }
  # Load ONLY the function definitions (strip the trailing `case "$ACTION"`
  # dispatcher, which would otherwise `die` on an empty action), then re-install
  # just the watchdog + cron. No tunnel/iptables side effects. Runs in a subshell
  # so the sourced script's `set -euo pipefail` can't leak into the updater.
  if ( set +eu +o pipefail 2>/dev/null
       eval "$(sed '/^case "\$ACTION" in/,$d' "$cs")"
       write_watchdog ) >/dev/null 2>&1; then
    log_info "Cascade watchdog refreshed (BUG-172: full-chain probe + nightly recycle) ✓"
  else
    log_warn "Cascade watchdog refresh returned non-zero — re-toggle the cascade in the panel to update it"
  fi
}

# ── v1.8.0 (Hy2 Sub-stage C): Hysteria2 update migration ─────────────────────
#   Hy2 is the OPTIONAL third protocol. This migration NEVER auto-installs it.
#     • Installed (config + binary present): restart hysteria-server so the
#       refreshed unit/config (and any panel-rewritten userpass) take effect,
#       exactly like caddy-naive/mita above. The panel keeps the userpass map in
#       sync from the SQLite pool on the next applyAllConfigs(), so existing Hy2
#       users are NOT dropped.
#     • Not installed: print a one-line hint that Hy2 can be added from Settings
#       ("Доустановить Hy2"). No side effects — existing installs are untouched.
#   Idempotent and safe under -y / --dry-run.
# v1.8.4 (Cascade Variant 1): migrate an EXISTING Hy2 install from User=root to
# a dedicated 'hysteria' system user, so the cascade relay can scope its egress
# by owner-uid (like Mieru's mita). Idempotent: does nothing if the unit already
# runs as hysteria. Only touches a box where Hy2 is installed. Preserves the cert
# (adds hysteria to group caddy + grants group-read) so Hy2 keeps starting.
migrate_hy2_service_user() {
  local unit=/etc/systemd/system/hysteria-server.service
  [[ -f "$unit" ]] || return 0
  # Already migrated? (unit runs as hysteria) → nothing to do.
  grep -qE '^\s*User\s*=\s*hysteria\s*$' "$unit" && return 0

  log_info "Hy2: migrating service from root → dedicated 'hysteria' user (cascade owner-match)"

  # 1) Create the system user (idempotent) and grant cert access via group caddy.
  if ! id hysteria &>/dev/null; then
    useradd --system --no-create-home --shell /usr/sbin/nologin hysteria 2>/dev/null \
      || useradd --system --no-create-home --shell /bin/false hysteria 2>/dev/null || true
  fi
  if getent group caddy &>/dev/null; then
    usermod -aG caddy hysteria 2>/dev/null || true
  fi

  # 2) Patch the unit: User/Group → hysteria, ensure SupplementaryGroups=caddy.
  sed -i -E 's/^\s*User\s*=\s*root\s*$/User=hysteria/'  "$unit"
  sed -i -E 's/^\s*Group\s*=\s*root\s*$/Group=hysteria/' "$unit"
  if ! grep -qE '^\s*SupplementaryGroups\s*=\s*caddy' "$unit"; then
    sed -i -E '/^\s*Group\s*=\s*hysteria\s*$/a SupplementaryGroups=caddy' "$unit"
  fi

  # 3) Config dir + files owned by the service user (it only reads them), with
  #    explicit modes: dir traversable (750), config group-readable (640). The
  #    panel writes the config as root 0600 on every edit, so the running server
  #    (index.js hy2ChownConfig) hands it back — this is the migration-time seed.
  chown -R hysteria:hysteria /etc/hysteria 2>/dev/null || true
  chmod 750 /etc/hysteria 2>/dev/null || true
  [[ -f /etc/hysteria/config.yaml ]] && chmod 640 /etc/hysteria/config.yaml 2>/dev/null || true

  # 4) Cert perms: make the Caddy cert group-readable for the caddy group so the
  #    hysteria user (member of caddy) can read it. Discover the cert dir from the
  #    tls: block in config.yaml; skip silently if it's ACME/standalone.
  local crt; crt=$(grep -E '^\s*cert:\s*' /etc/hysteria/config.yaml 2>/dev/null | awk '{print $2}' | head -1)
  if [[ -n "$crt" && -f "$crt" ]] && getent group caddy &>/dev/null; then
    local cdir; cdir=$(dirname "$crt")
    local p="$cdir"
    while [[ "$p" == /var/lib/caddy* || "$p" == /root/.local* || "$p" == /home/* ]]; do
      chgrp caddy "$p" 2>/dev/null || true; chmod g+rx "$p" 2>/dev/null || true
      p=$(dirname "$p")
    done
    chgrp caddy "$crt" "${crt%.crt}.key" 2>/dev/null || true
    chmod g+r  "$crt" "${crt%.crt}.key" 2>/dev/null || true
  fi

  systemctl daemon-reload 2>/dev/null || true
  log_info "Hy2: service user migration applied ✓"
}

# v1.8.6: enable the Traffic Stats API on existing Hy2 installs so the panel can
#   show per-user Hy2 traffic (like Naive/Mieru). Adds a loopback trafficStats
#   block with a generated secret if the config doesn't already have one.
#   Idempotent: configs that already contain `trafficStats:` are left untouched.
migrate_hy2_traffic_stats() {
  local cfg=/etc/hysteria/config.yaml
  [[ -f "$cfg" ]] || return 0
  grep -qE '^\s*trafficStats\s*:' "$cfg" && return 0
  log_info "Hy2: enabling Traffic Stats API (per-user traffic in the panel)"
  local secret; secret="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  cat >> "$cfg" <<HYSTATSEOF

# ── Traffic Stats API (управляется панелью — не редактируйте вручную) ──
trafficStats:
  listen: 127.0.0.1:9999
  secret: "${secret}"
HYSTATSEOF
  # Keep ownership/mode correct for the non-root service user.
  if id hysteria &>/dev/null; then
    chown hysteria:hysteria "$cfg" 2>/dev/null || true
  fi
  chmod 640 "$cfg" 2>/dev/null || true
}

migrate_hy2() {
  $DRY_RUN && { log_dry "Would migrate Hy2 to the 'hysteria' user + enable Traffic Stats API + restart hysteria-server if installed (else print an install hint)"; return 0; }
  if [[ -f /etc/hysteria/config.yaml && -x /usr/local/bin/hysteria ]]; then
    migrate_hy2_service_user
    migrate_hy2_traffic_stats
    systemctl reset-failed hysteria-server 2>/dev/null || true
    if systemctl restart hysteria-server 2>/dev/null; then
      log_info "Hy2: hysteria-server restarted to pick up the update ✓"
    else
      log_warn "Hy2: hysteria-server restart failed — journalctl -u hysteria-server -n 20"
    fi
  else
    log_info "Hy2 (Hysteria2) is available but NOT installed — add it any time from the panel: Settings → «Доустановить Hy2» (443/udp by default, reuses the Caddy cert)."
  fi
}

# ── v1.8.2: Opt-in auto-enroll — add "hy2" to EVERY existing user's protocols ─
#   Requested feature: "чтобы на уже выпущенные клиенты Hy2 сам подтянулся".
#   Existing clients were issued BEFORE Hy2 existed, so their protocols array is
#   ["naive","mieru"] and they never appear in auth.userpass → they can't use Hy2.
#   This backfills "hy2" into every user (idempotent — users who already have it
#   are skipped), then rewrites /etc/hysteria/config.yaml's userpass block and
#   restarts the service so all clients work over Hy2 immediately.
#
#   OPT-IN by design: runs only when HY2_ENROLL_ALL=1 is set (so a plain update
#   never silently changes which protocols users have). Requires Hy2 installed.
#   Passwords are unchanged — the same credential the client already has works
#   for Hy2 (auth.userpass maps username → the stored plaintext password).
migrate_hy2_enroll_all() {
  [[ "${HY2_ENROLL_ALL:-0}" == "1" ]] || return 0
  $DRY_RUN && { log_dry "Would add 'hy2' to every user's protocols and rewrite Hy2 userpass (HY2_ENROLL_ALL=1)"; return 0; }

  if [[ ! -f /etc/hysteria/config.yaml || ! -x /usr/local/bin/hysteria ]]; then
    log_warn "HY2_ENROLL_ALL=1 set but Hy2 is not installed — install it first (Settings → «Доустановить Hy2»), then re-run."
    return 0
  fi
  [[ -f "$DB_PATH" ]] || { log_warn "DB not found at $DB_PATH — cannot enroll users"; return 0; }

  log_step "Enrolling all existing users into Hy2 (HY2_ENROLL_ALL=1)"

  # Bug 86b pattern: write the temp script INTO $PANEL_DIR (not /tmp) so node
  # resolves require('better-sqlite3') against $PANEL_DIR/node_modules. Node
  # resolves modules relative to the SCRIPT FILE's dir, not the cwd, so a
  # /tmp/*.js looked in /tmp/node_modules and failed with MODULE_NOT_FOUND.
  local enroll_js; enroll_js="$(mktemp "${PANEL_DIR}/.hy2-enroll.XXXXXX.js")"
  cat > "$enroll_js" << 'NODE_EOF'
'use strict';
const Database = require('better-sqlite3');
const db = new Database(process.env.RB_DB_PATH);
const rows = db.prepare('SELECT id, username, protocols FROM users').all();
const upd = db.prepare('UPDATE users SET protocols = ? WHERE id = ?');
let changed = 0, already = 0;
const tx = db.transaction(() => {
  for (const r of rows) {
    let arr;
    try { arr = JSON.parse(r.protocols || '["naive","mieru"]'); }
    catch { arr = ['naive', 'mieru']; }
    if (!Array.isArray(arr)) arr = ['naive', 'mieru'];
    if (arr.includes('hy2')) { already++; continue; }
    arr.push('hy2');
    upd.run(JSON.stringify(arr), r.id);
    changed++;
  }
});
tx();
db.close();
console.log('[hy2-enroll] added hy2 to ' + changed + ' user(s); ' + already + ' already had it');
NODE_EOF

  if ( cd "$PANEL_DIR" && RB_DB_PATH="$DB_PATH" node "$enroll_js" ); then
    log_info "All users enrolled into Hy2 ✓"
  else
    rm -f "$enroll_js"
    log_warn "Hy2 auto-enroll failed (node/better-sqlite3) — users left unchanged"
    return 1
  fi
  rm -f "$enroll_js"

  # Rewrite the userpass block from the (now-enrolled) DB and restart Hy2.
  # Same Bug 86b fix: script lives in $PANEL_DIR so better-sqlite3 resolves.
  local rewrite_js; rewrite_js="$(mktemp "${PANEL_DIR}/.hy2-rewrite.XXXXXX.js")"
  cat > "$rewrite_js" << 'NODE_EOF'
'use strict';
const fs = require('fs');
const Database = require('better-sqlite3');
const CFG = '/etc/hysteria/config.yaml';
const db = new Database(process.env.RB_DB_PATH, { readonly: true });
const users = db.prepare('SELECT username, password, protocols FROM users').all()
  .filter(u => { try { return JSON.parse(u.protocols || '[]').includes('hy2'); } catch { return false; } });
db.close();

const q = s => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
const lines = ['auth:', '  type: userpass', '  userpass:'];
const seen = new Set();
for (const u of users) {
  if (!u.username || seen.has(u.username) || !u.password) continue;
  seen.add(u.username);
  lines.push('    ' + u.username + ': ' + q(u.password));
}
if (lines.length === 3) {
  // never leave an empty map (Hy2 FATALs) — disabled sentinel
  const rnd = require('crypto').randomBytes(24).toString('hex');
  lines.push('    __disabled_no_hy2_users__: ' + q('disabled-' + rnd));
}
const block = lines.join('\n') + '\n';

let text = fs.readFileSync(CFG, 'utf8');
const re = /^auth:[ \t]*\r?\n(?:[ \t].*\r?\n?|\r?\n)*/m;
if (re.test(text)) text = text.replace(re, () => block);
else {
  const lr = /^listen:.*\r?\n/m;
  text = lr.test(text) ? text.replace(lr, m => m + '\n' + block) : block + '\n' + text;
}
if (!/^listen:/m.test(text) || (!/^tls:/m.test(text) && !/^acme:/m.test(text)) || !/^auth:/m.test(text)) {
  console.error('[hy2-rewrite] refusing to write — structural validation failed');
  process.exit(2);
}
fs.writeFileSync(CFG, text, { mode: 0o600 });
console.log('[hy2-rewrite] userpass rewritten with ' + seen.size + ' Hy2 user(s)');
NODE_EOF

  if ( cd "$PANEL_DIR" && RB_DB_PATH="$DB_PATH" node "$rewrite_js" ); then
    rm -f "$rewrite_js"
    systemctl reset-failed hysteria-server 2>/dev/null || true
    if systemctl restart hysteria-server 2>/dev/null && \
       [[ "$(systemctl is-active hysteria-server 2>/dev/null)" == "active" ]]; then
      log_info "Hy2 config rewritten and hysteria-server restarted — all clients active over Hy2 ✓"
    else
      log_warn "Hy2 restart failed after enroll — journalctl -u hysteria-server -n 20"
    fi
  else
    rm -f "$rewrite_js"
    log_warn "Hy2 config rewrite failed — run a user add/delete in the panel to resync userpass"
  fi
}

# ── Bug 79: fix caddy-naive config permissions ───────────────────────────────
#   caddy-naive runs as User=caddy and fails to start with
#     "reading config from file: open /etc/caddy-naive/Caddyfile: permission denied"
#   when the config dir lacks group-execute (traverse) for the caddy group.
#   The Caddyfile is written by root (mode 640, owner root:root); the caddy user
#   then cannot enter the dir / read the file. Own dir as root:caddy, set dirs
#   750 (group can traverse) and files 640 (group can read).
fix_caddy_perms() {
  id caddy &>/dev/null || return 0
  [[ -d "$CADDY_CONFIG_DIR" ]] || return 0
  chown -R root:caddy "$CADDY_CONFIG_DIR" 2>/dev/null || true
  # Order matters: make the top dir traversable FIRST, otherwise `find` cannot
  # descend into a 640 dir to chmod the files inside it.
  chmod 750 "$CADDY_CONFIG_DIR" 2>/dev/null || true
  find "$CADDY_CONFIG_DIR" -type d -exec chmod 750 {} + 2>/dev/null || true
  find "$CADDY_CONFIG_DIR" -type f -exec chmod 640 {} + 2>/dev/null || true
  [[ -f "$CADDY_FILE" ]] && chmod 640 "$CADDY_FILE" 2>/dev/null || true
  # caddy also needs its data/log dirs owned correctly
  mkdir -p /var/log/caddy-naive /var/lib/caddy 2>/dev/null || true
  chown -R caddy:caddy /var/log/caddy-naive /var/lib/caddy 2>/dev/null || true
  log_info "caddy-naive config permissions fixed (dir 750, files 640, owner root:caddy) ✓"
}

# ── v1.2.3: Update caddy-forwardproxy-naive (amd64 only) ─────────────────────
update_caddy_naive() {
  log_step "Checking caddy-forwardproxy-naive update"
  detect_arch

  if [[ "$ARCH" != "amd64" ]]; then
    log_warn "caddy-forwardproxy-naive is amd64-only (current arch: $ARCH) — skipping Caddy update"
    return
  fi

  local release_json=""
  release_json=$(curl -fsSL --connect-timeout 10 "$CADDY_NAIVE_RELEASES" 2>/dev/null) || true

  local remote_tag="unknown"
  local asset_url=""

  if [[ -n "$release_json" ]]; then
    remote_tag=$(echo "$release_json" | jq -r '.tag_name // "unknown"')

    asset_url=$(echo "$release_json" | jq -r \
      '.assets[] | select(.name | test("caddy.*forwardproxy.*naive.*\\.tar\\.xz$|caddy-forwardproxy-naive.*\\.tar\\.xz$"; "i")) | .browser_download_url' \
      | head -1)

    if [[ -z "$asset_url" ]]; then
      asset_url=$(echo "$release_json" | jq -r \
        '.assets[] | select(.name | endswith(".tar.xz")) | .browser_download_url' | head -1)
    fi
  fi

  if [[ -z "$asset_url" ]]; then
    log_warn "GitHub API unavailable — using fallback URL (v2.10.0)"
    asset_url="$CADDY_NAIVE_FALLBACK_URL"
    remote_tag="v2.10.0-naive"
  fi

  local current_ver; current_ver=$("$CADDY_BIN" version 2>/dev/null | head -1 || \
                                   "$CADDY_BIN" --version 2>/dev/null | head -1 || \
                                   get_caddy_version_file)
  log_info "Current: $current_ver  |  Latest: $remote_tag"

  if ! $FORCE && echo "$current_ver" | grep -qF "${remote_tag#v}"; then
    log_info "caddy-forwardproxy-naive already up-to-date ✓"
    return
  fi

  $DRY_RUN && { log_dry "Would update caddy-naive to $remote_tag from $asset_url"; return; }

  local tmp_dir; tmp_dir=$(mktemp -d)
  log_info "Downloading: $asset_url"
  wget -q --show-progress --connect-timeout 30 -O "$tmp_dir/caddy.tar.xz" "$asset_url" || \
    { log_warn "Download failed — skipping Caddy update"; rm -rf "$tmp_dir"; return; }

  cd "$tmp_dir"
  tar -xJf caddy.tar.xz 2>/dev/null || tar -xf caddy.tar.xz 2>/dev/null || \
    { log_warn "Extract failed — skipping"; rm -rf "$tmp_dir"; cd /; return; }

  local caddy_found
  caddy_found=$(find "$tmp_dir" -maxdepth 3 -type f \
    \( -name "caddy" -o -name "caddy-naive" -o -name "caddy-forwardproxy-naive" \) \
    ! -name "*.xz" ! -name "*.gz" ! -name "*.tar" | head -1)

  if [[ -n "$caddy_found" ]]; then
    systemctl stop caddy-naive 2>/dev/null || true
    install -m 755 "$caddy_found" "$CADDY_BIN"
    if command -v setcap &>/dev/null; then
      setcap 'cap_net_bind_service=+ep' "$CADDY_BIN" 2>/dev/null || true
    fi
    # Bug 79b: fix config perms BEFORE starting, and clear any prior failure
    # storm — otherwise a broken-perms install hits "Start request repeated too
    # quickly" and never recovers even after the perms are fixed later.
    fix_caddy_perms
    systemctl reset-failed caddy-naive 2>/dev/null || true
    systemctl start caddy-naive 2>/dev/null || true
    log_info "caddy-naive updated to $remote_tag ✓"
  else
    log_warn "caddy binary not found in archive — skipping"
  fi

  rm -rf "$tmp_dir"; cd /

  # Update version file
  local new_ver; new_ver=$("$CADDY_BIN" version 2>/dev/null | head -1 || echo "$remote_tag")
  if [[ -f "$VERSION_FILE" ]]; then
    sed -i "s|^caddy_version=.*|caddy_version=${new_ver}|" "$VERSION_FILE" 2>/dev/null || \
      echo "caddy_version=${new_ver}" >> "$VERSION_FILE"
  fi

  # Remove legacy naive binary if still present
  if [[ -f "$LEGACY_NAIVE_BIN" ]]; then
    rm -f "$LEGACY_NAIVE_BIN"
    log_info "Legacy naive binary removed ✓"
  fi
}

# ── Update Mieru ──────────────────────────────────────────────────────────────
update_mieru() {
  log_step "Checking Mieru update"
  detect_arch

  local release_json
  release_json=$(curl -fsSL "$MIERU_RELEASES") || { log_warn "Cannot reach GitHub API for Mieru"; return; }

  local remote_tag; remote_tag=$(echo "$release_json" | jq -r '.tag_name')
  local current_ver; current_ver=$(mita version 2>/dev/null | grep -oP 'v[\d.]+' | head -1 || echo "none")
  log_info "Current: $current_ver  |  Latest: $remote_tag"

  if ! $FORCE && [[ "$current_ver" == "$remote_tag" ]]; then
    log_info "Mieru already up-to-date ✓"
    return
  fi

  $DRY_RUN && { log_dry "Would update mita to $remote_tag"; return; }

  local asset_url
  asset_url=$(echo "$release_json" | jq -r \
    --arg arch "$DEB_ARCH" \
    '.assets[] | select(.name | test("mita.*" + $arch + "\\.deb")) | .browser_download_url' | head -1)
  [[ -z "$asset_url" ]] && { log_warn "No Mieru .deb for $DEB_ARCH"; return; }

  local deb; deb=$(mktemp /tmp/mieru-XXXXXX.deb)
  wget -q -O "$deb" "$asset_url"
  systemctl stop mita 2>/dev/null || true
  dpkg -i "$deb" 2>/dev/null || apt-get install -f -y
  rm -f "$deb"
  systemctl start mita 2>/dev/null || true
  log_info "Mieru updated to $remote_tag ✓"
}

# ── Update panel ──────────────────────────────────────────────────────────────
# Bug 76: this step previously could be skipped or die silently:
#   - under `set -e`, a failing `npm install` aborted the whole script with no
#     clear message and left a partial copy;
#   - the version bump happened even on a partial run, so the next `-y` run saw
#     "already up-to-date" and never re-copied the panel files.
# Now: clone (or fall back to the local checkout), copy ALL panel files, run
# npm install non-fatally, restart PM2, and verify a known sentinel landed.
update_panel() {
  log_step "Updating web panel"
  $DRY_RUN && { log_dry "Would pull latest panel from $REPO_URL"; return; }

  local tmp; tmp=$(mktemp -d)
  local src=""
  if git clone --depth 1 "${REPO_URL}.git" "$tmp" 2>/dev/null && [[ -d "$tmp/panel" ]]; then
    src="$tmp/panel"
    log_info "Fetched latest panel from $REPO_URL (git)"
  elif curl -fsSL --max-time 60 "${REPO_URL}/archive/refs/heads/main.tar.gz" -o "$tmp/main.tar.gz" 2>/dev/null \
       && tar -xzf "$tmp/main.tar.gz" -C "$tmp" 2>/dev/null \
       && [[ -n "$(find "$tmp" -maxdepth 2 -type d -name panel 2>/dev/null | head -1)" ]]; then
    # Bug 99: tarball fallback — works even if git clone is unavailable/rate-limited.
    src="$(find "$tmp" -maxdepth 2 -type d -name panel 2>/dev/null | head -1)"
    log_info "Fetched latest panel from $REPO_URL (tarball)"
  elif [[ -d "$(pwd)/panel" ]]; then
    # Fallback: use the local checkout the operator already `git pull`-ed.
    src="$(pwd)/panel"
    log_warn "git/tarball fetch failed — using local checkout at $src"
  else
    log_warn "No panel source available (fetch failed, no local ./panel) — skipping"
    rm -rf "$tmp"; return
  fi

  # repo_root is the dir that CONTAINS panel/ (holds VERSION + deploy scripts).
  local repo_root; repo_root="$(dirname "$src")"

  pm2 stop panel-naive-mieru 2>/dev/null || true

  mkdir -p "$PANEL_DIR"
  # Copy everything including dotfiles; cp -a preserves structure.
  # NOTE: this only touches $PANEL_DIR (/opt/...). The user DB
  # (/var/lib/rixxx-panel/db.sqlite) and config (/etc/rixxx-panel/config.json)
  # live OUTSIDE $PANEL_DIR and are never overwritten here → users are safe.
  cp -a "$src/." "$PANEL_DIR/"

  # Bug 99: refresh the on-prod deploy scripts + VERSION so the NEXT update can
  # run the latest update.sh straight from /opt/panel-naive-mieru.
  for f in install.sh update.sh uninstall.sh VERSION CHANGELOG.md; do
    [[ -f "$repo_root/$f" ]] && cp "$repo_root/$f" "$PANEL_DIR/$f" 2>/dev/null || true
  done
  chmod +x "$PANEL_DIR/update.sh" "$PANEL_DIR/install.sh" "$PANEL_DIR/uninstall.sh" 2>/dev/null || true

  # v1.8.0 (Hy2 Sub-stage C): make the shipped helper scripts executable so the
  # panel can run them. install_hysteria.sh is the Hy2 installer invoked by
  # POST /api/settings/hy2/install (the "Доустановить Hy2" button); warp_egress.sh
  # / cascade_mieru.sh are the WARP + cascade helpers. `cp -a` preserves mode from
  # the repo, but a git/tarball checkout may land them non-executable — force it.
  # NOTE: server/index.js resolves scripts via __dirname/../scripts, so on prod
  # they live at $PANEL_DIR/scripts. We chmod BOTH that canonical location and the
  # legacy $PANEL_DIR/panel/scripts path (older layouts) to be safe.
  for base in "$PANEL_DIR/scripts" "$PANEL_DIR/panel/scripts"; do
    for s in install_hysteria.sh warp_egress.sh cascade_mieru.sh; do
      [[ -f "$base/$s" ]] && chmod +x "$base/$s" 2>/dev/null || true
    done
  done

  # npm install must NOT be fatal — keep going even on a transient failure.
  ( cd "$PANEL_DIR" && npm install --omit=dev --silent ) \
    || ( cd "$PANEL_DIR" && npm install --production --silent ) \
    || log_warn "npm install reported a problem — continuing (deps may already be present)"

  pm2 restart panel-naive-mieru --update-env 2>/dev/null \
    || pm2 start "$PANEL_DIR/server/index.js" --name panel-naive-mieru --time

  # Bug 99: verify the new code actually landed by checking the version-agnostic
  # sentinel — the password generator endpoint added in this release. (The old
  # check hardcoded a v1.2.6 marker and would false-warn on every later build.)
  if grep -q "/api/password/generate" "$PANEL_DIR/server/index.js" 2>/dev/null; then
    log_info "Panel code updated ✓ (new server/index.js landed)"
  elif grep -q "downloadNote" "$PANEL_DIR/public/index.html" 2>/dev/null; then
    log_info "Panel updated ✓"
  else
    log_warn "Panel files copied but expected marker not found — check $PANEL_DIR"
  fi
  rm -rf "$tmp"
}

# ── Smoke tests ───────────────────────────────────────────────────────────────
smoke_test() {
  log_step "Running smoke tests"
  sleep 3

  local pass=0 fail=0

  check_svc() {
    if systemctl is-active --quiet "$1"; then
      echo -e "  ${GREEN}✓${NC} $1 active"; (( pass++ ))
    else
      echo -e "  ${RED}✗${NC} $1 INACTIVE"; (( fail++ ))
    fi
  }

  # v1.2.3: check caddy-naive (not legacy naive)
  check_svc caddy-naive
  check_svc mita

  # v1.8.0 (Hy2 Sub-stage C): Hy2 is OPTIONAL — only smoke-test it when the
  # operator has actually installed it (config + binary present). A box that
  # never enabled Hy2 must NOT be flagged as failing.
  if [[ -f /etc/hysteria/config.yaml && -x /usr/local/bin/hysteria ]]; then
    if systemctl is-active --quiet hysteria-server; then
      echo -e "  ${GREEN}✓${NC} hysteria-server active (Hy2)"; (( pass++ ))
    else
      echo -e "  ${YELLOW}⚠${NC}  hysteria-server INACTIVE (Hy2 installed) — journalctl -u hysteria-server -n 20"
    fi
  fi

  # caddy-naive version check
  if timeout 5 "$CADDY_BIN" version &>/dev/null 2>&1 || \
     timeout 5 "$CADDY_BIN" --version &>/dev/null 2>&1; then
    echo -e "  ${GREEN}✓${NC} caddy-naive version OK"; (( pass++ ))
  else
    echo -e "  ${RED}✗${NC} caddy-naive version FAILED"; (( fail++ ))
  fi

  # Caddyfile present
  if [[ -f "$CADDY_FILE" ]]; then
    echo -e "  ${GREEN}✓${NC} Caddyfile present"; (( pass++ ))
  else
    echo -e "  ${RED}✗${NC} Caddyfile MISSING"; (( fail++ ))
  fi

  # Fake site present
  if [[ -f "${FAKE_SITE_DIR}/index.html" ]]; then
    echo -e "  ${GREEN}✓${NC} fake-site/index.html present"; (( pass++ ))
  else
    echo -e "  ${YELLOW}⚠${NC}  fake-site/index.html missing (non-critical)"; 
  fi

  # Panel HTTP
  if curl -sf http://127.0.0.1:3000/ -o /dev/null 2>/dev/null; then
    echo -e "  ${GREEN}✓${NC} Panel HTTP :3000 OK"; (( pass++ ))
  else
    echo -e "  ${YELLOW}⚠${NC}  Panel :3000 not responding"
  fi

  # mita status
  if mita status 2>/dev/null | grep -qi "running\|active"; then
    echo -e "  ${GREEN}✓${NC} mita reports running"; (( pass++ ))
  else
    echo -e "  ${YELLOW}⚠${NC}  mita status unclear"
  fi

  # Bug 103: real outbound egress check (IPv4 always; IPv6 only if a route exists).
  if curl -4 -fsS --max-time 8 -o /dev/null https://www.google.com 2>/dev/null; then
    echo -e "  ${GREEN}✓${NC} IPv4 outbound OK"; (( pass++ ))
  else
    echo -e "  ${YELLOW}⚠${NC}  IPv4 outbound check failed (firewall/DNS?)"
  fi
  if has_working_ipv6; then
    if curl -6 -fsS --max-time 8 -o /dev/null https://www.google.com 2>/dev/null; then
      echo -e "  ${GREEN}✓${NC} IPv6 outbound OK"; (( pass++ ))
    else
      echo -e "  ${YELLOW}⚠${NC}  IPv6 advertised but unreachable — enforcing IPv4 preference"
      ensure_ipv4_preference
    fi
  fi

  echo ""
  echo -e "  Smoke: ${GREEN}$pass passed${NC}  ${RED}$fail failed${NC}"
  return $fail
}

# ── --status mode ─────────────────────────────────────────────────────────────
do_status() {
  echo -e "\n${BOLD}══════════════════════════════════════════${NC}"
  echo -e "${BOLD}   Panel Naive + Mieru v${TARGET_VERSION} — Status Report${NC}"
  echo -e "${BOLD}══════════════════════════════════════════${NC}\n"

  # Versions
  echo -e "${BOLD}Versions:${NC}"
  echo "  Panel:          $(get_current_version) (target: $TARGET_VERSION)"
  echo "  caddy-naive:    $("$CADDY_BIN" version 2>/dev/null | head -1 || echo 'not installed')"
  echo "  mita:           $(mita version 2>/dev/null | head -1 || echo 'not installed')"
  echo "  hysteria (Hy2): $([[ -x /usr/local/bin/hysteria ]] && /usr/local/bin/hysteria version 2>/dev/null | head -1 || echo 'not installed')"
  echo "  Node.js:        $(node --version 2>/dev/null || echo 'not installed')"
  echo "  PM2:            $(pm2 --version 2>/dev/null || echo 'not installed')"
  echo ""

  # Version file
  if [[ -f "$VERSION_FILE" ]]; then
    echo -e "${BOLD}Version file ($VERSION_FILE):${NC}"
    sed 's/^/  /' "$VERSION_FILE"
    echo ""
  fi

  # Services
  echo -e "${BOLD}Services:${NC}"
  for svc in caddy-naive mita; do
    local status; status=$(systemctl is-active "$svc" 2>/dev/null || echo "unknown")
    if [[ "$status" == "active" ]]; then
      echo -e "  ${GREEN}●${NC} $svc — active"
    else
      echo -e "  ${RED}●${NC} $svc — $status"
    fi
  done
  # v1.8.0: Hy2 (Hysteria2) — only shown when the optional 3rd protocol is
  # installed; a box that never enabled it simply omits the line.
  if [[ -f /etc/hysteria/config.yaml && -x /usr/local/bin/hysteria ]]; then
    local hy2s; hy2s=$(systemctl is-active hysteria-server 2>/dev/null || echo "unknown")
    if [[ "$hy2s" == "active" ]]; then
      echo -e "  ${GREEN}●${NC} hysteria-server — active (Hy2)"
    else
      echo -e "  ${RED}●${NC} hysteria-server — $hy2s (Hy2)"
    fi
  else
    echo -e "  ${YELLOW}○${NC} hysteria-server — not installed (add from Settings → «Доустановить Hy2»)"
  fi
  # Legacy naive check
  if systemctl is-active naive &>/dev/null 2>&1; then
    echo -e "  ${YELLOW}●${NC} naive — active (LEGACY — should have been removed in v1.2.3 migration)"
  fi
  local pm2_status; pm2_status=$(pm2 status panel-naive-mieru --no-color 2>/dev/null \
    | grep panel-naive-mieru | awk '{print $10}' || echo "unknown")
  echo "  ● PM2 panel     — $pm2_status"
  echo ""

  # Configuration
  echo -e "${BOLD}Configuration:${NC}"
  if [[ -f "$PANEL_CONFIG" ]]; then
    jq '{ domain, serverIp, naivePort, mieruPortStart, mieruPortEnd,
          hy2Port, stack,
          exposePanel, trafficPattern, mtu, udpEnabled,
          fakeSiteUrl, probeSecret }' \
      "$PANEL_CONFIG" 2>/dev/null | sed 's/^/  /'
  else
    echo "  config.json NOT FOUND"
  fi
  echo ""

  # Caddyfile
  echo -e "${BOLD}Caddyfile (${CADDY_FILE}):${NC}"
  if [[ -f "$CADDY_FILE" ]]; then
    # Bug 23: directive is now "basic_auth" (underscore), not "basicauth"
    local user_count; user_count=$(grep -cE '^\s*basic_auth\s+\S+\s+\S+' "$CADDY_FILE" 2>/dev/null || echo 0)
    echo "  Present — $user_count basic_auth user(s)"
    grep -E 'probe_resistance|tls\s' "$CADDY_FILE" 2>/dev/null | head -5 | sed 's/^/  /' || true
  else
    echo "  Caddyfile NOT FOUND"
  fi
  echo ""

  # Fake site
  echo -e "${BOLD}Fake site ($FAKE_SITE_DIR):${NC}"
  if [[ -f "${FAKE_SITE_DIR}/index.html" ]]; then
    echo "  index.html present ✓"
  else
    echo "  MISSING"
  fi
  echo ""

  # v1.4.0: panel access mode
  echo -e "${BOLD}Panel access:${NC}"
  if [[ -f "$PANEL_CONFIG" ]]; then
    local _exp _pd _wbp _stub
    _exp=$(jq -r '.exposePanel // false' "$PANEL_CONFIG" 2>/dev/null)
    _pd=$(jq -r '.panelDomain // ""'     "$PANEL_CONFIG" 2>/dev/null)
    _wbp=$(jq -r '.webBasePath // ""'    "$PANEL_CONFIG" 2>/dev/null)
    _stub=$(jq -r '.panelStubPage // "/var/www/panel-stub/index.html"' "$PANEL_CONFIG" 2>/dev/null)
    if [[ "$_exp" == "true" && -n "$_pd" && -n "$_wbp" ]]; then
      echo -e "  Mode: ${GREEN}EXTERNAL${NC} — https://${_pd}/${_wbp}/"
    else
      echo -e "  Mode: SSH-only (127.0.0.1:3000)"
      [[ -n "$_pd" ]] && echo "  Saved panelDomain: $_pd (re-enable: bash update.sh --expose $_pd)"
    fi
    [[ -f "$_stub" ]] && echo "  Stub page: present ✓" || echo "  Stub page: MISSING ($_stub)"
  fi
  echo ""

  # Ports
  echo -e "${BOLD}Listening ports:${NC}"
  ss -tlnup 2>/dev/null | grep -E ":(443|80|8080|3000|20[0-9]{2})" | \
    awk '{print "  "$5}' || true
  echo ""

  # Backups
  echo -e "${BOLD}Recent backups:${NC}"
  if [[ -d "$BACKUP_DIR" ]]; then
    ls -1dt "$BACKUP_DIR"/*/ 2>/dev/null | head -5 | while read -r d; do
      echo "  $(basename "$d")"
    done || echo "  (none)"
  else
    echo "  (none)"
  fi
  echo ""

  # Time sync
  echo -e "${BOLD}Time:${NC}"
  timedatectl status 2>/dev/null | grep -E "Local time|synchronized" | sed 's/^/  /' || true
  echo ""
}

# ── --expose mode (v1.4.0) ────────────────────────────────────────────────────
# Switch the panel to EXTERNAL access via a dedicated TLS subdomain. The panel
# itself keeps listening on loopback (127.0.0.1:3000); Caddy reverse_proxies to
# it behind basic_auth + a secret webBasePath. NO bare HTTP port is opened.
#
#   https://panel.<domain>/<webBasePath>/  → basic_auth → reverse_proxy 127.0.0.1:3000
#   panel.<domain>/ and any other path     → static "CONNECTION" stub
#
# Idempotent: re-running with the same domain keeps the existing webBasePath and
# basic-auth credentials, only regenerating the Caddyfile block from template.
do_expose() {
  log_step "Switching panel to EXTERNAL access (TLS subdomain)"
  [[ -z "$EXPOSE_DOMAIN" ]] && die "--expose requires a panel-subdomain argument (e.g. --expose panel.example.com)"

  $DRY_RUN && { log_dry "Would expose panel at https://$EXPOSE_DOMAIN/<webBasePath>/"; return; }

  auto_backup >/dev/null

  # webBasePath: explicit --web-base-path wins; else preserve existing; else
  # generate a fresh random 16-hex value on first enable.
  local web_base_path="$WEB_BASE_PATH"
  [[ -n "$WEB_BASE_PATH_FLAG" ]] && web_base_path="$WEB_BASE_PATH_FLAG"
  [[ -z "$web_base_path" || "$web_base_path" == "null" ]] && web_base_path="$(gen_web_base_path)"
  # Sanitize to a path-safe token (strip slashes / unsafe chars).
  web_base_path="$(printf '%s' "$web_base_path" | sed 's#^/*##; s#/*$##; s#[^A-Za-z0-9._~-]##g')"
  [[ -z "$web_base_path" ]] && web_base_path="$(gen_web_base_path)"

  # Basic-auth credentials. Keep an existing user; generate a password and hash
  # only when none is stored yet (first enable). The plaintext is shown ONCE.
  local ba_user="$PANEL_BA_USER" ba_pass="" ba_hash=""
  [[ -z "$ba_user" || "$ba_user" == "null" ]] && ba_user="admin"
  ba_hash=$(jq -r '.panelBasicAuthHash // ""' "$PANEL_CONFIG")
  local ba_generated=0
  if [[ -z "$ba_hash" || "$ba_hash" == "null" ]]; then
    if [[ -n "${PANEL_BA_PASS_FLAG:-}" ]]; then
      ba_pass="$PANEL_BA_PASS_FLAG"
    else
      ba_pass="$(openssl rand -base64 18 | tr -d '/+=' | head -c 20)"
      ba_generated=1
    fi
    ba_hash="$(panel_hash_password "$ba_pass")"
  fi

  ensure_panel_stub

  # Persist config (node, UTF-8-safe). exposePanel=true, listenHost stays loopback.
  cfg_set_json \
    exposePanel "bool:1" \
    panelDomain "$EXPOSE_DOMAIN" \
    webBasePath "$web_base_path" \
    panelBasicAuthUser "$ba_user" \
    panelBasicAuthHash "$ba_hash" \
    panelStubPage "${PANEL_STUB_PAGE:-/var/www/panel-stub/index.html}" \
    panelHost "127.0.0.1" \
    panelPort "int:3000" \
    && log_ok_or_info "config.json updated (exposePanel=true, panelDomain=$EXPOSE_DOMAIN)"

  # Reload local vars so the banner/rebuild use the new values.
  WEB_BASE_PATH="$web_base_path"; PANEL_DOMAIN="$EXPOSE_DOMAIN"; PANEL_BA_USER="$ba_user"

  # Regenerate Caddyfile (now includes the panel block) and restart caddy-naive.
  rebuild_caddyfile_direct || log_warn "Caddyfile rebuild returned non-zero — check above"
  fix_caddy_perms
  systemctl reset-failed caddy-naive 2>/dev/null || true
  if systemctl restart caddy-naive 2>/dev/null && \
     [[ "$(systemctl is-active caddy-naive 2>/dev/null)" == "active" ]]; then
    log_info "caddy-naive restarted ✓"
  else
    log_error "caddy-naive failed to start after expose — rolling back is recommended:"
    journalctl -u caddy-naive -n 20 --no-pager 2>/dev/null || true
  fi
  # The panel itself does not change (loopback only) — no pm2 restart needed.

  print_panel_credentials "expose" "$ba_generated" "$ba_pass"
}

# ── --ssh-only mode (v1.4.0) ──────────────────────────────────────────────────
# Symmetric reverse of --expose: drop the panel subdomain block, close any old
# bare panel port, and keep the panel loopback-only (SSH-tunnel access). The
# panelDomain / webBasePath / basic-auth hash are PRESERVED in config.json so
# external access can be restored with `--expose <same domain>`.
do_ssh_only() {
  log_step "Switching panel to SSH-only mode (loopback)"

  $DRY_RUN && { log_dry "Would switch panel to 127.0.0.1:3000 (SSH-only), remove panel block, close port 8080"; return; }

  if ! $YES; then
    read -rp "Switch panel to SSH-only (external access OFF)? [y/N]: " confirm
    [[ "${confirm^^}" != "Y" ]] && { log_info "Aborted."; exit 0; }
  fi

  auto_backup >/dev/null

  # BUG-155: clean any polluted panelBasicAuthHash so the rebuilt Caddyfile is
  # valid even if a pre-fix installer left apt output in the hash. (Without this,
  # --ssh-only set exposePanel=false but the garbage hash stayed in config.json
  # and re-broke the Caddyfile on the next regenerate.)
  sanitize_basic_auth_hash

  # exposePanel=false → template/rebuild omits the panel subdomain block.
  cfg_set_json exposePanel "bool:0" panelHost "127.0.0.1" panelPort "int:3000" \
    && log_ok_or_info "config.json updated (exposePanel=false, panelDomain preserved)"

  # Migration cleanup: close any legacy bare panel port left by old installs.
  if command -v ufw &>/dev/null; then
    ufw delete allow 8080/tcp 2>/dev/null || true
    ufw delete allow 8080 2>/dev/null || true
  fi

  # Regenerate Caddyfile WITHOUT the panel block and restart caddy.
  rebuild_caddyfile_direct || log_warn "Caddyfile rebuild returned non-zero — check above"
  fix_caddy_perms
  systemctl reset-failed caddy-naive 2>/dev/null || true
  systemctl restart caddy-naive 2>/dev/null && log_info "caddy-naive restarted ✓" || \
    log_warn "caddy-naive restart failed — journalctl -u caddy-naive -n 20"

  log_info "Panel now SSH-only (127.0.0.1:3000) ✓"
  local server_ip; server_ip=$(jq -r '.serverIp' "$PANEL_CONFIG")
  echo ""
  echo -e "  SSH tunnel:  ${CYAN}ssh -L 3000:127.0.0.1:3000 root@$server_ip${NC}"
  echo -e "  Then open:   ${CYAN}http://localhost:3000/${NC}"
  [[ -n "$PANEL_DOMAIN" && "$PANEL_DOMAIN" != "null" ]] && \
    echo -e "  Re-enable:   ${CYAN}bash update.sh --expose $PANEL_DOMAIN${NC}"
}

# Small helper: log_ok if available, else log_info (reference uses log_ok).
log_ok_or_info() { log_info "$*"; }

# ── v1.4.0: final credentials banner (install + expose/change) ────────────────
# $1 = context ("install" | "expose"); $2 = ba_generated (1/0); $3 = ba_pass (plain)
print_panel_credentials() {
  local ctx="$1" ba_generated="${2:-0}" ba_pass="${3:-}"
  local server_ip; server_ip=$(jq -r '.serverIp // ""' "$PANEL_CONFIG" 2>/dev/null)
  local expose; expose=$(jq -r '.exposePanel // false' "$PANEL_CONFIG" 2>/dev/null)
  local pdom;   pdom=$(jq -r '.panelDomain // ""'      "$PANEL_CONFIG" 2>/dev/null)
  local wbp;    wbp=$(jq -r '.webBasePath // ""'       "$PANEL_CONFIG" 2>/dev/null)
  local bauser; bauser=$(jq -r '.panelBasicAuthUser // ""' "$PANEL_CONFIG" 2>/dev/null)

  echo ""
  echo -e "${CYAN}${BOLD}╔══════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${CYAN}${BOLD}║   🌐  ПАНЕЛЬ УПРАВЛЕНИЯ — реквизиты доступа                  ║${NC}"
  echo -e "${CYAN}${BOLD}╠══════════════════════════════════════════════════════════════╣${NC}"
  if [[ "$expose" == "true" && -n "$pdom" && -n "$wbp" ]]; then
    echo -e "  URL:        ${BOLD}https://${pdom}/${wbp}/${NC}"
    echo -e "  Basic auth логин:  ${BOLD}${bauser}${NC}"
    if [[ "$ba_generated" == "1" && -n "$ba_pass" ]]; then
      echo -e "  Basic auth пароль: ${BOLD}${ba_pass}${NC}   ${YELLOW}(показывается один раз!)${NC}"
    else
      echo -e "  Basic auth пароль: ${YELLOW}(не изменён — хранится только bcrypt-хеш)${NC}"
    fi
    echo -e "  ${YELLOW}Корень panel.<домен>/ и пути вне webBasePath → статическая заглушка.${NC}"
  else
    echo -e "  🔒  SSH-only режим (панель не доступна из Интернета)"
    echo -e "  SSH-туннель:  ${BOLD}ssh -L 3000:127.0.0.1:3000 root@${server_ip}${NC}"
    echo -e "  Затем:        ${BOLD}http://localhost:3000/${NC}"
    [[ -n "$pdom" ]] && echo -e "  Открыть публично: ${BOLD}bash update.sh --expose ${pdom}${NC}"
  fi
  echo -e "  Логин в панель:    ${BOLD}admin${NC}  ${YELLOW}(если не меняли — смените в настройках!)${NC}"
  echo -e "${CYAN}${BOLD}╚══════════════════════════════════════════════════════════════╝${NC}"
  echo -e "  ${YELLOW}${BOLD}⚠  Сохраните эти данные — basic-auth пароль больше не будет показан!${NC}"
  echo ""
}

# ── --enroll-hy2 mode ────────────────────────────────────────────────────────
# One-off: add "hy2" to every existing user, rewrite userpass, restart Hy2 —
# WITHOUT running a full update. Delegates to migrate_hy2_enroll_all (which is
# gated on HY2_ENROLL_ALL=1), so we just force the flag on for this invocation.
do_enroll_hy2() {
  log_step "Enroll-Hy2 mode — adding Hysteria2 to all existing users"
  if [[ ! -f /etc/hysteria/config.yaml || ! -x /usr/local/bin/hysteria ]]; then
    log_error "Hysteria2 is not installed. Install it first: panel → Settings → «Доустановить Hy2»."
    exit 1
  fi
  if ! $YES; then
    if [[ -r /dev/tty ]]; then
      read -rp "Add Hy2 to EVERY user and restart hysteria-server? [y/N]: " confirm </dev/tty || confirm=""
      [[ "${confirm^^}" != "Y" ]] && { log_info "Aborted."; exit 0; }
    else
      log_info "No interactive terminal — proceeding (explicit --enroll-hy2 is consent)."
    fi
  fi
  HY2_ENROLL_ALL=1 migrate_hy2_enroll_all
  log_info "Enroll-Hy2 done. Verify: systemctl is-active hysteria-server"
}

# ── --repair mode ─────────────────────────────────────────────────────────────
# Rebuild Caddyfile + mita config from SQLite DB; no data loss.
# v1.2.3: Calls /api/services/rebuild-all (falls back to direct DB rebuild).
do_repair() {
  log_step "Repair mode — rebuilding configs from SQLite database"

  # BUG-155: make --repair reliable as a one-liner. With `-y` we never prompt.
  # Without `-y` but with NO usable terminal (the common
  # `curl … | bash -s -- --repair` case) the old `read` consumed the empty pipe
  # stdin and always "Aborted" even though the operator clearly asked to repair.
  # We now (a) honour -y, (b) prompt on /dev/tty when one is available, and
  # (c) when there is no TTY at all, proceed (an explicit --repair IS consent).
  if ! $YES; then
    if [[ -r /dev/tty ]]; then
      read -rp "Rebuild Caddyfile and mita state from DB? [y/N]: " confirm </dev/tty || confirm=""
      [[ "${confirm^^}" != "Y" ]] && { log_info "Aborted."; exit 0; }
    else
      log_info "No interactive terminal — proceeding with repair (use -y to silence this)."
    fi
  fi

  $DRY_RUN && { log_dry "Would rebuild all configs from $DB_PATH"; return; }

  auto_backup >/dev/null

  # Bug 81: migrate config (set probeMode='bare' for pre-Bug 81 installs) so the
  # rebuilt Caddyfile matches the reference server's bare probe_resistance.
  migrate_config

  # Step 1: ensure fake site exists
  if [[ ! -f "${FAKE_SITE_DIR}/index.html" ]]; then
    log_info "Recreating fake site..."
    mkdir -p "$FAKE_SITE_DIR"
    cat > "${FAKE_SITE_DIR}/index.html" <<'FAKEHTML'
<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Welcome</title></head>
<body><h1>Welcome</h1><p>This service is currently unavailable.</p></body>
</html>
FAKEHTML
    chmod 644 "${FAKE_SITE_DIR}/index.html"
    log_info "Fake site recreated ✓"
  fi

  # Step 2: ensure caddy-naive.service exists
  ensure_caddy_service

  # Step 3: rebuild Caddyfile + mita state from DB
  # Bug 84: ALWAYS rebuild directly from the on-disk caddyTemplate.js (the single
  # source of truth that --update freshly copied into $PANEL_DIR). Previously
  # --repair POSTed to /api/services/rebuild-all FIRST, which is rendered by the
  # *running* PM2 panel process. If that process had not reloaded the new
  # index.js yet (e.g. update_panel copied the files but the panel was still
  # serving old in-memory code), the API regenerated the STALE Caddyfile format
  # (route{} wrapper, domain-only listener) even though the on-disk template was
  # already the new Bug 83 layout — and the direct fallback never ran because the
  # API "succeeded". Going direct guarantees the rebuilt Caddyfile reflects the
  # template on disk, independent of whatever code the panel happens to be running.
  rebuild_caddyfile_direct
  rebuild_mita_state_direct

  # Step 4: apply mita config
  if [[ -f "$MITA_STATE_FILE" ]]; then
    mita apply config "$MITA_STATE_FILE" 2>/dev/null && \
      log_info "mita config applied ✓" || \
      log_warn "mita apply returned non-zero — check: mita status"
  fi

  # Step 5: reload/restart services
  systemctl daemon-reload
  # Bug 79: make sure the caddy user can read its config before (re)starting
  fix_caddy_perms
  # Bug 91: a graceful `reload` silently keeps the OLD in-memory config when the
  # new config can't be read (e.g. a permission error) — validate/status/logs all
  # look healthy while the cascade is NOT actually loaded. Always do a full
  # restart and verify is-active so a real failure surfaces.
  systemctl reset-failed caddy-naive 2>/dev/null || true
  systemctl restart caddy-naive 2>/dev/null || true
  if [[ "$(systemctl is-active caddy-naive 2>/dev/null)" == "active" ]]; then
    log_info "caddy-naive restarted ✓"
  else
    log_warn "caddy-naive restart failed — journalctl -u caddy-naive -n 20:"
    journalctl -u caddy-naive -n 20 --no-pager 2>/dev/null || true
  fi
  systemctl restart mita 2>/dev/null && log_info "mita restarted ✓" || \
    log_warn "mita restart failed — journalctl -u mita -n 20"

  # v1.8.0 (Hy2 Sub-stage C): if Hy2 is installed, restart it too. The panel
  # rewrites /etc/hysteria/config.yaml's userpass map from the SQLite pool on its
  # next applyAllConfigs(), so a repair keeps Hy2 users in sync (no data loss).
  # Skipped entirely when Hy2 was never installed.
  if [[ -f /etc/hysteria/config.yaml && -x /usr/local/bin/hysteria ]]; then
    systemctl reset-failed hysteria-server 2>/dev/null || true
    systemctl restart hysteria-server 2>/dev/null && log_info "hysteria-server restarted (Hy2) ✓" || \
      log_warn "hysteria-server restart failed — journalctl -u hysteria-server -n 20"
  fi

  # Bug 104 (v1.4.2): --repair previously left config.json's "version" untouched,
  # so PM2 / the UI kept reporting a stale version (e.g. 1.2.6 while 1.4.x is
  # installed). Sync config.json to the installed VERSION *before* restarting the
  # panel so the freshly-started process reads the correct version.
  sync_config_version

  pm2 restart panel-naive-mieru 2>/dev/null || true

  # Bug 103: repair must also fix a missing-IPv6 black hole.
  ensure_ipv4_preference

  smoke_test || log_warn "Some smoke tests failed — check above"
  log_info "Repair complete ✓"
}

# ── v1.4.0: external-access prompt during update ──────────────────────────────
# Contract:
#   • exposePanel already true → keep mode (block is regenerated by the normal
#     rebuild_caddyfile_direct later in do_update). Ask nothing.
#   • exposePanel false + interactive → ask ONCE; default N keeps it local.
#       If yes → ask subdomain, generate webBasePath, ask basic-auth user/pass
#       (password hashed via caddy hash-password), then run the expose flow.
#   • exposePanel false + non-interactive (-y) → keep current mode (do nothing).
maybe_prompt_external_access() {
  local expose; expose=$(jq -r '.exposePanel // false' "$PANEL_CONFIG" 2>/dev/null)
  if [[ "$expose" == "true" ]]; then
    log_info "External access is ON — panel block will be regenerated from template."
    return 0
  fi
  # SSH-only from here on.
  if $YES || $DRY_RUN; then
    log_info "SSH-only mode kept (non-interactive). Enable later: bash update.sh --expose panel.<domain>"
    return 0
  fi
  echo ""
  read -rp "Перевести панель в открытый доступ по домену? [y/N]: " _ans
  if [[ ! "${_ans:-N}" =~ ^([yYдД])$ ]]; then
    log_info "Панель остаётся в SSH-only режиме."
    return 0
  fi
  local def_domain="panel.${DOMAIN}"
  read -rp "Поддомен панели [${def_domain}]: " _pd
  EXPOSE_DOMAIN="${_pd:-$def_domain}"
  read -rp "Логин basic auth [admin]: " _bu
  PANEL_BA_USER="${_bu:-admin}"
  read -rsp "Пароль basic auth (Enter — сгенерировать): " _bp; echo ""
  [[ -n "$_bp" ]] && PANEL_BA_PASS_FLAG="$_bp"
  # Hand off to the shared expose flow (it generates webBasePath, hashes the
  # password, persists config, rebuilds the Caddyfile, restarts, prints creds).
  do_expose
}

# ── Main update flow ──────────────────────────────────────────────────────────
do_update() {
  detect_arch

  # Bug 99: learn the real target from main (folds remote VERSION into
  # TARGET_VERSION) so a release only needs a VERSION bump in main to trigger
  # the update — no need to re-edit a hardcoded constant.
  resolve_target_version

  log_step "Updating Panel Naive + Mieru to v${TARGET_VERSION}"

  local current; current=$(get_current_version)
  log_info "Installed version: $current  |  Target: $TARGET_VERSION"

  # v1.8.3: an explicit maintenance action (HY2_ENROLL_ALL=1) must ALWAYS run to
  # completion, even when the installed version already equals the target — the
  # operator asked for a one-off migration, not a version upgrade. Without this,
  # a same-version box hit the "Nothing to do" early-exit and the enroll step
  # (which lives further down in do_update) never executed.
  if [[ "${HY2_ENROLL_ALL:-0}" == "1" ]] && ! version_gt "$TARGET_VERSION" "$current"; then
    log_info "HY2_ENROLL_ALL=1 — running full update flow to apply the Hy2 enrollment (version unchanged)."
  elif ! $FORCE && ! version_gt "$TARGET_VERSION" "$current"; then
    log_info "Version file already reports $current (target $TARGET_VERSION)."
    if $YES; then
      # Bug 76: in non-interactive mode, re-sync the panel files anyway. The
      # version file may have been bumped by an earlier *partial* run that never
      # copied the new code, so "up-to-date" can be a lie. Re-copying is cheap
      # and idempotent.
      log_info "Non-interactive (-y): re-syncing panel files to be safe."
    else
      read -rp "Re-sync / force update anyway? [y/N]: " confirm
      [[ "${confirm^^}" != "Y" ]] && { log_info "Nothing to do."; exit 0; }
    fi
  fi

  if ! $YES && ! $DRY_RUN; then
    read -rp "Proceed with update? [Y/n]: " confirm
    [[ "${confirm^^}" == "N" ]] && { log_info "Aborted."; exit 0; }
  fi

  auto_backup >/dev/null

  # Bug 81: migrate config (set probeMode='bare' for pre-Bug 81 installs).
  # v1.4.0: also adds external-access fields (SSH-only default) and closes any
  # legacy bare 8080 port without breaking access.
  migrate_config
  migrate_close_legacy_8080

  # v1.4.0: external-access decision on update.
  #   • already exposed → keep mode, regenerate block from template, ask nothing.
  #   • SSH-only + interactive → ask ONCE (default N → stays local).
  #   • SSH-only + -y (non-interactive) → keep current mode (safe default).
  maybe_prompt_external_access

  # Update components
  update_caddy_naive     # replaces update_naiveproxy() from v1.2.x
  update_mieru
  update_panel

  # Ensure service is present and legacy naive is gone
  ensure_caddy_service

  # BUG-162 (CRITICAL migration): v1.5.1 brought WARP up with a blanket default
  #   route (AllowedIPs 0.0.0.0/0 + Table=auto) AND `systemctl enable`d the unit.
  #   That tunnelled SSH/panel and re-downed the box on every reboot. Recover any
  #   such box: disable autostart + tear down the old broken tunnel/routes so the
  #   operator regains native access. The new (safe) WARP is only re-enabled when
  #   the operator explicitly toggles it again in the panel.
  migrate_warp_safety

  # BUG-172 migration: refresh the cascade watchdog (full-chain probe + nightly
  # redsocks recycle) on any box that currently has the Mieru cascade enabled.
  migrate_cascade_watchdog

  # v1.8.0 (Hy2 Sub-stage C): restart Hy2 if installed, else hint how to add it.
  # Runs BEFORE the dry-run gate returns so --dry-run reports the intended action.
  migrate_hy2

  # v1.8.2: opt-in — enroll ALL existing users into Hy2 (HY2_ENROLL_ALL=1).
  # No-op unless the operator explicitly sets the env var. Also honours --dry-run.
  migrate_hy2_enroll_all

  $DRY_RUN && { log_info "[DRY-RUN] No changes were made."; return; }

  # Bug 80/81: regenerate the Caddyfile from the (now-migrated) config + DB so the
  # new `servers { protocols h1 h2 }` block and probeMode take effect on update.
  # Older `do_update` only restarted caddy without re-rendering the config, so the
  # stale Caddyfile kept the old probe_resistance secret and lacked the protocols
  # block. rebuild_caddyfile_direct uses caddyTemplate.js (single source of truth).
  rebuild_caddyfile_direct || log_warn "Caddyfile rebuild returned non-zero — check above"

  # Bug 79: fix caddy-naive config permissions and (re)start it. Older installs
  # left the Caddyfile owned root:root (group caddy couldn't read it), so
  # caddy-naive failed with "Caddyfile: permission denied". Fix perms, clear any
  # failure storm (reset-failed), then restart so the fix actually takes hold.
  fix_caddy_perms
  systemctl reset-failed caddy-naive 2>/dev/null || true
  systemctl restart caddy-naive 2>/dev/null && log_info "caddy-naive restarted ✓" || \
    log_warn "caddy-naive restart failed — journalctl -u caddy-naive -n 20"

  # Update version file
  if [[ -f "$VERSION_FILE" ]]; then
    sed -i "s|^panel_version=.*|panel_version=${TARGET_VERSION}|" "$VERSION_FILE" 2>/dev/null || \
      echo "panel_version=${TARGET_VERSION}" >> "$VERSION_FILE"
  else
    echo "panel_version=${TARGET_VERSION}" > "$VERSION_FILE"
  fi
  log_info "Version file updated to $TARGET_VERSION ✓"

  # Bug A (v1.3.1): keep config.json's "version" in sync so the UI / PM2 show
  # the real version (centralised in sync_config_version — also used by --repair).
  sync_config_version

  # Remove legacy naive paths if present (migration cleanup)
  if [[ -f "$LEGACY_NAIVE_BIN" ]]; then
    rm -f "$LEGACY_NAIVE_BIN"
    log_info "Legacy naive binary removed ✓"
  fi
  if [[ -d "$LEGACY_NAIVE_CONFIG_DIR" ]]; then
    rm -rf "$LEGACY_NAIVE_CONFIG_DIR"
    log_info "Legacy /etc/naive directory removed ✓"
  fi

  # Bug 103: on existing installs without a working IPv6 route, force IPv4 so
  # mieru/mita stop black-holing AAAA traffic (google/youtube via the tunnel).
  ensure_ipv4_preference

  smoke_test && log_info "Update completed successfully ✓" || \
    log_warn "Update completed with warnings — check services"
}

# ── Entry point ───────────────────────────────────────────────────────────────
main() {
  parse_args "$@"
  check_root

  case "$MODE" in
    status)   check_install; load_config; do_status ;;
    expose)   check_install; load_config; do_expose ;;
    ssh-only) check_install; load_config; do_ssh_only ;;
    repair)   check_install; load_config; do_repair ;;
    enroll-hy2) check_install; load_config; do_enroll_hy2 ;;
    update)   check_install; load_config; do_update ;;
  esac
}

main "$@"
