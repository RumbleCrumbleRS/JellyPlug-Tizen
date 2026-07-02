// JEL-178 regression: a plugin script whose body is config-mutable (the JS
// Injector is the reported example, but this is GENERAL — any plugin that
// serves a cache-busted `?v=<tick/version>` script) must reflect the current
// server content on TV, exactly like the browser. An earlier fix special-cased
// the JS-Injector path by name; this pins the PLUGIN-AGNOSTIC design:
//
//   1. A query-bearing script URL is served from the version-keyed cache ONLY
//      when a kept query token pins the content version (JEL-619: config
//      ticks / dotted version / hash — see plugin-fetch-cache.test.cjs).
//      A URL with no version signal (static marker like ?_jsi=1) is NEVER
//      served from cache — its body is config-mutable and nothing tracks it.
//   2. Any version-key MISS is fetched with a per-fetch unique cache-buster
//      (the M63 WebView ignores fetch cache:"no-store"), so the network read
//      is always current.
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
  // JEL-197 sanctions exactly ONE plugin-named token in logic: the JS-Injector
  // snippet-channel path constant (the deliberate cutover wiring that replaces
  // the Shell Loader .NET plugin — parent JEL-196). Strip that single constant
  // before the agnosticism check so the cache/transpile LOGIC is still proven
  // plugin-agnostic, while the channel constant is explicitly allowed here.
  const code = stripComments(src).replace(
    /JSI_PUBLIC_PATH\s*=\s*["']\/JavaScriptInjector\/public\.js["']/g,
    "JSI_PUBLIC_PATH = <jel197-channel-path>",
  );

  // 1. No plugin named in the cache/transpile LOGIC (general fix, not a patch).
  check(
    label + ": no plugin name in cache/transpile logic (general fix)",
    code.indexOf("JavaScriptInjector") < 0,
    "found 'JavaScriptInjector' outside comments + the sanctioned JEL-197 path",
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

// 6. JEL-182: TX_CACHE_EPOCH must be byte-identical across both shells. It is
// salted into TX_VER -> TX_PFX; if the two shells diverge they compute
// different cache prefixes and stop sharing transpile-cache entries on a shared
// origin/localStorage (and one shell can miss a legacy-flush bump). A
// single-sided bump must fail CI. (PR #8 bumped only boot-shell to jel178-2.)
function epochOf(file) {
  const src = fs.readFileSync(file, "utf8");
  const m = src.match(/TX_CACHE_EPOCH\s*=\s*"([^"]*)"/);
  return m ? m[1] : null;
}
const shellEpoch = epochOf(SHELL);
const bootEpoch = epochOf(BOOT);
check(
  "TX_CACHE_EPOCH literal present in shell.js",
  shellEpoch !== null,
  "could not find TX_CACHE_EPOCH in shell.js",
);
check(
  "TX_CACHE_EPOCH literal present in boot-shell.src.js",
  bootEpoch !== null,
  "could not find TX_CACHE_EPOCH in boot-shell.src.js",
);
check(
  "TX_CACHE_EPOCH is in lockstep across both shells",
  shellEpoch !== null && shellEpoch === bootEpoch,
  "shell.js=" + shellEpoch + " vs boot-shell.src.js=" + bootEpoch,
);

if (failures) {
  console.error("\nJEL-178 jsi-no-cache verification FAILED: " + failures);
  process.exit(1);
}
console.log("\nAll JEL-178 jsi-no-cache (general) checks passed.");
