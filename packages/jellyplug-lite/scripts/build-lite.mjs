// Build lite.min.js from src/lite.src.js.
//
// Same discipline as shell-tizen's build_shell_min.py: esbuild with
// whitespace+syntax minify only, mangle OFF (public symbols like
// window.JellyPlugLite and the create*() factories stay greppable on
// device). Enforces a size budget — the whole Lite pitch (JELA-67) is
// ~100KB of purpose-built ES5 instead of the multi-MB SPA bundle, and
// the JELA-66 localStorage byte-cache rail that delivers it has finite
// headroom.
//
// dist/lite.min.js is COMMITTED (JELA-67 M1 slice 2): the server plugin
// embeds it as a resource exactly like shell-tizen/src/shell.min.js, so
// the repo must always carry the bytes the plugin will serve.
// dist-freshness.test.cjs fails CI when the committed blob goes stale
// relative to src/lite.src.js (or an esbuild bump churns the output —
// re-run `pnpm --filter @jellyfin-tv/jellyplug-lite build` either way).

import { transform } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(pkgRoot, "src", "lite.src.js");
export const out = join(pkgRoot, "dist", "lite.min.js");

export const BUDGET_BYTES = 96 * 1024;

// Pure build: source text -> minified text. Shared by the CLI below and
// dist-freshness.test.cjs so the two can never drift on esbuild options.
export async function buildLite() {
  const result = await transform(readFileSync(src, "utf8"), {
    loader: "js",
    // Pin the OUTPUT syntax. Without a target, minifySyntax "upgrades"
    // constructs to the newest equivalent — it rewrote `catch(e){` as the
    // ES2019 optional catch binding `catch{`, which the Q60R's ES2018-max
    // M63 engine refuses with "SyntaxError: Unexpected token {" (found
    // on-device, JELA-67 slice-2 QA). Input is ES5, so es5 out = no
    // upgrades and nothing to lower. es5-guard.test.cjs now scans the
    // dist blob too, so this class of build-introduced syntax fails CI.
    target: "es5",
    minifyWhitespace: true,
    minifySyntax: true,
    minifyIdentifiers: false,
    legalComments: "inline",
  });
  return result.code;
}

const isCli = process.argv[1] === fileURLToPath(import.meta.url);
if (isCli) {
  const code = await buildLite();
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, code);
  const bytes = Buffer.byteLength(code);
  console.log(`lite.min.js: ${bytes} bytes (budget ${BUDGET_BYTES})`);
  if (bytes > BUDGET_BYTES) {
    console.error("lite.min.js exceeds the size budget");
    process.exit(1);
  }
}
