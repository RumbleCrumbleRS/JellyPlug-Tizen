#!/usr/bin/env node
/*
 * emit-manifest-version.test.cjs — JELA-10 regression guard.
 *
 * emit_manifest.py extracts the shell semver from the minified shell.min.js
 * head bytes for the manifest `version` field. JEL-617's boot-phase ring made
 * `ver:"X"` (the ring record literal) the first version occurrence in
 * minified output, which the pre-JELA-10 extractor did not match — so the
 * manifest silently shipped version "unknown" for every current shell.
 *
 * This test drives emit_manifest.py against a staged drop built from the real
 * committed shell.min.js and asserts the manifest version equals the shell's
 * config.xml version (the build-time source of truth), plus a couple of unit
 * cases over the extractor's supported minified forms.
 */
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const HERE = __dirname;
const REPO = path.resolve(HERE, "..", "..", "..");
const SHELL_MIN = path.join(REPO, "packages", "shell-tizen", "src", "shell.min.js");
const BABEL_MIN = path.join(REPO, "packages", "shell-tizen", "src", "babel.min.js");
const CONFIG_XML = path.join(REPO, "packages", "shell-tizen", "tizen", "config.xml");
const EMIT = path.join(HERE, "emit_manifest.py");

function configVersion() {
  const xml = fs.readFileSync(CONFIG_XML, "utf8");
  const m = xml.match(/<widget[^>]*\bversion="([^"]+)"/);
  assert(m, "could not read version from config.xml");
  return m[1];
}

// --- end-to-end: emit_manifest.py against the real committed shell.min.js ---
(function endToEnd() {
  assert(fs.existsSync(SHELL_MIN), `missing ${SHELL_MIN} — run build_shell_min.py`);
  const want = configVersion();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shelldrop-"));
  try {
    fs.copyFileSync(SHELL_MIN, path.join(dir, "shell.min.js"));
    if (fs.existsSync(BABEL_MIN)) {
      fs.copyFileSync(BABEL_MIN, path.join(dir, "babel.min.js"));
    }
    execFileSync("python3", [EMIT, dir + path.sep], { stdio: "pipe" });
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
    assert.strictEqual(
      manifest.version,
      want,
      `manifest version ${JSON.stringify(manifest.version)} != config.xml ${JSON.stringify(want)} ` +
        "(extractor regressed on the current minified shell form)",
    );
    assert.notStrictEqual(manifest.version, "unknown", "manifest version must not be 'unknown'");
    assert.match(manifest.sha256, /^[0-9a-f]{64}$/, "sha256 must be a 64-char hex digest");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

// --- unit: each supported minified form resolves; junk falls back to unknown ---
(function extractorForms() {
  // Mirror extract_shell_version's patterns via a tiny python one-liner so the
  // test exercises the actual implementation, not a JS re-derivation.
  const probe = (headText) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shellprobe-"));
    try {
      fs.writeFileSync(path.join(dir, "shell.min.js"), headText);
      execFileSync("python3", [EMIT, dir + path.sep], { stdio: "pipe" });
      return JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")).version;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  assert.strictEqual(probe('var rec={ts:t0,nav,ver:"1.0.75"};'), "1.0.75", "boot-ring ver: form");
  assert.strictEqual(probe('x,BUNDLE_CACHE_VER="9.9.9",y'), "9.9.9", "_VER= constant form");
  assert.strictEqual(probe('shellVer="2.3.4"'), "2.3.4", "legacy shellVer form");
  assert.strictEqual(probe('{"version":"5.6.7"}'), "5.6.7", "legacy json version form");
  assert.strictEqual(probe("no version literal here at all"), "unknown", "no match -> unknown");
})();

console.log("emit-manifest-version.test.cjs OK");
