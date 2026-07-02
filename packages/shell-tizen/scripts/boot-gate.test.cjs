// JEL-623 verification — defer boot-time pollers/observers until first paint.
//
// The seed's cosmetic sweeps (auto-focus 600ms poll, remember-me 300ms poll,
// YT-iframe cap MutationObserver + 400ms sweep, webpack CM/PM walker) used to
// arm at document.write handoff and tick through the whole 20-40s legacy
// bundle fetch/parse blackout on Chromium 56 with nothing to act on. JEL-623
// introduces window.__shellPaintGate — the ONE timer allowed during the
// blackout (500ms setTimeout chain; pre-boot tick is a single
// `typeof window.ApiClient` property check, no DOM access) — and re-homes the
// sweeps onto its two stages:
//   onApi   — webpack entry completed (ApiClient set): YT-iframe cap sweep
//             (crash guard; plugins cannot build media-bar DOM before app
//             init, so coverage is unchanged).
//   onPaint — first view painted (.card / login form / user picker / quick
//             connect) or 60 post-api ticks (30s): auto-focus poll,
//             remember-me nudge poll, webpack walker kick.
// Absolute backstop: 240 total ticks (120s) fires BOTH stages ("giveup") so
// no feature stays dead on a wedged boot. The passive guards (iframe src
// setter/setAttribute intercepts, keydown focus rescue, creds-guard storage
// tap) stay armed from t0. Every registration site falls back to arming
// immediately when the gate is absent (lets per-feature tests lift their
// IIFEs into bare sandboxes, and is defensive at runtime).
//
// WHAT THIS PINS
//   PART A — CONTRACT (all four shipped artifacts): gate present; src-level
//            registration sites for all four sweeps; self-test force-fire.
//   PART B — GATE EXECUTION (gate IIFE lifted from both src seeds):
//     B1. pre-ApiClient ticks never touch the DOM and fire nothing.
//     B2. ApiClient appearing fires onApi (and only onApi).
//     B3. a painted view (.card) fires onPaint; late subscribers run at once.
//     B4. 60 post-api ticks with no paint fires onPaint ("timeout").
//     B5. 240 total ticks with no ApiClient fires both stages ("giveup").
//     B6. manual fire() (self-test path) fires both stages immediately.
//   PART C — SWEEP DEFERRAL (feature IIFEs lifted from both src seeds, run
//            against a recording fake gate):
//     C1. remember-me: no 300ms interval pre-fire; armed + immediate nudge
//         after onPaint fires.
//     C2. YT-iframe cap (Tizen UA): src intercepts installed at t0, but no
//         MutationObserver.observe and no 400ms interval pre-fire; both armed
//         after onApi fires.
//
// Run: node scripts/boot-gate.test.cjs
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

// ============================================================================
// PART A — CONTRACT
// ============================================================================
// The gate is a window property, so it survives minification in all four
// artifacts. The per-sweep registration identifiers are locals (minified
// away), so those are pinned on the two src files only.
for (const [name, src] of [
  ["shell.js", tvSrc],
  ["shell.min.js", tvMin],
  ["boot-shell.src.js", bootSrc],
  ["boot-shell.min.js", bootMin],
]) {
  check(name + ": paint gate present", src.includes("__shellPaintGate"));
}
for (const [name, src] of [
  ["shell.js", tvSrc],
  ["boot-shell.src.js", bootSrc],
]) {
  check(
    name + ": auto-focus poll registers on onPaint",
    src.includes("pg.onPaint(__armAF)"),
  );
  check(
    name + ": remember-me nudge registers on onPaint",
    src.includes("pg.onPaint(__armRM)"),
  );
  check(
    name + ": YT-iframe cap sweep registers on onApi",
    src.includes("pg.onApi(__armCap)"),
  );
  check(
    name + ": webpack walker kick registers on onPaint",
    src.includes("pg.onPaint(kick)"),
  );
  check(
    name + ": AF self-test force-fires the gate",
    src.includes('window.__shellPaintGate.fire("selftest")'),
  );
  // The blackout-phase tick must stay DOM-free: the ApiClient check has to
  // come before the querySelector paint probe inside the gate poll.
  const gate = extractGateIIFE(src);
  check(name + ": gate IIFE extractable", !!gate);
  if (gate) {
    const apiAt = gate.indexOf('typeof window.ApiClient==="undefined"');
    const domAt = gate.indexOf("document.querySelector(");
    check(
      name + ": gate polls ApiClient before any DOM probe",
      apiAt !== -1 && domAt !== -1 && apiAt < domAt,
      JSON.stringify({ apiAt, domAt }),
    );
  }
}

