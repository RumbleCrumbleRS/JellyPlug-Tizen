// JEL-132 verification — creds-guard against jellyfin-web's
// validate-clears-token behaviour.
//
// jellyfin-web 10.11's connection manager nulls UserId/AccessToken on ANY
// failure of the authenticated GET /System/Info it issues at boot (network
// blip, DNS, reverse-proxy 502 — not just a real 401) and persists the strip
// through the credential provider. One transient outage at TV boot
// permanently logs the TV out: the server stays in the list, the user is
// re-asked to log in (the JEL-132 field report). The guard seed taps
// fetch/XHR observe-only and vetoes the localStorage write that strips a
// previously-present AccessToken unless the clear is legitimate (401/403
// validate outcome, or an observed POST /Sessions/Logout).
//
// WHAT THIS PINS
//   PART A — CONTRACT: kill switch, trail key, diag object and the XHR tap
//            marker exist in all four shipped artifacts (shell.js,
//            shell.min.js, boot-shell.src.js, boot-shell.min.js).
//   PART B — EXECUTION (both src seeds, vm harness):
//     B1. boot trail entry records creds presence/token count.
//     B2. network-level validate failure (fetch reject) → strip vetoed,
//         token survives in storage, veto event in trail.
//     B3. proxy 502 validate failure → strip vetoed.
//     B4. real 401 validate outcome → strip passes through (sign-out is
//         legitimate; revoked tokens self-heal).
//     B5. observed POST /Sessions/Logout → strip passes through even with
//         a network-failed validate (explicit user sign-out wins).
//     B6. no observed validate at all → strip passes through (no positive
//         evidence, guard stays conservative).
//     B7. kill switch jellyfin.shell.credsGuardDisabled=1 → guard fully off.
//     B8. XHR validate path (status 0) → strip vetoed.
//     B9. Storage.prototype wrap path: veto works through the prototype and
//         a second (sessionStorage-like) instance passes through untouched.
//     B10. trail ring is capped at 8 entries.
//     B11. config.json seed shim still short-circuits through the guard's
//          fetch wrapper (interplay).
//
// JEL-134 (JEL-132 v2) — IndexedDB creds vault. The on-device trail capture
// (tooling/tv-validate/creds-guard/jel132-trail-capture.md) proved hard TV
// restarts roll localStorage back to the last durable commit, destroying a
// freshly-saved token — no setItem veto survives that. The guard now mirrors
// tokened jellyfin_credentials writes into IDB (jellyfin_shell/kv, key
// credsBackup) and both shells restore from the vault in the pre-rewrite
// boot path (restoreCredsVault, gated into the document.write Promise.all).
//
//   PART C — VAULT MIRROR POLICY (both src seeds, vm harness):
//     C1. tokened creds write → mirrored into the vault (counter vm).
//     C2. boot-time mirror: LS already tokened when the seed runs → vault
//         primed without any setItem (pre-JEL-134 login convergence).
//     C3. observed POST /Sessions/Logout + tokenless write → vault synced
//         tokenless (intentional sign-outs never resurrected).
//     C4. 401 validate + tokenless write → vault synced tokenless (revoked
//         tokens never resurrected).
//     C5. causeless tokenless write (rollback-recreated server entry) →
//         vault NOT overwritten.
//     C6. enableAutoLogin === "false" → no mirroring at all.
//     C7. kill switch jellyfin.shell.credsGuardDisabled=1 → vault off.
//     C8. vetoed strip → vault re-mirrors the merged (tokened) value.
//   PART D — VAULT RESTORE POLICY (both shells' restoreCredsVault):
//     D1. LS creds key absent + tokened vault → whole vault value restored,
//         trail {e:"restore"} recorded, __shellCredsRestored counter set.
//     D2. LS creds present tokenless (same server Id) + tokened vault →
//         token+UserId merged by Id, other fields of the LS write kept.
//     D3. LS already tokened → no restore.
//     D4. tokenless vault → no restore (post-invalidation state).
//     D5. enableAutoLogin === "false" → no restore.
//     D6. kill switch → no restore.
//     D7. indexedDB missing/broken → resolves without restoring (boot
//         never stalls; promise always settles).
//     D8. vault server Id ≠ LS server Id → no cross-server resurrection.
//     D9. composite no-loop: restore → 401 validate → strip passes AND
//         invalidates the vault → second restore is a no-op.
//
// Run: node scripts/creds-guard.test.cjs
//   or: pnpm --filter @jellyfin-tv/shell-tizen test

