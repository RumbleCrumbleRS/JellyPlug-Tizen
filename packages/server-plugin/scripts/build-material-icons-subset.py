#!/usr/bin/env python3
"""JELA-825 — rebuild Resources/fonts/MaterialIcons-Regular-subset.woff2.

The upstream face jellyfin-web ships (`/web/MaterialIcons-Regular.<hash>.woff2`)
carries 2,188 glyphs in 125,116 B. The TV UI renders 208 of them, so the plugin
intercepts that URL (MaterialIconsSubsetStartupFilter) and answers with a subset
built here.

Two things about the upstream face drive how the subset must be cut:

  * Jellyfin 10.11 selects icons by CSS CLASS, not by ligature text — the markup
    is `<span class="material-icons play_arrow"></span>` and the stylesheet
    carries `.material-icons.play_arrow:before{content:"\\ue037"}`. So the
    CODEPOINTS are what actually has to survive.
  * The ligature table lives under the `rlig` feature, not `liga`. Subsetting
    with `--layout-features=liga,...` silently drops the whole GSUB. The
    ligature form is unused today (`--audit` reports zero call sites), but it is
    ~200 B to keep and it is the form every Material Icons snippet on the web
    uses, so a future skin edit should not render as literal text.
  * pyftsubset's layout closure walks the ligature table from the retained latin
    letters and drags all 2,193 icon glyphs back in — the subset comes out at
    115 KB. `--no-layout-closure` is mandatory here, not an optimisation.

Usage:

    python3 build-material-icons-subset.py --audit  URL   # re-derive the icon list
    python3 build-material-icons-subset.py --build  URL   # rebuild the woff2
    python3 build-material-icons-subset.py --verify       # check the committed woff2

URL is the Jellyfin origin (e.g. https://example.invalid). --audit re-runs the
enumeration against the LIVE shipped artifacts and rewrites material-icons.json;
--build subsets the live upstream face down to whatever that file lists.
"""

import argparse
import hashlib
import json
import os
import re
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.join(HERE, "..", "Jellyfin.Plugin.JellyPlugShell")
FONTS = os.path.join(PLUGIN, "Resources", "fonts")
SUBSET = os.path.join(FONTS, "MaterialIcons-Regular-subset.woff2")
ICON_LIST = os.path.join(FONTS, "material-icons.json")

# Artifacts outside /web/ that can also name an icon: our shell, the JSI channel
# bundle, and the third-party plugins that inject into the same document.
OUR_ARTIFACTS = [
    "/shell/shell.min.js",
    "/JavaScriptInjector/public.js",
    "/JellyfinEnhanced/script",
    "/HomeScreen/home-screen-sections.js",
    "/HomeScreen/home-screen-sections.css",
    "/PluginPages/inject.js",
    "/NotifySync/client.js",
    "/GetAvatar/ClientScript",
]


