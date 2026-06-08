#!/usr/bin/env bash
# validate-jel7.sh — one-shot connect + install + (best-effort) inspect for JEL-7.
#
# Purpose: the moment the physical Samsung Tizen 5.0 (M63) TV at 192.168.0.10
# is powered on AND has authorized our sdb host, this script drives the entire
# install of the SIGNED retail bootstrap WGT end-to-end with no further
# engineering steps. It is intentionally idempotent and verbose.
#
# Why sdb install (not `tizen install` / `sdb shell pkgcmd`):
#   This TV reports intershell_support:disabled (JEL-2040), so `sdb shell` and
#   anything layered on it (pkgcmd, app_launcher, `tizen run --debug`) fail.
#   `sdb install <wgt>` uses the sdbd *install service* directly, which does NOT
#   require a shell, so it is the reliable install path for this device.
#
# Usage:
#   tooling/tv-validate/validate-jel7.sh [TV_IP] [SDB_BIN] [WGT_PATH]
#
# Defaults match the JEL-7 environment.
set -uo pipefail

TV_IP="${1:-192.168.0.10}"
SDB_BIN="${2:-${SDB_BIN:-$(command -v sdb || echo /tmp/sdbpkg/data/tools/sdb)}}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WGT_PATH="${3:-$REPO_ROOT/release-artifacts/bootstrap/v2.0.1/JellyfinShellBootstrap_v2.0.1.wgt}"
PKG_ID="JelShellTV.Jellyfin"

log()  { printf '\n\033[1;36m[validate-jel7]\033[0m %s\n' "$*"; }
fail() { printf '\n\033[1;31m[validate-jel7] FAIL:\033[0m %s\n' "$*" >&2; exit 1; }

[ -x "$SDB_BIN" ] || fail "sdb not found/executable at '$SDB_BIN' (pass as arg 2 or set SDB_BIN)"
[ -f "$WGT_PATH" ] || fail "signed WGT not found at '$WGT_PATH' (pass as arg 3)"

log "sdb: $SDB_BIN ($("$SDB_BIN" version 2>/dev/null | tr -d '\n'))"
log "WGT: $WGT_PATH ($(wc -c <"$WGT_PATH") bytes)"

# 0. Reachability preflight: distinguish "TV offline" from "TV up but unauthorized".
log "Preflight: probing sdbd port 26101 on $TV_IP ..."
if ! python3 - "$TV_IP" <<'PY'
import socket, sys
ip = sys.argv[1]
s = socket.socket(); s.settimeout(5)
try:
    s.connect((ip, 26101)); s.close(); print("  port 26101 OPEN"); sys.exit(0)
except Exception as e:
    print(f"  port 26101 unreachable: {type(e).__name__}"); sys.exit(1)
PY
then
  fail "TV sdbd port not reachable. The TV is powered off / asleep / off-network, OR Developer Mode is disabled. Power it on and enable Developer Mode, then re-run."
fi

"$SDB_BIN" start-server >/dev/null 2>&1

# 1. Connect.
log "sdb connect $TV_IP ..."
if ! "$SDB_BIN" connect "$TV_IP" 2>&1 | tee /tmp/jel7-connect.log | grep -qiE "connected|already"; then
  cat /tmp/jel7-connect.log
  fail "sdb connect rejected. Port is open but the handshake was refused — our host IP is not on the TV's Developer Mode allow-list. Accept the on-screen 'Allow connection' prompt at the TV (or set Host PC IP), then re-run."
fi

# 2. Resolve target name.
"$SDB_BIN" devices
TARGET="$("$SDB_BIN" devices | awk 'NR>1 && $0 !~ /offline/ {print $1; exit}')"
[ -n "${TARGET:-}" ] || fail "no online device in 'sdb devices' after connect"
log "target: $TARGET"

# 3. Install the signed WGT (install service; no shell needed).
log "Installing signed WGT via sdb install ..."
"$SDB_BIN" -s "$TARGET" install "$WGT_PATH" 2>&1 | tee /tmp/jel7-install.log

if grep -qiE "fail|error\[|signature" /tmp/jel7-install.log; then
  log "Install reported an error — retrying after uninstall of $PKG_ID ..."
  "$SDB_BIN" -s "$TARGET" uninstall "$PKG_ID" 2>&1 | tee /tmp/jel7-uninstall.log || true
  "$SDB_BIN" -s "$TARGET" install "$WGT_PATH" 2>&1 | tee /tmp/jel7-install.log
fi

grep -qiE "install.*(complete|success)|spend time|key\[end\]" /tmp/jel7-install.log \
  || fail "install did not report success — see /tmp/jel7-install.log"

log "INSTALL OK. App '$PKG_ID' is installed on $TARGET."

# 4. On-screen / CDP validation (HSB overlay, AC2-AC4).
#    NOTE: launching in debug mode for CDP relies on `tizen run --debug`, which
#    needs the `tizen` CLI AND a working remote shell. This TV has
#    intershell_support:disabled, so automated debug-launch is currently NOT
#    possible from the sandbox. Until intershell is re-enabled (or tizen CLI is
#    present on an authorized host), the HSB overlay must be confirmed on-screen:
#      - App icon shows on the TV launcher as 'JelShellTV.Jellyfin'
#      - Launch it; the HSB overlay shows __hsbState / __hsbShellUrl / __hsbFallback
#      - After HSB resolves, the Jellyfin connect form / client renders
log "Install phase complete. Proceed to on-screen HSB validation (see header note)."
log "If a debug-capable host is available, run: tooling/tv-inspect/tv-inspect.py --target $TARGET"
