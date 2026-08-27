#!/usr/bin/env node
/*
 * hss-section-cache.test.cjs — JELA-732 guards for the private cache over
 * /HomeScreen/Section/{name}, the Home Screen Sections plugin's row-CONTENTS
 * endpoint (no Cache-Control, no ETag, 1.4-2.2 s of query CPU per home load).
 *
 * Scope: this file guards the CACHE over the row contents. The sibling
 * section-LIST endpoint (/HomeScreen/Sections) is JELA-693/JELA-703 territory
 * and must stay untouched — check 1 below is what keeps those two apart.
 *
 * Like the sibling .test.cjs files, the C# plugin is not compiled in this
 * repo's node CI, so the wiring that would only break against a live server is
 * source-pinned. The behavioural proof is a scratch Kestrel host that runs the
 * real filter over real HTTP (48/48; JELA-732 issue thread) — it needs a
 * dotnet SDK and a JEL-141-barred harness, so it does not live here. What each
 * check protects is a specific way this can silently stop working, and every
 * one of them is a defect that actually shipped once in this exact plugin
 * (JELA-693's post-mortem) or in ours (JELA-688's missing Vary):
 *
 *   1. It caches the row CONTENTS, not the section LIST.
 *   2. Entries are keyed by CREDENTIAL. JELA-693 defect 4: the upstream
 *      sections cache is keyed by hash alone and never compares userId, so a
 *      non-credentialled key is how users cross-contaminate.
 *   3. The ETag is a hash of the BODY. JELA-693's root cause was a key
 *      (Guid.NewGuid()) that could never match, i.e. a cache that was never
 *      read. A timestamp or a counter would fail the same way.
 *   4. no-store is never shipped next to the ETag — it makes the ETag inert.
 *   5. The store is bounded and entries expire. JELA-693 defect 3: an
 *      unbounded dictionary whose LastAccessed was written and never read.
 *   6. Only a 200 JSON body is stored, so an outage cannot be memoized.
 *   7. A hit replays the CORS headers and its own x-response-time-ms. The
 *      filter is OUTSIDE Jellyfin's CORS and response-time middleware, so a
 *      hit that dropped these would break cross-origin fetches on the TV and
 *      erase every hit from the x-response-time-ms census.
 *   8. The buffering swap is restored in a finally, and the store + filter are
 *      actually registered (a singleton store; a transient IStartupFilter).
 *
 * Run: node packages/server-plugin/scripts/hss-section-cache.test.cjs
 */
"use strict";
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "Jellyfin.Plugin.JellyPlugShell");
const filter = fs.readFileSync(
  path.join(ROOT, "HomeScreenSectionCacheStartupFilter.cs"),
  "utf8",
);
const store = fs.readFileSync(
  path.join(ROOT, "HomeScreenSectionCache.cs"),
  "utf8",
);
const cfg = fs.readFileSync(path.join(ROOT, "PluginConfiguration.cs"), "utf8");
const reg = fs.readFileSync(
  path.join(ROOT, "PluginServiceRegistrator.cs"),
  "utf8",
);

// ---- 1. row CONTENTS only, never the section LIST ---------------------------

assert.ok(
  /SectionPathPrefix\s*=\s*"\/HomeScreen\/Section\/"/.test(filter),
  'the route prefix must keep its trailing slash — "/HomeScreen/Section" also ' +
    "matches /HomeScreen/Sections, the JELA-693/703 endpoint, which is not ours to cache",
);
assert.ok(
  /StartsWith\(SectionPathPrefix, StringComparison\.OrdinalIgnoreCase\)/.test(
    filter,
  ),
  "path match must be case-insensitive (clients differ on casing)",
);
assert.ok(
  /HttpMethods\.IsGet\(request\.Method\)/.test(filter),
  "only GET is cacheable — a POST to this route must never be answered from a store",
);

// ---- 2. per-credential keying ------------------------------------------------

