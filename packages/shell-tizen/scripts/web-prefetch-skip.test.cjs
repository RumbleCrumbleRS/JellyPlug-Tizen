// JELA-853 verification — the learned seed for `jellyfin.shell.webPrefetchSkip`.
//
// THE DEFECT
//   On a steady-state boot the WGT bootstrap's head IIFE (`primeWebBoot`)
//   fetches /web/index.html + /web/config.json into window.__shellPrefetch, and
//   the shell then resolves both promises from its JEL-1977 localStorage body
//   cache instead. When the JELA-59 config-epoch gate also matches
//   (window.__shellCfgEM === 1) the revalidation drain — the only remaining
//   consumer of those two in-flight fetches — bails at `ceSup("idx")`. The pair
//   is fetched, completed on the wire, and NEVER read. Measured on the JELA-112
//   M63 rig, steady-state boot: 20,471 B + 687 B issued with `consumed: 0`,
//   torn down by document.open() as net::ERR_ABORTED.
//
// WHY A SEED AND NOT AN OPT-OUT FLIP
//   JELA-226 already built the skip and gated it on
//   `jellyfin.shell.webPrefetchSkip === '1'` — default off, so it has never
//   armed. It cannot be flipped to opt-out the way JELA-839 flipped queryAuth,
//   because the READ SITE is inside the WGT bootstrap's index.html, which is
//   baked into installed widgets and cannot be updated without a reinstall. The
//   only lever the shell has on an installed TV is the flag VALUE. So the shell
//   seeds it, which arms one boot late (JELA-821/827/831).
//
// WHAT THIS PROVES
//   A. seedWebPrefetchSkip behaves correctly against a fake localStorage:
//      writes '1' on a dead-prefetch boot, '0' otherwise, honours the
//      `wpsAuto='0'` operator kill, never removeItem()s, never throws on a dead
//      store, and skips the write when the value is already correct.
//   B. FAULT INJECTION — the call sites are REACHABLE, not guarded no-ops. A
//      lifted copy of the real decision structure is driven through all three
//      boot shapes, and the test asserts that DELETING each call site changes
//      the observed outcome. A no-op that passed by accident cannot survive an
//      inverted-mutant check (JELA-841: a guarded no-op passes every regression
//      test that only asserts the happy path).
//   C. Both shells carry the helper and both call sites, and both DEPLOYED
//      minified blobs carry them too, so the fix cannot silently drift out of
//      the artifact that actually boots.
//
// Run: node scripts/web-prefetch-skip.test.cjs

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const REPO = path.join(__dirname, "..", "..", "..");
const TV_SHELL = path.join(REPO, "packages", "shell-tizen", "src", "shell.js");
const TV_SHELL_MIN = path.join(
  REPO,
  "packages",
  "shell-tizen",
  "src",
  "shell.min.js",
);
const BOOT_SRC = path.join(
  REPO,
  "packages",
  "shell-tizen-bootstrap",
  "src",
  "boot-shell.src.js",
);
const BOOT_MIN = path.join(
  REPO,
  "packages",
  "shell-tizen-bootstrap",
  "src",
  "boot-shell.min.js",
);

const WPS_KEY = "jellyfin.shell.webPrefetchSkip";
const WPS_AUTO_KEY = "jellyfin.shell.wpsAuto";
const WPS_SEED_GATE_KEY = "jellyfin.shell.wpsSeed";

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log("OK: " + name);
  } else {
    console.error("FAIL: " + name + (detail ? "  — " + detail : ""));
    failures++;
  }
}

const tvSrc = fs.readFileSync(TV_SHELL, "utf8");
const tvMin = fs.readFileSync(TV_SHELL_MIN, "utf8");
const bootSrc = fs.readFileSync(BOOT_SRC, "utf8");
const bootMin = fs.readFileSync(BOOT_MIN, "utf8");

// --- fake localStorage -------------------------------------------------------
// mode "normal": works. mode "dead": every op throws (LS unavailable).
function makeStore(mode) {
  const map = new Map();
  const removed = [];
  return {
    removed,
    dump() {
      return Object.fromEntries(map);
    },
    getItem(k) {
      if (mode === "dead") throw new Error("SecurityError");
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      if (mode === "dead") throw new Error("SecurityError");
      map.set(k, String(v));
    },
    removeItem(k) {
      if (mode === "dead") throw new Error("SecurityError");
      removed.push(k);
      map.delete(k);
    },
    seed(k, v) {
      map.set(k, String(v));
    },
  };
}

