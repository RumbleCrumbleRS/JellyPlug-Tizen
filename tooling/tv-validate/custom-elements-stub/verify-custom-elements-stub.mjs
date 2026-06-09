#!/usr/bin/env node
// JEL-74 — Compare: Custom Elements polyfill stub — Web Components fallback on
// the Tizen WebView (M56/M63/M69) vs browser.
//
// ── What the ticket asks ─────────────────────────────────────────────────────
//   (1) the makeStub() Custom-Elements fallback is installed for the TV path;
//   (2) jellyfin-web components that use Custom Elements either work correctly
//       via the stub or degrade gracefully;
//   (3) the stub does NOT throw on the TV;
//   (4) the same UI renders as in browser.
//
// ── What the code actually is (an important correction to the ticket) ────────
// The shell does NOT polyfill a *missing* Custom Elements API. It wraps the
// Custom Elements **v0** API — `document.registerElement` — which DOES exist on
// the Tizen WebViews (Chromium M56/M63/M69 all ship v0 registerElement AND v1
// `customElements.define`). The defect (JEL-1779) is that on the Tizen WebView
// build, `document.registerElement` *throws* NotSupportedError when the document
// state isn't yet `interactive`. jellyfin-web / emby-webcomponents call
// `document.registerElement('array-checkbox', …)` (and friends) during early
// boot; one such throw, unguarded, blows up the boot sequence and the splash
// hangs 10+ minutes.
//
// The shell's guard, installed in BOTH shells (shell.js + boot-shell.src.js):
//   - reads `orig = document.registerElement`. If it's absent (a modern browser
//     — Chrome 80+ removed v0 — uses native v1 `customElements.define`, no v0),
//     OR already wrapped, it installs NOTHING. → On browser the shell is inert:
//     jellyfin-web's native v1 path is untouched, UI is fully native.
//   - otherwise replaces registerElement with a wrapper that calls the native
//     one; on success returns the native constructor (component WORKS); on a
//     thrown NotSupportedError it returns `makeStub()` — an HTMLElement-derived
//     no-op constructor — so the boot sequence proceeds (component DEGRADES to
//     an inert tag instead of blocking) and NEVER rethrows.
//   - counts `__shellRegElCalls` vs `__shellRegElErrors` so QA can see, on the
//     real device, how many registrations succeeded natively vs were rescued.
//
// So "works correctly OR degrades gracefully" maps exactly to the two branches:
// native success → works; throw → inert stub → graceful. "Does not throw" is the
// catch + return-stub. "Same UI as browser" holds because (a) on browser the
// wrapper is never installed (native v1), and (b) on TV the overwhelming
// majority of registrations succeed natively (only pre-`interactive` ones throw
// and are stubbed), so the rendered DOM matches; the stubbed element still
// renders its light-DOM children as an inert HTMLElement, it just loses that one
// component's scripted behavior.
//
// ── What this harness does (deterministic, runs in this sandbox) ─────────────
//  PART A (source): the makeStub + registerElement wrapper block is present and
//    BYTE-IDENTICAL in shell.js and boot-shell.src.js, and shipped in both
//    .min.js artifacts; the install guard, idempotency tag, diagnostics
//    counters and the catch→return-stub shape are all present.
//  PART B (faithful simulation): EXTRACT the exact wrapper IIFE from shell.js
//    source, reconstitute the injected JS, and run it in a Node `vm` context
//    against a mocked `document.registerElement`, proving the real code:
//      - native-success path → returns the native ctor, counts a call, 0 errors;
//      - throw path → returns a working HTMLElement-derived stub, counts an
//        error, records a diagnostic, and NEVER rethrows (does not throw on TV);
//      - the stub is a usable constructor: `new Stub()` works, instances are
//        `instanceof HTMLElement` (renders as an inert element → graceful);
//      - absent registerElement (browser/modern) → installs NOTHING (no
//        interference with native v1 → same UI as browser);
//      - idempotent (re-running never double-wraps);
//      - diagnostics ring buffer is bounded (never grows without limit).
//
// This proves the MECHANISM is correct and non-throwing. The on-device split of
// native-vs-rescued registrations is the empirical confirmation and is readable
// from `window.__shellRegElCalls` / `window.__shellRegElErrors` via the existing
// QA beacon / diag — no new manual step required.
//
// Usage (no server or browser needed):
//   node tooling/tv-validate/custom-elements-stub/verify-custom-elements-stub.mjs
// Exits non-zero on any failed assertion.

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..", "..", "..");
const TV_SHELL = path.join(REPO, "packages", "shell-tizen", "src", "shell.js");
const HOSTED_SHELL = path.join(REPO, "packages", "shell-tizen-bootstrap", "src", "boot-shell.src.js");
const TV_MIN = path.join(REPO, "packages", "shell-tizen", "src", "shell.min.js");
const HOSTED_MIN = path.join(REPO, "packages", "shell-tizen-bootstrap", "src", "boot-shell.min.js");

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

