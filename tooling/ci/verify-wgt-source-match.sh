#!/usr/bin/env bash
# Guard: fail if a committed retail .wgt does not match the checked-out source.
#
# release-tizen.yml publishes a maintainer-built .wgt that is committed under
# release-artifacts/. JEL-8's guard proves it is *signed*, but a signature only
# proves who built it — not that the bytes correspond to the tagged source. A
# compromised local build machine (or a bad commit) could ship arbitrary signed
# bytes. This script rebuilds the retail widget *payload* from the checked-out
# tree (pure file staging — no Tizen CLI needed, `tizen build-web` is a
# pass-through for this project) and byte-compares it against the .wgt's
# entries, excluding only the signature files. Run it from a tag checkout and
# a tampered or stale artifact can no longer be published (JEL-121).
#
# Payload definition (must mirror packages/shell-tizen/scripts/build-wgt.sh):
#   packages/shell-tizen/src/**        -> widget root
#   packages/shell-tizen/tizen/config.xml -> config.xml
#   minus dev-only build inputs: shell.js, qa-beacon.js, *.eb_clean (JEL-124)
#   index.html QA-seed-stripped via process-qa-seed.sh (retail default;
#   SHELL_QA_BUILD is forcibly unset so a QA-seeded artifact always fails)
#
# Excluded from comparison: author-signature.xml, signature<N>.xml — those are
# the signer's output and are covered by verify-wgt-signed.sh instead.
#
# Usage:
#   tooling/ci/verify-wgt-source-match.sh path/to/JellyPlug.wgt
#
# Exit 0 = payload is byte-identical to the staged source; non-zero = any
# missing/extra/mismatched entry (each offender printed to stderr).
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <file.wgt>" >&2
  exit 2
fi
WGT="$1"
[[ -f "$WGT" ]] || { echo "FAIL  $WGT: not found" >&2; exit 1; }

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PKG_DIR="$REPO_ROOT/packages/shell-tizen"
SRC_DIR="$PKG_DIR/src"
CONFIG_XML="$PKG_DIR/tizen/config.xml"
QA_SEED_SCRIPT="$PKG_DIR/scripts/process-qa-seed.sh"

[[ -d "$SRC_DIR" ]]   || { echo "FAIL  source tree missing: $SRC_DIR" >&2; exit 1; }
[[ -f "$CONFIG_XML" ]] || { echo "FAIL  manifest missing: $CONFIG_XML" >&2; exit 1; }

STAGE_DIR="$(mktemp -d)"
trap 'rm -rf "$STAGE_DIR"' EXIT

# Mirror build-wgt.sh staging exactly.
cp -R "$SRC_DIR"/. "$STAGE_DIR"/
cp "$CONFIG_XML" "$STAGE_DIR/config.xml"
# JEL-124: build-input sources are excluded from the shipped payload (see
# build-wgt.sh) — a .wgt that still carries them now fails as "extra in .wgt".
rm -f "$STAGE_DIR/shell.js" "$STAGE_DIR/qa-beacon.js" "$STAGE_DIR"/*.eb_clean
if [[ -f "$QA_SEED_SCRIPT" ]]; then
  # Retail strip, never the QA substitution path — a release artifact carrying
  # the QA seed must fail this check (JEL-100).
  env -u SHELL_QA_BUILD bash "$QA_SEED_SCRIPT" "$STAGE_DIR/index.html" >/dev/null
fi

python3 - "$WGT" "$STAGE_DIR" <<'PY'
import hashlib, pathlib, re, sys, zipfile

wgt_path, stage_root = sys.argv[1], pathlib.Path(sys.argv[2])
SIG_RE = re.compile(r"^(author-signature\.xml|signature[0-9]+\.xml)$")

try:
    wgt = zipfile.ZipFile(wgt_path)
except zipfile.BadZipFile:
    print(f"FAIL  {wgt_path}: not a readable zip", file=sys.stderr)
    sys.exit(1)

wgt_entries = {n for n in wgt.namelist()
               if not n.endswith("/") and not SIG_RE.match(n)}
stage_entries = {str(p.relative_to(stage_root)).replace("\\", "/")
                 for p in stage_root.rglob("*") if p.is_file()}

problems = []
for name in sorted(wgt_entries - stage_entries):
    problems.append(f"extra in .wgt (not in tagged source): {name}")
for name in sorted(stage_entries - wgt_entries):
    problems.append(f"missing from .wgt (present in tagged source): {name}")
for name in sorted(wgt_entries & stage_entries):
    a = hashlib.sha256(wgt.read(name)).hexdigest()
    b = hashlib.sha256((stage_root / name).read_bytes()).hexdigest()
    if a != b:
        problems.append(f"content mismatch: {name} (wgt {a[:12]} != source {b[:12]})")

if problems:
    print(f"FAIL  {wgt_path}: payload does not match the checked-out source", file=sys.stderr)
    for p in problems:
        print(f"      {p}", file=sys.stderr)
    print("      Rebuild from the tagged commit via packages/shell-tizen/scripts/"
          "build-wgt.sh,", file=sys.stderr)
    print("      recommit the artifact, and re-tag (JEL-121).", file=sys.stderr)
    sys.exit(1)

print(f"OK    {wgt_path}: payload matches checked-out source "
      f"({len(wgt_entries)} entries, signatures excluded)")
PY