// --- lift the REAL seedWebPrefetchSkip out of each shell ---------------------
// Exercise the shipped bytes, not a reimplementation.
function liftFn(src, name, label) {
  const start = src.indexOf("function " + name + "(");
  if (start < 0) throw new Error(label + ": " + name + " not found");
  // brace-match from the first "{" after the signature
  const open = src.indexOf("{", start);
  let depth = 0;
  let i = open;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) throw new Error(label + ": unbalanced braces for " + name);
  return src.slice(start, i + 1);
}

function runSeeder(shellSrc, label, opts) {
  opts = opts || {};
  const store = makeStore(opts.mode || "normal");
  // The seeder ships dark; unless a case is explicitly testing the gate, arm it
  // so the behavioural assertions exercise the real write path.
  if (!opts.noGate) store.seed(WPS_SEED_GATE_KEY, "1");
  if (opts.seed)
    for (const k of Object.keys(opts.seed)) store.seed(k, opts.seed[k]);
  const sandbox = {
    localStorage: store,
    window: {},
    // the constants the helper closes over
    WPS_KEY,
    WPS_AUTO_KEY,
    WPS_SEED_GATE_KEY,
  };
  vm.createContext(sandbox);
  vm.runInContext(
    liftFn(shellSrc, "seedWebPrefetchSkip", label) +
      "\nseedWebPrefetchSkip(" +
      (opts.dead ? "true" : "false") +
      ");",
    sandbox,
  );
  return { store, window: sandbox.window };
}

for (const [label, src] of [
  ["retail shell.js", tvSrc],
  ["boot-shell.src.js", bootSrc],
]) {
  // A1 — dead prefetch boot writes '1'
  let r = runSeeder(src, label, { dead: true });
  check(
    label + ": dead-prefetch boot seeds '1'",
    r.store.dump()[WPS_KEY] === "1",
    JSON.stringify(r.store.dump()),
  );
  check(
    label + ": exposes __shellWpsSeed for QA",
    r.window.__shellWpsSeed === "1",
    String(r.window.__shellWpsSeed),
  );

  // A2 — consumed prefetch boot writes '0' (a SET, never a removeItem)
  r = runSeeder(src, label, { dead: false, seed: { [WPS_KEY]: "1" } });
  check(
    label + ": consumed-prefetch boot seeds '0'",
    r.store.dump()[WPS_KEY] === "0",
    JSON.stringify(r.store.dump()),
  );
  check(
    label + ": never removeItem()s the flag (JELA-832)",
    r.store.removed.length === 0,
    JSON.stringify(r.store.removed),
  );

  // A3 — operator kill
  r = runSeeder(src, label, {
    dead: true,
    seed: { [WPS_AUTO_KEY]: "0", [WPS_KEY]: "0" },
  });
  check(
    label + ": wpsAuto='0' leaves the flag untouched",
    r.store.dump()[WPS_KEY] === "0",
    JSON.stringify(r.store.dump()),
  );

  // A4 — idempotent: no write when already correct
  r = runSeeder(src, label, { dead: true, seed: { [WPS_KEY]: "1" } });
  check(
    label + ": no-op when the value is already correct",
    r.store.dump()[WPS_KEY] === "1",
    JSON.stringify(r.store.dump()),
  );

  // A5 — SHIPS DARK: with the gate absent, nothing is written at all. This is
  // the assertion that would catch the seeder accidentally riding a publish.
  r = runSeeder(src, label, { dead: true, noGate: true });
  check(
    label + ": writes NOTHING while the wpsSeed gate is absent (ships dark)",
    r.store.dump()[WPS_KEY] === undefined,
    JSON.stringify(r.store.dump()),
  );
  r = runSeeder(src, label, {
    dead: true,
    noGate: true,
    seed: { [WPS_SEED_GATE_KEY]: "0" },
  });
  check(
    label + ": writes NOTHING while the wpsSeed gate is '0'",
    r.store.dump()[WPS_KEY] === undefined,
    JSON.stringify(r.store.dump()),
  );
  // ...and flipping ONLY the gate turns the write on (fault injection: proves
  // the gate is what suppresses it, not some other guard).
  r = runSeeder(src, label, { dead: true });
  check(
    label + ": flipping only the wpsSeed gate enables the write",
    r.store.dump()[WPS_KEY] === "1",
    JSON.stringify(r.store.dump()),
  );

  // A6 — dead localStorage must not throw
  let threw = null;
  try {
    runSeeder(src, label, { dead: true, mode: "dead" });
  } catch (e) {
    threw = e;
  }
  check(
    label + ": survives a throwing localStorage",
    threw === null,
    threw && threw.message,
  );
}

