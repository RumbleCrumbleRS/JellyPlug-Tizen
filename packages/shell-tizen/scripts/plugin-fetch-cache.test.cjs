// JEL-619 regression test — version-keyed plugin FETCH caching.
//
// JEL-178's per-boot `&__sb=` buster + cache:"no-store" forced a FULL
// re-download of every query-bearing plugin script on every boot
// (JellyfinEnhanced ~54 submodules, the JSI channel); the content-addressed
// `txc:` key deduped only the TRANSPILE. JEL-619 serves a query-bearing URL
// from a version-keyed cache slot when its txKey() identity is unchanged vs
// the boot that stored it — zero network — while ANY version-token change
// still misses into the busted fetch (JEL-178 staleness intact).
//
// The contract pinned here (both shells, widget-side AND seed-side):
//   class 2 (version-pinned: >=15-digit ticks / dotted a.b.c / long hex) —
//     cached until the token changes; a token change is a miss.
//   class 1 (per-load epoch buster only) — cached under the stripped key
//     with a 24 h TTL; an expired entry is a miss.
//   class 0 (kept query with NO version signal, e.g. the JSI channel's
//     static ?_jsi=1 marker) — NEVER served from cache; the body is
//     config-mutable with no tracked version. THIS IS THE JEL-178 GUARD.
//   Version slots hold "@@shellref:" pointers to the single txc: body; a
//     pruned target reads as a miss (self-healing). The per-path "vqk:"
//     index frees the previous generation's body on a token change.
//   Kill-switch jellyfin.shell.pluginFetchCacheDisabled='1' restores the
//     fetch-every-boot behaviour.
//
// Run: node scripts/plugin-fetch-cache.test.cjs

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
  if (cond) console.log("OK: " + name);
  else {
    console.error("FAIL: " + name + (detail ? " — " + detail : ""));
    failures++;
  }
}

// --- lift the shipping code -------------------------------------------------

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

function makeLS() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => {
      m.set(k, String(v));
    },
    removeItem: (k) => {
      m.delete(k);
    },
    _m: m,
  };
}

function compileWidget(src, label) {
  const decls = [
    "txKey",
    "pluginFetchCacheDisabled",
    "txQueryClass",
    "txRecordQuerySlot",
    "txGetStatic",
    "txSetStatic",
  ]
    .map((n) => extractFnDecl(src, n, label))
    .join("\n");
  const prelude =
    'var TX_PFX="tx:";var TX_QUERY_TTL_MS=864e5;var TX_REF_PFX="@@shellref:";' +
    'var PLUGIN_FETCH_CACHE_DISABLED_KEY="jellyfin.shell.pluginFetchCacheDisabled";';
  // eslint-disable-next-line no-new-func
  return new Function(
    "localStorage",
    "window",
    prelude +
      decls +
      ";return {txKey:txKey,txQueryClass:txQueryClass," +
      "txRecordQuerySlot:txRecordQuerySlot,txGetStatic:txGetStatic," +
      "txSetStatic:txSetStatic};",
  );
}

function compileSeed(src, label) {
  const decls = [
    "__txKey",
    "__txQC",
    "__txQGate",
    "__txLru",
    "__txPersistLru",
    "__txPrune",
    "__txGet",
    "__txSet",
  ]
    .map((n) => liftSeedFn(src, n, label))
    .join("\n");
  const prelude =
    'var __TXPFX="tx:";var __TXLRUKEY="txlru";var __TXREF="@@shellref:";';
  // eslint-disable-next-line no-new-func
  return new Function(
    "localStorage",
    "window",
    prelude +
      decls +
      ";return {__txQC:__txQC,__txGet:__txGet,__txSet:__txSet};",
  );
}

const tvSrc = fs.readFileSync(TV_SHELL, "utf8");
const bootSrc = fs.readFileSync(BOOT_SHELL, "utf8");

// --- probe URL shapes (real plugin ecosystem shapes) -------------------------

const NOW = Date.now();
const TICKS = "https://srv/Plug/public.js?v=639171366085089023"; // class 2
const TICKS_B = "https://srv/Plug/public.js?v=639171999999999999";
const DOTTED = "https://srv/Home/sections.js?v=2.5.11.0&c=3"; // class 2
const HEX = "https://srv/Thing/mod.js?v=ab12cd34ef567890"; // class 2
const EPOCH = "https://srv/Enh/translations.js?v=" + NOW; // class 1
const EPOCH_B = "https://srv/Enh/translations.js?v=" + (NOW + 9000);
const MARKER = "https://srv/Chan/agg.js?_jsi=1"; // class 0
const BARE = "https://srv/Simple/plain.js"; // no query

