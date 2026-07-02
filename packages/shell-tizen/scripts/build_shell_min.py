"""
Build shell.min.js for the Jellyfin Tizen browser-shell.

Per JEL-929: minify shell.js with esbuild (mangle OFF, public symbols
preserved) and record a JEL- ticket-history manifest so breadcrumb
tickets survive minification.

JEL-625: the manifest used to be PREPENDED to shell.min.js as a
/*! JEL history */ comment and tail-trimmed to fit HARD_CAP; the blob
crept to 3 bytes under the cap, so any shell growth failed the build.
The manifest now lives OUT-OF-BAND in ../shell.jel-history.txt
(package root, deliberately outside src/ so build-wgt.sh never stages
it) and is no longer trimmed — the full breadcrumb set is kept.
shell.min.js is pure minified code. verify_shell_src.py fails CI if
the history file goes stale relative to shell.js.

Acceptance (JEL-929, restated for the out-of-band manifest):
- grep -c '^\\*JEL-' shell.jel-history.txt  >= 80
- shell.min.js                              <= HARD_CAP
- mangle OFF (esbuild --minify-whitespace --minify-syntax only)

Manifest format: header lines, then one breadcrumb per line in
`*JEL-N [context]` form so `grep -c '^*JEL-'` reports one match per
source breadcrumb.

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
# JEL-625: out-of-band breadcrumb manifest. Lives at the PACKAGE root, not in
# src/ — build-wgt.sh stages src/ wholesale minus an explicit dev-file list,
# so a src/ location would silently ship the manifest in the retail .wgt.
JEL_HISTORY = HERE.parent / "shell.jel-history.txt"
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
# JEL-625 raised it 131072 -> 147456 (144 KiB) and moved the breadcrumb
# manifest out-of-band (shell.jel-history.txt): the committed blob had crept
# to 3 B under the old cap, so the next non-trivial shell change failed the
# build. The cap now covers pure minified code (~128.5 KB at the raise).
# JEL-618 (this branch) needed the same headroom for the chunked JSI-channel
# body cache and had bumped the cap independently; JEL-625 landed first and
# owns the cap policy, so its version is taken here verbatim.
#
# CAP POLICY (JEL-625): shell.min.js ships in the retail .wgt (index.html
# loads it) and is also the hosted /shell/ payload, so the cap is a payload-
# diet growth tripwire (JEL-124), NOT a platform hard limit — boot-shell.min.js
# has no cap and the TVs parse far larger plugin bundles. When a legitimate
# feature outgrows it: raise in 16 KiB steps, in the ticket that grows the
# code, leaving >= SOFT_HEADROOM of room after the raise; never absorb the
# bump silently in an unrelated change. The build warns (does not fail) when
# headroom drops below SOFT_HEADROOM so the wall is visible one ticket early.
HARD_CAP = 147456
SOFT_HEADROOM = 8192  # warn threshold: remaining bytes under HARD_CAP
# MIN_JEL_LINES is the JEL-929 grep floor: shell.jel-history.txt must carry
# >= 80 `*JEL-N` breadcrumb lines so `grep -c '^*JEL-'` on it stays a
# meaningful drift signal (pre-JEL-625 this floor applied to shell.min.js).
MIN_JEL_LINES = 80

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


def build_history_text(breadcrumbs) -> str:
    """JEL-625: render the out-of-band breadcrumb manifest.

    Deterministic function of shell.js alone (source order, no size budget,
    no trimming — the pre-JEL-625 in-blob manifest tail-trimmed to fit
    HARD_CAP and silently dropped history). verify_shell_src.py regenerates
    this text in CI and requires byte identity with the committed file, so
    keep it free of anything non-reproducible.
    """
    header = (
        "JEL breadcrumb history for shell.min.js — GENERATED, do not edit.\n"
        "Regenerate: python3 packages/shell-tizen/scripts/build_shell_min.py\n"
        "One `*JEL-N [context]` line per shell.js source breadcrumb, in source\n"
        "order. Formerly a /*! JEL history */ comment prepended to shell.min.js\n"
        "(JEL-929); moved out-of-band by JEL-625 so the deployed blob spends its\n"
        "HARD_CAP budget on code. Floor: >= 80 breadcrumb lines (JEL-929).\n"
        "\n"
    )
    lines = []
    for refs, ctx in breadcrumbs:
        line = "*" + " ".join(refs)
        if ctx:
            # Clamp context for line tidiness; refs are the drift signal.
            line += " " + ctx[:60].rstrip()
        lines.append(line + "\n")
    return header + "".join(lines)


def main() -> int:
    src = SHELL_JS.read_text(encoding="utf-8")
    minified = run_esbuild()
    minified = inject_babel_fingerprint(minified)
    minified = inject_shell_version(minified)
    minified = inject_qa_beacon(minified)
    CLEAN_MIN.write_bytes(minified)

    # JEL-625: shell.min.js is pure minified code; the breadcrumb manifest is
    # written out-of-band, full-length, next to the package (not in src/).
    SHELL_MIN.write_bytes(minified)

    crumbs = collect_breadcrumbs(src)
    history = build_history_text(crumbs)
    JEL_HISTORY.write_text(history, encoding="utf-8")

    jel_lines = sum(1 for l in history.split("\n") if l.startswith("*JEL-"))
    headroom = HARD_CAP - len(minified)
    print(
        f"shell.min.js  bytes={len(minified)}  headroom={headroom}  "
        f"babel_fpr={babel_fingerprint()}  shell_ver={shell_version()}"
    )
    print(f"shell.jel-history.txt  breadcrumb_lines={jel_lines}")

    if headroom < SOFT_HEADROOM:
        print(
            f"WARNING: only {headroom} B of headroom under the "
            f"{HARD_CAP // 1024} KiB cap (< {SOFT_HEADROOM} B) — plan a cap "
            "raise per the CAP POLICY comment before the next sizable change"
        )

    # If the minified code itself outgrows the budget, a deliberate cap bump
    # is owed (see CAP POLICY above; precedent: JEL-1977/120/131/134/625).
    # Fail loudly rather than ship an oversized blob.
    assert len(minified) <= HARD_CAP, (
        f"size {len(minified)} > {HARD_CAP} ({HARD_CAP // 1024} KiB cap): "
        "trim shell.js or raise HARD_CAP per the CAP POLICY comment"
    )
    assert jel_lines >= MIN_JEL_LINES, (
        f"history breadcrumb lines {jel_lines} < {MIN_JEL_LINES} (JEL-929 floor)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
