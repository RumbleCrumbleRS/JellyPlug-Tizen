#!/usr/bin/env bash
# Build a signed Tizen .wgt for @jellyfin-tv/shell-tizen.
#
# Layout:
#   src/                  source tree (index.html, shell.js, connect/, icon.png)
#   tizen/config.xml      Tizen widget manifest
#   build/widget/         staged widget root (generated)
#   dist/                 final .wgt output (generated)
#
# Requires: Tizen Studio CLI on PATH (`tizen`, ~5.5+) with an active
# signing profile. CI installs this in a Tizen Studio container. Locally
# the VirtualCertificate / TVs profile configured during JEL-3 works.
#
# Usage: pnpm -C packages/shell-tizen build
#        (or)  bash scripts/build-wgt.sh

set -euo pipefail

PKG_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC_DIR="$PKG_DIR/src"
CONFIG_XML="$PKG_DIR/tizen/config.xml"
STAGE_DIR="$PKG_DIR/build/widget"
DIST_DIR="$PKG_DIR/dist"
WGT_NAME="JellyPlug.wgt"

# Pick the right CLI binary:
#   - Linux/macOS containers ship `tizen` (CI image).
#   - Windows local dev uses `tizen.bat` from <tizen-studio>/tools/ide/bin.
TIZEN_CLI=""
if command -v tizen >/dev/null 2>&1; then
  TIZEN_CLI="tizen"
elif command -v tizen.bat >/dev/null 2>&1; then
  TIZEN_CLI="tizen.bat"
elif [[ -x "/c/tizen-studio/tools/ide/bin/tizen.bat" ]]; then
  TIZEN_CLI="/c/tizen-studio/tools/ide/bin/tizen.bat"
else
  echo "ERROR: Tizen CLI not found. Install Tizen Studio and ensure" >&2
  echo "       <tizen-studio>/tools/ide/bin is on PATH (or set up CI image)." >&2
  exit 1
fi

echo ">> staging widget"
rm -rf "$STAGE_DIR" "$DIST_DIR"
mkdir -p "$STAGE_DIR" "$DIST_DIR"
cp -R "$SRC_DIR"/. "$STAGE_DIR"/
cp "$CONFIG_XML" "$STAGE_DIR/config.xml"

# JEL-124: drop build-input sources the widget never loads. index.html loads
# shell.min.js (and lazily babel.min.js); shell.js is the editable source that
# build_shell_min.py compiles, qa-beacon.js is baked INTO shell.min.js at build
# time, and *.eb_clean is a build_shell_min.py byproduct. Shipping them costs
# every TV ~200 KB of download/install/storage for bytes that are never parsed.
# MUST stay in lockstep with tooling/ci/verify-wgt-source-match.sh and
# scripts/wgt-source-match.test.cjs (JEL-121 guard).
rm -f "$STAGE_DIR/shell.js" "$STAGE_DIR/qa-beacon.js" "$STAGE_DIR"/*.eb_clean

# JEL-100: strip the QA-only seed block (auto-connect server URL + QA overlay/
# telemetry-beacon gate + placeholder flags) out of the staged index.html so it
# never ships in a retail WGT. SHELL_QA_BUILD=1 keeps + substitutes it instead.
bash "$PKG_DIR/scripts/process-qa-seed.sh" "$STAGE_DIR/index.html"

echo ">> "$TIZEN_CLI" build-web"
# build-web walks the staged dir, rejects manifest violations, and writes
# the packaged tree into .buildResult inside the widget root.
( cd "$STAGE_DIR" && "$TIZEN_CLI" build-web -- . )

# Tizen build-web emits .buildResult under the input dir.
BUILD_RESULT="$STAGE_DIR/.buildResult"

# Allow overriding the signing profile (SDK certs for general distribution
# vs. TV certs for a specific device). Defaults to the active profile.
SIGNING_PROFILE="${SIGNING_PROFILE:-}"
PACKAGE_ARGS=( "package" "-t" "wgt" "-o" "$DIST_DIR" )
if [[ -n "$SIGNING_PROFILE" ]]; then
  PACKAGE_ARGS+=( "-s" "$SIGNING_PROFILE" )
fi
PACKAGE_ARGS+=( "--" "." )

echo ">> $TIZEN_CLI ${PACKAGE_ARGS[*]}"
( cd "$BUILD_RESULT" && "$TIZEN_CLI" "${PACKAGE_ARGS[@]}" )

# Tizen names the output after <name> in config.xml; rename to a stable
# filename so CI/QA always look in the same place.
shopt -s nullglob
EMITTED=( "$DIST_DIR"/*.wgt )
shopt -u nullglob
if [[ ${#EMITTED[@]} -eq 0 ]]; then
  echo "ERROR: no .wgt produced in $DIST_DIR" >&2
  exit 1
fi
if [[ "${EMITTED[0]##*/}" != "$WGT_NAME" ]]; then
  mv -f "${EMITTED[0]}" "$DIST_DIR/$WGT_NAME"
fi

echo ">> built: $DIST_DIR/$WGT_NAME"
ls -lh "$DIST_DIR/$WGT_NAME"
