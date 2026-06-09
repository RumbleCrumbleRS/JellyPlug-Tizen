// JEL-40 verification test — Babel preload optimization (V8 code-cache warm-up)
// for legacy Chromium TVs (Tizen 5.0 / M56, Tizen 5.5 / M63-M69).
//
// WHAT THE TICKET ASKS US TO PROVE
// --------------------------------
// On a legacy Chromium TV, after the FIRST babel-needed boot (which sets
// `jellyfin.shell.legacy.babelNeeded='1'`), the SECOND boot must:
//   (1) insert `<link rel=preload as=script href=babel.min.js>` into <head>;
//   (2) set `window.__shellBabelPreload === 1`;
//   (3) set `__qaMarks.tBabelPreloadAppend` to a real (non-zero) timestamp.
// Then COMPARE boot timing with vs without the preload (the
// `jellyfin.shell.legacy.babelPreload='0'` flag disables it) and confirm the
// preload makes babel ready EARLIER in the boot critical path.
//
// HOW THIS TEST PROVES IT (without a TV)
// --------------------------------------
// The preload behaviour lives entirely in the four head IIFEs of the SHIPPED
// `packages/shell-tizen/src/index.html`:
//   - boot-mark IIFE   (allocates window.__qaMarks, gated by qa.bootMarks)
//   - babel-preload    (JEL-1973: the <link rel=preload> appender)
//   - prefetch IIFE    (JEL-554/1967: /web/ + recorded-URL warmers)
//   - ensureBabel IIFE (JEL-1034: lazy loader + JEL-1973 step-3 eager kick)
// We EXTRACT each IIFE verbatim from the real index.html (so a future edit that
// drops/renames a flag fails this test) and EXECUTE it in a controlled fake-DOM
// harness with a scriptable UA, localStorage, monotonic clock, and an element
// recorder. That runs the exact shipped code through the exact second-boot
// state and lets us assert the DOM/flag/qa-mark outcomes deterministically and
// run a clean A/B on WHEN babel loading is initiated.
//
// TIMING — what is and isn't measurable here. The ABSOLUTE millisecond cost of
// V8 parsing the 3.13 MB babel.min.js (~500-800 ms) is M56/M63 silicon-bound
// and only measurable on the TV via the persisted boot-marks
// (localStorage['jellyfin.qa.bootMarks.prior'], rotated each boot). What IS
// verifiable in-sandbox — and what the optimization actually changes — is WHEN
// the babel <script> load is *initiated*: with the preload on, the eager
// __ensureBabel() kick fires during head parse; with it off, __ensureBabel() is
// only reached later from shell.js's transpile path, i.e. after shell.min.js
// has parsed. So babel readiness moves earlier by (at least) one
// shell.min.js-parse interval — exactly the mechanism JEL-1973 claims. We model
// the boot as an ordered clock and assert that direction structurally; the
// modeled shell-parse interval stands in for the hardware number, which the
// on-TV boot-marks report for record.
//
// Zero committed deps (pure source extraction + Node), matching
// plugin-syntax-transpile.test.cjs. An optional jsdom block (resolved from
// tooling/wgt-emulate, skipped cleanly if absent) re-confirms the second-boot
// DOM outcome inside a genuine browser-like DOM as belt-and-suspenders.
//
// Run: node scripts/babel-preload.test.cjs
//   or: pnpm --filter @jellyfin-tv/shell-tizen test

"use strict";

const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..", "..", "..");
const INDEX_HTML = path.join(
  REPO,
  "packages",
  "shell-tizen",
  "src",
  "index.html",
);

// localStorage keys the preload pipeline reads/writes.
const K = {
  babelNeeded: "jellyfin.shell.legacy.babelNeeded",
  babelPreload: "jellyfin.shell.legacy.babelPreload",
  unusedStreak: "jellyfin.shell.legacy.babelUnusedStreak",
  bootMarksEnabled: "jellyfin.qa.bootMarks.enabled",
  serverUrl: "jellyfin.shell.serverUrl",
};

// Representative legacy UAs. Both contain a Chrome/<70 token so the shell's
// UA regex (/(?:Chrome|Chromium)\/(\d+)\./, <70 => legacy) classifies them
// legacy WITHOUT falling back to the optional-chaining probe — which Node's
// modern parser can't reproduce (it never throws). M56 = Tizen 5.0, M63 = the
// Chromium 63 class the shell's babel preset targets.
const UA_M56 =
  "Mozilla/5.0 (SMART-TV; Linux; Tizen 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/56.0.2924.0 Safari/537.36";
