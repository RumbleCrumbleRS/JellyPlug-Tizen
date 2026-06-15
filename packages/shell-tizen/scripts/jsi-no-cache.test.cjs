// JEL-178 regression: a plugin script whose body is config-mutable (the JS
// Injector is the reported example, but this is GENERAL — any plugin that
// serves a cache-busted `?v=<tick/version>` script) must reflect the current
// server content on TV, exactly like the browser. An earlier fix special-cased
// the JS-Injector path by name; this pins the PLUGIN-AGNOSTIC design:
//
//   1. Query-bearing (cache-busted) script URLs are NOT served from the URL
//      transpile cache (their path doesn't change when content does).
//   2. They are fetched with a per-fetch unique cache-buster (the M63 WebView
//      ignores fetch cache:"no-store"), so the network read is always current.
//   3. The transpile result is cached by a HASH OF THE SOURCE (`txc:`+fnv1a),
//      so unchanged content reuses the cached transpile (no Babel re-run) while
//      any content change yields a new key (re-transpile) — for every plugin,
//      no plugin named.
//   4. The web-index HTML cache refuses to persist a document that has a
//      transpiled plugin script inlined (would replay a stale snapshot).
//
// CRITICAL: the cache/transpile LOGIC must not name a specific plugin.
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

// Strip comments so we can assert no plugin name leaks into LOGIC (comments may
// still reference the JS Injector as an example).
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
}

for (const [label, file] of [
  ["shell.js", SHELL],
  ["boot-shell.src.js", BOOT],
]) {
  const src = fs.readFileSync(file, "utf8");
  const code = stripComments(src);

  // 1. No plugin named in the cache/transpile LOGIC (general fix, not a patch).
  check(
    label + ": no plugin name in cache/transpile logic (general fix)",
    code.indexOf("JavaScriptInjector") < 0,
    "found 'JavaScriptInjector' outside comments",
  );

  // 2. Volatility keyed off the URL query, not a plugin name.
  check(
    label + ': keys volatility off the URL query (indexOf("?"))',
    /indexOf\("\?"\)\s*>=\s*0/.test(code),
  );

  // 3. Transpile result is content-addressed (hash of the fetched source).
  check(
    label + ": transpile cache is content-addressed (txc: + txFnv1a(code))",
    /txc:/.test(code) && /txFnv1a\(code\)/.test(code),
  );

  // 4. Volatile fetch carries a per-fetch unique cache-buster.
  check(
    label + ": volatile fetch appends a unique cache-buster (__sb / __sbN)",
    /__sb=/.test(code) && /__sbN/.test(code),
  );

  // 5. web-index HTML cache refuses HTML with a transpiled plugin inlined.
  check(
    label + ": web-index cache skips HTML with a transpiled inline",
    /indexOf\("data-shell-transpiled-from"\)/.test(code),
  );
}

if (failures) {
  console.error("\nJEL-178 jsi-no-cache verification FAILED: " + failures);
  process.exit(1);
}
console.log("\nAll JEL-178 jsi-no-cache (general) checks passed.");