// --- widget-side behaviour (both shells) -------------------------------------

for (const [label, src] of [
  ["shell.js", tvSrc],
  ["boot-shell.src.js", bootSrc],
]) {
  const ls = makeLS();
  const w = compileWidget(src, label)(ls, {});

  check(label + ": ticks URL is class 2", w.txQueryClass(TICKS) === 2);
  check(label + ": dotted-version URL is class 2", w.txQueryClass(DOTTED) === 2);
  check(label + ": long-hex URL is class 2", w.txQueryClass(HEX) === 2);
  check(label + ": epoch-busted URL is class 1", w.txQueryClass(EPOCH) === 1);
  check(label + ": static marker URL is class 0", w.txQueryClass(MARKER) === 0);
  check(
    label + ": epoch buster + ticks is class 2 (token pins it)",
    w.txQueryClass("https://srv/x.js?v=" + NOW + "&t=639171366085089023") === 2,
  );

  // Version-pinned round trip: boot 1 stores, boot 2 serves with no fetch.
  w.txSetStatic("txc:aaa", "BODY_A");
  w.txRecordQuerySlot(TICKS, "txc:aaa");
  check(
    label + ": unchanged ticks token -> served from cache (zero download)",
    w.txGetStatic(TICKS) === "BODY_A",
  );
  check(
    label + ": changed ticks token -> MISS (JEL-178 config-change contract)",
    w.txGetStatic(TICKS_B) === null,
  );

  // Class 0 marker: never cached, never served (THE JEL-178 guard).
  w.txSetStatic("txc:mmm", "BODY_M");
  w.txRecordQuerySlot(MARKER, "txc:mmm");
  check(
    label + ": ?_jsi=1-style marker NEVER served from cache",
    w.txGetStatic(MARKER) === null,
  );

  // Class 1 epoch: stable across boots (different buster), TTL-bounded.
  w.txSetStatic("txc:eee", "BODY_E");
  w.txRecordQuerySlot(EPOCH, "txc:eee");
  check(
    label + ": epoch-busted URL served across boots (new buster, same path)",
    w.txGetStatic(EPOCH_B) === "BODY_E",
  );
  const epochKey = w.txKey(EPOCH);
  ls.setItem("tx:ts:" + epochKey, String(NOW - 2 * 864e5));
  check(
    label + ": epoch-busted entry EXPIRES after the 24 h TTL",
    w.txGetStatic(EPOCH_B) === null,
  );

  // One generation per path: a token change frees the old body.
  check(
    label + ": token change removed the previous generation's txc: body",
    (w.txRecordQuerySlot(TICKS_B, "txc:bbb"),
    w.txSetStatic("txc:bbb", "BODY_B"),
    ls.getItem("tx:txc:aaa") === null && w.txGetStatic(TICKS_B) === "BODY_B"),
  );

  // Pointer with a pruned target reads as a miss (self-healing).
  ls.removeItem("tx:txc:bbb");
  check(
    label + ": pruned pointer target reads as a miss",
    w.txGetStatic(TICKS_B) === null,
  );

  // Bare URLs keep the JEL-554 behaviour (no TTL, direct body).
  w.txSetStatic(BARE, "BODY_BARE");
  check(label + ": bare URL round trip unchanged", w.txGetStatic(BARE) === "BODY_BARE");

  // Kill-switch restores fetch-every-boot.
  const ls2 = makeLS();
  const w2 = compileWidget(src, label)(ls2, {});
  ls2.setItem("jellyfin.shell.pluginFetchCacheDisabled", "1");
  w2.txSetStatic("txc:kkk", "BODY_K");
  w2.txRecordQuerySlot(TICKS, "txc:kkk");
  check(
    label + ": kill-switch -> query-bearing URL never served from cache",
    w2.txGetStatic(TICKS) === null,
  );

  // JEL-619 cap raise: the JSI channel aggregate (>1 MB) must be cacheable
  // under txc: (it re-Babel'd every boot above the old 256 KB cap)...
  const big = "x".repeat(1300000);
  w.txSetStatic("txc:big", big);
  check(
    label + ": >1 MB txc: body is stored (old 256 KB cap re-transpiled it)",
    ls.getItem("tx:txc:big") === big,
  );
  // ...while a pathological >2 MB body is still rejected.
  w.txSetStatic("txc:huge", "x".repeat(2200000));
  check(
    label + ": >2 MB body still rejected",
    ls.getItem("tx:txc:huge") === null,
  );
}

// --- seed-side behaviour (dynamic pipeline, both shells) ----------------------