const UA_M63 =
  "Mozilla/5.0 (SMART-TV; Linux; Tizen 5.5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/63.0.3239.84 Safari/537.36";
const UA_MODERN =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

let failures = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log("OK: " + name);
  } else {
    console.error("FAIL: " + name + (extra ? "  [" + extra + "]" : ""));
    failures++;
  }
}

// --- Extract the four head IIFEs verbatim from the shipped index.html --------
// Pull each inline <script> body by a signature substring so the test runs the
// EXACT shipped code and fails loudly if an IIFE is renamed or removed.
const html = fs.readFileSync(INDEX_HTML, "utf8");

function inlineScripts(src) {
  const out = [];
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(src))) out.push(m[1]);
  return out;
}
const SCRIPTS = inlineScripts(html);
function findIIFE(signature) {
  const hit = SCRIPTS.filter((s) => s.indexOf(signature) !== -1);
  return hit.length === 1 ? hit[0] : null;
}

const SRC = {
  qaMarks: findIIFE("__qaMarks={bootIndex"),
  preload: findIIFE("__shellBabelPreload=0"),
  prefetch: findIIFE("__shellPrefetch"),
  ensureBabel: findIIFE("__ensureBabel=function"),
};

check("index.html exposes the boot-mark IIFE", !!SRC.qaMarks);
check("index.html exposes the babel-preload IIFE", !!SRC.preload);
check("index.html exposes the prefetch IIFE", !!SRC.prefetch);
check("index.html exposes the ensureBabel IIFE", !!SRC.ensureBabel);
// The preload IIFE must reference babel.min.js as a preloaded script and set
// the documented flag/qa-mark — guards against a silent behavioural rewrite.
check(
  "preload IIFE targets babel.min.js via rel=preload as=script",
  !!SRC.preload &&
    /l\.rel='preload'/.test(SRC.preload) &&
    /l\.as='script'/.test(SRC.preload) &&
    /l\.href='babel\.min\.js'/.test(SRC.preload),
);
check(
  "preload IIFE sets window.__shellBabelPreload and tBabelPreloadAppend",
  !!SRC.preload &&
    /__shellBabelPreload=1/.test(SRC.preload) &&
    /tBabelPreloadAppend=performance\.now\(\)/.test(SRC.preload),
);
check(
  "ensureBabel IIFE eager-kicks on babelNeeded=1 && babelPreload!=0",
  !!SRC.ensureBabel &&
    /babelNeeded'\)==='1'&&localStorage\.getItem\('jellyfin\.shell\.legacy\.babelPreload'\)!=='0'/.test(
      SRC.ensureBabel,
    ) &&
    /__ensureBabel\(\)/.test(SRC.ensureBabel),
);

if (failures) {
  console.error("\nCannot continue: failed to extract shipped IIFEs.");
  process.exit(1);
}

// --- Fake-DOM harness --------------------------------------------------------
// A scriptable boot environment that runs the shipped IIFEs in head order and
// records every element appended to <head>. The clock is monotonic and only
// advances when WE advance it, so timing is deterministic.
function makeBoot(opts) {
  const store = Object.assign({}, opts.store || {});
  const clock = { t: 0 };
  const appended = [];
  let babelScriptEl = null;

  const localStorage = {
    getItem(k) {
      return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null;
    },
    setItem(k, v) {
      store[k] = String(v);
    },
    removeItem(k) {
      delete store[k];
    },
  };
  const head = {
    appendChild(node) {
      appended.push(node);
      if (node.tagName === "SCRIPT" && node.src === "babel.min.js") {
        babelScriptEl = node;
      }
      return node;
    },
  };
  const document = {
    head,
    createElement(tag) {
      return { tagName: String(tag).toUpperCase(), rel: "", as: "", href: "", src: "", async: false, onload: null, onerror: null };
    },
  };
  const navigator = { userAgent: opts.ua };
  const performance = { now: () => clock.t };
  const fetchCalls = [];
  function fetch(url, init) {
    fetchCalls.push(url);
    return Promise.resolve({ ok: true, url, _init: init });
  }
  const win = {};

  function run(name) {
    const body = SRC[name];
    // Expose the same globals an inline <script> would see; everything else
    // (Promise, JSON, parseInt, Function, Date) is a real JS global.
    const fn = new Function(
      "window",
      "document",
      "navigator",
      "localStorage",
      "performance",
      "fetch",
      "console",
      body,
    );
    fn(win, document, navigator, localStorage, performance, fetch, console);
  }

  return {
    window: win,
    store,
    clock,
    appended,
    fetchCalls,
    run,
    advance(ms) {
      clock.t += ms;
    },
    get babelScriptEl() {
      return babelScriptEl;
    },
    // Simulate the babel.min.js <script> finishing load after `parseMs` of V8
    // work, firing its onload so tBabelReady is stamped (as a real browser
    // would once the resource downloads + compiles).
    settleBabel(parseMs) {
      if (!babelScriptEl || typeof babelScriptEl.onload !== "function") return false;
      clock.t += parseMs;
      babelScriptEl.onload();
      return true;
    },
    preloadLink() {
      return appended.find(
        (n) =>
          n.tagName === "LINK" &&
          n.rel === "preload" &&
          n.as === "script" &&
          n.href === "babel.min.js",
      );
    },
  };
}