"use strict";
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

const ARTIFACTS = [
  ["shell.js", tvSrc],
  ["shell.min.js", tvMin],
  ["boot-shell.src.js", bootSrc],
  ["boot-shell.min.js", bootMin],
];

// ============================================================================
// PART A — CONTRACT
// ============================================================================
for (const [name, src] of ARTIFACTS) {
  check(
    name + ": guard kill switch present",
    src.includes("jellyfin.shell.credsGuardDisabled"),
  );
  check(
    name + ": boot trail key present",
    src.includes("jellyfin.shell.credsTrail"),
  );
  check(name + ": diag object present", src.includes("__shellCredsGuard"));
  check(name + ": XHR tap marker present", src.includes("__shellCgU"));
  check(
    name + ": vault DB/store/key present",
    src.includes("jellyfin_shell") && src.includes("credsBackup"),
  );
  check(
    name + ": restore diag counter present",
    src.includes("__shellCredsRestored"),
  );
  check(name + ": autoLogin opt-out honored", src.includes("enableAutoLogin"));
}

// ============================================================================
// PART B — EXECUTION
// ============================================================================
const SERVER = "https://srv.test";
const CK = "jellyfin_credentials";
const TRK = "jellyfin.shell.credsTrail";

const CREDS_FULL = JSON.stringify({
  Servers: [
    {
      Id: "srv1",
      AccessToken: "tok123",
      UserId: "u1",
      ManualAddress: SERVER,
      DateLastAccessed: 111,
    },
  ],
});
// what the connection manager writes after validateAuthentication fails:
// same server entry, token/user nulled, DateLastAccessed bumped.
const CREDS_STRIPPED = JSON.stringify({
  Servers: [
    {
      Id: "srv1",
      AccessToken: null,
      UserId: null,
      ManualAddress: SERVER,
      DateLastAccessed: 222,
    },
  ],
});

function extractTopFn(src, name) {
  const lines = src.split("\n");
  let s = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("  function " + name + "(")) {
      s = i;
      break;
    }
  }
  if (s === -1) throw new Error("function not found: " + name);
  for (let i = s + 1; i < lines.length; i++) {
    if (lines[i] === "  }") return lines.slice(s, i + 1).join("\n");
  }
  throw new Error("no closing brace for: " + name);
}

function buildSeed(src) {
  const fnSrc = extractTopFn(src, "buildSeedScript").replace(
    /^  function buildSeedScript/,
    "function",
  );
  const sb = { Object, JSON, TX_VER: "credstest" };
  vm.createContext(sb);
  const build = vm.runInContext("(" + fnSrc + ")", sb);
  return build(SERVER, {});
}

function extractRestoreFn(src) {
  return extractTopFn(src, "restoreCredsVault").replace(
    /^  function restoreCredsVault/,
    "function",
  );
}

// ---- IndexedDB fake: ES5 callback API, microtask-async like the real one.
// Shared `store` object = the durable vault ({credsBackup: {v,ts,t}}).
function makeIndexedDB(store) {
  function fire(fn) {
    Promise.resolve().then(() => {
      if (typeof fn === "function") fn();
    });
  }
  const api = {
    _store: store,
    _opens: 0,
    _puts: 0,
    open(name) {
      api._opens++;
      api._lastName = name;
      const rq = {};
      const db = {
        close() {},
        createObjectStore() {},
        transaction() {
          const tx = {};
          tx.objectStore = function () {
            return {
              put(val, key) {
                api._puts++;
                store[key] = val;
                fire(() => {
                  if (tx.oncomplete) tx.oncomplete();
                });
                return {};
              },
              get(key) {
                const r = {};
                r.result = store[key];
                fire(() => {
                  if (r.onsuccess) r.onsuccess();
                });
                return r;
              },
            };
          };
          return tx;
        },
      };
      rq.result = db;
      fire(() => {
        if (!api._upgraded) {
          api._upgraded = true;
          if (rq.onupgradeneeded) rq.onupgradeneeded();
        }
        if (rq.onsuccess) rq.onsuccess();
      });
      return rq;
    },
  };
  return api;
}

