// JELA-854 regression test — the tx cache must not hold keys for an origin
// the runtime never asks for.
//
// The defect, measured on the JELA-112 virtual Tizen 5.0 rig across a
// five-boot kept-profile lineage (shell 25f8ed83): the store gained 305 tx
// by-URL keys / 1,813,571 UTF-16 code units — 34.6% of the M63 5,242,880-unit
// quota — addressed under a SECOND origin (the reverse-proxied server's own
// LAN address, which its plugin config emits into the module list it serves).
// The very same modules were already cached, and being hit, under the real
// server origin. Measured headroom went 1,550,000 -> ZERO in three boots.
//
// The tx cache key IS the URL, so those entries are unreachable BY
// CONSTRUCTION: nothing ever calls __txGet with that URL. The proof they were
// dead is in "shell.txLru<VER>" — __txGet stamps the LRU on every HIT, and
// the foreign keys' stamps never advanced past their write time while every
// server-origin sibling was restamped each boot.
//
// Sizes here are in UTF-16 CODE UNITS (k.length + v.length) — the unit the
// M63 quota is actually denominated in (JELA-797). Do not restate as "MB".
//
// Run: node scripts/tx-origin-guard.test.cjs

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

// --- lift the shipping code (same mechanism as tx-gen-sweep.test) -----------

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

// __txSweepForeign spans many array elements. Collect them from the line that
// opens the declaration to the line that closes it, evaluating each element as
// the string literal it is.
function liftSeedBlock(src, name, label) {
  const lines = src.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.includes("function " + name + "(") && /^['"]/.test(t)) {
      start = i;
      break;
    }
  }
  if (start === -1) throw new Error(label + ": seed block " + name + " absent");
  const out = [];
  for (let i = start; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!/^['"]/.test(t)) continue;
    // eslint-disable-next-line no-eval
    const piece = eval(t.replace(/,\s*$/, ""));
    out.push(piece);
    if (/}catch\(_\)\{\}\}\s*$/.test(piece) && out.length > 1) break;
  }
  return out.join("\n");
}

const PFX = "shell.txT:";
const LRU = "shell.txLruT";
const SRV = "https://srv.example";
const DOC = "https://doc.example"; // second anchor: the document we run in
const ALIEN = "http://127.0.0.1:8861"; // the origin nobody ever asks for

function compile(src, label, opts) {
  const o = opts || {};
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
    "__txForeign",
    "__txSet",
  ]
    .map((n) => liftSeedFn(src, n, label))
    .join("\n");
  const sweep = liftSeedBlock(src, "__txSweepForeign", label);
  const prelude =
    'var __TXPFX="' +
    PFX +
    '";var __TXLRUKEY="' +
    LRU +
    '";var __TXREF="@@shellref:";' +
    'var __TXGENK="jellyfin.shell.txGenSweep";' +
    'var __TXBK="jellyfin.shell.txBudget";' +
    "var __txOgOn=" +
    (o.off ? "false" : "true") +
    ";var __TXORG=" +
    JSON.stringify(o.anchors === undefined ? [SRV, DOC] : o.anchors) +
    ";";
  // eslint-disable-next-line no-new-func
  return new Function(
    "localStorage",
    "window",
    "URL",
    prelude +
      seed +
      "\n" +
      sweep +
      ";return {__txSet:__txSet,__txGet:__txGet,__txForeign:__txForeign," +
      "__txSweepForeign:__txSweepForeign,__txLru:__txLru};",
  );
}

function makeLS() {
  const m = new Map();
  return {
    get length() {
      return m.size;
    },
    key: (i) => Array.from(m.keys())[i] || null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _m: m,
    _units: () => {
      let t = 0;
      for (const [k, v] of m) t += k.length + v.length;
      return t;
    },
  };
}

function env(src, label, opts) {
  const ls = makeLS();
  const win = {};
  return { ls, win, api: compile(src, label, opts)(ls, win, URL) };
}

// JellyfinEnhanced's real shape: ?v=<plugin version> is a class-2 pinned
// token, which __txKey KEEPS — so the key really is the full versioned URL.
const MOD = "/JellyfinEnhanced/js/core/lifecycle.js?v=12.5.0.0";
const BODY = "x".repeat(6000);

