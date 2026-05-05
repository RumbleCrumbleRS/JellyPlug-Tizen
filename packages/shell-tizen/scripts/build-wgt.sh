#!/usr/bin/env bash
# Build a Tizen .wgt for jellyfin-tv-shell.
#
# Requires: Tizen Studio CLI (`tizen` on PATH) with a configured signing
# profile. CI runs this in a container that ships Tizen Studio (see
# .github/workflows/ci.yml).
#
# Stub for [JEL-3] (Tizen prototype). The real implementation will:
#   1. Stage shell-core dist/, connect-screen/, and shell-tizen dist/ into a
#      build/tizen/ directory matching the .wgt layout.
#   2. Copy tizen/config.xml + icon.png.
#   3. Run `tizen build-web -- -out build/tizen/.buildResult` then
#      `tizen package -t wgt -o dist/ -- build/tizen/.buildResult`.
#   4. Verify signature with `tizen signing-profile`.
#
# For now we emit a placeholder so the CI scaffold has something to point at.

set -euo pipefail
mkdir -p dist
echo "tizen build placeholder - implemented in [JEL-3]" > dist/jellyfin-tv-shell.wgt.placeholder
