#!/usr/bin/env bash
# Prepare an Ubuntu 20.04 VPS for the shared Panel Naive + Mieru installer.
# Run as root before install.sh. This only targets the stock Ubuntu 20.04 setup.
set -Eeuo pipefail

readonly BUILD_MARKER="/var/lib/rixxx-panel/build-native-from-source"

log() { printf '[bootstrap-ubuntu20] %s\n' "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: sudo bash bootstrap-ubuntu20.sh

Run this once on a clean Ubuntu 20.04 (Focal Fossa) VPS before install.sh.
It installs gcc-10/g++-10 and makes them the default compiler, then marks
the server so install.sh builds better-sqlite3 from source instead of using
its bundled prebuilt binary.

Two separate problems make this necessary on Ubuntu 20.04:
  - better-sqlite3's prebuilt Linux binary is linked against a newer glibc
    than Ubuntu 20.04 ships (GLIBC_2.33; Ubuntu 20.04 has 2.31), so it fails
    to load and the panel silently falls back to an in-memory store.
  - Rebuilding it from source needs a C++20 compiler, but Ubuntu 20.04's
    stock g++ (9.4) only understands the pre-standardization `-std=c++2a`
    spelling and rejects better-sqlite3's `-std=c++20` flag outright.
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi
[[ $# -eq 0 ]] || die "Unknown argument: $1"
[[ $EUID -eq 0 ]] || die "Run as root: sudo bash bootstrap-ubuntu20.sh"
[[ -r /etc/os-release ]] || die "/etc/os-release is missing"
# shellcheck disable=SC1091
source /etc/os-release
[[ "${ID:-}" == ubuntu && "${VERSION_ID:-}" == "20.04" ]] || \
  die "This helper is only for Ubuntu 20.04 (detected ${ID:-unknown} ${VERSION_ID:-unknown})."

command -v apt-get >/dev/null 2>&1 || die "apt-get is not available"

export DEBIAN_FRONTEND=noninteractive
log "Refreshing APT metadata"
apt-get -o Acquire::Retries=3 update
log "Installing native module build requirements (gcc-10/g++-10 for C++20 support)"
apt-get -o Acquire::Retries=3 install -y --no-install-recommends \
  build-essential python3 gcc-10 g++-10

update-alternatives --install /usr/bin/gcc gcc /usr/bin/gcc-10 100
update-alternatives --install /usr/bin/g++ g++ /usr/bin/g++-10 100
update-alternatives --set gcc /usr/bin/gcc-10
update-alternatives --set g++ /usr/bin/g++-10

for tool in make g++ gcc python3; do
  command -v "$tool" >/dev/null 2>&1 || die "Required build tool was not installed: $tool"
done
gxx_major="$(g++ -dumpversion | cut -d. -f1)"
[[ "$gxx_major" -ge 10 ]] || die "g++ did not switch to gcc-10 (still reports version $gxx_major)"

install -d -m 0755 "$(dirname "$BUILD_MARKER")"
cat >"$BUILD_MARKER" <<EOF
Ubuntu 20.04 requires better-sqlite3 to be compiled against this host's
glibc, using gcc-10/g++-10 for C++20 support.
Prepared by bootstrap-ubuntu20.sh.
EOF
chmod 0644 "$BUILD_MARKER"

log "Bootstrap complete. Run the shared installer next: bash install.sh"
log "Reminder: Ubuntu 20.04 reached standard EOL in April 2025; Ubuntu 22.04+ is recommended for new installations."