// ============================================================================
// PART B — GATE EXECUTION
// ============================================================================
function extractGateIIFE(src) {
  const m = src.match(
    /(\(function\(\)\{var g=\{api:0,fired:0[\s\S]*?\}\)\(\);)\}catch\(_\)\{\}/,
  );
  return m ? m[1] : null;
}

// Run the gate with a manual timer queue so ticks are stepped one by one.
function runGate(gateIIFE) {
  const queue = [];
  const win = {};
  const state = { dom: null };
  const sandbox = {
    window: win,
    document: {
      querySelector: () => state.dom,
    },
    setTimeout: (fn, ms) => {
      queue.push({ fn, ms });
      return queue.length;
    },
    Date,
  };
  vm.createContext(sandbox);
  vm.runInContext(gateIIFE, sandbox);
  return {
    win,
    state,
    gate: () => win.__shellPaintGate,
    tick() {
      const t = queue.shift();
      if (t) t.fn();
      return t ? t.ms : null;
    },
    pending: () => queue.length,
  };
}

function execGateScenarios(label, gateIIFE) {
  if (!gateIIFE) {
    check(label + ": gate IIFE present", false);
    return;
  }

  // B1 + B2 + B3: ApiClient then paint.
  {
    const r = runGate(gateIIFE);
    const g = r.gate();
    let api = 0,
      paint = 0;
    g.onApi(() => api++);
    g.onPaint(() => paint++);
    for (let i = 0; i < 10; i++) r.tick(); // no ApiClient yet
    check(
      label + " B1: nothing fires before ApiClient",
      api === 0 && paint === 0,
    );
    check(label + " B1: gate keeps polling (500ms chain)", r.pending() === 1);
    r.win.ApiClient = {};
    r.tick();
    check(label + " B2: onApi fires when ApiClient appears", api === 1);
    check(
      label + " B2: onPaint does NOT fire without a painted view",
      paint === 0,
    );
    r.state.dom = { tag: "card" };
    r.tick();
    check(label + " B3: onPaint fires on first painted view", paint === 1);
    check(label + ' B3: fire reason recorded as "paint"', g.why === "paint");
    check(label + " B3: poll chain stops after fire", r.pending() === 0);
    let late = 0;
    g.onPaint(() => late++);
    g.onApi(() => late++);
    check(label + " B3: late subscribers run immediately", late === 2);
  }

  // B4: ApiClient but nothing ever paints → 60-tick (30s) paint fallback.
  {
    const r = runGate(gateIIFE);
    const g = r.gate();
    let paint = 0;
    g.onPaint(() => paint++);
    r.win.ApiClient = {};
    for (let i = 0; i < 59 && r.pending(); i++) r.tick();
    check(
      label + " B4: still waiting one tick before the 30s fallback",
      paint === 0,
    );
    r.tick();
    check(
      label + ' B4: paint fallback fires after 60 post-api ticks ("timeout")',
      paint === 1 && g.why === "timeout",
      JSON.stringify({ paint, why: g.why }),
    );
  }

  // B5: ApiClient never appears → 240-tick (120s) giveup fires both stages.
  {
    const r = runGate(gateIIFE);
    const g = r.gate();
    let api = 0,
      paint = 0;
    g.onApi(() => api++);
    g.onPaint(() => paint++);
    for (let i = 0; i < 240 && r.pending(); i++) r.tick();
    check(
      label + ' B5: 240-tick giveup fires BOTH stages ("giveup")',
      api === 1 && paint === 1 && g.why === "giveup",
      JSON.stringify({ api, paint, why: g.why }),
    );
  }

  // B6: manual fire() — the AF self-test path — fires both stages at once.
  {
    const r = runGate(gateIIFE);
    const g = r.gate();
    let api = 0,
      paint = 0;
    g.onApi(() => api++);
    g.onPaint(() => paint++);
    g.fire("selftest");
    check(
      label + " B6: manual fire() fires both stages immediately",
      api === 1 && paint === 1 && g.why === "selftest",
    );
  }
}

execGateScenarios("shell.js", extractGateIIFE(tvSrc));
execGateScenarios("boot-shell.src.js", extractGateIIFE(bootSrc));

// ============================================================================
// PART C — SWEEP DEFERRAL (feature IIFEs against a recording fake gate)
// ============================================================================
function fakeGate() {
  const g = {
    apiCbs: [],
    paintCbs: [],
    onApi(cb) {
      g.apiCbs.push(cb);
    },
    onPaint(cb) {
      g.paintCbs.push(cb);
    },
    fireApi() {
      g.apiCbs.splice(0).forEach((cb) => cb());
    },
    firePaint() {
      g.paintCbs.splice(0).forEach((cb) => cb());
    },
  };
  return g;
}

