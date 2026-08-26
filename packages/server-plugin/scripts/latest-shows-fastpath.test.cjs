#!/usr/bin/env node
/*
 * latest-shows-fastpath.test.cjs — JELA-731 guard for the one-query
 * "Latest Shows" row. Like the sibling .test.cjs files, the C# plugin is not
 * compiled in this repo's node CI, so the wiring is source-pinned.
 *
 * The bug this replaces: Home Screen Sections builds the LatestShows row by
 * walking backwards through time in 30-day windows, one episode query per TV
 * library per window, each with EnableTotalRecordCount=true, until 16 distinct
 * series have accumulated. On production that is 27 windows x 2 libraries =
 * 54 queries and 1,166 ms of server time for 16 titles, and it is the slowest
 * thing on the home path (median 293.7 ms warm vs 60.7 ms for LatestMovies,
 * n=7 interleaved).
 *
 * This middleware answers the same URL from a single ordered episode query per
 * library. Two properties make that safe, and both are pinned below:
 *
 *   A. It is a REPLACEMENT, not a cache. There is no TTL and no stored body —
 *      so it cannot serve a stale row, and JELA-732's caching work layers on
 *      top of it rather than fighting it.
 *
 *   B. Every path it cannot prove equivalent falls through to the real
 *      section. That is what keeps "the fast path is wrong" bounded to "the
 *      fast path is slow": HideWatchedItems unreadable or on, a foreign
 *      UserId, missing services, the kill switch, or any exception at all.
 *
 * Run: node packages/server-plugin/scripts/latest-shows-fastpath.test.cjs
 */
"use strict";
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "Jellyfin.Plugin.JellyPlugShell");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

const core = read("LatestShowsFastPath.cs");
const filter = read("LatestShowsFastPathStartupFilter.cs");
const registrator = read("PluginServiceRegistrator.cs");
const config = read("PluginConfiguration.cs");

// ---- 1. the middleware is actually in the pipeline --------------------------

// RegisterServices runs before Startup.ConfigureServices, so IStartupFilter is
// the only order-independent hook that can reach a route this plugin does not
// own (JELA-709/714/722 landed on the same conclusion). A plain
// AddSingleton/AddTransient of the class alone would compile and never run.
assert.ok(
  /AddTransient<IStartupFilter,\s*LatestShowsFastPathStartupFilter>/.test(
    registrator,
  ),
  "LatestShowsFastPathStartupFilter is not registered as an IStartupFilter",
);
assert.ok(
  /class LatestShowsFastPathStartupFilter\s*:\s*IStartupFilter/.test(filter),
  "LatestShowsFastPathStartupFilter must implement IStartupFilter",
);

// ---- 2. it claims exactly one URL ------------------------------------------

// A prefix match would swallow every other section (LatestMovies,
// ContinueWatchingNextUp, BecauseYouWatched) and answer them all with a TV row.
assert.ok(
  /RequestPath\s*=\s*"\/HomeScreen\/Section\/LatestShows"/.test(filter),
  "the matched path must be the full LatestShows section route",
);
assert.ok(
  /string\.Equals\(request\.Path\.Value,\s*RequestPath,\s*StringComparison\.OrdinalIgnoreCase\)/.test(
    filter,
  ),
  "the path must be matched by full equality, not StartsWith",
);
assert.ok(
  /HttpMethods\.IsGet\(request\.Method\)/.test(filter),
  "only GET may be short-circuited — OPTIONS preflights must reach the CORS middleware",
);

// ---- 3. nothing is written until the whole body exists ----------------------

// The bail-outs in section 4 are only worth anything if they can still bail:
// once a byte is on the wire, falling through to Home Screen Sections would
// produce two concatenated JSON bodies rather than one working row.
const writeIndex = filter.indexOf("Response.Body.WriteAsync");
const buildIndex = filter.indexOf("TrySerializeAsync(context)");
assert.ok(
  writeIndex > 0 && buildIndex > 0,
  "expected a build-then-write shape",
);
assert.ok(
  buildIndex < writeIndex,
  "the body must be fully built before the response is touched",
);
assert.ok(
  /if \(body is null\)\s*\{\s*await nextMiddleware\(\)\.ConfigureAwait\(false\);\s*return;\s*\}/.test(
    filter,
  ),
  "a null body must fall through to the section that owns the route",
);

// ---- 4. every non-equivalent shape defers to upstream -----------------------

// HideWatchedItems flips upstream's query to IsPlayed=false, a per-user filter
// this fast path does not model. `!= false` is load-bearing: the reader returns
// null when Home Screen Sections is absent or its config shape moved, and null
// must be treated exactly like true.
assert.ok(
  /if \(HideWatchedItems\(\) != false\)\s*\{\s*return null;\s*\}/.test(core),
  "HideWatchedItems must bail on true AND on unknown (null), not just on true",
);
assert.ok(
  /internal static bool\? HideWatchedItems\(\)/.test(core),
  "HideWatchedItems must be tri-state so 'unknown' is representable",
);

