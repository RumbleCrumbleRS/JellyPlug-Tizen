"""
Build shell.min.js for the Jellyfin Tizen browser-shell.

Per JEL-929: minify shell.js with esbuild (mangle OFF, public symbols
preserved) and prepend a JEL- ticket-history manifest so breadcrumb
tickets survive minification.

Acceptance (JEL-929):
- grep -c JEL- shell.min.js  >= 80
- shell.min.js                <= 70 KB
- mangle OFF (esbuild --minify-whitespace --minify-syntax only)

Manifest format: one /*! ... */ block at the top, one breadcrumb per
line in `*JEL-N [context]` form so `grep -c JEL-` reports one match
per source breadcrumb.

Usage: python3 build_shell_min.py
"""

import re
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent
SHELL_JS = HERE / "shell.js"
SHELL_MIN = HERE / "shell.min.js"
CLEAN_MIN = HERE / "shell.min.js.eb_clean"
BABEL_MIN = HERE / "babel.min.js"
CONFIG_XML = HERE / "config.xml"
QA_BEACON_JS = HERE / "qa-beacon.js"  # JEL-1971: optional QA telemetry body
BABEL_FPR_PLACEHOLDER = "__BABEL_FPR__"
SHELL_VER_PLACEHOLDER = "__SHELL_VER__"
QA_BEACON_PLACEHOLDER = "__QA_BEACON_BODY__"

TARGET_BYTES = 100000  # JEL-1977 v69: raised 94000 -> 100000 for /web/ body cache helpers
BASE_BYTES_PLACEHOLDER = 0  # filled at runtime after esbuild pass

ESBUILD = shutil.which("esbuild") or "esbuild"


def run_esbuild() -> bytes:
    """Run esbuild without mangle, no comments, return minified bytes."""
    args = [
        ESBUILD,
        str(SHELL_JS),
        "--minify-whitespace",
        "--minify-syntax",
        "--target=es2017",
        "--legal-comments=none",
    ]
    proc = subprocess.run(args, capture_output=True, check=True)
    return proc.stdout


def babel_fingerprint() -> str:
    """JEL-1150: stable fingerprint of vendored babel.min.js.

    Format: `<len>:<first32hex>:<last32hex>`. Changes iff the vendored
    babel bundle changes; survives pure shell refactors so the
    transpile-cache key (TX_VER) stays valid across shell releases that
    don't touch babel. Hex avoids string-literal escaping hazards from
    raw JS bytes (quotes, backslashes, newlines).
    """
    if not BABEL_MIN.exists():
        return "missing:0:0"
    data = BABEL_MIN.read_bytes()
    head = data[:32].hex()
    tail = data[-32:].hex() if len(data) >= 32 else head
    return f"{len(data)}:{head}:{tail}"


def inject_babel_fingerprint(minified: bytes) -> bytes:
    fpr = babel_fingerprint()
    if BABEL_FPR_PLACEHOLDER.encode("ascii") not in minified:
        raise RuntimeError(
            f"placeholder {BABEL_FPR_PLACEHOLDER!r} not found in minified output"
        )
    return minified.replace(
        BABEL_FPR_PLACEHOLDER.encode("ascii"), fpr.encode("ascii")
    )


def shell_version() -> str:
    """JEL-1215: parse widget version from config.xml.

    Single source of truth for shell version. The release-time bump in
    config.xml propagates into the HUD diag string via __SHELL_VER__.
    """
    if not CONFIG_XML.exists():
        raise RuntimeError(f"{CONFIG_XML} not found")
    text = CONFIG_XML.read_text(encoding="utf-8")
    m = re.search(r'<widget[^>]*\bversion="([^"]+)"', text)
    if not m:
        raise RuntimeError("widget version attribute not found in config.xml")
    return m.group(1)


def inject_shell_version(minified: bytes) -> bytes:
    ver = shell_version()
    if SHELL_VER_PLACEHOLDER.encode("ascii") not in minified:
        raise RuntimeError(
            f"placeholder {SHELL_VER_PLACEHOLDER!r} not found in minified output"
        )
    return minified.replace(
        SHELL_VER_PLACEHOLDER.encode("ascii"), ver.encode("ascii")
    )


