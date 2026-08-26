#!/usr/bin/env python3
"""fetch-webfonts.py — JELA-710: regenerate the self-hosted /shell/fonts/ drop.

Google Fonts UA-sniffs, does not recognise the Tizen 5.0 UA, and serves it
TrueType: 771 KiB of fonts per boot (~155-159 KiB gzipped per Inter weight)
for an engine (M63) that has supported WOFF2 since Chrome 36 — plus DNS + TLS
to two Google hosts, serially, on the boot path. So we self-host the WOFF2
bodies and serve them from the plugin next to the rest of /shell/.

This script is the provenance + regen tool for the committed artifacts under
Jellyfin.Plugin.JellyPlugShell/Resources/fonts/. It is run by hand, never at
build time (the babel FetchBabelStandalone pattern would put Google on the
build path, which is exactly the dependency this ticket removes).

What it does:
  1. Fetches the css2 stylesheets for the three families the boot uses, with
     a PINNED Chrome 49 UA. That UA choice is load-bearing twice over:
     Chrome 49 is new enough to be served WOFF2 + unicode-range subsets, and
     old enough (pre-62) that Google serves STATIC per-weight instances
     instead of variable fonts, which M63 cannot apply per-weight.
  2. Downloads the latin + latin-ext bodies for each requested weight.
     (The other subsets — vietnamese, cyrillic, greek — are dropped: the
     libraries this fleet browses are latin-script, and a title outside the
     hosted ranges falls back to the system face for those glyphs only.)
  3. Emits inter-sora.css — the local replacement for the theme's
     fonts.googleapis.com/css2 <link> (theme-css loadFonts, JS-Injector
     entry). Same @font-face shape css2 served: font-display swap,
     unicode-range per subset, woff2 only.
  4. Downloads the Media Bar plugin's slideshowpure.css at the exact
     jsdelivr commit the server's index.html pins today, and emits
     mediabar-slideshowpure.css with its line-1 @import (the Archivo Narrow
     css2 pull — the only render-blocking font request of the boot) replaced
     by local @font-face blocks. The shell rewrites the index.html <link> to
     this copy; if upstream Media Bar updates, re-run with the new pin.
  5. Emits fonts-manifest.json: source URLs + sha256 per artifact, so drift
     against upstream is checkable without re-running the downloads.

Font url()s inside the emitted CSS carry ?v=<sha256 of the woff2>, which is
what earns them the immutable branch of ShellController.ContentAddressed —
same manifest-sha discipline the shell itself uses.

Usage: python3 packages/server-plugin/scripts/fetch-webfonts.py
"""

import hashlib
import json
import re
import urllib.request
from pathlib import Path

# Chrome 49: woff2 + unicode-range, pre-variable-fonts. See module docstring.
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/49.0.2623.112 Safari/537.36"
)

# Weights mirror what the live consumers ask for today: the theme-css entry's
# css2 URL (Inter 400-700, Sora 400-800) and slideshowpure.css's font-weight
# rules (Archivo Narrow 400/500/600/700, no italics used anywhere in it).
FAMILIES = [
    ("inter", "Inter", "family=Inter:wght@400;500;600;700"),
    ("sora", "Sora", "family=Sora:wght@400;500;600;700;800"),
    (
        "archivo-narrow",
        "Archivo Narrow",
        "family=Archivo+Narrow:wght@400;500;600;700",
    ),
]

SUBSETS = ("latin", "latin-ext")

# The exact pin the live server's index.html carries (Media Bar 2.4.12.0).
MEDIABAR_CSS = (
    "https://cdn.jsdelivr.net/gh/IAmParadox27/jellyfin-plugin-media-bar"
    "@ae878fd763c1d2065db4dcbc7d15a90539a0f813/slideshowpure.css"
)

OUT = Path(__file__).resolve().parent.parent / (
    "Jellyfin.Plugin.JellyPlugShell/Resources/fonts"
)

FACE_RE = re.compile(
    r"/\*\s*(?P<subset>[a-z-]+)\s*\*/\s*"
    r"@font-face\s*\{(?P<body>[^}]*)\}",
    re.S,
)


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read()