function makeHarness(seedText, opts) {
  opts = opts || {};
  function noopTimer() {
    return 0;
  }

  // ---- fetch stub: opts.net maps pathname -> {status} | "reject" ----------
  const fetched = [];
  function vFetch(url) {
    const u = String(url);
    fetched.push(u);
    let p = u;
    try {
      p = new URL(u, SERVER + "/web/").pathname;
    } catch (_) {}
    const r = opts.net && opts.net[p];
    if (r === "reject") return Promise.reject(new TypeError("Failed to fetch"));
    const st = r && r.status != null ? r.status : 200;
    return Promise.resolve({ ok: st >= 200 && st < 300, status: st });
  }

  // ---- XHR stub: fires loadend synchronously on send -----------------------
  const xhrStatus = opts.xhrStatus || {};
  function XHR() {
    this._ls = {};
  }
  XHR.prototype.open = function (m, u) {
    this._url = String(u || "");
  };
  XHR.prototype.send = function () {
    let p = this._url;
    try {
      p = new URL(this._url, SERVER + "/web/").pathname;
    } catch (_) {}
    this.status = xhrStatus[p] != null ? xhrStatus[p] : 200;
    const ls = this._ls.loadend || [];
    for (const f of ls) f.call(this);
  };
  XHR.prototype.addEventListener = function (t, f) {
    (this._ls[t] = this._ls[t] || []).push(f);
  };

  // ---- Storage fake: real prototype so the guard wraps it ------------------
  function Storage() {
    this._s = {};
  }
  Storage.prototype.getItem = function (k) {
    return k in this._s ? this._s[k] : null;
  };
  Storage.prototype.setItem = function (k, v) {
    this._s[k] = String(v);
  };
  Storage.prototype.removeItem = function (k) {
    delete this._s[k];
  };
  const localStorage = new Storage();
  Object.defineProperty(localStorage, "length", {
    get() {
      return Object.keys(this._s).length;
    },
  });
  const sessionStorage = new Storage();
  for (const k of Object.keys(opts.localStorage || {}))
    localStorage._s[k] = String(opts.localStorage[k]);

  // ---- IndexedDB fake: opts.vault seeds the durable store -----------------
  const idb = opts.noIndexedDB ? undefined : makeIndexedDB(opts.vault || {});

  function Response(body, init) {
    this._body = String(body);
    this.status = (init && init.status) || 200;
    this.ok = this.status >= 200 && this.status < 300;
  }
  Response.prototype.text = function () {
    return Promise.resolve(this._body);
  };
  Response.prototype.json = function () {
    return Promise.resolve(JSON.parse(this._body));
  };

  const doc = {
    baseURI: SERVER + "/web/",
    body: null,
    activeElement: null,
    createElement: () => ({ style: {}, setAttribute() {} }),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementsByTagName: () => [],
    addEventListener() {},
    registerElement: undefined,
  };

  const win = {};
  const sandbox = {
    window: win,
    document: doc,
    navigator: { userAgent: "tizen-test" },
    XMLHttpRequest: XHR,
    Storage: opts.noStorageCtor ? undefined : Storage,
    Response,
    URL,
    Promise,
    Object,
    JSON,
    Array,
    Math,
    Date,
    RegExp,
    String,
    Number,
    Boolean,
    Error,
    Function,
    console: { log() {}, warn() {}, error() {} },
    setTimeout: noopTimer,
    clearTimeout() {},
    setInterval: noopTimer,
    clearInterval() {},
    localStorage,
    indexedDB: idb,
    Node: function () {},
    HTMLScriptElement: function () {},
    Element: function () {},
  };
  sandbox.Node.prototype = {};
  sandbox.HTMLScriptElement.prototype = {};
  sandbox.Element.prototype = {};
  win.addEventListener = () => {};
  win.fetch = vFetch;
  win.indexedDB = idb;
  win.location = { replace() {}, hash: "", search: "" };
  win.setTimeout = noopTimer;
  win.setInterval = noopTimer;
  win.clearTimeout = () => {};
  win.clearInterval = () => {};
  win.localStorage = localStorage;
  win.sessionStorage = sessionStorage;
  win.Storage = sandbox.Storage;
  win.document = doc;
  win.console = sandbox.console;
  win.navigator = sandbox.navigator;

  vm.createContext(sandbox);
  if (seedText) vm.runInContext(seedText, sandbox, { filename: "seed.js" });

  async function drainMicro() {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  }

  // runs the lifted restoreCredsVault() inside this sandbox (pre-rewrite
  // boot path uses the same globals: localStorage, indexedDB, window).
  function runRestore(restoreFnSrc) {
    return vm.runInContext("(" + restoreFnSrc + ")()", sandbox, {
      filename: "restore.js",
    });
  }

  return {
    win,
    sandbox,
    localStorage,
    sessionStorage,
    fetched,
    drainMicro,
    idb,
    runRestore,
  };
}

