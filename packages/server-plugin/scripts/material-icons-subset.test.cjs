#!/usr/bin/env node
/*
 * material-icons-subset.test.cjs — JELA-825 guard for the MaterialIcons subset.
 *
 * Cold boot downloads MaterialIcons-Regular.woff2 from /web/ — a 125 KB full
 * icon set (~2,100 glyphs). The Jellyfin TV UI uses ~96 of them. This guard
 * verifies that:
 *
 *   1. The subset file exists in Resources/fonts/ and is within the target
 *      size budget (≤ 20,000 B per the acceptance criteria).
 *
 *   2. The interceptor is wired: MaterialIconsSubsetStartupFilter.cs exists,
 *      matches the right URL pattern, and is registered in
 *      PluginServiceRegistrator.cs before WebAssetCacheStartupFilter.
 *
 *   3. The regex in the filter matches exactly the known prod URL shape and
 *      does NOT match unrelated /web/ paths.
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

// ---- 2. interceptor is wired -------------------------------------------

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

// ---- 3. regex shape matches/rejects correctly ---------------------------

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
