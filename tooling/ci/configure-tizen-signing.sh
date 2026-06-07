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
# Print a NON-SECRET structural diagnosis of a decoded .p12 so a failure tells
# the secret owner exactly which knob is wrong (no key material is revealed —
# only the leading bytes / file shape).
diagnose_p12() {
  local p12="$1" magic
  magic="$(head -c 4 "$p12" | od -An -tx1 | tr -d ' \n')"
  echo "       diagnostic: first bytes = ${magic}, size = $(stat -c%s "$p12" 2>/dev/null) bytes" >&2
  case "$magic" in
    3082*) echo "       -> header is DER SEQUENCE (a valid PKCS#12 starts 3082): the file" >&2
           echo "          looks like a real .p12, so the PASSWORD secret is the mismatch." >&2 ;;
    2d2d2d*) echo "       -> starts with '---' (PEM): the secret is a PEM cert/key, not a" >&2
             echo "          PKCS#12. Build one: openssl pkcs12 -export -inkey k.pem -in c.pem -out cert.p12" >&2 ;;
    *) if head -c 64 "$p12" | LC_ALL=C grep -qE '^[A-Za-z0-9+/=[:space:]]+$'; then
         echo "       -> decoded bytes look like base64 TEXT, not binary DER: the secret is" >&2
         echo "          probably DOUBLE base64-encoded. Encode the raw .p12 once: base64 -w0 cert.p12" >&2
       else
         echo "       -> unrecognized header: the secret is likely not a PKCS#12 file at all." >&2
       fi ;;
  esac
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
  echo "       without openssl -legacy). Re-check the cert/password pair stored" >&2
  echo "       in the CI secrets." >&2
  diagnose_p12 "$p12"
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

# Add the profile with BOTH certs in one call. The author cert establishes the
# package author identity; the distributor cert (-d/-dp) is the second signature
# a retail TV validates on install — without it the package is author-only and a
# TV rejects it. There is no separate `security-profiles add-distributor`
# subcommand (the Tizen CLI only exposes list/add/set-active/remove); the
# distributor is registered via the -d/-dp flags of `add` itself. (JEL-15)
tizen security-profiles add \
  -n "$PROFILE_NAME" \
  -a "$author_p12" \
  -p "$AUTHOR_PW" \
  -d "$dist_p12" \
  -dp "$DIST_PW"

echo "Tizen signing profile '$PROFILE_NAME' configured (author + distributor)."
echo "Pass it to packaging with: tizen package -t wgt -s $PROFILE_NAME -- ."
