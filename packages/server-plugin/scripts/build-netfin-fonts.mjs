#!/usr/bin/env node
/*
 * build-netfin-fonts.mjs — JELA-902: vendor the NetFin skin and self-host the
 * fonts it pulls, so a cold boot makes zero third-party requests.
 *
 * WHAT THE DEFECT WAS
 * -------------------
 * The server's `Branding.CustomCss` field held exactly 73 bytes:
 *
 *     @import url("https://cdn.jsdelivr.net/gh/ya0903/NetFin@main/netfin.css");
 *
 * Every third-party byte of the boot hung off that one line — 5.28 MB across 7
 * requests to 3 origins, 26% of a 20.26 MB cold boot (JELA-900 census, 23rd
 * run). netfin.css is the sole parent of the other six: its line-8 `@import`
 * pulls a Google css2 stylesheet plus four faces, and its Material Icons
 * `@font-face` pulls a 4,969,868 B icon font.
 *
 * Note this is NOT the JS-Injector channel. The census predicted the injector
 * and the jellyplug-theme skin; the live bundle references none of these URLs.
 * Our own theme still ships via the injector, and NetFin layers on top of it.
 *
 * THE ICON FONT IS VARIABLE, AND M63 CANNOT USE THAT
 * --------------------------------------------------
 * The upstream Material Symbols Rounded face is a 4-axis variable font —
 * FILL 0..1, GRAD -50..200, opsz 20..48, wght 100..700 — 6,182 glyphs,
 * 14,270,532 B decompressed, the bulk of it `gvar`. JELA-710 already
 * established that M63 cannot apply a variable font per weight; that is why
 * fetch-webfonts.py pins a Chrome 49 UA to force static instances. So the
 * fleet was paying 4.97 MB for an axis the engine cannot drive, and rendering
 * the default instance regardless.
 *
 * We therefore pin all four axes to their defaults (a static instance) and
 * subset to the codepoints actually referenced: 4,969,868 B -> ~13 KB.
 *
 * WHY THE GLYPH SET IS PROVABLE, NOT GUESSED
 * ------------------------------------------
 * Jellyfin selects icons by CSS CLASS with a codepoint (`content:""`),
 * not by ligature text — the JELA-825 finding. So CODEPOINTS are what has to
 * survive, and the set is the union of two audited lists:
 *
 *   * the 208 codepoints JELA-825 enumerated against the live shipped
 *     artifacts into Resources/fonts/material-icons.json, and
 *   * the 7 PUA escapes netfin.css adds for its own section-tab icons.
 *
 * = 210. One of them, U+E88F (info_outline), is absent from upstream Material
 * Symbols v267 ITSELF, so it does not render from this face today either; the
 * other 209 all survive. The subset is the same bytes with unreferenced glyphs
 * removed, which makes "no visual regression" a property of the construction.
 *
 * There is a second safety net already in the skin: netfin.css sets
 * `--iconPack: "Material Icons Round", Material Icons` and applies it with
 * `.material-icons { font-family: var(--iconPack) !important }`, so per-glyph
 * CSS font fallback lands on Jellyfin's own Material Icons face — which
 * MaterialIconsSubsetStartupFilter already subsets to those same 208
 * codepoints. A codepoint we missed would still render.
 *
 * `noLayoutClosure` IS MANDATORY, NOT AN OPTIMISATION
 * --------------------------------------------------
 * Same trap JELA-825 documented for the MaterialIcons subset: the subsetter's
 * layout closure walks the ligature table and drags all ~6k icon glyphs back
 * in. Without it the "subset" comes out near full size.
 *
 * ONE FILE PER WEIGHT, NOT GOOGLE'S latin/latin-ext SPLIT
 * ------------------------------------------------------
 * Google serves the Tizen UA ten full unsubsetted `.ttf` faces with no
 * unicode-range at all (verified: that is the JELA-710 UA sniff, never applied
 * to these three families). A browser fetches one file per USED weight today.
 * If we emitted Google's usual latin + latin-ext split we would turn each of
 * those into two requests and break AC3's "request count does not rise". So we
 * subset each `.ttf` to the UNION of the latin and latin-ext ranges and emit a
 * single woff2 per weight: one request per used weight, same as today, but
 * Brotli-compressed and subsetted.
 *
 * All ten declared weights are emitted even though a boot fetches ~4 of them.
 * An unfetched face costs nothing on the wire, and shipping the full set the
 * upstream `@import` declares means a skin edit that reaches for another
 * weight gets the real face instead of silently falling back to the system
 * one.
 *
 * DEPENDENCIES ARE DELIBERATELY NOT IN package.json
 * -------------------------------------------------
 * Like fetch-webfonts.py, this is a hand-run provenance + regen tool, never a
 * build step — putting Google and jsdelivr on the build path is the very
 * dependency the ticket removes. The subsetter deps stay out of package.json
 * so `pnpm test` never needs them (and cannot be broken by a devDep-skipping
 * install). Install them ad hoc:
 *
 *     npm install --no-save subset-font wawoff2
 *
 * The committed artifacts are guarded by scripts/netfin-fonts.test.cjs, which
 * is pure node and needs nothing.
 *
 * USAGE
 * -----
 *     node packages/server-plugin/scripts/build-netfin-fonts.mjs && pnpm format
 *     node packages/server-plugin/scripts/build-netfin-fonts.mjs --check
 *
 * `pnpm format` is not optional after a write: fonts-manifest.json is inside
 * the repo's prettier glob and JSON.stringify disagrees with prettier about
 * short arrays, so skipping it reddens the CI format gate.
 *
 * `--check` re-downloads the pinned upstream sources and reports drift against
 * the recorded sha256s without writing anything.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.join(HERE, "..", "Jellyfin.Plugin.JellyPlugShell");
const FONTS = path.join(PLUGIN, "Resources", "fonts");
const MANIFEST = path.join(FONTS, "fonts-manifest.json");
const ICON_LIST = path.join(FONTS, "material-icons.json");

// ---------------------------------------------------------------- upstream pins

// `@main` is an uncontrolled input to the fielded skin — an upstream force-push
// would change what every TV renders. Vendoring pins it to a commit.
const NETFIN_REPO = "ya0903/NetFin";
const NETFIN_COMMIT = "ba7ff8ad627e7d8c5611cb6e53625cc53381f9d3";
const NETFIN_URL = `https://cdn.jsdelivr.net/gh/${NETFIN_REPO}@${NETFIN_COMMIT}/netfin.css`;
const NETFIN_SHA256 =
  "3a6105f50b93d4b1a6f96739ec17e30b8f4af3d17c2019f9092b7cbacde052cc";

// The exact face netfin.css points at today. We subset THESE bytes, which is
// what lets us claim no glyph that renders today stops rendering.
const MATSYM_URL =
  "https://fonts.gstatic.com/s/materialsymbolsrounded/v267/sykg-zNym6YjUruM-QrEh7-nyTnjDwKNJ_190Fjzag.woff2";
const MATSYM_SHA256 =
  "84c2298291cb0cc57d2cef859ddd21b58802c603acc88f9f6acff973ec2bdb63";
const MATSYM_OUT = "material-symbols-rounded-v267-400.woff2";
// All four axes pinned to the upstream defaults — i.e. the instance M63 is
// already rendering, since it cannot drive the axes.
const MATSYM_AXES = { wght: 400, FILL: 0, GRAD: 0, opsz: 24 };

// netfin.css line 8, verbatim. Its `@font-face` blocks get inlined, which is
// why the 706 B css2 request disappears entirely rather than moving origin.
const CSS2_URL =
  "https://fonts.googleapis.com/css2?family=Orbitron:wght@400;500;700;900&family=Rajdhani:wght@300;400;500;600;700&family=Share+Tech+Mono&display=swap";

// The Tizen 5.0 UA the fleet actually sends. Unlike fetch-webfonts.py we WANT
// the TrueType this UA is served: it is the complete unsubsetted face, which is
// exactly the right input to subset ourselves. Asking as Chrome 49 would hand
// back Google's pre-split latin/latin-ext woff2 pair and force 2 requests per
// weight.
const TIZEN_UA =
  "Mozilla/5.0 (SMART-TV; LINUX; Tizen 5.0) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Version/5.0 TV Safari/537.36";

// Filenames must satisfy ShellController.FontNameRe = ^[a-z0-9.-]{1,64}$.
const FAMILY_SLUG = {
  Orbitron: "orbitron-v35",
  Rajdhani: "rajdhani-v17",
  "Share Tech Mono": "share-tech-mono-v16",
};

const NETFIN_OUT = "netfin.css";

// The three origins AC1 requires off the boot path. Shared with the test guard
// via netfin-fonts.test.cjs's own copy — kept literal in both so a grep for an
// origin finds every place that reasons about it.
const THIRD_PARTY_ORIGINS = [
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "cdn.jsdelivr.net",
];

// ------------------------------------------------------------- unicode coverage

// latin + latin-ext, copied from the ranges Google's own css2 emits for these
// families (and already recorded per-face in fonts-manifest.json). We take the
// UNION and emit one file, so a latin-ext glyph never costs a second request.
const LATIN_RANGES = [
  [0x0000, 0x00ff], [0x0131, 0x0131], [0x0152, 0x0153], [0x02bb, 0x02bc],
  [0x02c6, 0x02c6], [0x02da, 0x02da], [0x02dc, 0x02dc], [0x0304, 0x0304],
  [0x0308, 0x0308], [0x0329, 0x0329], [0x2000, 0x206f], [0x20ac, 0x20ac],
  [0x2122, 0x2122], [0x2191, 0x2191], [0x2193, 0x2193], [0x2212, 0x2212],
  [0x2215, 0x2215], [0xfeff, 0xfeff], [0xfffd, 0xfffd],
];
const LATIN_EXT_RANGES = [
  [0x0100, 0x02ba], [0x02bd, 0x02c5], [0x02c7, 0x02cc], [0x02ce, 0x02d7],
  [0x02dd, 0x02ff], [0x0304, 0x0304], [0x0308, 0x0308], [0x0329, 0x0329],
  [0x1d00, 0x1dbf], [0x1e00, 0x1e9f], [0x1ef2, 0x1eff], [0x2020, 0x2020],
  [0x20a0, 0x20ab], [0x20ad, 0x20c0], [0x2113, 0x2113], [0x2c60, 0x2c7f],
  [0xa720, 0xa7ff],
];

function expand(ranges) {
  const out = new Set();
  for (const [lo, hi] of ranges) for (let c = lo; c <= hi; c++) out.add(c);
  return out;
}

// The 7 PUA escapes netfin.css references itself, on top of JELA-825's 208.
// Re-derived from the downloaded sheet below; this list is the assertion.
const NETFIN_ICON_CODEPOINTS = [
  0xe313, 0xe5d0, 0xe87d, 0xe88a, 0xe88e, 0xe8eb, 0xf1c6,
];

// ------------------------------------------------------------------- primitives

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

async function fetchBuf(url, ua) {
  const res = await fetch(url, { headers: ua ? { "User-Agent": ua } : {} });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Pinned fetch: a sha mismatch is upstream drift, and must never be silent. */
