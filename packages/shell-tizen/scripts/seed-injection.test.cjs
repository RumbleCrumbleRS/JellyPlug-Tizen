// JEL-81 verification — seed script injection (TV vs browser).
//
// Goal: prove buildSeedScript()'s output is injected before any remote
// jellyfin-web script runs, and that the four things the ticket calls out are
// actually established when the seed installs:
//   (1) window.__TXVER is set to the correct (derived) TX_VER hash;
//   (2) the body-focus rescue keydown listener is installed (capture phase);
//   (3) the auto-focus interval (600 ms) is running, budget seeded to 24;
//   (4) the NativeShell getPlugins()/downloadFile() stubs are in place.
//
// WHY THIS IS A "TV vs BROWSER" COMPARISON, NOT A SINGLE-PATH CHECK
//   The seed body is byte-identical on both platforms — there is no `tizen`
//   branch in buildSeedScript(). What differs is ONE gate: the server-origin
//   transpile machinery (which re-asserts window.__TXVER so the seed-side cache
//   key matches the widget-side key) is wrapped in a legacy-Chromium guard:
//
//       var m = /(?:Chrome|Chromium)\/(\d+)\./.exec(navigator.userAgent);
//       var legacy = !!(m && parseInt(m[1],10) < 70);
//       if (!legacy) { try { new Function("var a={};return a?.b"); }
//                      catch (_) { legacy = true; } }
//       if (!legacy) return;          // modern browser: no transpile needed
//       ...
//       var __TXVER = "<hash>"; try { window.__TXVER = __TXVER; } catch (_) {}
//
//   So on the TV (Chromium 56) the SEED itself sets window.__TXVER; on a modern
//   browser the seed's transpile block returns early and never re-sets it —
//   window.__TXVER there comes from the STATIC shell (shell.js line ~119,
//   `window.__TXVER = TX_VER`, run unconditionally on the widget origin BEFORE
//   document.write, and window persists across the document handoff). Both paths
//   resolve to the SAME derived hash, so the cache keys agree.
//
//   By contrast the focus rescue, the 600 ms auto-focuser, and the config.json
//   seed are NOT gated — they install identically on both platforms. That is the
//   parity this test pins: same seed, same focus/config behavior, with the only
//   divergence being WHERE __TXVER gets (re-)asserted.
//
// HOW IT VERIFIES
//   PART A  — CONTRACT: source pins across all four shipped artifacts
//             (shell.js, shell.min.js, boot-shell.src.js, boot-shell.min.js):
//             injection order, the data-shell-seed marker, and the presence of
//             each of the four features.
//   PART B  — TX_VER CORRECTNESS: recompute TX_VER from shell.js's OWN inputs
//             (the extracted txFnv1a + the three derivation constants), then
//             prove the static assignment and the built seed both embed exactly
//             that value, and that the static/seed cache prefixes agree.
//   PART C  — EXECUTION: build the ACTUAL seed via the extracted
//             buildSeedScript(), run it in a DOM sandbox under both a TV
//             (Chromium 56) and a browser (Chrome 120) userAgent, and introspect
//             `window` — exactly the "window introspection" the ticket asks for.
//             Also fires the installed config.json intercept to prove the seed
//             is live before remote scripts, and exercises the NativeShell stubs.
//
// Run: node scripts/seed-injection.test.cjs
//   or: pnpm --filter @jellyfin-tv/shell-tizen test

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

const AUTOFOCUS_MS = 600; // proactive auto-focuser cadence
const AUTOFOCUS_BUDGET = 24; // ~14 s per page (24 ticks * 600 ms)

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

// Structural extractor: pull a 2-space-indented top-level function out of the
// shell IIFE by scanning to its closing `  }` line. A brace counter can't be
// used here — buildSeedScript() is ~1100 lines of string literals stuffed with
// unbalanced `{`/`}` bytes — but every sibling function in shell.js closes with
// a `}` at exactly two-space indent on its own line.
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

// ============================================================================
// PART A — CONTRACT (source pins; failures exit non-zero)
// ============================================================================

// A1. The seed builder and its injection marker exist.
check(
  "buildSeedScript() defined in shell.js",
  /function buildSeedScript\(serverUrl, upstreamCfg\)/.test(tvSrc),
);
check(
  "seed is tagged data-shell-seed so QA/interceptors can find it",
  tvSrc.includes('"data-shell-seed", "1"') ||
    tvSrc.includes('data-shell-seed="1"'),
);