def inject_qa_beacon(minified: bytes) -> bytes:
    """JEL-1971: substitute the qa-beacon.js body into the shell-side
    qaBeaconBody() placeholder.

    Beacon source is kept as a standalone file (qa-beacon.js) for
    readability; this step JSON-encodes the body (handles every JS
    string escape) and rewrites `'__QA_BEACON_BODY__'` (placeholder
    literal in single quotes after esbuild) with a single-quoted JS
    string carrying the full beacon. Refuses to inline a body that
    contains the literal `</script>` because the fast path splices the
    result as HTML.
    """
    if QA_BEACON_PLACEHOLDER.encode("ascii") not in minified:
        # No placeholder: shell.js was not patched to call qaBeaconBody().
        # Treat as fatal so a stale shell.js never ships a silently-inert
        # beacon.
        raise RuntimeError(
            f"placeholder {QA_BEACON_PLACEHOLDER!r} not found in minified output"
        )
    if not QA_BEACON_JS.exists():
        # Beacon file absent — leave placeholder so qaBeaconBody() returns
        # the literal string and injectQaBeacon() no-ops. Useful for plain
        # source loads / local dev without the QA channel.
        return minified
    body = QA_BEACON_JS.read_text(encoding="utf-8")
    if "</script" in body:
        raise RuntimeError(
            "qa-beacon.js contains </script — would break HTML fast-path splice"
        )
    # json.dumps gives a JSON string literal with all needed escapes.
    # JS happily parses JSON string literals as JS string literals when
    # the source already lacks U+2028/U+2029; ensure_ascii=True keeps the
    # body 7-bit so the splice through Tizen's UTF-8 file pipeline is
    # byte-safe.
    import json
    quoted = json.dumps(body, ensure_ascii=True)
    # qaBeaconBody() returned '__QA_BEACON_BODY__' (single-quoted in
    # esbuild output). Replace that single-quoted literal with the
    # JSON-encoded (double-quoted) string.
    target_single = ("'" + QA_BEACON_PLACEHOLDER + "'").encode("ascii")
    target_double = ('"' + QA_BEACON_PLACEHOLDER + '"').encode("ascii")
    if target_single in minified:
        return minified.replace(target_single, quoted.encode("ascii"), 1)
    if target_double in minified:
        return minified.replace(target_double, quoted.encode("ascii"), 1)
    raise RuntimeError(
        "qaBeaconBody placeholder not found in expected single/double-quoted form"
    )


def collect_breadcrumbs(src: str):
    crumbs = []

    def push(text: str) -> None:
        text = re.sub(r"[-]{3,}", "", text).strip()
        if not text:
            return
        refs = re.findall(r"JEL-\d+", text)
        seen = []
        for r in refs:
            if r not in seen:
                seen.append(r)
        if not seen:
            return
        context = re.sub(r"\(?\bJEL-\d+\)?", "", text)
        context = re.sub(r"\s+", " ", context).strip(" :;,()")
        crumbs.append((seen, context))

    for m in re.finditer(r"/\*[\s\S]*?\*/", src):
        body = m.group()
        if "JEL-" not in body:
            continue
        for line in body.split("\n"):
            if "JEL-" in line:
                cleaned = re.sub(r"^[\s/*]+|\*/\s*$", "", line).strip()
                push(cleaned)

    for line in src.split("\n"):
        s = line.strip()
        if s.startswith("//") and "JEL-" in s:
            push(s[2:].strip())

    result = []
    prev = None
    for b in crumbs:
        key = (tuple(b[0]), b[1])
        if key != prev:
            result.append(b)
            prev = key
    return result


def build_manifest(base_size: int, breadcrumbs) -> str:
    header = "/*! JEL history (passthrough JEL-929):\n"
    footer = "*/\n"
    budget = TARGET_BYTES - base_size - len(header) - len(footer)

    lines = ["*" + " ".join(refs) + "\n" for refs, _ in breadcrumbs]
    bare = sum(len(l) for l in lines)
    remaining = budget - bare

    for i, (_, ctx) in enumerate(breadcrumbs):
        if not ctx:
            continue
        base = lines[i].rstrip("\n")
        max_extra = min(45, remaining - 1)
        if max_extra <= 2:
            break
        extra = " " + ctx[: max_extra - 1]
        lines[i] = base + extra + "\n"
        remaining -= len(extra)

    return header + "".join(lines) + footer


def main() -> int:
    src = SHELL_JS.read_text(encoding="utf-8")
    minified = run_esbuild()
    minified = inject_babel_fingerprint(minified)
    minified = inject_shell_version(minified)
    minified = inject_qa_beacon(minified)
    CLEAN_MIN.write_bytes(minified)
    base_size = len(minified)

    crumbs = collect_breadcrumbs(src)
    manifest = build_manifest(base_size, crumbs)

    out = manifest.encode("utf-8") + minified
    SHELL_MIN.write_bytes(out)

    jel_lines = sum(1 for l in out.decode("utf-8").split("\n") if "JEL-" in l)
    print(
        f"shell.min.js  bytes={len(out)}  jel_lines={jel_lines}  "
        f"babel_fpr={babel_fingerprint()}  shell_ver={shell_version()}"
    )

    assert len(out) <= 102400, f"size {len(out)} > 100 KiB"  # JEL-1977 v69: 96→100 KiB for /web/ body cache helpers
    assert jel_lines >= 80, f"jel_lines {jel_lines} < 80"
    return 0


if __name__ == "__main__":
    sys.exit(main())
