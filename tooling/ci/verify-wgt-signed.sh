#!/usr/bin/env bash
# Guard: fail if a Tizen .wgt is not signed.
#
# A Tizen TV refuses to install an unsigned package. Every release .wgt MUST
# embed BOTH an author signature (author-signature.xml) and at least one
# distributor signature (signature1.xml). This script opens the .wgt (a zip)
# and asserts those entries exist, so CI can never publish an unsigned package
# again (see JEL-8).
#
# Usage:
#   tooling/ci/verify-wgt-signed.sh path/to/one.wgt [path/to/another.wgt ...]
#
# Exit code 0 = every .wgt is signed; non-zero = at least one is unsigned or
# unreadable (the offending file + reason is printed to stderr).
set -euo pipefail

AUTHOR_SIG="author-signature.xml"
DIST_SIG_RE='^signature[0-9]+\.xml$'

if [[ $# -eq 0 ]]; then
  echo "usage: $0 <file.wgt> [file.wgt ...]" >&2
  exit 2
fi

# List the entries of a zip without external `unzip` (not always on the CI
# image). Prefer `unzip -Z1`; fall back to python3's zipfile.
list_entries() {
  local wgt="$1"
  if command -v unzip >/dev/null 2>&1; then
    unzip -Z1 "$wgt"
  elif command -v python3 >/dev/null 2>&1; then
    python3 - "$wgt" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    print("\n".join(z.namelist()))
PY
  else
    echo "__NO_ZIP_READER__"
    return 1
  fi
}

fail=0
for wgt in "$@"; do
  if [[ ! -f "$wgt" ]]; then
    echo "FAIL  $wgt: not found" >&2
    fail=1
    continue
  fi

  if ! entries="$(list_entries "$wgt")"; then
    echo "FAIL  $wgt: could not read zip entries (no unzip/python3?)" >&2
    fail=1
    continue
  fi

  has_author=0
  has_dist=0
  while IFS= read -r entry; do
    base="${entry##*/}"
    [[ "$base" == "$AUTHOR_SIG" ]] && has_author=1
    [[ "$base" =~ $DIST_SIG_RE ]] && has_dist=1
  done <<< "$entries"

  missing=()
  [[ $has_author -eq 1 ]] || missing+=("$AUTHOR_SIG")
  [[ $has_dist -eq 1 ]]   || missing+=("signatureN.xml (distributor)")

  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "FAIL  $wgt: UNSIGNED — missing ${missing[*]}" >&2
    echo "      A Tizen TV will refuse to install this package. Sign it via" >&2
    echo "      'tizen package -t wgt -s <profile>' before releasing (JEL-8)." >&2
    fail=1
  else
    echo "OK    $wgt: signed (author + distributor)"
  fi
done

exit $fail
