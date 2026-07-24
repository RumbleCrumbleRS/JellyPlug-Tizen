#!/usr/bin/env node
/*
 * config-page.test.cjs — JELA-62 guard for the dashboard settings page +
 * rehash surface. Like the sibling .test.cjs files, the C# plugin is not
 * compiled in this repo's node CI, so the wiring that would only break at
 * runtime is source-pinned:
 *
 *   1. The embedded-resource chain: Plugin.GetPages points at
 *      {Namespace}.Configuration.configPage.html, the csproj embeds
 *      Configuration/configPage.html (msbuild default logical name =
 *      RootNamespace + folder dots + file name), and the file exists. A
 *      mismatch anywhere yields a plugin whose settings page 404s.
 *
 *   2. The page drives the right plugin: its GUID literal must equal
 *      Plugin.Id, or getPluginConfiguration silently edits nothing.
 *
 *   3. Form wiring: every field id in the page's declarative `fields` list
 *      must be a real PluginConfiguration property (a typo'd id would
 *      silently save nothing), and the current operator-facing property set
 *      must be present in the form. Save round-trips the whole config
 *      object, so a property deliberately absent from the form still
 *      survives saves — new internal properties do NOT need to be added
 *      here or to the form.
 *
 *   4. Auth is fail-closed on /shell/: class-level RequiresElevation with
 *      per-endpoint [AllowAnonymous] opt-outs for exactly the TV-facing
 *      routes (a class-level AllowAnonymous would override method
 *      [Authorize] — the pre-JELA-62 ASP0026 hole that left diag/report
 *      anonymous).
 *
 *   5. The rehash surface: GET shell/fingerprint + POST
 *      shell/fingerprint/rehash exist without an [AllowAnonymous] opt-out,
 *      Rehash keeps the previous fingerprint on failure, and the scheduled
 *      ConfigRehashTask forwards its CancellationToken and never hashes
 *      from a default (uninitialized-plugin) configuration.
 *
 * Run: node packages/server-plugin/scripts/config-page.test.cjs
 */
"use strict";
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "Jellyfin.Plugin.JellyPlugShell");
const plugin = fs.readFileSync(path.join(ROOT, "Plugin.cs"), "utf8");
const csproj = fs.readFileSync(
  path.join(ROOT, "Jellyfin.Plugin.JellyPlugShell.csproj"),
  "utf8",
);
const page = fs.readFileSync(
  path.join(ROOT, "Configuration", "configPage.html"),
  "utf8",
);
const ctrl = fs.readFileSync(
  path.join(ROOT, "Controllers", "ShellController.cs"),
  "utf8",
);
const svc = fs.readFileSync(path.join(ROOT, "ConfigFingerprintService.cs"), "utf8");
const cfg = fs.readFileSync(path.join(ROOT, "PluginConfiguration.cs"), "utf8");
const task = fs.readFileSync(
  path.join(ROOT, "ScheduledTasks", "ConfigRehashTask.cs"),
  "utf8",
);

// ---- 1. embedded-resource chain ---------------------------------------------

assert.ok(plugin.includes("IHasWebPages"), "Plugin must implement IHasWebPages");
assert.ok(
  plugin.includes('.Configuration.configPage.html"'),
  "GetPages must point at the Configuration.configPage.html logical name",
);
assert.ok(
  /<RootNamespace>Jellyfin\.Plugin\.JellyPlugShell<\/RootNamespace>/.test(csproj),
  "RootNamespace pin (logical-name basis for the config page resource)",
);
assert.ok(
  /<EmbeddedResource Include="Configuration\/configPage\.html" \/>/.test(csproj),
  "configPage.html must be embedded WITHOUT a custom LogicalName",
);

// ---- 2. the page drives this plugin -----------------------------------------

const guid = /Guid\.Parse\("([0-9a-f-]{36})"\)/.exec(plugin);
assert.ok(guid, "Plugin.Id GUID literal not found");
assert.ok(
  page.includes(`var pluginId = '${guid[1]}';`),
  "config page GUID must equal Plugin.Id",
);

// ---- 3. form wiring ----------------------------------------------------------

// Reverse direction: every declared form field must be a real config property.
const formIds = [...page.matchAll(/\{ id: '(\w+)', type: '\w+' \}/g)].map((m) => m[1]);
assert.ok(formIds.length >= 9, `expected the full field list, got ${formIds}`);
for (const id of formIds) {
  assert.ok(
    new RegExp(`public\\s[^\\n]*\\b${id}\\b`).test(cfg),
    `form field '${id}' has no matching PluginConfiguration property (typo → silently never saved)`,
  );
  assert.ok(page.includes(`id="${id}"`), `form field '${id}' has no matching input element`);
}

