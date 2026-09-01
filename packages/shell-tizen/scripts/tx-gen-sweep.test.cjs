// JELA-799 regression test — tx-cache generation sweep + txc: prunability.
//
// Split from JELA-797, which REFUTED the parent "localStorage size kills
// boots" claim (M63 quota measured at 5,242,880 UTF-16 code units; a boot
// with a 2.87M-char store and __shellLsQuotaErr=0 died anyway, and a boot
// padded to the ceiling rendered 279 cards). What survived that census is
// two CACHE-EFFICIENCY defects, and this test pins both — plus, deliberately,
// the control arms that SHOW them, so the fix can never be graded against an
// arm where the defect had already decayed away (JELA-778's lesson).
//
// (a) Seed-written ?v= slots were never generation-swept. __txKey KEEPS a
//     version token (only 12-14 digit epoch busters are stripped), the seed
//     kept no index, and the widget's one-generation "vqk:" cleanup only ran
//     for URLs the WIDGET fetched — census: 3 vqk: entries against 163 plain
//     slots / 1,882,682 chars. One plugin version bump therefore laid a whole
//     fresh generation beside the old one. Fixed by a per-FAMILY "gqk:" index
//     (family = the key with version-ish tokens removed), swept BEFORE the
//     new body is written. Flag: jellyfin.shell.txGenSweep.
//
// (b) txc: bodies were invisible to the pruner. __txPrune evicts the LRU
//     -oldest keys from the shared map, which only __txGet/__txSet populate —
//     txSetStatic never touched it, so the single biggest key in the census
//     store (a 901,582-char txc: body, 24.5% of everything) could never be
//     evicted while the pruner dropped small seed entries around it. And
//     txSetStatic's quota catch only COUNTED the lost write, with no
//     prune-and-retry. Flag: jellyfin.shell.txLruStatic.
//
// Sizes here are in UTF-16 CODE UNITS (k.length + v.length) — the unit the
// M63 quota is actually denominated in. Do not restate them as "MB".
//
// Run: node scripts/tx-gen-sweep.test.cjs

const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..", "..", "..");
const SHELLS = [
  ["shell.js", path.join(REPO, "packages", "shell-tizen", "src", "shell.js")],
  [
    "boot-shell.src.js",
    path.join(
      REPO,
      "packages",
      "shell-tizen-bootstrap",
      "src",
      "boot-shell.src.js",
    ),
  ],
];

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log("OK: " + name);
  else {
    console.error("FAIL: " + name + (detail ? " — " + detail : ""));
    failures++;
  }
}

// --- lift the shipping code (same mechanism as plugin-fetch-cache.test) -----

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

// Both layers are compiled against ONE store and ONE LRU key, exactly as they
// run on device: the seed's __txPrune and the widget's txSetStatic share the
// keyspace "shell.txT:" and the map "shell.txLruT".
const PFX = "shell.txT:";
const LRU = "shell.txLruT";

