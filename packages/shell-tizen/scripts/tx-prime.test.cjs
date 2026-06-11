// JEL-131 verification — login-idle tx-cache primer + dynamic URL recording.
//
// On a FRESH install the JEL-557 transpile cache is empty, so
// JellyfinEnhanced's post-login parallel load of ~54 sub-module scripts
// costs ~1.9 MB of Babel.transform serialized on the M63 main thread
// (~21-42 s) and starves the home render — the user-reported ~30 s
// login→home (vs ~9-10 s warm). The primer uses the login idle window
// (ApiClient present, getCurrentUserId() empty) to prefetch + transpile
// those scripts into the same localStorage cache before the storm starts.
//
// WHAT THIS PINS
//   PART A — CONTRACT: kill switch, recording key, scrape/probe primer,
//            __recDyn calls in BOTH dynamic pipelines, and the pr=/TP: HUD
//            fields exist in all four shipped artifacts (shell.js,
//            shell.min.js, boot-shell.src.js, boot-shell.min.js).
//   PART B — EXECUTION (both src seeds, TV UA, virtual timers + fetch):
//     B1. logged-out boot, cold cache: primer scrapes a JE-style inlined
//         plugin body (basePath dir literal + relative names + absolute
//         .js literal), probes names[0] across candidate dirs, commits to
//         the 200 dir, and caches every module under the shell.tx<ver>:
//         key — wrong dirs cost exactly one probe miss each, never a
//         per-name spray. jQuery-touching bodies get the same wrapJq gate
//         the on-demand pipeline applies.
//     B2. already-authenticated boot: primer stops with st="auth" and
//         fetches NOTHING (the on-demand interceptor owns post-auth work).
//     B3. kill switch: no primer state, no fetches; recording stays live.
//     B4. dynamic intercept recording: a script src intercepted by the
//         setter pipeline lands in jellyfin.shell.dynPluginUrls (debounced),
//         and a later logged-out boot primes it from that list alone.
//     B5. already-cached candidates are skipped (warm boot ≈ no-op primer).
//
// Run: node scripts/tx-prime.test.cjs
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
    name + ": primer kill switch present",
    src.includes("jellyfin.shell.txPrimeDisabled"),
  );
  check(
    name + ": dynamic URL recording key present",
    src.includes("jellyfin.shell.dynPluginUrls"),
  );
  check(
    name + ": scrape + primer functions present",
    src.includes("__txScrapeBodies") && src.includes("__txPrimeStart"),
  );
  check(
    name + ": __recDyn wired into both dynamic pipelines",
    (src.match(/__recDyn\(src\)/g) || []).length >= 2,
  );
  check(name + ": diag HUD pr= field present", src.includes('" pr="'));
  check(name + ": QA HUD TP: field present", src.includes('"TP:"'));
}

// ============================================================================
// PART B — EXECUTION
// ============================================================================
const TV_UA =
  "Mozilla/5.0 (SMART-TV; Linux; Tizen 5.0) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/56.0.2924.0 Safari/537.36";

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
  const sb = { Object, JSON, TX_VER: "primetest" };
  vm.createContext(sb);
  const build = vm.runInContext("(" + fnSrc + ")", sb);
  return build("https://srv.test", {});
}

const SERVER = "https://srv.test";
const TXPFX = "shell.txprimetest:";

// A JE-shaped plugin body: one real module-dir literal buried among
// endpoint-shaped literals (the real JE body has /JellyfinEnhanced/
// public-config etc. BEFORE the basePath), relative module names, and one
// absolute .js literal. None of the bodies served use modern syntax, so
// maybeTranspile rides the fast path and the primer needs no Babel stub.
const JE_BODY = [
  'var cfg="/MyPlugin/public-config";',
  'var ver="/MyPlugin/version";',
  'var basePath="/MyPlugin/js";',
  'var splash="/MyPlugin/js/extra/splash.js";',
  'var mods=["sub/alpha.js","sub/beta.js","sub/gamma.js"];',
].join("\n");

const MODULES = {
  "/MyPlugin/js/sub/alpha.js": 'window.__alpha=1;jQuery(function(){"a";});',
  "/MyPlugin/js/sub/beta.js": "window.__beta=1;",
  "/MyPlugin/js/sub/gamma.js": "window.__gamma=1;",
  "/MyPlugin/js/extra/splash.js": "window.__splash=1;",
};

