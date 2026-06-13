"""
Build the JEL-2040 Hosted Shell Bootstrap WGT.

Pipeline:
  1. Resolve bootstrap version from config.xml (single source of truth).
  2. Package the committed src/boot-shell.min.js as-is. This is the deployed,
     on-device-validated bootstrap shell; its maintainable source of record is
     src/boot-shell.src.js (JEL-24). To regenerate boot-shell.min.js from that
     source, use scripts/build_boot_shell.py — NOT --shell-src (see below).
     (--shell-src remains as a generic override to bake in some OTHER prebuilt
     shell.min.js, e.g. a shell-tizen build.)
  3. Package {config.xml,index.html,icon.png,boot-shell.min.js,babel.min.js}
     into JellyPlug.wgt at the tree root.

Variants (JEL-143):
  - Retail (default): index.html ships as committed. Both diagnostic overlays
    stay opt-in (off on a fresh install). Output -> JellyPlug.wgt.
  - Debug (--debug): a tiny seed <script> is injected as the first element of
    <body> so it runs BEFORE the bootloader IIFE, setting
    localStorage['jellyfin.shell.debug']='1' and
    localStorage['jellyfin.shell.hsbDebug']='1'. That turns on BOTH the HSB
    bootstrap overlay (#hsb-status) and the shell diagnostics overlay
    (#__shell_diag) + shellLog() for every boot of that WGT. Output ->
    JellyPlug-Debug.wgt. The seed is build-time only — the committed
    src/index.html (and the selftest that reads it) is never modified.
       - With --sign-profile NAME (and the Tizen CLI on PATH): runs
         `tizen package -t wgt -s NAME` so the .wgt embeds author-signature.xml
         + signature1.xml and is installable on a real TV.
       - Without it: falls back to a raw zip. That zip is UNSIGNED and a retail
         Tizen TV will refuse to install it (see JEL-8). The raw zip is only
         useful for the wgt-emulate Tier-2 harness / inspection.
  4. Compute sha256 of the bootstrap and emit a manifest stub at
     ./manifest.bootstrap.json so the server-side /shell/ host can
     advertise the corresponding boot-shell-x.y.z.wgt for fresh-pull
     install procedures.

To produce an installable package, the release pipeline configures a signing
profile (tooling/ci/configure-tizen-signing.sh) and then passes
--sign-profile. The produced .wgt is checked by tooling/ci/verify-wgt-signed.sh
before release.

Usage:
  python3 build_bootstrap.py                       # JellyPlug.wgt, raw zip (UNSIGNED, emulator only)
  python3 build_bootstrap.py --debug               # JellyPlug-Debug.wgt, debug overlays on
  python3 build_bootstrap.py --sign-profile jellyfin   # signed, installable
  python3 build_bootstrap.py --debug --sign-profile jellyfin   # signed debug build
  python3 build_bootstrap.py --shell-src ../some-prebuilt-shell --out ../

NOTE (JEL-24): the historical `--shell-src ../_jel*_v80_src` flow is gone — that
shell source tree was never committed and is lost. The deployed shell now has a
committed source (src/boot-shell.src.js); regenerate the artifact with
scripts/build_boot_shell.py and ship the validated src/boot-shell.min.js.
"""

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

HERE = Path(__file__).parent
PKG_ROOT = HERE.parent
SRC = PKG_ROOT / "src"
CONFIG_XML = SRC / "config.xml"
INDEX_HTML = SRC / "index.html"
ICON_PNG = SRC / "icon.png"
BOOT_SHELL = SRC / "boot-shell.min.js"
BABEL_MIN = SRC / "babel.min.js"

WGT_PAYLOAD = [CONFIG_XML, INDEX_HTML, ICON_PNG, BOOT_SHELL, BABEL_MIN]

RETAIL_WGT_NAME = "JellyPlug.wgt"
DEBUG_WGT_NAME = "JellyPlug-Debug.wgt"

