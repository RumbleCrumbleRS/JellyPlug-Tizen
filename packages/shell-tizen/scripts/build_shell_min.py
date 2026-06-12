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
# JEL-98: the JEL-96 Tizen-only restructure split the formerly-flat package into
# src/ (shell sources + deployed blobs) and tizen/ (the WGT config), but left
# these path constants pointing at the script's own scripts/ dir, which silently
# broke `python3 build_shell_min.py`. Resolve sources from their real homes.
SRC = HERE.parent / "src"
TIZEN = HERE.parent / "tizen"
SHELL_JS = SRC / "shell.js"
SHELL_MIN = SRC / "shell.min.js"
CLEAN_MIN = SRC / "shell.min.js.eb_clean"
BABEL_MIN = SRC / "babel.min.js"
CONFIG_XML = TIZEN / "config.xml"
QA_BEACON_JS = SRC / "qa-beacon.js"  # JEL-1971: optional QA telemetry body
BABEL_FPR_PLACEHOLDER = "__BABEL_FPR__"
SHELL_VER_PLACEHOLDER = "__SHELL_VER__"
QA_BEACON_PLACEHOLDER = "__QA_BEACON_BODY__"

# HARD_CAP is the deployed-blob ceiling enforced by the assert in main().
# JEL-1977 raised the budget 94000 -> 100000 (cap 102400); JEL-120 raised the
# cap 102400 -> 110592 (108 KiB) when the JEL-111 iterator-clobber sweep
# (mirrored from boot-shell, on-device verified) grew the minified base to
# ~104.8 KB and the first lockstep rebuild of shell.min.js no longer fit.
# JEL-131 raised it 110592 -> 122880 (120 KiB): the login-idle tx-cache
# primer (seed-side string block, mirrored in boot-shell) grew the minified
# base to ~116.1 KB. shell.min.js is the HOSTED shell (served from /shell/,
# not packaged in the .wgt since JEL-124), so the cap guards manifest
# breadcrumb budget only — boot-shell.min.js (the wgt-shipped blob) has no
# such cap and took the same block.
# JEL-134 raised it 122880 -> 131072 (128 KiB): the IndexedDB creds vault
# (seed-side mirror/invalidation + restoreCredsVault boot restore, mirrored
# in boot-shell) grew the minified base to ~119.4 KB, leaving no room for
# the 80-line breadcrumb floor under the old cap.
HARD_CAP = 131072
# MIN_JEL_LINES is the JEL-929 grep floor: shell.min.js must carry >= 80
# `*JEL-N` breadcrumb lines so `grep -c JEL-` stays a meaningful drift signal.
MIN_JEL_LINES = 80
# JEL-91: budget the breadcrumb manifest against HARD_CAP, not a fixed 100000.
# The old TARGET (100000) had drifted *below* the minified base size (~101.3 KB
# after accumulated feature growth, incl. JEL-90's resolveDeviceName model read),
# so build_manifest computed a negative budget and emitted every breadcrumb
# unbounded — overflowing the cap (~102994 B). The manifest now trims breadcrumbs
# from the tail to fit under HARD_CAP while preserving the MIN_JEL_LINES floor, so
# future code growth self-corrects here instead of failing the build.
TARGET_BYTES = HARD_CAP  # manifest budget tracks the hard cap (was 100000)
BASE_BYTES_PLACEHOLDER = 0  # filled at runtime after esbuild pass

# Prefer the lockfile-pinned workspace install (integrity-checked by pnpm)
# over PATH or an ad-hoc npx download (JEL-119 supply-chain hardening).
_LOCAL_ESBUILD = HERE.parent.parent.parent / "node_modules" / ".bin" / "esbuild"
ESBUILD = (
    str(_LOCAL_ESBUILD)
    if _LOCAL_ESBUILD.exists()
    else (shutil.which("esbuild") or "esbuild")
)


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

    # JEL-120: budget in UTF-8 BYTES, not str chars — context lines harvested
    # from source comments can carry non-ASCII (arrows, ≡), and the manifest
    # is written encoded, so char-based math overshot HARD_CAP by the
    # multibyte surplus.
    def blen(s: str) -> int:
        return len(s.encode("utf-8"))

    budget = TARGET_BYTES - base_size - blen(header) - blen(footer)

    lines = ["*" + " ".join(refs) + "\n" for refs, _ in breadcrumbs]

    # JEL-91: trim breadcrumbs from the tail (source order) until the bare lines
    # fit the byte budget, but never drop below the MIN_JEL_LINES grep floor.
    # base_size now sits close to HARD_CAP, so the full breadcrumb set no longer
    # fits; shedding tail entries holds the deployed blob under the cap without
    # bloating it. Trimming is deterministic, so the output is reproducible.
    kept = len(lines)
    while kept > MIN_JEL_LINES and sum(blen(l) for l in lines[:kept]) > budget:
        kept -= 1
    dropped = len(lines) - kept
    if dropped:
        print(
            f"manifest: trimmed {dropped} of {len(lines)} breadcrumb lines "
            f"to fit {budget} B budget (kept {kept}, floor {MIN_JEL_LINES})"
        )
    lines = lines[:kept]
    breadcrumbs = breadcrumbs[:kept]

    bare = sum(blen(l) for l in lines)
    remaining = budget - bare

    for i, (_, ctx) in enumerate(breadcrumbs):
        if not ctx:
            continue
        base = lines[i].rstrip("\n")
        max_extra = min(45, remaining - 1)
        if max_extra <= 2:
            break
        extra = " " + ctx[: max_extra - 1]
        while blen(extra) > max_extra:
            extra = extra[:-1]
        lines[i] = base + extra + "\n"
        remaining -= blen(extra)

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

    # JEL-91: if even the MIN_JEL_LINES floor can't fit under HARD_CAP, the
    # minified code itself has outgrown the budget — a real cap bump is owed
    # (precedent: JEL-1977). Fail loudly rather than ship an oversized blob.
    assert len(out) <= HARD_CAP, (
        f"size {len(out)} > {HARD_CAP} ({HARD_CAP // 1024} KiB cap): minified base "
        f"{base_size} B leaves no room for the {MIN_JEL_LINES}-line breadcrumb "
        "floor — trim shell.js or raise HARD_CAP with justification (JEL-1977)"
    )
    assert jel_lines >= MIN_JEL_LINES, f"jel_lines {jel_lines} < {MIN_JEL_LINES}"
    return 0


if __name__ == "__main__":
    sys.exit(main())