async function fetchPinned(url, expectSha, ua) {
  const buf = await fetchBuf(url, ua);
  const got = sha256(buf);
  if (expectSha && got !== expectSha) {
    throw new Error(
      `sha256 drift for ${url}\n  expected ${expectSha}\n  got      ${got}\n` +
        `If upstream legitimately changed, update the pin in this script and ` +
        `re-run; do not relax the check.`,
    );
  }
  return buf;
}

async function loadSubsetter() {
  try {
    const [{ default: subsetFont }, wawoff2] = await Promise.all([
      import("subset-font"),
      import("wawoff2"),
    ]);
    return { subsetFont, wawoff2: wawoff2.default ?? wawoff2 };
  } catch (err) {
    throw new Error(
      "this regen tool needs the subsetter, which is deliberately not a repo " +
        "dependency (see the header). Install it ad hoc:\n\n" +
        "    npm install --no-save subset-font wawoff2\n\n" +
        `underlying error: ${err.message}`,
    );
  }
}

// ------------------------------------------------------------- sfnt inspection
// Just enough of the table directory + cmap to assert coverage. Keeping this
// in-tree rather than leaning on the subsetter means the coverage proof does
// not come from the same library that produced the subset.

function sfntTables(buf) {
  const n = buf.readUInt16BE(4);
  const out = {};
  for (let i = 0; i < n; i++) {
    const p = 12 + i * 16;
    out[buf.toString("latin1", p, p + 4)] = {
      off: buf.readUInt32BE(p + 8),
      len: buf.readUInt32BE(p + 12),
    };
  }
  return out;
}

