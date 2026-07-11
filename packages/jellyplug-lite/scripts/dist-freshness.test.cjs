#!/usr/bin/env node
/*
 * dist-freshness.test.cjs — the committed dist/lite.min.js must be exactly
 * what build-lite.mjs produces from src/lite.src.js today (JELA-67 M1
 * slice 2). The server plugin embeds the committed blob as the
 * /shell/lite.min.js resource, so a stale blob means the plugin serves
 * bytes that no longer match the source the tests just proved out.
 *
 * Fix a failure with: pnpm --filter @jellyfin-tv/jellyplug-lite build
 * (also the fix when an esbuild version bump churns minify output).
 */
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

async function main() {
  const builder = await import("./build-lite.mjs");
  const fresh = await builder.buildLite();

  const distPath = path.join(__dirname, "..", "dist", "lite.min.js");
  assert.ok(
    fs.existsSync(distPath),
    "dist/lite.min.js missing — run the build and commit it",
  );
  const committed = fs.readFileSync(distPath, "utf8");

  assert.strictEqual(
    committed,
    fresh,
    "dist/lite.min.js is stale relative to src/lite.src.js — rebuild + commit",
  );

  const bytes = Buffer.byteLength(committed);
  assert.ok(
    bytes <= builder.BUDGET_BYTES,
    `dist/lite.min.js ${bytes}B exceeds budget ${builder.BUDGET_BYTES}B`,
  );

  console.log(`OK: dist/lite.min.js fresh (${bytes} bytes)`);
}

main().catch((err) => {
  console.error("FAIL:", err.message);
  process.exit(1);
});
