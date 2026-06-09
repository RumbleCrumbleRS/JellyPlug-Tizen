// JEL-75 verification — jQuery-dependent plugin deferred execution (TV vs browser).
//
// Goal: prove that when an installed server plugin references `$`/`jQuery` in
// its inlined body, (1) the shell's needsJq() detection fires, (2) the wrapJq()
// wrapper defers execution until window.jQuery is defined, and (3) the plugin
// still executes within the 10-second jQuery-wait timeout in BOTH environments.
//
// WHY "TV vs browser" IS A TIMING STORY, NOT A CODE-BRANCH STORY
//   The detection regex and the deferral wrapper are byte-identical regardless
//   of platform — there is no `tizen` branch anywhere in the gate. What differs
//   is the *timing of window.jQuery*:
//
//     • Browser (jellyfin-web served normally): jQuery loads as an ordinary
//       <script src> in source order, so by the time a plugin body runs
//       window.jQuery is already present. The wrapper's fast path
//       (`if(typeof window.jQuery!=="undefined"){__run();return;}`) executes the
//       plugin SYNCHRONOUSLY at t=0 — zero deferral, exact browser parity.
//
//     • TV (Tizen 5.0 / Chromium 56, inside our shell): the shell XHR-fetches a
//       plugin's <script src> and re-inlines the body via textContent (JEL-405/
//       407), which loses the async-load ordering. The jQuery bundle
//       (node_modules.jquery.bundle.js) is deliberately NOT transpiled, so it
//       stays a normal <script src> and may not have finished evaluating when
//       the inlined plugin body runs. Without the gate that is a hard
//       `ReferenceError: $ is not defined` at parse time. The wrapper bridges
//       the gap: it polls every 20 ms and runs the plugin the instant
//       window.jQuery appears — in practice a few hundred ms, far under the
//       10 s ceiling. If jQuery never appears, a 10 s setTimeout runs the body
//       anyway (with a console.warn) so the plugin is never silently dropped.
//
//   So the comparison reduces to: same detector, same wrapper, same 10 s bound;
//   the browser hits the synchronous fast path and the TV hits the poller —
//   both end with the plugin executed, the TV always within 10 s.
//
// TWO GATE IMPLEMENTATIONS, ONE CONTRACT
//   The gate exists twice in each shell:
//     • static  — needsJQueryGate()/wrapForJQuery(): real JS, used by
//       transpileLegacyScripts() at the HTML-rewrite stage (fast path + babel).
//     • dynamic — needsJq()/wrapJq(): emitted as an injected string, used by the
//       runtime DOM-mutation interceptors rewrite() and srcPipeline().
//   Both must use the same regex and the same 10 s wrapper, in all four shipped
//   artifacts (shell.js, shell.min.js, boot-shell.src.js, boot-shell.min.js),
//   or a plugin could be gated on one code path and crash on another.
//
// This test executes the ACTUAL shipped wrapper (extracted from shell.js) under
// a virtual clock — no real waiting, no network. It exits non-zero on any drift.
//
// Run: node scripts/jquery-gate.test.cjs
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

const JQ_TIMEOUT_MS = 10000; // the contract: plugin runs within 10 s on TV
const POLL_MS = 20; // window.jQuery poll cadence

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
// PART A — CONTRACT (source pins; failures exit non-zero)
// ============================================================================

