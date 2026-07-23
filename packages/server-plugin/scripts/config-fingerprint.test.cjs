#!/usr/bin/env node
/*
 * config-fingerprint.test.cjs — JELA-58 (JELA-57 WS-1) guard for the
 * ConfigFingerprintService + dynamic /shell/manifest.json. Like
 * lockstep.test.cjs / diag-ingest.test.cjs, the C# plugin is not compiled in
 * this repo's node CI, so the contract is pinned two ways:
 *
 *   1. Source pins: the pieces a TV-side epoch gate (JELA-59) depends on must
 *      stay exactly as designed — the fixed aggregate order
 *      (web/shell/scripts/branding), the "label\0sha\n" group-hash shape, the
 *      ADDITIVE-only manifest fields (configEpoch + components appended after
 *      the untouched legacy keys), the DisableConfigFingerprint kill switch
 *      with the legacy-bytes fallback, the ~30s pre-scan throttle with NO
 *      FileSystemWatcher (NAS/Docker mounts drop inotify), the tx-manifest
 *      normalization that EXCLUDES the `generated` timestamp (the scheduled
 *      rebuild rewrites it every run — raw bytes would churn the epoch for
 *      nothing), and the exclusion of our own plugin-config XML from the
 *      scripts group.
 *
 *   2. Behavioural mirror: a faithful JS re-implementation of the hash
 *      pipeline (group hash, ordered aggregate, tx normalization, web-index
 *      asset extraction) is fed fixtures and we PROVE the properties the TV
 *      gate relies on: stable epoch for identical inputs regardless of
 *      enumeration order; epoch moves iff a covered byte/set changes;
 *      `generated`-only tx rewrites do NOT move the epoch; absolute/data:
 *      URLs never resolve into the web group.
 *
 * The full end-to-end behaviour (real service against a fixture server
 * layout, 29 checks incl. component-selective invalidation and manifest
 * byte-identity on the kill-switch path) was executed against the compiled
 * DLL during JELA-58 development; evidence on the issue thread.
 *
 * Run: node packages/server-plugin/scripts/config-fingerprint.test.cjs
 */
"use strict";
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "Jellyfin.Plugin.JellyPlugShell");
const svc = fs.readFileSync(path.join(ROOT, "ConfigFingerprintService.cs"), "utf8");
const drop = fs.readFileSync(path.join(ROOT, "ShellDropService.cs"), "utf8");
const ctrl = fs.readFileSync(
  path.join(ROOT, "Controllers", "ShellController.cs"),
  "utf8",
);
const cfg = fs.readFileSync(path.join(ROOT, "PluginConfiguration.cs"), "utf8");
const reg = fs.readFileSync(
  path.join(ROOT, "PluginServiceRegistrator.cs"),
  "utf8",
);

// ---- 1. source-pin the contract --------------------------------------------

// Registered like the other singletons.
assert.ok(
  reg.includes("AddSingleton<ConfigFingerprintService>()"),
  "ConfigFingerprintService not registered",
);

// NO FileSystemWatcher instantiation anywhere in the plugin — freshness is
// the throttled mtime+size+path pre-scan by design (NAS/Docker bind mounts
// drop inotify events silently). The name may appear in comments explaining
// exactly this; constructing one is what's forbidden.
for (const [name, text] of [
  ["ConfigFingerprintService.cs", svc],
  ["ShellDropService.cs", drop],
  ["ShellController.cs", ctrl],
]) {
  assert.ok(
    !/new\s+FileSystemWatcher/.test(text),
    name + " must not construct a FileSystemWatcher",
  );
}

// ~30s pre-scan throttle.
assert.ok(
  svc.includes("TimeSpan.FromSeconds(30)"),
  "30s pre-scan throttle constant missing/changed",
);

// Timestamps feed the pre-scan signature only, never the fingerprint: the
// signature builder is the only place mtime appears.
assert.ok(
  svc.includes("LastWriteTimeUtc"),
  "pre-scan must include mtime",
);

// The ordered aggregate — this exact order is the TV-side contract.
assert.ok(
  svc.includes(
    '"web:" + web + "\\nshell:" + shell + "\\nscripts:" + scripts + "\\nbranding:" + branding + "\\n"',
  ),
  "epoch aggregate order/shape drifted from web/shell/scripts/branding",
);

// Group hash shape: "label\0sha\n" lines sorted ordinal.
assert.ok(
  svc.includes('e.Label + "\\0" + e.Sha + "\\n"'),
  "group-hash line shape drifted",
);
assert.ok(
  svc.includes("StringComparer.Ordinal"),
  "group-hash ordering must be ordinal",
);

