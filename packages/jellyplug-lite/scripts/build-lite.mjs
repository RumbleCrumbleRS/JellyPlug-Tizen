// Build lite.min.js from src/lite.src.js.
//
// Same discipline as shell-tizen's build_shell_min.py: esbuild with
// whitespace+syntax minify only, mangle OFF (public symbols like
// window.JellyPlugLite and the create*() factories stay greppable on
// device). Enforces a size budget — the whole Lite pitch (JELA-67) is
// ~100KB of purpose-built ES5 instead of the multi-MB SPA bundle, and
// the JELA-66 localStorage byte-cache rail that delivers it has finite
// headroom.

import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(pkgRoot, "src", "lite.src.js");
const out = join(pkgRoot, "dist", "lite.min.js");

const BUDGET_BYTES = 96 * 1024;

const result = await build({
  entryPoints: [src],
  outfile: out,
  bundle: false,
  minifyWhitespace: true,
  minifySyntax: true,
  minifyIdentifiers: false,
  legalComments: "inline",
  write: true,
});

if (result.errors.length) {
  console.error(result.errors);
  process.exit(1);
}

const bytes = readFileSync(out).length;
console.log(`lite.min.js: ${bytes} bytes (budget ${BUDGET_BYTES})`);
if (bytes > BUDGET_BYTES) {
  console.error("lite.min.js exceeds the size budget");
  process.exit(1);
}