function trailOf(h) {
  const raw = h.localStorage.getItem(TRK);
  return raw ? JSON.parse(raw) : null;
}

async function scenarios(name, seedText) {
  // ---- B1: boot trail -------------------------------------------------------
  {
    const h = makeHarness(seedText, { localStorage: { [CK]: CREDS_FULL } });
    const G = h.win.__shellCredsGuard;
    check(name + " B1: guard armed", G && G.st === "on", JSON.stringify(G));
    const tr = trailOf(h);
    check(
      name + " B1: boot trail records creds present + 1 token",
      tr &&
        tr.length === 1 &&
        tr[0].e === "boot" &&
        tr[0].p === 1 &&
        tr[0].n === 1 &&
        tr[0].t === 1,
      JSON.stringify(tr),
    );
  }

  // ---- B2: network-level validate failure → veto ----------------------------
  {
    const h = makeHarness(seedText, {
      localStorage: { [CK]: CREDS_FULL },
      net: { "/System/Info": "reject" },
    });
    await h.win.fetch(SERVER + "/System/Info").catch(() => {});
    await h.drainMicro();
    h.localStorage.setItem(CK, CREDS_STRIPPED);
    const after = JSON.parse(h.localStorage.getItem(CK));
    check(
      name + " B2: token survives a network-failed validate strip",
      after.Servers[0].AccessToken === "tok123" &&
        after.Servers[0].UserId === "u1",
      h.localStorage.getItem(CK),
    );
    check(
      name + " B2: non-token fields of the new write are kept",
      after.Servers[0].DateLastAccessed === 222,
    );
    const G = h.win.__shellCredsGuard;
    check(
      name + " B2: counters strips=1 vetoes=1",
      G.strips === 1 && G.vetoes === 1,
      JSON.stringify(G),
    );
    const tr = trailOf(h);
    check(
      name + " B2: veto event in trail with s=0",
      tr && tr[tr.length - 1].e === "veto" && tr[tr.length - 1].s === 0,
      JSON.stringify(tr),
    );
  }

  // ---- B3: proxy 502 validate failure → veto --------------------------------
  {
    const h = makeHarness(seedText, {
      localStorage: { [CK]: CREDS_FULL },
      net: { "/System/Info": { status: 502 } },
    });
    await h.win.fetch(SERVER + "/System/Info");
    await h.drainMicro();
    h.localStorage.setItem(CK, CREDS_STRIPPED);
    const after = JSON.parse(h.localStorage.getItem(CK));
    check(
      name + " B3: token survives a 502 validate strip",
      after.Servers[0].AccessToken === "tok123",
    );
  }

  // ---- B4: real 401 → strip passes through ----------------------------------
  {
    const h = makeHarness(seedText, {
      localStorage: { [CK]: CREDS_FULL },
      net: { "/System/Info": { status: 401 } },
    });
    await h.win.fetch(SERVER + "/System/Info");
    await h.drainMicro();
    h.localStorage.setItem(CK, CREDS_STRIPPED);
    const after = JSON.parse(h.localStorage.getItem(CK));
    const G = h.win.__shellCredsGuard;
    check(
      name + " B4: 401 strip is persisted (no veto)",
      after.Servers[0].AccessToken === null && G.strips === 1 && G.vetoes === 0,
      JSON.stringify(G),
    );
    const tr = trailOf(h);
    check(
      name + " B4: strip event in trail with s=401",
      tr && tr[tr.length - 1].e === "strip" && tr[tr.length - 1].s === 401,
      JSON.stringify(tr),
    );
  }

  // ---- B5: explicit logout wins over a network-failed validate --------------
  {
    const h = makeHarness(seedText, {
      localStorage: { [CK]: CREDS_FULL },
      net: { "/System/Info": "reject", "/Sessions/Logout": { status: 204 } },
    });
    await h.win.fetch(SERVER + "/Sessions/Logout");
    await h.win.fetch(SERVER + "/System/Info").catch(() => {});
    await h.drainMicro();
    h.localStorage.setItem(CK, CREDS_STRIPPED);
    const after = JSON.parse(h.localStorage.getItem(CK));
    const G = h.win.__shellCredsGuard;
    check(
      name + " B5: logout strip is persisted (no veto)",
      after.Servers[0].AccessToken === null && G.vetoes === 0,
      JSON.stringify(G),
    );
  }

  // ---- B6: no observed validate → strip passes through ----------------------
  {
    const h = makeHarness(seedText, { localStorage: { [CK]: CREDS_FULL } });
    h.localStorage.setItem(CK, CREDS_STRIPPED);
    const after = JSON.parse(h.localStorage.getItem(CK));
    const G = h.win.__shellCredsGuard;
    check(
      name + " B6: strip with no validate signal is persisted",
      after.Servers[0].AccessToken === null && G.strips === 1 && G.vetoes === 0,
      JSON.stringify(G),
    );
  }

  // ---- B7: kill switch -------------------------------------------------------
  {
    const h = makeHarness(seedText, {
      localStorage: {
        [CK]: CREDS_FULL,
        "jellyfin.shell.credsGuardDisabled": "1",
      },
      net: { "/System/Info": "reject" },
    });
    const G = h.win.__shellCredsGuard;
    check(name + " B7: kill switch reports off", G && G.st === "off");
    check(name + " B7: no trail written when off", trailOf(h) === null);
    await h.win.fetch(SERVER + "/System/Info").catch(() => {});
    await h.drainMicro();
    h.localStorage.setItem(CK, CREDS_STRIPPED);
    const after = JSON.parse(h.localStorage.getItem(CK));
    check(
      name + " B7: strip passes through when off",
      after.Servers[0].AccessToken === null,
    );
  }

  // ---- B8: XHR validate path (status 0) → veto -------------------------------
  {
    const h = makeHarness(seedText, {
      localStorage: { [CK]: CREDS_FULL },
      xhrStatus: { "/System/Info": 0 },
    });
    const X = new h.sandbox.XMLHttpRequest();
    // exercise the wrapped prototype the way jellyfin-web would
    h.sandbox.XMLHttpRequest.prototype.open.call(
      X,
      "GET",
      SERVER + "/System/Info",
    );
    h.sandbox.XMLHttpRequest.prototype.send.call(X);
    h.localStorage.setItem(CK, CREDS_STRIPPED);
    const after = JSON.parse(h.localStorage.getItem(CK));
    check(
      name + " B8: token survives an XHR status-0 validate strip",
      after.Servers[0].AccessToken === "tok123",
      h.localStorage.getItem(CK),
    );
  }

  // ---- B9: prototype wrap — other Storage instances untouched ----------------
  {
    const h = makeHarness(seedText, {
      localStorage: { [CK]: CREDS_FULL },
      net: { "/System/Info": "reject" },
    });
    check(
      name + " B9: guard wrapped Storage.prototype (shared instances)",
      h.localStorage.setItem === h.sessionStorage.setItem,
    );
    await h.win.fetch(SERVER + "/System/Info").catch(() => {});
    await h.drainMicro();
    h.sessionStorage.setItem(CK, CREDS_STRIPPED);
    const ses = JSON.parse(h.sessionStorage.getItem(CK));
    check(
      name + " B9: sessionStorage creds write passes through unmodified",
      ses.Servers[0].AccessToken === null,
    );
    h.localStorage.setItem(CK, CREDS_STRIPPED);
    const loc = JSON.parse(h.localStorage.getItem(CK));
    check(
      name + " B9: localStorage creds write still vetoed",
      loc.Servers[0].AccessToken === "tok123",
    );
  }

  // ---- B10: trail ring cap ----------------------------------------------------
  {
    const h = makeHarness(seedText, { localStorage: { [CK]: CREDS_FULL } });
    for (let i = 0; i < 12; i++) {
      h.localStorage.setItem(CK, CREDS_STRIPPED);
      h.localStorage.setItem(CK, CREDS_FULL);
    }
    const tr = trailOf(h);
    check(
      name + " B10: trail ring capped at 8",
      tr && tr.length === 8,
      tr && String(tr.length),
    );
  }

  // ---- B11: config.json shim interplay ----------------------------------------
  {
    const h = makeHarness(seedText, { localStorage: { [CK]: CREDS_FULL } });
    const r = await h.win.fetch(SERVER + "/web/config.json");
    const cfg = await r.json();
    check(
      name + " B11: config.json still short-circuits through the guard tap",
      r.status === 200 &&
        Array.isArray(cfg.servers) &&
        cfg.servers[0] === SERVER,
      JSON.stringify(cfg),
    );
    check(
      name + " B11: config.json fetch never hit the network",
      !h.fetched.some((u) => u.indexOf("config.json") >= 0),
    );
  }
}