for (const [label, file] of SHELLS) {
  const src = fs.readFileSync(file, "utf8");
  const L = (n) => label + ": " + n;

  // ---- 1. the predicate ----------------------------------------------------
  {
    const { api } = env(src, label);
    check(
      L("__txForeign flags a third origin"),
      api.__txForeign(ALIEN + MOD) === true,
    );
    check(
      L("__txForeign clears the server origin"),
      api.__txForeign(SRV + MOD) === false,
    );
    check(
      L("__txForeign clears the document origin (second anchor)"),
      api.__txForeign(DOC + MOD) === false,
      "a rig/LAN boot where S and document.baseURI disagree must keep caching",
    );
    check(
      L("__txForeign ignores a relative key"),
      api.__txForeign("../JellyfinEnhanced/script?v=12.5.0.0") === false,
    );
    check(
      L("__txForeign ignores a txc: content hash"),
      api.__txForeign("txc:q4byl6") === false,
    );
    check(
      L("__txForeign ignores an unparseable key"),
      api.__txForeign("http://") === false,
    );
  }

  // ---- 2. fail-safe: no anchor, or killed, means never refuse --------------
  {
    const noAnchor = env(src, label, { anchors: [] });
    check(
      L("no usable anchor leaves the guard inert"),
      noAnchor.api.__txForeign(ALIEN + MOD) === false,
      "a boot that cannot name its own origin must not start dropping cache",
    );
    noAnchor.api.__txSet(ALIEN + MOD, BODY);
    check(
      L("no usable anchor still caches"),
      noAnchor.ls.getItem(PFX + ALIEN + MOD) === BODY,
    );

    const killed = env(src, label, { off: true });
    check(
      L("kill switch disarms the predicate"),
      killed.api.__txForeign(ALIEN + MOD) === false,
    );
    killed.api.__txSet(ALIEN + MOD, BODY);
    check(
      L("kill switch restores the pre-854 write"),
      killed.ls.getItem(PFX + ALIEN + MOD) === BODY,
    );
  }

  // ---- 3. __txSet refuses a foreign key, wholly ----------------------------
  {
    const { ls, win, api } = env(src, label);
    ls.setItem("jellyfin.shell.txGenSweep", "1"); // gqk: index armed
    api.__txSet(ALIEN + MOD, BODY);
    check(L("foreign body not stored"), ls.getItem(PFX + ALIEN + MOD) === null);
    check(
      L('foreign "ts:" sibling not stored'),
      ls.getItem(PFX + "ts:" + ALIEN + MOD) === null,
    );
    check(
      L("no gqk: family index minted for a foreign key"),
      Array.from(ls._m.keys()).every((k) => k.indexOf("gqk:") < 0),
    );
    check(
      L("foreign key never enters the LRU"),
      Object.keys(api.__txLru()).length === 0,
      JSON.stringify(api.__txLru()),
    );
    check(L("refusal is counted"), win.__shellTxOriginSkip === 1);
    check(L("store is untouched"), ls._m.size === 1);

    // the same module under the real origin still caches AND still reads back
    api.__txSet(SRV + MOD, BODY);
    check(
      L("server-origin body still stored"),
      ls.getItem(PFX + SRV + MOD) === BODY,
    );
    check(L("server-origin body reads back"), api.__txGet(SRV + MOD) === BODY);
    check(
      L("server-origin key is tracked in the LRU"),
      api.__txLru()[SRV + MOD] > 0,
    );
  }

  // ---- 4. the sweep reclaims an already-poisoned store ---------------------
  // Reproduces the measured end state in miniature: live server-origin keys
  // interleaved with a full second copy under the alien origin, plus the
  // "ts:"/"gqk:"/"vqk:" satellites that are named after the URL they serve.
  {
    const { ls, win, api } = env(src, label);
    const live = [];
    const dead = [];
    for (let i = 0; i < 12; i++) {
      const p = "/JellyfinEnhanced/js/m" + i + ".js?v=12.5.0.0";
      live.push(SRV + p);
      dead.push(ALIEN + p);
      ls.setItem(PFX + SRV + p, BODY);
      ls.setItem(PFX + ALIEN + p, BODY);
    }
    ls.setItem(PFX + "ts:" + dead[0], "1788249001070");
    ls.setItem(PFX + "gqk:" + ALIEN + "/JellyfinEnhanced/js/m0.js", dead[0]);
    ls.setItem(
      PFX + "vqk:" + ALIEN + "/JellyfinEnhanced/js/m0.js",
      JSON.stringify({ k: dead[0], c: "txc:dead" }),
    );
    ls.setItem(PFX + "ts:" + live[0], "1788249001070");
    ls.setItem(PFX + "gqk:" + SRV + "/JellyfinEnhanced/js/m0.js", live[0]);
    ls.setItem(PFX + "txc:keep", "body");
    ls.setItem("jellyfin.shell.serverUrl", SRV);
    const lru = {};
    for (const k of live.concat(dead)) lru[k] = 1788249001070;
    ls.setItem(LRU, JSON.stringify(lru));
    // What the sweep should report: FULL key + value, over exactly the tx
    // entries whose URL belongs to the alien origin — the same units a
    // localStorage census counts, so a QA gate can compare the two directly. Measured against the
    // store rather than restated by hand, so the expectation cannot drift
    // from the fixture.
    let expectN = 0;
    let expectB = 0;
    for (const [k, v] of ls._m) {
      if (k.indexOf(PFX) !== 0) continue;
      let u = k.substring(PFX.length);
      if (u.indexOf("ts:") === 0) u = u.substring(3);
      else if (u.indexOf("gqk:") === 0 || u.indexOf("vqk:") === 0)
        u = u.substring(4);
      if (u.indexOf(ALIEN) !== 0) continue;
      expectN++;
      expectB += k.length + v.length;
    }

    api.__txSweepForeign();

    check(
      L("sweep dropped every foreign body"),
      dead.every((k) => ls.getItem(PFX + k) === null),
    );
    check(
      L("sweep dropped the foreign ts:/gqk:/vqk: satellites"),
      ls.getItem(PFX + "ts:" + dead[0]) === null &&
        ls.getItem(PFX + "gqk:" + ALIEN + "/JellyfinEnhanced/js/m0.js") ===
          null &&
        ls.getItem(PFX + "vqk:" + ALIEN + "/JellyfinEnhanced/js/m0.js") ===
          null,
    );
    check(
      L("sweep kept every live body"),
      live.every((k) => ls.getItem(PFX + k) === BODY),
    );
    check(
      L("sweep kept the live ts:/gqk: satellites"),
      ls.getItem(PFX + "ts:" + live[0]) === "1788249001070" &&
        ls.getItem(PFX + "gqk:" + SRV + "/JellyfinEnhanced/js/m0.js") ===
          live[0],
    );
    check(
      L("sweep kept the txc: content-addressed body"),
      ls.getItem(PFX + "txc:keep") === "body",
      "a txc: key carries no origin and must never be judged foreign",
    );
    check(
      L("sweep left non-tx keys alone"),
      ls.getItem("jellyfin.shell.serverUrl") === SRV,
    );
    const m = api.__txLru();
    check(
      L("sweep purged the LRU of dead keys"),
      dead.every((k) => m[k] === undefined) &&
        live.every((k) => m[k] === 1788249001070),
    );
    check(
      L("sweep reports what it reclaimed"),
      win.__shellTxOriginSweep &&
        win.__shellTxOriginSweep.n === expectN &&
        win.__shellTxOriginSweep.b === expectB,
      JSON.stringify(win.__shellTxOriginSweep) +
        " vs {n:" +
        expectN +
        ",b:" +
        expectB +
        "}",
    );
    check(
      L("live traffic still hits after the sweep"),
      api.__txGet(live[0]) === BODY,
      "the reclaim must cost zero cached requests — there was never a request",
    );
  }

  // ---- 5. the sweep is a no-op when the guard cannot name an origin --------
  {
    const { ls, api } = env(src, label, { anchors: [] });
    ls.setItem(PFX + ALIEN + MOD, BODY);
    api.__txSweepForeign();
    check(
      L("anchor-less sweep deletes nothing"),
      ls.getItem(PFX + ALIEN + MOD) === BODY,
    );
  }

  // ---- 6. the upstream filters, pinned in source ---------------------------
  // These two sit inside multi-statement seed blocks that no sandbox lifts, so
  // pin them textually: without them a poisoned __DYNKEY (capped at the last
  // 100 URLs) keeps EVICTING the real URLs it exists to replay, and keeps
  // feeding the JEL-131 primer fetch candidates that can only 404 or hang.
  {
    check(
      L("__recDyn refuses to record a foreign URL"),
      /if\(!src\)return;[\s\S]{0,900}?if\(__txForeign\(abs\)\)return;/.test(
        src,
      ),
    );
    check(
      L("the primer's norm() rejects a foreign candidate"),
      /function norm\(u\)\{[\s\S]{0,900}?if\(__txForeign\(abs\)\)return null;/.test(
        src,
      ),
    );
    check(
      L("the sweep runs on the every-boot hygiene timer"),
      /__txSweepForeign\(\);/.test(src) && /12000\);\}catch\(_\)\{\}/.test(src),
    );
    check(
      L("__DYNKEY is rewritten free of foreign URLs"),
      /window\.__shellDynOriginDrop=ds\.length-keep\.length;/.test(src),
    );
    check(
      L("the guard has a documented kill switch"),
      src.includes("jellyfin.shell.txOriginGuardDisabled"),
    );
  }
}

if (failures) {
  console.error("\n" + failures + " check(s) FAILED");
  process.exit(1);
}
console.log("\nAll JELA-854 origin-guard checks passed.");