// ── Extract the registerElement wrapper IIFE from a shell source file ─────────
// The seed script is authored as an array of quoted JS-line string literals that
// get join("\n")'d into the injected document script. We locate the contiguous
// run of lines from the `try{(function(){` that opens the registerElement block
// (the one containing `function makeStub()`) to its closing `})();}catch(_){}`,
// unquote each literal, and rejoin — yielding the EXACT injected JS verbatim.
function extractRegElBlock(file) {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const mid = lines.findIndex((l) => l.includes("function makeStub()") && l.includes("Reflect.construct"));
  if (mid < 0) return null;
  let start = mid;
  while (start >= 0 && !/try\{\(function\(\)\{/.test(lines[start])) start--;
  let end = mid;
  while (end < lines.length && !/\}\)\(\);\}catch\(_\)\{/.test(lines[end])) end++;
  if (start < 0 || end >= lines.length) return null;
  const parts = [];
  for (let i = start; i <= end; i++) {
    const t = lines[i].trim().replace(/,\s*$/, "");
    if (!t) continue;
    if (t[0] !== '"' && t[0] !== "'") return null; // not a string literal — bail
    // t is exactly one quoted JS string literal; evaluating it yields the line.
    parts.push(eval(t)); // eslint-disable-line no-eval -- our own source, literal only
  }
  return parts.join("\n");
}

// ─── PART A: source presence + parity + shipped artifacts ────────────────────
function sourceChecks() {
  const tvBlock = extractRegElBlock(TV_SHELL);
  const hostedBlock = extractRegElBlock(HOSTED_SHELL);

  check("registerElement wrapper block extracted from shell.js (TV)", !!tvBlock,
    tvBlock ? `${tvBlock.length} chars` : "not found");
  check("registerElement wrapper block extracted from boot-shell.src.js (hosted)", !!hostedBlock,
    hostedBlock ? `${hostedBlock.length} chars` : "not found");
  check("the Custom Elements stub is BYTE-IDENTICAL across TV + hosted shell",
    tvBlock && hostedBlock && tvBlock === hostedBlock, "single source of behavior");

  if (tvBlock) {
    check("[source] makeStub() builds an HTMLElement-derived constructor",
      /function makeStub\(\)\{function S\(\)\{.*Reflect\.construct\(HTMLElement,\[\],S\).*\}S\.prototype=Object\.create\(HTMLElement\.prototype\);S\.prototype\.constructor=S;return S;\}/.test(tvBlock));
    check("[source] install guard: skips when registerElement absent OR already wrapped",
      /if\(!orig\|\|orig\.__shellWrap\)return;/.test(tvBlock));
    check("[source] success path returns the NATIVE registration result",
      /try\{return orig\.apply\(document,arguments\);\}/.test(tvBlock));
    check("[source] throw path is caught and returns makeStub() (never rethrows)",
      /catch\(e\)\{[\s\S]*return makeStub\(\);[\s\S]*\}/.test(tvBlock));
    check("[source] diagnostics count calls + errors (__shellRegElCalls/Errors)",
      /__shellRegElCalls=\(window\.__shellRegElCalls\|\|0\)\+1/.test(tvBlock) &&
      /__shellRegElErrors=\(window\.__shellRegElErrors\|\|0\)\+1/.test(tvBlock));
    check("[source] idempotency tag set on the wrapper (__shellWrap)",
      /wrapped\.__shellWrap=true;/.test(tvBlock));
  }

  // shipped artifacts carry the wrapper (it is not stripped by minification)
  for (const [label, f] of [["shell.min.js", TV_MIN], ["boot-shell.min.js", HOSTED_MIN]]) {
    const src = fs.readFileSync(f, "utf8");
    check(`[artifact] ${label} ships the makeStub + registerElement wrapper`,
      src.includes("makeStub") && src.includes("__shellRegElCalls") && src.includes("__shellWrap"));
  }

  return tvBlock;
}

// ─── PART B: run the REAL extracted code in a vm against a mocked API ─────────
// Node has no DOM, so mock HTMLElement exactly as a WebView exposes it: a
// constructor with a prototype, usable with Reflect.construct / Object.create /
// instanceof. The SAME object is shared into every sandbox and used by the
// harness's own assertions, so `instanceof HTMLElement` is meaningful.
function HTMLElement() {}
HTMLElement.prototype = { __isHTMLElementProto: true };

function makeCtx(registerElementImpl) {
  const win = {};
  const doc = {};
  if (registerElementImpl !== undefined) doc.registerElement = registerElementImpl;
  const sandbox = { window: win, document: doc, HTMLElement, Reflect, Object, JSON, console };
  vm.createContext(sandbox);
  return sandbox;
}

function simulationChecks(block) {
  if (!block) { check("[sim] wrapper code available to simulate", false, "extraction failed"); return; }

  // Scenario 1 — native registerElement SUCCEEDS (the common path).
  {
    function NativeCtor() {}
    const sb = makeCtx(function () { return NativeCtor; });
    vm.runInContext(block, sb);
    const installed = sb.document.registerElement && sb.document.registerElement.__shellWrap === true;
    check("[sim:success] wrapper installs over a present registerElement", installed);
    const ret = sb.document.registerElement("emby-button", { prototype: {} });
    check("[sim:success] returns the NATIVE constructor (component works)", ret === NativeCtor);
    check("[sim:success] counts the call, records ZERO errors",
      sb.window.__shellRegElCalls === 1 && !sb.window.__shellRegElErrors,
      `calls=${sb.window.__shellRegElCalls} errors=${sb.window.__shellRegElErrors || 0}`);
  }

  // Scenario 2 — native registerElement THROWS NotSupportedError (JEL-1779).
  {
    const sb = makeCtx(function () {
      const e = new Error("Operation is not supported");
      e.name = "NotSupportedError";
      throw e;
    });
    sb.window.__shellDiag = { errors: [] };
    vm.runInContext(block, sb);
    let threw = false, stub = null;
    try { stub = sb.document.registerElement("array-checkbox", { prototype: {} }); }
    catch (_) { threw = true; }
    check("[sim:throw] wrapper does NOT rethrow on NotSupportedError (does not throw on TV)", !threw);
    check("[sim:throw] returns a stub constructor instead of failing boot", typeof stub === "function");
    check("[sim:throw] counts the call AND the rescued error",
      sb.window.__shellRegElCalls === 1 && sb.window.__shellRegElErrors === 1,
      `calls=${sb.window.__shellRegElCalls} errors=${sb.window.__shellRegElErrors}`);
    check("[sim:throw] records a diagnostic naming the failed element",
      sb.window.__shellDiag.errors.length === 1 &&
      /array-checkbox/.test(sb.window.__shellDiag.errors[0].m),
      sb.window.__shellDiag.errors[0] && sb.window.__shellDiag.errors[0].m);

    // The stub must be a USABLE HTMLElement-derived constructor → the custom
    // tag renders as an inert element (graceful degradation), not a crash.
    let inst = null, ctorThrew = false;
    try { inst = vm.runInContext("(function(C){return new C();})", sb)(stub); }
    catch (_) { ctorThrew = true; }
    check("[sim:throw] `new Stub()` does not throw (renders as an inert tag)", !ctorThrew && !!inst);
    check("[sim:throw] stub instances are `instanceof HTMLElement` (valid DOM element → graceful)",
      inst instanceof HTMLElement);
    check("[sim:throw] stub prototype chains to HTMLElement.prototype",
      stub.prototype && Object.getPrototypeOf(stub.prototype) === HTMLElement.prototype &&
      stub.prototype.constructor === stub);
  }

  // Scenario 3 — registerElement ABSENT (a modern browser / Chrome 80+; the
  // hosted shell running in a normal browser). Wrapper must install NOTHING so
  // jellyfin-web's native v1 customElements.define is untouched → same UI.
  {
    const sb = makeCtx(undefined); // no document.registerElement at all
    vm.runInContext(block, sb);
    check("[sim:absent] installs nothing when registerElement is absent (browser native v1 untouched)",
      sb.document.registerElement === undefined &&
      sb.window.__shellRegElCalls === undefined);
  }

  // Scenario 4 — idempotency: re-running the seed never double-wraps.
  {
    function NativeCtor() {}
    const sb = makeCtx(function () { return NativeCtor; });
    vm.runInContext(block, sb);
    const firstWrapped = sb.document.registerElement;
    vm.runInContext(block, sb); // run again
    check("[sim:idempotent] second install is a no-op (same wrapper, no double layer)",
      sb.document.registerElement === firstWrapped);
    sb.document.registerElement("x-test", { prototype: {} });
    check("[sim:idempotent] a single call increments the counter by exactly 1 (not double-counted)",
      sb.window.__shellRegElCalls === 1, `calls=${sb.window.__shellRegElCalls}`);
  }

  // Scenario 5 — mixed traffic + bounded diagnostics: many registrations, some
  // native-success, many throwing; counts split correctly and the diag ring
  // buffer never exceeds its cap (30).
  {
    let n = 0;
    const sb = makeCtx(function () {
      n++;
      if (n % 5 === 0) return function GoodCtor() {}; // 1 in 5 succeeds natively
      const e = new Error("not interactive yet"); e.name = "NotSupportedError"; throw e;
    });
    sb.window.__shellDiag = { errors: [] };
    vm.runInContext(block, sb);
    let anyThrew = false;
    for (let i = 0; i < 40; i++) {
      try { sb.document.registerElement("el-" + i, { prototype: {} }); }
      catch (_) { anyThrew = true; }
    }
    check("[sim:mixed] 40 registrations, never throws to the caller", !anyThrew);
    check("[sim:mixed] call/error split is correct (8 native successes, 32 rescued)",
      sb.window.__shellRegElCalls === 40 && sb.window.__shellRegElErrors === 32,
      `calls=${sb.window.__shellRegElCalls} errors=${sb.window.__shellRegElErrors}`);
    check("[sim:mixed] diagnostics ring buffer is bounded (≤30, never unbounded growth)",
      sb.window.__shellDiag.errors.length === 30, `errors buffered=${sb.window.__shellDiag.errors.length}`);
  }
}

function main() {
  console.log("JEL-74 — Custom Elements stub (document.registerElement v0 rescue) verification\n");
  const block = sourceChecks();
  console.log("");
  simulationChecks(block);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  process.exit(failed.length ? 1 : 0);
}

main();