// C1. remember-me nudge (same extraction as remember-me-default.test.cjs).
function extractNudgeIIFE(src) {
  const m = src.match(
    /(\(function\(\)\{if\(localStorage\.getItem\("jellyfin\.shell\.rememberMeDefaultDisabled"\)[\s\S]*?\}\)\(\);)\}catch\(_\)\{\}/,
  );
  return m ? m[1] : null;
}

function execRememberMe(label, iife) {
  if (!iife) {
    check(label + " C1: nudge IIFE present", false);
    return;
  }
  const g = fakeGate();
  const intervals = [];
  const box = {
    checked: false,
    listeners: [],
    addEventListener(t, fn) {
      this.listeners.push(fn);
    },
  };
  const sandbox = {
    window: { __shellPaintGate: g },
    localStorage: { getItem: () => null },
    document: {
      querySelector: (sel) => (sel === ".chkRememberLogin" ? box : null),
      addEventListener() {},
    },
    setInterval: (fn, ms) => {
      intervals.push(ms);
      return intervals.length;
    },
    WeakSet,
  };
  vm.createContext(sandbox);
  vm.runInContext(iife, sandbox);
  check(
    label + " C1: no 300ms nudge interval before paint",
    intervals.length === 0 && box.checked === false,
    JSON.stringify({ intervals, checked: box.checked }),
  );
  g.firePaint();
  check(
    label + " C1: paint fires immediate nudge + arms 300ms interval",
    intervals.indexOf(300) !== -1 && box.checked === true,
    JSON.stringify({ intervals, checked: box.checked }),
  );
}

execRememberMe("shell.js", extractNudgeIIFE(tvSrc));
execRememberMe("boot-shell.src.js", extractNudgeIIFE(bootSrc));

// C2. YT-iframe cap (same extraction as mediabar-crashguard.test.cjs).
function extractGuardIIFE(src) {
  const m = src.match(
    /(\(function\(\)\{if\(localStorage\.getItem\("jellyfin\.shell\.ytIframeCapDisabled"\)[\s\S]*?\}\)\(\);)\}catch\(_\)\{\}/,
  );
  return m ? m[1] : null;
}

function execYtCap(label, iife) {
  if (!iife) {
    check(label + " C2: guard IIFE present", false);
    return;
  }
  const g = fakeGate();
  const intervals = [];
  const observed = [];
  let srcSetterInstalled = false;
  function Iframe() {}
  Object.defineProperty(Iframe.prototype, "src", {
    configurable: true,
    enumerable: true,
    get() {
      return this._src;
    },
    set(v) {
      this._src = v;
    },
  });
  Iframe.prototype.setAttribute = function () {};
  const realDefine = Object.defineProperty.bind(Object);
  const sandbox = {
    window: { __shellPaintGate: g },
    localStorage: { getItem: () => null },
    navigator: { userAgent: "Tizen 6.5 Chrome/85" },
    document: {
      documentElement: {},
      getElementsByTagName: () => [],
    },
    HTMLIFrameElement: Iframe,
    Object,
    MutationObserver: function (cb) {
      this.observe = (target, opts) => observed.push(opts);
    },
    setInterval: (fn, ms) => {
      intervals.push(ms);
      return intervals.length;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(iife, sandbox);
  // passive intercepts are armed at t0 — the src setter must already blank
  // youtube URLs before any gate stage fires.
  const probe = new Iframe();
  probe.src = "https://www.youtube.com/embed/xyz";
  srcSetterInstalled = probe._src === "about:blank";
  check(
    label + " C2: src setter intercept armed at t0 (pre-gate)",
    srcSetterInstalled,
    JSON.stringify({ got: probe._src }),
  );
  check(
    label + " C2: no MutationObserver / 400ms sweep before onApi",
    observed.length === 0 && intervals.length === 0,
    JSON.stringify({ observed, intervals }),
  );
  g.fireApi();
  check(
    label + " C2: onApi arms whole-tree observer + 400ms sweep",
    observed.length === 1 &&
      observed[0].subtree === true &&
      intervals.indexOf(400) !== -1,
    JSON.stringify({ observed, intervals }),
  );
}

execYtCap("shell.js", extractGuardIIFE(tvSrc));
execYtCap("boot-shell.src.js", extractGuardIIFE(bootSrc));

if (failures) {
  console.error("\n" + failures + " FAILURE(S)");
  process.exit(1);
}
console.log("\nALL OK");