def prop(body: str, name: str) -> str:
    m = re.search(name + r":\s*([^;]+);", body)
    assert m, f"@font-face without {name}: {body!r}"
    return m.group(1).strip()


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    manifest: dict = {"userAgent": UA, "families": {}, "mediabar": {}}
    css_by_family: dict[str, list[str]] = {}

    for slug, family, query in FAMILIES:
        css2_url = f"https://fonts.googleapis.com/css2?{query}&display=swap"
        css2 = fetch(css2_url).decode("utf-8")
        faces = []
        for m in FACE_RE.finditer(css2):
            subset, body = m.group("subset"), m.group("body")
            if subset not in SUBSETS:
                continue
            assert prop(body, "font-family") == f"'{family}'"
            assert prop(body, "font-style") == "normal"
            weight = prop(body, "font-weight")
            src = re.search(
                r"url\((https://fonts\.gstatic\.com/[^)]+\.woff2)\)"
                r"\s*format\('woff2'\)",
                body,
            )
            assert src, f"no woff2 src for {family} {weight} {subset}"
            gstatic_url = src.group(1)
            upstream_ver = re.search(r"/s/[a-z0-9]+/(v\d+)/", gstatic_url)
            assert upstream_ver, gstatic_url
            name = f"{slug}-{upstream_ver.group(1)}-{weight}-{subset}.woff2"
            woff2 = fetch(gstatic_url)
            (OUT / name).write_bytes(woff2)
            sha = hashlib.sha256(woff2).hexdigest()
            faces.append(
                {
                    "file": name,
                    "weight": weight,
                    "subset": subset,
                    "bytes": len(woff2),
                    "sha256": sha,
                    "source": gstatic_url,
                    "unicodeRange": prop(body, "unicode-range"),
                }
            )
        # Every requested weight must have come back in both kept subsets.
        want = len(query.split(";")) * len(SUBSETS)
        assert len(faces) == want, f"{family}: {len(faces)} faces, want {want}"
        manifest["families"][family] = {"css2": css2_url, "faces": faces}
        css_by_family[family] = [
            "@font-face {\n"
            f"  font-family: '{family}';\n"
            "  font-style: normal;\n"
            f"  font-weight: {f['weight']};\n"
            "  font-display: swap;\n"
            f"  src: url({f['file']}?v={f['sha256']}) format('woff2');\n"
            f"  unicode-range: {f['unicodeRange']};\n"
            "}"
            for f in faces
        ]

    header = (
        "/* Generated by scripts/fetch-webfonts.py (JELA-710) — do not edit.\n"
        " * Self-hosted replacement for the fonts.googleapis.com/css2 pull;\n"
        " * see fonts-manifest.json for upstream provenance. */\n"
    )
    (OUT / "inter-sora.css").write_text(
        header
        + "\n".join(css_by_family["Inter"] + css_by_family["Sora"])
        + "\n"
    )

    upstream = fetch(MEDIABAR_CSS).decode("utf-8")
    import_re = re.compile(
        r"@import url\(https://fonts\.googleapis\.com/css2\?family=Archivo"
        r"[^)]*\);"
    )
    assert len(import_re.findall(upstream)) == 1, (
        "slideshowpure.css upstream changed shape: expected exactly one "
        "Archivo Narrow @import — re-pin MEDIABAR_CSS and re-check"
    )
    patched = import_re.sub(
        "/* JELA-710: Archivo Narrow self-hosted below in place of the "
        "fonts.googleapis.com @import (render-blocking, UA-sniffed to TTF "
        "on Tizen). */\n"
        + "\n".join(css_by_family["Archivo Narrow"]),
        upstream,
    )
    (OUT / "mediabar-slideshowpure.css").write_text(
        "/* Patched copy of the Media Bar plugin's slideshowpure.css "
        "(see fonts-manifest.json\n"
        " * for the upstream pin). Regenerate with "
        "scripts/fetch-webfonts.py — do not edit. */\n" + patched
    )
    manifest["mediabar"] = {
        "source": MEDIABAR_CSS,
        "upstreamSha256": hashlib.sha256(upstream.encode()).hexdigest(),
    }

    (OUT / "fonts-manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n"
    )
    total = sum(
        f["bytes"]
        for fam in manifest["families"].values()
        for f in fam["faces"]
    )
    print(f"wrote {OUT}: {total} woff2 bytes across all faces")
    for fam, data in manifest["families"].items():
        latin = [f for f in data["faces"] if f["subset"] == "latin"]
        print(f"  {fam}: latin bytes {sum(f['bytes'] for f in latin)}")


if __name__ == "__main__":
    main()