function makeHarness(seedText, opts) {
  opts = opts || {};
  // ---- virtual timers ------------------------------------------------------
  const timers = [];
  let nextId = 1;
  function vSetTimeout(fn) {
    timers.push({ id: nextId, fn, once: true });
    return nextId++;
  }
  function vSetInterval(fn) {
    timers.push({ id: nextId, fn, once: false });
    return nextId++;
  }
  function vClear(id) {
    for (let i = timers.length - 1; i >= 0; i--) {
      if (timers[i].id === id) timers.splice(i, 1);
    }
  }
  async function drainMicro() {
    for (let i = 0; i < 30; i++) await Promise.resolve();
  }
  async function pump(rounds) {
    for (let r = 0; r < rounds; r++) {
      const snapshot = timers.slice();
      for (const t of snapshot) {
        if (t.once) vClear(t.id);
        try {
          t.fn();
        } catch (_) {}
      }
      await drainMicro();
    }
  }

  // ---- fetch stub ----------------------------------------------------------
  const fetched = [];
  function vFetch(url) {
    fetched.push(String(url));
    const u = new URL(String(url));
    const body = MODULES[u.pathname];
    if (u.origin !== SERVER || body == null) {
      return Promise.resolve({ ok: false, status: 404 });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(body),
    });
  }

  // ---- DOM stub ------------------------------------------------------------
  function El(tag) {
    return {
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
      getBoundingClientRect() {
        return { width: 0, height: 0 };
      },
      focus() {},
    };
  }
  // the statically-inlined JE-style plugin script the scraper reads
  const inlined = El("script");
  inlined.textContent = JE_BODY;
  inlined._attrs["data-shell-transpiled-from"] =
    SERVER + "/MyPlugin/script?v=1.0";

  const doc = {
    baseURI: SERVER + "/web/",
    documentElement: El("html"),
    head: El("head"),
    body: El("body"),
    activeElement: null,
    createElement: (t) => El(t),
    createComment: () => El("#comment"),
    createEvent() {
      return {
        initEvent() {},
      };
    },
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll(sel) {
      if (String(sel).indexOf("data-shell-transpiled-from") >= 0)
        return opts.noScrapeTarget ? [] : [inlined];
      return [];
    },
    getElementsByTagName: () => [],
    addEventListener() {},
    registerElement: undefined,
  };
  doc.body.nodeName = "BODY";
  doc.activeElement = doc.body;

  function XHR() {}
  XHR.prototype.open = function () {};
  XHR.prototype.send = function () {};

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

  const win = {};
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
    setTimeout: vSetTimeout,
    clearTimeout: vClear,
    setInterval: vSetInterval,
    clearInterval: vClear,
    localStorage,
    Node: function () {},
    HTMLScriptElement: function () {},
    Element: function () {},
  };
  sandbox.Node.prototype = { appendChild() {}, insertBefore() {} };
  sandbox.HTMLScriptElement.prototype = {};
  sandbox.Element.prototype = { setAttribute() {} };
  win.addEventListener = () => {};
  win.fetch = vFetch;
  win.location = { replace() {}, hash: "" };
  win.setInterval = vSetInterval;
  win.setTimeout = vSetTimeout;
  win.clearInterval = vClear;
  win.clearTimeout = vClear;
  win.localStorage = localStorage;
  win.document = doc;
  win.console = sandbox.console;
  win.navigator = sandbox.navigator;
  win.Babel = undefined;

  vm.createContext(sandbox);
  vm.runInContext(seedText, sandbox, { filename: "seed.js" });

  return { win, sandbox, store, pump, fetched, drainMicro };
}

async function scenarioLoginIdle(name, seedText) {
  const h = makeHarness(seedText);
  check(
    name + " B1: primer state exposed on window",
    h.win.__shellTxPrime && h.win.__shellTxPrime.q === 0,
  );
  // two arming polls with no ApiClient: nothing may be fetched
  await h.pump(2);
  check(
    name + " B1: no fetches before ApiClient exists (parse blackout safe)",
    h.fetched.length === 0,
    "fetched=" + JSON.stringify(h.fetched),
  );
  // login form phase: ApiClient present, nobody logged in
  h.win.ApiClient = { getCurrentUserId: () => null };
  await h.pump(8);
  const P = h.win.__shellTxPrime;
  check(
    name + " B1: primer ran to completion in the login window",
    P && P.done === 1 && P.st === "",
    JSON.stringify(P),
  );
  // probe: names[0]=sub/alpha.js across dirs. Only /MyPlugin/js answers 200.
  const probeMisses = h.fetched.filter(
    (u) => u.indexOf("/sub/alpha.js") >= 0 && !MODULES[new URL(u).pathname],
  );
  check(
    name + " B1: probe-then-commit — wrong dirs cost one miss each, no spray",
    probeMisses.length >= 1 &&
      h.fetched.filter((u) => !MODULES[new URL(u).pathname]).length ===
        probeMisses.length,
    JSON.stringify(h.fetched),
  );
  // every module cached under the tx prefix, query-stripped key
  for (const p of Object.keys(MODULES)) {
    check(
      name + " B1: cached " + p,
      typeof h.store[TXPFX + SERVER + p] === "string",
    );
  }
  check(
    name + " B1: jQuery-touching module got the wrapJq gate",
    String(h.store[TXPFX + SERVER + "/MyPlugin/js/sub/alpha.js"]).indexOf(
      "window.jQuery",
    ) >= 0,
  );
  check(
    name + " B1: non-jQuery module cached verbatim (fast path)",
    h.store[TXPFX + SERVER + "/MyPlugin/js/sub/beta.js"] ===
      MODULES["/MyPlugin/js/sub/beta.js"],
  );
  check(
    name + " B1: counters — t equals cached module count",
    P.t === 4 && P.f >= 4,
    JSON.stringify(P),
  );
}

