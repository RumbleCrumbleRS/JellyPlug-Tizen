#!/usr/bin/env node
/*
 * asset-headers.test.cjs — JELA-688 (gzip) + JELA-689 (cache policy) guards
 * for the three TV-facing /shell/ JS routes.
 *
 * Like the sibling .test.cjs files, the C# plugin is not compiled in this
 * repo's node CI, so the wiring that would only break against a live server is
 * source-pinned here. What each check protects:
 *
 *   1. Compression exists at all. Jellyfin runs no response compression over
 *      plugin routes, so if ShellController stops choosing a gzip body the
 *      assets silently go back to 190 KB / 34 KB / 2.0 MB on the wire with no
 *      test failing anywhere. Pinned: the gzip bodies exist on the drop
 *      service, and every JS route goes out through the single JsAsset helper
 *      that can pick them.
 *
 *   2. The identity fallback survives. An M63 TV that does not offer gzip must
 *      still get inflatable-free plain JS; this is the boot path where a
 *      stranded TV has no second chance. Pinned: the gzip branch is guarded on
 *      an explicit AcceptsGzip(...) test and the method still has a raw-bytes
 *      return, and AcceptsGzip is fail-closed (returns false when the header
 *      is missing or unparseable).
 *
 *   3. The compressed body never becomes the source of truth. The manifest
 *      sha256 and every ?v=<sha> URL are hashes of the RAW asset, so
 *      ShellDropService must keep hashing the raw bytes.
 *
 *   4. Cache policy per route. shell.min.js and lite.min.js are only ever
 *      fetched at content-addressed URLs (?v=<sha> / ?t=<now>), so they get
 *      `immutable`. babel.min.js is fetched at a BARE URL by both shells, so
 *      marking it immutable would pin a TV to a stale Babel forever — it must
 *      keep a revalidating policy. This is the check most likely to catch a
 *      well-meaning future "make them all immutable" edit.
 *
 *   5. The manifests stay no-cache. manifest.json / tx-manifest.json are the
 *      indirection that lets a TV discover a new sha at all; caching them
 *      would pin the fleet to a stale shell, which is far worse than the
 *      re-download JELA-689 fixed.
 *
 * Run: node packages/server-plugin/scripts/asset-headers.test.cjs
 */
"use strict";
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "Jellyfin.Plugin.JellyPlugShell");
const ctrl = fs.readFileSync(
  path.join(ROOT, "Controllers", "ShellController.cs"),
  "utf8",
);
const drop = fs.readFileSync(path.join(ROOT, "ShellDropService.cs"), "utf8");

// The bare-URL fetch that makes babel.min.js un-immutable. If a future change
// ever version-pins these, this test should be revisited, not deleted.
const SHELL_SRC = path.join(
  __dirname,
  "..",
  "..",
  "shell-tizen",
  "src",
  "shell.js",
);
const BOOT_SHELL_SRC = path.join(
  __dirname,
  "..",
  "..",
  "shell-tizen-bootstrap",
  "src",
  "boot-shell.src.js",
);

// ---- 1. gzip bodies exist and every JS route can use them --------------------

for (const asset of ["Shell", "Babel", "Lite"]) {
  assert.ok(
    new RegExp(`public byte\\[\\]\\?\\s+${asset}GzipBytes`).test(drop),
    `ShellDropService.${asset}GzipBytes missing — /shell/ would serve raw bytes again`,
  );
}

assert.ok(
  /CompressionLevel\.SmallestSize/.test(drop),
  "gzip must be built at the maximum level: it runs once per asset per server lifetime, so only wire size matters",
);
assert.ok(
  /ms\.Length < raw\.Length \? ms\.ToArray\(\) : null/.test(drop),
  "Gzip must return null when compression does not pay — a TV must never be handed MORE bytes than the raw body",
);
assert.ok(
  /LazyThreadSafetyMode\.ExecutionAndPublication/.test(drop),
  "gzip bodies must be Lazy: this is a DI singleton built on the FIRST /shell/ request, and compressing 2 MB of babel eagerly would sit on the boot critical path",
);

// Each JS route must delegate to the one helper. A route that hand-rolls its
// own File(...) again is exactly how the raw-bytes regression comes back.
const cachePolicy = {}; // route method -> the cache-control constant it passes
for (const [method, bytes, gzip, sha] of [
  ["GetShell", "ShellBytes", "ShellGzipBytes", "ShellSha256"],
  ["GetLite", "LiteBytes", "LiteGzipBytes", "LiteSha256"],
  ["GetBabel", "BabelBytes", "BabelGzipBytes", "BabelSha256"],
]) {
  const re = new RegExp(
    `${method}\\(\\)\\s*=>\\s*JsAsset\\(_drop\\.${bytes}, _drop\\.${gzip}, _drop\\.${sha}, (\\w+)\\)`,
  );
  const m = re.exec(ctrl);
  assert.ok(
    m,
    `${method} must serve through JsAsset(raw, gzip, sha, cacheControl)`,
  );
  cachePolicy[method] = m[1]; // checked in section 4
}

assert.ok(
  /Response\.Headers\.ContentEncoding = "gzip";/.test(ctrl),
  "JsAsset must set Content-Encoding when it serves the compressed body",
);
assert.ok(
  /Response\.Headers\.Vary = HeaderNames\.AcceptEncoding;/.test(ctrl),
  "Vary: Accept-Encoding must be set unconditionally — including on the uncompressed response — or an intermediary can hand a cached gzip body to an identity client",
);

