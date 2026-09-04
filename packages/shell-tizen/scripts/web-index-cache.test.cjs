// JEL-57 verification — Web index cache (stale-while-revalidate for
// /web/index.html), compared TV-shell vs hosted/browser-shell.
//
// What the issue asks us to prove (gate flag jellyfin.shell.indexCache —
// default-on since JEL-622; '0' opts out):
//   1. First boot fetches /web/index.html and caches the body in localStorage
//      under `jellyfin.shell.webIndexHtml`.
//   2. Second boot resolves the index from cache immediately and fires a
//      background revalidation that refreshes localStorage for next boot.
//   3. Origin mismatch OR a shell version bump invalidates the cache.
//   4. Bodies > 256 KB or < 1 KB are rejected (never cached).
//   + The cached boot must save measurable time vs the uncached boot.
//
// STRATEGY — exercise the SHIPPED code, not a reimplementation. There is no DOM
// test runner in this repo, so we (a) lift the FIVE real cache functions
// (`webCacheEnabled`, `readWebIndexCache`, `writeWebIndexCache`,
// `readWebConfigCache`, `writeWebConfigCache`) verbatim out of each shell's
// source and run them inside a `vm` sandbox backed by a fake localStorage —
// this proves invariants 1/3/4 behaviourally against the actual bytes that
// ship; and (b) source-assert the stale-while-revalidate boot wiring (the
// `indexCacheHit ? Promise.resolve(cachedIndex.body) : fetch…` fork plus the
// background revalidation) on BOTH shells, which is invariant 2 and the
// "measurable time difference" claim.
//
// WHY "TV vs browser" REDUCES TO A SOURCE/BEHAVIOUR CHECK
//   Every cache function uses only `localStorage`, `JSON`, `Date.now()` and (in
//   the boot fork) `fetch`. NONE branch on `tizen`/`webapis`. So the TV and a
//   desktop browser running the same shell cache, read, invalidate and
//   revalidate IDENTICALLY by construction. The test asserts that no cache
//   function references a Tizen-only global, which is what makes the behavioural
//   proof below a complete TV-vs-browser parity proof.
//
// TWO SHELLS, ONE CONTRACT
//   The retail artifact that boots on the TV is the BOOTSTRAP
//   (boot-shell.src.js / .min.js); the full shell (shell.js / .min.js) carries
//   its own copy of the same cache layer. Both are exercised here, and the
//   deployed minified blobs are source-checked so they cannot silently drift.
//
// Run: node scripts/web-index-cache.test.cjs
//   or: pnpm --filter @jellyfin-tv/shell-tizen test

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

const GATE_KEY = "jellyfin.shell.indexCache";
const INDEX_KEY = "jellyfin.shell.webIndexHtml";
const CONFIG_KEY = "jellyfin.shell.webConfig";
const CACHE_MAX = 262144; // 256 KB

let failures = 0;
let notes = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log("OK: " + name);
  } else {
    console.error("FAIL: " + name + (detail ? "  — " + detail : ""));
    failures++;
  }
}
function note(msg) {
  console.log("  NOTE: " + msg);
  notes++;
}

const tvSrc = fs.readFileSync(TV_SHELL, "utf8");
const tvMin = fs.readFileSync(TV_SHELL_MIN, "utf8");
const bootSrc = fs.readFileSync(BOOT_SRC, "utf8");
const bootMin = fs.readFileSync(BOOT_MIN, "utf8");

// --- Fake localStorage mimicking the browser Storage contract ---------------
function makeStore() {
  const map = new Map();
  let throwMode = false;
  const ls = {
    getItem(k) {
      if (throwMode) throw new Error("storage disabled");
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      if (throwMode) throw new Error("storage disabled");
      map.set(k, String(v));
    },
    removeItem(k) {
      if (throwMode) throw new Error("storage disabled");
      map.delete(k);
    },
  };
  return {
    ls,
    raw: map,
    setThrow(v) {
      throwMode = v;
    },
  };
}

