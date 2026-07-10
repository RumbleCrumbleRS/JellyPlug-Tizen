/*
 * JELA-59 (JELA-57 WS-2): config-epoch boot gate — server fingerprint
 * (manifest configEpoch/components, JELA-58) vs the TV-persisted record.
 * Opt-in via localStorage['jellyfin.shell.configEpochGate']='1', default
 * OFF; kill switch 'jellyfin.shell.configEpochDisabled'='1' honored now.
 *
 * Extracts the SHIPPED gate block (+ loadTxDropManifest) from BOTH shells
 * and drives it with fake localStorage/fetch, pinning:
 *   - default OFF: no flag -> st="off", zero manifest fetches, CfgEM 0
 *   - kill switch beats the gate flag
 *   - manifest without the additive fields -> st="nofield", inert
 *   - fetch error -> st="err", inert (today's behavior)
 *   - fresh (no record) -> nothing invalidated; record commits ONLY via
 *     ceAdopt (write-after-adopt) with the spec'd shape
 *     {epoch,components,ts,origin}
 *   - match -> st="match", __shellCfgEM=1, nothing invalidated
 *   - origin switch -> treated as fresh (record is origin-keyed)
 *   - soft-TTL: matched record older than 7 days -> st="ttl", no
 *     suppression, refreshed record still write-after-adopt
 *   - mismatch -> component-SELECTIVE invalidation (scripts -> JSI clear +
 *     JEL-619 vqk/version-slot drop, web caches kept; web -> the four web
 *     body caches, JSI kept) and the OLD record stays until ceAdopt
 *   - suppression point (c): matched boot serves tx-drop manifest from the
 *     persisted copy with NO ?__sb= fetch (sup.txm counted); any other
 *     state does the busted fetch exactly as today and persists a copy
 *     for later matched boots (gate on only)
 * Plus static pins: the class-1 TTL waiver in the seed script, the JSI
 * max-age waiver, the boot-shell CSS miss-populate gate, and the flag /
 * kill-switch / counter literals shipping in both committed .min blobs.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const RETAIL_SRC = path.join(__dirname, "..", "src", "shell.js");
const BOOT_SRC = path.join(
  __dirname,
  "..",
  "..",
  "shell-tizen-bootstrap",
  "src",
  "boot-shell.src.js",
);
const RETAIL_MIN = path.join(__dirname, "..", "src", "shell.min.js");
const BOOT_MIN = path.join(
  __dirname,
  "..",
  "..",
  "shell-tizen-bootstrap",
  "src",
  "boot-shell.min.js",
);

let fails = 0;
function check(name, cond) {
  console.log((cond ? "OK: " : "FAIL: ") + name);
  if (!cond) fails++;
}

function extractGate(src) {
  const start = src.indexOf("  // ---- Config-epoch boot gate (JELA-59");
  const end = src.indexOf("  // ---- Pre-lowered transpile drop (JEL-621)");
  if (start < 0 || end < 0 || end <= start)
    throw new Error("gate block markers missing");
  const ceBlock = src.slice(start, end);
  const ltdStart = src.indexOf("  function loadTxDropManifest(serverUrl) {");
  const ltdEnd =
    src.indexOf(
      "\n  }\n",
      src.indexOf("window.__shellTxDropReady = p;", ltdStart),
    ) + 4;
  return ceBlock + "\n" + src.slice(ltdStart, ltdEnd);
}

function mkEnv(code) {
  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    key: (i) => Array.from(store.keys())[i],
    get length() {
      return store.size;
    },
  };
  const fetchLog = [];
  let manifestBody = null;
  const env = {
    window: {},
    localStorage,
    Date,
    Math,
    JSON,
    String,
    Promise,
    console,
    fetchLog,
    store,
    setManifest: (m) => {
      manifestBody = m;
    },
    fetch: (url) => {
      fetchLog.push(url);
      if (manifestBody === "neterr") return Promise.reject(new Error("net"));
      if (manifestBody === "http500")
        return Promise.resolve({ ok: false, status: 500 });
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(manifestBody),
        text: () => Promise.resolve(JSON.stringify(manifestBody)),
      });
    },
    withBootTimeout: (p) => p,
    jsiChannelCleared: 0,
    jsiChannelCacheClear: function () {
      env.jsiChannelCleared++;
    },
    TX_PFX: "shell.txTEST:",
    WEB_INDEX_CACHE_KEY: "jellyfin.shell.webIndexHtml",
    WEB_CONFIG_CACHE_KEY: "jellyfin.shell.webConfig",
    BUNDLE_CACHE_KEY: "jellyfin.shell.bundlePatchState",
    BABEL_OPTS_KEY: "BOK1",
    TXDROP_MANIFEST_PATH: "/shell/tx-manifest.json",
    isLegacyChromium: () => true,
    txDropDisabled: () => false,
  };
  vm.createContext(env);
  vm.runInContext(
    code +
      "\nthis.api={loadConfigEpoch:loadConfigEpoch,ceAdopt:ceAdopt," +
      "loadTxDropManifest:loadTxDropManifest,ceTxmWrite:ceTxmWrite};",
    env,
  );
  return env;
}

const S = "http://srv:8096";
const COMPS = { web: "w1", shell: "s1", scripts: "j1", branding: "b1" };

async function driveShell(label, code) {
  // A. default OFF
  let e = mkEnv(code);
  await e.api.loadConfigEpoch(S);
  check(
    label + ": default OFF -> st=off, no fetch, CfgEM 0",
    e.window.__shellConfigEpoch.st === "off" &&
      e.fetchLog.length === 0 &&
      e.window.__shellCfgEM === 0,
  );

  // kill switch beats gate flag
  e = mkEnv(code);
  e.store.set("jellyfin.shell.configEpochGate", "1");
  e.store.set("jellyfin.shell.configEpochDisabled", "1");
  await e.api.loadConfigEpoch(S);
  check(
    label + ": kill switch -> st=off, no fetch",
    e.window.__shellConfigEpoch.st === "off" && e.fetchLog.length === 0,
  );

  // manifest without field
  e = mkEnv(code);
  e.store.set("jellyfin.shell.configEpochGate", "1");
  e.setManifest({ version: "1.0.13.0", sha256: "x" });
  await e.api.loadConfigEpoch(S);
  check(
    label + ": no configEpoch field -> st=nofield, inert",
    e.window.__shellConfigEpoch.st === "nofield" && e.window.__shellCfgEM === 0,
  );

  // fetch error
  e = mkEnv(code);
  e.store.set("jellyfin.shell.configEpochGate", "1");
  e.setManifest("neterr");
  await e.api.loadConfigEpoch(S);
  check(
    label + ": manifest unreachable -> st=err, inert",
    e.window.__shellConfigEpoch.st === "err" && e.window.__shellCfgEM === 0,
  );

  // fresh + write-after-adopt shape
  e = mkEnv(code);
  e.store.set("jellyfin.shell.configEpochGate", "1");
  e.setManifest({ configEpoch: "E1", components: COMPS });
  await e.api.loadConfigEpoch(S);
  check(
    label + ": fresh -> st=fresh, NO record before adopt",
    e.window.__shellConfigEpoch.st === "fresh" &&
      !e.store.has("jellyfin.shell.configEpoch"),
  );
  e.api.ceAdopt();
  const rec = JSON.parse(e.store.get("jellyfin.shell.configEpoch"));
  check(
    label + ": adopt commits {epoch,components,ts,origin}",
    rec.epoch === "E1" &&
      rec.origin === S &&
      rec.components.web === "w1" &&
      rec.ts > 0 &&
      e.window.__shellConfigEpoch.pend === null,
  );

  // match
  e = mkEnv(code);
  e.store.set("jellyfin.shell.configEpochGate", "1");
  e.store.set(
    "jellyfin.shell.configEpoch",
    JSON.stringify({ origin: S, epoch: "E1", components: COMPS, ts: Date.now() }),
  );
  e.setManifest({ configEpoch: "E1", components: COMPS });
  await e.api.loadConfigEpoch(S);
  check(
    label + ": match -> st=match, CfgEM 1, nothing invalidated",
    e.window.__shellConfigEpoch.st === "match" &&
      e.window.__shellCfgEM === 1 &&
      e.jsiChannelCleared === 0,
  );

  // origin switch
  e = mkEnv(code);
  e.store.set("jellyfin.shell.configEpochGate", "1");
  e.store.set(
    "jellyfin.shell.configEpoch",
    JSON.stringify({
      origin: "http://other",
      epoch: "E1",
      components: COMPS,
      ts: Date.now(),
    }),
  );
  e.setManifest({ configEpoch: "E1", components: COMPS });
  await e.api.loadConfigEpoch(S);
  check(
    label + ": origin switch -> fresh, no suppression",
    e.window.__shellConfigEpoch.st === "fresh" && e.window.__shellCfgEM === 0,
  );

  // soft-TTL
  e = mkEnv(code);
  e.store.set("jellyfin.shell.configEpochGate", "1");
  e.store.set(
    "jellyfin.shell.configEpoch",
    JSON.stringify({
      origin: S,
      epoch: "E1",
      components: COMPS,
      ts: Date.now() - 8 * 864e5,
    }),
  );
  e.setManifest({ configEpoch: "E1", components: COMPS });
  await e.api.loadConfigEpoch(S);
  check(
    label + ": 7-day soft-TTL -> st=ttl, no suppression, pend set",
    e.window.__shellConfigEpoch.st === "ttl" &&
      e.window.__shellCfgEM === 0 &&
      !!e.window.__shellConfigEpoch.pend,
  );

  // scripts mismatch -> selective invalidation + write-after-adopt
  e = mkEnv(code);
  e.store.set("jellyfin.shell.configEpochGate", "1");
  e.store.set(
    "jellyfin.shell.configEpoch",
    JSON.stringify({ origin: S, epoch: "E1", components: COMPS, ts: Date.now() }),
  );
  e.store.set("jellyfin.shell.webIndexHtml", "IDX");
  e.store.set(
    "shell.txTEST:vqk:/JavaScriptInjector/public.js",
    JSON.stringify({ k: "/JavaScriptInjector/public.js?x=1", c: "txc:abc" }),
  );
  e.store.set(
    "shell.txTEST:/JavaScriptInjector/public.js?x=1",
    "@@shellref:txc:abc",
  );
  e.store.set("shell.txTEST:ts:/JavaScriptInjector/public.js?x=1", "123");
  e.setManifest({
    configEpoch: "E2",
    components: { web: "w1", shell: "s1", scripts: "j2", branding: "b1" },
  });
  await e.api.loadConfigEpoch(S);
  const st = e.window.__shellConfigEpoch;
  check(
    label + ": scripts mismatch -> inv=[scripts], jsi+vqk dropped, web kept",
    st.st === "mismatch" &&
      st.inv.join() === "scripts" &&
      e.jsiChannelCleared === 1 &&
      !e.store.has("shell.txTEST:vqk:/JavaScriptInjector/public.js") &&
      !e.store.has("shell.txTEST:/JavaScriptInjector/public.js?x=1") &&
      !e.store.has("shell.txTEST:ts:/JavaScriptInjector/public.js?x=1") &&
      e.store.get("jellyfin.shell.webIndexHtml") === "IDX",
  );
  check(
    label + ": mismatch keeps OLD record until adopt (write-after-adopt)",
    JSON.parse(e.store.get("jellyfin.shell.configEpoch")).epoch === "E1",
  );
  e.api.ceAdopt();
  check(
    label + ": adopt commits the NEW epoch",
    JSON.parse(e.store.get("jellyfin.shell.configEpoch")).epoch === "E2",
  );

  // web mismatch -> the four web body caches, JSI kept
  e = mkEnv(code);
  e.store.set("jellyfin.shell.configEpochGate", "1");
  e.store.set(
    "jellyfin.shell.configEpoch",
    JSON.stringify({ origin: S, epoch: "E1", components: COMPS, ts: Date.now() }),
  );
  e.store.set("jellyfin.shell.webIndexHtml", "IDX");
  e.store.set("jellyfin.shell.webConfig", "CFG");
  e.store.set("jellyfin.shell.bundlePatchState", "BPS");
  e.store.set("jellyfin.shell.stylesheetBodies", "CSS");
  e.setManifest({
    configEpoch: "E3",
    components: { web: "w2", shell: "s1", scripts: "j1", branding: "b1" },
  });
  await e.api.loadConfigEpoch(S);
  check(
    label + ": web mismatch -> 4 web caches cleared, JSI kept",
    e.window.__shellConfigEpoch.inv.join() === "web" &&
      !e.store.has("jellyfin.shell.webIndexHtml") &&
      !e.store.has("jellyfin.shell.webConfig") &&
      !e.store.has("jellyfin.shell.bundlePatchState") &&
      !e.store.has("jellyfin.shell.stylesheetBodies") &&
      e.jsiChannelCleared === 0,
  );

  // tx-drop manifest suppression (point (c))
  e = mkEnv(code);
  e.store.set("jellyfin.shell.configEpochGate", "1");
  e.store.set(
    "jellyfin.shell.configEpoch",
    JSON.stringify({ origin: S, epoch: "E1", components: COMPS, ts: Date.now() }),
  );
  e.setManifest({ configEpoch: "E1", components: COMPS });
  e.api.ceTxmWrite(S, { deadbeef: "tx/deadbeef.js" });
  await e.api.loadConfigEpoch(S);
  const n = e.fetchLog.length;
  const d = await e.api.loadTxDropManifest(S);
  check(
    label + ": matched boot serves tx-drop manifest from LS (no ?__sb=)",
    d &&
      d.ok &&
      d.entries.deadbeef === "tx/deadbeef.js" &&
      e.fetchLog.length === n &&
      e.window.__shellConfigEpoch.sup.txm === 1 &&
      e.window.__shellTxDrop &&
      e.window.__shellTxDrop.ok === true,
  );

  e = mkEnv(code);
  e.store.set("jellyfin.shell.configEpochGate", "1");
  e.setManifest({
    configEpoch: "E1",
    components: COMPS,
    entries: { h1: "tx/h1.js" },
    babelOptsKey: "BOK1",
  });
  await e.api.loadConfigEpoch(S);
  const before = e.fetchLog.length;
  const d2 = await e.api.loadTxDropManifest(S);
  check(
    label + ": non-matched boot does the busted fetch + persists a copy",
    d2 &&
      d2.ok &&
      e.fetchLog.length === before + 1 &&
      e.fetchLog[before].indexOf("?__sb=") > 0 &&
      JSON.parse(e.store.get("jellyfin.shell.txDropCache")).e.h1 === "tx/h1.js",
  );
}

(async () => {
  const retail = fs.readFileSync(RETAIL_SRC, "utf8");
  const boot = fs.readFileSync(BOOT_SRC, "utf8");

  await driveShell("shell.js", extractGate(retail));
  await driveShell("boot-shell.src.js", extractGate(boot));

  // Static pins — src: seed-script class-1 TTL waiver + JSI age waiver +
  // the epoch-gated SWR drain; boot-only CSS miss-populate gate.
  for (const [label, src] of [
    ["shell.js", retail],
    ["boot-shell.src.js", boot],
  ]) {
    check(
      label + ": seed __txGet carries the epoch TTL waiver",
      src.indexOf("864e5&&window.__shellCfgEM!==1") >= 0,
    );
    check(
      label + ": txGetStatic waives class-1 TTL only on match",
      /TX_QUERY_TTL_MS\)\s*{\s*(\/\/[^\n]*\n\s*)*if \(window\.__shellCfgEM !== 1\) return null;/.test(
        src,
      ),
    );
    check(
      label + ": jsiChannelCacheGet waives max-age only on match",
      /maxAge\)\s*{\s*(\/\/[^\n]*\n\s*)*if \(window\.__shellCfgEM !== 1\) return null;/.test(
        src,
      ),
    );
    check(
      label + ": SWR revalidation waits for the epoch gate (ceReady)",
      src.indexOf("ceReady()") >= 0 &&
        /ceSup\("idx"\)/.test(src) &&
        src.indexOf("loadConfigEpoch(serverUrl)") >= 0,
    );
  }
  check(
    "boot-shell.src.js: CSS miss-populate pass gated on the epoch match",
    /misses\.push[\s\S]{0,800}__shellCfgEM === 1[\s\S]{0,200}sup\.css/.test(
      boot,
    ),
  );

  // Static pins — deployed blobs carry the flag, kill switch and counters.
  for (const [label, minPath] of [
    ["shell.min.js", RETAIL_MIN],
    ["boot-shell.min.js", BOOT_MIN],
  ]) {
    const min = fs.readFileSync(minPath, "utf8");
    for (const lit of [
      "jellyfin.shell.configEpochGate",
      "jellyfin.shell.configEpochDisabled",
      "jellyfin.shell.configEpoch",
      "jellyfin.shell.txDropCache",
      "__shellConfigEpoch",
      "__shellCfgEM",
      "__shellEpochReady",
    ]) {
      check(label + " carries " + JSON.stringify(lit), min.indexOf(lit) >= 0);
    }
  }

  if (fails) {
    console.error("\nconfig-epoch.test.cjs: " + fails + " check(s) FAILED");
    process.exit(1);
  }
  console.log("\nconfig-epoch.test.cjs: all checks passed");
})();
