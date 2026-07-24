// JEL-621 verification — pre-lowered transpile drop consumption.
//
// The server's /shell/ drop may publish pre-lowered ES5 bodies keyed by the
// fnv1a hash of the original source (built offline by server-shell-drop's
// build-tx-drop.mjs). The shells fetch /shell/tx-manifest.json in parallel
// with the /web/ RTT and, on a hash hit in any transpile slow path, inline
// the drop body instead of loading Babel — the 21-42 s serial on-TV Babel
// pass (the dominant Tizen 5.0 cold-boot cost) never runs on the happy path.
//
// WHAT THIS PINS
//   PART A — CONTRACT (all four shipped artifacts): kill switch, manifest
//            path, manifest gate on BABEL_OPTS_KEY, window.__shellTxDrop
//            state + seed consumption fns, drop marker attribute, txDropHits
//            feeding the babel-unused streak, and the JSI eager babel kick
//            gated off when the drop manifest resolved.
//   PART B — SEED LOCKSTEP: the seed-side __oracleRe literal equals the
//            widget-side MODERN_SYNTAX_RE_SRC (STRICT oracle, JEL-417 role
//            split), and __txFnv matches the widget-side txFnv1a on vectors.
//   PART C — EXECUTION (both src seeds, no Babel in the sandbox):
//     C1. dynamic src-setter pipeline with a drop hit: the pre-lowered body
//         is fetched from the drop, inlined, cached under the shell.tx key —
//         and Babel is never consulted (its absence would fail any fallback).
//     C2. manifest miss: pipeline falls back (Babel absent -> error event,
//         no inline node), miss counter increments.
//     C3. kill switch: entries present but txDropDisabled=1 -> no drop fetch.
//     C4. oracle reject: a drop body still carrying `?.` is refused (r++),
//         never inlined.
//   PART D — WIDGET txDropResolve (extracted from both src files): hit
//         returns the lowered body; oracle-reject and manifest-miss return
//         null with the right counters.
//
// Run: node scripts/tx-drop.test.cjs
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
    name + ": drop kill switch present",
    src.includes("jellyfin.shell.txDropDisabled"),
  );
  check(
    name + ": drop manifest path present",
    src.includes("/shell/tx-manifest.json"),
  );
  check(
    name + ": manifest gated on babelOptsKey",
    src.includes(".babelOptsKey"),
  );
  check(
    name + ": drop state + ready promise on window",
    src.includes("__shellTxDrop") && src.includes("__shellTxDropReady"),
  );
  check(
    name + ": seed drop consumption fns present",
    src.includes("__txDropGet") && src.includes("__txFnv"),
  );
  check(
    name + ": drop marker attribute present",
    src.includes("data-shell-tx-drop"),
  );
  check(
    name + ": drop hits feed the babel-unused streak",
    src.includes(".txDropHits"),
  );
  // JELA-187: a drop hit proves a static body cannot run raw on this
  // engine, but it never loads Babel, so the JEL-1832 warm-boot string
  // fast path's babelNeeded gate went false-negative on drop-covered
  // servers — warm replayed boots executed raw <script src> tags and
  // every modern-syntax plugin (JE loader included) died as a parse-time
  // SyntaxError. Pin the sticky sibling flag: txDropResolve sets it on a
  // hit and maybeStringFastPath bails on it exactly like babelNeeded.
  check(
    name + ": dropNeeded persistent flag key present",
    src.includes("jellyfin.shell.legacy.dropNeeded"),
  );
  check(
    name + ": string fast path bails on dropNeeded",
    src.includes('bail("dropNeeded")'),
  );
  // The babelNeeded bail had been LOST in the hand-mirrored bootstrap copy
  // (computed, never consulted) — JELA-187 restored it; pin all four.
  check(
    name + ": string fast path bails on babelNeeded",
    src.includes('bail("babelNeeded")'),
  );
}
// The retail seed routes both dynamic call sites through __txResolve; the
// bootstrap seed inlines the same logic via its __dp/pre pattern. JELA-183:
// both patterns must lazy-load Babel on a drop miss (await __ensureBabel
// before maybeTranspile) — without that, a boot whose static scripts all
// drop-hit leaves Babel cold and every dynamic-module miss nulls out.
check("shell.js: seed __txResolve wired", tvSrc.includes("__txResolve"));
check(
  "shell.js: seed __txResolve lazy-loads Babel on drop miss",
  /__txDropGet\(code\)\.then\(function\(b\)\{[\s\S]{0,400}__ensureBabelDyn/.test(
    tvSrc,
  ),
);
// JELA-183: the seed's lazy loader must be HANDOFF-SAFE — the widget-side
// __ensureBabel resolves 'babel.min.js' relative to the post-write document
// (404 against /web/), so the seed needs the absolute server-drop fallback.
for (const [name, src] of ARTIFACTS) {
  check(
    name + ": seed handoff-safe babel loader present",
    src.includes("__ensureBabelDyn") && src.includes("/shell/babel.min.js"),
  );
}
check(
  "boot-shell.src.js: seed __dp/pre pattern wired at both call sites",
  (bootSrc.match(/__dp=needsTx\(code\)\?__txDropGet\(code\)/g) || []).length ===
    2,
);
// JSI channel (JELA-183): the JEL-621 drop-state skip is GONE — it kept
// Babel cold on boots whose dynamically-injected modules (not enumerated by
// the drop builder) still needed it. Only the JEL-1984 unused-streak may
// skip the eager kick now (drop hits count as coverage, so fully-covered
// servers still self-tune the 3 MB fetch+parse away within two boots).
for (const [name, src] of [
  ["shell.js", tvSrc],
  ["boot-shell.src.js", bootSrc],
]) {
  check(
    name + ": JSI eager babel kick NOT gated on drop state",
    !src.includes("!(window.__shellTxDrop && window.__shellTxDrop.ok)"),
  );
  check(
    name + ": JSI eager babel kick honors the unused-streak soft-skip",
    src.includes("!jsiStreakSkip &&"),
  );
  check(
    name + ": streak counts drop hits as coverage",
    src.includes(
      "(c.cachedHits || 0) + (c.txDropHits || 0) === c.scriptsFound",
    ),
  );
  check(
    name + ": manifest fetch kicked from loadRemoteWebClient",
    src.includes("loadTxDropManifest(serverUrl)"),
  );
}

// ============================================================================
// PART B — SEED LOCKSTEP
// ============================================================================
function extractStringConst(src, name) {
  const re = new RegExp(name + '\\s*=\\s*\\n?\\s*"([^"]+)"');
  const m = re.exec(src);
  if (!m) throw new Error("could not extract " + name);
  return m[1]; // raw source text (backslashes doubled)
}
for (const [name, src] of [
  ["shell.js", tvSrc],
  ["boot-shell.src.js", bootSrc],
]) {
  const oracleRaw = extractStringConst(src, "MODERN_SYNTAX_RE_SRC");
  check(
    name + ": seed __oracleRe literal equals widget MODERN_SYNTAX_RE_SRC",
    src.includes("var __oracleRe=/" + oracleRaw + "/;"),
  );
}

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
function compileFn(src, name) {
  const fnSrc = extractTopFn(src, name).replace(
    new RegExp("^ {2}function " + name),
    "function",
  );
  const sb = {};
  vm.createContext(sb);
  return { fn: vm.runInContext("(" + fnSrc + ")", sb), sandbox: sb };
}
{
  // __txFnv (seed string) vs txFnv1a (widget fn) on vectors.
  const seedFnvMatch =
    /function __txFnv\(s\)\{[^}]+\}return h\.toString\(36\);\}/.exec(tvSrc);
  check("shell.js: seed __txFnv literal found", !!seedFnvMatch);
  if (seedFnvMatch) {
    const sb = {};
    vm.createContext(sb);
    const seedFnv = vm.runInContext(
      "(" + seedFnvMatch[0].replace(/^function __txFnv/, "function") + ")",
      sb,
    );
    const widgetFnv = compileFn(tvSrc, "txFnv1a").fn;
    let ok = true;
    for (const v of ["", "abc", "var a = b ?? c;", "☃".repeat(999)]) {
      if (seedFnv(v) !== widgetFnv(v)) ok = false;
    }
    check("shell.js: seed __txFnv matches widget txFnv1a", ok);
  }
  check(
    "boot-shell.src.js: seed __txFnv literal identical to shell.js",
    bootSrc.includes(seedFnvMatch ? seedFnvMatch[0] : " "),
  );
}