for (const [label, src] of [
  ["shell.js seed", tvSrc],
  ["boot-shell seed", bootSrc],
]) {
  const ls = makeLS();
  const s = compileSeed(src, label)(ls, {});

  check(label + ": ticks URL is class 2", s.__txQC(TICKS) === 2);
  check(label + ": epoch URL is class 1", s.__txQC(EPOCH) === 1);
  check(label + ": marker URL is class 0", s.__txQC(MARKER) === 0);

  // Version-pinned dynamic script round trip (was: never cached at all).
  s.__txSet(TICKS, "DYN_A");
  check(
    label + ": unchanged ticks token -> served (zero download)",
    s.__txGet(TICKS) === "DYN_A",
  );
  check(label + ": changed ticks token -> miss", s.__txGet(TICKS_B) === null);

  // Marker: __txSet refuses, __txGet refuses (fetch stays busted every boot).
  s.__txSet(MARKER, "DYN_M");
  check(
    label + ": marker URL never cached / never served",
    ls.getItem("tx:" + MARKER) === null && s.__txGet(MARKER) === null,
  );

  // Epoch-busted submodule: cached across boots under the stripped key,
  // TTL-bounded (the JellyfinEnhanced ~54-submodule warm-boot win).
  s.__txSet(EPOCH, "DYN_E");
  check(
    label + ": epoch submodule served across boots (new buster)",
    s.__txGet(EPOCH_B) === "DYN_E",
  );
  ls.setItem("tx:ts:https://srv/Enh/translations.js", String(NOW - 2 * 864e5));
  check(
    label + ": epoch submodule expires after 24 h TTL",
    s.__txGet(EPOCH_B) === null,
  );

  // Seed derefs a STATIC-layer pointer (shared keyspace).
  ls.setItem("tx:txc:zzz", "STATIC_BODY");
  ls.setItem("tx:" + TICKS, "@@shellref:txc:zzz");
  check(
    label + ": seed derefs a static-layer @@shellref: pointer",
    s.__txGet(TICKS) === "STATIC_BODY",
  );

  // Kill-switch.
  ls.setItem("jellyfin.shell.pluginFetchCacheDisabled", "1");
  check(
    label + ": kill-switch -> query-bearing miss",
    s.__txGet(TICKS) === null,
  );
}

// --- widget/seed classifier lockstep -----------------------------------------

{
  const probes = [
    TICKS,
    TICKS_B,
    DOTTED,
    HEX,
    EPOCH,
    MARKER,
    BARE,
    "https://srv/x.js?a=1&v=" + NOW + "&c=2",
    "https://srv/Enh/script?v=11.12.0.0-639167216800000000",
  ];
  const impls = [
    ["shell.js widget", compileWidget(tvSrc, "tv")(makeLS(), {}).txQueryClass],
    ["shell.js seed", compileSeed(tvSrc, "tv")(makeLS(), {}).__txQC],
    [
      "boot-shell widget",
      compileWidget(bootSrc, "boot")(makeLS(), {}).txQueryClass,
    ],
    ["boot-shell seed", compileSeed(bootSrc, "boot")(makeLS(), {}).__txQC],
  ];
  for (const u of probes) {
    const ref = impls[0][1](u);
    for (let i = 1; i < impls.length; i++) {
      check(
        'classifier lockstep on "' + u + '": ' + impls[i][0],
        impls[i][1](u) === ref,
        impls[i][1](u) + " vs " + ref,
      );
    }
  }
}

// --- source-level wiring guards ----------------------------------------------

for (const [label, src] of [
  ["shell.js", tvSrc],
  ["boot-shell.src.js", bootSrc],
]) {
  check(
    label + ": static short-circuit no longer bails on query-bearing URLs",
    !/cached = url\.indexOf\("\?"\) >= 0 \? null : txGetStatic/.test(src),
  );
  const slotCalls = (src.match(/txRecordQuerySlot\(url, ck\)/g) || []).length;
  check(
    label +
      ": version slot recorded at all 3 download sites (txc-hit promote, fast path, babel path)",
    slotCalls >= 3,
    "found " + slotCalls,
  );
  check(
    label + ": next-boot preload list skips query-bearing plugin URLs",
    /pUsrc\.indexOf\("\?"\)/.test(src),
  );
  check(
    label + ": kill-switch key present",
    src.indexOf("jellyfin.shell.pluginFetchCacheDisabled") >= 0,
  );
}

if (failures) {
  console.error("\nJEL-619 plugin-fetch-cache verification FAILED: " + failures);
  process.exit(1);
}
console.log("\nAll JEL-619 plugin-fetch-cache checks passed.");
