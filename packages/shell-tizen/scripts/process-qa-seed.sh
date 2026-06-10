#!/usr/bin/env bash
# JEL-100: process the QA-only seed block in a STAGED index.html before packaging.
#
# src/index.html wraps a QA-only localStorage seed — auto-connect server URL, the
# QA overlay/telemetry-beacon gate (`jellyfin.qa.overlay`), the boot-mark gate,
# and the babel-preload / index-cache cold-boot flags — between these markers:
#
#   <!-- QA-SEED:START ... -->
#   <script> ...localStorage.setItem(...)... </script>
#   <!-- QA-SEED:END -->
#
# Default (RETAIL): the whole block is DELETED, so production WGTs never carry a
# baked-in server URL, the QA overlay/telemetry gate, or the un-substituted
# __*_SEED__ placeholders. This is the fix for JEL-100.
#
# SHELL_QA_BUILD=1 (QA build): the block is KEPT and its placeholders are
# substituted from the environment so a QA WGT auto-connects:
#   __QA_SERVER_URL__      <- SHELL_QA_SERVER_URL    (REQUIRED; if unset the
#                                                     block is stripped instead of
#                                                     shipping a placeholder URL)
#   __BABEL_PRELOAD_SEED__ <- SHELL_QA_BABEL_PRELOAD (default '1')
#   __INDEX_CACHE_SEED__   <- SHELL_QA_INDEX_CACHE   (default '')
#
# Idempotent: a file with no QA-SEED markers (already stripped) passes through
# unchanged.
#
# Usage: process-qa-seed.sh <staged-index.html>
set -euo pipefail

TARGET="${1:?usage: process-qa-seed.sh <index.html>}"
[[ -f "$TARGET" ]] || { echo "ERROR: not a file: $TARGET" >&2; exit 1; }

START_MARK='QA-SEED:START'
END_MARK='QA-SEED:END'

# Delete every line from the START marker through the END marker (inclusive).
strip_block() {
  awk -v s="$START_MARK" -v e="$END_MARK" '
    index($0, s) { skip = 1; next }
    skip == 1 && index($0, e) { skip = 0; next }
    skip == 1 { next }
    { print }
  ' "$1"
}

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

if [[ "${SHELL_QA_BUILD:-0}" == "1" && -n "${SHELL_QA_SERVER_URL:-}" ]]; then
  babel="${SHELL_QA_BABEL_PRELOAD:-1}"
  cache="${SHELL_QA_INDEX_CACHE:-}"
  # '|' delimiter: the server URL contains '/' but never '|'.
  sed -e "s|__QA_SERVER_URL__|${SHELL_QA_SERVER_URL}|g" \
      -e "s|__BABEL_PRELOAD_SEED__|${babel}|g" \
      -e "s|__INDEX_CACHE_SEED__|${cache}|g" \
      "$TARGET" > "$tmp"
  echo ">> QA seed KEPT (SHELL_QA_BUILD=1, server=${SHELL_QA_SERVER_URL})" >&2
else
  strip_block "$TARGET" > "$tmp"
  if [[ "${SHELL_QA_BUILD:-0}" == "1" ]]; then
    echo ">> SHELL_QA_BUILD=1 but SHELL_QA_SERVER_URL unset — QA seed STRIPPED" >&2
  else
    echo ">> QA seed block STRIPPED (retail build, JEL-100)" >&2
  fi
fi

mv "$tmp" "$TARGET"
trap - EXIT
