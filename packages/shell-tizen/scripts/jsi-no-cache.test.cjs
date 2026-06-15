// JEL-178 regression: the JS-Injector public.js/private.js bundles are
// config-mutable (enabling/disabling a snippet regenerates the body but the
// served ?v= is a per-render .NET tick, not a content hash). They must NEVER be
// served from any shell cache or the WebView HTTP cache, or a disabled snippet
// keeps rendering on TV (and a re-enabled one fails to appear) — the exact
// JEL-178 symptom reproduced on a physical M63.
//
// This pins the fix across BOTH shells (shell.js widget-side + boot-shell.src.js
// hosted/baked): every transpile-cache read/write path skips JS-Injector URLs,
// the fetch uses cache:"no-store" for them, and the web-index HTML cache refuses
// to persist a document with a JS-Injector bundle inlined.
//
// Run: node scripts/jsi-no-cache.test.cjs

const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..", "..", "..");
const SHELL = path.join(REPO, "packages", "shell-tizen", "src", "shell.js");
const BOOT = path.join(
  REPO,
  "packages",
  "shell-tizen-bootstrap",
  "src",
  "boot-shell.src.js",
);

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log("OK: " + name);
  else {
    console.error("FAIL: " + name + (detail ? "  — " + detail : ""));
    failures++;
  }
}

// Both shells skip JS-Injector with a `(public|private)` URL-pattern guard.
// Seed strings escape the slashes (`\\/`), real functions don't (`\/`), so
// match on the escaping-agnostic `(public|private)` alternation that nothing
// else in the file uses.
const GUARD = /\(public\|private\)/g;

for (const [label, file] of [
  ["shell.js", SHELL],
  ["boot-shell.src.js", BOOT],
]) {
  const src = fs.readFileSync(file, "utf8");

  // Cache read/write skips: __txGet, __txSet, txGetStatic, txSetStatic each
  // early-out for a JS-Injector URL; the fetch adds one more; so does the
  // web-index guard / fast-path. Require a healthy floor across the shell.
  const guards = (src.match(GUARD) || []).length;
  check(
    label + ": carries the JS-Injector skip guards (cache + fetch paths)",
    guards >= 5,
    "found " + guards,
  );

  check(
    label + ": __txGet skips JS-Injector before the cache read",
    /function __txGet\(src\)\{if\(\/JavaScriptInjector.*?return null;/.test(
      src,
    ),
  );
  check(
    label + ": __txSet skips JS-Injector (no cache write)",
    /function __txSet\(src,body\)\{if\(\/JavaScriptInjector.*?return;/.test(
      src,
    ),
  );
  check(
    label + ": txGetStatic skips JS-Injector",
    /function txGetStatic\(url\) \{[\s\S]{0,80}?\(public\|private\)[\s\S]{0,40}?return null;/.test(
      src,
    ),
  );
  check(
    label + ": txSetStatic skips JS-Injector",
    /function txSetStatic\(url, body\) \{[\s\S]{0,80}?\(public\|private\)[\s\S]{0,30}?return;/.test(
      src,
    ),
  );
  check(
    label + ': fetches JS-Injector with cache:"no-store"',
    /cache:\s*"no-store"/.test(src),
  );
  check(
    label + ": web-index cache refuses HTML with a JS-Injector bundle inlined",
    src.indexOf("JavaScriptInjector/public") >= 0 &&
      src.indexOf("JavaScriptInjector/private") >= 0,
  );
}

if (failures) {
  console.error("\nJEL-178 jsi-no-cache verification FAILED: " + failures);
  process.exit(1);
}
console.log("\nAll JEL-178 jsi-no-cache checks passed.");
