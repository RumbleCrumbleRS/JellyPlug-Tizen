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
    Node: function () {},
    HTMLScriptElement: function () {},
    Element: function () {},
  };
  sandbox.Node.prototype = {};
  sandbox.HTMLScriptElement.prototype = {};
  sandbox.Element.prototype = {};
  win.addEventListener = () => {};
  win.fetch = vFetch;
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
  vm.runInContext(seedText, sandbox, { filename: "seed.js" });

  async function drainMicro() {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  }

  return { win, sandbox, localStorage, sessionStorage, fetched, drainMicro };
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

(async () => {
  await scenarios("shell.js seed", buildSeed(tvSrc));
  await scenarios("boot-shell.src.js seed", buildSeed(bootSrc));

  if (failures) {
    console.error("\n" + failures + " FAILURE(S)");
    process.exit(1);
  }
  console.log("\nALL OK");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