// Drive the head IIFEs in document order. `advanceEach` ms of modeled parse
// time elapses between IIFEs so the clock moves the way head parsing does.
function bootHead(boot, advanceEach) {
  boot.run("qaMarks");
  boot.advance(advanceEach);
  boot.run("preload");
  boot.advance(advanceEach);
  boot.run("prefetch");
  boot.advance(advanceEach);
  boot.run("ensureBabel");
}

const baseStore = () => ({
  [K.bootMarksEnabled]: "1",
  [K.serverUrl]: "https://tv.example.net",
});

// =============================================================================
// SCENARIO A — second boot on a babel-needed legacy server (the core ask)
// =============================================================================
console.log("\n--- A: M63 second boot, babelNeeded=1, preload default-on ---");
{
  const boot = makeBoot({
    ua: UA_M63,
    store: Object.assign(baseStore(), { [K.babelNeeded]: "1" }),
  });
  bootHead(boot, 5);

  const link = boot.preloadLink();
  check("(1) <link rel=preload as=script href=babel.min.js> appended to <head>", !!link);
  check("(2) window.__shellBabelPreload === 1", boot.window.__shellBabelPreload === 1, "got " + boot.window.__shellBabelPreload);
  check(
    "(3) __qaMarks.tBabelPreloadAppend is set (non-zero)",
    boot.window.__qaMarks && boot.window.__qaMarks.tBabelPreloadAppend > 0,
    "got " + (boot.window.__qaMarks && boot.window.__qaMarks.tBabelPreloadAppend),
  );
  // The eager kick must have appended the actual babel <script> during head
  // parse, and stamped tBabelScriptAppend after the preload-append mark.
  check("eager __ensureBabel kicked: babel <script> appended in head", !!boot.babelScriptEl);
  check(
    "tBabelScriptAppend stamped after tBabelPreloadAppend (preload precedes script)",
    boot.window.__qaMarks.tBabelScriptAppend > boot.window.__qaMarks.tBabelPreloadAppend,
  );
  // Persistence: marks are saved so the next boot's beacon can read them.
  const saved = JSON.parse(boot.store["jellyfin.qa.bootMarks.current"]);
  check(
    "boot-marks persisted to localStorage with the preload mark",
    saved && saved.tBabelPreloadAppend === boot.window.__qaMarks.tBabelPreloadAppend,
  );
}

// Same on the older M56 WebView (Tizen 5.0) — both legacy classes covered.
console.log("\n--- A': M56 second boot, babelNeeded=1, preload default-on ---");
{
  const boot = makeBoot({
    ua: UA_M56,
    store: Object.assign(baseStore(), { [K.babelNeeded]: "1" }),
  });
  bootHead(boot, 5);
  check("M56: preload link present", !!boot.preloadLink());
  check("M56: __shellBabelPreload === 1", boot.window.__shellBabelPreload === 1);
  check("M56: tBabelPreloadAppend set", boot.window.__qaMarks.tBabelPreloadAppend > 0);
}

// =============================================================================
// SCENARIO B — FIRST boot of a new server (no babelNeeded flag yet)
// The preload must NOT fire: plugin-light servers never eat the 3.13 MB cost.
// =============================================================================
console.log("\n--- B: M63 first boot, babelNeeded UNSET ---");
{
  const boot = makeBoot({ ua: UA_M63, store: baseStore() });
  bootHead(boot, 5);
  check("first boot: no preload link", !boot.preloadLink());
  check("first boot: __shellBabelPreload stays 0", boot.window.__shellBabelPreload === 0);
  check("first boot: tBabelPreloadAppend stays 0", boot.window.__qaMarks.tBabelPreloadAppend === 0);
  check("first boot: no eager babel <script>", !boot.babelScriptEl);
}

