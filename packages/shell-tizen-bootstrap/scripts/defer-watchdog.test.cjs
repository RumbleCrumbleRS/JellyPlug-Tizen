/*
 * JEL-99: defer-script watchdog must NOT re-inject on a healthy-but-slow cold
 * boot.
 *
 * Repro of the field bug (Tizen 5.0 / Chromium 63): after
 * document.open/write/close into the already-"complete" bootstrap document the
 * panel reports document.readyState === "complete" almost immediately (measured
 * 638 ms) while the freshly written <script defer> bundles are still healthy and
 * pending — ApiClient did not install until 6097 ms. The old watchdog treated
 * readyState === "complete" + webpack-undefined as a definitive "defers hung"
 * signal, re-injected all 28 scripts at 638 ms, and the real defers then ALSO
 * ran, double-running the webpack runtime and wedging the SPA forever.
 *
 * This test extracts the SHIPPED armDeferWatchdog() out of boot-shell.src.js and
 * drives it through a virtual clock so the regression is pinned without a TV.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const SRC = path.join(__dirname, "..", "src", "boot-shell.src.js");
const text = fs.readFileSync(SRC, "utf8");

// ---- extract `function armDeferWatchdog() { ... }` by brace matching --------
function extractFn(name) {
  const marker = "function " + name + "()";
  const start = text.indexOf(marker);
  assert(start !== -1, "could not find " + marker + " in boot-shell.src.js");
  let i = text.indexOf("{", start);
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    const c = text[j];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, j + 1);
    }
  }
  throw new Error("unbalanced braces extracting " + name);
}
const fnSrc = extractFn("armDeferWatchdog");

// ---- discrete-event simulator ----------------------------------------------
// One run = a fresh window/document, a virtual clock, a list of timers, and a
// list of "world events" (e.g. ApiClient installs at t=6000) that fire in clock
// order interleaved with the watchdog's own setTimeout polls.
function runScenario(opts) {
  let now = 0;
  const timers = []; // {at, cb}
  const events = (opts.events || []).slice().sort((a, b) => a.at - b.at);

  const win = {};
  const head = { children: [] };

  function makeDefer(src) {
    const node = {
      _src: src,
      _removed: false,
      getAttribute(k) {
        if (k === "src") return this._src;
        return null;
      },
      setAttribute() {},
    };
    node.parentNode = {
      removeChild(child) {
        child._removed = true;
        const k = head.children.indexOf(child);
        if (k !== -1) head.children.splice(k, 1);
      },
    };
    return node;
  }

  // original defer bundles written by document.write()
  const originals = [];
  for (let i = 0; i < opts.deferCount; i++) {
    const n = makeDefer("bundle-" + i + ".js");
    originals.push(n);
    head.children.push(n);
  }
  const injected = []; // watchdog-created scripts

  const doc = {
    get readyState() {
      return opts.readyState ? opts.readyState(now) : "complete";
    },
    querySelectorAll(sel) {
      assert.strictEqual(sel, "script[defer][src]");
      return originals.filter((n) => !n._removed);
    },
    createElement() {
      const s = { setAttribute() {} };
      return s;
    },
    head: {
      appendChild(s) {
        injected.push(s);
      },
    },
  };

  const fakeConsole = { warn() {}, log() {} };
  const Clock = { now: () => now };

  const setTimeout = (cb, delay) => {
    timers.push({ at: now + Math.max(0, delay | 0), cb });
  };

  // build the watchdog with our mocked globals in scope
  const factory = new Function(
    "window",
    "document",
    "console",
    "Date",
    "setTimeout",
    fnSrc + "\nreturn armDeferWatchdog;",
  );
  const armDeferWatchdog = factory(win, doc, fakeConsole, Clock, setTimeout);
  armDeferWatchdog();

  // drive the clock until both queues drain (or a hard ceiling)
  const CEIL = 120000;
  for (let guard = 0; guard < 100000; guard++) {
    const nextTimer = timers.length
      ? Math.min(...timers.map((t) => t.at))
      : Infinity;
    const nextEvent = events.length ? events[0].at : Infinity;
    const next = Math.min(nextTimer, nextEvent);
    if (next === Infinity || next > CEIL) break;
    now = next;
    if (nextEvent <= nextTimer) {
      events.shift().fn(win);
    } else {
      const idx = timers.findIndex((t) => t.at === nextTimer);
      const t = timers.splice(idx, 1)[0];
      t.cb();
    }
  }

  return {
    win,
    injected,
    originals,
    fired: win.__shellDeferWatchdogFired,
    reason: win.__shellDeferWatchdogReason,
    atMs: win.__shellDeferWatchdogAtMs,
  };
}

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log("ok  - " + name);
  } catch (e) {
    failures++;
    console.error("FAIL - " + name + "\n      " + (e && e.message));
  }
}

// 1) THE JEL-99 REGRESSION: healthy-but-slow boot. readyState is "complete"
//    from t=0 (the M63 document.write quirk) but the real defers install
//    __webpack_require__ at 4000 ms and ApiClient at 6097 ms. The watchdog must
//    NOT re-inject.
check("healthy-slow boot does not re-inject (readyState complete @0)", () => {
  const r = runScenario({
    deferCount: 28,
    readyState: () => "complete",
    events: [
      { at: 4000, fn: (w) => (w.__webpack_require__ = function () {}) },
      { at: 6097, fn: (w) => (w.ApiClient = {}) },
    ],
  });
  assert.strictEqual(
    r.fired,
    undefined,
    "watchdog re-injected on a healthy boot (regression); reason=" + r.reason,
  );
  assert.strictEqual(r.injected.length, 0, "no scripts should be re-injected");
  assert.ok(
    r.originals.every((n) => !n._removed),
    "healthy boot must not remove the original defer nodes",
  );
});

// 2) Even slower healthy boot, just under the 20s cap, still must not fire.
check("healthy boot at 15s (under cap) does not re-inject", () => {
  const r = runScenario({
    deferCount: 28,
    readyState: () => "complete",
    events: [
      { at: 15000, fn: (w) => (w.__webpack_require__ = function () {}) },
    ],
  });
  assert.strictEqual(r.fired, undefined, "fired on a <cap healthy boot");
});

// 3) GENUINE HANG: nothing ever installs. Watchdog must rescue exactly once at
//    the cap, re-inject every bundle, and neutralize the originals so they can
//    never double-run.
check("true hang re-injects once at the cap and removes originals", () => {
  const r = runScenario({
    deferCount: 28,
    readyState: () => "complete",
    events: [],
  });
  assert.strictEqual(r.fired, 28, "should report 28 re-injected");
  assert.strictEqual(r.injected.length, 28, "should re-inject all 28 bundles");
  assert.ok(
    /^cap@/.test(r.reason || ""),
    "reason must be cap@…, got " + r.reason,
  );
  assert.ok(
    r.atMs >= 20000,
    "must wait the full cap (>=20000ms), got " + r.atMs,
  );
  assert.ok(
    r.originals.every((n) => n._removed),
    "all original defer nodes must be removed before re-inject",
  );
});

// 4) Fast healthy boot (webpack at 2s) — classic no-op, no re-inject.
check("fast healthy boot is a no-op", () => {
  const r = runScenario({
    deferCount: 28,
    readyState: () => "complete",
    events: [{ at: 2000, fn: (w) => (w.__webpack_require__ = function () {}) }],
  });
  assert.strictEqual(r.fired, undefined);
  assert.strictEqual(r.injected.length, 0);
});

// 5) JEL-631 (JEL-137-era guard): registerElement already ran but ApiClient /
//    __webpack_require__ never install before the cap (slow boot where the
//    bundle executed but the late globals are still pending). Re-injecting
//    would double-run the webpack runtime (black login page) — alreadyRan()
//    must suppress the rescue entirely.
check("registerElement-ran boot never re-injects (alreadyRan guard)", () => {
  const r = runScenario({
    deferCount: 28,
    readyState: () => "complete",
    events: [{ at: 1000, fn: (w) => (w.__shellRegElCalls = 3) }],
  });
  assert.strictEqual(
    r.fired,
    undefined,
    "watchdog re-injected despite registerElement having run; reason=" +
      r.reason,
  );
  assert.strictEqual(r.injected.length, 0, "no scripts may be re-injected");
  assert.ok(
    r.originals.every((n) => !n._removed),
    "original defer nodes must be left alone when the bundle already ran",
  );
});

// 6) Regression guard on the SOURCE itself: the bogus readyState trigger must be
//    gone and the cap raised to 20000.
check("source no longer fires on readyState-complete and cap is 20000", () => {
  assert.ok(
    !/readyState-complete@/.test(fnSrc),
    "the readyState-complete re-inject trigger must be removed",
  );
  assert.ok(/CAP = 20000/.test(fnSrc), "CAP must be raised to 20000");
});

if (failures) {
  console.error("\n" + failures + " check(s) failed");
  process.exit(1);
}
console.log("\nall defer-watchdog checks passed");
