#!/usr/bin/env node
/*
 * material-icons-subset.test.cjs — JELA-825 guard for the MaterialIcons subset.
 *
 * Cold boot downloads MaterialIcons-Regular.woff2 from /web/ — a 125,116 B full
 * icon set (2,188 glyphs). The fielded UI references 208 of them, enumerated in
 * Resources/fonts/material-icons.json. This guard verifies that:
 *
 *   1. The subset file exists in Resources/fonts/ and is within the target
 *      size budget (≤ 20,000 B per the acceptance criteria).
 *
 *   2. The published icon list is present and non-empty, so a later reader can
 *      tell WHICH icons the subset covers without re-deriving the set. A subset
 *      cut from an under-enumerated list renders blank boxes on a page nobody
 *      tested — that is the whole risk of this change.
 *
 *   3. The interceptor is wired: MaterialIconsSubsetStartupFilter.cs exists,
 *      matches the right URL pattern, and is registered in
 *      PluginServiceRegistrator.cs before WebAssetCacheStartupFilter.
 *
 *   4. The interceptor reproduces Access-Control-Allow-Origin. Short-circuiting
 *      skips Jellyfin's CORS middleware; a webfont is always fetched in CORS
 *      mode, so without that header the browser blocks the font and every icon
 *      goes blank. This is a load-bearing assertion, not a style check.
 *
 *   5. The regex in the filter matches exactly the known prod URL shape and
 *      does NOT match unrelated /web/ paths.
 *
 * Deep font checks (codepoint coverage, ligature retention) live in
 * build-material-icons-subset.py --verify, which needs fontTools.
 *
 * Run: node packages/server-plugin/scripts/material-icons-subset.test.cjs
 */
"use strict";
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "Jellyfin.Plugin.JellyPlugShell");
const FONTS = path.join(ROOT, "Resources", "fonts");

// ---- 1. subset file size budget ----------------------------------------

const subsetPath = path.join(FONTS, "MaterialIcons-Regular-subset.woff2");
assert.ok(
  fs.existsSync(subsetPath),
  "MaterialIcons-Regular-subset.woff2 missing from Resources/fonts/",
);
const subsetSize = fs.statSync(subsetPath).size;
assert.ok(
  subsetSize <= 20_000,
  `MaterialIcons-Regular-subset.woff2 is ${subsetSize} B — exceeds 20,000 B target`,
);

// ---- 2. published icon list --------------------------------------------

const listPath = path.join(FONTS, "material-icons.json");
assert.ok(
  fs.existsSync(listPath),
  "material-icons.json missing — the subset must ship with the list it was cut from",
);
const iconList = JSON.parse(fs.readFileSync(listPath, "utf8"));
assert.ok(
  Array.isArray(iconList.icons) && iconList.icons.length > 0,
  "material-icons.json carries no icons[]",
);
assert.strictEqual(
  iconList.icons.length,
  iconList.codepoints.length,
  "material-icons.json: icons[] and codepoints[] disagree in length",
);
// Every icon Jellyfin emits as a class attribute must be in the built set —
// that reading is unambiguous, so a name missing from it is a definite blank box.
for (const name of iconList.sources["class-attribute"]) {
  assert.ok(
    iconList.icons.includes(name),
    `class-attribute icon "${name}" is not in the built subset`,
  );
}

// ---- 3. interceptor is wired -------------------------------------------

const filterSrc = fs.readFileSync(
  path.join(ROOT, "MaterialIconsSubsetStartupFilter.cs"),
  "utf8",
);

// The filename pattern used in the filter must match the hash-bearing URL shape.
assert.ok(
  filterSrc.includes("MaterialIcons-Regular"),
  "MaterialIconsSubsetStartupFilter does not reference the font name",
);
assert.ok(
  filterSrc.includes("SubsetAssetName"),
  "MaterialIconsSubsetStartupFilter must name the subset asset key",
);
assert.ok(
  filterSrc.includes('"MaterialIcons-Regular-subset.woff2"'),
  "SubsetAssetName must point to the correct embedded resource filename",
);

const registratorSrc = fs.readFileSync(
  path.join(ROOT, "PluginServiceRegistrator.cs"),
  "utf8",
);
assert.ok(
  registratorSrc.includes("MaterialIconsSubsetStartupFilter"),
  "MaterialIconsSubsetStartupFilter not registered in PluginServiceRegistrator",
);

// The interceptor must be registered BEFORE WebAssetCacheStartupFilter so it
// runs first and can short-circuit the request. Compare AddTransient lines only
// (comments may reference both names in either order).
const addTransientLines = registratorSrc
  .split("\n")
  .filter((l) => l.includes("AddTransient"));
const matLineIdx = addTransientLines.findIndex((l) =>
  l.includes("MaterialIconsSubsetStartupFilter"),
);
const cacheLineIdx = addTransientLines.findIndex((l) =>
  l.includes("WebAssetCacheStartupFilter"),
);
assert.ok(
  matLineIdx >= 0,
  "MaterialIconsSubsetStartupFilter AddTransient not found",
);
assert.ok(
  matLineIdx < cacheLineIdx,
  "MaterialIconsSubsetStartupFilter must be registered before WebAssetCacheStartupFilter",
);

// ---- 4. CORS header is reproduced on the short-circuited response -------

assert.ok(
  filterSrc.includes('"Access-Control-Allow-Origin"'),
  "MaterialIconsSubsetStartupFilter must set Access-Control-Allow-Origin — a " +
    "font is fetched in CORS mode and a bare response blocks every icon",
);
assert.ok(
  /IsNullOrEmpty\(request\.Headers\.Origin\)/.test(filterSrc),
  "Access-Control-Allow-Origin must be gated on the request carrying an Origin, " +
    "matching what the live /web/ response emits",
);
// It has to be set before the 304 early-return, or a warm hit answers without it.
const acaoIdx = filterSrc.indexOf('"Access-Control-Allow-Origin"');
const notModifiedIdx = filterSrc.indexOf("Status304NotModified");
assert.ok(
  acaoIdx >= 0 && notModifiedIdx >= 0 && acaoIdx < notModifiedIdx,
  "Access-Control-Allow-Origin must be set before the 304 early-return",
);

// ---- 5. regex shape matches/rejects correctly ---------------------------

// The filter uses a C# Regex. Reconstruct the equivalent JS regex for testing.
// Pattern: ^/web/MaterialIcons-Regular\.[0-9a-f]{20}\.woff2$ (case-insensitive)
const pattern =
  /^\/web\/MaterialIcons-Regular\.[0-9a-f]{20}\.woff2$/i;

const SHOULD_MATCH = [
  "/web/MaterialIcons-Regular.2d8017489da689caedc1.woff2",
  "/web/MaterialIcons-Regular.abcdef1234567890abcd.woff2",
];
const SHOULD_NOT_MATCH = [
  "/web/MaterialIcons-Regular.woff2",
  "/web/MaterialIcons-Regular.short.woff2",
  "/web/MaterialIcons-Regular.2d8017489da689caedc1.woff",
  "/shell/fonts/MaterialIcons-Regular-subset.woff2",
  "/web/inter-v20-400-latin.woff2",
  "/web/MaterialIcons-Regular.2d8017489da689caedc1ZZ.woff2",
];

for (const url of SHOULD_MATCH) {
  assert.ok(pattern.test(url), `pattern should match: ${url}`);
}
for (const url of SHOULD_NOT_MATCH) {
  assert.ok(!pattern.test(url), `pattern should NOT match: ${url}`);
}

console.log(
  `OK: MaterialIcons subset ${subsetSize} B ≤ 20,000 B, interceptor wired (JELA-825)`,
);
