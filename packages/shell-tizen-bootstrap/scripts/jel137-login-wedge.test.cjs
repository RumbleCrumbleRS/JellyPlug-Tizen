/*
 * JEL-137: black login page — two shell mechanisms corrupted the webpack
 * module graph on slow (cold-cache / Babel-storm) boots:
 *
 *   1. __shellWalkWebpack force-required keyword-matching modules (the
 *      ServerConnections module matches "currentApiClient") the moment the
 *      webpack runtime existed. Mid-bundle-sequence the require throws on a
 *      missing cross-bundle dep, the walker swallows it, and webpack's module
 *      cache keeps the half-evaluated module FOREVER — the login route's
 *      tF getter then dies with "Cannot read property 'A' of undefined"
 *      (on-device <anonymous>:2:332410) and the page stays black.
 *      Fix: the walker must wait for window.ApiClient (set by the webpack
 *      entry) before requiring anything — the CM/PM/PluginManager instances
 *      it hunts only exist after the entry anyway.
 *
 *   2. armDeferWatchdog's 20 s cap re-injected ALL <script defer> bundles on
 *      boots whose defer sequence was executing but slow (ApiClient /
 *      registerElement only appear near the END of the sequence). That
 *      re-runs already-run bundles: two webpack runtimes, two module caches,
 *      route chunks bound to stale half-evaluated modules. Fix: the
 *      existence of window.webpackChunk proves at least one bundle executed
 *      (every bundle starts with `(self.webpackChunk=self.webpackChunk||[])
 *      .push(...)`) — never re-inject then.
 *
 *   3. The needsTx/MODERN_SYNTAX_RE private-field alternation
 *      `(^|[^\w])#[a-zA-Z_$]` false-positived on CSS selectors and hex
 *      colors inside plugin template literals (`#custom-rows-wrapper`,
 *      `#e50914`), permanently re-arming jellyfin.shell.legacy.babelNeeded
 *      and inflating every boot with the Babel pipeline — the very slowness
 *      that triggers 1+2. Fix: require `=` or `(` after the identifier
 *      (field init / method / access-assignment), which CSS never produces.
 *
 * All three are pinned for BOTH deployed copies (boot-shell.src.js and
 * shell.js).
 */
"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const BOOT_SRC = path.join(__dirname, "..", "src", "boot-shell.src.js");
const SHELL_SRC = path.join(
  __dirname,
  "..",
  "..",
  "shell-tizen",
  "src",
  "shell.js",
);

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

// ---- helpers ----------------------------------------------------------------