// tx-manifest normalization: babelOptsKey + entries only; the `generated`
// timestamp must never be read into the digest.
assert.ok(
  svc.includes('TryGetProperty("babelOptsKey"') &&
    svc.includes('TryGetProperty("entries"'),
  "tx normalization must digest babelOptsKey + entries",
);
assert.ok(
  !svc.includes('TryGetProperty("generated"'),
  "tx normalization must EXCLUDE the generated timestamp",
);

// Our own plugin config never feeds the epoch (this plugin's toggles do not
// change what a TV downloads; the shell group already covers served bytes).
assert.ok(
  svc.includes('"Jellyfin.Plugin.JellyPlugShell.xml"'),
  "own-config exclusion missing",
);

// Default scripts-group coverage: the fielded injector stack.
assert.ok(
  cfg.includes('"*injector*\\n*enhanced*"'),
  "ScriptFingerprintPatterns default drifted",
);

// JELA-139: plugin-config XMLs hash with the volatile leaf elements stripped
// — JellyfinEnhanced rewrites its cache-clear timestamps without operator
// action, and raw bytes churned the epoch (one spurious resume reload per TV
// per churn). Defaults pin the two keys the 2026-07 live-config audit found.
assert.ok(
  cfg.includes('"ClearTranslationCacheTimestamp\\nClearLocalStorageTimestamp"'),
  "VolatileScriptConfigKeys default drifted",
);
assert.ok(
  /scripts\/config\/[\s\S]{0,400}NormalizedScriptConfigSha/.test(svc),
  "scripts/config files must hash through NormalizedScriptConfigSha",
);
assert.ok(
  svc.includes("VolatileKeyRegexes(config.VolatileScriptConfigKeys)"),
  "volatile keys must come from the operator config",
);

// Kill switch: present in config, checked in the controller BEFORE computing,
// with the legacy static bytes as the fallback on both the disabled and the
// failure path.
assert.ok(
  cfg.includes("public bool DisableConfigFingerprint"),
  "DisableConfigFingerprint kill switch missing",
);
assert.ok(
  ctrl.includes("!config.DisableConfigFingerprint"),
  "controller must gate on the kill switch",
);
// JELA-141 moved the legacy-bytes fallback INTO BuildManifestJson: with
// neither a fingerprint nor flagDefaults applicable it must return the
// exact pre-JELA-58 ManifestJson bytes (byte-identity preserved end to end).
assert.ok(
  /fingerprint == null && flagDefaults == null[\s\S]{0,80}return ManifestJson;/.test(drop),
  "legacy ManifestJson short-circuit missing from BuildManifestJson",
);
assert.ok(
  /TryGetFingerprint[\s\S]{0,300}BuildManifestJson/.test(ctrl),
  "dynamic path must build from the computed fingerprint",
);

// JELA-141: flagDefaults is additive like configEpoch/components, sourced
// from the Lite*DefaultOn config bools, and OMITTED when all are off (null
// map) so the no-rollout manifest stays byte-identical. Absent field is
// meaningful on the TV (clears cached defaults) — the all-off path must
// return null, never an empty/all-0 map.
assert.ok(
  cfg.includes("public bool LiteDefaultOn") &&
    cfg.includes("public bool LiteNativeDefaultOn") &&
    cfg.includes("public bool LiteSubsDefaultOn"),
  "JELA-141 Lite*DefaultOn config bools missing",
);
assert.ok(
  /!config\.LiteDefaultOn && !config\.LiteNativeDefaultOn && !config\.LiteSubsDefaultOn[\s\S]{0,60}return null;/.test(drop),
  "LiteFlagDefaults must return null (field omitted) when every default is off",
);
assert.ok(
  drop.includes('manifest["flagDefaults"] = flagDefaults;'),
  "flagDefaults additive field missing from BuildManifestJson",
);
for (const k of [
  '["jellyfin.shell.liteEnabled"]',
  '["jellyfin.lite.native"]',
  '["jellyfin.lite.subs"]',
]) {
  assert.ok(drop.includes(k), "flagDefaults key missing: " + k);
}
assert.ok(
  ctrl.includes("ShellDropService.LiteFlagDefaults(config)"),
  "controller must source flagDefaults from the shared helper",
);

// Additive-only manifest: legacy base keys untouched, in order, and the only
// new keys are configEpoch + components (with the four fixed groups).
for (const k of [
  '["version"]',
  '["sha256"]',
  '["shellUrl"]',
  '["babelSha256"]',
  '["minBootstrapVersion"]',
  '["bootstrapWgt"]',
]) {
  assert.ok(drop.includes(k), "legacy manifest key missing: " + k);
}
assert.ok(
  drop.includes('["configEpoch"] = fingerprint.Epoch'),
  "configEpoch additive field missing",
);
// JELA-62 moved the group map onto the ConfigFingerprint record so the
// manifest and the settings endpoints cannot drift; the four fixed groups now
// live there and the manifest builds from the shared helper.
for (const k of ['["web"]', '["shell"]', '["scripts"]', '["branding"]']) {
  assert.ok(svc.includes(k), "components group missing: " + k);
}
assert.ok(
  drop.includes('["components"] = fingerprint.ComponentsDictionary()'),
  "manifest must build components from the shared record helper",
);
// Legacy bytes still serialized from the same base dict (byte-identity of the
// disabled path with the pre-JELA-58 manifest).
assert.ok(
  drop.includes("ManifestJson = JsonSerializer.SerializeToUtf8Bytes(_baseManifest)"),
  "legacy ManifestJson must serialize the unchanged base dict",
);

