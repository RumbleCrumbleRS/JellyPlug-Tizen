#!/usr/bin/env bash
# Configure a Tizen signing profile from base64-encoded p12 secrets.
# Used by .github/workflows/release-tizen.yml. Stub - real implementation
# uses `tizen security-profiles add` once we wire up the production cert.
set -euo pipefail

if [[ -z "${TIZEN_AUTHOR_P12_BASE64:-}" ]]; then
  echo "TIZEN_AUTHOR_P12_BASE64 not set; skipping signing profile setup."
  exit 0
fi

mkdir -p "$HOME/.tizen-signing"
echo "$TIZEN_AUTHOR_P12_BASE64" | base64 -d > "$HOME/.tizen-signing/author.p12"
echo "$TIZEN_DISTRIBUTOR_P12_BASE64" | base64 -d > "$HOME/.tizen-signing/distributor.p12"

# tizen security-profiles add -n jellyfin -a "$HOME/.tizen-signing/author.p12" -p "$TIZEN_AUTHOR_PASSWORD"
# tizen security-profiles add-distributor -n jellyfin -d "$HOME/.tizen-signing/distributor.p12" -dp "$TIZEN_DISTRIBUTOR_PASSWORD"
echo "Tizen signing profile placeholder configured."