// Join the string-literal members of a seed line array between two marker
// lines (inclusive), skipping // comment lines, exactly like the source's
// .join("\n").
function extractSeedBlock(file, startMarker, endMarker) {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (start === -1 && lines[i].indexOf(startMarker) !== -1) start = i;
    if (start !== -1 && lines[i].indexOf(endMarker) !== -1) {
      end = i;
      break;
    }
  }
  assert(start !== -1, "start marker not found in " + file);
  assert(end !== -1, "end marker not found in " + file);
  const out = [];
  for (let i = start; i <= end; i++) {
    const m = /^\s*(["'])([\s\S]*)\1,?\s*$/.exec(lines[i].trimEnd());
    if (!m) continue; // comment or non-literal line
    // Re-evaluate the literal with its original quote to unescape.
    out.push(new Function("return " + m[1] + m[2] + m[1] + ";")());
  }
  return out.join("\n");
}

function extractFn(file, name) {
  const text = fs.readFileSync(file, "utf8");
  const marker = "function " + name + "()";
  const start = text.indexOf(marker);
  assert(start !== -1, "could not find " + marker + " in " + file);
  const i = text.indexOf("{", start);
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

// ---- 1) walker must not require modules before ApiClient ---------------------

function runWalker(file, opts) {
  const block = extractSeedBlock(
    file,
    "function __shellWalkWebpack(){",
    "setTimeout(__shellWalkWebpack,200);",
  );
  const win = opts.win || {};
  win.__shellCMTries = win.__shellCMTries || 0;
  const timers = [];
  const pushes = [];
  if (opts.withRuntime) {
    const chunks = [];
    chunks.push = function (entry) {
      pushes.push(entry);
      // webpack runtime invokes the runtime callback synchronously
      if (entry && typeof entry[2] === "function") entry[2](opts.wr);
      return Array.prototype.push.call(this, entry);
    };
    win.webpackChunk = chunks;
  }
  const sandbox = new Function(
    "window",
    "setTimeout",
    "Date",
    // stub the scanners the walker calls — the gate under test runs first
    "function __shellScanModule(){return 0;}\n" +
      "function __shellScanExports(){return 0;}\n" +
      block +
      "\nreturn __shellWalkWebpack;",
  );
  const walk = sandbox(win, (cb, ms) => timers.push({ cb, ms }), {
    now: () => 12345,
  });
  // evaluating the block runs its own trailing `setTimeout(...,200)` arm —
  // drop it so assertions only see timers created by the explicit call.
  timers.length = 0;
  walk();
  return { win, timers, pushes };
}

for (const [label, file] of [
  ["boot-shell", BOOT_SRC],
  ["shell.js", SHELL_SRC],
]) {
  check(label + ": walker does NOT touch webpack before ApiClient", () => {
    const r = runWalker(file, { withRuntime: true, wr: { m: {} } });
    assert.strictEqual(
      r.pushes.length,
      0,
      "walker pushed a probe chunk before ApiClient existed",
    );
    assert.ok(r.timers.length === 1, "walker must re-arm a retry timer");
  });

  check(label + ": walker scans once ApiClient exists", () => {
    const r = runWalker(file, {
      withRuntime: true,
      wr: { m: {} },
      win: { ApiClient: {} },
    });
    assert.strictEqual(
      r.pushes.length,
      1,
      "walker should push exactly one probe chunk once ApiClient exists",
    );
  });
}

// ---- 2) watchdog must not re-inject a partially-executed sequence ------------

function runWatchdog(file, opts) {
  const fnSrc = extractFn(file, "armDeferWatchdog");
  let now = 0;
  const timers = [];
  const events = (opts.events || []).slice().sort((a, b) => a.at - b.at);
  const win = {};
  const injected = [];
  const originals = [];
  for (let i = 0; i < (opts.deferCount || 4); i++) {
    const node = {
      _removed: false,
      getAttribute(k) {
        return k === "src" ? "bundle-" + i + ".js" : null;
      },
      setAttribute() {},
      parentNode: {
        removeChild(child) {
          child._removed = true;
        },
      },
    };
    originals.push(node);
  }
  const doc = {
    readyState: "complete",
    querySelectorAll() {
      return originals.filter((n) => !n._removed);
    },
    createElement() {
      return { setAttribute() {} };
    },
    head: {
      appendChild(s) {
        injected.push(s);
      },
    },
  };
  const factory = new Function(
    "window",
    "document",
    "console",
    "Date",
    "setTimeout",
    fnSrc + "\nreturn armDeferWatchdog;",
  );
  const arm = factory(
    win,
    doc,
    { warn() {}, log() {} },
    { now: () => now },
    (cb, delay) => timers.push({ at: now + Math.max(0, delay | 0), cb }),
  );
  arm();
  for (let guard = 0; guard < 100000; guard++) {
    const nextTimer = timers.length
      ? Math.min(...timers.map((t) => t.at))
      : Infinity;
    const nextEvent = events.length ? events[0].at : Infinity;
    const next = Math.min(nextTimer, nextEvent);
    if (next === Infinity || next > 120000) break;
    now = next;
    if (nextEvent <= nextTimer) {
      events.shift().fn(win);
    } else {
      const idx = timers.findIndex((t) => t.at === nextTimer);
      timers.splice(idx, 1)[0].cb();
    }
  }
  return { win, injected, originals };
}

for (const [label, file] of [
  ["boot-shell", BOOT_SRC],
  ["shell.js", SHELL_SRC],
]) {
  check(
    label +
      ": watchdog skips re-inject when webpackChunk exists (slow boot, no ApiClient by cap)",
    () => {
      const r = runWatchdog(file, {
        deferCount: 6,
        events: [{ at: 3000, fn: (w) => (w.webpackChunk = [[["x"], {}]]) }],
      });
      assert.strictEqual(
        r.injected.length,
        0,
        "must not re-inject once any bundle executed",
      );
      assert.ok(
        r.originals.every((n) => !n._removed),
        "originals must be left alone",
      );
      assert.strictEqual(
        r.win.__shellDeferWatchdogSkipReason,
        "webpackChunkExists",
      );
    },
  );

  check(label + ": watchdog still rescues a true wedge (no bundle ran)", () => {
    const r = runWatchdog(file, { deferCount: 6, events: [] });
    assert.strictEqual(
      r.injected.length,
      6,
      "true wedge must still re-inject all defers",
    );
  });
}

// ---- 3) modern-syntax detector: CSS/hex strings must not arm Babel -----------

function getRegexes(file) {
  const text = fs.readFileSync(file, "utf8");
  // top-level MODERN_SYNTAX_RE_SRC string literal (the precise post-transpile
  // ORACLE).
  const m = /MODERN_SYNTAX_RE_SRC\s*=\s*\n?\s*"((?:[^"\\]|\\.)*)"/.exec(text);
  assert(m, "MODERN_SYNTAX_RE_SRC not found in " + file);
  const top = new RegExp(new Function('return "' + m[1] + '";')());
  // JEL-417: top-level MODERN_PRECHECK_RE_SRC = oracle + interior-spread alt.
  const pm =
    /MODERN_PRECHECK_RE_SRC\s*=\s*MODERN_SYNTAX_RE_SRC\s*\+\s*"((?:[^"\\]|\\.)*)"/.exec(
      text,
    );
  assert(pm, "MODERN_PRECHECK_RE_SRC not found in " + file);
  const suffix = new Function('return "' + pm[1] + '";')();
  const precheck = new RegExp(top.source + suffix);
  // seed copy (this is the PRE-check, so it carries the broader precheck src)
  const s = /var __modernRe=\/((?:[^/\\]|\\.)*)\//.exec(
    extractSeedBlock(file, "var __modernRe=", "var __modernRe="),
  );
  assert(s, "__modernRe literal not found in " + file);
  const seed = new RegExp(s[1]);
  return { top, precheck, seed };
}