// =============================================================================
// SCENARIO C — preload explicitly DISABLED (the A/B baseline switch)
// =============================================================================
console.log("\n--- C: M63 second boot, babelPreload='0' (v66m baseline) ---");
{
  const boot = makeBoot({
    ua: UA_M63,
    store: Object.assign(baseStore(), { [K.babelNeeded]: "1", [K.babelPreload]: "0" }),
  });
  bootHead(boot, 5);
  check("disabled: no preload link", !boot.preloadLink());
  check("disabled: __shellBabelPreload stays 0", boot.window.__shellBabelPreload === 0);
  check("disabled: tBabelPreloadAppend stays 0", boot.window.__qaMarks.tBabelPreloadAppend === 0);
  check("disabled: no eager babel <script> kick in head", !boot.babelScriptEl);
}

// =============================================================================
// SCENARIO D — soft-skip when babel went unused for >=2 passes (JEL-1984)
// Flag stays 0 and no <link> appears, so QA can assert the skip.
// =============================================================================
console.log("\n--- D: M63 second boot, babelUnusedStreak>=2 (soft-skip) ---");
{
  const boot = makeBoot({
    ua: UA_M63,
    store: Object.assign(baseStore(), { [K.babelNeeded]: "1", [K.unusedStreak]: "2" }),
  });
  bootHead(boot, 5);
  check("soft-skip: no preload link", !boot.preloadLink());
  check("soft-skip: __shellBabelPreload stays 0", boot.window.__shellBabelPreload === 0);
  // streak below threshold still preloads
  const boot1 = makeBoot({
    ua: UA_M63,
    store: Object.assign(baseStore(), { [K.babelNeeded]: "1", [K.unusedStreak]: "1" }),
  });
  bootHead(boot1, 5);
  check("streak=1 (<2): preload still fires", !!boot1.preloadLink());
}

// =============================================================================
// SCENARIO E — modern (non-legacy) browser: preload pipeline must NOT engage
// =============================================================================
console.log("\n--- E: modern Chromium 120, babelNeeded=1 ---");
{
  const boot = makeBoot({
    ua: UA_MODERN,
    store: Object.assign(baseStore(), { [K.babelNeeded]: "1" }),
  });
  bootHead(boot, 5);
  check("modern: no preload link", !boot.preloadLink());
  check("modern: __shellBabelPreload stays 0", boot.window.__shellBabelPreload === 0);
  check("modern: no babel <script> (ensureBabel is a no-op)", !boot.babelScriptEl);
}

// =============================================================================
// SCENARIO F — TIMING A/B: confirm the preload makes babel ready EARLIER
// -----------------------------------------------------------------------------
// Model the boot as an ordered clock. The head IIFEs run first (cheap). Then
// shell.min.js parses — a fixed, hardware-bound interval (SHELL_PARSE) that on
// M56/M63 is ~hundreds of ms. babel.min.js V8 compile is BABEL_PARSE.
//
//   PRELOAD ON : the eager __ensureBabel() kick fires DURING head parse, so the
//                babel <script> load starts immediately and its V8 compile
//                OVERLAPS the shell.min.js parse. tBabelReady lands at
//                head + BABEL_PARSE.
//   PRELOAD OFF: __ensureBabel() is only reached from shell.js's transpile path
//                AFTER shell.min.js has parsed, so the babel load starts
//                ~SHELL_PARSE later. tBabelReady lands at head + SHELL_PARSE +
//                BABEL_PARSE.
//
// The structural, assumption-free fact we assert: babel loading is INITIATED
// earlier with the preload on (tBabelScriptAppend_ON < tBabelScriptAppend_OFF),
// and the gap equals the shell.min.js-parse interval — so total time-to-babel
// is reduced by at least that interval. The absolute ms is the on-TV number.
// =============================================================================
console.log("\n--- F: timing A/B (preload ON vs OFF) ---");
{
  const HEAD_EACH = 5; // modeled per-IIFE head parse
  const SHELL_PARSE = 900; // modeled shell.min.js parse interval on M63
  const BABEL_PARSE = 700; // modeled babel.min.js V8 compile on M63

  // ON: eager kick during head parse; babel compile overlaps shell parse.
  const on = makeBoot({
    ua: UA_M63,
    store: Object.assign(baseStore(), { [K.babelNeeded]: "1" }),
  });
  bootHead(on, HEAD_EACH);
  const onScriptAppend = on.window.__qaMarks.tBabelScriptAppend;
  on.settleBabel(BABEL_PARSE); // overlaps the shell parse that follows
  const onReady = on.window.__qaMarks.tBabelReady;

  // OFF: no eager kick. shell.min.js parses first, THEN the transpile path
  // calls __ensureBabel(). We advance the clock by SHELL_PARSE to represent
  // shell.min.js parsing, then invoke the lazy loader as shell.js would.
  const off = makeBoot({
    ua: UA_M63,
    store: Object.assign(baseStore(), { [K.babelNeeded]: "1", [K.babelPreload]: "0" }),
  });
  bootHead(off, HEAD_EACH);
  check("F/OFF: head parse left babel un-kicked", !off.babelScriptEl);
  off.advance(SHELL_PARSE); // shell.min.js parses
  off.window.__ensureBabel(); // transpile path reaches the lazy loader
  const offScriptAppend = off.window.__qaMarks.tBabelScriptAppend;
  off.settleBabel(BABEL_PARSE);
  const offReady = off.window.__qaMarks.tBabelReady;

  check(
    "babel load INITIATED earlier with preload on",
    onScriptAppend < offScriptAppend,
    "on=" + onScriptAppend + " off=" + offScriptAppend,
  );
  check(
    "babel READY earlier with preload on",
    onReady < offReady,
    "on=" + onReady + " off=" + offReady,
  );
  const savedMs = offReady - onReady;
  check(
    "time-to-babel reduced by >= one shell.min.js-parse interval",
    savedMs >= SHELL_PARSE,
    "saved=" + savedMs + " shellParse=" + SHELL_PARSE,
  );
  console.log(
    "   modeled: ready ON=" + onReady + "ms  OFF=" + offReady + "ms  saved=" + savedMs + "ms (== shell-parse interval; absolute ms is the on-TV boot-marks number)",
  );
}

