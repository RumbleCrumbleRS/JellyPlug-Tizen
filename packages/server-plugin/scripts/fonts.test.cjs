#!/usr/bin/env node
/*
 * fonts.test.cjs — JELA-710 guards for the self-hosted /shell/fonts/ drop.
 *
 * The drop exists to keep fonts.googleapis.com + fonts.gstatic.com (and the
 * media-bar's cdn.jsdelivr.net stylesheet) off the TV boot path: Google
 * UA-sniffs the Tizen UA and serves it TrueType — 771 KiB/boot measured on
 * the JELA-706 rig — for an M63 engine that has read WOFF2 since Chrome 36.
 *
 * Like the sibling .test.cjs files, the C# plugin is not compiled in node CI,
 * so the wiring is source-pinned. What each check protects:
 *
 *   1. The committed artifacts stay self-contained: every url() in the two
 *      emitted stylesheets resolves to a committed .woff2 sibling, carries the
 *      ?v=<sha256 of those exact bytes> that earns ContentAddressed's
 *      immutable branch, and no remote font origin survives anywhere. A
 *      regen via fetch-webfonts.py that half-lands (css updated, bodies not,
 *      or vice versa) fails here instead of 404ing on TVs.
 *
 *   2. The serving side stays wired: csproj embeds the directory, the
 *      controller route exists, and it serves through ContentAddressed with
 *      the asset's own content type (a woff2 body served as
 *      application/javascript breaks font parsing on some engines).
 *
 *   3. Both shells still repoint the media-bar <link>: the rewrite helper +
 *      its kill switch exist in shell.js AND boot-shell.src.js, and the
 *      rewritten URL matches a file this plugin actually serves.
 *
 * Run: node packages/server-plugin/scripts/fonts.test.cjs
 */
"use strict";
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "Jellyfin.Plugin.JellyPlugShell");
const FONTS = path.join(ROOT, "Resources", "fonts");
const REPO = path.join(__dirname, "..", "..", "..");

// ---- 1. the committed drop is self-contained --------------------------------

const files = fs.readdirSync(FONTS);
const woff2 = files.filter((f) => f.endsWith(".woff2"));
const css = files.filter((f) => f.endsWith(".css"));
assert.ok(woff2.length >= 20, `only ${woff2.length} woff2 bodies committed`);
assert.deepStrictEqual(
  css.sort(),
  ["inter-sora.css", "mediabar-slideshowpure.css"],
  "the two served stylesheets must exist (theme fonts + patched media-bar)",
);

for (const sheet of css) {
  // Comments may (and do) NAME the replaced origins for provenance; only
  // effective CSS must never reach one.
  const body = fs
    .readFileSync(path.join(FONTS, sheet), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(
    !/fonts\.googleapis|fonts\.gstatic|cdn\.jsdelivr|@import/.test(body),
    `${sheet} still reaches a remote origin (or kept an @import)`,
  );
  const urls = [...body.matchAll(/url\(([^)]+)\)/g)].map((m) => m[1]);
  assert.ok(urls.length > 0, `${sheet} has no url() at all`);
  for (const url of urls) {
    const m = /^([a-z0-9.-]+\.woff2)\?v=([0-9a-f]{64})$/.exec(url);
    assert.ok(m, `${sheet}: url(${url}) is not a local ?v=sha256 woff2 ref`);
    const file = path.join(FONTS, m[1]);
    assert.ok(fs.existsSync(file), `${sheet} references missing ${m[1]}`);
    const sha = crypto
      .createHash("sha256")
      .update(fs.readFileSync(file))
      .digest("hex");
    assert.strictEqual(
      sha,
      m[2],
      `${sheet}: ?v= for ${m[1]} does not match the committed bytes — ` +
        "half-landed regen; re-run scripts/fetch-webfonts.py",
    );
  }
}

// Every committed body is referenced (orphans mean the css and the dir have
// drifted apart — usually a weight was dropped in one place only).
const referenced = new Set(
  css.flatMap((sheet) =>
    [
      ...fs
        .readFileSync(path.join(FONTS, sheet), "utf8")
        .matchAll(/url\(([a-z0-9.-]+\.woff2)\?/g),
    ].map((m) => m[1]),
  ),
);
for (const f of woff2) {
  assert.ok(referenced.has(f), `${f} committed but referenced by no css`);
}

// ---- 2. the serving side stays wired ----------------------------------------

const csproj = fs.readFileSync(
  path.join(ROOT, "Jellyfin.Plugin.JellyPlugShell.csproj"),
  "utf8",
);
for (const glob of ["Resources/fonts/*.woff2", "Resources/fonts/*.css"]) {
  assert.ok(
    csproj.includes(`Include="${glob}"`),
    `csproj no longer embeds ${glob} — the route would 404 fleet-wide`,
  );
}

const ctrl = fs.readFileSync(
  path.join(ROOT, "Controllers", "ShellController.cs"),
  "utf8",
);
assert.ok(
  ctrl.includes('[HttpGet("fonts/{name}")]'),
  "fonts route missing from ShellController",
);
assert.ok(
  /ContentAddressed\(asset\.Bytes, asset\.GzipBytes, asset\.Sha256, asset\.ContentType\)/.test(
    ctrl,
  ),
  "fonts must serve through ContentAddressed with the asset's own content type",
);

const dropSvc = fs.readFileSync(path.join(ROOT, "ShellDropService.cs"), "utf8");
assert.ok(
  /"font\/woff2"/.test(dropSvc) && /"text\/css; charset=utf-8"/.test(dropSvc),
  "FontAsset content types lost",
);

// ---- 3. both shells still repoint the media-bar stylesheet ------------------

for (const shell of [
  "packages/shell-tizen/src/shell.js",
  "packages/shell-tizen-bootstrap/src/boot-shell.src.js",
]) {
  const src = fs.readFileSync(path.join(REPO, shell), "utf8");
  assert.ok(
    src.includes("function rewriteFontThirdPartyCss("),
    `${shell}: rewriteFontThirdPartyCss missing`,
  );
  assert.ok(
    src.includes('"/shell/fonts/mediabar-slideshowpure.css"'),
    `${shell}: rewrite no longer targets the served patched stylesheet`,
  );
  assert.ok(
    src.includes('"jellyfin.shell.selfFontsDisabled"'),
    `${shell}: kill switch gone — no way to boot the stock font chain`,
  );
  assert.ok(
    /rewriteFontThirdPartyCss\(results\[0\], serverUrl\)/.test(src),
    `${shell}: rewrite is defined but no longer applied to the index markup`,
  );
}

// The rewrite target must be a name the dictionary will actually contain.
assert.ok(
  files.includes("mediabar-slideshowpure.css"),
  "rewrite target mediabar-slideshowpure.css not in the embedded drop",
);

console.log("OK: /shell/fonts/ self-hosted webfont drop (JELA-710)");