function cmapCodepoints(buf) {
  const t = sfntTables(buf);
  const out = new Set();
  if (!t.cmap) return out;
  const c = t.cmap.off;
  const n = buf.readUInt16BE(c + 2);
  for (let i = 0; i < n; i++) {
    const sub = c + buf.readUInt32BE(c + 4 + i * 8 + 4);
    const fmt = buf.readUInt16BE(sub);
    if (fmt === 4) {
      const segX2 = buf.readUInt16BE(sub + 6);
      for (let s = 0; s < segX2 / 2; s++) {
        const end = buf.readUInt16BE(sub + 14 + s * 2);
        const start = buf.readUInt16BE(sub + 16 + segX2 + s * 2);
        if (start === 0xffff) continue;
        for (let u = start; u <= end; u++) out.add(u);
      }
    } else if (fmt === 12) {
      const ng = buf.readUInt32BE(sub + 12);
      for (let g = 0; g < ng; g++) {
        const gr = sub + 16 + g * 12;
        const s = buf.readUInt32BE(gr);
        const e = buf.readUInt32BE(gr + 4);
        for (let u = s; u <= e; u++) out.add(u);
      }
    }
  }
  return out;
}

const numGlyphs = (buf) => buf.readUInt16BE(sfntTables(buf).maxp.off + 4);

