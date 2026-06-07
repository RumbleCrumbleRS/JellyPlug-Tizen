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
# Decode a base64 secret into a .p12, tolerating whitespace/newlines that a
# pasted GitHub secret often carries (a stray trailing newline silently
# corrupts the file and tizen then reports "Invalid file or password",
# masking the real cause). Fail with a precise message instead.
decode_p12() {
  local b64="$1" out="$2" label="$3"
  if ! printf '%s' "$b64" | tr -d '[:space:]' | base64 -d > "$out" 2>/dev/null; then
    echo "ERROR: $label is not valid base64 (decode failed)." >&2
    echo "       Re-encode the .p12 with: base64 -w0 cert.p12" >&2
    exit 1
  fi
  if [[ ! -s "$out" ]]; then
    echo "ERROR: $label decoded to an empty file — the secret is blank." >&2
    exit 1
  fi
}

# Returns (on stdout) the password variant that actually opens the .p12, so a
# trailing newline/CR on a pasted password secret doesn't masquerade as a
# wrong-password failure. We try the password as-given and with trailing
# CR/LF stripped; openssl 3 needs -legacy for the RC2/3DES p12s Tizen tooling
# emits, so each variant is tried both ways. If none open the file we fail
# with a precise diagnostic — at that point the cert/password pair itself is
# wrong and only whoever set the secrets can fix it.
_p12_opens() {  # p12, password -> 0 if openable
  openssl pkcs12 -in "$1" -passin "pass:$2" -nokeys -noout >/dev/null 2>&1 ||
  openssl pkcs12 -legacy -in "$1" -passin "pass:$2" -nokeys -noout >/dev/null 2>&1
}
resolve_password() {
  local p12="$1" pw="$2" label="$3" cleaned
  if ! command -v openssl >/dev/null 2>&1; then
    printf '%s' "$pw"; return 0   # can't validate here; let tizen be the judge
  fi
  cleaned="$(printf '%s' "$pw" | tr -d '\r\n')"
  local cand
  for cand in "$pw" "$cleaned"; do
    if _p12_opens "$p12" "$cand"; then
      printf '%s' "$cand"; return 0
    fi
  done
  echo "ERROR: $label — openssl could not open the .p12 with the given password" >&2
  echo "       (tried it as-is and with trailing newlines stripped, with and" >&2
  echo "       without openssl -legacy). The decoded file is either not a valid" >&2
  echo "       PKCS#12 cert or the password secret does not match it. Re-check" >&2
  echo "       the cert/password pair stored in the CI secrets." >&2
  exit 1
}

decode_p12 "$TIZEN_AUTHOR_P12_BASE64"      "$author_p12" "TIZEN_AUTHOR_P12_BASE64"
decode_p12 "$TIZEN_DISTRIBUTOR_P12_BASE64" "$dist_p12"   "TIZEN_DISTRIBUTOR_P12_BASE64"
chmod 600 "$author_p12" "$dist_p12"

# Resolve the effective passwords (newline-tolerant) and use them downstream.
AUTHOR_PW="$(resolve_password "$author_p12" "$TIZEN_AUTHOR_PASSWORD"      "author cert (TIZEN_AUTHOR_PASSWORD)")"
DIST_PW="$(resolve_password   "$dist_p12"   "$TIZEN_DISTRIBUTOR_PASSWORD" "distributor cert (TIZEN_DISTRIBUTOR_PASSWORD)")"

# Recreate the profile idempotently (CI runners may be reused).
if tizen security-profiles list 2>/dev/null | grep -qw "$PROFILE_NAME"; then
  echo "Profile '$PROFILE_NAME' already exists; recreating."
  tizen security-profiles remove -n "$PROFILE_NAME" || true
fi

# Author certificate establishes the package author identity.
tizen security-profiles add \
  -n "$PROFILE_NAME" \
  -a "$author_p12" \
  -p "$AUTHOR_PW"

# Distributor certificate is what a retail TV validates on install. Without
# this second signature the package is author-only and a TV rejects it.
tizen security-profiles add-distributor \
  -n "$PROFILE_NAME" \
  -d "$dist_p12" \
  -dp "$DIST_PW"

echo "Tizen signing profile '$PROFILE_NAME' configured (author + distributor)."
echo "Pass it to packaging with: tizen package -t wgt -s $PROFILE_NAME -- ."