// ============================================================================
// PART C — EXECUTION (both src seeds; Babel deliberately absent)
// ============================================================================
const TV_UA =
  "Mozilla/5.0 (SMART-TV; Linux; Tizen 5.0) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/56.0.2924.0 Safari/537.36";
const SERVER = "https://srv.test";

function buildSeed(src) {
  const fnSrc = extractTopFn(src, "buildSeedScript").replace(
    /^ {2}function buildSeedScript/,
    "function",
  );
  const sb = { Object, JSON, TX_VER: "droptest" };
  vm.createContext(sb);
  const build = vm.runInContext("(" + fnSrc + ")", sb);
  return build(SERVER, {});
}

// A modern plugin body and its (fake, clearly-server-built) lowered form.
const MODERN_BODY = 'var v=window.__x??1;console.log(window.__y?.z,"mod",v);';
const LOWERED_BODY =
  'var v=window.__x!=null?window.__x:1;console.log(window.__y==null?void 0:window.__y.z,"mod",v);';
const BAD_LOWERED_BODY = 'var v=window.__x??1;console.log("still modern",v);';

function fnvOf(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(36);
}
const MODERN_HASH = fnvOf(MODERN_BODY);

function makeHarness(seedText, opts) {
  opts = opts || {};
  const fetched = [];
  const created = [];
  const routes = Object.assign(
    {
      "/plugins/mod.js": MODERN_BODY,
      "/shell/tx/lowered.js":
        opts.dropBody != null ? opts.dropBody : LOWERED_BODY,
    },
    opts.routes || {},
  );
  function vFetch(url) {
    fetched.push(String(url));
    let u;
    try {
      u = new URL(String(url));
    } catch (_) {
      return Promise.resolve({ ok: false, status: 400 });
    }
    const body = routes[u.pathname];
    if (u.origin !== SERVER || body == null)
      return Promise.resolve({ ok: false, status: 404 });
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(body),
    });
  }
  function El(tag) {
    const el = {
      nodeName: String(tag || "div").toUpperCase(),
      style: {},
      _attrs: {},
      textContent: "",
      parentNode: null,
      setAttribute(k, v) {
        this._attrs[k] = String(v);
      },
      getAttribute(k) {
        return k in this._attrs ? this._attrs[k] : null;
      },
      removeAttribute(k) {
        delete this._attrs[k];
      },
      appendChild(c) {
        c.parentNode = this;
        return c;
      },
      insertBefore(c) {
        c.parentNode = this;
        return c;
      },
      replaceChild(c) {
        c.parentNode = this;
        return c;
      },
      removeChild(c) {
        c.parentNode = null;
        return c;
      },
      addEventListener() {},
      dispatchEvent() {
        return true;
      },
      querySelector() {
        return null;
      },
      querySelectorAll() {
        return [];
      },
    };
    if (el.nodeName === "SCRIPT") created.push(el);
    return el;
  }
  const doc = {
    baseURI: SERVER + "/web/",
    documentElement: El("html"),
    head: El("head"),
    body: El("body"),
    createElement: (t) => El(t),
    createComment: () => El("#comment"),
    createEvent() {
      return { initEvent() {} };
    },
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementsByTagName: () => [],
    addEventListener() {},
  };
  // JELA-11: PART C pins the regex-fallback pipeline (still the only path on
  // probe-less devices), so the parse probe is killswitched by default here —
  // the sandbox runs on Node's modern parser, which accepts the MODERN_BODY
  // fixtures and would (correctly, per-device) fast-path them raw instead.
  // Probe-active behavior is pinned in parse-probe.test.cjs.
  const store = Object.assign(
    { "jellyfin.shell.parseProbeDisabled": "1" },
    opts.localStorage || {},
  );
  const localStorage = {
    getItem(k) {
      return k in store ? store[k] : null;
    },
    setItem(k, v) {
      store[k] = String(v);
    },
    removeItem(k) {
      delete store[k];
    },
  };
  function XHR() {}
  XHR.prototype.open = function () {};
  XHR.prototype.send = function () {};
  const win = {};
  const timers = [];
  const vTimer = (fn) => (timers.push(fn), timers.length);
  const sandbox = {
    window: win,
    document: doc,
    navigator: { userAgent: TV_UA },
    XMLHttpRequest: XHR,
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
    setTimeout: vTimer,
    clearTimeout() {},
    setInterval: vTimer,
    clearInterval() {},
    localStorage,
    Node: function () {},
    HTMLScriptElement: function () {},
    Element: function () {},
  };
  sandbox.Node.prototype = { appendChild() {}, insertBefore() {} };
  // Give the prototype a configurable src accessor so the seed's JEL-407
  // setter patch installs (real Chromium 56 has one; the seed skips the
  // patch when the descriptor is missing).
  sandbox.HTMLScriptElement.prototype = {};
  Object.defineProperty(sandbox.HTMLScriptElement.prototype, "src", {
    configurable: true,
    enumerable: true,
    get() {
      return this._rawSrc || "";
    },
    set(v) {
      this._rawSrc = String(v);
    },
  });
  sandbox.Element.prototype = { setAttribute() {} };
  win.addEventListener = () => {};
  // The seed guards its JEL-407 setter patch on window.HTMLScriptElement —
  // mirror the constructors onto win like a real browser global scope.
  win.HTMLScriptElement = sandbox.HTMLScriptElement;
  win.Element = sandbox.Element;
  win.Node = sandbox.Node;
  win.fetch = vFetch;
  win.location = { replace() {}, hash: "" };
  win.setTimeout = vTimer;
  win.clearTimeout = () => {};
  win.setInterval = vTimer;
  win.clearInterval = () => {};
  win.localStorage = localStorage;
  win.document = doc;
  win.console = sandbox.console;
  win.navigator = sandbox.navigator;
  win.Babel = undefined; // Babel ABSENT: any fallback transpile returns null
  if (opts.txDrop !== null) {
    win.__shellTxDrop = opts.txDrop || {
      ok: true,
      base: SERVER + "/shell/",
      entries: { [MODERN_HASH]: "tx/lowered.js" },
      h: 0,
      m: 0,
      r: 0,
      f: 0,
    };
  }
  vm.createContext(sandbox);
  vm.runInContext(seedText, sandbox);
  return { win, doc, created, fetched, store, sandbox };
}

