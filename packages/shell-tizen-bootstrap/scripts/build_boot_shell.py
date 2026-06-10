"""
JEL-24: rebuild boot-shell.min.js from the committed source of record.

The deployed bootstrap shell used to have NO committed source — boot-shell.min.js
was a hand-maintained minified blob (see agent memory `shell-source-divergence`).
JEL-24 reconstructed the source by de-minifying it into `src/boot-shell.src.js`,
so the shell now has a real, reproducible build:

    boot-shell.min.js  =  boot-shell.manifest.txt  +  esbuild_minify(boot-shell.src.js)

Pipeline:
  1. esbuild-minify src/boot-shell.src.js (mangle OFF, same flags as the legacy
     build_shell_min.py — JEL-929: --minify-whitespace --minify-syntax only).
  2. Prepend the preserved JEL-history manifest (src/boot-shell.manifest.txt), a
     passthrough breadcrumb block (JEL-929) kept verbatim because the original
     source comments that generated it were lost when the blob was minified.
  3. Write the result.

By default this writes to dist/boot-shell.min.js (a build output) and runs the
equivalence guard — it does NOT overwrite the committed, on-device-validated
src/boot-shell.min.js. Pass --promote to overwrite the committed artifact.

IMPORTANT: a rebuilt artifact is byte-different from the hand-maintained one
(esbuild's own quote/whitespace choices) even though it is SEMANTICALLY identical
(verify_boot_shell_src.py proves this). The committed src/boot-shell.min.js is the
validated deploy. Promoting a rebuild ships new bytes to a wedge-prone locked TV
(see memory `tv-webview-wedge-on-reinstall`), so --promote requires fresh
on-device validation before release.

Usage:
  python3 build_boot_shell.py                  # -> dist/boot-shell.min.js (+verify)
  python3 build_boot_shell.py --promote        # overwrite src/boot-shell.min.js
  python3 build_boot_shell.py --esbuild /path/to/esbuild
"""

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent
PKG_ROOT = HERE.parent
SRC = PKG_ROOT / "src"
BOOT_SRC = SRC / "boot-shell.src.js"
BOOT_MANIFEST = SRC / "boot-shell.manifest.txt"
BOOT_MIN = SRC / "boot-shell.min.js"

ESBUILD_FLAGS = [
    "--minify-whitespace",
    "--minify-syntax",
    "--target=es2017",
    "--legal-comments=none",
]


def resolve_esbuild(explicit: str | None) -> list[str]:
    if explicit:
        return [explicit]
    # Prefer the lockfile-pinned workspace install (integrity-checked by pnpm)
    # over PATH or an ad-hoc npx download (JEL-119 supply-chain hardening).
    local = PKG_ROOT.parent.parent / "node_modules" / ".bin" / "esbuild"
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


def minify(esbuild: list[str], src: Path) -> bytes:
    proc = subprocess.run(
        [*esbuild, str(src), *ESBUILD_FLAGS], capture_output=True, check=True
    )
    return proc.stdout


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--esbuild", default=None, help="path to the esbuild binary")
    ap.add_argument(
        "--out",
        type=Path,
        default=PKG_ROOT / "dist" / "boot-shell.min.js",
        help="output path (default: dist/boot-shell.min.js)",
    )
    ap.add_argument(
        "--promote",
        action="store_true",
        help="overwrite the committed src/boot-shell.min.js (needs on-device "
        "validation before release)",
    )
    args = ap.parse_args()

    for p in (BOOT_SRC, BOOT_MANIFEST):
        if not p.exists():
            print(f"FATAL: missing {p}", file=sys.stderr)
            return 2

    esbuild = resolve_esbuild(args.esbuild)
    manifest = BOOT_MANIFEST.read_bytes()
    code = minify(esbuild, BOOT_SRC)
    out_bytes = manifest + code

    out = BOOT_MIN if args.promote else args.out
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(out_bytes)

    jel_lines = sum(1 for line in out_bytes.split(b"\n") if b"JEL-" in line)
    print(
        f"boot-shell.min.js  path={out}  bytes={len(out_bytes)}  "
        f"jel_lines={jel_lines}  esbuild={' '.join(esbuild)}"
    )

    # Confirm the rebuild is semantically faithful to the committed source.
    verify_cmd = [sys.executable, str(HERE / "verify_boot_shell_src.py")]
    if len(esbuild) == 1:  # a concrete binary path; share it with the guard
        verify_cmd += ["--esbuild", esbuild[0]]
    rc = subprocess.run(verify_cmd).returncode
    if rc != 0:
        print("FATAL: rebuilt artifact failed the equivalence guard", file=sys.stderr)
        return rc

    if args.promote:
        print(
            "PROMOTED to src/boot-shell.min.js. This changes the deployed bytes — "
            "validate on a real TV (memory: tv-webview-wedge-on-reinstall) before "
            "release.",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
