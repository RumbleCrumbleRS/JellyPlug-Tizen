#!/usr/bin/env node
/*
 * asset-gzip.test.cjs — JELA-688 guards for the compression layer on the three
 * TV-facing /shell/ JS routes.
 *
 * Scope note: the CACHE policy on these same routes (immutable at a matching
 * ?v=, revalidate otherwise, manifests stay no-cache) is JELA-689's and is
 * guarded by shell-cache.test.cjs. This file only covers what compression
 * adds, so the two do not restate each other.
 *
 * Like the sibling .test.cjs files, the C# plugin is not compiled in this
 * repo's node CI, so the wiring that would only break against a live server is
 * source-pinned. What each check protects:
 *
 *   1. Compression exists at all. Jellyfin runs no response compression over
 *      plugin routes, so if ShellController stops choosing a gzip body the
 *      assets silently go back to 190 KB / 34 KB / 2.0 MB on the wire with no
 *      test failing anywhere.
 *
 *   2. The identity fallback survives. An M63 TV that does not offer gzip must
 *      still get plain JS; this is the boot path where a stranded TV has no
 *      second chance. Pinned: the gzip branch is guarded on an explicit
 *      AcceptsGzip(...) test, the helper still has an unconditional raw-bytes
 *      return, and AcceptsGzip is fail-closed when the header is missing or
 *      unparseable.
 *
 *   3. The compressed body never becomes the source of truth. The manifest
 *      sha256, the ?v= match that earns `immutable`, and every cache-busting
 *      URL are all hashes of the RAW asset, so ShellDropService must keep
 *      hashing the raw bytes.
 *
 *   4. The two representations stay distinguishable to caches — distinct
 *      ETags, and Vary: Accept-Encoding on BOTH responses.
 *
 * Run: node packages/server-plugin/scripts/asset-gzip.test.cjs
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

// ---- 1. gzip bodies exist and every JS route can use them -------------------

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

// Each JS route must hand its own gzip body to the shared helper. A crossover
// (ShellGzipBytes with LiteSha256) would advertise an ETag that does not match
// the body — the same failure shell-cache.test.cjs guards for the raw pairs.
for (const [method, bytes, gzip, sha] of [
  ["GetShell", "ShellBytes", "ShellGzipBytes", "ShellSha256"],
  ["GetLite", "LiteBytes", "LiteGzipBytes", "LiteSha256"],
  ["GetBabel", "BabelBytes", "BabelGzipBytes", "BabelSha256"],
]) {
  assert.ok(
    new RegExp(
      `${method}\\(\\)\\s*=>\\s*ContentAddressed\\(_drop\\.${bytes}, _drop\\.${gzip}, _drop\\.${sha}\\)`,
    ).test(ctrl),
    `${method} must pass its OWN raw body, gzip body and sha to ContentAddressed`,
  );
}

assert.ok(
  /Response\.Headers\.ContentEncoding = "gzip";/.test(ctrl),
  "the helper must set Content-Encoding when it serves the compressed body",
);

// ---- 2. the identity fallback is intact and fail-closed --------------------

assert.ok(
  /if \(gzip != null && AcceptsGzip\(Request\.Headers\.AcceptEncoding\)\)/.test(
    ctrl,
  ),
  "the gzip body must be gated on BOTH its existence and an explicit client opt-in",
);
assert.ok(
  /\}\s*\n\s*return Tagged\(bytes, sha256\);/.test(ctrl),
  "ContentAddressed must still have an unconditional raw-bytes return — M63 TVs must never be handed bytes they cannot inflate",
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

// ---- 3. the sha stays a hash of the RAW asset ------------------------------

for (const [sha, bytes] of [
  ["ShellSha256", "ShellBytes"],
  ["BabelSha256", "BabelBytes"],
  ["LiteSha256", "LiteBytes"],
]) {
  assert.ok(
    new RegExp(`${sha} = Sha256Hex\\(${bytes}\\);`).test(drop),
    `${sha} must hash ${bytes} (the RAW asset) — it is the manifest value, the ?v= match that earns immutable, and the cache-buster, and must not track what went over the wire`,
  );
}

// ---- 4. the two representations stay distinguishable to caches -------------

assert.ok(
  /Response\.Headers\.Vary = HeaderNames\.AcceptEncoding \+ ", " \+ HeaderNames\.Origin;/.test(
    ctrl,
  ),
  "Vary: Accept-Encoding must be set unconditionally — including on the uncompressed response — or an intermediary can hand a cached gzip body to an identity client",
);

// JELA-687: Origin must be in Vary too. M63 does not partition its HTTP cache
// by request mode, so a no-cors <script src> entry gets reused for a later CORS
// fetch() of the same url and that entry carries no CORS approval — the fetch
// fails despite this route always sending `*`. Both shells do exactly that
// sequence on shell.min.js (script tag cold, fetch warm). Varying on Origin
// splits the two request modes into separate cache slots. Without it the
// immutable branch pins the failure for a year instead of the ~60 s the old
// blanket TTL used to clear it in (measured against production on the rig).
assert.ok(
  /HeaderNames\.Origin/.test(ctrl),
  "Vary must include Origin — otherwise M63 hands a no-cors <script> cache entry to a CORS fetch() of the same ?v= url and the fetch fails permanently under immutable",
);
assert.ok(
  /Tagged\(gzip, sha256 \+ "-gzip"\)/.test(ctrl),
  "the compressed representation needs its own ETag, distinct from the identity one — an entity tag identifies a representation, not a resource",
);
assert.ok(
  /entityTag: new EntityTagHeaderValue\("\\"" \+ tag \+ "\\""\)/.test(ctrl),
  "Tagged must pass the entity tag through the 5-arg File overload — the 3-arg call binds to `bool enableRangeProcessing` and silently drops the tag",
);

console.log("OK: /shell/ asset gzip (JELA-688)");