// A1. Both gate implementations are present in shell.js.
check(
  "static gate needsJQueryGate() defined in shell.js",
  /function needsJQueryGate\(/.test(tvSrc),
);
check(
  "static gate wrapForJQuery() defined in shell.js",
  /function wrapForJQuery\(/.test(tvSrc),
);
check(
  "dynamic gate needsJq() defined in shell.js (injected string)",
  /function needsJq\(code\)\{return __jqRe\.test\(code\);\}/.test(tvSrc),
);
check(
  "dynamic gate wrapJq() defined in shell.js (injected string)",
  /function wrapJq\(code\)\{/.test(tvSrc),
);

// A2. The detection regex is identical between the static and dynamic gates.
//     Static form:  /\bjQuery\b|(?:^|[^A-Za-z0-9_$.])\$\s*\(/
//     Dynamic form (escaped for the JS string literal):
//                   \\bjQuery\\b|(?:^|[^A-Za-z0-9_$.])\\$\\s*\\(
const STATIC_RE = "/\\bjQuery\\b|(?:^|[^A-Za-z0-9_$.])\\$\\s*\\(/";
const DYNAMIC_RE = "\\\\bjQuery\\\\b|(?:^|[^A-Za-z0-9_$.])\\\\$\\\\s*\\\\(";
check(
  "static gate uses the JQUERY_REF_RE literal in shell.js",
  tvSrc.includes("JQUERY_REF_RE = " + STATIC_RE),
);
check(
  "dynamic gate uses the same regex (escaped) in shell.js",
  tvSrc.includes("__jqRe=/" + DYNAMIC_RE + "/"),
);

// A3. The 10 s timeout and 20 ms poll cadence appear in both gates.
check(
  "static wrapForJQuery() has the " + JQ_TIMEOUT_MS + "ms timeout",
  new RegExp(
    "setTimeout\\(function\\(\\)\\{clearInterval\\(__t\\);[^]*?\\}," +
      JQ_TIMEOUT_MS +
      "\\)",
  ).test(tvSrc),
);
check(
  "static wrapForJQuery() polls every " + POLL_MS + "ms",
  /setInterval\(function\(\)\{/.test(tvSrc) && tvSrc.includes("},20);"),
);
// The dynamic wrapJq() lives inside an injected string literal, so its console
// text is double-escaped; match on the wrapJq function bytes + the 10 s bound.
{
  const wjStart = tvSrc.indexOf("function wrapJq(code){");
  const wjSlice = wjStart === -1 ? "" : tvSrc.slice(wjStart, wjStart + 1200);
  check(
    "dynamic wrapJq() has the " + JQ_TIMEOUT_MS + "ms timeout + wait warning",
    wjSlice.includes("}," + JQ_TIMEOUT_MS + ");") &&
      wjSlice.includes("jQuery wait timed out, running anyway"),
  );
}

// A4. The gate is actually WIRED IN on every inline path (not just defined).
//     Static: transpileLegacyScripts() fast path + babel path.
check(
  "static gate wired into fast path (needsJQueryGate(code)->wrapForJQuery(code))",
  /needsJQueryGate\(code\)[^]*?wrapForJQuery\(code\)/.test(tvSrc),
);
check(
  "static gate wired into babel path (needsJQueryGate(out)->wrapForJQuery(out))",
  /needsJQueryGate\(out\)[^]*?wrapForJQuery\(out\)/.test(tvSrc),
);
//     Dynamic: rewrite() and srcPipeline() both gate the transpiled body.
const dynWires = (tvSrc.match(/var gated=needsJq\(out\);/g) || []).length;
check(
  "dynamic gate wired into both runtime interceptors (rewrite + srcPipeline)",
  dynWires >= 2,
  "found " + dynWires + " needsJq(out) call sites, expected >= 2",
);

// A5. When gated, the shell tags the node with data-shell-jquery-gated so QA can
//     observe deferral on-device.
check(
  "gated nodes are marked data-shell-jquery-gated",
  tvSrc.includes('"data-shell-jquery-gated"'),
);

// A6. The gate ships in ALL FOUR artifacts (no path boots without it).
for (const [label, src] of [
  ["shell.js", tvSrc],
  ["shell.min.js", tvMin],
  ["boot-shell.src.js", bootSrc],
  ["boot-shell.min.js", bootMin],
]) {
  check(
    label + " carries the jQuery-wait wrapper",
    src.includes("jQuery wait timed out, running anyway"),
  );
  check(
    label + " carries the " + JQ_TIMEOUT_MS + "ms timeout bound",
    src.includes("," + JQ_TIMEOUT_MS + ")"),
  );
}

// ============================================================================
// PART B — DETECTION (needsJq) — exercise the SHIPPED regex
// ============================================================================
// Extract the live regex from source and run it against real-world plugin
// snippets, so detection is proven against the exact bytes that ship.
const JQUERY_REF_RE = new RegExp(
  /\bjQuery\b|(?:^|[^A-Za-z0-9_$.])\$\s*\(/.source,
);
function needsJq(code) {
  return JQUERY_REF_RE.test(code);
}

// Should FIRE (these crash with ReferenceError if run before jQuery on the TV):
const POSITIVE = [
  ['jQuery("#x").hide()', "bare jQuery() call"],
  ['$(".jellyfin-enhanced").appendTo("body")', "$(selector) at start of body"],
  ['  $("body").addClass("x")', "$( after leading whitespace"],
  ["var x = 1;\n$(document).ready(fn)", "$( after newline"],
  ["if (a) { $(el).remove(); }", "$( after a non-identifier char"],
  ["window.jQuery.fn.extend({})", "jQuery member access"],
];
for (const [code, why] of POSITIVE) {
  check("needsJq fires: " + why, needsJq(code) === true, JSON.stringify(code));
}

// Should NOT fire (no jQuery dependency — gating these would needlessly defer):
const NEGATIVE = [
  ["var price = `$${amount}`;", "template-literal dollar, no call"],
  [
    "const $el = document.body; $el.id;",
    "$-prefixed identifier, never called as $()",
  ],
  ["foo.$(x)", "member .$( — not the global jQuery"],
  ["a$ (b)", "identifier ending in $ then space-call"],
  ["const cost = $.5;", "$ followed by a dot, not a paren"],
  ["console.log('no jquery here')", "plain DOM/console plugin"],
];
for (const [code, why] of NEGATIVE) {
  check(
    "needsJq stays quiet: " + why,
    needsJq(code) === false,
    JSON.stringify(code),
  );
}

// ============================================================================
// PART C — DEFERRAL (wrapJq) — execute the SHIPPED wrapper under a virtual clock
// ============================================================================
// Pull the real wrapForJQuery() out of shell.js and run the wrapped body in a
// vm sandbox whose setInterval/setTimeout are backed by a fake clock. This is
// the literal shipped deferral logic — no re-transcription.

function extractWrapForJQuery(src) {
  const start = src.indexOf("function wrapForJQuery(");
  if (start === -1) throw new Error("wrapForJQuery not found in shell.js");
  // The function body is a `return [ ... ].join("");` block; find its closing
  // brace by scanning balanced braces from the opening one.
  const open = src.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end === -1) throw new Error("could not balance wrapForJQuery braces");
  return src.slice(start, end);
}

// Evaluate the extracted function into this scope.
const wrapForJQuery = (function () {
  const factory = new vm.Script(
    "(" +
      extractWrapForJQuery(tvSrc).replace(
        /^function wrapForJQuery/,
        "function",
      ) +
      ")",
  );
  return factory.runInThisContext();
})();

// A minimal virtual clock: setInterval/setTimeout register timers; advanceTo()
// fires every due timer in time order, re-firing intervals, honoring clears.
function makeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, delay) {
      const id = nextId++;
      timers.set(id, { fn, at: now + delay, interval: null });
      return id;
    },
    setInterval(fn, delay) {
      const id = nextId++;
      timers.set(id, { fn, at: now + delay, interval: delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    clearInterval(id) {
      timers.delete(id);
    },
    advanceTo(target) {
      // Fire timers strictly in chronological order until none remain <= target.
      // Re-scan each step because a fired callback may add/clear timers.
      for (;;) {
        let pick = null;
        for (const [id, t] of timers) {
          if (t.at <= target && (pick === null || t.at < pick.t.at))
            pick = { id, t };
        }
        if (!pick) break;
        now = pick.t.at;
        if (pick.t.interval != null) pick.t.at = now + pick.t.interval;
        else timers.delete(pick.id);
        pick.t.fn();
      }
      now = target;
    },
  };
}

// Run a wrapped plugin body in a sandbox. `jqAt` = ms at which window.jQuery
// becomes defined (null = never). Returns { ranAt, timedOut, errored }.
function runWrapped(pluginRecordsRunAt, jqAt) {
  const clock = makeClock();
  let timedOut = false;
  let errored = null;
  const sandbox = {
    window: { jQuery: undefined },
    console: {
      warn(msg) {
        if (String(msg).indexOf("jQuery wait timed out") !== -1)
          timedOut = true;
      },
      error(msg, detail) {
        errored = detail || msg;
      },
      log() {},
    },
    setInterval: clock.setInterval,
    setTimeout: clock.setTimeout,
    clearInterval: clock.clearInterval,
    clearTimeout: clock.clearTimeout,
    __mark() {
      sandbox.__ranAt = clock.now();
    },
    __ranAt: null,
  };
  vm.createContext(sandbox);

  // Plugin body: records the virtual time at which it actually executed.
  const pluginBody = "window.__ran = true; __mark();";
  const wrapped = wrapForJQuery(pluginBody);

  // Model jQuery's late arrival as a timer on the same clock (browser => 0).
  if (jqAt !== null) {
    clock.setTimeout(function () {
      sandbox.window.jQuery = function () {};
    }, jqAt);
  }

  if (jqAt === 0) sandbox.window.jQuery = function () {}; // present before run (browser)
  vm.runInContext(wrapped, sandbox);
  clock.advanceTo(JQ_TIMEOUT_MS + 1000); // run well past the 10 s ceiling
  return {
    ranAt: sandbox.__ranAt,
    ran: sandbox.window.__ran === true,
    timedOut,
    errored,
  };
}

// C1. BROWSER parity: window.jQuery present at t=0 -> synchronous fast path.
{
  const r = runWrapped(true, 0);
  check(
    "browser: jQuery present at t=0 -> plugin runs synchronously (t=0)",
    r.ran && r.ranAt === 0,
    "ranAt=" + r.ranAt,
  );
  check(
    "browser: no timeout warning on the synchronous path",
    r.timedOut === false,
  );
}

// C2. TV typical: jQuery bundle finishes ~300 ms after the inlined body runs.
//     The 20 ms poller must run the plugin at the first tick >= 300 ms, far
//     under the 10 s ceiling, with no timeout warning.
{
  const r = runWrapped(true, 290); // arrives at 290 ms (between two poll ticks)
  check(
    "TV typical: plugin deferred then runs once jQuery appears",
    r.ran === true,
  );
  check(
    "TV typical: runs at the first poll tick after jQuery (t=300ms)",
    r.ranAt === 300,
    "ranAt=" + r.ranAt,
  );
  check("TV typical: well within the 10 s bound", r.ranAt < JQ_TIMEOUT_MS);
  check(
    "TV typical: no timeout warning (jQuery arrived in time)",
    r.timedOut === false,
  );
  check("TV typical: plugin executed without error", r.errored === null);
}

// C3. TV worst case: jQuery NEVER appears. The 10 s setTimeout must fire, warn,
//     and run the plugin anyway — so the plugin is never silently dropped, and
//     still executes within the 10 s ceiling (exactly at the bound).
{
  const r = runWrapped(true, null);
  check(
    "TV worst case: plugin still executes when jQuery never loads",
    r.ran === true,
  );
  check(
    "TV worst case: executes at the 10 s timeout bound",
    r.ranAt === JQ_TIMEOUT_MS,
    "ranAt=" + r.ranAt,
  );
  check(
    "TV worst case: emits the 'jQuery wait timed out' warning",
    r.timedOut === true,
  );
}

// C4. Boundary: jQuery appears at 9.98 s (last poll tick before timeout) still
//     runs via the poller, not the timeout fallback.
{
  const r = runWrapped(true, 9970);
  check(
    "TV edge: jQuery at 9.97 s -> poller runs it at 9.98 s, before timeout",
    r.ranAt === 9980 && r.timedOut === false,
    "ranAt=" + r.ranAt + " timedOut=" + r.timedOut,
  );
}

// ============================================================================
console.log("");
if (failures) {
  console.error(
    "\njQuery-gate verification FAILED: " + failures + " check(s).",
  );
  process.exit(1);
}
console.log(
  "jQuery-gate verification PASSED — detection + deferral confirmed, plugin runs within 10 s on TV and synchronously in the browser.",
);
