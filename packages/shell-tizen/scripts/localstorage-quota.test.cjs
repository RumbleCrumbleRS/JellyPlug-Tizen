// JEL-60 verification — localStorage quota handling (graceful degradation on a
// FULL store), compared TV-shell vs hosted/browser-shell.
//
// What the issue asks us to prove, by simulating a full localStorage on TV:
//   1. Bundle body cache falls back to {url, needsPatch} WITHOUT the body
//      (no crash) when the full record won't fit; the quota is flagged
//      (window.__shellMainBundleQuotaErr=1) so on-device QA can see it.
//   2. Transpile cache calls __txPrune() to evict the 10 oldest LRU entries
//      before RETRYING the write.
//   3. Web index/config cache silently SKIPS the write (no crash, no flag).
//   4. The server URL still saves — it's a tiny write that fits headroom that
//      the big caches can't.
//   + The app keeps functioning even with localStorage entirely dead.
//
// STRATEGY — exercise the SHIPPED bytes, not a reimplementation. There's no DOM
// test runner here, so we (a) lift the REAL persistence functions verbatim out
// of each shell's source and run them in a `vm` sandbox backed by a fake
// localStorage that can model a FULL store (setItem throws QuotaExceededError
// once a byte budget is exceeded; getItem/removeItem keep working so a prune can
// actually free space) — this proves behaviours 1-4 against the code that ships;
// and (b) source-assert the degradation wiring on BOTH shells AND their deployed
// minified blobs so it cannot silently drift.
//
// WHY "TV vs browser" REDUCES TO A SOURCE/BEHAVIOUR CHECK
//   Every persistence function uses only `localStorage`, `JSON`, `Date.now()`
//   and `window`. NONE branch on `tizen`/`webapis`. So a real TV (where the LS
//   quota is genuinely hit after a few power-cycles of bundle caching) and a
//   desktop browser running the same shell degrade IDENTICALLY by construction.
//   Part B asserts no degradation path references a Tizen-only global, which is
//   what makes the behavioural proof a complete TV-vs-browser parity proof.
//
// TWO SHELLS, ONE CONTRACT
//   The retail artifact that boots on the TV is the BOOTSTRAP
//   (boot-shell.src.js / .min.js); the full shell (shell.js / .min.js) carries
//   its own copy of the same persistence layer. Both are exercised here, and the
//   deployed minified blobs are source-checked so they cannot drift.
//
// Run: node scripts/localstorage-quota.test.cjs
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

const SERVER_URL_KEY = "jellyfin.shell.serverUrl";
const BUNDLE_KEY = "jellyfin.shell.bundlePatchState";
const INDEX_KEY = "jellyfin.shell.webIndexHtml";
const CONFIG_KEY = "jellyfin.shell.webConfig";

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

// --- Fake localStorage that can model a FULL store --------------------------
// mode "normal": unbounded. mode "quota": setItem throws QuotaExceededError once
// the total byte count would exceed `cap` (getItem/removeItem still work, so a
// prune frees real space). mode "dead": every op throws (LS unavailable at all).
function qerr(name) {
  const e = new Error(name);
  e.name = name;
  return e;
}
function makeStore(opts) {
  opts = opts || {};
  const map = new Map();
  let mode = opts.mode || "normal";
  let cap = typeof opts.cap === "number" ? opts.cap : Infinity;
  function bytes() {
    let n = 0;
    for (const [k, v] of map) n += k.length + String(v).length;
    return n;
  }
  const ls = {
    getItem(k) {
      if (mode === "dead") throw qerr("SecurityError");
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      if (mode === "dead") throw qerr("SecurityError");
      v = String(v);
      if (mode === "quota") {
        let cur = bytes();
        if (map.has(k)) cur -= k.length + String(map.get(k)).length;
        if (cur + k.length + v.length > cap) throw qerr("QuotaExceededError");
      }
      map.set(k, v);
    },
    removeItem(k) {
      if (mode === "dead") throw qerr("SecurityError");
      map.delete(k);
    },
  };
  return {
    ls,
    raw: map,
    bytes,
    setMode(m) {
      mode = m;
    },
    setCap(c) {
      cap = c;
    },
  };
}

// --- source lifters ----------------------------------------------------------
// Brace-walk a real `function NAME(...) { ... }` body out of source verbatim.
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