# JEL-143: injected as the FIRST child of <body> in the --debug variant so it
# executes before the bootloader IIFE captures hsbDebugOn and before
# boot-shell.min.js reads jellyfin.shell.debug. Seeds both diagnostic overlays
# on for every boot of the debug WGT. ES5-only so it parses on M63/Chromium 63.
DEBUG_SEED_MARKER = "JellyPlug-Debug build (JEL-143)"
DEBUG_SEED_SCRIPT = (
    '    <script>/* ' + DEBUG_SEED_MARKER + ': force both diagnostic overlays on */'
    "try{localStorage.setItem('jellyfin.shell.debug','1');"
    "localStorage.setItem('jellyfin.shell.hsbDebug','1');}catch(_){}</script>\n"
)


def debug_index_html() -> str:
    """Return src/index.html with the debug seed injected after <body>.

    Raises if the <body> anchor is missing so a future markup change can never
    silently ship a debug WGT that is identical to retail.
    """
    html = INDEX_HTML.read_text(encoding="utf-8")
    if DEBUG_SEED_MARKER in html:
        return html  # already seeded (defensive; src is never committed seeded)
    anchor = "<body>\n"
    if anchor not in html:
        raise RuntimeError("index.html: '<body>' anchor not found; cannot inject debug seed")
    return html.replace(anchor, anchor + DEBUG_SEED_SCRIPT, 1)


def stage_payload(stage_dir: Path, *, debug: bool) -> None:
    """Copy the WGT payload into stage_dir, substituting a debug-seeded
    index.html for the --debug variant."""
    for src in WGT_PAYLOAD:
        if not src.exists():
            raise RuntimeError(f"bootstrap payload missing: {src}")
        if debug and src == INDEX_HTML:
            (stage_dir / src.name).write_text(debug_index_html(), encoding="utf-8")
        else:
            shutil.copy2(src, stage_dir / src.name)


def bootstrap_version() -> str:
    text = CONFIG_XML.read_text(encoding="utf-8")
    m = re.search(r'<widget[^>]*\bversion="([^"]+)"', text)
    if not m:
        raise RuntimeError("widget version not found in config.xml")
    return m.group(1)


def sync_baked_shell(shell_src: Path) -> None:
    src_shell = shell_src / "shell.min.js"
    if not src_shell.exists():
        raise RuntimeError(f"shell.min.js missing under {shell_src}")
    shutil.copy2(src_shell, BOOT_SHELL)
    src_babel = shell_src / "babel.min.js"
    if src_babel.exists():
        shutil.copy2(src_babel, BABEL_MIN)


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _resolve_tizen_cli(explicit: str | None) -> str | None:
    candidates = [explicit] if explicit else ["tizen", "tizen.bat"]
    for c in candidates:
        if c and shutil.which(c):
            return c
    return None


def variant_wgt_name(debug: bool) -> str:
    return DEBUG_WGT_NAME if debug else RETAIL_WGT_NAME


def build_wgt_unsigned(out_dir: Path, ver: str, *, debug: bool) -> Path:
    """Raw zip of the payload. UNSIGNED — not installable on a real TV."""
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / variant_wgt_name(debug)
    with tempfile.TemporaryDirectory(prefix="hsb-bootstrap-") as stage:
        stage_dir = Path(stage)
        stage_payload(stage_dir, debug=debug)
        with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for src in WGT_PAYLOAD:
                zf.write(stage_dir / src.name, arcname=src.name)
    print(
        "WARNING: produced an UNSIGNED bootstrap .wgt. A retail Tizen TV will "
        "refuse to install it (JEL-8).\n"
        "         Re-run with --sign-profile <name> on a host with the Tizen "
        "CLI to produce an installable package.",
        file=sys.stderr,
    )
    return out


