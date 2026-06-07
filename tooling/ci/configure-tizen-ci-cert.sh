#!/usr/bin/env bash
# Configure a throwaway Tizen signing profile for the CI *build* job.
# Used by .github/workflows/ci.yml's build-tizen job.
#
# Why this exists (and is separate from configure-tizen-signing.sh):
#   `tizen package -t wgt` ALWAYS signs — there is no "unsigned" mode, and it
#   fails outright if no profile is active (see README.md / wgt-emulate docs:
#   "signing still applies, even on the emulator"). So the per-push/PR build
#   job needs *a* profile just to produce a .wgt.
#
#   We deliberately DO NOT reuse the 4 release secrets here. Coupling every
#   push/PR build to the retail signing key would (a) fail on fork PRs where
#   secrets are absent and (b) spend the real distributor identity on a smoke
#   build. The retail, TV-installable .wgt is bootstrap-sign.yml's job
#   (configure-tizen-signing.sh + the "jellyfin" profile). This script instead
#   mints an ephemeral self-signed author cert so the build is self-contained
#   and always green.
#
#   The resulting .wgt is TEST-signed: fine for verifying the build/package
#   pipeline and for the emulator, but NOT installable on a retail TV. That is
#   intentional — CI verifies the build; releases ship the signed artifact.
#
# The author cert is generated with openssl (deterministic, no Tizen-version
# flag drift) and imported with `tizen security-profiles add`, the same,
# CI-verified flags configure-tizen-signing.sh uses. A profile carrying only an
# author cert packages fine: Tizen Studio supplies its default distributor
# signer automatically during `tizen package`.
#
# Output: an active Tizen security profile (default name "ci"). Pass it to the
# build with:  SIGNING_PROFILE=ci pnpm --filter @jellyfin-tv/shell-tizen build
set -euo pipefail

PROFILE_NAME="${TIZEN_PROFILE_NAME:-ci}"
# A throwaway password for a throwaway, self-signed cert — there is no secret
# to protect here (the keypair is generated fresh each run and discarded).
CERT_PW="${TIZEN_CI_CERT_PASSWORD:-jellyplug-ci}"
CERT_DIR="$HOME/.tizen-ci-cert"

if ! command -v tizen >/dev/null 2>&1; then
  echo "ERROR: 'tizen' CLI not found on PATH. Install the Tizen Studio Web CLI" >&2
  echo "       before this step (see ci.yml build-tizen)." >&2
  exit 1
fi
if ! command -v openssl >/dev/null 2>&1; then
  echo "ERROR: openssl not found; cannot mint the CI author certificate." >&2
  exit 1
fi

mkdir -p "$CERT_DIR"
chmod 700 "$CERT_DIR"
key_pem="$CERT_DIR/author-key.pem"
cert_pem="$CERT_DIR/author-cert.pem"
author_p12="$CERT_DIR/author.p12"

echo ">> generating ephemeral self-signed author certificate"
openssl req -x509 -newkey rsa:2048 -keyout "$key_pem" -out "$cert_pem" \
  -days 3650 -nodes -subj "/CN=JellyPlug CI/O=JellyPlug/C=US" 2>/dev/null

# openssl 3 emits AES-based p12s by default; Tizen's bundled openssl path is
# happier with the legacy RC2/3DES algorithms. Prefer -legacy, fall back if the
# running openssl doesn't support it.
if ! openssl pkcs12 -export -inkey "$key_pem" -in "$cert_pem" -out "$author_p12" \
       -passout "pass:$CERT_PW" -name "JellyPlug CI" -legacy 2>/dev/null; then
  openssl pkcs12 -export -inkey "$key_pem" -in "$cert_pem" -out "$author_p12" \
    -passout "pass:$CERT_PW" -name "JellyPlug CI"
fi
chmod 600 "$author_p12"

if [[ ! -s "$author_p12" ]]; then
  echo "ERROR: failed to produce author.p12." >&2
  exit 1
fi

# Recreate idempotently (CI runners may be reused).
if tizen security-profiles list 2>/dev/null | grep -qw "$PROFILE_NAME"; then
  echo "Profile '$PROFILE_NAME' already exists; recreating."
  tizen security-profiles remove -n "$PROFILE_NAME" || true
fi

tizen security-profiles add \
  -n "$PROFILE_NAME" \
  -a "$author_p12" \
  -p "$CERT_PW"

echo "Ephemeral Tizen CI signing profile '$PROFILE_NAME' configured (test author cert)."
echo "Package with: SIGNING_PROFILE=$PROFILE_NAME pnpm --filter @jellyfin-tv/shell-tizen build"