// Read reflectively and per-request: Home Screen Sections is third-party, ships
// on its own train, and its section settings are edited live from the
// dashboard. A compile-time reference would make this plugin fail to load
// without it; a cached read would miss an operator flipping the setting.
assert.ok(
  /GetType\("Jellyfin\.Plugin\.HomeScreenSections\.HomeScreenSectionsPlugin"\)/.test(
    core,
  ),
  "the HideWatchedItems read must resolve Home Screen Sections reflectively",
);
assert.ok(
  !/PackageReference[^\n]*HomeScreenSections/.test(
    fs.readFileSync(
      path.join(ROOT, "Jellyfin.Plugin.JellyPlugShell.csproj"),
      "utf8",
    ),
  ),
  "no build-time dependency on Home Screen Sections",
);
assert.ok(
  /catch \(Exception\)\s*\{\s*\/\/[^\n]*\n\s*return null;/.test(core) ||
    /catch \(Exception\)\s*\{\s*return null;/.test(core),
  "the reflective read must degrade to 'unknown' rather than throw",
);

// The upstream route is [Authorize] and then trusts the caller's UserId
// verbatim. Reproducing that in new code would be a fresh cross-user read; the
// fast path answers only for the caller's own user (or a server-wide API key)
// and hands everything else back.
assert.ok(
  /!auth\.IsApiKey && \(auth\.User is null \|\| !auth\.User\.Id\.Equals\(userId\)\)/.test(
    filter,
  ),
  "the fast path must only answer for the authenticated user's own row",
);

// One catch around the whole build, returning null: a home row is not worth a
// 500, and the fallback is a working (slow) response.
assert.ok(
  /catch \(Exception\)\s*\{[\s\S]{0,200}?return null;\s*\}/.test(filter),
  "any unexpected exception must fall through instead of failing the request",
);

// ---- 5. the kill switch reaches the middleware ------------------------------

assert.ok(
  /public bool DisableLatestShowsFastPath \{ get; set; \}/.test(config),
  "PluginConfiguration.DisableLatestShowsFastPath missing",
);
assert.ok(
  /Plugin\.Instance\?\.Configuration\.DisableLatestShowsFastPath \?\? false/.test(
    filter,
  ),
  "the kill switch must be read per-request, defaulting to 'fast path on'",
);

// ---- 6. upstream row parity -------------------------------------------------

// The DTO shape LatestShowsSection hands to GetBaseItemDto. The row's cards are
// rendered from these fields, so a divergence here is a visibly different row
// rather than a slow one — the one failure mode the fallbacks cannot catch.
for (const pin of [
  "ItemFields.PrimaryImageAspectRatio",
  "ItemFields.Path",
  "ImageType.Thumb",
  "ImageType.Backdrop",
  "ImageType.Primary",
]) {
  assert.ok(
    core.includes(pin),
    `DTO options must match upstream's: missing ${pin}`,
  );
}
assert.ok(/ImageTypeLimit = 1/.test(core), "upstream sets ImageTypeLimit = 1");
assert.ok(/SeriesLimit = 16/.test(core), "upstream's row is 16 series");

// Upstream's window walk starts at DateTime.Now and so never reaches unaired
// episodes. With no window, both guards have to be explicit.
assert.ok(
  /MaxPremiereDate = now/.test(core),
  "future-dated episodes must be excluded",
);
assert.ok(/episode\.IsUnaired/.test(core), "upstream filters unaired episodes");
assert.ok(
  /OrderBy = new\[\] \{ \(ItemSortBy\.PremiereDate, SortOrder\.Descending\) \}/.test(
    core,
  ),
  "the row is ordered by episode premiere date, as upstream orders it",
);

// The count upstream asks for and discards — one extra pass over the same
// filtered set, per query. Asking for it here would give back the saving.
assert.ok(
  /EnableTotalRecordCount = false/.test(core),
  "EnableTotalRecordCount must stay off — it is half of what makes upstream slow",
);

// ItemIds does not preserve the order it is given, and the order IS the row.
assert.ok(
  /seriesIds\s*\n?\s*\.Where\(byId\.ContainsKey\)/.test(core),
  "the final DTOs must be re-ordered from seriesIds, not taken in query order",
);

// ---- 7. the two headers a short-circuit would otherwise drop -----------------

// Running ahead of the pipeline means the response skips the middleware that
// would have decorated it. The shell's fetches are cross-origin (the page
// origin is file:// on-device), so a missing ACAO is a blank row; and every
// measurement in this programme is quoted in x-response-time-ms.
assert.ok(
  /if \(!string\.IsNullOrEmpty\(context\.Request\.Headers\.Origin\)\)/.test(
    filter,
  ),
  "ACAO must be emitted only when the request carries an Origin, as the live origin does",
);
assert.ok(
  /Headers\["Access-Control-Allow-Origin"\] = "\*"/.test(filter),
  "the live origin answers CORS requests with ACAO: *",
);
assert.ok(
  /Headers\["x-response-time-ms"\]/.test(filter),
  "x-response-time-ms must be reproduced or the fix becomes unmeasurable",
);

// A marker header so verification can tell "fast" from "quietly stepped aside
// onto a warm box" — with medians a few hundred ms apart, timing cannot.
assert.ok(
  /ServedByHeader\s*=\s*"X-JellyPlug-LatestShows"/.test(filter),
  "the fast path must announce itself for acceptance testing",
);

// ---- 8. it is a replacement, not a cache ------------------------------------

// JELA-732 owns caching this endpoint. If this file ever grows a TTL the two
// fixes start disagreeing about freshness, and a "Latest" row that is wrong is
// worse than one that is slow.
assert.ok(
  !/MemoryCache|TimeSpan\.From|_cache|s_cache/.test(core),
  "the fast path must not cache — it recomputes, so it can never serve a stale row",
);

console.log("latest-shows-fastpath.test.cjs: all pins hold");