// Extract a `function NAME(...) { ... }` body verbatim by brace-walking.
function extractFn(src, name, label) {
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

function constVal(src, name, label) {
  const m = src.match(new RegExp(name + '\\s*=\\s*"([^"]*)"'));
  if (!m) throw new Error(label + ": const " + name + " not found");
  return m[1];
}

// Lift the REAL cache functions out of a shell's source into a sandbox backed
// by `store`, with the shell's own constant values declared as the closure
// would have them. The behaviour under test is the shipped code.
function loadCache(src, label, store) {
  const indexKey = constVal(src, "WEB_INDEX_CACHE_KEY", label);
  const configKey = constVal(src, "WEB_CONFIG_CACHE_KEY", label);
  const ver = constVal(src, "WEB_CACHE_VER", label);
  const gateKey = constVal(src, "WEB_CACHE_GATE_KEY", label);
  const maxM = src.match(/WEB_CACHE_MAX\s*=\s*(\d+)/);
  if (!maxM) throw new Error(label + ": WEB_CACHE_MAX not found");

  const preamble =
    "var WEB_INDEX_CACHE_KEY = " +
    JSON.stringify(indexKey) +
    ", WEB_CONFIG_CACHE_KEY = " +
    JSON.stringify(configKey) +
    ", WEB_CACHE_VER = " +
    JSON.stringify(ver) +
    ", WEB_CACHE_MAX = " +
    maxM[1] +
    ", WEB_CACHE_GATE_KEY = " +
    JSON.stringify(gateKey) +
    ";\n";

  const code =
    preamble +
    extractFn(src, "webCacheEnabled", label) +
    "\n" +
    extractFn(src, "readWebIndexCache", label) +
    "\n" +
    extractFn(src, "writeWebIndexCache", label) +
    "\n" +
    extractFn(src, "readWebConfigCache", label) +
    "\n" +
    extractFn(src, "writeWebConfigCache", label) +
    "\n" +
    "globalThis.__c = { webCacheEnabled, readWebIndexCache, writeWebIndexCache, readWebConfigCache, writeWebConfigCache, INDEX_KEY: WEB_INDEX_CACHE_KEY, CONFIG_KEY: WEB_CONFIG_CACHE_KEY, VER: WEB_CACHE_VER, GATE_KEY: WEB_CACHE_GATE_KEY, MAX: WEB_CACHE_MAX };";

  const sandbox = { localStorage: store.ls, JSON, Date, globalThis: {} };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.__c;
}

// A realistic Jellyfin index.html body (>1 KB, contains <html). 4 KB.
const ORIGIN_A = "https://demo.jellyfin.org";
const ORIGIN_B = "https://other.example.com";
const HTML_OK =
  "<!DOCTYPE html><html><head></head><body>" +
  "x".repeat(4000) +
  "</body></html>";
const CONFIG_OK = JSON.stringify({ multiserver: true, themes: [] });

// ============================================================================
// PART A — BEHAVIOURAL (real lifted functions, both shells)
// ============================================================================
function behavioural(src, label) {
  const store = makeStore();
  let c = loadCache(src, label, store);

  // Contract: the gate key and cache key are the canonical ones from the issue.
  check(label + ": gate key is " + GATE_KEY, c.GATE_KEY === GATE_KEY);
  check(label + ": index cache key is " + INDEX_KEY, c.INDEX_KEY === INDEX_KEY);
  check(label + ": cap is 256 KB (" + CACHE_MAX + ")", c.MAX === CACHE_MAX);

  // -- Gate semantics (JEL-622): ON by default, '0' opts out ----------------
  check(
    label + ": gate ON when unset (default-on)",
    c.webCacheEnabled() === true,
  );
  store.raw.set(GATE_KEY, "0");
  check(label + ": gate OFF when '0' (opt-out)", c.webCacheEnabled() === false);
  store.raw.set(GATE_KEY, "1");
  check(label + ": gate ON when '1'", c.webCacheEnabled() === true);
  store.raw.delete(GATE_KEY);

  // -- Invariant 1: first boot caches the fetched index body ----------------
  // Simulate the boot fork: gate on, no cache yet -> first boot writes.
  check(
    label + ": cold cache read returns null (=> first boot fetches)",
    c.readWebIndexCache(ORIGIN_A) === null,
  );
  c.writeWebIndexCache(ORIGIN_A, HTML_OK);
  check(
    label + ": writeWebIndexCache stores body under " + INDEX_KEY,
    store.raw.has(INDEX_KEY),
  );
  const stored = JSON.parse(store.raw.get(INDEX_KEY));
  check(
    label + ": stored record carries the exact index body",
    stored.body === HTML_OK,
  );
  check(
    label + ": stored record stamps origin + version",
    stored.origin === ORIGIN_A && stored.v === c.VER,
  );
  c.writeWebConfigCache(ORIGIN_A, CONFIG_OK);
  check(
    label + ": writeWebConfigCache stores config under " + CONFIG_KEY,
    store.raw.has(CONFIG_KEY),
  );

  // -- Invariant 2 (read half): second boot resolves index from cache -------
  // New process / new closures, SAME backing store — exactly what "second
  // boot" means. The boot fork resolves indexPromise from this record without
  // awaiting the network (the SWR source assertion in Part B proves the fork).
  c = loadCache(src, label, store);
  const hitIndex = c.readWebIndexCache(ORIGIN_A);
  const hitConfig = c.readWebConfigCache(ORIGIN_A);
  check(
    label + ": second boot reads index body from cache (immediate resolve)",
    hitIndex && hitIndex.body === HTML_OK,
  );
  check(
    label + ": second boot reads config and pre-parses it",
    hitConfig && hitConfig.parsed && hitConfig.parsed.multiserver === true,
  );

  // -- Invariant 3a: origin mismatch invalidates ----------------------------
  check(
    label + ": cache MISS when server origin differs (URL changed)",
    c.readWebIndexCache(ORIGIN_B) === null,
  );

  // -- Invariant 3b: shell version bump invalidates -------------------------
  // Rewrite the stored record with a bumped version, as if the previous shell
  // version had written it; the current shell must reject it.
  const bumped = JSON.parse(store.raw.get(INDEX_KEY));
  bumped.v = c.VER + "-OLD";
  store.raw.set(INDEX_KEY, JSON.stringify(bumped));
  check(
    label + ": cache MISS when stored version != current shell version",
    c.readWebIndexCache(ORIGIN_A) === null,
  );
  // Restore a valid record for subsequent independence.
  c.writeWebIndexCache(ORIGIN_A, HTML_OK);

  // -- Invariant 4: size bounds ---------------------------------------------
  const store4 = makeStore();
  const c4 = loadCache(src, label, store4);
  // < 1 KB rejected
  c4.writeWebIndexCache(ORIGIN_A, "<html>" + "y".repeat(500) + "</html>");
  check(
    label + ": body < 1 KB rejected (truncated/error response)",
    !store4.raw.has(INDEX_KEY),
  );
  // > 256 KB rejected
  c4.writeWebIndexCache(
    ORIGIN_A,
    "<html>" + "z".repeat(CACHE_MAX + 10) + "</html>",
  );
  check(
    label + ": body > 256 KB rejected (LS quota guard)",
    !store4.raw.has(INDEX_KEY),
  );
  // Non-HTML body of valid size rejected (extra guard against poisoning).
  c4.writeWebIndexCache(ORIGIN_A, "p".repeat(5000));
  check(
    label + ": valid-size body without <html marker rejected",
    !store4.raw.has(INDEX_KEY),
  );
  // Valid-size HTML accepted.
  c4.writeWebIndexCache(ORIGIN_A, HTML_OK);
  check(
    label + ": valid-size HTML body (4 KB, has <html) accepted",
    store4.raw.has(INDEX_KEY),
  );

  // -- Resilience: a throwing Storage must never crash boot -----------------
  const bad = makeStore();
  const cb = loadCache(src, label, bad);
  bad.setThrow(true);
  let threw = false;
  try {
    check(
      label + ": webCacheEnabled on broken storage returns false",
      cb.webCacheEnabled() === false,
    );
    check(
      label + ": readWebIndexCache on broken storage returns null",
      cb.readWebIndexCache(ORIGIN_A) === null,
    );
    cb.writeWebIndexCache(ORIGIN_A, HTML_OK);
    cb.writeWebConfigCache(ORIGIN_A, CONFIG_OK);
  } catch (e) {
    threw = true;
  }
  check(label + ": cache calls never throw on broken storage", !threw);
}

console.log("=== PART A: behavioural (lifted shipped functions) ===");
behavioural(tvSrc, "shell.js");
behavioural(bootSrc, "boot-shell.src.js");

// ============================================================================
// PART B — SOURCE CONTRACT (stale-while-revalidate boot wiring + parity)
// ============================================================================
console.log("");
console.log("=== PART B: source contract (SWR boot wiring, TV==browser) ===");

const SRC_SHELLS = [
  ["shell.js", tvSrc],
  ["boot-shell.src.js", bootSrc],
];
const ALL_SHELLS = SRC_SHELLS.concat([
  ["shell.min.js", tvMin],
  ["boot-shell.min.js", bootMin],
]);

// B0. The gate flag defaults ON (JEL-622): webCacheEnabled returns true unless
//     the operator opts out with exactly "0".
for (const [label, src] of SRC_SHELLS) {
  check(
    "gate flag '" + GATE_KEY + "' is default-on / '0' opts out in " + label,
    /getItem\(\s*WEB_CACHE_GATE_KEY\s*\)\s*!==?\s*"0"/.test(src),
  );
}

// B1. Invariant 2 — SWR fork: cache hit resolves the index promise IMMEDIATELY
//     (Promise.resolve(cachedIndex.body)) rather than awaiting the network.
for (const [label, src] of SRC_SHELLS) {
  check(
    "cache hit resolves index from memory (Promise.resolve(cachedIndex.body)) in " +
      label,
    /indexCacheHit\s*\?\s*Promise\.resolve\(\s*cachedIndex\.body\s*\)/.test(
      src,
    ),
  );
  check(
    "cache hit resolves config from pre-parsed cache (cachedConfig.parsed) in " +
      label,
    /Promise\.resolve\(\s*cachedConfig\.parsed\s*\)/.test(src),
  );
}

// B2. Invariant 2 — background revalidation: on a hit, the fetch pair is
//     still drained and writes the fresh body back for the NEXT boot.
//     JELA-59 restructured the drain into a shared helper gated on the
//     config-epoch promise (an epoch-MATCHED boot suppresses the pair by
//     design; every other state revalidates as before), so the check pins
//     the helper wiring: drain(thunk, cachedBody, writeBack) + the write
//     call inside the helper body.
for (const [label, src] of SRC_SHELLS) {
  check(
    "on hit, index fetch revalidates LS in background (drain -> writeWebIndexCache) in " +
      label,
    /drain\(\s*mkIdxF\s*,\s*cachedIndex\s*,\s*writeWebIndexCache\s*\)/.test(
      src,
    ) && /\bw\(\s*serverUrl\s*,\s*txt\s*\)/.test(src),
  );
  check(
    "on hit, config fetch revalidates LS in background (drain -> writeWebConfigCache) in " +
      label,
    /drain\(\s*mkCfgF\s*,\s*cachedConfig\s*,\s*writeWebConfigCache\s*\)/.test(
      src,
    ),
  );
}

// B3. "Measurable time difference": the hit path skips the network from the
//     pre-document.write critical path, and the savings are timed into a diag
//     global so on-device QA can read the actual delta.
for (const [label, src] of SRC_SHELLS) {
  check(
    "cached-vs-uncached delta is timed into a diag global (__shellIndexCacheSavedMs) in " +
      label,
    src.includes("__shellIndexCacheSavedMs"),
  );
  check(
    "cache adoption is counted for QA (__shellIndexCacheHits) in " + label,
    src.includes("__shellIndexCacheHits"),
  );
}

// B4. Invariant 1 — uncached (miss) boot records the body for the next boot.
for (const [label, src] of SRC_SHELLS) {
  check(
    "miss path records body for next boot (writeWebIndexCache on fetched txt, gated) in " +
      label,
    /cacheGateOn\s*&&?\s*\(?\s*writeWebIndexCache\(\s*serverUrl\s*,\s*txt\s*\)/.test(
      src,
    ) ||
      /if\s*\(\s*cacheGateOn\s*\)\s*\{?\s*writeWebIndexCache\(\s*serverUrl\s*,\s*txt\s*\)/.test(
        src,
      ),
  );
}

// B5. TV == browser by construction: NO cache function references a Tizen-only
//     global. This is what makes Part A a complete TV-vs-browser parity proof.
const CACHE_FNS = [
  "webCacheEnabled",
  "readWebIndexCache",
  "writeWebIndexCache",
  "readWebConfigCache",
  "writeWebConfigCache",
];
for (const [label, src] of SRC_SHELLS) {
  for (const fn of CACHE_FNS) {
    const body = extractFn(src, fn, label);
    check(
      fn + "() has no tizen/webapis branch (TV==browser) in " + label,
      !/\btizen\b|\bwebapis\b/.test(body),
    );
  }
}

// B6. Deployed minified blobs carry the same gate flag + cap so they cannot
//     drift from the source-of-record contract.
for (const [label, src] of ALL_SHELLS) {
  check(
    "deployed " + label + " references gate flag " + JSON.stringify(GATE_KEY),
    src.includes('"' + GATE_KEY + '"'),
  );
  check(
    "deployed " +
      label +
      " references index cache key " +
      JSON.stringify(INDEX_KEY),
    src.includes('"' + INDEX_KEY + '"'),
  );
  check(
    "deployed " + label + " carries the 256 KB cap (" + CACHE_MAX + ")",
    src.includes(String(CACHE_MAX)),
  );
}

// ============================================================================
// PART BX — JELA-856: publish the resolved index body for in-document readers
// ============================================================================
// The JELA-110/542 media-bar "0 ms probe" XHRs the whole server
// /web/index.html on every steady-state boot just to test for hero assets.
// That document is served `no-cache, no-store, must-revalidate`, so no HTTP
// cache can ever coalesce it — 20,406 B pre-first-card for a body the shell
// already resolved (from LS or the network) and is about to document.write.
//
// The shell half is publish-only: it exposes the RAW resolved body plus the
// origin it belongs to on `window` (which survives the document.write
// handoff), so an in-document consumer can read it instead of re-fetching.
// Nothing in the shell reads these globals — a consumer that does not find
// them keeps today's XHR path, so the change is fail-open by construction.
//
// What must hold, and what would break the consumer if it did not:
//   1. The body published is `results[0]` (RAW upstream), not the rewritten
//      `html` — the rewrites (font CSS, JE-defer strip, media-bar CDN strip)
//      would make a consumer's scan see a different document than the XHR.
//   2. The publish happens BEFORE both document.write paths (the JEL-1832
//      string fast path and the DOMParser path), or the consumer running in
//      the written document finds nothing.
//   3. The origin is published alongside, so a consumer can reject a body
//      left over from a different server URL.
//   4. It is wrapped so a throw cannot break boot.
console.log("");
console.log("=== PART BX: JELA-856 index-body publish (shell half) ===");

const PUB_HTML = "__shellWebIndexHtml";
const PUB_ORIGIN = "__shellWebIndexOrigin";

for (const [label, src] of SRC_SHELLS) {
  const body = extractFn(src, "loadRemoteWebClient", label);
  const pubAt = body.indexOf(PUB_HTML);

  check(
    "publishes the RAW resolved body on window." + PUB_HTML + " in " + label,
    new RegExp("window\\." + PUB_HTML + "\\s*=\\s*results\\[0\\]").test(body),
  );
  check(
    "publishes the server origin on window." + PUB_ORIGIN + " in " + label,
    new RegExp("window\\." + PUB_ORIGIN + "\\s*=\\s*serverUrl").test(body),
  );
  // The rewritten `html` must never be what is published — a consumer
  // scanning it would see the shell's rewrites, not the server's document.
  check(
    "does NOT publish the rewritten html in " + label,
    !new RegExp("window\\." + PUB_HTML + "\\s*=\\s*html\\b").test(body),
  );
  // Ordering: the publish must precede BOTH document.write call sites.
  const writes = [];
  for (let i = body.indexOf("document.write("); i >= 0; ) {
    writes.push(i);
    i = body.indexOf("document.write(", i + 1);
  }
  check(
    "publish precedes both document.write paths in " + label,
    pubAt >= 0 && writes.length >= 2 && writes.every((i) => i > pubAt),
    "publishAt=" + pubAt + " writes=" + JSON.stringify(writes),
  );
  // Guarded: a throw here (a frozen window, a hostile consumer having
  // redefined the property) must not take the boot down with it.
  check(
    "publish is wrapped in try/catch in " + label,
    /try\s*\{[\s\S]{0,400}?window\.__shellWebIndexHtml[\s\S]{0,400}?\}\s*catch/.test(
      body,
    ),
  );
  // Only publish a usable body — never `undefined`/empty from a degraded
  // resolve, which a consumer could mistake for "server has no hero assets".
  check(
    "publish is guarded on a non-empty string body in " + label,
    /typeof\s+results\[0\]\s*===?\s*"string"\s*&&\s*results\[0\]\.length/.test(
      body,
    ),
  );
  // Publish-only: the shell must not grow a reader, or the fail-open
  // guarantee (absent global == today's behaviour) stops being trivial.
  check(
    "shell never READS the published globals (publish-only) in " + label,
    !new RegExp(
      "(?:if|return|=|\\()\\s*window\\." +
        PUB_HTML +
        "\\s*(?:\\)|\\|\\||&&|;|\\.)",
    ).test(src.replace(new RegExp("window\\." + PUB_HTML + "\\s*=", "g"), "")),
  );
}

// The deployed blobs must carry both globals, or the fielded shell publishes
// nothing and every consumer silently stays on the XHR path.
for (const [label, src] of ALL_SHELLS) {
  check(
    "deployed " + label + " carries " + PUB_HTML + " + " + PUB_ORIGIN,
    src.includes(PUB_HTML) && src.includes(PUB_ORIGIN),
  );
}

// ============================================================================
// PART BW — JELA-226 (WS-B3): warm-boot /web prefetch-skip (flag-dark)
// ============================================================================
// The head-IIFE prefetch (shell-tizen/src/index.html) and the bootstrap's
// primeWebBoot (shell-tizen-bootstrap/src/index.html) kick /web/index.html +
// /web/config.json before the shell parses. On an epoch-match warm boot the
// shell adopts its LS body cache and suppresses the fetch drain, so those two
// fetches are issued-but-never-consumed. WS-B3 gates them behind the opt-in
// flag jellyfin.shell.webPrefetchSkip (default off = current behaviour) + an
// inline cache-presence check, and stays provably fail-safe via the shell's
// mkIdxF/mkCfgF fresh-fetch fallback (Part B2 above).
//
// The skip decision lives in the two index.html head scripts (no DOM runner),
// so this part source-asserts the shipped gate on BOTH prefetch sites.
console.log("");
console.log("=== PART BW: WS-B3 warm-boot prefetch-skip (flag-dark) ===");

const TV_INDEX = path.join(
  REPO,
  "packages",
  "shell-tizen",
  "src",
  "index.html",
);
const BOOT_INDEX = path.join(
  REPO,
  "packages",
  "shell-tizen-bootstrap",
  "src",
  "index.html",
);
const WPS_FLAG = "jellyfin.shell.webPrefetchSkip";
const WPS_COUNTER = "__shellWebPrefetchSkipped";

const PREFETCH_SITES = [
  ["shell-tizen/index.html", fs.readFileSync(TV_INDEX, "utf8")],
  ["shell-tizen-bootstrap/index.html", fs.readFileSync(BOOT_INDEX, "utf8")],
];

for (const [label, src] of PREFETCH_SITES) {
  // BW1. Skip is behind the opt-in flag, checked for EXACTLY "1" (default off:
  //      an unset / "0" / anything-else flag keeps the current prefetch).
  check(
    "prefetch-skip is behind flag " +
      JSON.stringify(WPS_FLAG) +
      ' (=== "1") in ' +
      label,
    new RegExp(
      "getItem\\(\\s*['\"]" +
        WPS_FLAG.replace(/\./g, "\\.") +
        "['\"]\\s*\\)\\s*===\\s*['\"]1['\"]",
    ).test(src),
  );
  // BW2. Skip also requires the indexCache gate ON (!== "0") — never skip when
  //      the SWR body cache the shell would adopt is disabled.
  check(
    "prefetch-skip requires indexCache gate on (!== '0') in " + label,
    /getItem\(\s*['"]jellyfin\.shell\.indexCache['"]\s*\)\s*!==\s*['"]0['"]/.test(
      src,
    ),
  );
  // BW3. Presence check covers BOTH bodies for the current origin: it reads the
  //      webIndexHtml + webConfig records and matches p.origin against the
  //      current server URL (u in the retail IIFE, server in primeWebBoot).
  check(
    "presence check reads webIndexHtml + webConfig records in " + label,
    src.includes("jellyfin.shell.webIndexHtml") &&
      src.includes("jellyfin.shell.webConfig"),
  );
  check(
    "presence check origin-gates the cached record (p.origin === serverUrl) in " +
      label,
    /p\.origin\s*===\s*(?:u|server)\b/.test(src),
  );
  // BW4. FAIL-SAFE: the prefetch fetches are still issued on the non-skip path,
  //      so a missing/invalid cache falls straight back to today's behaviour.
  check(
    "non-skip path still issues the index + config fetches in " + label,
    /pf\.index\s*=/.test(src) && /pf\.config\s*=/.test(src),
  );
  // BW5. The skip is observable for on-device QA via a window counter.
  check(
    "skip sets QA counter window." + WPS_COUNTER + " in " + label,
    new RegExp("window\\." + WPS_COUNTER + "\\s*=\\s*1").test(src),
  );
}

// BW6. Flag-dark parity: the flag string appears verbatim at both prefetch
//      sites so retail-WGT and hosted-bootstrap boots behave identically.
check(
  "webPrefetchSkip flag string present at BOTH prefetch sites (retail + bootstrap)",
  PREFETCH_SITES.every(function (s) {
    return (
      s[1].includes('"' + WPS_FLAG + '"') || s[1].includes("'" + WPS_FLAG + "'")
    );
  }),
);

// ============================================================================
// PART C — OBSERVATIONS (informational; never fails the build)
// ============================================================================
console.log("");
console.log("=== PART C: observations ===");

// The two shells stamp records with their own WEB_CACHE_VER. They are not the
// same value today (each is its widget version). That is SAFE: a single device
// boots exactly one shell, and a cross-shell swap simply invalidates the cache
// (a fresh fetch), which is the conservative behaviour. Surface it as a note.
const tvVer = constVal(tvSrc, "WEB_CACHE_VER", "shell.js");
const bootVer = constVal(bootSrc, "WEB_CACHE_VER", "boot-shell.src.js");
const tvMinVer = constVal(tvMin, "WEB_CACHE_VER", "shell.min.js");
const bootMinVer = constVal(bootMin, "WEB_CACHE_VER", "boot-shell.min.js");
note(
  "WEB_CACHE_VER per shell — shell.js=" +
    JSON.stringify(tvVer) +
    " (build-substituted placeholder), shell.min.js=" +
    JSON.stringify(tvMinVer) +
    ", boot-shell.src.js=" +
    JSON.stringify(bootVer) +
    ", boot-shell.min.js=" +
    JSON.stringify(bootMinVer) +
    ". Per-shell version is by design; a version bump invalidates the cache (invariant 3b).",
);
check(
  "shell.js WEB_CACHE_VER is the build-time placeholder (substituted by build_shell_min.py)",
  tvVer === "__SHELL_VER__",
);
check(
  "deployed shell.min.js / boot-shell.min.js carry a concrete (substituted) version",
  /^\d+\.\d+\.\d+$/.test(tvMinVer) && /^\d+\.\d+\.\d+$/.test(bootMinVer),
);

// --- summary ----------------------------------------------------------------
console.log("");
if (notes) {
  console.log(
    notes +
      " observation(s) — see tooling/tv-validate/web-index-cache/results-JEL-57.md",
  );
}
if (failures) {
  console.error(failures + " check(s) FAILED");
  process.exit(1);
}
console.log("All web-index-cache (JEL-57) checks passed.");