def fetch(url, timeout=90):
    req = urllib.request.Request(url, headers={"User-Agent": "jellyplug-jela825/1"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def web_assets(origin):
    """Yield (name, bytes) for every JS/CSS artifact the fleet can load.

    Enumerates the webpack chunk map out of runtime.bundle.js rather than the
    eager <script> tags in index.html: an icon that only appears on a lazily
    loaded route is exactly the one a shallow scan misses and a blank box
    reveals to a user later.
    """
    index = fetch(origin + "/web/index.html").decode("utf-8", "replace")
    yield "index.html", index.encode()

    eager = sorted(
        set(
            re.sub(r"\?.*$", "", m)
            for m in re.findall(r'(?:src|href)="([^"]+)"', index)
            if re.sub(r"\?.*$", "", m).endswith((".js", ".css"))
            and not m.startswith(("http", "/", "../"))
        )
    )
    runtime = None
    for name in eager:
        body = fetch(origin + "/web/" + name)
        if name.startswith("runtime."):
            runtime = body.decode("utf-8", "replace")
        yield name, body

    if runtime is None:
        raise SystemExit("runtime.bundle.js not referenced by index.html")

    # `.u(id)` -> chunk filename, `.miniCssF(id)` -> css filename. Both are plain
    # nested ternaries over a literal id->name map; pull the ids out of the map
    # and re-evaluate the ternaries by string substitution rather than by running
    # webpack's runtime.
    for fn_name in (".u=", ".miniCssF="):
        body = _slice_fn(runtime, fn_name)
        if not body:
            continue
        for chunk in _chunk_names(runtime, body):
            try:
                yield chunk, fetch(origin + "/web/" + chunk)
            except Exception as exc:  # a chunk id with no emitted asset
                print("  skip %s (%s)" % (chunk, exc), file=sys.stderr)


def _slice_fn(src, marker):
    i = src.find(marker)
    if i < 0:
        return ""
    start = i + len(marker)
    depth = 0
    for k in range(src.index("{", start), len(src)):
        if src[k] == "{":
            depth += 1
        elif src[k] == "}":
            depth -= 1
            if depth == 0:
                return src[start : k + 1]
    return ""


def _chunk_names(runtime, fn_body):
    """Chunk filenames = the id->name map entries, stamped with their hash.

    The map is `{2:"syncPlay-core-players-GenericPlayer",...}` and the emitted
    name is `<name>.<hash>.chunk.js`; the hash table is the second literal map in
    the same function. Reading both as literals avoids evaluating webpack's
    runtime in this process.
    """
    names = dict(re.findall(r'(\d{1,7}):"([^"]+)"', fn_body))
    ext = ".css" if "miniCssF" in fn_body[:40] or ".css" in fn_body else ".js"
    hashes = dict(re.findall(r'(\d{1,7}):"([0-9a-f]{20})"', fn_body))
    out = []
    for cid, name in names.items():
        if re.fullmatch(r"[0-9a-f]{20}", name):
            continue
        h = hashes.get(cid)
        if not h:
            continue
        out.append("%s.%s.chunk%s" % (name, h, ext))
    # Direct filenames (the node_modules bundles) appear as full names already.
    out += [n for n in names.values() if n.endswith((".js", ".css"))]
    return sorted(set(out))


def css_icon_map(assets):
    """.material-icons.<class>:before{content:"<char>"} -> {class: codepoint}."""
    rule = re.compile(r'\.material-icons\.([A-Za-z0-9_\\-]+):before\{content:"([^"]*)"')
    out = {}
    for name, body in assets:
        if not name.endswith(".css"):
            continue
        for m in rule.finditer(body.decode("utf-8", "replace")):
            char = m.group(2)
            if len(char) == 1:
                out[m.group(1).replace("\\", "")] = ord(char)
    return out


def enumerate_icons(assets, icon_classes, ligature_names):
    """Icon names actually referenced, by three independent readings.

    A — a token inside a `class="material-icons ..."` attribute. This is the
        form Jellyfin 10.11 emits and the only one that is unambiguous.
    B — text content of a material-icons element (the ligature form).
    C — any bare string literal equal to an icon name, in a file that mentions
        material-icons at all. Deliberately loose: it is how a dynamic
        `icon:"volume_off"` gets caught, and a false positive costs ~50 B while
        a false negative is a blank box on a page nobody opened.
    """
    attr = re.compile(r'material-icons([ \t][A-Za-z0-9_\- ]{0,200}?)(?=["\'])')
    ligtext = re.compile(r'material-icons[^<>"\']{0,120}?>\s*([a-z0-9_]{2,40})\s*<')
    strlit = re.compile(r'["\']([a-z0-9_]{3,40})["\']')

    found = {"A": set(), "B": set(), "C": set()}
    for _name, body in assets:
        text = body.decode("utf-8", "replace")
        if not text:
            continue
        for m in attr.finditer(text):
            found["A"].update(t for t in m.group(1).split() if t in icon_classes)
        for m in ligtext.finditer(text):
            if m.group(1) in ligature_names:
                found["B"].add(m.group(1))
        if "material-icons" in text:
            for m in strlit.finditer(text):
                n = m.group(1)
                if n in ligature_names or n in icon_classes:
                    found["C"].add(n)
    return found


def font_ligatures(path_or_bytes):
    from fontTools.ttLib import TTFont
    import io

    f = TTFont(io.BytesIO(path_or_bytes) if isinstance(path_or_bytes, bytes) else path_or_bytes)
    cmap = f.getBestCmap()
    glyph_to_cp = {}
    for cp, g in cmap.items():
        glyph_to_cp.setdefault(g, cp)
    names = {}
    if "GSUB" in f:
        for lookup in f["GSUB"].table.LookupList.Lookup:
            if lookup.LookupType != 4:
                continue
            for st in lookup.SubTable:
                for first, ligs in st.ligatures.items():
                    for lig in ligs:
                        try:
                            key = "".join(
                                chr(glyph_to_cp[c]) for c in [first] + list(lig.Component)
                            )
                        except KeyError:
                            continue
                        names[key] = lig.LigGlyph
    return f, cmap, names


def upstream_font_url(origin):
    index = fetch(origin + "/web/index.html").decode("utf-8", "replace")
    # The face is referenced from the main stylesheet, not index.html.
    css = [
        m
        for m in re.findall(r'href="([^"]+\.css)[^"]*"', index)
        if not m.startswith(("http", "/"))
    ]
    for name in css:
        body = fetch(origin + "/web/" + re.sub(r"\?.*$", "", name)).decode("utf-8", "replace")
        m = re.search(r"(MaterialIcons-Regular\.[0-9a-f]{20}\.woff2)", body)
        if m:
            return origin + "/web/" + m.group(1)
    raise SystemExit("MaterialIcons-Regular.<hash>.woff2 not referenced by any /web/ CSS")


def do_audit(origin):
    print("fetching /web/ artifacts …", file=sys.stderr)
    assets = list(web_assets(origin))
    for path in OUR_ARTIFACTS:
        try:
            assets.append((path, fetch(origin + path)))
        except Exception as exc:
            print("  skip %s (%s)" % (path, exc), file=sys.stderr)
    print("scanned %d artifacts" % len(assets), file=sys.stderr)

    icon_classes = css_icon_map(assets)
    font = fetch(upstream_font_url(origin))
    _f, _cmap, ligs = font_ligatures(font)
    found = enumerate_icons(assets, icon_classes, set(ligs))

    names = sorted(found["A"] | found["B"] | found["C"])
    missing = [n for n in names if n not in icon_classes]
    if missing:
        raise SystemExit("no codepoint for: %s" % missing)

    out = {
        "_comment": "JELA-825 — icons the fleet actually references. Regenerate with "
        "build-material-icons-subset.py --audit <origin>.",
        "sources": {
            "class-attribute": sorted(found["A"]),
            "ligature-text": sorted(found["B"]),
            "string-literal": sorted(found["C"]),
        },
        "icons": names,
        "codepoints": ["U+%04X" % icon_classes[n] for n in names],
    }
    with open(ICON_LIST, "w") as fh:
        json.dump(out, fh, indent=1)
        fh.write("\n")
    print(
        "audit: %d icons (class-attr %d, ligature-text %d, string-literal %d) -> %s"
        % (len(names), len(found["A"]), len(found["B"]), len(found["C"]), ICON_LIST)
    )


def do_build(origin):
    from fontTools import subset

    spec = json.load(open(ICON_LIST))
    names = spec["icons"]
    url = upstream_font_url(origin)
    print("upstream: %s" % url)
    src = os.path.join(FONTS, ".materialicons-upstream.woff2")
    with open(src, "wb") as fh:
        fh.write(fetch(url))

    subset.main(
        [
            src,
            "--unicodes=" + ",".join(spec["codepoints"]),
            # Retain the latin letters the ligature rules are keyed on.
            "--text=" + "".join(sorted(set("".join(names)))),
            "--layout-features=rlig,liga,calt",
            # Without this the closure walks rlig and pulls every icon back in.
            "--no-layout-closure",
            "--no-hinting",
            "--notdef-outline",
            "--flavor=woff2",
            "--output-file=" + SUBSET,
        ]
    )
    os.remove(src)
    do_verify(upstream=url)


def do_verify(upstream=None):
    spec = json.load(open(ICON_LIST))
    want = {int(c[2:], 16) for c in spec["codepoints"]}
    _f, cmap, ligs = font_ligatures(SUBSET)
    size = os.path.getsize(SUBSET)
    missing = sorted(want - set(cmap))
    if missing:
        raise SystemExit("subset is missing codepoints: %s" % [hex(c) for c in missing])
    no_lig = [n for n in spec["icons"] if n not in ligs]
    if no_lig:
        raise SystemExit("subset lost the ligature form for: %s" % no_lig[:10])
    if size > 20_000:
        raise SystemExit("subset is %d B — over the 20,000 B budget" % size)
    sha = hashlib.sha256(open(SUBSET, "rb").read()).hexdigest()
    print(
        "verify OK: %d B, %d icons, %d ligature rules, sha256 %s%s"
        % (size, len(want), len(ligs), sha, ("\nupstream " + upstream) if upstream else "")
    )


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--audit", metavar="ORIGIN")
    ap.add_argument("--build", metavar="ORIGIN")
    ap.add_argument("--verify", action="store_true")
    args = ap.parse_args()
    if args.audit:
        do_audit(args.audit.rstrip("/"))
    if args.build:
        do_build(args.build.rstrip("/"))
    if args.verify or not (args.audit or args.build):
        do_verify()
