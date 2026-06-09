// JEL-73 — empirical runtime verification of the __shellFlat / __shellFlatMap
// accessor polyfill, exercised against the THREE Array.prototype.flat realities
// a real device can present, by EXECUTING the real shell.js polyfill (not by
// reading source).
//
// The flat polyfill is shell-internal and UA-unconditional (no isLegacyChromium
// gate), so — unlike the bundle-patch harness — there is no two-UA fork to run.
// What actually decides the outcome on a real device is the state of the native
// Array.prototype.flat the accessor installs OVER:
//
//   • Scenario A — ABSENT  (stock Chrome <69 / Tizen 5.0 M56 WebView).
//     `items.flat()` would throw "flat is not a function". The accessor supplies
//     it → no TypeError, correct one-level flatten.
//
//   • Scenario B — PRESENT-BUT-BUGGY  (Samsung's M56 fork: body uses `d > 1`,
//     so `[[item]].flat()` returns `[[item]]` unchanged). The earlier
//     `if(!Array.prototype.flat)` conditional polyfill CANNOT fix this (flat is
//     present, so it skips). The unconditional accessor REPLACES the buggy flat
//     → playbackmanager gets a real one-level flatten, killing the
//     "No player found for the requested media: undefined" log. We also prove a
//     strict-mode plugin write cannot resurface the buggy native.
//
//   • Scenario C — CORRECT  (every modern browser / modern Tizen TV). The
//     accessor reproduces native output exactly → behavioural no-op (parity).
//
// In each scenario we install the relevant fake native onto a vm context's
// Array.prototype, then run the REAL reconstructed shell.js polyfill over it and
// drive the exact playbackmanager pattern (`items = items.flat()`).
//
// Run: node tooling/tv-validate/flat-polyfill/verify-flat-polyfill.mjs

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import vm from "node:vm";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..", "..", "..");
const SHELL = path.join(REPO, "packages", "shell-tizen", "src", "shell.js");
const source = fs.readFileSync(SHELL, "utf8");

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log("OK: " + name);
  } else {
    console.error("FAIL: " + name + (detail ? "  — " + detail : ""));
    failures++;
  }
}

// Reconstruct the REAL injected polyfill JS from shell.js's string-array source
// (the same bytes that ship to the device). See flat-polyfill.test.cjs for the
// detailed rationale.
function reconstruct(src) {
  const anchor = src.indexOf("function __shellFlat(depth){");
  if (anchor === -1) throw new Error("__shellFlat block not found in shell.js");
  const tryIdx = src.lastIndexOf("try{(function(){", anchor);
  const startLine = src.lastIndexOf("\n", tryIdx) + 1;
  const flag = src.indexOf("__shellFlatInstalled", anchor);
  const close = src.indexOf("})();}catch(_){}", flag);
  let endLine = src.indexOf("\n", close);
  if (endLine === -1) endLine = src.length;
  const block = src.slice(startLine, endLine);
  const arr = new Function("return [" + block + "\n]")();
  return arr.join("\n");
}

const INJECTED = reconstruct(source);

// A vm context whose native Array.prototype.flat is set up by `prelude` BEFORE
// the shell polyfill runs over it. Returns the context (with a fake window).
function deviceContext(prelude) {
  const ctx = { window: {}, console };
  vm.createContext(ctx);
  if (prelude) vm.runInContext(prelude, ctx);
  vm.runInContext(INJECTED, ctx);
  return ctx;
}

// The exact jellyfin-web playbackmanager pattern (playbackmanager.js:2095):
//   items = items.flat();  then each entry is handed to getPlayer(item, ...)
// A correct flatten yields objects with a MediaType; a no-op flatten yields
// nested arrays (no MediaType) → "No player found ... undefined".
const PLAYQUEUE = "[[{Id:'a',MediaType:'Video'}],[{Id:'b',MediaType:'Video'}]]";
const DRIVE_PLAYQUEUE =
  "(function(){var items=" +
  PLAYQUEUE +
  ";items=items.flat();" +
  "return JSON.stringify({" +
  "len:items.length," +
  "allHaveMediaType:items.every(function(it){return it&&it.MediaType==='Video';})," +
  "anyStillArray:items.some(function(it){return Array.isArray(it);})" +
  "});})()";

// ---------------------------------------------------------------------------
// Scenario A — native flat ABSENT (stock Chrome <69 / Tizen 5.0 M56).
// ---------------------------------------------------------------------------
function scenarioAbsent() {
  console.log("\n=== Scenario A: native flat/flatMap ABSENT (Chrome <69) ===");
  const PRELUDE =
    "try{delete Array.prototype.flat;}catch(_){}" +
    "try{delete Array.prototype.flatMap;}catch(_){}" +
    // sanity: prove they really are gone before the shell installs them
    "window.__preFlat=typeof Array.prototype.flat;" +
    "window.__preFlatMap=typeof Array.prototype.flatMap;";
  const ctx = deviceContext(PRELUDE);
  check(
    "precondition: native flat was absent before the shell polyfill",
    ctx.window.__preFlat === "undefined" &&
      ctx.window.__preFlatMap === "undefined",
  );
  check(
    "shell supplies flat → typeof [].flat === 'function' (no TypeError)",
    vm.runInContext("typeof [].flat==='function'", ctx),
  );
  const r = JSON.parse(vm.runInContext(DRIVE_PLAYQUEUE, ctx));
  check(
    "playbackmanager items.flat() flattens to 2 items, all with MediaType, none still arrays",
    r.len === 2 && r.allHaveMediaType === true && r.anyStillArray === false,
    JSON.stringify(r),
  );
  check("window.__shellFlatInstalled set", ctx.window.__shellFlatInstalled === 1);
}