// ============================================================================
// PART C — VAULT MIRROR POLICY (seed-side)
// ============================================================================
const CREDS_FULL_2 = JSON.stringify({
  Servers: [
    {
      Id: "srv1",
      AccessToken: "tok456",
      UserId: "u1",
      ManualAddress: SERVER,
      DateLastAccessed: 333,
    },
  ],
});

function vaultRec(h) {
  return h.idb && h.idb._store ? h.idb._store.credsBackup : undefined;
}

async function vaultMirrorScenarios(name, seedText) {
  // ---- C1: tokened creds write → mirrored -----------------------------------
  {
    const h = makeHarness(seedText, {});
    h.localStorage.setItem(CK, CREDS_FULL);
    await h.drainMicro();
    const rec = vaultRec(h);
    check(
      name + " C1: login write mirrored into vault",
      rec && rec.t === 1 && rec.v === CREDS_FULL,
      JSON.stringify(rec),
    );
    check(
      name + " C1: mirror counter vm=1",
      h.win.__shellCredsGuard.vm === 1,
      JSON.stringify(h.win.__shellCredsGuard),
    );
  }

  // ---- C2: boot-time mirror of an already-tokened localStorage ---------------
  {
    const h = makeHarness(seedText, { localStorage: { [CK]: CREDS_FULL } });
    await h.drainMicro();
    const rec = vaultRec(h);
    check(
      name + " C2: pre-existing token boot-mirrored",
      rec &&
        rec.t === 1 &&
        rec.v === CREDS_FULL &&
        h.win.__shellCredsGuard.vm === 1,
      JSON.stringify(rec),
    );
  }

  // ---- C3: logout → tokenless write syncs the vault tokenless ----------------
  {
    const h = makeHarness(seedText, {
      localStorage: { [CK]: CREDS_FULL },
      net: { "/Sessions/Logout": { status: 204 } },
    });
    await h.win.fetch(SERVER + "/Sessions/Logout");
    await h.drainMicro();
    h.localStorage.setItem(CK, CREDS_STRIPPED);
    await h.drainMicro();
    const rec = vaultRec(h);
    const G = h.win.__shellCredsGuard;
    check(
      name + " C3: logout invalidates the vault",
      rec && rec.t === 0 && G.vinv === 1,
      JSON.stringify({ rec, G }),
    );
  }

  // ---- C4: 401 validate → tokenless write syncs the vault tokenless ----------
  {
    const h = makeHarness(seedText, {
      localStorage: { [CK]: CREDS_FULL },
      net: { "/System/Info": { status: 401 } },
    });
    await h.win.fetch(SERVER + "/System/Info");
    await h.drainMicro();
    h.localStorage.setItem(CK, CREDS_STRIPPED);
    await h.drainMicro();
    const rec = vaultRec(h);
    check(
      name + " C4: 401-revoked token invalidates the vault",
      rec && rec.t === 0 && h.win.__shellCredsGuard.vinv === 1,
      JSON.stringify(rec),
    );
  }

  // ---- C5: causeless tokenless write does NOT overwrite the vault ------------
  {
    const h = makeHarness(seedText, { localStorage: { [CK]: CREDS_FULL } });
    await h.drainMicro(); // boot mirror lands first
    h.localStorage.setItem(CK, CREDS_STRIPPED);
    await h.drainMicro();
    const rec = vaultRec(h);
    const G = h.win.__shellCredsGuard;
    check(
      name + " C5: causeless strip leaves the vault tokened",
      rec && rec.t === 1 && rec.v === CREDS_FULL && G.vinv === 0,
      JSON.stringify({ rec, G }),
    );
  }

  // ---- C6: enableAutoLogin === "false" → no mirroring at all -----------------
  {
    const h = makeHarness(seedText, {
      localStorage: { [CK]: CREDS_FULL, enableAutoLogin: "false" },
    });
    await h.drainMicro();
    h.localStorage.setItem(CK, CREDS_FULL_2);
    await h.drainMicro();
    const G = h.win.__shellCredsGuard;
    check(
      name + " C6: autoLogin opt-out → vault never written",
      vaultRec(h) === undefined && G.vm === 0 && G.vinv === 0,
      JSON.stringify({ rec: vaultRec(h), G }),
    );
  }

  // ---- C7: kill switch disables the vault too --------------------------------
  {
    const h = makeHarness(seedText, {
      localStorage: {
        [CK]: CREDS_FULL,
        "jellyfin.shell.credsGuardDisabled": "1",
      },
    });
    await h.drainMicro();
    h.localStorage.setItem(CK, CREDS_FULL_2);
    await h.drainMicro();
    check(
      name + " C7: kill switch → no vault writes, no IDB opens",
      vaultRec(h) === undefined && h.idb._opens === 0,
      JSON.stringify(vaultRec(h)),
    );
  }

  // ---- C8: vetoed strip re-mirrors the merged (tokened) value ----------------
  {
    const h = makeHarness(seedText, {
      localStorage: { [CK]: CREDS_FULL },
      net: { "/System/Info": "reject" },
    });
    await h.win.fetch(SERVER + "/System/Info").catch(() => {});
    await h.drainMicro();
    h.localStorage.setItem(CK, CREDS_STRIPPED);
    await h.drainMicro();
    const rec = vaultRec(h);
    let merged = null;
    try {
      merged = JSON.parse(rec.v).Servers[0];
    } catch (_) {}
    check(
      name + " C8: vetoed strip mirrors the merged tokened value",
      rec &&
        rec.t === 1 &&
        merged &&
        merged.AccessToken === "tok123" &&
        merged.DateLastAccessed === 222,
      JSON.stringify(rec),
    );
  }
}