function compile(src, label) {
  const widget = [
    "txKey",
    "pluginFetchCacheDisabled",
    "txQueryClass",
    "txWriteLost",
    "txLruStaticOn",
    "txLruRead",
    "txLruWrite",
    "txLruTouch",
    "txLruForget",
    "txPruneStatic",
    // JELA-844: txSetStatic's quota arm now forks through the value-ranked
    // reclaim — lift it or txSetStatic reference-errors.
    "txBudgetOn",
    "txNsScan",
    "txReclaim",
    "txStaticVal",
    "txRecordQuerySlot",
    "txGetStatic",
    "txSetStatic",
  ]
    .map((n) => extractFnDecl(src, n, label))
    .join("\n");
  const seed = [
    "__txKey",
    "__txQC",
    "__txQGate",
    "__qeB",
    "__txLru",
    "__txPersistLru",
    "__txPrune",
    "__txGenOn",
    "__txVerTok",
    "__txFam",
    "__txGenRec",
    "__txGet",
    "__txBudgetOn",
    "__txNsScan",
    "__txReclaim",
    "__txSet",
  ]
    .map((n) => liftSeedFn(src, n, label))
    .join("\n");
  const prelude =
    'var TX_PFX="' +
    PFX +
    '";var TX_QUERY_TTL_MS=864e5;var TX_REF_PFX="@@shellref:";' +
    'var TX_LRU_KEY="' +
    LRU +
    '";var TX_LRU_STATIC_KEY="jellyfin.shell.txLruStatic";' +
    "var TX_LRU_TOUCH_MS=36e5;" +
    'var PLUGIN_FETCH_CACHE_DISABLED_KEY="jellyfin.shell.pluginFetchCacheDisabled";' +
    'var __TXPFX="' +
    PFX +
    '";var __TXLRUKEY="' +
    LRU +
    '";var __TXREF="@@shellref:";' +
    'var __TXGENK="jellyfin.shell.txGenSweep";' +
    // JELA-844 flag key (dark by default, so every existing case here keeps
    // exercising the pre-844 fixed-ten prune path).
    'var TX_BUDGET_KEY="jellyfin.shell.txBudget";var TX_RECLAIM_SLACK=8192;' +
    'var __TXBK="jellyfin.shell.txBudget";';
  // eslint-disable-next-line no-new-func
  return new Function(
    "localStorage",
    "window",
    prelude +
      widget +
      "\n" +
      seed +
      ";return {txSetStatic:txSetStatic,txGetStatic:txGetStatic," +
      "txRecordQuerySlot:txRecordQuerySlot,txLruRead:txLruRead," +
      "__txSet:__txSet,__txGet:__txGet,__txPrune:__txPrune,__txFam:__txFam};",
  );
}

// A store that enforces a real quota in UTF-16 code units, so the
// prune-and-retry path is exercised the way M63 exercises it.
function makeLS(limitChars) {
  const m = new Map();
  const chars = () => {
    let t = 0;
    for (const [k, v] of m) t += k.length + v.length;
    return t;
  };
  return {
    get length() {
      return m.size;
    },
    key: (i) => Array.from(m.keys())[i] || null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => {
      v = String(v);
      const was = m.has(k) ? k.length + m.get(k).length : 0;
      if (limitChars && chars() - was + k.length + v.length > limitChars) {
        const e = new Error("QuotaExceededError");
        e.name = "QuotaExceededError";
        throw e;
      }
      m.set(k, v);
    },
    removeItem: (k) => {
      m.delete(k);
    },
    _m: m,
    _chars: chars,
  };
}

function env(limitChars) {
  const ls = makeLS(limitChars);
  const win = {};
  return { ls, win };
}

function bodyKeys(ls) {
  return Array.from(ls._m.keys())
    .filter((k) => k.indexOf(PFX) === 0)
    .filter((k) => k.indexOf(PFX + "gqk:") !== 0)
    .filter((k) => k.indexOf(PFX + "vqk:") !== 0)
    .filter((k) => k.indexOf(PFX + "ts:") !== 0);
}

// Real shapes: JellyfinEnhanced ships ?v=<plugin version>-<ticks>, which
// txKey KEEPS (dotted a.b.c => class 2), and the HomeScreen sections add a
// non-version &c=N discriminator on the SAME path.
const P = "https://srv/JellyfinEnhanced/main.js";
const V1 = P + "?v=12.4.1.0-638912345678900000";
const V2 = P + "?v=12.5.0.0-638999999999900000";
const H = "https://srv/HomeScreen/rows.js";
const BIG = "x".repeat(4096);

