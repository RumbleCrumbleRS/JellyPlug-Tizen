// JELA-11 verification — device-native parse-probe transpile detection
// (adopting the JEL-651 §4 recommendation).
//
// needsTranspile()/the post-transform oracle no longer approximate "can this
// engine parse this source?" with a token regex when the engine can be asked
// directly: new Function(code) parses the body eagerly without executing it,
// so a SyntaxError at construction === this engine cannot parse it. The
// regex pre-check/oracle remain as (a) the capability/killswitch fallback
// on-device and (b) the offline coverage pre-filter in build-tx-drop.mjs /
// jsi-minify-es5.mjs (an offline builder cannot ask an M56 parser).
//
// WHAT THIS PINS
//   PART A — CONTRACT (all four shipped artifacts): killswitch literal,
//            capability probe, widget/seed QA counter objects, seed probe
//            fns, probe wired into needsTranspile + the drop oracle, regex
//            fallback retained, offline builders untouched.
//   PART B — WIDGET BEHAVIOR (extracted from both src files, run on the
//            host engine as "the device"):
//     B1. probe ON: unparseable source needs transpile; ES5 does not; a
//         source with syntax THIS engine parses does not (per-device
//         optimal — the JEL-651 headline win); modern-looking tokens inside
//         string literals no longer trigger a wasted Babel pass.
//     B2. killswitch / no capability: byte-for-byte the JEL-417 regex
//         semantics (modern token -> transpile, even when the host engine
//         parses it; unparseable-but-regex-clean -> raw).
//     B3. oracle loweredBodyOk: probe ON accepts a parseable body the regex
//         oracle would false-positive on, rejects an unparseable body the
//         regex oracle would miss; killswitch restores regex semantics.
//     B4. babelTranspile: probe ON refuses Babel output this engine cannot
//         parse (BigInt-class residue); killswitch keeps the pre-JELA-11
//         accept-anything-Babel-returned behavior.
//     B5. QA counters (__shellParseProbe.n/.tx) advance.
//   PART C — SEED EXECUTION (both src seeds, Babel absent, probe ON):
//     C1. per-device fast path: a body this engine parses is inlined RAW
//         with no drop fetch and no Babel (skip counter++).
//     C2. unparseable body: flagged, drop miss, no Babel -> error event and
//         nothing raw reaches the document.
//     C3. drop oracle: a regex-clean but unparseable drop body is refused
//         (r++); a parseable drop body carrying a modern token only inside
//         a string literal is accepted (h++) — the regex oracle would have
//         rejected it.
//     C4. seed re-tests capability itself (__shellParseProbeSeed.ok) — the
//         server origin may carry a different CSP than the widget origin.
//
// Run: node scripts/parse-probe.test.cjs
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
const TX_DROP_BUILDER = path.join(
  REPO,
  "packages",
  "server-shell-drop",
  "scripts",
  "build-tx-drop.mjs",
);
const JSI_MINIFY = path.join(
  REPO,
  "packages",
  "server-shell-drop",
  "scripts",
  "jsi-minify-es5.mjs",
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

const KILLSWITCH = "jellyfin.shell.parseProbeDisabled";

// ============================================================================
// PART A — CONTRACT
// ============================================================================
for (const [name, src] of [
  ["shell.js", tvSrc],
  ["shell.min.js", tvMin],
  ["boot-shell.src.js", bootSrc],
  ["boot-shell.min.js", bootMin],
]) {
  check(name + ": probe killswitch present", src.includes(KILLSWITCH));
  check(
    name + ": boot-time capability probe present",
    src.includes('new Function("1")'),
  );
  check(
    name + ": widget QA counter object present",
    src.includes("__shellParseProbe"),
  );
  check(
    name + ": seed QA counter object present",
    src.includes("__shellParseProbeSeed"),
  );
  check(
    name + ": seed probe fns present",
    src.includes("__ppOn(") &&
      src.includes("__ppParses(") &&
      src.includes("__loweredOk("),
  );
}
for (const [name, src] of [
  ["shell.js", tvSrc],
  ["boot-shell.src.js", bootSrc],
]) {
  check(
    name + ": needsTranspile consults the probe",
    /function needsTranspile\(code\) \{[\s\S]{0,200}parseProbeActive\(\)/.test(
      src,
    ),
  );
  check(
    name + ": needsTranspile keeps the regex fallback",
    /function needsTranspile\(code\) \{[\s\S]{0,300}MODERN_PRECHECK_RE\.test\(code\)/.test(
      src,
    ),
  );
  check(
    name + ": drop oracle routes through loweredBodyOk",
    src.includes("!loweredBodyOk(body)"),
  );
  check(
    name + ": loweredBodyOk keeps the regex-oracle fallback",
    /function loweredBodyOk\(body\) \{[\s\S]{0,300}MODERN_SYNTAX_RE\.test\(body\)/.test(
      src,
    ),
  );
  check(
    name + ": babelTranspile probe-verifies its output",
    /function babelTranspile\(src\) \{[\s\S]*?parsesOnThisEngine\(out\)/.test(
      src,
    ),
  );
}
// Offline builders keep their conservative regex pre-filter/oracle — the
// design intentionally does NOT probe there (a Node builder cannot ask the
// TV's parser; the regexes are the coverage filter).
{
  const drop = fs.readFileSync(TX_DROP_BUILDER, "utf8");
  const jsi = fs.readFileSync(JSI_MINIFY, "utf8");
  check(
    "build-tx-drop.mjs: offline regex pre-filter retained (no probe)",
    drop.includes("PRECHECK_RE") && !drop.includes("parseProbe"),
  );
  check(
    "jsi-minify-es5.mjs: offline regex gates retained (no probe)",
    jsi.includes("PRECHECK_RE") && !jsi.includes("parseProbe"),
  );
}

// ============================================================================
// Shared extraction helpers (same shape as tx-drop.test.cjs)
// ============================================================================
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
function extractStringConst(src, name) {
  const re = new RegExp(name + '\\s*=\\s*\\n?\\s*"([^"]+)"');
  const m = re.exec(src);
  if (!m) throw new Error("could not extract " + name);
  return m[1];
}

// Widget-side probe kit compiled into a vm context. PARSE_PROBE_OK is real
// (the vm realm has a working Function constructor); the killswitch comes
// from the sandbox localStorage.
function widgetKit(src, opts) {
  opts = opts || {};
  const oracleRaw = extractStringConst(src, "MODERN_SYNTAX_RE_SRC");
  const oracleSrc = JSON.parse('"' + oracleRaw + '"');
  const precheckSuffix = "|,\\s*\\.\\.\\.[\\w$]";
  const store = Object.assign({}, opts.localStorage || {});
  const win = {};
  const sandbox = {
    window: win,
    Object,
    String,
    RegExp,
    console: { warn() {} },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
    },
    MODERN_SYNTAX_RE: new RegExp(oracleSrc),
    MODERN_PRECHECK_RE: new RegExp(oracleSrc + precheckSuffix),
  };
  vm.createContext(sandbox);
  const code = [
    'var PARSE_PROBE_DISABLED_KEY = "' + KILLSWITCH + '";',
    "var PARSE_PROBE_OK = " + (opts.capability === false ? "false" : "true") + ";",
    extractTopFn(src, "parseProbeDisabled"),
    extractTopFn(src, "parseProbeActive"),
    "window.__shellParseProbe = { ok: PARSE_PROBE_OK, n: 0, tx: 0 };",
    extractTopFn(src, "parsesOnThisEngine"),
    extractTopFn(src, "needsTranspile"),
    extractTopFn(src, "loweredBodyOk"),
    extractTopFn(src, "babelTranspile"),
  ].join("\n");
  vm.runInContext(code, sandbox);
  return { sandbox, win };
}

const ES5_BODY = 'var a = 1; function f(b) { return a + b; }';
const UNPARSEABLE_BODY = "var a = ;";
const HOST_MODERN_BODY = "var x = window.__y?.z ?? 1;"; // host engine parses
const STRING_FALSE_POSITIVE = 'var s = "a?.b ?? c";'; // tokens only in a string

// ============================================================================
// PART B — WIDGET BEHAVIOR
// ============================================================================
for (const [label, src] of [
  ["shell.js", tvSrc],
  ["boot-shell.src.js", bootSrc],
]) {
  // B1 — probe ON.
  {
    const { sandbox } = widgetKit(src);
    const needs = (s) =>
      vm.runInContext("needsTranspile", sandbox)(s);
    check(label + " B1: unparseable source needs transpile", needs(UNPARSEABLE_BODY) === true);
    check(label + " B1: ES5 source does not need transpile", needs(ES5_BODY) === false);
    check(
      label + " B1: source THIS engine parses does not need transpile (per-device optimal)",
      needs(HOST_MODERN_BODY) === false,
    );
    check(
      label + " B1: modern tokens inside string literals no longer trigger Babel",
      needs(STRING_FALSE_POSITIVE) === false,
    );
    check(label + " B1: non-string never needs transpile", needs(null) === false);
  }
  // B2 — killswitch and missing capability restore regex semantics.
  for (const [mode, opts] of [
    ["killswitch", { localStorage: { [KILLSWITCH]: "1" } }],
    ["no capability", { capability: false }],
  ]) {
    const { sandbox } = widgetKit(src, opts);
    const needs = vm.runInContext("needsTranspile", sandbox);
    check(
      label + " B2 (" + mode + "): modern token -> transpile (regex fallback)",
      needs(HOST_MODERN_BODY) === true,
    );
    check(
      label + " B2 (" + mode + "): regex-clean unparseable source -> raw (JEL-417 semantics)",
      needs(UNPARSEABLE_BODY) === false,
    );
    check(
      label + " B2 (" + mode + "): no probes were run",
      vm.runInContext("window.__shellParseProbe.n", sandbox) === 0,
    );
  }
  // B3 — oracle.
  {
    const { sandbox } = widgetKit(src);
    const ok = vm.runInContext("loweredBodyOk", sandbox);
    check(
      label + " B3: probe oracle accepts parseable body with string-literal tokens",
      ok(STRING_FALSE_POSITIVE) === true,
    );
    check(
      label + " B3: probe oracle rejects regex-clean unparseable body",
      ok(UNPARSEABLE_BODY) === false,
    );
  }
  {
    const { sandbox } = widgetKit(src, {
      localStorage: { [KILLSWITCH]: "1" },
    });
    const ok = vm.runInContext("loweredBodyOk", sandbox);
    check(
      label + " B3 (killswitch): regex oracle rejects modern token",
      ok(HOST_MODERN_BODY) === false,
    );
    check(
      label + " B3 (killswitch): regex oracle accepts regex-clean body",
      ok(UNPARSEABLE_BODY) === true,
    );
  }
  // B4 — babelTranspile output verification.
  {
    const { sandbox, win } = widgetKit(src);
    win.Babel = { transform: () => ({ code: UNPARSEABLE_BODY }) };
    check(
      label + " B4: probe ON refuses unparseable Babel output",
      vm.runInContext("babelTranspile", sandbox)("var x=1;") === null,
    );
    win.Babel = { transform: () => ({ code: ES5_BODY }) };
    check(
      label + " B4: probe ON passes parseable Babel output through",
      vm.runInContext("babelTranspile", sandbox)("var x=1;") === ES5_BODY,
    );
  }
  {
    const { sandbox, win } = widgetKit(src, {
      localStorage: { [KILLSWITCH]: "1" },
    });
    win.Babel = { transform: () => ({ code: UNPARSEABLE_BODY }) };
    check(
      label + " B4 (killswitch): pre-JELA-11 behavior kept (output not verified)",
      vm.runInContext("babelTranspile", sandbox)("var x=1;") === UNPARSEABLE_BODY,
    );
  }
  // B5 — QA counters advance.
  {
    const { sandbox } = widgetKit(src);
    const needs = vm.runInContext("needsTranspile", sandbox);
    needs(ES5_BODY);
    needs(UNPARSEABLE_BODY);
    check(
      label + " B5: __shellParseProbe counters advance (n=2, tx=1)",
      vm.runInContext("window.__shellParseProbe.n", sandbox) === 2 &&
        vm.runInContext("window.__shellParseProbe.tx", sandbox) === 1,
    );
  }
}

// ============================================================================
// PART C — SEED EXECUTION (probe ON, Babel absent)
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
  const sb = { Object, JSON, TX_VER: "probetest" };
  vm.createContext(sb);
  const build = vm.runInContext("(" + fnSrc + ")", sb);
  return build(SERVER, {});
}

function fnvOf(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(36);
}

// Harness mirrors tx-drop.test.cjs's makeHarness, WITHOUT the probe
// killswitch: this test exercises the probe-active pipelines.
function makeHarness(seedText, opts) {
  opts = opts || {};
  const fetched = [];
  const created = [];
  const routes = Object.assign({}, opts.routes || {});
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
  const store = Object.assign({}, opts.localStorage || {});
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
  if (opts.txDrop !== undefined) win.__shellTxDrop = opts.txDrop;
  vm.createContext(sandbox);
  vm.runInContext(seedText, sandbox);
  return { win, doc, created, fetched, store, sandbox };
}

function makeScriptNode(h) {
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
  return node;
}

async function drain() {
  for (let i = 0; i < 60; i++) await Promise.resolve();
}

async function runSeedScenarios(label, src) {
  const seed = buildSeed(src);

  // C1 — per-device fast path: this engine parses the body -> inlined RAW.
  {
    const h = makeHarness(seed, {
      routes: { "/plugins/mod.js": HOST_MODERN_BODY },
    });
    const node = makeScriptNode(h);
    node.src = SERVER + "/plugins/mod.js";
    await drain();
    const inlined = h.created.find(
      (e) => e._attrs["data-shell-transpiled-from"],
    );
    check(
      label + " C1: engine-parseable body inlined raw (no transpile)",
      !!inlined && inlined.textContent === HOST_MODERN_BODY,
    );
    check(
      label + " C1: skip counter advanced",
      h.win.__shellTxSkipCount === 1,
    );
    check(
      label + " C1: no drop fetch for a fast-path body",
      !h.fetched.some((u) => u.indexOf("/shell/tx/") >= 0),
    );
    check(
      label + " C1: load event dispatched",
      node.events.indexOf("load") >= 0 && node.events.indexOf("error") < 0,
    );
  }

  // C2 — unparseable body: flagged, no drop entry, Babel absent -> error.
  {
    const h = makeHarness(seed, {
      routes: { "/plugins/broken.js": UNPARSEABLE_BODY },
      txDrop: {
        ok: true,
        base: SERVER + "/shell/",
        entries: {},
        h: 0,
        m: 0,
        r: 0,
        f: 0,
      },
    });
    const node = makeScriptNode(h);
    node.src = SERVER + "/plugins/broken.js";
    await drain();
    check(
      label + " C2: unparseable body flagged (drop miss counted)",
      h.win.__shellTxDrop.m === 1,
    );
    check(
      label + " C2: nothing raw reaches the document, error dispatched",
      node.events.indexOf("error") >= 0 &&
        !h.created.some((e) => e.textContent === UNPARSEABLE_BODY),
    );
  }

  // C3 — drop oracle, probe-active semantics.
  {
    // Reject: regex-clean but unparseable "lowered" body.
    const h = makeHarness(seed, {
      routes: {
        "/plugins/broken.js": UNPARSEABLE_BODY,
        "/shell/tx/lowered.js": "var b = = 2;",
      },
      txDrop: {
        ok: true,
        base: SERVER + "/shell/",
        entries: { [fnvOf(UNPARSEABLE_BODY)]: "tx/lowered.js" },
        h: 0,
        m: 0,
        r: 0,
        f: 0,
      },
    });
    const node = makeScriptNode(h);
    node.src = SERVER + "/plugins/broken.js";
    await drain();
    check(
      label + " C3: unparseable drop body refused (r++), never inlined",
      h.win.__shellTxDrop.r === 1 &&
        !h.created.some((e) => e.textContent === "var b = = 2;"),
    );
  }
  {
    // Accept: parseable drop body whose only "modern" token is inside a
    // string literal — the regex oracle would have rejected it (r++), the
    // probe inlines it.
    const h = makeHarness(seed, {
      routes: {
        "/plugins/broken.js": UNPARSEABLE_BODY,
        "/shell/tx/lowered.js": STRING_FALSE_POSITIVE,
      },
      txDrop: {
        ok: true,
        base: SERVER + "/shell/",
        entries: { [fnvOf(UNPARSEABLE_BODY)]: "tx/lowered.js" },
        h: 0,
        m: 0,
        r: 0,
        f: 0,
      },
    });
    const node = makeScriptNode(h);
    node.src = SERVER + "/plugins/broken.js";
    await drain();
    const inlined = h.created.find(
      (e) => e._attrs["data-shell-transpiled-from"],
    );
    check(
      label +
        " C3: parseable drop body with string-literal token accepted (h++)",
      h.win.__shellTxDrop.h === 1 &&
        !!inlined &&
        inlined.textContent === STRING_FALSE_POSITIVE,
    );
  }

  // C4 — the seed re-tested capability for itself on this origin.
  {
    const h = makeHarness(seed, { routes: {} });
    check(
      label + " C4: seed probe capability re-test recorded",
      !!h.win.__shellParseProbeSeed && h.win.__shellParseProbeSeed.ok === true,
    );
  }
}

(async () => {
  await runSeedScenarios("shell.js", tvSrc);
  await runSeedScenarios("boot-shell.src.js", bootSrc);
  process.exitCode = failures ? 1 : 0;
  console.log(failures ? failures + " FAILURE(S)" : "all checks passed");
})().catch((e) => {
  console.error("FATAL: " + (e && e.stack ? e.stack : e));
  process.exit(1);
});