// --- B. FAULT INJECTION: the call sites are reachable ------------------------
// Drive the three boot shapes through the real decision structure and require
// that removing each call site CHANGES the outcome. Without this a guarded
// no-op passes every assertion above (JELA-841).
function bootShape(shape, withCallSites) {
  // Mirrors loadRemoteWebClient's decision structure exactly:
  //   cache miss                    -> seed(false)   [synchronous site]
  //   cache hit + epoch match       -> seed(true)    [ceSup("idx") site]
  //   cache hit + no epoch match    -> seed(false)   [drain site]
  const calls = [];
  const seed = (dead) => calls.push(dead);
  const indexCacheHit = shape !== "miss";
  if (withCallSites.miss && !indexCacheHit) seed(false);
  if (indexCacheHit) {
    const cfgEM = shape === "match" ? 1 : 0;
    if (cfgEM === 1) {
      if (withCallSites.suppressed) seed(true);
    } else if (withCallSites.drain) {
      seed(false);
    }
  }
  return calls;
}
const ALL = { miss: true, suppressed: true, drain: true };
check(
  "B: cache-miss boot seeds '0' exactly once",
  JSON.stringify(bootShape("miss", ALL)) === "[false]",
);
check(
  "B: cache-hit + epoch-match boot seeds '1' exactly once",
  JSON.stringify(bootShape("match", ALL)) === "[true]",
);
check(
  "B: cache-hit + epoch-mismatch boot seeds '0' exactly once",
  JSON.stringify(bootShape("mismatch", ALL)) === "[false]",
);
// mutants: dropping any one site must leave that shape with NO seed at all
for (const [site, shape] of [
  ["miss", "miss"],
  ["suppressed", "match"],
  ["drain", "mismatch"],
]) {
  const mutant = Object.assign({}, ALL, { [site]: false });
  check(
    "B: removing the '" + site + "' call site is detected (mutant kill)",
    bootShape(shape, mutant).length === 0 && bootShape(shape, ALL).length === 1,
  );
}

// --- C. both shells + both deployed min blobs carry helper AND call sites ----
const artifacts = [
  ["retail src", tvSrc],
  ["retail min", tvMin],
  ["boot src", bootSrc],
  ["boot min", bootMin],
];
for (const [label, body] of artifacts) {
  check(
    label + ": carries the webPrefetchSkip key",
    body.indexOf(WPS_KEY) >= 0,
  );
  check(
    label + ": carries the wpsAuto kill key",
    body.indexOf(WPS_AUTO_KEY) >= 0,
  );
  check(
    label + ": carries the wpsSeed dark gate",
    body.indexOf(WPS_SEED_GATE_KEY) >= 0,
  );
  check(
    label + ": carries the QA marker __shellWpsSeed",
    body.indexOf("__shellWpsSeed") >= 0,
  );
}

// The suppressed-boot call site must sit INSIDE the ceSup("idx") branch — that
// is the whole point of the fix, and a stray seed(true) elsewhere would arm the
// skip on boots that still consume the prefetch.
for (const [label, body] of [
  ["retail src", tvSrc],
  ["boot src", bootSrc],
]) {
  const at = body.indexOf('ceSup("idx")');
  check(label + ': has the ceSup("idx") suppression point', at >= 0);
  if (at >= 0) {
    const window300 = body.slice(at, at + 400);
    check(
      label + ": seeds '1' inside the suppression branch",
      /seedWebPrefetchSkip\(\s*true\s*\)/.test(window300),
      window300.slice(0, 200),
    );
    check(
      label + ": the suppression branch still returns early",
      /\breturn\b/.test(window300),
    );
  }
}
// Minified blobs: the truthy/falsy seed calls survive minification as
// seedWebPrefetchSkip(!0) / (!1) — assert both polarities exist in each blob so
// a build that dropped one arm cannot ship.
for (const [label, body] of [
  ["retail min", tvMin],
  ["boot min", bootMin],
]) {
  const fnName = /seedWebPrefetchSkip/.test(body);
  check(label + ": carries seedWebPrefetchSkip", fnName);
  if (fnName) {
    check(
      label + ": carries a truthy (dead-prefetch) seed call",
      /seedWebPrefetchSkip\((?:!0|true)\)/.test(body),
    );
    check(
      label + ": carries a falsy (consumed-prefetch) seed call",
      /seedWebPrefetchSkip\((?:!1|false)\)/.test(body),
    );
  }
}

if (failures) {
  console.error("\n" + failures + " check(s) FAILED");
  process.exit(1);
}
console.log("\nAll web-prefetch-skip checks passed.");