// Forward direction: today's operator-facing settings all appear in the form.
for (const prop of [
  "DisableConfigFingerprint",
  "ScriptFingerprintPatterns",
  "ExtraFingerprintPaths",
  "VolatileScriptConfigKeys",
  "DisableTxRebuild",
  "DisableTxDynScan",
  "JsiChannelPath",
  "ExtraSourceUrls",
  "TransformTimeoutSeconds",
  "DisableDiagIngest",
  "DiagMaxRings",
]) {
  assert.ok(formIds.includes(prop), `operator setting ${prop} missing from the form`);
}

// ---- 4. fail-closed auth shape ----------------------------------------------

// Class-level attributes are unindented; method-level ones are indented —
// prose mentions in doc comments never sit at column 0 in this file.
assert.ok(
  /^\[Authorize\(Policy = "RequiresElevation"\)\]$/m.test(ctrl),
  "class-level RequiresElevation default missing (fail-open controller)",
);
assert.ok(
  !/^\[AllowAnonymous\]$/m.test(ctrl),
  "class-level [AllowAnonymous] would override every method [Authorize] (ASP0026)",
);

// Exactly the TV-facing pre-login routes opt out.
const anonRoutes = [
  '[HttpGet("manifest.json")]',
  '[HttpGet("shell.min.js")]',
  '[HttpGet("lite.min.js")]', // JELA-67: Lite blob, fetched pre-login like shell.min.js
  '[HttpGet("babel.min.js")]',
  '[HttpGet("tx-manifest.json")]',
  '[HttpGet("tx/{hash}.js")]',
  '[HttpPost("diag")]',
];
for (const route of anonRoutes) {
  const at = ctrl.indexOf(route);
  assert.ok(at >= 0, `${route} route missing`);
  assert.ok(
    ctrl.lastIndexOf("    [AllowAnonymous]", at) > ctrl.lastIndexOf("]\n\n", at),
    `${route} must carry [AllowAnonymous] (TVs fetch it before login)`,
  );
}
assert.strictEqual(
  (ctrl.match(/^    \[AllowAnonymous\]$/gm) || []).length,
  anonRoutes.length,
  "an endpoint beyond the TV-facing set opted out of elevation",
);

// Operator-only fingerprint routes exist and do NOT opt out.
for (const route of ['[HttpGet("fingerprint")]', '[HttpPost("fingerprint/rehash")]']) {
  assert.ok(ctrl.includes(route), `${route} route missing`);
}
assert.ok(
  page.includes("shell/fingerprint"),
  "settings page must read the fingerprint endpoint",
);

// ---- 5. rehash surface -------------------------------------------------------

// Full re-hash API: cancellable, and failure must NOT drop the cached
// fingerprint (a transient NAS error at the 24h tick would otherwise strip
// the epoch from the manifest fleet-wide).
assert.ok(
  /public ConfigFingerprint\? Rehash\(PluginConfiguration config, CancellationToken cancellationToken/.test(svc),
  "ConfigFingerprintService.Rehash(config, token) missing",
);
assert.ok(
  svc.includes("keeping the previous fingerprint"),
  "Rehash failure path must keep the known-good cache",
);

// Scheduled task: distinct key, JellyPlug category, forwards the token,
// respects the kill switch, and skips (not defaults) when the plugin has not
// initialized — a default-config epoch would be cached and served.
assert.ok(task.includes('"JellyPlugShellConfigRehash"'), "task key pin");
assert.ok(task.includes('"JellyPlug"'), "task category pin");
assert.ok(
  task.includes("_fingerprint.Rehash(config, cancellationToken)"),
  "task must full-rehash with the scheduler's CancellationToken",
);
assert.ok(
  task.includes("config.DisableConfigFingerprint"),
  "task must respect the kill switch",
);
assert.ok(
  !task.includes("?? new PluginConfiguration()"),
  "task must skip when Plugin.Instance is null, not hash a default config",
);
assert.ok(
  task.includes("TaskTriggerInfoType.StartupTrigger") &&
    task.includes("TaskTriggerInfoType.IntervalTrigger"),
  "default triggers: startup + interval",
);

console.log("config-page.test.cjs: all pins hold");
