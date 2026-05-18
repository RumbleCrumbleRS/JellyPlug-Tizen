"""
Emit ${server}/shell/manifest.json for the Hosted Shell Bootstrap (HSB).

Reads the shell.min.js + babel.min.js already present in the drop directory,
extracts version from the /*! JEL history */ header (built by build_shell_min.py),
and writes manifest.json with sha256 + size for cache-busting and integrity.

Usage:
  python3 emit_manifest.py /var/www/jellyfin/shell/
  python3 emit_manifest.py /var/www/jellyfin/shell/ --min-bootstrap 2.0.0 \
      --bootstrap-wgt JellyfinShellBootstrap_v2.0.0.wgt
"""

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def extract_shell_version(shell_min: Path) -> str:
    text = shell_min.read_text(encoding="utf-8", errors="ignore")[:8192]
    # build_shell_min.py inlines the running shell version via __SHELL_VER__
    # placeholder. Reading the first localStorage seed/version probe should
    # always carry that string verbatim somewhere in the head bytes.
    m = re.search(r'shellVer\s*[:=]\s*"([0-9][0-9A-Za-z.\-]*)"', text)
    if m:
        return m.group(1)
    m = re.search(r'"version"\s*:\s*"([0-9][0-9A-Za-z.\-]*)"', text)
    if m:
        return m.group(1)
    return "unknown"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("drop_dir", type=Path)
    ap.add_argument("--min-bootstrap", default="2.0.0")
    ap.add_argument("--bootstrap-wgt", default=None,
                    help="filename of an advertised bootstrap WGT inside drop_dir")
    ap.add_argument("--shell-url", default=None,
                    help="optional override; defaults to shell.min.js (relative)")
    args = ap.parse_args()

    drop = args.drop_dir
    shell = drop / "shell.min.js"
    babel = drop / "babel.min.js"
    if not shell.exists():
        print(f"ERROR: missing {shell}", file=sys.stderr)
        return 1

    payload = {
        "version": extract_shell_version(shell),
        "sha256": sha256_file(shell),
        "shellUrl": args.shell_url,
        "babelSha256": sha256_file(babel) if babel.exists() else None,
        "minBootstrapVersion": args.min_bootstrap,
        "bootstrapWgt": None,
    }
    if args.bootstrap_wgt:
        wgt = drop / args.bootstrap_wgt
        if not wgt.exists():
            print(f"ERROR: --bootstrap-wgt set but {wgt} missing", file=sys.stderr)
            return 1
        payload["bootstrapWgt"] = {
            "filename": wgt.name,
            "sha256": sha256_file(wgt),
            "sizeBytes": wgt.stat().st_size,
        }

    out = drop / "manifest.json"
    out.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"manifest  path={out}  version={payload['version']}  sha256={payload['sha256']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