// Failure degrades to null -> legacy manifest, never a wrong epoch.
assert.ok(
  svc.includes("return null;"),
  "TryGetFingerprint must fail open (null -> legacy manifest)",
);

// ---- 2. behavioural mirror ---------------------------------------------------

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

// Mirror of ConfigFingerprintService.GroupSha: "label\0sha\n" sorted ordinal.
function groupSha(entries) {
  const lines = entries
    .map((e) => e.label + "\0" + e.sha + "\n")
    .sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  return sha256(Buffer.from(lines.join(""), "utf8"));
}

// Mirror of the ordered aggregate.
function epochOf(web, shell, scripts, branding) {
  return sha256(
    Buffer.from(
      "web:" +
        web +
        "\nshell:" +
        shell +
        "\nscripts:" +
        scripts +
        "\nbranding:" +
        branding +
        "\n",
      "utf8",
    ),
  );
}

// Mirror of NormalizedTxManifestSha (parsed path).
function txSha(manifest) {
  let s = "babelOptsKey\0" + (manifest.babelOptsKey || "") + "\n";
  for (const k of Object.keys(manifest.entries || {}).sort()) {
    s += k + "\0" + manifest.entries[k] + "\n";
  }
  return sha256(Buffer.from(s, "utf8"));
}

// Mirror of ReferencedWebAssets: script src + link href, skip absolute /
// protocol-relative / data:-style URLs, strip query+hash, de-dupe.
function referencedWebAssets(html) {
  const out = [];
  const seen = new Set();
  for (const re of [
    /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi,
    /<link\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi,
  ]) {
    let m;
    while ((m = re.exec(html))) {
      const url = m[1];
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url)) continue;
      const rel = url.split("?")[0].split("#")[0].replace(/^\/+/, "");
      if (rel && !seen.has(rel)) {
        seen.add(rel);
        out.push(rel);
      }
    }
  }
  return out;
}

// Deterministic + enumeration-order independent.
const files = [
  { label: "web/index.html", sha: sha256(Buffer.from("<html>")) },
  { label: "web/config.json", sha: sha256(Buffer.from("{}")) },
  { label: "web/themes/dark/theme.css", sha: sha256(Buffer.from(":root{}")) },
];
assert.strictEqual(
  groupSha(files),
  groupSha([...files].reverse()),
  "group hash must not depend on enumeration order",
);

// Epoch stable for identical groups; moves when any single component moves;
// component order is significant (swapping two groups is a different epoch).
const g = files.map((f) => f.sha);
const e1 = epochOf(g[0], g[1], g[2], g[0]);
assert.strictEqual(e1, epochOf(g[0], g[1], g[2], g[0]), "epoch stable");
assert.notStrictEqual(
  e1,
  epochOf(sha256(Buffer.from("x")), g[1], g[2], g[0]),
  "web move must move epoch",
);
assert.notStrictEqual(
  e1,
  epochOf(g[1], g[0], g[2], g[0]),
  "aggregate order must be significant",
);

// One changed byte in one covered file -> that group and the epoch move.
const theme2 = files.map((f) =>
  f.label === "web/themes/dark/theme.css"
    ? { label: f.label, sha: sha256(Buffer.from(":root{--c:#001}")) }
    : f,
);
assert.notStrictEqual(groupSha(files), groupSha(theme2), "theme byte change moves web group");

// Adding/removing a covered file moves the group even with same other bytes.
assert.notStrictEqual(
  groupSha(files),
  groupSha(files.slice(0, 2)),
  "covered-set change moves the group",
);

// tx normalization: `generated`-only rewrite is invisible; entry changes are not.
const tx1 = {
  format: 1,
  babelOptsKey: "k1",
  generated: "2026-07-10T00:00:00Z",
  entries: { abc: "tx/abc.js" },
};
const tx2 = { ...tx1, generated: "2026-07-11T09:09:09Z" };
assert.strictEqual(txSha(tx1), txSha(tx2), "generated-only rewrite must not move tx digest");
assert.notStrictEqual(
  txSha(tx1),
  txSha({ ...tx1, entries: { abc: "tx/abc.js", def: "tx/def.js" } }),
  "entry change must move tx digest",
);
assert.notStrictEqual(
  txSha(tx1),
  txSha({ ...tx1, babelOptsKey: "k2" }),
  "babelOptsKey change must move tx digest",
);