// ---- 2. the identity fallback is intact and fail-closed ---------------------

assert.ok(
  /if \(gzip != null && AcceptsGzip\(Request\.Headers\.AcceptEncoding\)\)/.test(
    ctrl,
  ),
  "the gzip body must be gated on BOTH its existence and an explicit client opt-in",
);
assert.ok(
  /\}\s*\n\s*return Tagged\(raw, sha256\);/.test(ctrl),
  "JsAsset must still have an unconditional raw-bytes return — M63 TVs must never be handed bytes they cannot inflate",
);

const accepts = /private static bool AcceptsGzip\([\s\S]*?\n    \}/.exec(ctrl);
assert.ok(accepts, "AcceptsGzip not found");
assert.ok(
  /StringValues\.IsNullOrEmpty\(acceptEncoding\)[\s\S]*?return false;/.test(
    accepts[0],
  ),
  "AcceptsGzip must fail closed on a missing Accept-Encoding",
);
assert.ok(
  /TryParseList\(acceptEncoding, out var encodings\)[\s\S]*?return false;/.test(
    accepts[0],
  ),
  "AcceptsGzip must fail closed on an unparseable Accept-Encoding",
);
assert.ok(
  /return gzip \?\? wildcard;/.test(accepts[0]),
  "an explicit gzip;q=0 must beat a '*' wildcard (RFC 9110 12.5.3) — the client is refusing, not shrugging",
);

// ---- 3. the sha stays a hash of the RAW asset -------------------------------

for (const [sha, bytes] of [
  ["ShellSha256", "ShellBytes"],
  ["BabelSha256", "BabelBytes"],
  ["LiteSha256", "LiteBytes"],
]) {
  assert.ok(
    new RegExp(`${sha} = Sha256Hex\\(${bytes}\\);`).test(drop),
    `${sha} must hash ${bytes} (the RAW asset) — it is the manifest value and the ?v= cache-buster, and must not track what went over the wire`,
  );
}

// ---- 4. per-route cache policy ----------------------------------------------

assert.ok(
  /ImmutableCacheControl = "public, max-age=31536000, immutable";/.test(ctrl),
  "content-addressed assets must be immutable with a maximal TTL",
);
assert.strictEqual(
  cachePolicy.GetShell,
  "ImmutableCacheControl",
  "shell.min.js is only ever fetched at ?v=<sha> / ?t=<now> — it should be immutable",
);
assert.strictEqual(
  cachePolicy.GetLite,
  "ImmutableCacheControl",
  "lite.min.js is only ever fetched at ?v=<liteSha> — it should be immutable",
);

// The load-bearing one. babel.min.js is fetched at a bare URL, so `immutable`
// would make a plugin update unreachable on any TV that already cached it.
assert.strictEqual(
  cachePolicy.GetBabel,
  "RevalidateCacheControl",
  "babel.min.js is fetched at a BARE URL — marking it immutable would pin TVs to a stale Babel forever",
);
const revalidate = /RevalidateCacheControl = "([^"]+)";/.exec(ctrl);
assert.ok(revalidate, "RevalidateCacheControl constant missing");
assert.ok(
  !/immutable/.test(revalidate[1]) && /must-revalidate/.test(revalidate[1]),
  `babel's policy must stay revalidating, got '${revalidate[1]}'`,
);

for (const [file, label] of [
  [SHELL_SRC, "shell.js"],
  [BOOT_SHELL_SRC, "boot-shell.src.js"],
]) {
  const src = fs.readFileSync(file, "utf8");
  assert.ok(
    src.includes('"/shell/babel.min.js"'),
    `${label} no longer fetches /shell/babel.min.js at a bare URL — if it is now version-pinned, revisit the babel cache policy above`,
  );
}

// ETags make the revalidation a ~200-byte 304 instead of a re-download, and
// must differ per representation (an entity tag identifies a representation,
// not a resource).
assert.ok(
  /Tagged\(gzip, sha256 \+ "-gzip"\)/.test(ctrl),
  "the compressed representation needs its own ETag, distinct from the identity one",
);
assert.ok(
  /entityTag: new EntityTagHeaderValue\("\\"" \+ tag \+ "\\""\)/.test(ctrl),
  "Tagged must pass the entity tag through the 5-arg File overload — the 3-arg call binds to `bool enableRangeProcessing` and silently drops the tag",
);

// ---- 5. the manifests stay uncacheable --------------------------------------

for (const route of ["manifest.json", "tx-manifest.json"]) {
  const body = new RegExp(
    `HttpGet\\("${route.replace(".", "\\.")}"\\)[\\s\\S]*?\\n    \\}`,
  ).exec(ctrl);
  assert.ok(body, `${route} route not found`);
  assert.ok(
    /Response\.Headers\.CacheControl = "no-cache";/.test(body[0]),
    `${route} must stay no-cache — it is how a TV discovers a new sha; caching it would pin the fleet to a stale shell`,
  );
  assert.ok(
    !/immutable|max-age=\d/.test(body[0]),
    `${route} must not acquire a positive TTL`,
  );
}

console.log(
  "OK: /shell/ asset headers (JELA-688 gzip + JELA-689 cache policy)",
);