// =============================================================================
// OPTIONAL — re-confirm the second-boot DOM outcome inside a real jsdom DOM.
// Skipped cleanly when jsdom isn't installed (matches e2e.cjs Tier-2 policy).
// =============================================================================
console.log("\n--- jsdom faithful-DOM re-check (optional) ---");
(function jsdomCheck() {
  let JSDOM;
  try {
    JSDOM = require(
      path.join(REPO, "tooling", "wgt-emulate", "node_modules", "jsdom"),
    ).JSDOM;
  } catch (_) {
    try {
      JSDOM = require("jsdom").JSDOM;
    } catch (_2) {
      console.log("SKIP: jsdom not available — fake-DOM assertions above stand.");
      return;
    }
  }
  // Build a minimal head with ONLY the boot-mark + babel-preload IIFEs, with
  // the second-boot localStorage seeded by a pre-script. No external resources,
  // no network — we are checking the real DOM node the shipped IIFE produces.
  const seed =
    "localStorage.setItem('" + K.bootMarksEnabled + "','1');" +
    "localStorage.setItem('" + K.babelNeeded + "','1');";
  const doc =
    "<!DOCTYPE html><html><head>" +
    "<script>" + seed + "</script>" +
    "<script>" + SRC.qaMarks + "</script>" +
    "<script>" + SRC.preload + "</script>" +
    "</head><body></body></html>";
  const dom = new JSDOM(doc, {
    runScripts: "dangerously",
    url: "https://tv.example.net/",
    // jsdom's top-level userAgent option doesn't always reach
    // navigator.userAgent across versions; force it before any script runs so
    // the shell's UA regex classifies this DOM legacy (Chrome/63 < 70).
    beforeParse(win) {
      try {
        Object.defineProperty(win.navigator, "userAgent", {
          value: UA_M63,
          configurable: true,
        });
      } catch (_) {}
    },
  });
  const w = dom.window;
  // Match on rel + the `.as` IDL property (jsdom doesn't reflect `as` to the
  // attribute, so an [as="script"] attribute selector would miss it).
  const link = Array.from(w.document.head.querySelectorAll('link[rel="preload"]')).find(
    (l) => l.as === "script",
  );
  check("jsdom: real <link rel=preload as=script> in head", !!link);
  check(
    "jsdom: href resolves to babel.min.js",
    !!link && /babel\.min\.js$/.test(link.href),
    link && link.href,
  );
  check("jsdom: window.__shellBabelPreload === 1", w.__shellBabelPreload === 1);
  check(
    "jsdom: __qaMarks.tBabelPreloadAppend set",
    w.__qaMarks && w.__qaMarks.tBabelPreloadAppend > 0,
  );
})();

if (failures) {
  console.error("\n" + failures + " CHECK(S) FAILED");
  process.exit(1);
}
console.log("\nALL JEL-40 BABEL-PRELOAD CHECKS PASS");