const NOT_MODERN = [
  "s.textContent=`\\n#custom-rows-wrapper,\\n.srow-section{\\noverflow:hidden}`;",
  "const css = `:root { --ns-red: #e50914; --ns-upgrade: #2196F3 }`;",
  'document.querySelector("#txtManualName").focus();',
  'location.hash = "#anchor";',
  "var color = '#e50914';",
];
const MODERN = [
  "class A{#x=1}",
  "class B{#m(){return 1}}",
  "this.#count = 2;",
  "a?.b",
  "x ?? y",
  "n ||= 1",
  "try{f()}catch{g()}",
];

for (const [label, file] of [
  ["boot-shell", BOOT_SRC],
  ["shell.js", SHELL_SRC],
]) {
  check(label + ": detector ignores CSS selectors / hex colors", () => {
    const { top, seed } = getRegexes(file);
    for (const sample of NOT_MODERN) {
      assert.ok(!top.test(sample), "top regex false positive on: " + sample);
      assert.ok(!seed.test(sample), "seed regex false positive on: " + sample);
    }
  });
  check(label + ": detector still catches real modern syntax", () => {
    const { top, seed } = getRegexes(file);
    for (const sample of MODERN) {
      assert.ok(top.test(sample), "top regex missed: " + sample);
      assert.ok(seed.test(sample), "seed regex missed: " + sample);
    }
  });
  // JEL-417: the seed __modernRe is a PRE-check (gates needsTx -> transpile),
  // so it carries the broader MODERN_PRECHECK_RE_SRC, NOT the precise top-level
  // oracle. The seed source must equal the top-level precheck (oracle + the
  // interior-object-spread alternative), and must catch interior spread that
  // the precise oracle deliberately misses.
  check(
    label + ": seed detector equals the top-level PRE-check (not oracle)",
    () => {
      const { precheck, seed } = getRegexes(file);
      assert.strictEqual(seed.source, precheck.source);
    },
  );
  check(label + ": seed PRE-check catches interior object spread", () => {
    const { top, seed } = getRegexes(file);
    const interior = "var o={a:1, ...b, c:2};";
    assert.ok(seed.test(interior), "seed missed interior spread");
    assert.ok(!top.test(interior), "oracle should NOT match interior spread");
  });
}

if (failures) {
  console.error("\n" + failures + " check(s) failed");
  process.exit(1);
}
console.log("\nall JEL-137 login-wedge checks passed");
