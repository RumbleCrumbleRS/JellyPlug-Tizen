"""
JEL-120 guard: prove the committed shell-tizen SOURCE matches the deployed
artifact.

Sibling of the bootstrap's JEL-24 guard (verify_boot_shell_src.py). The file
the WGT ships, `src/shell.min.js`, is a release-time esbuild build of
`src/shell.js` (build_shell_min.py) — build-wgt.sh stages the committed blob
as-is, so an edit to only one side (tampering or an honest miss) would ship
silently. This guard makes that divergence a CI failure.

Wrinkle vs the bootstrap guard: build_shell_min.py substitutes three
placeholders into the minified output before prepending the breadcrumb
manifest:
  __BABEL_FPR__       <- fingerprint of src/babel.min.js   (JEL-1150)
  __SHELL_VER__       <- widget version from tizen/config.xml (JEL-1215)
  __QA_BEACON_BODY__  <- JSON-encoded body of src/qa-beacon.js (JEL-1971)

Rather than trying to reverse those out of the deployed blob, the guard
FORWARD-builds the source side through build_shell_min's own functions (same
esbuild flags, same substitution logic, same inputs), strips the manifest
from the deployed blob the way the bootstrap guard strips its manifest, then
canonicalizes BOTH sides through the same esbuild pass and requires byte
identity. Canonicalizing both sides keeps the check robust to esbuild
version drift between the release build and CI.

Forward substitution deliberately also fails the guard when babel.min.js,
config.xml's widget version, or qa-beacon.js change without a blob rebuild —
each of those is real staleness in the shipped artifact (e.g. a babel swap
invalidates the baked transpile-cache fingerprint).

JEL-625: the JEL breadcrumb manifest moved out of shell.min.js into
../shell.jel-history.txt. This guard now also regenerates that file's text
from shell.js (via build_shell_min.build_history_text) and requires byte
identity with the committed copy, so the out-of-band manifest cannot drift
from source any more than the blob can.

Usage:
  python3 verify_shell_src.py             # auto-resolve esbuild / npx
  python3 verify_shell_src.py --esbuild /path/to/esbuild
"""

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import build_shell_min as build  # noqa: E402  (same dir, shared build logic)

SRC = HERE.parent / "src"
SHELL_MIN = SRC / "shell.min.js"
SHELL_JS = SRC / "shell.js"
JEL_HISTORY = HERE.parent / "shell.jel-history.txt"  # JEL-625 out-of-band manifest

# Canonicalization flags — must stay in lockstep with build_shell_min.run_esbuild.
ESBUILD_FLAGS = [
    "--minify-whitespace",
    "--minify-syntax",
    "--target=es2017",
    "--legal-comments=none",
]


def resolve_esbuild(explicit: str | None) -> list[str]:
    """Return an argv prefix that runs esbuild.

    Prefers the lockfile-pinned workspace install (integrity-checked by pnpm,
    JEL-119), then an `esbuild` on PATH; falls back to `npx --yes esbuild@0.21.5`
    so the guard still runs in a bare environment with no node_modules.
    """
    if explicit:
        return [explicit]
    local = HERE.parent.parent.parent / "node_modules" / ".bin" / "esbuild"
    if local.exists():
        return [str(local)]
    found = shutil.which("esbuild")
    if found:
        return [found]
    npx = shutil.which("npx")
    if npx:
        return [npx, "--yes", "esbuild@0.21.5"]
    raise RuntimeError(
        "no esbuild found: pnpm install at the repo root, or install esbuild on PATH"
    )


def canonicalize(esbuild: list[str], source: bytes) -> bytes:
    """Minify `source` to its canonical form via esbuild (stdin -> stdout)."""
    proc = subprocess.run(
        [*esbuild, "--loader=js", *ESBUILD_FLAGS],
        input=source,
        capture_output=True,
        check=True,
    )
    return proc.stdout


def strip_manifest(blob: bytes) -> bytes:
    """Drop a leading `/*! JEL history ... */` manifest comment, if present.

    Since JEL-625 shell.min.js is pure code (the manifest lives in
    shell.jel-history.txt), so this is a no-op for current blobs; kept so the
    guard still verifies pre-JEL-625 blobs (`MANIFEST + CODE`) during
    transitions/rollbacks.
    """
    if blob.startswith(b"/*!"):
        end = blob.find(b"*/\n")
        if end == -1:
            raise RuntimeError("shell.min.js manifest comment is unterminated")
        return blob[end + 3 :]
    return blob


def forward_build(esbuild: list[str]) -> bytes:
    """Rebuild the code portion of shell.min.js from shell.js, in memory.

    Reuses build_shell_min's substitution functions verbatim so the guard can
    never drift from the real build's logic; only the esbuild invocation is
    overridden (build_shell_min resolves its binary at import time).
    """
    proc = subprocess.run(
        [*esbuild, "--loader=js", *ESBUILD_FLAGS],
        input=build.expanded_source(),  # JEL-644: splice shell-core first
        capture_output=True,
        check=True,
    )
    minified = proc.stdout
    minified = build.inject_babel_fingerprint(minified)
    minified = build.inject_shell_version(minified)
    minified = build.inject_qa_beacon(minified)
    return minified


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--esbuild", default=None, help="path to the esbuild binary")
    args = ap.parse_args()

    for p in (SHELL_MIN, SHELL_JS):
        if not p.exists():
            print(f"FAIL: missing {p}", file=sys.stderr)
            return 2

    esbuild = resolve_esbuild(args.esbuild)

    # JEL-625: the out-of-band breadcrumb manifest must match shell.js exactly.
    expected_history = build.build_history_text(
        build.collect_breadcrumbs(build.expanded_text())  # JEL-644: expand first
    )
    actual_history = (
        JEL_HISTORY.read_text(encoding="utf-8") if JEL_HISTORY.exists() else None
    )
    if actual_history != expected_history:
        print(
            "FAIL: shell.jel-history.txt is "
            + ("missing" if actual_history is None else "stale")
            + " — the out-of-band JEL breadcrumb manifest (JEL-625) no longer "
            "matches shell.js. Re-sync with `python3 scripts/build_shell_min.py` "
            "and commit shell.min.js + shell.jel-history.txt together.",
            file=sys.stderr,
        )
        return 1

    deployed_code = strip_manifest(SHELL_MIN.read_bytes())
    source_code = forward_build(esbuild)

    canon_deployed = canonicalize(esbuild, deployed_code)
    canon_source = canonicalize(esbuild, source_code)

    if canon_deployed == canon_source:
        print(
            f"OK: shell.js (+ placeholder inputs) ≡ shell.min.js "
            f"(canonical {len(canon_source)} bytes, esbuild={' '.join(esbuild)}); "
            f"shell.jel-history.txt in sync"
        )
        return 0

    n = min(len(canon_deployed), len(canon_source))
    i = 0
    while i < n and canon_deployed[i] == canon_source[i]:
        i += 1
    lo, hi = max(0, i - 60), i + 80
    print(
        "FAIL: shell.js and shell.min.js are NOT semantically equivalent — "
        "the committed source (or one of its baked inputs: babel.min.js, "
        "config.xml widget version, qa-beacon.js) and the deployed blob have "
        "diverged. Re-sync with `python3 scripts/build_shell_min.py` and "
        "commit both sides.\n"
        f"  canonical sizes: src={len(canon_source)} deployed={len(canon_deployed)}\n"
        f"  first diff at byte {i}:\n"
        f"    deployed: {canon_deployed[lo:hi]!r}\n"
        f"    source:   {canon_source[lo:hi]!r}",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
