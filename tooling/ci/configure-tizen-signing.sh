#!/usr/bin/env bash
# Configure a Tizen signing profile from base64-encoded p12 secrets.
# Used by .github/workflows/release-tizen.yml.
#
# Inputs (CI secrets):
#   TIZEN_AUTHOR_P12_BASE64       base64 of the author .p12
#   TIZEN_AUTHOR_PASSWORD         password for the author .p12
#   TIZEN_DISTRIBUTOR_P12_BASE64  base64 of the distributor .p12
#   TIZEN_DISTRIBUTOR_PASSWORD    password for the distributor .p12
#   TIZEN_PROFILE_NAME            optional profile name (default: jellyfin)
#
# On success an active Tizen security profile named "$TIZEN_PROFILE_NAME"
# exists and `tizen package -t wgt -s "$TIZEN_PROFILE_NAME"` will emit a
# signed .wgt (author-signature.xml + signature1.xml). Verify the output
# with tooling/ci/verify-wgt-signed.sh (JEL-8).
#
# If TIZEN_AUTHOR_P12_BASE64 is unset the script is a no-op (exit 0) so that
# forks / PRs without the secret still pass — the downstream verify-wgt-signed
# guard is what blocks an unsigned release, not this script.
set -euo pipefail

PROFILE_NAME="${TIZEN_PROFILE_NAME:-jellyfin}"
SIGNING_DIR="$HOME/.tizen-signing"

if [[ -z "${TIZEN_AUTHOR_P12_BASE64:-}" ]]; then
  echo "TIZEN_AUTHOR_P12_BASE64 not set; skipping signing profile setup."
  echo "(A signed release still requires this secret — the verify-wgt-signed"
  echo " guard will fail the release if the .wgt is unsigned.)"
  exit 0
fi

# Fail loudly if a partial set of secrets is provided — a half-configured
# profile silently produces an author-only (still uninstallable) package.
require() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "ERROR: $name is required when TIZEN_AUTHOR_P12_BASE64 is set." >&2
    exit 1
  fi
}
require TIZEN_AUTHOR_PASSWORD
require TIZEN_DISTRIBUTOR_P12_BASE64
require TIZEN_DISTRIBUTOR_PASSWORD

if ! command -v tizen >/dev/null 2>&1; then
  echo "ERROR: 'tizen' CLI not found on PATH. The release job must run inside" >&2
  echo "       a Tizen Studio image (see release-tizen.yml container)." >&2
  exit 1
fi

mkdir -p "$SIGNING_DIR"
chmod 700 "$SIGNING_DIR"
author_p12="$SIGNING_DIR/author.p12"
dist_p12="$SIGNING_DIR/distributor.p12"
echo "$TIZEN_AUTHOR_P12_BASE64"      | base64 -d > "$author_p12"
echo "$TIZEN_DISTRIBUTOR_P12_BASE64" | base64 -d > "$dist_p12"
chmod 600 "$author_p12" "$dist_p12"

# Recreate the profile idempotently (CI runners may be reused).
if tizen security-profiles list 2>/dev/null | grep -qw "$PROFILE_NAME"; then
  echo "Profile '$PROFILE_NAME' already exists; recreating."
  tizen security-profiles remove -n "$PROFILE_NAME" || true
fi

# Author certificate establishes the package author identity.
tizen security-profiles add \
  -n "$PROFILE_NAME" \
  -a "$author_p12" \
  -p "$TIZEN_AUTHOR_PASSWORD"

# Distributor certificate is what a retail TV validates on install. Without
# this second signature the package is author-only and a TV rejects it.
tizen security-profiles add-distributor \
  -n "$PROFILE_NAME" \
  -d "$dist_p12" \
  -dp "$TIZEN_DISTRIBUTOR_PASSWORD"

echo "Tizen signing profile '$PROFILE_NAME' configured (author + distributor)."
echo "Pass it to packaging with: tizen package -t wgt -s $PROFILE_NAME -- ."