// A2. Injection ORDER and TIMING: diag -> <base> -> seed -> polyfill, inserted
//     into <head> BEFORE jellyfin-web's body scripts.
//     TV path = document.write head splice; browser path = DOM insertBefore.
check(
  "TV path injects seed in order: diag -> base -> seed -> polyfill",
  /data-shell-diag="1"[^]*?<base href="[^]*?data-shell-seed="1"[^]*?seedBody[^]*?data-shell-polyfill="1"/.test(
    tvSrc,
  ),
);
check(
  "TV path splices the injection into <head> (before remote body scripts)",
  /var insertAt = headIdx \+ 6;[^]*?html\.slice\(0, insertAt\) \+ injected/.test(
    tvSrc,
  ),
);
check(
  "browser path inserts the seed <script> right after <base>",
  /seedTag\.setAttribute\("data-shell-seed", "1"\);[^]*?insertBefore\(seedTag, baseTag\.nextSibling\)/.test(
    tvSrc,
  ),
);
check(
  "browser path comment states seed runs BEFORE any jellyfin-web script",
  /Seed config\.json BEFORE any jellyfin-web script runs/.test(tvSrc),
);

// A3. (1) window.__TXVER — derived, not hand-bumped; static + seed both assert.
check(
  "TX_VER derivation inputs present (regex src / babel opts / babel fpr)",
  /var MODERN_SYNTAX_RE_SRC =/.test(tvSrc) &&
    /var BABEL_OPTS_KEY =/.test(tvSrc) &&
    /var BABEL_FPR = "__BABEL_FPR__";/.test(tvSrc),
);
check(
  "TX_VER derived via FNV-1a (txFnv1a) over those inputs",
  /function txFnv1a\(s\)/.test(tvSrc) && /var TX_VER = txFnv1a\(/.test(tvSrc),
);
check(
  "static shell sets window.__TXVER = TX_VER unconditionally (widget origin)",
  /window\.__TXVER = TX_VER;/.test(tvSrc),
);
check(
  "seed embeds __TXVER = JSON.stringify(TX_VER) and re-asserts window.__TXVER",
  tvSrc.includes('"    var __TXVER=" + JSON.stringify(TX_VER) + ";"') &&
    tvSrc.includes('"    try{window.__TXVER=__TXVER;}catch(_){}"'),
);
check(
  "seed-side cache prefix is derived from the SAME __TXVER (keys agree)",
  tvSrc.includes('var __TXPFX="shell.tx"+__TXVER+":"'),
);

// A4. (2) body-focus rescue keydown listener — capture phase, with bound flag.
check(
  "seed installs a capture-phase keydown listener for body-focus rescue",
  tvSrc.includes('window.addEventListener("keydown",function(e){') &&
    /window\.addEventListener\("keydown",function\(e\)\{[^]*?\},true\);/.test(
      tvSrc,
    ),
);
check(
  "seed marks the listener bound (__shellBodyFocusRescueBound=1)",
  tvSrc.includes("window.__shellBodyFocusRescueBound=1"),
);
check(
  "rescue only fires when focus is stuck on BODY/HTML",
  tvSrc.includes('return !a||a===document.body||a.tagName==="HTML";'),
);

// A5. (3) auto-focus interval — 600 ms cadence, 24-tick budget, auth-gated.
check(
  "seed runs a " + AUTOFOCUS_MS + "ms auto-focus interval",
  tvSrc.includes("}," + AUTOFOCUS_MS + ");"),
);
check(
  "auto-focus budget seeded to " + AUTOFOCUS_BUDGET + " ticks",
  tvSrc.includes("window.__shellAutoFocusBudget=" + AUTOFOCUS_BUDGET + ";"),
);
check(
  "auto-focus budget resets on hashchange/popstate",
  tvSrc.includes('addEventListener("hashchange",bumpAF') &&
    tvSrc.includes('addEventListener("popstate",bumpAF'),
);
check(
  "auto-focuser is gated on stored credentials (no keyboard pop pre-login)",
  /function isAuthed\(\)\{[^]*?jellyfin_credentials[^]*?AccessToken/.test(
    tvSrc,
  ),
);

// A6. (4) NativeShell getPlugins/downloadFile stubs.
check(
  "NativeShell.getPlugins() returns an empty array",
  /getPlugins: function \(\) \{\s*return \[\];\s*\},/.test(tvSrc),
);
check(
  "NativeShell.downloadFile() is a no-op (offline downloads not in M1)",
  /downloadFile: function \(\) \{\s*\/\* offline downloads not in M1 \*\/\s*\},/.test(
    tvSrc,
  ),
);

// A7. All four shipped artifacts carry the seed + its four features (no path
//     boots without them).
for (const [label, src] of ARTIFACTS) {
  check(
    label + " carries the data-shell-seed marker",
    src.includes("data-shell-seed"),
  );
  check(label + " carries window.__TXVER", src.includes("__TXVER"));
  check(
    label + " carries the body-focus rescue bound flag",
    src.includes("__shellBodyFocusRescueBound"),
  );
  check(
    label + " carries the " + AUTOFOCUS_MS + "ms auto-focus interval",
    src.includes("," + AUTOFOCUS_MS + ")"),
  );
  check(
    label + " carries NativeShell getPlugins stub",
    src.includes("getPlugins"),
  );
  check(
    label + " carries NativeShell downloadFile stub",
    src.includes("downloadFile"),
  );
}

// ============================================================================
// PART B — TX_VER CORRECTNESS (recompute from shell.js's own inputs)
// ============================================================================
// Pull txFnv1a + the three derivation constants straight out of shell.js and
// recompute TX_VER independently. Then prove the static assignment and the built
// seed both embed exactly that value — i.e. window.__TXVER really is "the
// correct TX_VER hash", not just *some* string.

function strLiteral(src, name) {
  const m = src.match(
    new RegExp("var " + name + '\\s*=\\s*\\n?\\s*("(?:[^"\\\\]|\\\\.)*")'),
  );
  if (!m) throw new Error("could not read string literal: " + name);
  return m[1];
}
const SRC_LIT = strLiteral(tvSrc, "MODERN_SYNTAX_RE_SRC");
const OPTS_LIT = strLiteral(tvSrc, "BABEL_OPTS_KEY");
const FPR_LIT = strLiteral(tvSrc, "BABEL_FPR");

const txCtx = {};
vm.createContext(txCtx);
vm.runInContext(
  extractTopFn(tvSrc, "txFnv1a") +
    ";\nthis.__TX = txFnv1a((" +
    SRC_LIT +
    ")+'|'+(" +
    OPTS_LIT +
    ")+'|'+(" +
    FPR_LIT +
    "));",
  txCtx,
);
const TX_VER = txCtx.__TX;
check(
  "recomputed TX_VER is a non-empty base-36 string",
  typeof TX_VER === "string" && /^[0-9a-z]+$/.test(TX_VER),
  JSON.stringify(TX_VER),
);

// B1. Static shell: run the real derivation block; window.__TXVER must equal the
//     independently recomputed hash, unconditionally.
{
  const a = tvSrc.indexOf("var MODERN_SYNTAX_RE_SRC");
  const b = tvSrc.indexOf("var TX_PFX");
  const staticBlock = tvSrc.slice(a, b);
  const win = {};
  const sb = { window: win, console };
  vm.createContext(sb);
  vm.runInContext(staticBlock + "\n;try{window.__TXVER=TX_VER;}catch(_){}", sb);
  check(
    "static shell sets window.__TXVER to the recomputed hash",
    win.__TXVER === TX_VER,
    "got " + JSON.stringify(win.__TXVER) + " want " + JSON.stringify(TX_VER),
  );
}

// Build the ACTUAL seed via the extracted buildSeedScript(), feeding it the same
// TX_VER the widget would have at parse time.
const SERVER = "https://tv.example.test";
const UPSTREAM = { servers: ["stale"], multiserver: true, theme: "dark" };
const buildSeedScript = (function () {
  const fnSrc = extractTopFn(tvSrc, "buildSeedScript").replace(
    /^  function buildSeedScript/,
    "function",
  );
  const sb = { Object, JSON, TX_VER };
  vm.createContext(sb);
  return vm.runInContext("(" + fnSrc + ")", sb);
})();
const seed = buildSeedScript(SERVER, UPSTREAM);

// B2. The built seed embeds exactly the recomputed hash and a matching prefix.
check(
  'built seed embeds var __TXVER="' + TX_VER + '"',
  seed.includes('var __TXVER="' + TX_VER + '"'),
);
check(
  "built seed asserts window.__TXVER and derives shell.tx<ver>: prefix from it",
  seed.includes("try{window.__TXVER=__TXVER;}catch(_){}") &&
    seed.includes('var __TXPFX="shell.tx"+__TXVER+":"'),
);

// ============================================================================
// PART C — EXECUTION (run the real seed; introspect window) — TV vs browser
// ============================================================================
// Run the exact seed string in a DOM sandbox under two userAgents. Record the
// 600 ms interval registration and keydown listener, then read window state.

const TV_UA =
  "Mozilla/5.0 (SMART-TV; Linux; Tizen 5.0) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/56.0.2924.0 Safari/537.36";
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function runSeed(ua) {
  const intervals = [];
  const keydown = [];
  let configResponseBody = null;

  function El() {
    return {
      style: {},
      setAttribute() {},
      getAttribute() {
        return null;
      },
      appendChild() {},
      insertBefore() {},
      addEventListener() {},
      querySelector() {
        return null;
      },
      querySelectorAll() {
        return [];
      },
      getElementsByTagName() {
        return [];
      },
      focus() {},
      getBoundingClientRect() {
        return { width: 0, height: 0 };
      },
      offsetParent: null,
    };
  }
  const doc = {
    documentElement: El(),
    head: El(),
    body: El(),
    createElement() {
      return El();
    },
    getElementById() {
      return null;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    getElementsByTagName() {
      return [];
    },
    addEventListener() {},
    registerElement: undefined,
    activeElement: null,
  };
  doc.body.tagName = "BODY";
  doc.activeElement = doc.body;

  function XHR() {}
  XHR.prototype.open = function () {};
  XHR.prototype.send = function () {};

  function FakeResponse(body, opts) {
    this._body = body;
    Object.assign(this, opts);
    this.text = function () {
      return Promise.resolve(body);
    };
  }

  const win = {};
  const sandbox = {
    window: win,
    document: doc,
    navigator: { userAgent: ua },
    XMLHttpRequest: XHR,
    Response: FakeResponse,
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
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: (fn, d) => {
      intervals.push(d);
      return intervals.length;
    },
    clearInterval() {},
    localStorage: {
      _d: {},
      getItem(k) {
        return this._d[k] || null;
      },
      setItem(k, v) {
        this._d[k] = v;
      },
      removeItem(k) {
        delete this._d[k];
      },
    },
    Node: function () {},
    HTMLScriptElement: function () {},
  };
  sandbox.Node.prototype = {};
  sandbox.HTMLScriptElement.prototype = {};
  win.addEventListener = (t, fn, capture) => {
    if (t === "keydown") keydown.push({ capture: capture });
  };
  win.fetch = () => Promise.resolve();
  win.location = { replace() {} };
  win.setInterval = sandbox.setInterval;
  win.setTimeout = sandbox.setTimeout;
  win.localStorage = sandbox.localStorage;
  win.document = doc;
  win.console = sandbox.console;
  win.navigator = sandbox.navigator;
  win.Babel = undefined;

  vm.createContext(sandbox);
  let threw = null;
  try {
    vm.runInContext(seed, sandbox, { filename: "seed.js" });
  } catch (e) {
    threw = e.message;
  }

  return {
    threw,
    txver: win.__TXVER,
    bound: win.__shellBodyFocusRescueBound,
    budget: win.__shellAutoFocusBudget,
    seeded: win.__shellSeededServer,
    intervals,
    keydown,
    // the seed overrode window.fetch — fetching config.json must now return the
    // seeded config, proving the seed is LIVE before any remote script runs.
    fetchConfig() {
      return win
        .fetch("https://tv.example.test/web/config.json")
        .then((r) => r.text())
        .then((t) => JSON.parse(t));
    },
  };
}

async function main() {
  const tv = runSeed(TV_UA);
  const br = runSeed(BROWSER_UA);

  // C0. The seed must install cleanly (no uncaught throw) on both platforms.
  check("TV: seed installs without throwing", tv.threw === null, tv.threw);
  check("browser: seed installs without throwing", br.threw === null, br.threw);

  // C1. (1) window.__TXVER — TV: seed itself sets it (legacy transpile path).
  check(
    "TV: seed sets window.__TXVER to the recomputed hash",
    tv.txver === TX_VER,
    "got " + JSON.stringify(tv.txver),
  );
  //     browser: seed's transpile block returns early (modern), so the seed does
  //     NOT re-set __TXVER — it is owned by the static widget-origin assignment
  //     (proven in B1). This is the one intended TV/browser divergence.
  check(
    "browser: seed does NOT re-set __TXVER (static shell owns it on modern Chrome)",
    br.txver === undefined,
    "got " + JSON.stringify(br.txver),
  );

  // C2. (2) body-focus rescue keydown listener — installed, capture phase, both.
  check(
    "TV: capture-phase keydown rescue listener installed",
    tv.bound === 1 && tv.keydown.length === 1 && tv.keydown[0].capture === true,
    JSON.stringify({ bound: tv.bound, keydown: tv.keydown }),
  );
  check(
    "browser: capture-phase keydown rescue listener installed (identical)",
    br.bound === 1 && br.keydown.length === 1 && br.keydown[0].capture === true,
    JSON.stringify({ bound: br.bound, keydown: br.keydown }),
  );

  // C3. (3) auto-focus interval — 600 ms, budget 24, on both.
  check(
    "TV: " +
      AUTOFOCUS_MS +
      "ms auto-focus interval running, budget=" +
      AUTOFOCUS_BUDGET,
    tv.intervals.indexOf(AUTOFOCUS_MS) !== -1 && tv.budget === AUTOFOCUS_BUDGET,
    JSON.stringify({ intervals: tv.intervals, budget: tv.budget }),
  );
  check(
    "browser: " +
      AUTOFOCUS_MS +
      "ms auto-focus interval running, budget=" +
      AUTOFOCUS_BUDGET +
      " (identical)",
    br.intervals.indexOf(AUTOFOCUS_MS) !== -1 && br.budget === AUTOFOCUS_BUDGET,
    JSON.stringify({ intervals: br.intervals, budget: br.budget }),
  );

  // C4. The config.json intercept is LIVE before remote scripts on both: fetch
  //     resolves to the seeded {servers:[serverUrl], multiserver:false}, with
  //     upstream fields preserved. This is what lands the user on the server's
  //     login UI without a second "Add Server" step.
  for (const [label, ctx] of [
    ["TV", tv],
    ["browser", br],
  ]) {
    check(
      label + ": seed records the seeded server URL on window",
      ctx.seeded === SERVER,
      "got " + JSON.stringify(ctx.seeded),
    );
    const cfg = await ctx.fetchConfig();
    check(
      label +
        ": config.json fetch returns servers:[serverUrl], multiserver:false",
      Array.isArray(cfg.servers) &&
        cfg.servers.length === 1 &&
        cfg.servers[0] === SERVER &&
        cfg.multiserver === false,
      JSON.stringify({ servers: cfg.servers, multiserver: cfg.multiserver }),
    );
    check(
      label + ": seeded config preserves upstream fields (theme)",
      cfg.theme === "dark",
    );
  }

  // C5. (4) NativeShell getPlugins()/downloadFile() stubs — behavioral.
  //     These live in the STATIC NativeShell object (set on the widget origin
  //     before document.write); extract and exercise them directly.
  {
    const ns0 = tvSrc.indexOf("window.NativeShell = {");
    const nsEnd = tvSrc.indexOf("\n  };", ns0) + 4;
    const nsLiteral = tvSrc.slice(ns0, nsEnd);
    const stubs = {
      AppInfo: { appName: "x", deviceId: "d", deviceName: "n" },
      getSystemInfo: () => Promise.resolve(),
      exitApp() {},
      systeminfo: null,
      SupportedFeatures: ["play"],
      clearServerUrl() {},
      window: { location: { replace() {} } },
      Promise,
    };
    vm.createContext(stubs);
    vm.runInContext(nsLiteral, stubs);
    const NS = stubs.window.NativeShell;
    const plugins = NS.getPlugins();
    check(
      "NativeShell.getPlugins() returns an empty array",
      Array.isArray(plugins) && plugins.length === 0,
      JSON.stringify(plugins),
    );
    check(
      "NativeShell.downloadFile() is a no-op returning undefined",
      typeof NS.downloadFile === "function" &&
        NS.downloadFile("http://x/y") === undefined,
    );
  }

  console.log("");
  if (failures) {
    console.error(
      "\nseed-injection verification FAILED: " + failures + " check(s).",
    );
    process.exit(1);
  }
  console.log(
    "seed-injection verification PASSED — seed injected before remote scripts; " +
      "__TXVER correct, focus rescue + 600ms auto-focuser installed, NativeShell " +
      "stubs in place; TV vs browser identical except the legacy-gated __TXVER owner.",
  );
}

main().catch((e) => {
  console.error("seed-injection verification ERRORED:", e && e.stack);
  process.exit(1);
});