assert.ok(
  /BuildKey\(\s*string method,\s*string path,\s*string query,\s*string credential,\s*string\? origin\s*\)/.test(
    store.replace(/\s+/g, " ").replace(/ /g, " "),
  ) ||
    /BuildKey\(string method, string path, string query, string credential, string\? origin\)/.test(
      store,
    ),
  "the cache key must cover method + path + query + credential + origin",
);
assert.ok(
  /if \(credential == null\)\s*\{\s*await nextMiddleware\(\);\s*return;\s*\}/.test(
    filter,
  ),
  "no credential must mean no cache participation at all — an anonymous request " +
    "must never be answered from, or stored into, a per-user cache",
);
for (const header of [
  "X-Emby-Token",
  "X-MediaBrowser-Token",
  "Authorization",
]) {
  assert.ok(
    filter.includes(`"${header}"`),
    `credential extraction must cover ${header} — a shape it misses is a shape that never caches`,
  );
}
assert.ok(
  /AppendPart\(sb, [a-z]/.test(store) &&
    /sb\.Append\(value\.Length\)\.Append\(':'\)/.test(store),
  "key parts must be length-prefixed so two different tuples cannot flatten to one key",
);
assert.ok(
  /SHA256\.HashData/.test(store),
  "the key must be hashed — the raw API token must not sit in a dictionary key",
);

// ---- 3. the ETag is a body hash ---------------------------------------------

assert.ok(
  /public static string ComputeETag\(byte\[\] body\)[\s\S]{0,240}SHA256\.HashData\(body\)/.test(
    store,
  ),
  "ComputeETag must hash the BODY BYTES (JELA-693: a key that cannot match is a cache that is never read)",
);
// Comments cite JELA-693's Guid.NewGuid() by name; only the CODE is pinned.
const storeCode = store.replace(/^\s*\/\/\/?.*$/gm, "");
assert.ok(
  !/Guid\.NewGuid|DateTime\.(Now|UtcNow)\.Ticks/.test(storeCode),
  "no Guid and no timestamp may enter the ETag/key path — that is JELA-693's exact root cause",
);
assert.ok(
  /ComputeETag\(body\)/.test(filter) && /Headers\["ETag"\] = etag/.test(filter),
  "the miss path must stamp the computed ETag on the response",
);
assert.ok(
  /ETagMatches\([\s\S]{0,120}StatusCodes\.Status304NotModified/.test(filter),
  "If-None-Match must be honoured with a 304 — otherwise the ETag buys nothing",
);

// ---- 4. never no-store next to the ETag -------------------------------------

assert.ok(
  /headers\["Cache-Control"\] = "private, max-age=" \+ maxAge/.test(filter),
  "the client directive must be private + max-age (private: it is one user's rows)",
);
assert.ok(
  !/Cache-Control"\] = "[^"]*no-store/.test(filter),
  "no-store must never be emitted here — it makes the ETag inert (JELA-693)",
);
assert.ok(
  /HomeScreenSectionCacheServerOnly[\s\S]{0,300}"private, no-cache"/.test(
    filter,
  ),
  "the server-only half-kill must still allow revalidation (no-cache), not forbid storage",
);

// ---- 5. bounded store, entries expire ---------------------------------------

assert.ok(
  /public const int MaxEntries = \d+;/.test(store),
  "the store must declare a hard entry cap (JELA-693 defect 3: unbounded growth)",
);
assert.ok(
  /_entries\.TryRemove/.test(store),
  "the store must actually remove entries — upstream's has no TryRemove anywhere",
);
assert.ok(
  /while \(_entries\.Count >= MaxEntries\)/.test(store),
  "the cap must be enforced on insert, not merely declared",
);
assert.ok(
  /if \(entry\.ExpiresUtc <= nowUtc\)\s*\{\s*_entries\.TryRemove\(key, out _\);\s*return null;/.test(
    store,
  ),
  "TryGet must drop an expired entry rather than serve it — the TTL is the only " +
    "freshness guarantee ContinueWatchingNextUp (resume position) gets",
);
assert.ok(
  /public int HomeScreenSectionCacheSeconds \{ get; set; \} = 30;/.test(cfg),
  "TTL defaults to 30 s: the ceiling that needs no watched-invalidation hook",
);
assert.ok(
  /public bool DisableHomeScreenSectionCache \{ get; set; \}/.test(cfg) &&
    /public bool HomeScreenSectionCacheServerOnly \{ get; set; \}/.test(cfg),
  "both operator switches must exist",
);
assert.ok(
  /var config = Plugin\.Instance\?\.Configuration \?\? new PluginConfiguration\(\);/.test(
    filter,
  ) &&
    /config\.DisableHomeScreenSectionCache \|\| ttlSeconds <= 0/.test(filter),
  "the switches must be read PER REQUEST (a kill switch that needs a restart is not a kill switch), " +
    "and TTL 0 must disable the cache too",
);

// ---- 6. only a 200 JSON body is stored --------------------------------------

assert.ok(
  /response\.StatusCode != StatusCodes\.Status200OK\s*\)\s*return false;/.test(
    filter,
  ),
  "a non-200 must never be stored — an outage would otherwise be memoized for a whole TTL",
);
assert.ok(
  /contentType\.Contains\("json", StringComparison\.OrdinalIgnoreCase\)/.test(
    filter,
  ),
  "only JSON bodies are stored",
);
assert.ok(
  /ContainsKey\("Set-Cookie"\)/.test(filter),
  "a response carrying Set-Cookie must never be memoized",
);
assert.ok(
  /ContentEncoding\.ToString\(\)/.test(filter),
  "an already-encoded body must not be stored — compression runs outside this filter, " +
    "so the store must hold identity bytes or a hit will serve gzip to a client that did not ask",
);
assert.ok(
  /body\.Length <= HomeScreenSectionCache\.MaxBodyBytes/.test(filter),
  "oversized bodies are served through, never stored",
);

// ---- 7. a hit reproduces what the short-circuit skipped ----------------------

// JELA-794: the previous version of this block asserted only that ACAO was
// read somewhere on the miss path and replayed on the hit. Both were true, and
// the behaviour was still broken in production for the whole life of this
// filter: the read happened after next() returned, where ASP.NET Core's CORS
// middleware has not yet run its OnStarting callback, so it captured null every
// time. Source pins cannot see that; these now pin WHERE the capture happens,
// which is the part that was wrong. The behavioural proof is a throwaway
// ASP.NET host replicating the real nesting (compression filter outermost ->
// this filter -> UseCors -> endpoint), asserting the header set on an actual
// cache hit — see docs/homescreen-section-cache.md.
for (const [field, header] of [
  ["AllowOrigin", "Access-Control-Allow-Origin"],
  ["AllowCredentials", "Access-Control-Allow-Credentials"],
  ["ExposeHeaders", "Access-Control-Expose-Headers"],
]) {
  assert.ok(
    filter.includes(`HeaderOrNull(response, "${header}")`),
    `${header} must be captured into the entry`,
  );
  assert.ok(
    filter.includes(`headers["${header}"] = entry.${field}`),
    `${header} must be REPLAYED on the hit — this filter runs OUTSIDE Jellyfin's CORS ` +
      "middleware, so a hit that drops it turns a working cross-origin fetch on the TV " +
      "into a CORS failure, and only on the second load",
  );
}

{
  // Scoped to ServeAndMaybeStoreAsync — the early bypasses at the top of the
  // middleware also call nextMiddleware(), and they are not what this pins.
  const bodyStart = filter.indexOf("private async Task ServeAndMaybeStoreAsync");
  assert.ok(bodyStart !== -1, "ServeAndMaybeStoreAsync must still exist");
  const store_ = filter.slice(bodyStart);
  const onStarting = store_.indexOf("response.OnStarting(");
  const nextCall = store_.indexOf("await nextMiddleware();");
  const store = store_.indexOf("_cache.Store(");
  assert.ok(
    onStarting !== -1 && nextCall !== -1 && onStarting < nextCall,
    "the CORS capture must sit in an OnStarting callback REGISTERED BEFORE nextMiddleware() " +
      "runs. ASP.NET Core's CORS middleware stamps Access-Control-* from its own OnStarting " +
      "callback, and this filter (plus the compression filter outside it) buffers the body, " +
      "so the response has not started when next() returns and a header read there sees " +
      "nothing. OnStarting callbacks fire in reverse registration order, so registering " +
      "first means running last — after CORS. This is the JELA-794 bug verbatim.",
  );
  assert.ok(
    store > onStarting && store < nextCall,
    "the Store call must live inside that same OnStarting callback — storing earlier is what " +
      "captured a null ACAO into every entry",
  );
}

assert.ok(
  /allowOrigin == null && !string\.IsNullOrEmpty\(context\.Request\.Headers\.Origin/.test(
    filter,
  ),
  "fail-safe: a cross-origin request whose ACAO could not be captured must NOT be stored. " +
    "A miss costs a rebuild; a hit that replays no ACAO is a dead home row on every TV, " +
    "because the shell runs at file:// and every section request it makes is cross-origin. " +
    "This keeps correctness independent of the OnStarting ordering argument above.",
);
assert.ok(
  /headers\["x-response-time-ms"\] = stopwatch\.Elapsed/.test(filter),
  "a hit must emit its own x-response-time-ms — Jellyfin's writer is inside this filter " +
    "and never runs on a short-circuit, so hits would vanish from every timing census",
);
assert.ok(
  /Vary/.test(filter) && /EnsureVaryOrigin/.test(filter),
  "a cacheable body must Vary: Origin (JELA-688 shipped this bug once)",
);
assert.ok(
  !/Access-Control-Allow-Origin"\]\.ToString\(\)\)\)\s*\n\s*return;/.test(filter),
  "EnsureVaryOrigin must NOT be gated on ACAO being present. M63 does not partition its " +
    "HTTP cache by request mode (JELA-687), so the dangerous direction is the one that gate " +
    "missed: an entry stored for a request that sent no Origin carries no CORS headers and " +
    "gets replayed into a later cross-origin fetch, which then fails for a body the server " +
    "would have allowed. Vary: Origin is unconditional (JELA-794).",
);
assert.ok(
  /headers\[CacheStatusHeader\] = "hit"/.test(filter) &&
    /Headers\[CacheStatusHeader\] = "miss"/.test(filter),
  "hit/miss must be observable from the wire, or nobody can prove the cache engaged",
);

// ---- 8. buffering + registration --------------------------------------------

assert.ok(
  /finally\s*\{\s*if \(originalBodyFeature != null\)\s*context\.Features\.Set\(originalBodyFeature\);/.test(
    filter,
  ),
  "the response-body swap must be restored in a finally — an exception downstream would " +
    "otherwise strand the whole pipeline on a MemoryStream",
);
assert.ok(
  /if \(!response\.HasStarted && IsStorable\(response, body\)\)/.test(filter),
  "headers are only mutated while the response has not started",
);
assert.ok(
  /AddSingleton<HomeScreenSectionCache>\(\)/.test(reg),
  "the store must be a SINGLETON or it is discarded between requests — a cache that " +
    "never survives the request is exactly JELA-693's never-read cache in a new costume",
);
assert.ok(
  /AddTransient<IStartupFilter, HomeScreenSectionCacheStartupFilter>\(\)/.test(
    reg,
  ),
  "the filter must be registered as an IStartupFilter (the only order-independent plugin hook, JELA-709)",
);

console.log("hss-section-cache.test.cjs: all checks passed");