async function drain() {
  for (let i = 0; i < 60; i++) await Promise.resolve();
}

async function runSeedScenarios(label, src) {
  const seed = buildSeed(src);

  // C1 — drop hit via the src-setter pipeline.
  {
    const h = makeHarness(seed, {});
    const node = Object.create(h.sandbox.HTMLScriptElement.prototype);
    Object.assign(node, {
      nodeName: "SCRIPT",
      _attrs: {},
      textContent: "",
      parentNode: null,
      events: [],
      setAttribute(k, v) {
        this._attrs[k] = String(v);
      },
      getAttribute(k) {
        return k in this._attrs ? this._attrs[k] : null;
      },
      removeAttribute(k) {
        delete this._attrs[k];
      },
      dispatchEvent() {
        return true;
      },
    });
    node.onload = function () {
      node.events.push("load");
    };
    node.onerror = function () {
      node.events.push("error");
    };
    node.src = SERVER + "/plugins/mod.js";
    await drain();
    const inlined = h.created.find(
      (e) => e._attrs["data-shell-transpiled-from"],
    );
    check(
      label + " C1: drop file fetched",
      h.fetched.some((u) => u.indexOf("/shell/tx/lowered.js") >= 0),
    );
    check(
      label + " C1: pre-lowered body inlined verbatim",
      !!inlined && inlined.textContent === LOWERED_BODY,
    );
    check(label + " C1: drop hit counter", h.win.__shellTxDrop.h === 1);
    check(
      label + " C1: load event dispatched to original node",
      node.events.indexOf("load") >= 0 && node.events.indexOf("error") < 0,
    );
    check(
      label + " C1: lowered body cached under the shell.tx key",
      Object.keys(h.store).some(
        (k) =>
          k.indexOf("shell.txdroptest:") === 0 && h.store[k] === LOWERED_BODY,
      ),
    );
  }

  // C2 — manifest miss: fallback path (Babel absent) errors, m++.
  {
    const h = makeHarness(seed, {
      txDrop: {
        ok: true,
        base: SERVER + "/shell/",
        entries: { nothash: "tx/other.js" },
        h: 0,
        m: 0,
        r: 0,
        f: 0,
      },
    });
    const node = Object.create(h.sandbox.HTMLScriptElement.prototype);
    Object.assign(node, {
      nodeName: "SCRIPT",
      _attrs: {},
      events: [],
      setAttribute(k, v) {
        this._attrs[k] = String(v);
      },
      getAttribute(k) {
        return k in this._attrs ? this._attrs[k] : null;
      },
      removeAttribute(k) {
        delete this._attrs[k];
      },
      dispatchEvent() {
        return true;
      },
    });
    node.onerror = function () {
      node.events.push("error");
    };
    node.src = SERVER + "/plugins/mod.js";
    await drain();
    check(label + " C2: manifest miss counter", h.win.__shellTxDrop.m === 1);
    check(
      label + " C2: no drop fetch on miss",
      !h.fetched.some((u) => u.indexOf("/shell/tx/") >= 0),
    );
    check(
      label + " C2: fallback without Babel errors out (never raw)",
      node.events.indexOf("error") >= 0 &&
        !h.created.some((e) => e.textContent === MODERN_BODY),
    );
  }

  // C3 — kill switch beats a present manifest.
  {
    const h = makeHarness(seed, {
      localStorage: { "jellyfin.shell.txDropDisabled": "1" },
    });
    const node = Object.create(h.sandbox.HTMLScriptElement.prototype);
    Object.assign(node, {
      nodeName: "SCRIPT",
      _attrs: {},
      events: [],
      setAttribute(k, v) {
        this._attrs[k] = String(v);
      },
      getAttribute(k) {
        return k in this._attrs ? this._attrs[k] : null;
      },
      removeAttribute(k) {
        delete this._attrs[k];
      },
      dispatchEvent() {
        return true;
      },
    });
    node.src = SERVER + "/plugins/mod.js";
    await drain();
    check(
      label + " C3: kill switch — no drop fetch, no hit",
      !h.fetched.some((u) => u.indexOf("/shell/tx/") >= 0) &&
        h.win.__shellTxDrop.h === 0,
    );
  }

  // C4 — oracle reject: modern token in the drop body is refused.
  {
    const h = makeHarness(seed, { dropBody: BAD_LOWERED_BODY });
    const node = Object.create(h.sandbox.HTMLScriptElement.prototype);
    Object.assign(node, {
      nodeName: "SCRIPT",
      _attrs: {},
      events: [],
      setAttribute(k, v) {
        this._attrs[k] = String(v);
      },
      getAttribute(k) {
        return k in this._attrs ? this._attrs[k] : null;
      },
      removeAttribute(k) {
        delete this._attrs[k];
      },
      dispatchEvent() {
        return true;
      },
    });
    node.src = SERVER + "/plugins/mod.js";
    await drain();
    check(
      label + " C4: oracle-rejected body never inlined",
      h.win.__shellTxDrop.r === 1 &&
        !h.created.some((e) => e.textContent === BAD_LOWERED_BODY),
    );
  }

  // C5 (JELA-183) — manifest miss with __ensureBabel available: the dynamic
  // pipeline must lazy-load Babel (await the ensure promise) and transpile,
  // instead of silently nulling out ("setter transpile failed"). This is the
  // live JE-v12 failure: all static bodies drop-hit, Babel never eagerly
  // loads, and every dynamically-injected module misses the drop.
  {
    const h = makeHarness(seed, {
      txDrop: {
        ok: true,
        base: SERVER + "/shell/",
        entries: { nothash: "tx/other.js" },
        h: 0,
        m: 0,
        r: 0,
        f: 0,
      },
    });
    let ensureCalls = 0;
    h.win.__ensureBabel = function () {
      ensureCalls++;
      h.win.Babel = {
        transform: () => ({ code: LOWERED_BODY }),
      };
      return Promise.resolve();
    };
    const node = Object.create(h.sandbox.HTMLScriptElement.prototype);
    Object.assign(node, {
      nodeName: "SCRIPT",
      _attrs: {},
      events: [],
      setAttribute(k, v) {
        this._attrs[k] = String(v);
      },
      getAttribute(k) {
        return k in this._attrs ? this._attrs[k] : null;
      },
      removeAttribute(k) {
        delete this._attrs[k];
      },
      dispatchEvent() {
        return true;
      },
    });
    node.onload = function () {
      node.events.push("load");
    };
    node.onerror = function () {
      node.events.push("error");
    };
    node.src = SERVER + "/plugins/mod.js";
    await drain();
    const inlined = h.created.find(
      (e) => e._attrs["data-shell-transpiled-from"],
    );
    check(
      label + " C5: drop miss awaits __ensureBabel (called once)",
      ensureCalls === 1,
    );
    check(
      label + " C5: lazily-transpiled body inlined after ensure",
      !!inlined && inlined.textContent === LOWERED_BODY,
    );
    check(
      label + " C5: load (not error) dispatched to original node",
      node.events.indexOf("load") >= 0 && node.events.indexOf("error") < 0,
    );
    check(label + " C5: miss counter incremented", h.win.__shellTxDrop.m === 1);
  }

  // C6 (JELA-183) — drop miss with NO widget __ensureBabel hook (or a hook
  // whose relative babel.min.js 404'd post-handoff): the seed must fall back
  // to the ABSOLUTE server-drop babel copy, eval it, and transpile.
  {
    const babelStub =
      "window.Babel={transform:function(){return{code:" +
      JSON.stringify(LOWERED_BODY) +
      "}}};";
    const h = makeHarness(seed, {
      txDrop: {
        ok: true,
        base: SERVER + "/shell/",
        entries: { nothash: "tx/other.js" },
        h: 0,
        m: 0,
        r: 0,
        f: 0,
      },
      routes: { "/shell/babel.min.js": babelStub },
    });
    const node = Object.create(h.sandbox.HTMLScriptElement.prototype);
    Object.assign(node, {
      nodeName: "SCRIPT",
      _attrs: {},
      events: [],
      setAttribute(k, v) {
        this._attrs[k] = String(v);
      },
      getAttribute(k) {
        return k in this._attrs ? this._attrs[k] : null;
      },
      removeAttribute(k) {
        delete this._attrs[k];
      },
      dispatchEvent() {
        return true;
      },
    });
    node.onload = function () {
      node.events.push("load");
    };
    node.onerror = function () {
      node.events.push("error");
    };
    node.src = SERVER + "/plugins/mod.js";
    await drain();
    const inlined = h.created.find(
      (e) => e._attrs["data-shell-transpiled-from"],
    );
    check(
      label + " C6: server-drop babel fetched on miss without widget hook",
      h.fetched.some((u) => u.indexOf("/shell/babel.min.js") >= 0),
    );
    check(
      label + " C6: body transpiled via drop-loaded Babel and inlined",
      !!inlined && inlined.textContent === LOWERED_BODY,
    );
    check(
      label + " C6: load (not error) dispatched",
      node.events.indexOf("load") >= 0 && node.events.indexOf("error") < 0,
    );
  }
}