// The transpile-cache functions ship as STRING array-elements (they're injected
// into a runtime <script>). Each is one quoted string literal on its own line;
// eval the literal to recover the real function source verbatim.
function liftTxFn(src, name, label) {
  for (const ln of src.split("\n")) {
    const t = ln.trim();
    if (t.includes("function " + name + "(") && /^['"]/.test(t)) {
      // eslint-disable-next-line no-eval
      return eval(t.replace(/,\s*$/, ""));
    }
  }
  throw new Error(label + ": tx fn " + name + " not found");
}

function constStr(src, name, label) {
  const m = src.match(new RegExp(name + '\\s*=\\s*"([^"]*)"'));
  if (!m) throw new Error(label + ": const " + name + " not found");
  return m[1];
}
function constExpr(src, name, label) {
  const m = src.match(new RegExp(name + "\\s*=\\s*([^;,\\n]+)"));
  if (!m) throw new Error(label + ": const " + name + " not found");
  // eslint-disable-next-line no-eval
  return eval(m[1]);
}

// Lift the persistence layer of one shell into a sandbox backed by `store`.
function loadShell(src, label, store) {
  const win = {};
  const preamble =
    "var SERVER_URL_KEY = " +
    JSON.stringify(constStr(src, "SERVER_URL_KEY", label)) +
    ", BUNDLE_CACHE_KEY = " +
    JSON.stringify(constStr(src, "BUNDLE_CACHE_KEY", label)) +
    ", BUNDLE_CACHE_VER = " +
    JSON.stringify(constStr(src, "BUNDLE_CACHE_VER", label)) +
    ", MAIN_BUNDLE_BODY_MAX = " +
    constExpr(src, "MAIN_BUNDLE_BODY_MAX", label) +
    ", WEB_INDEX_CACHE_KEY = " +
    JSON.stringify(constStr(src, "WEB_INDEX_CACHE_KEY", label)) +
    ", WEB_CONFIG_CACHE_KEY = " +
    JSON.stringify(constStr(src, "WEB_CONFIG_CACHE_KEY", label)) +
    ", WEB_CACHE_VER = " +
    JSON.stringify(constStr(src, "WEB_CACHE_VER", label)) +
    ", WEB_CACHE_MAX = " +
    constExpr(src, "WEB_CACHE_MAX", label) +
    // Transpile-cache prefixes (the real shell derives these from TX_VER at
    // parse time; the exact value is irrelevant to quota behaviour).
    ', __TXPFX = "shell.txTEST:", __TXLRUKEY = "shell.txLruTEST";\n';

  const realFns = [
    "writeBundlePatchState",
    "readBundlePatchState",
    "writeWebIndexCache",
    "readWebIndexCache",
    "writeWebConfigCache",
    "readWebConfigCache",
    "saveServerUrl",
    "loadServerUrl",
  ];
  const txFns = [
    "__txKey",
    "__txLru",
    "__txPersistLru",
    "__txPrune",
    "__txSet",
  ];

  let code = preamble;
  for (const fn of realFns) code += extractFn(src, fn, label) + "\n";
  for (const fn of txFns) code += liftTxFn(src, fn, label) + "\n";
  code +=
    "globalThis.__api = { writeBundlePatchState, readBundlePatchState, " +
    "writeWebIndexCache, readWebIndexCache, writeWebConfigCache, " +
    "readWebConfigCache, saveServerUrl, loadServerUrl, __txPrune, __txSet, " +
    "__txLru, BUNDLE_CACHE_VER, MAIN_BUNDLE_BODY_MAX, TXPFX: __TXPFX, " +
    "TXLRUKEY: __TXLRUKEY };";

  const sandbox = {
    localStorage: store.ls,
    JSON,
    Date,
    window: win,
    globalThis: {},
  };
  sandbox.window = win;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return { api: sandbox.__api, win };
}

// A realistic Jellyfin index.html (>1 KB, has <html) + config + a "bundle body".
const ORIGIN = "https://demo.jellyfin.org";
const HTML_OK =
  "<!DOCTYPE html><html><head></head><body>" +
  "x".repeat(4000) +
  "</body></html>";
const CONFIG_OK = JSON.stringify({ multiserver: true, themes: [] });
const BUNDLE_BODY = "/*bundle*/" + "b".repeat(200000); // ~200 KB patched body
const SERVER_URL = "http://192.168.1.50:8096";

// ============================================================================
// PART A — BEHAVIOURAL (real lifted functions, both shells, FULL store)
// ============================================================================
function behavioural(src, label) {
  // -- Behaviour 1: bundle body cache falls back to {url, needsPatch} --------
  // Store is full enough that the ~200 KB body record can't fit, but a tiny
  // bodyless record can.
  {
    const store = makeStore({ mode: "quota", cap: 1000 });
    const { api, win } = loadShell(src, label, store);
    let threw = false;
    try {
      api.writeBundlePatchState({
        url: ORIGIN + "/web/main.jellyfin.bundle.js",
        needsPatch: true,
        patches: 3,
        body: BUNDLE_BODY,
      });
    } catch (e) {
      threw = true;
    }
    check(
      label + " [1]: writeBundlePatchState never throws on full LS",
      !threw,
    );
    check(
      label + " [1]: quota is flagged (window.__shellMainBundleQuotaErr=1)",
      win.__shellMainBundleQuotaErr === 1,
    );
    const rec = store.raw.has(BUNDLE_KEY)
      ? JSON.parse(store.raw.get(BUNDLE_KEY))
      : null;
    check(
      label + " [1]: bodyless verdict still persisted under " + BUNDLE_KEY,
      !!rec,
    );
    check(
      label + " [1]: fallback record keeps url + needsPatch",
      rec &&
        rec.url === ORIGIN + "/web/main.jellyfin.bundle.js" &&
        rec.needsPatch === true,
    );
    check(
      label + " [1]: fallback record drops body + patches (no crash, fits)",
      rec && rec.body === undefined && rec.patches === undefined,
    );
    // And on a HEALTHY store the body IS cached (degradation is quota-only).
    const ok = makeStore();
    const okApi = loadShell(src, label, ok).api;
    okApi.writeBundlePatchState({
      url: ORIGIN + "/web/main.jellyfin.bundle.js",
      needsPatch: false,
      body: BUNDLE_BODY,
    });
    const okRec = JSON.parse(ok.raw.get(BUNDLE_KEY));
    check(
      label +
        " [1]: healthy LS DOES cache the body (degradation is quota-only)",
      okRec.body === BUNDLE_BODY,
    );
  }

  // -- Behaviour 2: transpile cache prunes 10 oldest LRU before retry --------
  {
    const store = makeStore();
    const { api } = loadShell(src, label, store);
    const PFX = api.TXPFX;
    const ENTRY = "v".repeat(40000); // 40 KB per cached transpile
    // Pre-seed 12 entries with ASCENDING LRU timestamps (k01 oldest..k12 newest).
    const lru = {};
    for (let i = 1; i <= 12; i++) {
      const k = "k" + String(i).padStart(2, "0");
      store.raw.set(PFX + k, ENTRY);
      lru[k] = i; // monotonic timestamps
    }
    store.raw.set(api.TXLRUKEY, JSON.stringify(lru));
    // Now go full: 12*40 KB ≈ 480 KB is present; cap leaves room for only a
    // couple entries, so the 13th write throws and forces a prune+retry.
    store.setMode("quota");
    store.setCap(500000);
    let threw = false;
    try {
      // JEL-178: query-bearing (cache-busted) URLs are intentionally NOT cached
      // by __txSet (they're config-mutable and content-addressed elsewhere), so
      // exercise the quota/prune mechanic with a query-less (URL-cacheable) URL.
      api.__txSet(ORIGIN + "/web/fresh.chunk.js", ENTRY);
    } catch (e) {
      threw = true;
    }
    check(label + " [2]: __txSet never throws on full LS", !threw);
    let evicted = 0;
    for (let i = 1; i <= 10; i++) {
      if (!store.raw.has(PFX + "k" + String(i).padStart(2, "0"))) evicted++;
    }
    check(
      label + " [2]: __txPrune evicted the 10 OLDEST entries (k01..k10)",
      evicted === 10,
      evicted + "/10 evicted",
    );
    check(
      label + " [2]: the 2 NEWEST survive the prune (k11, k12)",
      store.raw.has(PFX + "k11") && store.raw.has(PFX + "k12"),
    );
    const newKey = api.__txKey
      ? null
      : null; /* key derivation lifted below via LRU map */
    const lruAfter = JSON.parse(store.raw.get(api.TXLRUKEY));
    check(
      label + " [2]: LRU map dropped the evicted keys",
      !("k01" in lruAfter) && !("k10" in lruAfter),
    );
    check(
      label + " [2]: fresh transpile written after the prune freed space",
      // exactly one new shell.tx* entry beyond the 2 survivors
      [...store.raw.keys()].filter((k) => k.startsWith(PFX)).length === 3,
    );
    void newKey;
  }

  // -- Behaviour 2b: __txPrune evicts min(N,10) when fewer than 10 exist -----
  {
    const store = makeStore();
    const { api } = loadShell(src, label, store);
    const PFX = api.TXPFX;
    const lru = {};
    for (let i = 1; i <= 4; i++) {
      store.raw.set(PFX + "j" + i, "z".repeat(10000));
      lru["j" + i] = i;
    }
    store.raw.set(api.TXLRUKEY, JSON.stringify(lru));
    api.__txPrune();
    check(
      label + " [2b]: prune with <10 entries clears all of them (min(N,10))",
      [...store.raw.keys()].filter((k) => k.startsWith(PFX)).length === 0,
    );
  }

  // -- Behaviour 3: web index/config cache silently skip on quota ------------
  {
    const store = makeStore({ mode: "quota", cap: 10 }); // nothing big fits
    const { api } = loadShell(src, label, store);
    let threw = false;
    try {
      api.writeWebIndexCache(ORIGIN, HTML_OK);
      api.writeWebConfigCache(ORIGIN, CONFIG_OK);
    } catch (e) {
      threw = true;
    }
    check(
      label + " [3]: web index/config writes never throw on full LS",
      !threw,
    );
    check(
      label + " [3]: index cache write silently skipped (nothing stored)",
      !store.raw.has(INDEX_KEY),
    );
    check(
      label + " [3]: config cache write silently skipped (nothing stored)",
      !store.raw.has(CONFIG_KEY),
    );
  }

  // -- Behaviour 4: server URL still saves (the small write fits) ------------
  {
    // Headroom ~100 bytes: the tiny serverUrl write (~49 B) fits; the big
    // bundle/index writes do not.
    const store = makeStore({ mode: "quota", cap: 1000 });
    store.raw.set("__pad", "p".repeat(900)); // pre-fill near the cap
    const { api } = loadShell(src, label, store);
    api.saveServerUrl(SERVER_URL);
    api.writeWebIndexCache(ORIGIN, HTML_OK);
    api.writeBundlePatchState({
      url: ORIGIN + "/web/main.jellyfin.bundle.js",
      needsPatch: true,
      body: BUNDLE_BODY,
    });
    check(
      label + " [4]: server URL persisted even on a near-full store",
      store.raw.get(SERVER_URL_KEY) === SERVER_URL,
    );
    check(
      label + " [4]: loadServerUrl round-trips the saved URL",
      api.loadServerUrl() === SERVER_URL,
    );
    check(
      label + " [4]: the big index write still degraded (skipped)",
      !store.raw.has(INDEX_KEY),
    );
    check(
      label + " [4]: the big bundle write degraded to no record (no headroom)",
      !store.raw.has(BUNDLE_KEY),
    );
  }

  // -- Resilience: localStorage entirely DEAD — app keeps functioning --------
  {
    const store = makeStore({ mode: "dead" });
    const { api } = loadShell(src, label, store);
    let threw = false;
    try {
      api.saveServerUrl(SERVER_URL);
      api.writeBundlePatchState({
        url: ORIGIN,
        needsPatch: true,
        body: BUNDLE_BODY,
      });
      api.writeWebIndexCache(ORIGIN, HTML_OK);
      api.writeWebConfigCache(ORIGIN, CONFIG_OK);
      api.__txSet(ORIGIN + "/x.js", "y".repeat(5000));
      api.__txPrune();
      // readers must degrade to null/"" too
      check(
        label + " [dead]: loadServerUrl -> '' when LS is dead",
        api.loadServerUrl() === "",
      );
      check(
        label + " [dead]: readBundlePatchState -> null",
        api.readBundlePatchState() === null,
      );
      check(
        label + " [dead]: readWebIndexCache -> null",
        api.readWebIndexCache(ORIGIN) === null,
      );
    } catch (e) {
      threw = true;
    }
    check(
      label + " [dead]: NO persistence call throws when LS is dead",
      !threw,
    );
  }
}

console.log("=== PART A: behavioural (lifted shipped functions, full LS) ===");
behavioural(tvSrc, "shell.js");
behavioural(bootSrc, "boot-shell.src.js");

// ============================================================================
// PART B — SOURCE CONTRACT (degradation wiring + TV==browser parity + drift)
// ============================================================================
console.log("");
console.log("=== PART B: source contract (degradation wiring) ===");

const SRC_SHELLS = [
  ["shell.js", tvSrc],
  ["boot-shell.src.js", bootSrc],
];

// B1. Bundle body fallback: on the setItem catch, the quota is flagged, then
//     body+patches are deleted and the verdict is retried without the body.
for (const [label, src] of SRC_SHELLS) {
  const body = extractFn(src, "writeBundlePatchState", label);
  check(
    "writeBundlePatchState flags quota (__shellMainBundleQuotaErr=1) in " +
      label,
    /__shellMainBundleQuotaErr\s*=\s*1/.test(body),
  );
  check(
    "writeBundlePatchState retries WITHOUT body+patches after quota in " +
      label,
    /delete\s+rec\.body[\s\S]{0,40}delete\s+rec\.patches[\s\S]{0,120}setItem\(/.test(
      body,
    ),
  );
}

// B2. Transpile cache: __txSet's catch calls __txPrune() then retries setItem;
//     __txPrune evicts min(keys.length, 10) oldest by LRU timestamp.
for (const [label, src] of SRC_SHELLS) {
  const set = liftTxFn(src, "__txSet", label);
  const prune = liftTxFn(src, "__txPrune", label);
  check(
    "__txSet catch -> __txPrune() then retry setItem in " + label,
    /catch\([^)]*\)\s*\{\s*__txPrune\(\);[\s\S]*setItem\(/.test(set),
  );
  check(
    "__txPrune sorts by LRU timestamp and caps eviction at 10 in " + label,
    /sort\(/.test(prune) && /Math\.min\([^,]+,\s*10\)/.test(prune),
  );
  check(
    "__txPrune frees space via removeItem in " + label,
    /removeItem\(/.test(prune),
  );
}

// B3. Web index/config writes swallow the quota error (empty catch -> skip).
for (const [label, src] of SRC_SHELLS) {
  for (const fn of ["writeWebIndexCache", "writeWebConfigCache"]) {
    const body = extractFn(src, fn, label);
    check(
      fn + " wraps setItem in try/catch and skips on failure in " + label,
      /setItem\([\s\S]*\}\s*catch\s*\(_\)\s*\{\s*\}/.test(body),
    );
  }
}

// B4. Server URL save is wrapped (non-fatal) — never crashes boot.
for (const [label, src] of SRC_SHELLS) {
  const body = extractFn(src, "saveServerUrl", label);
  check(
    "saveServerUrl wraps setItem in try/catch (non-fatal) in " + label,
    /try\s*\{[\s\S]*setItem\([\s\S]*\}\s*catch/.test(body),
  );
}

// B5. TV == browser by construction: NO degradation path references a
//     Tizen-only global. This is what makes Part A a complete parity proof.
for (const [label, src] of SRC_SHELLS) {
  for (const fn of [
    "writeBundlePatchState",
    "writeWebIndexCache",
    "writeWebConfigCache",
    "saveServerUrl",
  ]) {
    const body = extractFn(src, fn, label);
    check(
      fn + "() has no tizen/webapis branch (TV==browser) in " + label,
      !/\btizen\b|\bwebapis\b/.test(body),
    );
  }
  for (const fn of ["__txSet", "__txPrune"]) {
    const body = liftTxFn(src, fn, label);
    check(
      fn + "() has no tizen/webapis branch (TV==browser) in " + label,
      !/\btizen\b|\bwebapis\b/.test(body),
    );
  }
}

// B6. Deployed minified blobs carry the same degradation markers so they
//     cannot drift from the source-of-record contract.
const ALL_BLOBS = [
  ["shell.min.js", tvMin],
  ["boot-shell.min.js", bootMin],
];
for (const [label, src] of ALL_BLOBS) {
  check(
    "deployed " + label + " carries the bundle quota flag",
    src.includes("__shellMainBundleQuotaErr"),
  );
  check(
    "deployed " + label + " carries the transpile prune (__txPrune)",
    src.includes("__txPrune"),
  );
  check(
    "deployed " + label + " caps prune eviction at 10",
    /Math\.min\([^)]*,\s*10\)/.test(src),
  );
}

// --- summary ----------------------------------------------------------------
console.log("");
if (notes) {
  console.log(
    notes +
      " observation(s) — see tooling/tv-validate/localstorage-quota/results-JEL-60.md",
  );
}
if (failures) {
  console.error(failures + " check(s) FAILED");
  process.exit(1);
}
console.log("All localStorage-quota (JEL-60) checks passed.");
