"""
JEL-24 guard: prove the committed bootstrap shell SOURCE matches the deployed
artifact.

Background (see agent memory `shell-source-divergence` / JEL-23): the file CI
ships, `src/boot-shell.min.js`, was historically hand-maintained as a minified
blob with NO committed source — committed `shell-tizen/src/shell.js` was stale
by several tickets (JEL-1989..1998 + the TX_SCRIPT_RE fast path). JEL-24
reconstructed the deployed source by de-minifying boot-shell.min.js into the
maintainable `src/boot-shell.src.js`.

This guard keeps the two from silently diverging again. It does NOT require
byte-identity (esbuild is unpinned in this repo, and the deployed blob was
hand-edited, so quote-style/whitespace choices differ harmlessly). Instead it
proves *semantic* equivalence: run BOTH the committed source and the deployed
artifact (manifest stripped) through the SAME esbuild minify pass and require
the canonical outputs to be byte-identical. Because both sides use the same
esbuild, the comparison is version-robust.

Fails loudly if:
  - boot-shell.src.js was edited but boot-shell.min.js wasn't (or vice versa),
  - either file stops parsing,
  - the manifest prefix in boot-shell.min.js is malformed.

Usage:
  python3 verify_boot_shell_src.py            # auto-resolve esbuild / npx
  python3 verify_boot_shell_src.py --esbuild /path/to/esbuild
"""

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent
SRC = HERE.parent / "src"
BOOT_MIN = SRC / "boot-shell.min.js"
BOOT_SRC = SRC / "boot-shell.src.js"

# Must match build_boot_shell.py / the historical build_shell_min.py flags so
# the canonical form is the one the artifact is actually built with.
ESBUILD_FLAGS = [
    "--minify-whitespace",
    "--minify-syntax",
    "--target=es2017",
    "--legal-comments=none",
]


def resolve_esbuild(explicit: str | None) -> list[str]:
    """Return an argv prefix that runs esbuild.

    Prefers an `esbuild` on PATH (matches build_shell_min.py's
    `shutil.which("esbuild")`); falls back to `npx --yes esbuild@0.21.5` so the
    guard is self-contained in a bare CI runner.
    """
    if explicit:
        return [explicit]
    found = shutil.which("esbuild")
    if found:
        return [found]
    npx = shutil.which("npx")
    if npx:
        return [npx, "--yes", "esbuild@0.21.5"]
    raise RuntimeError(
        "no esbuild found: install esbuild on PATH or make npx available"
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
    """Drop the leading `/*! JEL history ... */` manifest comment.

    boot-shell.min.js is `MANIFEST + CODE`; the manifest is a passthrough
    breadcrumb block (JEL-929) that esbuild would discard anyway, so we strip it
    before canonicalizing.
    """
    text = blob
    if text.startswith(b"/*!"):
        end = text.find(b"*/\n")
        if end == -1:
            raise RuntimeError("boot-shell.min.js manifest comment is unterminated")
        return text[end + 3 :]
    return text


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--esbuild", default=None, help="path to the esbuild binary")
    args = ap.parse_args()

    for p in (BOOT_MIN, BOOT_SRC):
        if not p.exists():
            print(f"FAIL: missing {p}", file=sys.stderr)
            return 2

    esbuild = resolve_esbuild(args.esbuild)

    deployed_code = strip_manifest(BOOT_MIN.read_bytes())
    source_code = BOOT_SRC.read_bytes()

    canon_deployed = canonicalize(esbuild, deployed_code)
    canon_source = canonicalize(esbuild, source_code)

    if canon_deployed == canon_source:
        print(
            f"OK: boot-shell.src.js ≡ boot-shell.min.js "
            f"(canonical {len(canon_source)} bytes, esbuild={' '.join(esbuild)})"
        )
        return 0

    # Report a small window around the first divergence to aid debugging.
    n = min(len(canon_deployed), len(canon_source))
    i = 0
    while i < n and canon_deployed[i] == canon_source[i]:
        i += 1
    lo, hi = max(0, i - 60), i + 80
    print(
        "FAIL: boot-shell.src.js and boot-shell.min.js are NOT semantically "
        "equivalent — the committed source and the deployed artifact have "
        "diverged. Re-sync them (edit both, or de-minify the artifact) before "
        "shipping.\n"
        f"  canonical sizes: src={len(canon_source)} deployed={len(canon_deployed)}\n"
        f"  first diff at byte {i}:\n"
        f"    deployed: {canon_deployed[lo:hi]!r}\n"
        f"    source:   {canon_source[lo:hi]!r}",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