// ============================================================================
// PART D — VAULT RESTORE POLICY (boot-side restoreCredsVault)
// ============================================================================
const VAULT_FULL = { v: CREDS_FULL, ts: 1111, t: 1 };
const VAULT_TOKENLESS = { v: CREDS_STRIPPED, ts: 2222, t: 0 };
const CREDS_OTHER_SERVER = JSON.stringify({
  Servers: [
    {
      Id: "srv2",
      AccessToken: null,
      UserId: null,
      ManualAddress: "https://other.test",
      DateLastAccessed: 444,
    },
  ],
});

async function restoreScenarios(name, restoreFnSrc, seedText) {
  // ---- D1: creds key absent + tokened vault → wholesale restore --------------
  {
    const h = makeHarness(null, { vault: { credsBackup: VAULT_FULL } });
    await h.runRestore(restoreFnSrc);
    check(
      name + " D1: vault restored wholesale when creds key absent",
      h.localStorage.getItem(CK) === CREDS_FULL,
      h.localStorage.getItem(CK),
    );
    check(name + " D1: restore counter set", h.win.__shellCredsRestored === 1);
    const tr = trailOf(h);
    check(
      name + " D1: trail records {e:restore,t:1}",
      tr && tr.length === 1 && tr[0].e === "restore" && tr[0].t === 1,
      JSON.stringify(tr),
    );
  }

  // ---- D2: tokenless creds (same Id) + tokened vault → merge by Id -----------
  {
    const h = makeHarness(null, {
      localStorage: { [CK]: CREDS_STRIPPED },
      vault: { credsBackup: VAULT_FULL },
    });
    await h.runRestore(restoreFnSrc);
    const after = JSON.parse(h.localStorage.getItem(CK));
    check(
      name + " D2: token+UserId merged by server Id, new fields kept",
      after.Servers[0].AccessToken === "tok123" &&
        after.Servers[0].UserId === "u1" &&
        after.Servers[0].DateLastAccessed === 222,
      h.localStorage.getItem(CK),
    );
  }

  // ---- D3: localStorage already tokened → no restore --------------------------
  {
    const h = makeHarness(null, {
      localStorage: { [CK]: CREDS_FULL_2 },
      vault: { credsBackup: VAULT_FULL },
    });
    await h.runRestore(restoreFnSrc);
    check(
      name + " D3: tokened localStorage left untouched",
      h.localStorage.getItem(CK) === CREDS_FULL_2 &&
        h.win.__shellCredsRestored === undefined,
      h.localStorage.getItem(CK),
    );
  }

  // ---- D4: tokenless vault → no restore ---------------------------------------
  {
    const h = makeHarness(null, {
      vault: { credsBackup: VAULT_TOKENLESS },
    });
    await h.runRestore(restoreFnSrc);
    check(
      name + " D4: tokenless vault restores nothing",
      h.localStorage.getItem(CK) === null &&
        h.win.__shellCredsRestored === undefined,
    );
  }

  // ---- D5: enableAutoLogin === "false" → no restore ---------------------------
  {
    const h = makeHarness(null, {
      localStorage: { enableAutoLogin: "false" },
      vault: { credsBackup: VAULT_FULL },
    });
    await h.runRestore(restoreFnSrc);
    check(
      name + " D5: autoLogin opt-out skips restore",
      h.localStorage.getItem(CK) === null && h.idb._opens === 0,
    );
  }

  // ---- D6: kill switch → no restore -------------------------------------------
  {
    const h = makeHarness(null, {
      localStorage: { "jellyfin.shell.credsGuardDisabled": "1" },
      vault: { credsBackup: VAULT_FULL },
    });
    await h.runRestore(restoreFnSrc);
    check(
      name + " D6: kill switch skips restore",
      h.localStorage.getItem(CK) === null && h.idb._opens === 0,
    );
  }

  // ---- D7: indexedDB missing → resolves without restoring ---------------------
  {
    const h = makeHarness(null, { noIndexedDB: true });
    let settled = false;
    await h.runRestore(restoreFnSrc).then(() => {
      settled = true;
    });
    check(
      name + " D7: missing indexedDB → promise settles, no restore",
      settled && h.localStorage.getItem(CK) === null,
    );
  }

  // ---- D8: vault Id ≠ creds Id → no cross-server resurrection ------------------
  {
    const h = makeHarness(null, {
      localStorage: { [CK]: CREDS_OTHER_SERVER },
      vault: { credsBackup: VAULT_FULL },
    });
    await h.runRestore(restoreFnSrc);
    check(
      name + " D8: foreign server entry never gets the vaulted token",
      h.localStorage.getItem(CK) === CREDS_OTHER_SERVER &&
        h.win.__shellCredsRestored === undefined,
      h.localStorage.getItem(CK),
    );
  }

  // ---- D9: composite no-loop — restore → 401 → invalidation → no re-restore ---
  {
    const h = makeHarness(seedText, {
      vault: { credsBackup: VAULT_FULL },
      net: { "/System/Info": { status: 401 } },
    });
    await h.runRestore(restoreFnSrc);
    check(
      name + " D9: first restore lands the vaulted token",
      h.localStorage.getItem(CK) === CREDS_FULL &&
        h.win.__shellCredsRestored === 1,
    );
    // jellyfin-web validates the restored token; the server says 401.
    await h.win.fetch(SERVER + "/System/Info");
    await h.drainMicro();
    h.localStorage.setItem(CK, CREDS_STRIPPED);
    await h.drainMicro();
    const rec = vaultRec(h);
    check(
      name + " D9: 401 strip passes through AND invalidates the vault",
      JSON.parse(h.localStorage.getItem(CK)).Servers[0].AccessToken === null &&
        rec &&
        rec.t === 0,
      JSON.stringify(rec),
    );
    await h.runRestore(restoreFnSrc);
    const tr = trailOf(h);
    check(
      name + " D9: second restore is a no-op (no loop)",
      JSON.parse(h.localStorage.getItem(CK)).Servers[0].AccessToken === null &&
        h.win.__shellCredsRestored === 1 &&
        tr.filter((e) => e.e === "restore").length === 1,
      JSON.stringify(tr),
    );
  }
}

(async () => {
  await scenarios("shell.js seed", buildSeed(tvSrc));
  await scenarios("boot-shell.src.js seed", buildSeed(bootSrc));
  await vaultMirrorScenarios("shell.js seed", buildSeed(tvSrc));
  await vaultMirrorScenarios("boot-shell.src.js seed", buildSeed(bootSrc));
  await restoreScenarios(
    "shell.js restore",
    extractRestoreFn(tvSrc),
    buildSeed(tvSrc),
  );
  await restoreScenarios(
    "boot-shell.src.js restore",
    extractRestoreFn(bootSrc),
    buildSeed(bootSrc),
  );

  if (failures) {
    console.error("\n" + failures + " FAILURE(S)");
    process.exit(1);
  }
  console.log("\nALL OK");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
