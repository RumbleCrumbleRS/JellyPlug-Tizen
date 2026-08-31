/*
 * JELA-707 (JELA-699 follow-up): defer the JellyfinEnhanced injection until
 * after firstCard.
 *
 * JELA-821 flipped the gate to opt-OUT: default ON, disabled only by an
 * explicit localStorage['jellyfin.shell.deferJe']='0'. It shipped opt-in, and
 * the jp773 channel seed of '1' arms ONE BOOT LATE (the JSI channel runs only
 * after the lite->SPA handoff, JELA-802), so every key-absent boot — first
 * install, re-install, localStorage eviction — read null !== '1' and paid the
 * full pre-paint JE module storm (152 modules / 670,857 B in 9/9 valid boots
 * across two rigs; JELA-813/819). B0/B0b/B3 below are the regression pins.
 *
 * THE LEVER. JELA-699 ring A on the calibrated JELA-690 harness measured
 * blocking JE's script injection at firstCard −3,340 ms [−4,589, −2,338],
 * p=0.0024 (−41.7%): JE's ~197-request fan-out contends with the boot's own
 * request burst, and boot latency tracks in-flight REQUEST COUNT. The fix
 * holds rather than kills: stripJeScriptsForDefer removes JE's <script src>
 * tag(s) from the fetched /web/index.html STRING (covering both the JEL-1832
 * string fast path and the DOMParser path), parks the URLs on
 * window.__shellJeDefer, and the seed's paint-gated re-injector appends them
 * back after __shellPaintGate.onPaint plus a settle delay
 * ('jellyfin.shell.deferJeMs', default 3000). Re-injected tags flow through
 * the JEL-406/407 dynamic-script interceptors (transpile + JEL-557 cache).
 *
 * WHAT THIS PINS
 *   PART A — CONTRACT (src + minified sibling): opt-OUT read site pinned by
 *            its exact expression (the file also contains 'deferJeMs' — an
 *            unscoped substring check would pass on the wrong key), delay
 *            knob, diag object, injection marker, ES5-only seed text.
 *   PART B — STRIP (the REAL stripJeScriptsForDefer, lifted from source):
 *     B0. key ABSENT -> JE tags stripped, diag installed (JELA-821).
 *     B0b. key = "0" -> html unchanged, no diag object (kill switch).
 *     B1. flag on -> JE tags (either name shape, any case, defer attr,
 *         entity-escaped query) removed; non-JE tags byte-identical; URLs
 *         captured in document order as raw attribute text.
 *     B2. flag on, no JE tags -> the exact input reference is returned.
 *     B3. a throwing localStorage -> still defers (the kill switch is
 *         unreadable, and unreadable storage is exactly the key-absent case
 *         the fleet default covers; same shape as stripDeadMediaBarJs).
 *     B4. src is the ONLY match surface — a non-JE src with "JellyfinEnhanced"
 *         elsewhere in the tag stays.
 *   PART C — RE-INJECTOR (the shim IIFE lifted from the SHIPPED seed):
 *     C0. no parked URLs -> completely inert (no timers, no listeners).
 *     C1. nothing is injected before onPaint fires, however long we wait;
 *         after paint + default 3000 ms every URL is appended as a
 *         data-shell-je-deferred script with async=false, append-then-src
 *         (JE's own load shape, so the JEL-407 setter interceptor sees it),
 *         and '&amp;' decoded back to '&'.
 *     C2. delay knob honored; out-of-range falls back to 3000.
 *     C3. gate absent -> the 20 s fallback injects.
 *     C4. release + inject are idempotent (double paint, double timer).
 *
 * Run: node scripts/je-defer.test.cjs
 *   or: pnpm --filter @jellyfin-tv/shell-tizen-bootstrap test
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = path.join(__dirname, "..", "src", "boot-shell.src.js");

const MIN = SRC.endsWith("boot-shell.src.js")
  ? SRC.replace(/boot-shell\.src\.js$/, "boot-shell.min.js")
  : SRC.replace(/shell\.js$/, "shell.min.js");

const FLAG = "jellyfin.shell.deferJe";
const DELAY_KEY = "jellyfin.shell.deferJeMs";
const SHIM_ANCHOR = "var J=window.__shellJeDefer;";

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log("OK: " + name);
  } else {
    console.error("FAIL: " + name + (detail ? "  — " + detail : ""));
    failures++;
  }
}

const src = fs.readFileSync(SRC, "utf8");
const min = fs.readFileSync(MIN, "utf8");
const srcLabel = path.basename(SRC);
const minLabel = path.basename(MIN);

function extractTopFn(text, name) {
  const lines = text.split("\n");
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

function buildSeed() {
  const fnSrc = extractTopFn(src, "buildSeedScript").replace(
    /^  function buildSeedScript/,
    "function",
  );
  const sb = { Object, JSON, TX_VER: "testver" };
  vm.createContext(sb);
  const buildSeedScript = vm.runInContext("(" + fnSrc + ")", sb);
  return buildSeedScript("https://tv.example.test", {});
}

const seed = buildSeed();

function extractShim() {
  const anchor = seed.indexOf(SHIM_ANCHOR);
  check(srcLabel + ": built seed contains the re-injector", anchor !== -1);
  if (anchor === -1) return null;
  const start = seed.lastIndexOf("try{(function(){", anchor);
  const endMark = "\n  })();}catch(_){}";
  const end = seed.indexOf(endMark, anchor);
  check(
    srcLabel + ": shim IIFE boundaries resolve",
    start !== -1 && end !== -1 && start < anchor && anchor < end,
  );
  if (start === -1 || end === -1) return null;
  return seed.slice(start, end + endMark.length);
}

const shim = extractShim();

// ===========================================================================
// PART A — CONTRACT
// ===========================================================================
check(
  srcLabel + ": strip runs on the fetched html in loadRemoteWebClient",
  src.includes("stripJeScriptsForDefer(") &&
    /stripJeScriptsForDefer\(\s*rewriteFontThirdPartyCss\(results\[0\], serverUrl\),?\s*\)/.test(
      src,
    ),
);
for (const [label, text] of [
  [srcLabel, src],
  [minLabel, min],
]) {
  // Scope the pin to the READ EXPRESSION, not the key: the bare substring
  // "jellyfin.shell.deferJe" also matches "jellyfin.shell.deferJeMs", so a
  // key-only check cannot tell an armed gate from the delay knob, nor an
  // opt-out read site from the JELA-821 opt-in bug it replaced.
  check(
    label + ': gate is opt-OUT (=== "0"), not opt-in',
    text.includes('getItem("' + FLAG + '")==="0"') ||
      text.includes('getItem("' + FLAG + '") === "0"'),
  );
  check(
    label + ": no opt-in read site remains",
    !text.includes('getItem("' + FLAG + '")!=="1"') &&
      !text.includes('getItem("' + FLAG + '") !== "1"'),
  );
  check(label + ": delay knob survives", text.includes(DELAY_KEY));
  check(label + ": diag object present", text.includes("__shellJeDefer"));
  check(
    label + ": injection marker present",
    text.includes("data-shell-je-deferred"),
  );
}
if (shim) {
  check("shim is ES5 (no arrow functions)", shim.indexOf("=>") === -1);
  check("shim is ES5 (no template literals)", shim.indexOf("`") === -1);
  check("shim has no </script literal", shim.indexOf("</script") === -1);
  check(
    "shim is ES5 (var only)",
    shim.indexOf("const ") === -1 && shim.indexOf("let ") === -1,
  );
  check(
    "shim appends BEFORE setting src (JEL-407 setter shape)",
    shim.indexOf("appendChild(s)") < shim.indexOf("s.src="),
  );
}

// ===========================================================================
// PART B — STRIP
// ===========================================================================
function makeStrip(lsImpl) {
  const fnSrc = extractTopFn(src, "stripJeScriptsForDefer").replace(
    /^  function stripJeScriptsForDefer/,
    "function",
  );
  const win = {};
  const sb = { window: win, localStorage: lsImpl, String };
  vm.createContext(sb);
  const fn = vm.runInContext("(" + fnSrc + ")", sb);
  return { fn, win };
}
function lsWith(map) {
  return {
    getItem: (k) => (k in map ? map[k] : null),
  };
}

const JE_TAG =
  '<script src="/JellyfinEnhanced/script?v=12.4.1.0_6392" defer></script>';
const JE_TAG2 =
  '<script defer src="https://cdn.example/gh/n00bcodr/Jellyfin-Enhanced@main/js/file.js?a=1&amp;b=2"></script>';
const KEEP_TAG = '<script src="/web/main.11111.bundle.js" defer></script>';
const KEEP_INLINE = "<script>var jellyfinenhancedNothing=1;</script>";
const KEEP_DATA =
  '<script src="/web/other.js" data-note="JellyfinEnhanced"></script>';
const HTML =
  "<html><head>" +
  KEEP_TAG +
  JE_TAG +
  KEEP_INLINE +
  JE_TAG2 +
  KEEP_DATA +
  "</head><body></body></html>";

// B0 — key ABSENT: the JELA-821 regression pin. This is the first-install /
// post-eviction boot, which the shipped opt-in gate left un-deferred.
{
  const { fn, win } = makeStrip(lsWith({}));
  const out = fn(HTML);
  const d = win.__shellJeDefer;
  check(
    "B0: key absent -> JE tags stripped (JELA-821)",
    out.indexOf("JellyfinEnhanced/script") === -1 &&
      out.indexOf("Jellyfin-Enhanced@main") === -1,
  );
  check("B0: key absent -> non-JE tags intact", out.indexOf(KEEP_TAG) !== -1);
  check(
    "B0: key absent -> diag proves the arm",
    d && d.on === 1 && d.held === 2,
    d && "on=" + d.on + " held=" + d.held,
  );
}
// B0b — kill switch: an explicit "0" still opts the device out.
{
  const { fn, win } = makeStrip(lsWith({ [FLAG]: "0" }));
  const out = fn(HTML);
  check('B0b: flag "0" -> html untouched', out === HTML);
  check('B0b: flag "0" -> no diag object', !("__shellJeDefer" in win));
}
// B0c — an unrelated value is NOT a kill switch (only "0" disables).
{
  const { fn, win } = makeStrip(lsWith({ [FLAG]: "" }));
  check(
    'B0c: empty value is not "0" -> still defers',
    fn(HTML).indexOf("JellyfinEnhanced/script") === -1 &&
      win.__shellJeDefer &&
      win.__shellJeDefer.held === 2,
  );
}
// B0d — the delay knob must not be mistaken for the gate.
{
  const { fn, win } = makeStrip(lsWith({ [DELAY_KEY]: "0" }));
  check(
    "B0d: deferJeMs=0 does not disable the gate",
    fn(HTML).indexOf("JellyfinEnhanced/script") === -1 &&
      win.__shellJeDefer &&
      win.__shellJeDefer.held === 2,
  );
}
// B1 — flag on, JE tags stripped, everything else intact.
{
  const { fn, win } = makeStrip(lsWith({ [FLAG]: "1" }));
  const out = fn(HTML);
  const d = win.__shellJeDefer;
  check("B1: JE tags removed", out.indexOf("JellyfinEnhanced/script") === -1);
  check(
    "B1: second JE shape removed too",
    out.indexOf("Jellyfin-Enhanced@main") === -1,
  );
  check(
    "B1: non-JE src tag intact",
    out.indexOf(KEEP_TAG) !== -1,
    "bundle tag must survive",
  );
  check("B1: inline script intact", out.indexOf(KEEP_INLINE) !== -1);
  check(
    "B1: src is the only match surface (B4)",
    out.indexOf(KEEP_DATA) !== -1,
    "a non-JE src with JE elsewhere in the tag must stay",
  );
  check("B1: held count", d && d.held === 2, d && "held=" + d.held);
  check(
    "B1: urls captured in order, raw attr text",
    d &&
      d.urls[0] === "/JellyfinEnhanced/script?v=12.4.1.0_6392" &&
      d.urls[1] ===
        "https://cdn.example/gh/n00bcodr/Jellyfin-Enhanced@main/js/file.js?a=1&amp;b=2",
    d && JSON.stringify(d.urls),
  );
}
// B2 — flag on, nothing to strip.
{
  const { fn, win } = makeStrip(lsWith({ [FLAG]: "1" }));
  const plain = "<html><head>" + KEEP_TAG + "</head></html>";
  const out = fn(plain);
  check("B2: no JE tags -> exact input returned", out === plain);
  check(
    "B2: diag reports held=0",
    win.__shellJeDefer && win.__shellJeDefer.held === 0,
  );
}
// B3 — throwing localStorage: the kill switch is unreadable, so the fleet
// default applies and we defer (matches stripDeadMediaBarJs's shape).
{
  const { fn, win } = makeStrip({
    getItem() {
      throw new Error("quota");
    },
  });
  const out = fn(HTML);
  check(
    "B3: throwing localStorage -> still defers",
    out.indexOf("JellyfinEnhanced/script") === -1,
  );
  check("B3: non-JE tags intact", out.indexOf(KEEP_TAG) !== -1);
  check(
    "B3: diag proves the arm",
    win.__shellJeDefer && win.__shellJeDefer.held === 2,
  );
}

// ===========================================================================
// PART C — RE-INJECTOR
// ===========================================================================
function makeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.set(id, { fn, at: now + (ms || 0) });
      return id;
    },
    clear(id) {
      timers.delete(id);
    },
    pending: () => timers.size,
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of timers) {
          if (t.at <= target && (next === null || t.at < next[1].at)) {
            next = [id, t];
          }
        }
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].fn();
      }
      now = target;
    },
  };
}

function makeGate() {
  const cbs = [];
  return {
    fired: 0,
    onPaint(cb) {
      if (this.fired) cb();
      else cbs.push(cb);
    },
    fire() {
      this.fired = 1;
      const run = cbs.slice();
      cbs.length = 0;
      run.forEach((cb) => cb());
    },
  };
}

function makeDoc() {
  const appended = [];
  function el(tag) {
    return {
      tagName: tag,
      attrs: {},
      async: undefined,
      src: undefined,
      setAttribute(n, v) {
        this.attrs[n] = v;
      },
    };
  }
  return {
    appended,
    createElement: (t) => el(t),
    head: {
      appendChild(n) {
        appended.push(n);
        return n;
      },
    },
    documentElement: {
      appendChild(n) {
        appended.push(n);
        return n;
      },
    },
  };
}

function runShim(opts) {
  const clock = makeClock();
  const doc = makeDoc();
  const gate = opts.gate === false ? null : makeGate();
  const win = {
    __shellJeDefer: opts.state,
    __shellPaintGate: gate,
  };
  const sb = {
    window: win,
    localStorage: lsWith(opts.ls || {}),
    document: doc,
    setTimeout: clock.setTimeout.bind(clock),
    clearTimeout: clock.clear.bind(clock),
    parseInt,
    String,
    Date: { now: clock.now },
  };
  vm.createContext(sb);
  vm.runInContext(shim, sb);
  return { clock, doc, gate, win };
}

const state = () => ({
  on: 1,
  held: 2,
  urls: ["/JellyfinEnhanced/script?v=12.4.1.0_6392", "/JE/two.js?a=1&amp;b=2"],
  rel: 0,
  inj: 0,
  tRel: 0,
  tInj: 0,
});

if (shim) {
  // C0 — inert without parked URLs.
  {
    const r = runShim({ state: undefined });
    check("C0: no diag object -> no timers", r.clock.pending() === 0);
    const r2 = runShim({
      state: { on: 1, held: 0, urls: [], rel: 0, inj: 0, tRel: 0, tInj: 0 },
    });
    r2.gate.fire();
    r2.clock.advance(700000);
    check("C0: empty urls -> nothing appended", r2.doc.appended.length === 0);
  }
  // C1 — paint-gated injection at the default delay.
  {
    const r = runShim({ state: state() });
    r.clock.advance(120000);
    check("C1: nothing before paint", r.doc.appended.length === 0);
    r.gate.fire();
    r.clock.advance(2999);
    check("C1: nothing before the settle delay", r.doc.appended.length === 0);
    r.clock.advance(1);
    check("C1: every URL injected", r.doc.appended.length === 2);
    const s0 = r.doc.appended[0];
    const s1 = r.doc.appended[1];
    check(
      "C1: marker + async=false",
      s0.attrs["data-shell-je-deferred"] === "1" && s0.async === false,
    );
    check(
      "C1: src set verbatim, entities decoded",
      s0.src === "/JellyfinEnhanced/script?v=12.4.1.0_6392" &&
        s1.src === "/JE/two.js?a=1&b=2",
      s0.src + " | " + s1.src,
    );
    check(
      "C1: diag updated",
      r.win.__shellJeDefer.rel === 1 && r.win.__shellJeDefer.inj === 2,
    );
  }
  // C2 — delay knob.
  {
    const r = runShim({ state: state(), ls: { [DELAY_KEY]: "0" } });
    r.gate.fire();
    r.clock.advance(0);
    check("C2: delay 0 injects at paint", r.doc.appended.length === 2);
    const r2 = runShim({ state: state(), ls: { [DELAY_KEY]: "600001" } });
    r2.gate.fire();
    r2.clock.advance(2999);
    check("C2: out-of-range knob -> 3000", r2.doc.appended.length === 0);
    r2.clock.advance(1);
    check("C2: ...and injects there", r2.doc.appended.length === 2);
  }
  // C3 — no gate: 20 s fallback.
  {
    const r = runShim({ state: state(), gate: false });
    r.clock.advance(19999);
    check("C3: nothing before 20 s", r.doc.appended.length === 0);
    r.clock.advance(1);
    check("C3: fallback injects at 20 s", r.doc.appended.length === 2);
  }
  // C4 — idempotence.
  {
    const r = runShim({ state: state() });
    r.gate.fire();
    r.gate.fired = 0;
    r.gate.fire();
    r.clock.advance(700000);
    check("C4: double release injects once", r.doc.appended.length === 2);
  }
}

if (failures) {
  console.error("\n" + failures + " je-defer check(s) FAILED");
  process.exit(1);
}
console.log("\nAll je-defer checks passed.");