// JELA-139 mirror of VolatileKeyRegexes + NormalizedScriptConfigSha: strip
// "<Key ...>text</Key>" / "<Key/>" leaf elements (case-insensitive) from the
// decoded XML text, hash the rest; empty key list = raw byte hash.
function volatileKeyRegexes(keys) {
  return (keys || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((k) => {
      const esc = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(
        "<" + esc + "(?:\\s[^>]*)?(?:\\/>|>[^<]*<\\/" + esc + "\\s*>)",
        "gi",
      );
    });
}
function normalizedScriptConfigSha(xml, regexes) {
  if (!regexes.length) return sha256(Buffer.from(xml, "utf8"));
  let text = xml;
  for (const re of regexes) text = text.replace(re, "");
  return sha256(Buffer.from(text, "utf8"));
}

const DEFAULT_VOLATILE = "ClearTranslationCacheTimestamp\nClearLocalStorageTimestamp";
const vres = volatileKeyRegexes(DEFAULT_VOLATILE);
const jeXml = (tx, ls, toast) =>
  '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<PluginConfiguration xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n' +
  "  <ToastDuration>" + toast + "</ToastDuration>\n" +
  "  <ClearLocalStorageTimestamp>" + ls + "</ClearLocalStorageTimestamp>\n" +
  "  <ClearTranslationCacheTimestamp>" + tx + "</ClearTranslationCacheTimestamp>\n" +
  "  <RandomButtonEnabled>true</RandomButtonEnabled>\n" +
  "</PluginConfiguration>";

// Volatile-only churn (the JELA-139 bug) must NOT move the hash…
assert.strictEqual(
  normalizedScriptConfigSha(jeXml("1784736116990", "1773159569032", "1500"), vres),
  normalizedScriptConfigSha(jeXml("1799999999999", "1780000000000", "1500"), vres),
  "volatile-timestamp churn must not move the scripts-config hash",
);
// …while a real config change still must.
assert.notStrictEqual(
  normalizedScriptConfigSha(jeXml("1784736116990", "1773159569032", "1500"), vres),
  normalizedScriptConfigSha(jeXml("1784736116990", "1773159569032", "1501"), vres),
  "real config change must move the scripts-config hash",
);
// End-to-end: churn-only rewrite leaves the scripts group and the epoch bit-identical.
const scriptsA = groupSha([
  { label: "scripts/config/JE.xml", sha: normalizedScriptConfigSha(jeXml("1", "2", "1500"), vres) },
]);
const scriptsB = groupSha([
  { label: "scripts/config/JE.xml", sha: normalizedScriptConfigSha(jeXml("9", "8", "1500"), vres) },
]);
assert.strictEqual(
  epochOf(g[0], g[1], scriptsA, g[2]),
  epochOf(g[0], g[1], scriptsB, g[2]),
  "volatile churn must not move the epoch",
);
// A key name quoted INSIDE element text is entity-escaped in real XML and can
// never match the leaf-element regex — a JSI snippet mentioning the tag is safe.
const quoted =
  "<CustomJavaScripts><Script>if(x){log('&lt;ClearTranslationCacheTimestamp&gt;42&lt;/ClearTranslationCacheTimestamp&gt;')}</Script></CustomJavaScripts>";
assert.strictEqual(
  normalizedScriptConfigSha(quoted, vres),
  sha256(Buffer.from(quoted, "utf8")),
  "escaped mention in element text must not be stripped",
);
// Self-closing + attribute forms strip too; empty key list = raw hash.
assert.strictEqual(
  normalizedScriptConfigSha("<A/><ClearLocalStorageTimestamp /><B>1</B>", vres),
  normalizedScriptConfigSha("<A/><B>1</B>", vres),
  "self-closing volatile element must strip",
);
assert.strictEqual(
  normalizedScriptConfigSha("<A>1</A>", []),
  sha256(Buffer.from("<A>1</A>", "utf8")),
  "empty volatile list must fall back to the raw byte hash",
);

// Web-index extraction: local assets in, external/data URLs out, query stripped.
assert.deepStrictEqual(
  referencedWebAssets(
    '<link rel="stylesheet" href="main.abc.css?v=1">' +
      '<script src="main.abc.bundle.js"></script>' +
      '<script src="/JavaScriptInjector/public.js#f"></script>' +
      '<script src="https://example.com/x.js"></script>' +
      '<script src="//example.com/y.js"></script>' +
      '<script src="data:text/javascript,1"></script>' +
      '<script src="main.abc.bundle.js"></script>',
  ),
  ["main.abc.bundle.js", "JavaScriptInjector/public.js", "main.abc.css"],
  "web-index asset extraction drifted",
);

console.log("config-fingerprint.test.cjs OK");