def build_wgt_signed(out_dir: Path, ver: str, profile: str, tizen_cli: str, *, debug: bool) -> Path:
    """Stage the payload and sign it with `tizen package -t wgt -s <profile>`.

    Tizen names the output after <name> in config.xml; we rename it to the
    canonical JellyPlug.wgt / JellyPlug-Debug.wgt so QA/CI always find it.
    The signed package is staged in its own tmp dir so two variants built into
    the same out_dir don't collide on the `*.wgt` glob below.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / variant_wgt_name(debug)
    with tempfile.TemporaryDirectory(prefix="hsb-bootstrap-") as stage:
        stage_dir = Path(stage)
        stage_payload(stage_dir, debug=debug)
        sign_out = stage_dir / "_signed"
        sign_out.mkdir()
        cmd = [tizen_cli, "package", "-t", "wgt", "-s", profile, "-o", str(sign_out.resolve()), "--", "."]
        print(f">> {' '.join(cmd)}  (cwd={stage_dir})")
        subprocess.run(cmd, cwd=stage_dir, check=True)

        emitted = sorted(sign_out.glob("*.wgt"))
        if not emitted:
            raise RuntimeError(f"tizen package produced no .wgt in {sign_out}")
        # Move whatever tizen emitted to the canonical variant name in out_dir.
        emitted[0].replace(out)
    return out


def build_wgt(out_dir: Path, ver: str, *, sign_profile: str | None, tizen_cli: str | None, debug: bool) -> Path:
    if sign_profile:
        cli = _resolve_tizen_cli(tizen_cli)
        if not cli:
            raise RuntimeError(
                "--sign-profile requires the Tizen CLI on PATH (tizen / tizen.bat). "
                "Run inside a Tizen Studio image or pass --tizen-cli."
            )
        return build_wgt_signed(out_dir, ver, sign_profile, cli, debug=debug)
    return build_wgt_unsigned(out_dir, ver, debug=debug)


def emit_manifest_stub(wgt: Path, ver: str) -> Path:
    manifest = {
        "version": ver,
        "kind": "bootstrap-wgt",
        "filename": wgt.name,
        "sha256": sha256_file(wgt),
        "sizeBytes": wgt.stat().st_size,
        "notes": "Install via Samsung Device Manager GUI on a fresh TV; no sdb shell required.",
    }
    out = PKG_ROOT / "manifest.bootstrap.json"
    out.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--shell-src", type=Path, default=None,
                    help="override: bake boot-shell.min.js + babel.min.js from "
                         "this dir's shell.min.js (the lost _jel*_v80_src tree is "
                         "gone — to rebuild from source use build_boot_shell.py)")
    ap.add_argument("--out", type=Path, default=PKG_ROOT / "dist",
                    help="WGT output dir (default: <pkg>/dist)")
    ap.add_argument("--sign-profile", default=None,
                    help="Tizen security profile to sign with (produces an "
                         "installable .wgt). Omit for a raw UNSIGNED zip.")
    ap.add_argument("--tizen-cli", default=None,
                    help="path/name of the Tizen CLI (default: auto-detect "
                         "tizen / tizen.bat). Only used with --sign-profile.")
    ap.add_argument("--debug", action="store_true",
                    help="build the JellyPlug-Debug.wgt variant: seed both "
                         "diagnostic overlays on (jellyfin.shell.debug + "
                         "jellyfin.shell.hsbDebug) for every boot (JEL-143). "
                         "Retail src/index.html is untouched.")
    ap.add_argument("--no-manifest", action="store_true",
                    help="skip writing manifest.bootstrap.json (which always "
                         "lands in the package root regardless of --out). Used "
                         "by tests so a throwaway build never mutates the "
                         "committed manifest.")
    args = ap.parse_args()

    if args.shell_src is not None:
        sync_baked_shell(args.shell_src)

    ver = bootstrap_version()
    wgt = build_wgt(args.out, ver, sign_profile=args.sign_profile,
                    tizen_cli=args.tizen_cli, debug=args.debug)

    print(f"bootstrap_wgt  path={wgt}  bytes={wgt.stat().st_size}  ver={ver}  "
          f"variant={'debug' if args.debug else 'retail'}")
    # The manifest stub advertises the retail WGT the server-side /shell/ host
    # serves; the debug build never overwrites it, and --no-manifest skips it
    # entirely (throwaway/test builds).
    if not args.debug and not args.no_manifest:
        manifest = emit_manifest_stub(wgt, ver)
        print(f"bootstrap_manifest  path={manifest}  sha256={sha256_file(wgt)}")
    else:
        print(f"bootstrap_wgt_sha256  {sha256_file(wgt)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
