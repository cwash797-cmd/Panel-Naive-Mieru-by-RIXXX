#!/usr/bin/env bash
# Prepare an end-of-life Debian 11 VPS for the shared Panel Naive + Mieru installer.
# Run as root before install.sh. This only targets the stock Debian 11 APT setup.
set -Eeuo pipefail

readonly SNAPSHOT="20260831T235959Z"
readonly MANAGED_HEADER="# Managed by Panel Naive + Mieru Debian 11 bootstrap"
readonly SOURCE_LIST="/etc/apt/sources.list"
readonly BACKUP_DIR="/var/backups/rixxx-debian11-bootstrap"
readonly BUILD_MARKER="/var/lib/rixxx-panel/build-native-from-source"

log() { printf '[bootstrap-debian11] %s\n' "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: sudo bash bootstrap-debian11.sh

Run this once on a clean Debian 11 (Bullseye) VPS before install.sh.
It configures the final Debian snapshot from 2026-08-31, installs the C/C++
toolchain and Python needed to compile Node native modules, and marks the
server so install.sh builds better-sqlite3 from source.

Debian 11 is out of official security support. The configured package snapshot
is frozen and will not receive future security updates.
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi
[[ $# -eq 0 ]] || die "Unknown argument: $1"
[[ $EUID -eq 0 ]] || die "Run as root: sudo bash bootstrap-debian11.sh"
[[ -r /etc/os-release ]] || die "/etc/os-release is missing"
# shellcheck disable=SC1091
source /etc/os-release
[[ "${ID:-}" == debian && "${VERSION_ID:-}" == 11 ]] || \
  die "This helper is only for Debian 11 (detected ${ID:-unknown} ${VERSION_ID:-unknown})."

command -v apt-get >/dev/null 2>&1 || die "apt-get is not available"
command -v python3 >/dev/null 2>&1 || die "python3 is required to validate the existing APT sources"
[[ -f "$SOURCE_LIST" ]] || die "$SOURCE_LIST is missing; refusing to replace an unknown APT setup"

if ! grep -qF "$MANAGED_HEADER" "$SOURCE_LIST"; then
  # Do not silently discard provider or third-party repositories. The helper
  # intentionally handles only the stock Debian 11 sources.list layout.
  if compgen -G '/etc/apt/sources.list.d/*.list' >/dev/null || \
     compgen -G '/etc/apt/sources.list.d/*.sources' >/dev/null; then
    for source_file in /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do
      [[ -f "$source_file" ]] || continue
      if grep -Eqv '^[[:space:]]*(#|$)' "$source_file"; then
        die "Active extra APT source found at $source_file. Review/disable it manually, then rerun."
      fi
    done
  fi

  python3 - "$SOURCE_LIST" <<'PY'
import re
import sys

path = sys.argv[1]
source_re = re.compile(r"^\s*deb(?:-src)?\s+(?:\[[^]]*\]\s+)?(?P<uri>\S+)\s+(?P<suite>\S+)")
allowed_uris = {
    "http://deb.debian.org/debian", "https://deb.debian.org/debian",
    "http://security.debian.org/debian-security", "https://security.debian.org/debian-security",
}
allowed_suites = {"bullseye", "bullseye-updates", "bullseye-security"}
active = []
with open(path, encoding="utf-8") as source_list:
    for number, line in enumerate(source_list, 1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        match = source_re.match(line)
        if not match:
            raise SystemExit(f"Unsupported active APT source on {path}:{number}; no changes made")
        uri, suite = match.group("uri").rstrip("/"), match.group("suite")
        if uri not in allowed_uris or suite not in allowed_suites:
            raise SystemExit(f"Non-stock APT source on {path}:{number}; no changes made")
        active.append((uri, suite))
if not active:
    raise SystemExit(f"No active Debian 11 sources found in {path}; no changes made")
PY

  mkdir -p "$BACKUP_DIR"
  if [[ ! -e "$BACKUP_DIR/sources.list.original" ]]; then
    cp -a "$SOURCE_LIST" "$BACKUP_DIR/sources.list.original"
    log "Saved original APT sources to $BACKUP_DIR/sources.list.original"
  fi

  source_tmp=$(mktemp /etc/apt/sources.list.XXXXXX)
  cat >"$source_tmp" <<EOF
$MANAGED_HEADER
# Frozen at Debian 11's official LTS end date. These repositories do not get
# security updates after this snapshot.
deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/${SNAPSHOT}/ bullseye main
deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/${SNAPSHOT}/ bullseye-updates main
deb [check-valid-until=no] https://snapshot.debian.org/archive/debian-security/${SNAPSHOT}/ bullseye-security main
EOF
  chmod 0644 "$source_tmp"
  mv "$source_tmp" "$SOURCE_LIST"
  log "Configured the signed Debian snapshot from ${SNAPSHOT}"
else
  log "Debian snapshot sources are already configured"
fi

export DEBIAN_FRONTEND=noninteractive
log "Refreshing APT metadata"
apt-get -o Acquire::Retries=3 update
log "Installing native module build requirements"
apt-get -o Acquire::Retries=3 install -y --no-install-recommends build-essential python3

for tool in make g++ python3; do
  command -v "$tool" >/dev/null 2>&1 || die "Required build tool was not installed: $tool"
done

install -d -m 0755 "$(dirname "$BUILD_MARKER")"
cat >"$BUILD_MARKER" <<EOF
Debian 11 requires better-sqlite3 to be compiled against this host's glibc.
Prepared by bootstrap-debian11.sh using Debian snapshot ${SNAPSHOT}.
EOF
chmod 0644 "$BUILD_MARKER"

log "Bootstrap complete. Run the shared installer next: bash install.sh"
log "APT source backup: $BACKUP_DIR/sources.list.original"
log "Reminder: Debian 11 is EOL; the configured repository snapshot is frozen."
