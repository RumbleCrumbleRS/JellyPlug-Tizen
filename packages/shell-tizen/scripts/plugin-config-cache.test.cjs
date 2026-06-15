// JEL-178 regression test — the transpile cache must key on a plugin script's
// content-version query so that toggling a plugin's config (which regenerates
// the served body and bumps its ?v= token) cache-MISSES on the TV instead of
// replaying a stale transpiled body.
//
// Background. The shell fetches + Babel-transpiles legacy-incompatible plugin
// scripts and caches the result in localStorage keyed by txKey(url). The
// JavaScript Injector serves every enabled snippet concatenated into one file:
//
//   /JavaScriptInjector/public.js?v=<.NET config ticks>
//
// When the user disables a snippet (e.g. the Apple TV / Prime / Hulu rows),
// the server regenerates public.js (fewer snippets) and bumps the ?v= ticks.
// The browser honours that via its HTTP cache and drops the snippet. The TV
// has no such cache — it relies on txKey() to notice the change. JEL-554 v35
// stripped the ENTIRE query from the key (to stop JellyfinEnhanced's
// ?v=<Date.now()> sub-module URLs from missing every cold boot), which made
// every public.js revision collide on the same slot: the disabled snippets
// kept executing on TV. JEL-178 narrows the strip to ONLY the per-load
// epoch-ms buster, so config-version tokens once again invalidate the cache.
//
// This test lifts the SHIPPING keyers from source (widget-side txKey + the
// seed-side __txKey string in both the TV shell and the bootstrap shell),
// proves they are behaviourally identical (JEL-26 lockstep), and pins the
// config-invalidation contract on the real plugin URL shapes.
//
// Run: node scripts/plugin-config-cache.test.cjs

const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..", "..", "..");
const TV_SHELL = path.join(REPO, "packages", "shell-tizen", "src", "shell.js");
const BOOT_SHELL = path.join(
  REPO,
  "packages",
  "shell-tizen-bootstrap",
  "src",
  "boot-shell.src.js",
);

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log("OK: " + name);
  } else {
    console.error("FAIL: " + name + (detail ? " — " + detail : ""));
    failures++;
  }
}

// --- Lift the real keyers from source ---------------------------------------

// Widget-side: a plain `function txKey(url){...}` declaration. Brace-match it.
function extractFnDecl(src, name, label) {
  const start = src.indexOf("function " + name + "(");
  if (start === -1) throw new Error(label + ": " + name + " not found");
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(label + ": could not close " + name);
}

// Seed-side: the function ships as ONE quoted string array-element. Eval the
// literal to recover the verbatim function source.
function liftSeedFn(src, name, label) {
  for (const ln of src.split("\n")) {
    const t = ln.trim();
    if (t.includes("function " + name + "(") && /^['"]/.test(t)) {
      // eslint-disable-next-line no-eval
      return eval(t.replace(/,\s*$/, ""));
    }
  }
  throw new Error(label + ": seed fn " + name + " not found");
}

function compile(declSrc, fnName) {
  // eslint-disable-next-line no-new-func
  return new Function(declSrc + "\nreturn " + fnName + ";")();
}

const tvSrc = fs.readFileSync(TV_SHELL, "utf8");
const bootSrc = fs.readFileSync(BOOT_SHELL, "utf8");

const keyers = {
  "TV widget-side txKey": compile(
    extractFnDecl(tvSrc, "txKey", "TV shell"),
    "txKey",
  ),
  "TV seed-side __txKey": compile(
    liftSeedFn(tvSrc, "__txKey", "TV shell"),
    "__txKey",
  ),
  "bootstrap seed-side __txKey": compile(
    liftSeedFn(bootSrc, "__txKey", "bootstrap shell"),
    "__txKey",
  ),
};

// --- Contract cases ----------------------------------------------------------

const NOW = Date.now();
const DAY = 864e5;

// Same path, two different .NET config-ticks revisions (snippet enabled vs
// disabled). These MUST land on different cache keys.
const INJ = "https://srv/JavaScriptInjector/public.js";
const INJ_REV_A = INJ + "?v=639171366085089023";
const INJ_REV_B = INJ + "?v=639171999999999999";

// HomeScreen ships ?v=<plugin version>&c=N — version bump must invalidate.
const HS = "https://srv/HomeScreen/home-screen-sections.js";
const HS_A = HS + "?v=2.5.11.0&c=3";
const HS_B = HS + "?v=2.6.0.0&c=3";

// JellyfinEnhanced sub-module with a per-load Date.now() buster: content is
// stable across boots, so two boots MUST share one key (the JEL-554 perf win).
const JE = "https://srv/JellyfinEnhanced/translations.js";
const JE_BOOT1 = JE + "?v=" + NOW;
const JE_BOOT2 = JE + "?v=" + (NOW + 7000);

// A stale buster from long ago is NOT a current per-load value — keep it (it
// behaves like an opaque version token, can't be confused with "now").
const JE_OLD = JE + "?v=" + (NOW - 30 * DAY);

for (const [label, txKey] of Object.entries(keyers)) {
  check(
    label + ": JS-Injector config change → different key (was the bug)",
    txKey(INJ_REV_A) !== txKey(INJ_REV_B),
    txKey(INJ_REV_A) + " vs " + txKey(INJ_REV_B),
  );
  check(
    label + ": JS-Injector ticks are KEPT in the key",
    txKey(INJ_REV_A).indexOf("639171366085089023") !== -1,
    txKey(INJ_REV_A),
  );
  check(
    label + ": HomeScreen version bump → different key",
    txKey(HS_A) !== txKey(HS_B),
  );
  check(
    label + ": JellyfinEnhanced Date.now() buster → stable key across boots",
    txKey(JE_BOOT1) === txKey(JE_BOOT2),
    txKey(JE_BOOT1) + " vs " + txKey(JE_BOOT2),
  );
  check(
    label + ": JE buster is stripped (key has no query)",
    txKey(JE_BOOT1) === JE,
    txKey(JE_BOOT1),
  );
  check(
    label + ": a far-past timestamp is NOT treated as a live buster",
    txKey(JE_OLD).indexOf(String(NOW - 30 * DAY)) !== -1,
    txKey(JE_OLD),
  );
  check(label + ": query-less URL is untouched", txKey(INJ) === INJ);
  check(
    label + ": self-invalidating — new key never equals a v35 stripped path",
    txKey(INJ_REV_A) !== INJ,
  );
}

// --- Lockstep: all three keyers must agree on every input -------------------
const probes = [
  INJ_REV_A,
  INJ_REV_B,
  HS_A,
  HS_B,
  JE_BOOT1,
  JE_OLD,
  INJ,
  "https://srv/NotifySync/client.js",
  "https://srv/JellyfinEnhanced/script?v=11.12.0.0-639167216800000000",
  "https://srv/x.js?a=1&v=" + NOW + "&c=2",
];
const ks = Object.entries(keyers);
for (const u of probes) {
  const ref = ks[0][1](u);
  for (let i = 1; i < ks.length; i++) {
    check(
      'lockstep on "' + u + '": ' + ks[i][0] + " == " + ks[0][0],
      ks[i][1](u) === ref,
      ks[i][1](u) + " vs " + ref,
    );
  }
}

if (failures) {
  console.error("\n" + failures + " check(s) FAILED");
  process.exit(1);
}
console.log("\nAll plugin-config-cache checks passed.");
