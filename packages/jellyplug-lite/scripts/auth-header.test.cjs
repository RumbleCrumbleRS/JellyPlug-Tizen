"use strict";
// JELA-899: Jellyfin 12.0 dropped `X-Emby-Token` as an auth transport and
// answers it 401. Re-probed against the live 12.0 server on 2026-09-12, on
// the exact endpoints lite hits (/System/Info, /UserViews, /Shows/NextUp,
// /Users/{u}/Items/Resume, /HomeScreen/Sections, /JellyfinEnhanced/tag-cache):
//
//   Authorization: MediaBrowser Token="..."  -> 200
//   ?ApiKey=                                 -> 200
//   X-Emby-Token:                            -> 401
//
// On the default fleet configuration this is masked: queryAuth is opt-OUT
// since JELA-839, and its JELA-740 shim swallows the auth header and re-adds
// `?ApiKey=`. But the two documented per-TV kill switches
// ('jellyfin.shell.queryAuth'='0', 'jellyfin.shell.queryAuthDisabled'='1')
// disarm that shim, and then whatever lite sets here IS the wire auth.
//
// AC1 wants this pinned by a TEST, not by inspection — the per-call-site
// suites below (api/playbackinfo/reporter/native-flow) each check their own
// header, but only a static sweep can prove a SIXTH site did not appear.
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { loadLite } = require("./lite-testkit.cjs");

const Lite = loadLite();

// --- the single header factory ---------------------------------------------

assert.deepStrictEqual(
  JSON.parse(JSON.stringify(Lite.authHeaders("tok"))),
  { Authorization: 'MediaBrowser Token="tok"' },
  "authHeaders emits a MediaBrowser Authorization header and nothing else",
);

// qaTok (shell.js JELA-740/839) parses the token back out with
// /Token="([^"]*)"/, so the value must stay quoted even when empty.
assert.deepStrictEqual(
  JSON.parse(JSON.stringify(Lite.authHeaders(""))),
  { Authorization: 'MediaBrowser Token=""' },
  "an empty token still produces a shim-parseable quoted value",
);

// --- AC1: no call site anywhere sets the raw header ------------------------

// Scan the source AND the committed dist blob — dist is what actually ships
// to a TV over the JELA-66 byte-cache rail, and a stale dist would hide a
// regression the source no longer has.
const FILES = [
  path.join(__dirname, "..", "src", "lite.src.js"),
  path.join(__dirname, "..", "dist", "lite.min.js"),
];

for (const file of FILES) {
  const name = path.basename(file);
  const text = fs.readFileSync(file, "utf8");

  // Deliberately NOT string-stripped the way es5-guard does it: the thing
  // being banned IS a string literal. Matching only the QUOTED form is what
  // keeps this precise — a header name reaches XHR as a string, so quotes
  // mean "used as a header", while the bare word is just prose. (Comments
  // here and in lite.src.js name the legacy header in backticks so they
  // stay readable without tripping the guard.)
  const hit = /["']X-Emby-Token["']/.exec(text);
  assert.ok(
    !hit,
    `${name} still sets the legacy X-Emby-Token header, which Jellyfin ` +
      `12.0 answers 401: ...${text.slice(
        Math.max(0, (hit ? hit.index : 0) - 60),
        (hit ? hit.index : 0) + 60,
      )}...`,
  );

  assert.ok(
    text.indexOf('MediaBrowser Token="') !== -1,
    `${name} authenticates with a MediaBrowser Authorization header`,
  );
}

// --- the JELA-896 carve-out stays carved out -------------------------------

// /Videos/*/stream* direct-play URLs are handed to the native AVPlay
// pipeline, which cannot set request headers at all — the server still
// honours `api_key=` there and it must NOT be unified onto Authorization.
{
  const src = fs.readFileSync(FILES[0], "utf8");
  assert.ok(
    src.indexOf('"&api_key=" +') !== -1,
    "direct-play stream URLs keep their api_key= query auth (JELA-896)",
  );
}

console.log("auth-header.test.cjs OK");