for (const [label, file] of SHELLS) {
  const src = fs.readFileSync(file, "utf8");
  const make = compile(src, label);

  // ---- (a) the CONTROL arm: with the sweep dark the bump orphans ---------
  {
    const { ls, win } = env(0);
    const tx = make(ls, win);
    tx.__txSet(V1, BIG);
    const after1 = bodyKeys(ls).length;
    const before = ls._chars();
    tx.__txSet(V2, BIG);
    check(
      label + " a-control: the bump costs a WHOLE extra generation",
      ls._chars() - before >= BIG.length,
      "grew " + (ls._chars() - before) + " code units",
    );
    check(
      label + " a-control: flag dark, a ?v= bump leaves BOTH generations",
      after1 === 1 && bodyKeys(ls).length === 2,
      "keys=" + JSON.stringify(bodyKeys(ls)),
    );
    check(
      label + " a-control: no gqk: index is written at all",
      !Array.from(ls._m.keys()).some((k) => k.indexOf(PFX + "gqk:") === 0),
    );
    check(
      label + " a-control: the orphaned generation is still fully readable",
      ls.getItem(PFX + P + "?v=12.4.1.0-638912345678900000") === BIG,
    );
  }

  // ---- (a) the fix: the bump frees the old generation --------------------
  {
    const { ls, win } = env(0);
    const tx = make(ls, win);
    ls.setItem("jellyfin.shell.txGenSweep", "1");
    tx.__txSet(V1, BIG);
    const before = ls._chars();
    tx.__txSet(V2, BIG);
    const keys = bodyKeys(ls);
    check(
      label + " a: one generation survives the bump",
      keys.length === 1 && keys[0].indexOf("12.5.0.0") > 0,
      "keys=" + JSON.stringify(keys),
    );
    check(
      label + " a: the old body is GONE, not just unreferenced",
      ls.getItem(PFX + P + "?v=12.4.1.0-638912345678900000") === null,
    );
    check(
      label + " a: gqk: index points at the live key",
      ls.getItem(PFX + "gqk:" + P) === P + "?v=12.5.0.0-638999999999900000",
    );
    check(
      label + " a: __shellTxGenDrop counts the sweep",
      win.__shellTxGenDrop === 1,
    );
    // Store size in UTF-16 code units: a bump must not grow the store by a
    // whole generation. The index key is the only overhead.
    // Store size in UTF-16 code units. The control arm above grows by a whole
    // body; here the swap is key-for-key and value-for-value, so the delta is
    // index churn only — well under one body, not ~+4096.
    const grew = ls._chars() - before;
    check(
      label + " a: store grew by index churn only, not by a generation",
      Math.abs(grew) < 200,
      "grew " + grew + " code units (body is " + BIG.length + ")",
    );
    // Serving still works, and still misses on the token change (JEL-178).
    check(label + " a: the new generation serves", tx.__txGet(V2) === BIG);
    check(
      label + " a: the old URL now misses (refetch)",
      tx.__txGet(V1) === null,
    );
  }

  // ---- (a) kill switch ---------------------------------------------------
  {
    const { ls, win } = env(0);
    const tx = make(ls, win);
    ls.setItem("jellyfin.shell.txGenSweep", "1");
    ls.setItem("jellyfin.shell.txGenSweepDisabled", "1");
    tx.__txSet(V1, BIG);
    tx.__txSet(V2, BIG);
    check(
      label + " a: kill switch restores the pre-799 orphaning exactly",
      bodyKeys(ls).length === 2 && win.__shellTxGenDrop === undefined,
    );
  }

  // ---- (a) families: a non-version token is NOT a generation -------------
  {
    const { ls, win } = env(0);
    const tx = make(ls, win);
    ls.setItem("jellyfin.shell.txGenSweep", "1");
    const c1v1 = H + "?v=1.2.3.0&c=1";
    const c2v1 = H + "?v=1.2.3.0&c=2";
    const c1v2 = H + "?v=1.3.0.0&c=1";
    tx.__txSet(c1v1, BIG);
    tx.__txSet(c2v1, BIG);
    check(
      label + " a: two &c= slots of one path are two families, not a thrash",
      bodyKeys(ls).length === 2,
      "keys=" + JSON.stringify(bodyKeys(ls)),
    );
    tx.__txSet(c1v2, BIG);
    const keys = bodyKeys(ls).sort();
    check(
      label + " a: the bump drops ONLY the matching family's old generation",
      keys.length === 2 &&
        keys.some((k) => k.indexOf("v=1.3.0.0&c=1") > 0) &&
        keys.some((k) => k.indexOf("v=1.2.3.0&c=2") > 0),
      "keys=" + JSON.stringify(keys),
    );
  }

  // ---- (a) class-1 (epoch buster only) costs no index --------------------
  {
    const { ls, win } = env(0);
    const tx = make(ls, win);
    ls.setItem("jellyfin.shell.txGenSweep", "1");
    // A 13-digit Date.now()-shaped buster: __txKey strips it, so the key is
    // the bare path — family === key, nothing to sweep.
    tx.__txSet(P + "?v=" + Date.now(), BIG);
    check(
      label + " a: an epoch-busted URL writes NO gqk: index",
      !Array.from(ls._m.keys()).some((k) => k.indexOf(PFX + "gqk:") === 0),
      JSON.stringify(Array.from(ls._m.keys())),
    );
    check(
      label + " a: __txFam is identity on a key with no version token",
      tx.__txFam(P) === P && tx.__txFam(P + "?c=2") === P + "?c=2",
    );
  }

  // ---- (a2) JELA-847: a FAILED version pin must still be swept ------------
  // `?v=unknown` is class 1 now, so the seed pipeline stores a body under it.
  // ceInvalidate reaches SEED-written slots only through the "gqk:" family
  // index, so if __txFam left `v=unknown` in place the family would equal the
  // key, __txGenRec would return early, no index would be written, and a JE
  // plugin bump could NOT drop the slot. Measured on the rig before the fix:
  // a scripts-epoch flip refetched all 149 pinned modules and none of the
  // three ?v=unknown ones. THIS is the assertion that would have caught it —
  // the config-epoch test alone could not, because it hand-seeds the widget
  // path's "vqk:" entry rather than exercising the seed path that writes gqk:.
  {
    const { ls, win } = env(0);
    const tx = make(ls, win);
    ls.setItem("jellyfin.shell.txGenSweep", "1");
    tx.__txSet(P + "?v=unknown", BIG);
    check(
      label + " a2: ?v=unknown writes a gqk: index (ceInvalidate can reach it)",
      ls.getItem(PFX + "gqk:" + P) === P + "?v=unknown",
      JSON.stringify(
        Array.from(ls._m.keys()).filter((k) => k.indexOf(PFX + "gqk:") === 0),
      ),
    );
    check(
      label + " a2: __txFam strips a failed version pin down to the path",
      tx.__txFam(P + "?v=unknown") === P &&
        tx.__txFam(P + "?version=unknown") === P,
    );
    check(
      label + " a2: an EMPTY ?v= is not a version key — family unchanged",
      tx.__txFam(P + "?v=") === P + "?v=",
    );
    // Same family as the real pin, so if JE ever wins its version race the
    // stale unknown-generation body is freed instead of leaking.
    tx.__txSet(P + "?v=12.5.0.0", BIG);
    check(
      label + " a2: winning the version race frees the ?v=unknown generation",
      ls.getItem(PFX + P + "?v=unknown") === null &&
        ls.getItem(PFX + "gqk:" + P) === P + "?v=12.5.0.0",
    );
  }

  // ---- (b) the CONTROL arm: a txc: body is unreachable by the pruner -----
  {
    const { ls, win } = env(0);
    const tx = make(ls, win);
    tx.txSetStatic("txc:deadbeef", BIG);
    check(
      label + " b-control: flag dark, txSetStatic tracks nothing",
      Object.keys(tx.txLruRead()).length === 0,
    );
    tx.__txPrune();
    check(
      label + " b-control: __txPrune cannot touch the biggest key",
      ls.getItem(PFX + "txc:deadbeef") === BIG,
    );
  }

  // ---- (b) the fix: txc: bodies enter the LRU and prune ------------------
  {
    const { ls, win } = env(0);
    const tx = make(ls, win);
    ls.setItem("jellyfin.shell.txLruStatic", "1");
    tx.txSetStatic("txc:deadbeef", BIG);
    check(
      label + " b: txSetStatic tracks the body key",
      tx.txLruRead()["txc:deadbeef"] > 0,
    );
    tx.__txPrune();
    check(
      label + " b: the seed pruner now reaches it",
      ls.getItem(PFX + "txc:deadbeef") === null,
    );
  }

  // ---- (b) a hit is the only recency signal a txc: body gets -------------
  {
    const { ls, win } = env(0);
    const tx = make(ls, win);
    ls.setItem("jellyfin.shell.txLruStatic", "1");
    tx.txSetStatic("txc:aaaa", BIG);
    tx.txRecordQuerySlot(V1, "txc:aaaa");
    const map0 = tx.txLruRead();
    check(
      label + " b: the pointer key is NOT tracked (evicting it would leak)",
      map0[P + "?v=12.4.1.0-638912345678900000"] === undefined &&
        map0["txc:aaaa"] > 0,
      JSON.stringify(map0),
    );
    // Age the entry past the coarse-touch window, then serve it.
    const aged = tx.txLruRead();
    aged["txc:aaaa"] = 1;
    ls.setItem(LRU, JSON.stringify(aged));
    check(
      label + " b: the version slot serves the body",
      tx.txGetStatic(V1) === BIG,
    );
    check(
      label + " b: the HIT refreshed the body key's recency",
      tx.txLruRead()["txc:aaaa"] > 1,
    );
  }

  // ---- (b) prune-and-retry at a real quota -------------------------------
  {
    // Sized so the store holds the filler but not filler + the new body.
    const filler = "y".repeat(3000);
    const { ls, win } = env(9000);
    const tx = make(ls, win);
    ls.setItem("jellyfin.shell.txLruStatic", "1");
    tx.txSetStatic("txc:old1", filler);
    tx.txSetStatic("txc:old2", filler);
    const ok = tx.txSetStatic("txc:new", BIG);
    void ok;
    check(
      label + " b: the write that would have been lost now lands",
      ls.getItem(PFX + "txc:new") === BIG,
      "chars=" + ls._chars(),
    );
    check(
      label + " b: nothing was counted as a swallowed write",
      !win.__shellLsQuotaErr,
      "qe=" + win.__shellLsQuotaErr,
    );
    check(
      label + " b: the pruner reported what it evicted",
      win.__shellTxPruneStatic > 0,
    );
  }

  // ---- (b) the CONTROL at the same quota: the write is simply lost -------
  {
    const filler = "y".repeat(3000);
    const { ls, win } = env(9000);
    const tx = make(ls, win);
    tx.txSetStatic("txc:old1", filler);
    tx.txSetStatic("txc:old2", filler);
    tx.txSetStatic("txc:new", BIG);
    check(
      label + " b-control: flag dark, the body is dropped at quota",
      ls.getItem(PFX + "txc:new") === null,
    );
    check(
      label + " b-control: and it is counted as a swallowed write (qe)",
      win.__shellLsQuotaErr === 1,
      "qe=" + win.__shellLsQuotaErr,
    );
  }

  // ---- (b) a replaced txc: body leaves no dead LRU entry behind ----------
  {
    const { ls, win } = env(0);
    const tx = make(ls, win);
    ls.setItem("jellyfin.shell.txLruStatic", "1");
    tx.txSetStatic("txc:gen1", BIG);
    tx.txRecordQuerySlot(V1, "txc:gen1");
    tx.txSetStatic("txc:gen2", BIG);
    tx.txRecordQuerySlot(V2, "txc:gen2");
    const map = tx.txLruRead();
    check(
      label + " b: the superseded body is forgotten, not left to sort oldest",
      map["txc:gen1"] === undefined && map["txc:gen2"] > 0,
      JSON.stringify(map),
    );
  }
}

// --- the two layers must agree on the keyspace ------------------------------
for (const [label, file] of SHELLS) {
  const src = fs.readFileSync(file, "utf8");
  check(
    label + ": seed LRU key and widget TX_LRU_KEY are the same string",
    /var __TXLRUKEY="shell\.txLru"\+__TXVER;/.test(src) &&
      /var TX_LRU_KEY = "shell\.txLru" \+ TX_VER;/.test(src),
    "the whole point of (b) is that ONE map governs both layers",
  );
  check(
    label + ": both JELA-799 flags ship dark (opt-in + kill switch)",
    src.includes('__TXGENK+"Disabled"') &&
      src.includes('TX_LRU_STATIC_KEY + "Disabled"'),
  );
}

if (failures) {
  console.error("\ntx-gen-sweep: " + failures + " failure(s)");
  process.exit(1);
}
console.log("\nAll tx-gen-sweep checks passed.");
