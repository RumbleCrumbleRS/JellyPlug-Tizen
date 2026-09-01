// JELA-844 regression test — value-ranked, byte-targeted tx-cache eviction.
//
// THE DEFECT (measured on the JELA-843 virtual Tizen 5.0 rig, shell d73fd58f):
// a healthy installed TV sits at 3,654,913 UTF-16 code units = 69.7% of M63's
// 5,242,880-unit quota, and that occupancy has walked 64.6% -> 69.6% -> 69.7%
// over three releases. When the headroom is gone the boot does not FAIL, it
// silently and permanently regresses: 291 reqs / 2.69 MB against 193-196 /
// 1.80 MB healthy — +49% requests, +49% bytes, on every boot, forever, with
// 130 cards still rendering and no error surfaced. Attribution is JEL-619
// unwinding: /JellyfinEnhanced/js goes 3 -> 117 requests (+599,781 B).
//
// TWO MECHANISMS, BOTH PINNED BELOW WITH THEIR CONTROL ARMS (JELA-778's rule:
// never grade a fix against an arm where the defect had already decayed away).
//
// (1) THE PRUNE IS COUNT-BASED, NOT BYTE-BASED. __txPrune / txPruneStatic drop
//     exactly ten keys whatever their size. Ten 2,000-unit module entries free
//     20,000 units, so the retry of a 30,000-unit body throws AGAIN — the write
//     is lost for good (nothing re-attempts it) and ten cached requests were
//     destroyed to achieve nothing. Control arm c1 asserts exactly that.
//
// (2) EVICTION IS RANKED BY RECENCY, NEVER BY VALUE, and a `txc:` body is not
//     tracked at all unless JELA-799 (b) is armed. Every URL-keyed entry saves
//     one REQUEST when it hits. A `txc:` body that no version slot points at
//     saves only a Babel pass: its source was already downloaded before the
//     content hash could be computed, and a class-0 URL (the JSI channel's
//     ?_jsi=1) is refetched every boot by contract. So the census store kept a
//     923,476-unit transpile-only blob — 17.6% of the WHOLE quota — while 113
//     individually request-saving module entries were evicted around it.
//
// THE FIX: reclaim BY BYTES, ranked by requests-saved-per-unit-stored.
//   tier 0 = a `txc:` body with no live "@@shellref:" pointer -> first, largest
//            first (costs a Babel pass, never a request).
//   tier 1 = anything that saves a download -> largest first, so the byte
//            target is met while destroying the FEWEST cached requests.
// Admission is the same trade backwards: a transpile-only body may only
// displace other transpile-only bodies, and a request-saving body may displace
// at most ONE other — evicting ten to store one is net -9 requests, which is
// precisely what the fixed-ten prune did.
//
// Sizes here are UTF-16 CODE UNITS (k.length + v.length) — the unit the M63
// quota is denominated in (JELA-797). Do not restate them as "MB".
//
// Run: node scripts/tx-budget.test.cjs

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
const MINS = [
  [
    "shell.min.js",
    path.join(REPO, "packages", "shell-tizen", "src", "shell.min.js"),
  ],
  [
    "boot-shell.min.js",
    path.join(
      REPO,
      "packages",
      "shell-tizen-bootstrap",
      "src",
      "boot-shell.min.js",
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

// --- lift the shipping code (same mechanism as tx-gen-sweep.test.cjs) -------

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

// Both layers compile against ONE store and ONE LRU key, exactly as they run
// on device: the seed's __txSet and the widget's txSetStatic share the
// keyspace "shell.txT:" and the map "shell.txLruT".
const PFX = "shell.txT:";
const LRU = "shell.txLruT";
const BUDGET_KEY = "jellyfin.shell.txBudget";

function compile(src, label) {
  const widget = [
    "txKey",
    "pluginFetchCacheDisabled",
    "txQueryClass",
    "txStaticVal",
    "txWriteLost",
    "txLruStaticOn",
    "txLruRead",
    "txLruWrite",
    "txLruTouch",
    "txLruForget",
    "txPruneStatic",
    "txBudgetOn",
    "txNsScan",
    "txReclaim",
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
    'var TX_BUDGET_KEY="' +
    BUDGET_KEY +
    '";var TX_RECLAIM_SLACK=8192;' +
    'var PLUGIN_FETCH_CACHE_DISABLED_KEY="jellyfin.shell.pluginFetchCacheDisabled";' +
    'var __TXPFX="' +
    PFX +
    '";var __TXLRUKEY="' +
    LRU +
    '";var __TXREF="@@shellref:";' +
    'var __TXGENK="jellyfin.shell.txGenSweep";' +
    'var __TXBK="' +
    BUDGET_KEY +
    '";';
  // eslint-disable-next-line no-new-func
  return new Function(
    "localStorage",
    "window",
    prelude +
      widget +
      "\n" +
      seed +
      ";return {txSetStatic:txSetStatic,txGetStatic:txGetStatic," +
      "txReclaim:txReclaim,txNsScan:txNsScan,txStaticVal:txStaticVal," +
      "__txSet:__txSet,__txGet:__txGet,__txPrune:__txPrune," +
      "__txReclaim:__txReclaim};",
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

// A store shaped like the census one: one huge transpile-only `txc:` blob, a
// crowd of small request-saving module slots, and inert non-tx ballast that
// nothing in the tx layer may touch. Sized so that TEN module evictions do NOT
// free enough for the incoming body but the blob alone does — which is the
// whole disagreement between the two policies.
const BLOB = 90000; // stands in for the 923,476-unit public.js transpile
const MODULES = 20;
const MOD = 2000;
const INCOMING = 30000;
const BALLAST = 60000;
const LIMIT = BLOB + MODULES * MOD + BALLAST + 1000;

const MOD_URL = (i) => "https://srv/JellyfinEnhanced/m" + i + ".js";
const NEW_URL = "https://srv/JellyfinEnhanced/fresh.js";

function seedCensusStore(ls, opts) {
  opts = opts || {};
  // The unreferenced transpile-only blob. Nothing writes a "@@shellref:"
  // pointer at it — exactly the JSI channel's class-0 situation.
  if (!opts.noBlob)
    ls.setItem(PFX + "txc:blob", "z".repeat(BLOB - (PFX + "txc:blob").length));
  // Request-saving module slots, tracked in the LRU with ascending stamps so
  // "ten oldest" is well defined for the control arm.
  const lru = {};
  for (let i = 0; i < MODULES; i++) {
    const k = MOD_URL(i);
    ls.setItem(PFX + k, "m".repeat(MOD - (PFX + k).length));
    lru[k] = 1000 + i;
  }
  ls.setItem(LRU, JSON.stringify(lru));
  ls.setItem("__inert", "b".repeat(BALLAST));
  if (opts.budget) ls.setItem(BUDGET_KEY, "1");
}

function modulesLeft(ls) {
  let n = 0;
  for (let i = 0; i < MODULES; i++) if (ls._m.has(PFX + MOD_URL(i))) n++;
  return n;
}

for (const [label, file] of SHELLS) {
  const src = fs.readFileSync(file, "utf8");
  const make = compile(src, label);
  const body = "n".repeat(INCOMING);

  // ---- c1: THE CONTROL — flag dark, the fixed-ten prune loses the write ----
  {
    const ls = makeLS(LIMIT);
    const win = {};
    seedCensusStore(ls);
    const tx = make(ls, win);
    tx.__txSet(NEW_URL, body);
    check(
      label + " c1-control: the write is LOST despite a prune",
      !ls._m.has(PFX + NEW_URL),
      "entry present",
    );
    check(
      label + " c1-control: ten cached requests were destroyed for nothing",
      modulesLeft(ls) === MODULES - 10,
      modulesLeft(ls) + " of " + MODULES + " modules left",
    );
    check(
      label + " c1-control: the transpile-only blob survives it all",
      ls._m.has(PFX + "txc:blob"),
    );
    check(
      label + " c1-control: the lost write is counted (qe)",
      win.__shellLsQuotaErr === 1,
      String(win.__shellLsQuotaErr),
    );
  }

  // ---- c2: flag ON — the blob goes, every module stays, the write lands ----
  {
    const ls = makeLS(LIMIT);
    const win = {};
    seedCensusStore(ls, { budget: true });
    const tx = make(ls, win);
    tx.__txSet(NEW_URL, body);
    check(
      label + " c2: the incoming body is stored",
      ls._m.get(PFX + NEW_URL) === body,
    );
    check(
      label + " c2: the unreferenced txc: blob is what paid for it",
      !ls._m.has(PFX + "txc:blob"),
    );
    check(
      label + " c2: ALL " + MODULES + " request-saving entries survive",
      modulesLeft(ls) === MODULES,
      modulesLeft(ls) + "/" + MODULES,
    );
    check(
      label + " c2: nothing was reported as a lost write",
      !win.__shellLsQuotaErr,
      String(win.__shellLsQuotaErr),
    );
    check(
      label + " c2: the reclaim is reported for the fleet beacon",
      win.__shellTxReclaim &&
        win.__shellTxReclaim.n === 1 &&
        win.__shellTxReclaim.b >= BLOB - 64,
      JSON.stringify(win.__shellTxReclaim),
    );
    check(
      label + " c2: inert non-tx ballast is never touched",
      ls._m.get("__inert").length === BALLAST,
    );
  }

  // ---- c3: the kill switch restores the pre-844 behaviour exactly ---------
  {
    const ls = makeLS(LIMIT);
    const win = {};
    seedCensusStore(ls, { budget: true });
    ls.setItem(BUDGET_KEY + "Disabled", "1");
    const tx = make(ls, win);
    tx.__txSet(NEW_URL, body);
    check(
      label + " c3: kill switch -> fixed-ten prune, write still lost",
      !ls._m.has(PFX + NEW_URL) && modulesLeft(ls) === MODULES - 10,
    );
  }

  // ---- c4: reclaim is BYTE-TARGETED, not count-targeted -------------------
  {
    const ls = makeLS(LIMIT);
    const win = {};
    seedCensusStore(ls, { budget: true });
    const tx = make(ls, win);
    // No tier-0 candidate: ask for more than one module and watch the cap.
    ls.removeItem(PFX + "txc:blob");
    const got = tx.txReclaim(MOD * 5, null, 1);
    check(
      label + " c4: a request-saving body may displace at most ONE other",
      modulesLeft(ls) === MODULES - 1,
      modulesLeft(ls) + "/" + MODULES,
    );
    check(
      label + " c4: and it reports the units it actually freed",
      got > 0 && got < MOD * 5,
      String(got),
    );
  }

  // ---- c5: a REFERENCED txc: body is not transpile-only ------------------
  {
    const ls = makeLS(0);
    const win = {};
    const tx = make(ls, win);
    ls.setItem(BUDGET_KEY, "1");
    ls.setItem(PFX + "txc:live", "z".repeat(50000));
    // A version slot dereferences it — this body saves a DOWNLOAD, not a
    // Babel pass, so tier-0-only reclaim must refuse to touch it.
    ls.setItem(PFX + "https://srv/p.js?v=1.2.3", "@@shellref:txc:live");
    const got = tx.txReclaim(10000, null, 0);
    check(
      label + " c5: a pointed-at txc: body is NOT tier 0",
      got === 0 && ls._m.has(PFX + "txc:live"),
      String(got),
    );
    check(
      label + " c5: and the pointer itself is never a candidate",
      ls._m.has(PFX + "https://srv/p.js?v=1.2.3"),
    );
  }

  // ---- c6: admission — a transpile-only body cannot displace requests -----
  {
    // A store with NO tier-0 candidate and no free room: the only way to land
    // a transpile-only body here would be to evict request-savers, so it must
    // be refused instead.
    const ls = makeLS(MODULES * MOD + BALLAST + 1000);
    const win = {};
    seedCensusStore(ls, { budget: true, noBlob: true });
    const tx = make(ls, win);
    tx.txSetStatic("txc:newblob", "z".repeat(BLOB), 0);
    check(
      label + " c6: a val=0 body is refused rather than evict request-savers",
      !ls._m.has(PFX + "txc:newblob") && modulesLeft(ls) === MODULES,
      modulesLeft(ls) + "/" + MODULES,
    );
    check(
      label + " c6: the refusal is counted, not silent",
      win.__shellLsQuotaErr === 1,
      String(win.__shellLsQuotaErr),
    );
  }

  // ---- c7: index keys are load-bearing and never evicted ------------------
  {
    const ls = makeLS(0);
    const win = {};
    const tx = make(ls, win);
    ls.setItem(BUDGET_KEY, "1");
    ls.setItem(PFX + "vqk:https://srv/p.js", '{"k":"a","c":"txc:a"}');
    ls.setItem(PFX + "gqk:https://srv/p.js", "https://srv/p.js?v=1.2.3");
    ls.setItem(PFX + "ts:https://srv/p.js", "1700000000000");
    ls.setItem(PFX + "txc:junk", "z".repeat(50000));
    tx.txReclaim(1e9, null, 99);
    check(
      label + " c7: vqk:/gqk:/ts: index keys survive a total reclaim",
      ls._m.has(PFX + "vqk:https://srv/p.js") &&
        ls._m.has(PFX + "gqk:https://srv/p.js"),
    );
    check(
      label + " c7: but the unreferenced body itself does not",
      !ls._m.has(PFX + "txc:junk"),
    );
  }

  // ---- c8: the widget layer honours the same ranking ----------------------
  {
    const ls = makeLS(LIMIT);
    const win = {};
    seedCensusStore(ls, { budget: true });
    const tx = make(ls, win);
    tx.txSetStatic("txc:incoming", body, 1);
    check(
      label + " c8: txSetStatic stores after dropping the tier-0 blob",
      ls._m.get(PFX + "txc:incoming") === body &&
        !ls._m.has(PFX + "txc:blob") &&
        modulesLeft(ls) === MODULES,
    );
  }

  // ---- c9: admission value is derived from the QUERY CLASS ----------------
  {
    const ls = makeLS(0);
    const win = {};
    const tx = make(ls, win);
    check(
      label + " c9: class-0 (?_jsi=1) transpiles are worth 0 requests",
      tx.txStaticVal("https://srv/JsInjector/public.js?_jsi=1") === 0,
    );
    check(
      label + " c9: a version-pinned URL is worth a request",
      tx.txStaticVal("https://srv/p.js?v=12.5.0.0") === 1,
    );
    check(
      label + " c9: and so is a bare URL slot",
      tx.txStaticVal("https://srv/p.js") === 1,
    );
  }
}

// ---- source guards: the flag ships DARK in both shells and both blobs -----
for (const [label, file] of SHELLS.concat(MINS)) {
  const src = fs.readFileSync(file, "utf8");
  check(
    label + ": carries the JELA-844 reclaim",
    /txReclaim/.test(src) && /__txReclaim/.test(src),
  );
  // Dark by default: the opt-in literal must be present AND the kill switch
  // must be read within the same gate. The minifier keeps the key in a
  // variable, so match the '+ "Disabled"' concat inside the window right after
  // the literal rather than assuming the literal is spelled out twice.
  const at = src.indexOf('"jellyfin.shell.txBudget"');
  check(
    label + ": ships the opt-in flag and its kill switch",
    at !== -1 && /\+\s*"Disabled"/.test(src.slice(at, at + 400)),
  );
}

if (failures) {
  console.error("\n" + failures + " tx-budget check(s) FAILED");
  process.exit(1);
}
console.log("\nAll tx-budget checks passed.");