// ---------------------------------------------------------------------------
// Scenario B — native flat PRESENT-BUT-BUGGY (Samsung M56 fork: d>1 bug).
// ---------------------------------------------------------------------------
function scenarioBuggy() {
  console.log("\n=== Scenario B: native flat PRESENT-BUT-BUGGY (Samsung M56 d>1) ===");
  // Faithful reproduction of the documented bug: depth<=1 returns the array
  // UNCHANGED (the `d > 1` off-by-one), so [[item]].flat() does nothing.
  const BUGGY_NATIVE =
    "Array.prototype.flat=function(d){" +
    "d=(d===undefined)?1:Math.floor(d);" +
    "if(d>1){var out=[];for(var i=0;i<this.length;i++){" +
    "var v=this[i];if(Array.isArray(v)){var inner=v.flat(d-1);" +
    "for(var j=0;j<inner.length;j++)out.push(inner[j]);}else{out.push(v);}}return out;}" +
    "return this;};"; // BUG: depth 1 is a no-op
  // Prove the bug exists in the fake native, THEN run the shell over it.
  const PROVE_BUG =
    BUGGY_NATIVE +
    "window.__buggyResult=JSON.stringify([[{MediaType:'Video'}]].flat());";
  const ctx = deviceContext(PROVE_BUG);
  check(
    "precondition: the faked Samsung native flat IS buggy ([[item]].flat() unchanged)",
    ctx.window.__buggyResult === '[[{"MediaType":"Video"}]]',
    ctx.window.__buggyResult,
  );
  // After the shell's unconditional accessor install, the bug is gone.
  const r = JSON.parse(vm.runInContext(DRIVE_PLAYQUEUE, ctx));
  check(
    "shell accessor OVERRIDES the buggy native → items.flat() now flattens correctly",
    r.len === 2 && r.allHaveMediaType === true && r.anyStillArray === false,
    JSON.stringify(r),
  );
  check(
    "[[item]].flat() now unwraps one level (the 'No player found ... undefined' fix)",
    vm.runInContext("JSON.stringify([[{MediaType:'Video'}]].flat())", ctx) ===
      '[{"MediaType":"Video"}]',
  );
  // A strict-mode plugin write must NOT let the buggy native resurface.
  const still = vm.runInContext(
    "(function(){'use strict';try{Array.prototype.flat=function(){return this;};}catch(_){}" +
      "return JSON.stringify([[{MediaType:'Video'}]].flat());})()",
    ctx,
  );
  check(
    "a strict-mode plugin reassignment cannot resurface the buggy flat",
    still === '[{"MediaType":"Video"}]',
    still,
  );
}

// ---------------------------------------------------------------------------
// Scenario C — native flat CORRECT (modern browser / modern Tizen TV).
// ---------------------------------------------------------------------------
function scenarioModern() {
  console.log("\n=== Scenario C: native flat CORRECT (modern browser / TV) ===");
  // No prelude → the vm context's own (correct) native flat is in place first.
  const ctxNative = { console };
  vm.createContext(ctxNative);
  const BATTERY = [
    "[1,[2,[3,[4]]]].flat()",
    "[1,[2,[3,[4]]]].flat(2)",
    "[1,[2,[3,[4]]]].flat(Infinity)",
    "[[{MediaType:'Video'}]].flat()",
    "[1,2,3].flatMap(function(x){return [x,x*2];})",
    "[1,2,3,4].flatMap(function(x){return x%2?[x]:[];})",
  ];
  const ctxPoly = deviceContext(null);
  let allMatch = true;
  for (const expr of BATTERY) {
    const native = vm.runInContext("JSON.stringify(" + expr + ")", ctxNative);
    const poly = vm.runInContext("JSON.stringify(" + expr + ")", ctxPoly);
    if (native !== poly) {
      allMatch = false;
      check("parity: " + expr, false, "native=" + native + " poly=" + poly);
    }
  }
  check(
    "modern: shell accessor reproduces native flat/flatMap exactly (behavioural no-op)",
    allMatch,
  );
}

scenarioAbsent();
scenarioBuggy();
scenarioModern();

console.log("");
if (failures) {
  console.error("JEL-73 flat polyfill runtime verification: " + failures + " check(s) FAILED.");
  process.exit(1);
}
console.log("JEL-73 flat polyfill runtime verification: all scenarios passed.");