// -------------------------------------------------------------- css2 face parse

/** Parse the Tizen-UA css2 response into {family, style, weight, url} faces. */
function parseCss2(css) {
  const faces = [];
  for (const block of css.split("@font-face").slice(1)) {
    const family = /font-family:\s*'([^']+)'/.exec(block)?.[1];
    const style = /font-style:\s*([a-z]+)/.exec(block)?.[1];
    const weight = /font-weight:\s*(\d+)/.exec(block)?.[1];
    const url = /src:\s*url\(([^)]+)\)/.exec(block)?.[1];
    if (!family || !style || !weight || !url) {
      throw new Error(`unparseable @font-face block:\n${block.slice(0, 200)}`);
    }
    faces.push({ family, style, weight, url });
  }
  return faces;
}

// --------------------------------------------------------------- icon codepoints

function iconCodepoints(netfinCss) {
  const audited = JSON.parse(fs.readFileSync(ICON_LIST, "utf8"));
  const cps = new Set(
    audited.codepoints.map((u) => parseInt(u.replace(/^U\+/, ""), 16)),
  );
  const auditedCount = cps.size;

  // Re-derive netfin's own escapes from the sheet rather than trusting the
  // constant: if a future upstream adds an icon, the build must notice.
  const found = new Set(
    [...netfinCss.matchAll(/\\([eEfF][0-9a-fA-F]{3})\b/g)].map((m) =>
      parseInt(m[1], 16),
    ),
  );
  const expected = new Set(NETFIN_ICON_CODEPOINTS);
  const added = [...found].filter((c) => !expected.has(c));
  const gone = [...expected].filter((c) => !found.has(c));
  if (added.length || gone.length) {
    throw new Error(
      "netfin.css PUA codepoint set drifted from NETFIN_ICON_CODEPOINTS.\n" +
        `  new in sheet: ${added.map(hex).join(", ") || "(none)"}\n` +
        `  no longer in sheet: ${gone.map(hex).join(", ") || "(none)"}\n` +
        "Update the constant (and re-check nothing else in the sheet moved).",
    );
  }
  for (const c of found) cps.add(c);
  return { cps, auditedCount, netfinCount: found.size };
}

const hex = (c) => "U+" + c.toString(16).toUpperCase();
const toText = (cps) =>
  [...cps].sort((a, b) => a - b).map((c) => String.fromCodePoint(c)).join("");

// ------------------------------------------------------------------------ build

