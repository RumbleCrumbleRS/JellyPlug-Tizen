#!/usr/bin/env bash
# JELA-880 guard: state at review time that a change rides in the .wgt.
#
# The bootstrap is the ONLY vehicle that is not auto-updatable. The server
# plugin serves shell.min.js / lite.min.js / babel.min.js / fonts / tx and
# advertises bootstrapWgt: null (ShellDropService.cs), and /shell/index.html
# and /shell/boot-shell.min.js are 404. So a bootstrap change reaches a TV only
# when someone signs a new .wgt on RumbleCrumbleRS/JellyPlug-Tizen-internal and
# hand-sideloads it (`sdb push` + `0 vd_appinstall`, JELA-21). There is no OTA.
#
# That was silent until now: JELA-226's read site (255aa34, 2026-07-28) changed
# index.html while config.xml still read 2.0.25 — a version already released —
# so two different builds claimed 2.0.25 and the widget version could not tell
# them apart. JELA-853 then approved a fleet flag flip against that read site,
# which was a no-op. This guard makes the vehicle visible in the PR.
#
# Two tiers, because the payload files are not equally stranded:
#
#   HARD FAIL — WGT-only files. index.html / config.xml / icon.png have no
#   server-side channel at all; a change here cannot reach a TV by any other
#   route, so it must carry a version bump or the .wgt is unidentifiable.
#
#   WARN — baked fallbacks. boot-shell.min.js / babel.min.js are baked into the
#   .wgt but are also reachable server-side (the shell runs from the LS byte
#   cache or /shell/, JELA-66; babel is <script src>'d from the /shell/ drop,
#   JELA-848). The baked copies are cold-start fallbacks only, and they are
#   regenerated on most shell commits — failing on them would fire ~65 times a
#   quarter and get the guard switched off. Annotate instead.
#
# Usage: check-bootstrap-version-bump.sh <base-ref>
#   base-ref defaults to origin/main. Requires enough history to diff (CI must
#   check out with fetch-depth: 0).
set -euo pipefail

BASE="${1:-origin/main}"
SRC="packages/shell-tizen-bootstrap/src"
CONFIG="${SRC}/config.xml"

# Files whose only delivery vehicle is the .wgt.
WGT_ONLY=("${SRC}/index.html" "${CONFIG}" "${SRC}/icon.png")
# Baked into the .wgt but also served; a stale bake is a fallback, not a break.
BAKED_FALLBACK=("${SRC}/boot-shell.min.js" "${SRC}/babel.min.js")

if ! git rev-parse --verify --quiet "${BASE}" >/dev/null; then
  echo "::error::check-bootstrap-version-bump: base ref '${BASE}' not resolvable — check out with fetch-depth: 0" >&2
  exit 1
fi

merge_base="$(git merge-base "${BASE}" HEAD)"

changed() {
  # Empty diff output means unchanged. Deleted files count as changed.
  [[ -n "$(git diff --name-only "${merge_base}" HEAD -- "$1")" ]]
}

widget_version() {
  # $1 = git rev. Prints the <widget version="..."> attribute, or nothing if
  # the file does not exist at that rev.
  git show "$1:${CONFIG}" 2>/dev/null |
    sed -nE 's/.*<widget[^>]* version="([^"]+)".*/\1/p' | head -n 1
}

changed_wgt_only=()
for f in "${WGT_ONLY[@]}"; do
  changed "$f" && changed_wgt_only+=("$f")
done

changed_baked=()
for f in "${BAKED_FALLBACK[@]}"; do
  changed "$f" && changed_baked+=("$f")
done

if [[ ${#changed_wgt_only[@]} -eq 0 && ${#changed_baked[@]} -eq 0 ]]; then
  echo "No bootstrap payload change against ${BASE} — nothing rides in the .wgt."
  exit 0
fi

base_ver="$(widget_version "${merge_base}")"
head_ver="$(widget_version HEAD)"

if [[ -z "${head_ver}" ]]; then
  echo "::error file=${CONFIG}::widget version attribute not found — cannot verify a bump" >&2
  exit 1
fi

if [[ ${#changed_baked[@]} -gt 0 ]]; then
  echo "::warning file=${changed_baked[0]}::JELA-880: ${changed_baked[*]} is baked into the .wgt. TVs use the server-side copy first, so this lands live — but the baked cold-start fallback stays at v${base_ver} until a new .wgt is signed and sideloaded."
fi

if [[ ${#changed_wgt_only[@]} -eq 0 ]]; then
  exit 0
fi

if [[ "${base_ver}" == "${head_ver}" ]]; then
  cat >&2 <<EOF
::error file=${CONFIG}::JELA-880: ${changed_wgt_only[*]} changed but the widget version is still ${head_ver}. These files ship ONLY in the .wgt — bump the version, or two different builds will claim ${head_ver} and no TV can tell them apart (that is exactly how 255aa34 stranded JELA-226's read site and made JELA-853's approved flip a no-op).
EOF
  echo "" >&2
  echo "To land this change on a TV:" >&2
  echo "  1. Bump <widget version> in ${CONFIG}." >&2
  echo "  2. Merge to public main." >&2
  echo "  3. Sync RumbleCrumbleRS/JellyPlug-Tizen-internal main to that commit" >&2
  echo "     (full-tree copy; the public repo has no TIZEN_* secrets by design," >&2
  echo "     JEL-162 Decision 2 / JEL-173)." >&2
  echo "  4. Push tag bootstrap-v<ver> there to sign + publish the release." >&2
  echo "  5. Sideload: sdb push + '0 vd_appinstall' (JELA-21). There is no OTA." >&2
  echo "  See docs/bootstrap-release-channel.md." >&2
  exit 1
fi

echo "Bootstrap payload changed and the widget version moved ${base_ver} -> ${head_ver}."
echo "Reminder: this does NOT reach a TV until a signed .wgt is built on"
echo "RumbleCrumbleRS/JellyPlug-Tizen-internal and sideloaded. See"
echo "docs/bootstrap-release-channel.md."
