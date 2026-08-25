#!/usr/bin/env node
/*
 * cors-preflight-max-age.test.cjs — JELA-709 guard for the preflight-cache
 * header. Like the sibling .test.cjs files, the C# plugin is not compiled in
 * this repo's node CI, so the wiring is source-pinned.
 *
 * The bug this locks down: no route on the server sent Access-Control-Max-Age,
 * so the Fetch spec's 5-SECOND default applied and 98 of 555 requests in a
 * cold TV boot (17.7%) were repeat CORS preflights — two serialized round
 * trips for every API call, invisible to byte counts and server CPU alike.
 *
 * The MECHANISM is the fragile part, and each pin below guards a way it can
 * silently break:
 *
 *   1. It must be an IStartupFilter + OnStarting decoration. A preflight
 *      OPTIONS never reaches any controller (Jellyfin's CORS middleware
 *      answers it and short-circuits), so a controller header is dead code;
 *      and a substituted ICorsPolicyProvider LOSES silently, because plugin
 *      RegisterServices runs before Startup.ConfigureServices registers
 *      Jellyfin's own provider and the last registration wins.
 *
 *   2. It must gate on OPTIONS + Access-Control-Request-Method (true
 *      preflights only), require Access-Control-Allow-Origin on the response
 *      (never decorate a refusal), and defer to an existing max-age (so the
 *      upstream half of JELA-709 landing in Jellyfin core disables this
 *      automatically).
 *
 *   3. The value must stay 600: Chromium clamps its preflight cache to 600 s,
 *      so a larger number is a lie in the header, and a smaller one gives
 *      away boot coverage for nothing.
 *
 *   4. The kill switch must exist, be operator-editable, and be read
 *      per-response (flip without restart).
 *
 * Run: node packages/server-plugin/scripts/cors-preflight-max-age.test.cjs
 */
"use strict";
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const PLUGIN = path.join(__dirname, "..", "Jellyfin.Plugin.JellyPlugShell");
const read = (...p) => fs.readFileSync(path.join(PLUGIN, ...p), "utf8");

const filter = read("CorsPreflightMaxAgeStartupFilter.cs");
const registrator = read("PluginServiceRegistrator.cs");
const cfg = read("PluginConfiguration.cs");
const page = read("Configuration", "configPage.html");

// ---- 1. the mechanism is a registered IStartupFilter ------------------------

assert.ok(
  filter.includes(": IStartupFilter"),
  "filter no longer implements IStartupFilter — the only order-independent hook a plugin has",
);
assert.ok(
  filter.includes("Response.OnStarting"),
  "filter must decorate via Response.OnStarting — the CORS middleware short-circuits preflights, " +
    "so there is no later place in the pipeline to touch the response",
);
assert.ok(
  // Lifetime is immaterial — the host resolves IStartupFilter once at startup —
  // so pin the registration itself, not Singleton vs Transient.
  /Add(?:Singleton|Transient|Scoped)<IStartupFilter, CorsPreflightMaxAgeStartupFilter>/.test(
    registrator,
  ),
  "PluginServiceRegistrator no longer registers the startup filter — the header silently vanishes",
);
assert.ok(
  !registrator.includes("ICorsPolicyProvider"),
  "registering an ICorsPolicyProvider from the plugin LOSES to Jellyfin's later registration — " +
    "plugin RegisterServices runs before Startup.ConfigureServices and last registration wins",
);

// ---- 2. the decoration is narrow and deferential ----------------------------

assert.ok(
  filter.includes("HttpMethods.IsOptions"),
  "preflight gate must check the OPTIONS method",
);
assert.ok(
  /IsNullOrEmpty\([^)]*AccessControlRequestMethod\)/.test(filter),
  "preflight gate must require Access-Control-Request-Method — a bare OPTIONS is not a preflight",
);
assert.ok(
  /!StringValues\.IsNullOrEmpty\(headers\.AccessControlAllowOrigin\)/.test(filter),
  "must require an Access-Control-Allow-Origin on the response — never decorate a CORS refusal",
);
assert.ok(
  /StringValues\.IsNullOrEmpty\(headers\.AccessControlMaxAge\)/.test(filter),
  "must defer to an existing Access-Control-Max-Age — when Jellyfin core ships its own " +
    "(the upstream half of JELA-709), this filter has to stand down automatically",
);

// ---- 3. the value is Chromium's clamp ---------------------------------------

assert.ok(
  /MaxAgeSeconds = "600"/.test(filter),
  "max-age must stay 600 — Chromium clamps the preflight cache at 600 s, more is a lie, less " +
    "gives away boot coverage",
);

// ---- 4. kill switch: config property + form wiring + per-response read ------

assert.ok(
  /public bool DisableCorsPreflightMaxAge \{ get; set; \}/.test(cfg),
  "kill switch property missing from PluginConfiguration",
);
assert.ok(
  filter.includes("DisableCorsPreflightMaxAge"),
  "filter no longer reads the kill switch",
);
assert.ok(
  /OnStarting[\s\S]{0,400}DisableCorsPreflightMaxAge/.test(filter),
  "kill switch must be read inside OnStarting (per-response) so an operator flip needs no restart",
);
assert.ok(
  page.includes('id="DisableCorsPreflightMaxAge"'),
  "config page checkbox missing — the kill switch would be config-file-only",
);
assert.ok(
  page.includes("{ id: 'DisableCorsPreflightMaxAge', type: 'bool' }"),
  "config page field-list entry missing — the checkbox would render but never save",
);

console.log("cors-preflight-max-age.test.cjs: all assertions passed");