async function scenarioAuthed(name, seedText) {
  const h = makeHarness(seedText);
  h.win.ApiClient = { getCurrentUserId: () => "user-1" };
  await h.pump(6);
  const P = h.win.__shellTxPrime;
  check(
    name + " B2: authed boot — primer stands down with st=auth, zero fetches",
    P && P.st === "auth" && h.fetched.length === 0,
    JSON.stringify({ P, fetched: h.fetched }),
  );
}

async function scenarioKillSwitch(name, seedText) {
  const h = makeHarness(seedText, {
    localStorage: { "jellyfin.shell.txPrimeDisabled": "1" },
  });
  h.win.ApiClient = { getCurrentUserId: () => null };
  await h.pump(6);
  check(
    name + " B3: kill switch — no primer state, no fetches",
    h.win.__shellTxPrime === undefined && h.fetched.length === 0,
    JSON.stringify(h.fetched),
  );
}

async function scenarioRecordThenPrime(name, seedText) {
  // boot 1: dynamic intercept records the URL
  const h1 = makeHarness(seedText, { noScrapeTarget: true });
  const doc = h1.sandbox.document;
  const node = doc.createElement("script");
  node.nodeName = "SCRIPT";
  // drive the patched setAttribute path (JEL-407 pipeline)
  h1.sandbox.Element.prototype.setAttribute.call(
    node,
    "src",
    SERVER + "/MyPlugin/js/extra/splash.js?v=9",
  );
  await h1.pump(3); // debounce flush
  let recorded = [];
  try {
    recorded = JSON.parse(h1.store["jellyfin.shell.dynPluginUrls"] || "[]");
  } catch (_) {}
  check(
    name + " B4: intercepted dynamic src recorded to dynPluginUrls",
    recorded.length === 1 && recorded[0].indexOf("/extra/splash.js") >= 0,
    JSON.stringify(recorded),
  );

  // boot 2: cold cache, logged out, NO scrapeable body — primes from the list
  const h2 = makeHarness(seedText, {
    noScrapeTarget: true,
    localStorage: { "jellyfin.shell.dynPluginUrls": JSON.stringify(recorded) },
  });
  h2.win.ApiClient = { getCurrentUserId: () => null };
  await h2.pump(8);
  check(
    name + " B4: next-boot primer cached the recorded URL",
    typeof h2.store[TXPFX + SERVER + "/MyPlugin/js/extra/splash.js"] ===
      "string",
    JSON.stringify(Object.keys(h2.store)),
  );
}

async function scenarioWarmNoop(name, seedText) {
  const pre = {};
  pre[TXPFX + SERVER + "/MyPlugin/js/sub/alpha.js"] = "cached";
  pre[TXPFX + SERVER + "/MyPlugin/js/sub/beta.js"] = "cached";
  pre[TXPFX + SERVER + "/MyPlugin/js/sub/gamma.js"] = "cached";
  pre[TXPFX + SERVER + "/MyPlugin/js/extra/splash.js"] = "cached";
  const h = makeHarness(seedText, { localStorage: pre });
  h.win.ApiClient = { getCurrentUserId: () => null };
  await h.pump(8);
  check(
    name + " B5: warm cache — primer queues nothing and fetches nothing",
    h.win.__shellTxPrime.q === 0 && h.fetched.length === 0,
    JSON.stringify({ P: h.win.__shellTxPrime, fetched: h.fetched }),
  );
}

async function main() {
  for (const [name, src] of [
    ["shell.js", tvSrc],
    ["boot-shell.src.js", bootSrc],
  ]) {
    const seed = buildSeed(src);
    check(name + ": built seed parses", !!new Function(seed));
    await scenarioLoginIdle(name, seed);
    await scenarioAuthed(name, seed);
    await scenarioKillSwitch(name, seed);
    await scenarioRecordThenPrime(name, seed);
    await scenarioWarmNoop(name, seed);
  }
  console.log(
    failures === 0
      ? "\nALL CHECKS PASSED"
      : "\n" + failures + " CHECK(S) FAILED",
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("HARNESS ERROR:", e);
  process.exit(1);
});
