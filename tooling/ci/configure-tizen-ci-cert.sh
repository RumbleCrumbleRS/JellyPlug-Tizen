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
CERT_PW="${TIZEN_CI_CERT_PASSWORD:-jellyplugci}"
CERT_DIR="$HOME/.tizen-ci-cert"

if ! command -v tizen >/dev/null 2>&1; then
  echo "ERROR: 'tizen' CLI not found on PATH. Install the Tizen Studio Web CLI" >&2
  echo "       before this step (see ci.yml build-tizen)." >&2
  exit 1
fi
mkdir -p "$CERT_DIR"
chmod 700 "$CERT_DIR"
author_p12="$CERT_DIR/author.p12"
rm -f "$author_p12"

# Primary path: let Tizen mint its own author cert. `tizen certificate` emits a
# PKCS#12 in exactly the format Tizen's own signer reads back at `tizen package`
# time, so there is no cross-toolchain (openssl 3 vs. old Java/BouncyCastle)
# algorithm mismatch to trip over. This is the canonical CI recipe.
echo ">> generating ephemeral self-signed author certificate (tizen certificate)"
if tizen certificate \
     --alias JellyPlugCI \
     --password "$CERT_PW" \
     --name "JellyPlug CI" \
     --organization JellyPlug \
     --country US \
     --filename author \
     -- "$CERT_DIR" 2>/dev/null && [[ -s "$author_p12" ]]; then
  echo ">> minted author.p12 via tizen certificate"
else
  # Fallback: mint with openssl. Tizen's signer runs on an old Java/BouncyCastle
  # that reads PKCS#12 files built with a SHA1 MAC + PBE-SHA1 (3DES). openssl 3
  # otherwise defaults to a SHA256 MAC + AES (and `-legacy` alone falls back to
  # 40-bit RC2, which JDK 17 restricts) — either is rejected at package time as
  # the misleading "CertificationException: Invaild password". Force the full
  # legacy/3DES set; -macalg sha1 is the critical knob.
  echo ">> 'tizen certificate' unavailable/failed; falling back to openssl (3DES p12)"
  if ! command -v openssl >/dev/null 2>&1; then
    echo "ERROR: 'tizen certificate' failed and openssl is absent; cannot mint cert." >&2
    exit 1
  fi
  key_pem="$CERT_DIR/author-key.pem"
  cert_pem="$CERT_DIR/author-cert.pem"
  openssl req -x509 -newkey rsa:2048 -keyout "$key_pem" -out "$cert_pem" \
    -days 3650 -nodes -subj "/CN=JellyPlug CI/O=JellyPlug/C=US" 2>/dev/null
  pbe_args=(-keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1)
  if ! openssl pkcs12 -export -inkey "$key_pem" -in "$cert_pem" -out "$author_p12" \
         -passout "pass:$CERT_PW" -name "JellyPlug CI" "${pbe_args[@]}" -legacy 2>/dev/null; then
    openssl pkcs12 -export -inkey "$key_pem" -in "$cert_pem" -out "$author_p12" \
      -passout "pass:$CERT_PW" -name "JellyPlug CI" "${pbe_args[@]}"
  fi
fi
chmod 600 "$author_p12"

if [[ ! -s "$author_p12" ]]; then
  echo "ERROR: failed to produce author.p12." >&2
  exit 1
fi

# `security-profiles add` persists each cert password to a sibling `.pwd` file
# whose path it records in profiles.xml. For the bundled distributor it targets
# the tizen-studio-DATA certificate tree — which a headless, CLI-only install
# never creates. The missing directory makes the .pwd write fail, so NO password
# files are written (author's included), and `tizen package` then signs with an
# empty password and dies with "CertificationException: Invaild password".
# Pre-create the expected data-dir tree so the password files can be written.
# (JEL-14: this, not the cert format or the JDK, was the real Build .wgt blocker.)
mkdir -p "$HOME/tizen-studio-data/tools/certificate-generator/certificates/distributor"

# Recreate idempotently (CI runners may be reused).
if tizen security-profiles list 2>/dev/null | grep -qw "$PROFILE_NAME"; then
  echo "Profile '$PROFILE_NAME' already exists; recreating."
  tizen security-profiles remove -n "$PROFILE_NAME" || true
fi

tizen security-profiles add \
  -n "$PROFILE_NAME" \
  -a "$author_p12" \
  -p "$CERT_PW"

# DIAG (JEL-14): confirm the author .p12 genuinely opens with CERT_PW, so we can
# tell a real password mismatch apart from a profiles.xml encryption round-trip
# bug when `tizen package` later reports "Invaild password".
if command -v openssl >/dev/null 2>&1; then
  if openssl pkcs12 -in "$author_p12" -passin "pass:$CERT_PW" -nokeys -noout 2>/dev/null \
     || openssl pkcs12 -legacy -in "$author_p12" -passin "pass:$CERT_PW" -nokeys -noout 2>/dev/null; then
    echo "DIAG: author.p12 opens with CERT_PW via openssl (cert+password are valid)"
  else
    echo "DIAG: author.p12 does NOT open with CERT_PW via openssl (cert/password mismatch)"
  fi
fi

echo "Ephemeral Tizen CI signing profile '$PROFILE_NAME' configured (test author cert)."
echo "Package with: SIGNING_PROFILE=$PROFILE_NAME pnpm --filter @jellyfin-tv/shell-tizen build"
