#!/usr/bin/env node
/*
 * shell-cache.test.cjs — JELA-689 guard for the /shell/ cache policy. Like the
 * sibling .test.cjs files, the C# plugin is not compiled in this repo's node
 * CI, so the wiring is source-pinned.
 *
 * The bug this locks down: the three /shell/*.js bodies were served
 * `max-age=60, must-revalidate` with NO ETag, while the TV requests them at
 * content-addressed urls (`shell.min.js?v=<sha256>` from the manifest). Every
 * real boot is more than 60 s after the last, so every boot had to revalidate,
 * and with no ETag the only possible answer was a full ~190 KB re-download of
 * bytes the TV already held.
 *
 * The fix is deliberately CONDITIONAL, and the conditions are the interesting
 * part of this file:
 *
 *   1. `?v=<CURRENT sha>` earns `immutable` + a year — same treatment
 *      tx/{hash}.js already gets, for the same reason.
 *
 *   2. Everything else keeps the short TTL. That branch is load-bearing:
 *      babel.min.js is fetched at a BARE url by BOTH shells, and fielded WGTs
 *      hardcode their fetches and can never be updated — pinning a bare url
 *      for a year would strand the fleet on a stale transpiler. Section 3
 *      below pins that premise against the shell sources, so if someone ever
 *      teaches the shells to address babel by sha, this test tells them the
 *      short-TTL branch can be revisited (rather than silently going stale).
 *
 *   3. The ETag is unconditional, so the short-TTL branch costs a 304 rather
 *      than a re-download.
 *
 *   4. The manifests stay `no-cache`. They are the indirection that lets a TV
 *      discover a new sha; caching them pins the fleet to a stale shell, which
 *      is far worse than the bug being fixed here.
 *
 * Run: node packages/server-plugin/scripts/shell-cache.test.cjs
 */
"use strict";
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const REPO = path.join(__dirname, "..", "..", "..");
const ctrl = fs.readFileSync(
  path.join(
    __dirname,
    "..",
    "Jellyfin.Plugin.JellyPlugShell",
    "Controllers",
    "ShellController.cs",
  ),
  "utf8",
);

const IMMUTABLE = '"public, max-age=31536000, immutable"';
const REVALIDATE = '"public, max-age=60, must-revalidate"';

// ---- 1. the three JS routes go through the shared policy helper -------------

// Each route must hand ContentAddressed the sha of the SAME asset it serves —
// a copy/paste crossover (ShellBytes with LiteSha256) would advertise a
// year-long immutable ETag that does not match the body, which is the one
// failure mode a caching bug can turn into a permanently broken TV.
for (const [route, bytes, sha] of [
  ["GetShell", "ShellBytes", "ShellSha256"],
  ["GetLite", "LiteBytes", "LiteSha256"],
  ["GetBabel", "BabelBytes", "BabelSha256"],
]) {
  assert.ok(
    ctrl.includes(
      `public IActionResult ${route}() => ContentAddressed(_drop.${bytes}, _drop.${sha});`,
    ),
    `${route} must serve _drop.${bytes} under _drop.${sha} via ContentAddressed`,
  );
}

// No route may hand-roll a TTL and bypass the helper: every CacheControl
// assignment in the file must be one of the four sanctioned policies.
const assigned = [...ctrl.matchAll(/Response\.Headers\.CacheControl\s*=\s*([^;]+);/g)].map(
  (m) => m[1].replace(/\s+/g, " ").trim(),
);
const SANCTIONED = new Set([
  `addressed ? ${IMMUTABLE} : ${REVALIDATE}`, // the helper
  IMMUTABLE, // tx/{hash}.js
  '"no-cache"', // both manifests
  '"no-store"', // diag + the operator-only routes
]);
for (const value of assigned) {
  assert.ok(
    SANCTIONED.has(value),
    `unsanctioned cache policy \`${value}\` — route it through ContentAddressed`,
  );
}
assert.strictEqual(
  assigned.filter((v) => v.includes("max-age")).length,
  2,
  "only two max-age sites expected: the ContentAddressed helper + tx/{hash}.js",
);

// ---- 2. the helper's two branches -------------------------------------------

const helper = /private IActionResult ContentAddressed\([\s\S]*?\n    \}/.exec(ctrl);
assert.ok(helper, "ContentAddressed helper not found");
const body = helper[0];

