#!/usr/bin/env bash
# Rebuild better-sqlite3 when the host's glibc predates the version the npm
# package's bundled prebuilt binary needs (currently Debian 11 and Ubuntu
# 20.04; see bootstrap-debian11.sh and bootstrap-ubuntu20.sh). Called after
# npm install by install.sh and update.sh; harmless on all other systems,
# since the marker file below is only written by those bootstrappers.
set -euo pipefail

readonly BUILD_MARKER="/var/lib/rixxx-panel/build-native-from-source"
readonly SQLITE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../node_modules/better-sqlite3" 2>/dev/null && pwd || true)"
readonly PREBUILT="${SQLITE_DIR}/prebuilds/linux-x64.node"

[[ -f "$BUILD_MARKER" ]] || exit 0
[[ -d "$SQLITE_DIR" ]] || {
  echo "[native-sqlite] better-sqlite3 is not installed; skipping rebuild" >&2
  exit 0
}
[[ -f "$PREBUILT" ]] || exit 0

echo "[native-sqlite] Rebuilding better-sqlite3 against this host's glibc"
(cd "$SQLITE_DIR" && npm run build-release --silent)
rm -f "$PREBUILT"
echo "[native-sqlite] Using the locally compiled better-sqlite3 binary"
