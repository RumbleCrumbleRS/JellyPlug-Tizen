#!/usr/bin/env bash
# Build a webOS .ipk for jellyfin-tv-shell.
#
# Requires: ares-cli (`@webos-tools/cli`). CI installs it via npm.
# Stub for post-Tizen port; flesh out with actual ares-package invocation.
set -euo pipefail
mkdir -p dist
echo "webos build placeholder - implemented after Tizen prototype" > dist/jellyfin-tv-shell.ipk.placeholder
