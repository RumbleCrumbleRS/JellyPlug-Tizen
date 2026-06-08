"""
Build the JEL-2040 Hosted Shell Bootstrap WGT.

Pipeline:
  1. Resolve bootstrap version from config.xml (single source of truth).
  2. Re-bake boot-shell.min.js from the latest jel*_v80_src shell build.
     (Caller passes --shell-src to override.)
  3. Package {config.xml,index.html,icon.png,boot-shell.min.js,babel.min.js}
     into JellyfinShellBootstrap_v<ver>.wgt at the tree root.
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
  python3 build_bootstrap.py                       # raw zip (UNSIGNED, emulator only)
  python3 build_bootstrap.py --sign-profile jellyfin   # signed, installable
  python3 build_bootstrap.py --shell-src ../_jel1963_v80_src --out ../
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


def build_wgt_unsigned(out_dir: Path, ver: str) -> Path:
    """Raw zip of the payload. UNSIGNED — not installable on a real TV."""
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"JellyfinShellBootstrap_v{ver}.wgt"
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for src in WGT_PAYLOAD:
            if not src.exists():
                raise RuntimeError(f"bootstrap payload missing: {src}")
            zf.write(src, arcname=src.name)
    print(
        "WARNING: produced an UNSIGNED bootstrap .wgt. A retail Tizen TV will "
        "refuse to install it (JEL-8).\n"
        "         Re-run with --sign-profile <name> on a host with the Tizen "
        "CLI to produce an installable package.",
        file=sys.stderr,
    )
    return out


def build_wgt_signed(out_dir: Path, ver: str, profile: str, tizen_cli: str) -> Path:
    """Stage the payload and sign it with `tizen package -t wgt -s <profile>`.

    Tizen names the output after <name> in config.xml; we rename it to the
    canonical JellyfinShellBootstrap_v<ver>.wgt so QA/CI always find it.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"JellyfinShellBootstrap_v{ver}.wgt"
    with tempfile.TemporaryDirectory(prefix="hsb-bootstrap-") as stage:
        stage_dir = Path(stage)
        for src in WGT_PAYLOAD:
            if not src.exists():
                raise RuntimeError(f"bootstrap payload missing: {src}")
            shutil.copy2(src, stage_dir / src.name)
        cmd = [tizen_cli, "package", "-t", "wgt", "-s", profile, "-o", str(out_dir.resolve()), "--", "."]
        print(f">> {' '.join(cmd)}  (cwd={stage_dir})")
        subprocess.run(cmd, cwd=stage_dir, check=True)

    emitted = sorted(out_dir.glob("*.wgt"))
    if not emitted:
        raise RuntimeError(f"tizen package produced no .wgt in {out_dir}")
    # Rename whatever tizen emitted (if different) to the canonical name.
    produced = emitted[0]
    if produced.name != out.name:
        produced.replace(out)
    return out


def build_wgt(out_dir: Path, ver: str, *, sign_profile: str | None, tizen_cli: str | None) -> Path:
    if sign_profile:
        cli = _resolve_tizen_cli(tizen_cli)
        if not cli:
            raise RuntimeError(
                "--sign-profile requires the Tizen CLI on PATH (tizen / tizen.bat). "
                "Run inside a Tizen Studio image or pass --tizen-cli."
            )
        return build_wgt_signed(out_dir, ver, sign_profile, cli)
    return build_wgt_unsigned(out_dir, ver)


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
                    help="re-bake boot-shell.min.js + babel.min.js from this dir")
    ap.add_argument("--out", type=Path, default=PKG_ROOT / "dist",
                    help="WGT output dir (default: <pkg>/dist)")
    ap.add_argument("--sign-profile", default=None,
                    help="Tizen security profile to sign with (produces an "
                         "installable .wgt). Omit for a raw UNSIGNED zip.")
    ap.add_argument("--tizen-cli", default=None,
                    help="path/name of the Tizen CLI (default: auto-detect "
                         "tizen / tizen.bat). Only used with --sign-profile.")
    args = ap.parse_args()

    if args.shell_src is not None:
        sync_baked_shell(args.shell_src)

    ver = bootstrap_version()
    wgt = build_wgt(args.out, ver, sign_profile=args.sign_profile,
                    tizen_cli=args.tizen_cli)
    manifest = emit_manifest_stub(wgt, ver)

    print(f"bootstrap_wgt  path={wgt}  bytes={wgt.stat().st_size}  ver={ver}")
    print(f"bootstrap_manifest  path={manifest}  sha256={sha256_file(wgt)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