// ============================================================================
// PART D — widget-side txDropResolve (extracted from both src files)
// ============================================================================
async function runWidgetScenarios(label, src) {
  const oracleRaw = extractStringConst(src, "MODERN_SYNTAX_RE_SRC");
  const fnvSrc = extractTopFn(src, "txFnv1a").replace(
    /^ {2}function txFnv1a/,
    "function txFnv1a",
  );
  const resolveSrc = extractTopFn(src, "txDropResolve").replace(
    /^ {2}function txDropResolve/,
    "function txDropResolve",
  );
  // JELA-11: txDropResolve routes its oracle through loweredBodyOk ->
  // parseProbeActive/parsesOnThisEngine, so extract those too. PART D pins
  // the regex-fallback oracle: the killswitch is set in the sandbox
  // localStorage (Node's parser would accept the BAD_LOWERED_BODY fixture).
  // Probe-active oracle behavior is pinned in parse-probe.test.cjs.
  const probeSrc = [
    "var PARSE_PROBE_OK = true;",
    'var PARSE_PROBE_DISABLED_KEY = "jellyfin.shell.parseProbeDisabled";',
    extractTopFn(src, "parseProbeDisabled"),
    extractTopFn(src, "parseProbeActive"),
    extractTopFn(src, "parsesOnThisEngine"),
    extractTopFn(src, "loweredBodyOk"),
  ].join("\n");
  function widgetHarness(drop, routes) {
    const fetched = [];
    const win = {};
    // JELA-187: record localStorage writes so scenarios can assert the
    // dropNeeded flag is set on a hit and ONLY on a hit.
    const stored = {};
    const sandbox = {
      window: win,
      Promise,
      Object,
      JSON,
      String,
      Error,
      RegExp,
      console: { warn() {} },
      localStorage: {
        getItem: (k) =>
          k === "jellyfin.shell.parseProbeDisabled" ? "1" : null,
        setItem: (k, v) => {
          stored[k] = String(v);
        },
      },
      MODERN_SYNTAX_RE: new RegExp(JSON.parse('"' + oracleRaw + '"')),
      fetch(url) {
        fetched.push(String(url));
        const body = routes[url];
        if (body == null) return Promise.resolve({ ok: false, status: 404 });
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(body),
        });
      },
    };
    vm.createContext(sandbox);
    // JELA-187: txDropResolve references DROP_NEEDED_KEY (set on a hit);
    // PART A pins the same literal in every shipped artifact.
    vm.runInContext(
      'var DROP_NEEDED_KEY = "jellyfin.shell.legacy.dropNeeded";\n' +
        probeSrc +
        "\n" +
        fnvSrc +
        "\n" +
        resolveSrc,
      sandbox,
    );
    win.__shellTxDropReady = Promise.resolve(drop);
    if (drop) win.__shellTxDrop = drop;
    return { sandbox, fetched, stored, resolve: sandbox.txDropResolve };
  }
  {
    const drop = {
      ok: true,
      base: SERVER + "/shell/",
      entries: { [MODERN_HASH]: "tx/lowered.js" },
      h: 0,
      m: 0,
      r: 0,
      f: 0,
    };
    const h = widgetHarness(drop, {
      [SERVER + "/shell/tx/lowered.js"]: LOWERED_BODY,
    });
    const out = await h.resolve(MODERN_BODY);
    check(
      label + " D: widget hit returns lowered body",
      out === LOWERED_BODY && drop.h === 1,
    );
    // JELA-187: the hit must persist the dropNeeded flag so the warm-boot
    // string fast path stops replaying raw <script src> tags.
    check(
      label + " D: widget hit sets the dropNeeded flag",
      h.stored["jellyfin.shell.legacy.dropNeeded"] === "1",
    );
  }
  {
    const drop = {
      ok: true,
      base: SERVER + "/shell/",
      entries: { [MODERN_HASH]: "tx/lowered.js" },
      h: 0,
      m: 0,
      r: 0,
      f: 0,
    };
    const h = widgetHarness(drop, {
      [SERVER + "/shell/tx/lowered.js"]: BAD_LOWERED_BODY,
    });
    const out = await h.resolve(MODERN_BODY);
    check(
      label + " D: widget oracle-reject returns null",
      out === null && drop.r === 1,
    );
    // JELA-187: a rejected body was NOT adopted — the flag must stay unset
    // (setting it here would disable the fast path with no drop coverage).
    check(
      label + " D: widget oracle-reject leaves dropNeeded unset",
      h.stored["jellyfin.shell.legacy.dropNeeded"] === undefined,
    );
  }
  {
    const drop = {
      ok: true,
      base: SERVER + "/shell/",
      entries: {},
      h: 0,
      m: 0,
      r: 0,
      f: 0,
    };
    const h = widgetHarness(drop, {});
    const out = await h.resolve(MODERN_BODY);
    check(
      label + " D: widget manifest miss returns null without fetch",
      out === null && drop.m === 1 && h.fetched.length === 0,
    );
    check(
      label + " D: widget manifest miss leaves dropNeeded unset",
      h.stored["jellyfin.shell.legacy.dropNeeded"] === undefined,
    );
  }
  {
    const h = widgetHarness(null, {});
    const out = await h.resolve(MODERN_BODY);
    check(label + " D: widget null manifest resolves null", out === null);
  }
}

(async () => {
  await runSeedScenarios("shell.js", tvSrc);
  await runSeedScenarios("boot-shell.src.js", bootSrc);
  await runWidgetScenarios("shell.js", tvSrc);
  await runWidgetScenarios("boot-shell.src.js", bootSrc);
  process.exitCode = failures ? 1 : 0;
  console.log(failures ? failures + " FAILURE(S)" : "all checks passed");
})().catch((e) => {
  console.error("FATAL: " + (e && e.stack ? e.stack : e));
  process.exit(1);
});