async function build({ checkOnly }) {
  const { subsetFont, wawoff2 } = checkOnly ? {} : await loadSubsetter();
  const log = (...a) => console.log(...a);

  log(`netfin.css  <- ${NETFIN_REPO}@${NETFIN_COMMIT.slice(0, 12)}`);
  const netfinRaw = await fetchPinned(NETFIN_URL, NETFIN_SHA256);
  const netfinCss = netfinRaw.toString("utf8");
  log(`  ${netfinRaw.length} B  sha256 ${NETFIN_SHA256.slice(0, 16)}…  OK`);

  log(`icon font   <- ${MATSYM_URL.split("/").slice(-2).join("/")}`);
  const matsymWoff2 = await fetchPinned(MATSYM_URL, MATSYM_SHA256);
  log(`  ${matsymWoff2.length} B  sha256 ${MATSYM_SHA256.slice(0, 16)}…  OK`);

  log(`css2        <- Tizen 5.0 UA`);
  const css2 = (await fetchBuf(CSS2_URL, TIZEN_UA)).toString("utf8");
  const faces = parseCss2(css2);
  const ttfCount = (css2.match(/\.ttf\)/g) || []).length;
  log(
    `  ${faces.length} faces, ${ttfCount} of them TrueType, ` +
      `${(css2.match(/unicode-range/g) || []).length} unicode-range ` +
      `(Google's UA sniff — the JELA-710 defect)`,
  );
  if (ttfCount !== faces.length) {
    log("  NOTE: upstream no longer serves this UA all-TrueType.");
  }

  if (checkOnly) {
    log("\n--check: all pinned sources match their recorded sha256.");
    return;
  }

  // ---- 1. the icon subset ------------------------------------------------

  const { cps, auditedCount, netfinCount } = iconCodepoints(netfinCss);
  log(
    `\nicon codepoints: ${auditedCount} audited (JELA-825) + ` +
      `${netfinCount} from netfin.css = ${cps.size} union`,
  );

  const matsymTtf = Buffer.from(await wawoff2.decompress(matsymWoff2));
  const upstreamCmap = cmapCodepoints(matsymTtf);
  log(
    `upstream face: ${numGlyphs(matsymTtf)} glyphs, ` +
      `${matsymTtf.length} B decompressed, ${upstreamCmap.size} codepoints`,
  );

  // A requested codepoint upstream does not have cannot be our regression — it
  // does not render from this face today either. Record it, do not fail.
  const absentUpstream = [...cps].filter((c) => !upstreamCmap.has(c)).sort();
  if (absentUpstream.length) {
    log(
      `  ${absentUpstream.length} requested codepoint(s) absent from UPSTREAM ` +
        `(so not a regression; they fall back to Jellyfin's own Material ` +
        `Icons face via --iconPack): ${absentUpstream.map(hex).join(", ")}`,
    );
  }
  const reachable = [...cps].filter((c) => upstreamCmap.has(c)).sort();

  const subsetOpts = {
    variationAxes: MATSYM_AXES,
    noLayoutClosure: true, // mandatory — see header
    noHinting: true,
  };
  const text = toText(cps);
  const matsymOut = await subsetFont(matsymTtf, text, {
    ...subsetOpts,
    targetFormat: "woff2",
  });
  const matsymSfnt = await subsetFont(matsymTtf, text, {
    ...subsetOpts,
    targetFormat: "sfnt",
  });

  // Coverage proof, read out of the emitted font's own cmap.
  const outCmap = cmapCodepoints(matsymSfnt);
  const missing = reachable.filter((c) => !outCmap.has(c));
  if (missing.length) {
    throw new Error(
      `subset dropped ${missing.length} reachable codepoint(s): ` +
        missing.map(hex).join(", "),
    );
  }
  const axesLeft = sfntTables(matsymSfnt).fvar;
  if (axesLeft) throw new Error("subset still carries fvar — not instanced");

  log(
    `icon subset: ${matsymWoff2.length} B -> ${matsymOut.length} B ` +
      `(${(matsymWoff2.length / matsymOut.length).toFixed(0)}x), ` +
      `${numGlyphs(matsymSfnt)} glyphs, ` +
      `${reachable.length}/${reachable.length} reachable codepoints present`,
  );

  const written = [];
  const emit = (name, bytes) => {
    fs.writeFileSync(path.join(FONTS, name), bytes);
    written.push(name);
    return sha256(bytes);
  };
  const matsymSha = emit(MATSYM_OUT, matsymOut);

  // ---- 2. the text faces -------------------------------------------------

  const latin = expand(LATIN_RANGES);
  const latinExt = expand(LATIN_EXT_RANGES);
  const textUnion = new Set([...latin, ...latinExt]);
  log(
    `\ntext faces: subsetting to latin+latin-ext union ` +
      `(${textUnion.size} codepoints), one woff2 per weight`,
  );

  const emitted = [];
  for (const face of faces) {
    const slug = FAMILY_SLUG[face.family];
    if (!slug) throw new Error(`no filename slug for family "${face.family}"`);
    if (face.style !== "normal") {
      throw new Error(`unexpected font-style "${face.style}" for ${face.family}`);
    }
    const name = `${slug}-${face.weight}.woff2`;

    const src = await fetchBuf(face.url, TIZEN_UA);
    const have = cmapCodepoints(src);
    // Subset to what this face actually has in range; asking for codepoints it
    // lacks is not an error, it just yields nothing.
    const want = [...textUnion].filter((c) => have.has(c));
    const out = await subsetFont(src, toText(want), {
      targetFormat: "woff2",
      noHinting: true,
    });
    const sha = emit(name, out);
    emitted.push({
      file: name,
      family: face.family,
      weight: face.weight,
      style: face.style,
      bytes: out.length,
      sha256: sha,
      source: face.url,
      sourceBytes: src.length,
      sourceSha256: sha256(src),
      codepoints: want.length,
    });
    log(
      `  ${name.padEnd(30)} ${String(src.length).padStart(7)} B ${path
        .extname(face.url)
        .slice(1)} -> ${String(out.length).padStart(6)} B woff2 ` +
        `(${want.length} codepoints)`,
    );
  }

  const srcTotal = emitted.reduce((n, f) => n + f.sourceBytes, 0);
  const outTotal = emitted.reduce((n, f) => n + f.bytes, 0);
  log(`  text total: ${srcTotal} B -> ${outTotal} B`);

  // ---- 3. the vendored stylesheet ---------------------------------------

  // url()s stay RELATIVE so they resolve against the sheet's own /shell/fonts/
  // path whatever the document <base href> is (the JELA-818 lesson), and carry
  // ?v=<sha256> to earn ContentAddressed's immutable branch.
  const faceBlocks = emitted
    .map(
      (f) =>
        `@font-face {\n` +
        `  font-family: '${f.family}';\n` +
        `  font-style: ${f.style};\n` +
        `  font-weight: ${f.weight};\n` +
        `  font-display: swap;\n` +
        `  src: url(${f.file}?v=${f.sha256}) format('woff2');\n` +
        `}`,
    )
    .join("\n");

  // No third-party hostname appears anywhere in the SERVED bytes, not even in a
  // comment. That is the JELA-818 lesson applied in the one direction where it
  // is actually available to us: there is no kill switch here that needs the
  // stock URL as a fallback string, so "zero third-party references" can be a
  // literal, greppable property of the artifact instead of an unpassable AC.
  // Full provenance — upstream repo, commit, every source URL and sha256 —
  // lives in fonts-manifest.json, which is docs and is never served.
  const banner =
    `/* JELA-902: vendored NetFin skin — see the "netfin" section of\n` +
    ` * fonts-manifest.json for upstream repo, commit and per-face provenance.\n` +
    ` * Regenerate with scripts/build-netfin-fonts.mjs.\n` +
    ` *\n` +
    ` * Two edits only, both URL rewrites; every other byte is upstream's.\n` +
    ` *\n` +
    ` *   1. the upstream css2 @import is replaced by the @font-face blocks\n` +
    ` *      below — the same faces the Tizen UA is served, subsetted to\n` +
    ` *      latin+latin-ext and recompressed to woff2. Inlining them is what\n` +
    ` *      removes the stylesheet request itself rather than just moving its\n` +
    ` *      origin.\n` +
    ` *   2. the Material Icons Round src is repointed at a static, subsetted\n` +
    ` *      instance of the same upstream face.\n` +
    ` *\n` +
    ` * font-weight: 100 700 is left AS UPSTREAM WROTE IT on that face. It now\n` +
    ` * describes a static instance, which is deliberate: declaring the full\n` +
    ` * range means the UA uses these glyphs as-is for any requested weight\n` +
    ` * instead of synthesising a bolder one — i.e. exactly what M63 already\n` +
    ` * does with the variable original, whose axes it cannot drive.\n` +
    ` */\n`;

  // Anchor on the full @import statement; a miss must throw, never no-op.
  const importRe =
    /@import url\("https:\/\/fonts\.googleapis\.com\/css2\?[^"]*"\);/;
  if (!importRe.test(netfinCss)) {
    throw new Error("css2 @import anchor not found in netfin.css");
  }
  let out = netfinCss.replace(
    importRe,
    `/* JELA-902: upstream css2 @import inlined as local @font-face */\n` +
      faceBlocks,
  );

  const srcRe = new RegExp(
    `url\\(${MATSYM_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`,
  );
  if (!srcRe.test(out)) {
    throw new Error("Material Symbols src anchor not found in netfin.css");
  }
  out = out.replace(srcRe, `url(${MATSYM_OUT}?v=${matsymSha})`);

  out = banner + out;

  // Belt: nothing remote may survive, in a url() or in prose. The test guard
  // asserts this too, but failing here means a bad sheet is never written.
  const remote = [
    ...[...out.matchAll(/url\(\s*['"]?(?:https?:)?\/\/[^)]*/g)].map((m) => m[0]),
    ...THIRD_PARTY_ORIGINS.filter((h) => out.includes(h)),
  ];
  if (remote.length) {
    throw new Error(
      `vendored sheet still has ${remote.length} third-party reference(s):\n` +
        remote.slice(0, 5).join("\n"),
    );
  }
  emit(NETFIN_OUT, Buffer.from(out, "utf8"));
  log(
    `\n${NETFIN_OUT}: ${netfinRaw.length} B upstream -> ${Buffer.byteLength(out)} B vendored`,
  );

  // ---- 4. manifest ------------------------------------------------------

  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  manifest.netfin = {
    _comment:
      "JELA-902 — the NetFin skin and the fonts it pulls, vendored so a cold " +
      "boot makes zero third-party requests. Regenerate with " +
      "scripts/build-netfin-fonts.mjs. The Branding.CustomCss field must " +
      "@import /shell/fonts/netfin.css for any of this to be on the wire.",
    upstream: {
      repo: NETFIN_REPO,
      commit: NETFIN_COMMIT,
      url: NETFIN_URL,
      sha256: NETFIN_SHA256,
      bytes: netfinRaw.length,
    },
    stylesheet: { file: NETFIN_OUT, bytes: Buffer.byteLength(out) },
    icons: {
      file: MATSYM_OUT,
      bytes: matsymOut.length,
      sha256: matsymSha,
      source: MATSYM_URL,
      sourceBytes: matsymWoff2.length,
      sourceSha256: MATSYM_SHA256,
      instancedAxes: MATSYM_AXES,
      glyphs: numGlyphs(matsymSfnt),
      codepointsRequested: cps.size,
      codepointsPresent: reachable.length,
      codepointsAbsentUpstream: absentUpstream.map(hex),
    },
    text: { userAgent: TIZEN_UA, css2: CSS2_URL, faces: emitted },
  };
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");

  log(`\nwrote ${written.length} artifact(s) + fonts-manifest.json to`);
  log(`  ${path.relative(process.cwd(), FONTS)}`);
  // fonts-manifest.json is inside the repo's prettier glob (*.json) and
  // JSON.stringify does not agree with prettier about short arrays, so a regen
  // reddens the format gate unless this is run. The woff2 and .css artifacts are
  // outside the glob and must NOT be reformatted.
  log(`\nNOW RUN: pnpm format   (fonts-manifest.json is in the prettier glob)`);
}

await build({ checkOnly: process.argv.includes("--check") });
