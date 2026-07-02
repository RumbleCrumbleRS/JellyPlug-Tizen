// JEL-627 verification — package.json version must track tizen/config.xml.
//
// tizen/config.xml <widget version> is the single source of truth for the
// shipped build: it's what the TV reports, what release tags are cut from,
// and what build_shell_min.py substitutes into the shell via __SHELL_VER__.
// package.json's version field is advisory-only (nothing consumes it), which
// is exactly how it silently drifted to 1.0.73 while config.xml moved to
// 1.0.75. A stale package.json version misleads anyone (or any tooling)
// reading the workspace manifest, so this guard makes the drift a CI failure:
// bump both files in lockstep when cutting a release.
//
// Run: node scripts/version-lockstep.test.cjs
//   or: pnpm --filter @jellyfin-tv/shell-tizen test
"use strict";
const fs = require("fs");
const path = require("path");

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const PKG = path.join(__dirname, "..", "package.json");
const CONFIG_XML = path.join(__dirname, "..", "tizen", "config.xml");

const pkgVersion = JSON.parse(fs.readFileSync(PKG, "utf8")).version;
if (!pkgVersion) fail("version field not found in package.json");

const cfgMatch = fs
  .readFileSync(CONFIG_XML, "utf8")
  .match(/<widget[^>]*\bversion="([^"]+)"/);
if (!cfgMatch) fail("widget version not found in tizen/config.xml");
const configVersion = cfgMatch[1];

if (pkgVersion !== configVersion)
  fail(
    "package.json version (" + pkgVersion + ") must equal config.xml widget " +
    "version (" + configVersion + "). config.xml is the source of truth for " +
    "the shipped build — bump package.json in lockstep (JEL-627)."
  );

console.log(
  "OK: package.json version " + pkgVersion + " matches tizen/config.xml"
);