// The immutable branch is gated on the request actually carrying the CURRENT
// sha. Anything looser (e.g. "?v= is present") would pin a STALE ?v= url — and
// a wrong immutable is a year-long mistake, not a one-boot one.
assert.ok(
  /var addressed = string\.Equals\(Request\.Query\["v"\]\.ToString\(\), sha256, StringComparison\.Ordinal\);/.test(
    body,
  ),
  "immutable must be gated on ?v= equalling THIS asset's sha256, exactly",
);
assert.ok(
  new RegExp(`addressed\\s*\\n?\\s*\\?\\s*${escapeRe(IMMUTABLE)}\\s*\\n?\\s*:\\s*${escapeRe(REVALIDATE)}`).test(
    body,
  ),
  "addressed => immutable, otherwise => the short revalidating TTL (not the reverse)",
);

// ---- 3. ETag: passed to File(), not hand-set ---------------------------------

// Setting Response.Headers.ETag would emit the header but MVC would NOT honour
// If-None-Match, so the revalidation would still cost a full body — i.e. the
// header would look fixed while the bug stayed. Runtime-verified 2026-08-23:
// bare url + If-None-Match => 304, wrong etag => 200 + body.
assert.ok(
  /entityTag: new EntityTagHeaderValue\("\\""\s*\+\s*sha256\s*\+\s*"\\""\)/.test(body),
  "the sha must be passed as File(..., entityTag:) — that is what makes MVC answer 304",
);
assert.ok(
  !/Response\.Headers\.ETag/.test(ctrl),
  "a hand-set ETag header does not enable MVC's If-None-Match handling",
);
assert.ok(
  ctrl.includes("using Microsoft.Net.Http.Headers;"),
  "EntityTagHeaderValue needs the Microsoft.Net.Http.Headers using",
);

// ---- 4. the premise behind the short-TTL branch ------------------------------

// Both shells fetch babel at a BARE url. If this ever stops being true the
// short-TTL branch can be reconsidered — but until then, removing it strands
// un-updatable fielded WGTs on a stale transpiler for a year.
for (const rel of [
  "packages/shell-tizen/src/shell.js",
  "packages/shell-tizen-bootstrap/src/boot-shell.src.js",
]) {
  const src = fs.readFileSync(path.join(REPO, rel), "utf8");
  assert.ok(
    src.includes('S+"/shell/babel.min.js"'),
    `${rel}: expected the bare (unversioned) babel fetch this policy is built around`,
  );
  assert.ok(
    !/babel\.min\.js\?v=/.test(src),
    `${rel}: babel is now content-addressed — revisit the ContentAddressed short-TTL branch`,
  );
}

// Conversely, shell + lite ARE addressed by sha — that is what makes the
// immutable branch reachable at all.
const bootstrapHtml = fs.readFileSync(
  path.join(REPO, "packages/shell-tizen-bootstrap/src/index.html"),
  "utf8",
);
assert.ok(
  bootstrapHtml.includes("'?v=' + encodeURIComponent(cachedSha)"),
  "the WGT bootstrap must load shell.min.js at ?v=<sha> for immutable to apply",
);
assert.ok(
  fs
    .readFileSync(path.join(REPO, "packages/shell-tizen/src/shell.js"), "utf8")
    .includes('"/shell/lite.min.js?v=" + sha'),
  "the shell must load lite.min.js at ?v=<sha> for immutable to apply",
);

// ---- 5. the manifests stay uncached ------------------------------------------

for (const route of ['[HttpGet("manifest.json")]', '[HttpGet("tx-manifest.json")]']) {
  const at = ctrl.indexOf(route);
  assert.ok(at >= 0, `${route} missing`);
  const scope = ctrl.slice(at, ctrl.indexOf("\n    }", at));
  assert.ok(
    scope.includes('Response.Headers.CacheControl = "no-cache";'),
    `${route} must stay no-cache — it is how a TV discovers a new sha`,
  );
  assert.ok(
    !scope.includes("max-age"),
    `${route} must never carry a max-age (pins the fleet to a stale shell)`,
  );
}

// tx/{hash}.js — the precedent this change follows — is unchanged.
const txAt = ctrl.indexOf('[HttpGet("tx/{hash}.js")]');
assert.ok(
  ctrl.slice(txAt).includes(`Response.Headers.CacheControl = ${IMMUTABLE};`),
  "tx/{hash}.js must keep its immutable policy",
);

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

console.log("shell-cache.test.cjs: ok");
