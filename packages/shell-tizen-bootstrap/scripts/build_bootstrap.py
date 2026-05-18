"""
Build the JEL-2040 Hosted Shell Bootstrap WGT.

Pipeline:
  1. Resolve bootstrap version from config.xml (single source of truth).
  2. Re-bake boot-shell.min.js from the latest jel*_v80_src shell build.
     (Caller passes --shell-src to override.)
  3. Zip {config.xml,index.html,icon.png,boot-shell.min.js,babel.min.js}
     into JellyfinShellBootstrap_v<ver>.wgt at the tree root.
  4. Compute sha256 of the bootstrap and emit a manifest stub at
     ./manifest.bootstrap.json so the server-side /shell/ host can
     advertise the corresponding boot-shell-x.y.z.wgt for fresh-pull
     install procedures.

This script does NOT sign the WGT. Signing remains the responsibility
of tizen.bat package -t wgt or the Samsung Device Manager GUI. Sign
the produced WGT before pushing it to a TV.

Usage:
  python3 build_bootstrap.py
  python3 build_bootstrap.py --shell-src ../_jel1963_v80_src --out ../
"""

import argparse
import hashlib
import json
import re
import shutil
import sys
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


def build_wgt(out_dir: Path, ver: str) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"JellyfinShellBootstrap_v{ver}.wgt"
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for src in WGT_PAYLOAD:
            if not src.exists():
                raise RuntimeError(f"bootstrap payload missing: {src}")
            zf.write(src, arcname=src.name)
    return out


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
    args = ap.parse_args()

    if args.shell_src is not None:
        sync_baked_shell(args.shell_src)

    ver = bootstrap_version()
    wgt = build_wgt(args.out, ver)
    manifest = emit_manifest_stub(wgt, ver)

    print(f"bootstrap_wgt  path={wgt}  bytes={wgt.stat().st_size}  ver={ver}")
    print(f"bootstrap_manifest  path={manifest}  sha256={sha256_file(wgt)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
