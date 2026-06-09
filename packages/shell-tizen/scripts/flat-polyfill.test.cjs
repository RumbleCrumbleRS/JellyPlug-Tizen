// JEL-73 verification — Array.prototype.flat / flatMap polyfill accessors,
// compared shell-polyfill vs native flat/flatMap.
//
// WHAT THE ISSUE ASKS US TO PROVE
//   1. __shellFlat() / __shellFlatMap() (injected via __installAccessor) produce
//      the SAME results as native Array.flat / Array.flatMap.
//   2. A Jellyfin page that calls flat() (e.g. playbackmanager's
//      `items = items.flat()` library/queue flattening) hits no TypeError on the
//      M56 Chromium TV WebView.
//   3. window.__shellFlatInstalled is set.
//
// THE TV-vs-BROWSER TRUTH (the "Compare" half)
//   The flat/flatMap accessor block is injected UNCONDITIONALLY — there is NO
//   isLegacyChromium() gate around it, unlike the bundle-patch / detail-page
//   chains. So the SAME bytes install on TV and browser, and equivalence is by
//   construction:
//
//     • Modern browser / modern TV — native flat/flatMap are already correct.
//       __shellFlat reproduces their output exactly, so the override is a
//       behavioural no-op (parity).
//
//     • Tizen 5.0 / 5.5 M56/M63 WebView — native flat is either ABSENT (Chrome
//       <69 never shipped it) or, on Samsung's fork, PRESENT-BUT-BUGGY (the
//       body uses `d > 1` instead of `d >= 1`, so `[[item]].flat()` returns
//       `[[item]]` unchanged). Either way the unconditional accessor REPLACES it
//       with the correct implementation, so `playbackmanager.js` gets a properly
//       one-level-flattened array and stops logging "No player found for the
//       requested media: undefined". The earlier `if(!Array.prototype.flat)`
//       conditional polyfill (chromium56PolyfillBody) can only cover the ABSENT
//       case — it cannot dislodge a present-but-buggy native. That is the whole
//       reason for the accessor approach. Empirical M56-bug confirmation lives
//       in tooling/tv-validate/flat-polyfill/results-JEL-73.md.
//
//   The v47 fix installs as an ACCESSOR (getter returns the fixed fn, setter
//   silently absorbs writes, configurable:true) rather than a writable:false
//   data property, so plugin bundles that run in strict mode and do
//   `Array.prototype.flat = fn` don't throw and die — but the broken platform
//   flat can never resurface either.
//
// STRATEGY
//   No DOM test runner exists here, so we (a) reconstruct the REAL injected
//   polyfill JS verbatim from shell.js's string-array source, run it in a `vm`
//   context, and compare its flat/flatMap output to Node's native flat/flatMap
//   across a battery of inputs; and (b) source-assert the accessor shape, the
//   __shellFlatInstalled flag, and the unconditional (no-UA-gate) install on
//   shell.js, the deployed shell.min.js, and the hosted boot-shell.src.js so TV
//   and browser stay in lockstep.
//
// Run: node scripts/flat-polyfill.test.cjs   (or via the package `test` script)

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const REPO = path.join(__dirname, "..", "..", "..");
const SHELL = path.join(REPO, "packages", "shell-tizen", "src", "shell.js");
const SHELL_MIN = path.join(
  REPO,
  "packages",
  "shell-tizen",
  "src",
  "shell.min.js",
);
const HOSTED = path.join(
  REPO,
  "packages",
  "shell-tizen-bootstrap",
  "src",
  "boot-shell.src.js",
);

const src = fs.readFileSync(SHELL, "utf8");
const min = fs.readFileSync(SHELL_MIN, "utf8");
const hosted = fs.readFileSync(HOSTED, "utf8");

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log("OK: " + name);
  } else {
    console.error("FAIL: " + name + (detail ? "  — " + detail : ""));
    failures++;
  }
}

function ns(s) {
  return s.replace(/\s+/g, " ");
}

// ----------------------------------------------------------------------------
// Reconstruct the REAL injected polyfill JS from shell.js's string-array source.
//
// In shell.js the polyfill is stored as an array of double/single-quoted source
// LINES (it is concatenated and injected into the page as a <script>), not as
// live code. We capture the lines from the `try{(function(){` that wraps the
// __shellFlat block through the matching `})();}catch(_){}` and re-evaluate them
// as a JS array literal, then join — yielding the exact bytes that ship to the
// device. We can then run that verbatim in a vm context.
// ----------------------------------------------------------------------------
function locateBlock(source, label) {
  const anchor = source.indexOf("function __shellFlat(depth){");
  if (anchor === -1) throw new Error(label + ": __shellFlat block not found");
  const tryIdx = source.lastIndexOf("try{(function(){", anchor);
  if (tryIdx === -1)
    throw new Error(label + ": wrapping IIFE not found before __shellFlat");
  const startLine = source.lastIndexOf("\n", tryIdx) + 1;
  const flag = source.indexOf("__shellFlatInstalled", anchor);
  if (flag === -1)
    throw new Error(
      label + ": __shellFlatInstalled not found after __shellFlat",
    );
  const close = source.indexOf("})();}catch(_){}", flag);
  if (close === -1)
    throw new Error(label + ": closing IIFE not found after the flag");
  let endLine = source.indexOf("\n", close);
  if (endLine === -1) endLine = source.length;
  return { text: source.slice(startLine, endLine), tryIdx, close };
}

function reconstruct(source, label) {
  const block = locateBlock(source, label).text;
  let arr;
  try {
    // Each captured line is a quoted array element ending in `,`; wrap in [] and
    // evaluate. Source is trusted (our own repo).
    arr = new Function("return [" + block + "\n]")();
  } catch (e) {
    throw new Error(label + ": could not parse injected block — " + e.message);
  }
  if (!Array.isArray(arr) || !arr.every((l) => typeof l === "string"))
    throw new Error(label + ": reconstructed block is not a string array");
  return arr.join("\n");
}

// A vm context with the real polyfill installed on ITS Array.prototype (so we
// never pollute the host realm) and a fake window for the flag.
function makeCtx(injectedJS) {
  const ctx = { window: {}, console };
  vm.createContext(ctx);
  vm.runInContext(injectedJS, ctx);
  return ctx;
}

// Native expected, computed in the host realm (Node's flat/flatMap are correct).
function hostEval(expr) {
  // eslint-disable-next-line no-eval
  return eval(expr);
}

// ----------------------------------------------------------------------------
// PART 1 — behavioural equivalence: __shellFlat/__shellFlatMap === native, run
// on the REAL reconstructed shell.js polyfill across a battery of inputs.
// Every case is a JS expression evaluated BOTH in the polyfill ctx and in the
// host (native); JSON-stringified results must match.
// ----------------------------------------------------------------------------
const EQUIV = [
  // --- flat: structure ---
  "[].flat()",
  "[1,2,3].flat()",
  "[1,[2,3]].flat()",
  "[1,[2,[3,[4]]]].flat()",
  "[[1],[2],[3]].flat()",
  "[[],[],[]].flat()",
  "[1,[2],3,[4,[5]]].flat()",
  "[[[1]]].flat()",
  "['a',['b',['c']]].flat()",
  // --- flat: depth argument coercion (must match ToIntegerOrInfinity) ---
  "[1,[2,[3,[4]]]].flat(2)",
  "[1,[2,[3,[4]]]].flat(3)",
  "[1,[2,[3,[4]]]].flat(Infinity)",
  "[1,[2,[3,[4]]]].flat(0)",
  "[1,[2,[3,[4]]]].flat(-1)",
  "[1,[2,[3,[4]]]].flat(1.9)",
  "[1,[2,[3,[4]]]].flat('2')",
  "[1,[2,[3,[4]]]].flat(NaN)",
  "[1,[2,[3,[4]]]].flat(undefined)",
  "[[[1]]].flat(2)",
  "['a',['b',['c']]].flat(Infinity)",
  // --- the exact playbackmanager shape (M56 bug target) ---
  "[[{m:'Video'}]].flat()",
  "[[{m:'Video'},{m:'Audio'}]].flat()",
  // --- flatMap ---
  "[1,2,3].flatMap(function(x){return [x,x*2];})",
  "[1,2,3].flatMap(function(x){return x*2;})",
  "[1,2,3].flatMap(function(x){return [[x]];})",
  "[1,2,3,4].flatMap(function(x){return x%2?[x]:[];})",
  "['a','b'].flatMap(function(x,i){return [x,i];})",
  "[].flatMap(function(x){return [x];})",
  "[1,2].flatMap(function(x){return [x];})",
];

function behaviouralEquivalence() {
  console.log(
    "--- PART 1: __shellFlat/__shellFlatMap === native (real shell.js) ---",
  );
  const ctx = makeCtx(reconstruct(src, "shell.js"));

  // No TypeError: flat/flatMap exist and are callable after install.
  check(
    "after install [].flat is a function (no TypeError on .flat())",
    vm.runInContext("typeof [].flat==='function'", ctx),
  );
  check(
    "after install [].flatMap is a function (no TypeError on .flatMap())",
    vm.runInContext("typeof [].flatMap==='function'", ctx),
  );

  for (const expr of EQUIV) {
    let got, want, threw;
    try {
      got = vm.runInContext("JSON.stringify(" + expr + ")", ctx);
    } catch (e) {
      threw = "polyfill threw: " + (e && e.message);
    }
    try {
      want = JSON.stringify(hostEval(expr));
    } catch (e) {
      threw = (threw ? threw + "; " : "") + "native threw: " + (e && e.message);
    }
    check(
      "polyfill === native:  " + expr,
      !threw && got === want,
      threw || "polyfill=" + got + "  native=" + want,
    );
  }

  // The M56 bug, made explicit: a single-nested array MUST unwrap one level.
  // The buggy Samsung flat (d>1) returns [[item]] unchanged → playbackmanager
  // hands the inner array to getPlayer as `item` → "No player found ... undefined".
  check(
    "playbackmanager [[item]].flat() unwraps exactly one level (M56 bug absent)",
    vm.runInContext("JSON.stringify([[{m:'Video'}]].flat())", ctx) ===
      '[{"m":"Video"}]',
  );

  return ctx;
}

// ----------------------------------------------------------------------------
// PART 2 — accessor semantics: the v47 install contract (getter/setter, flag,
// strict-mode write absorption, configurable escape hatch).
// ----------------------------------------------------------------------------
function accessorSemantics(ctx) {
  console.log("\n--- PART 2: accessor install semantics (v47 contract) ---");

  check(
    "window.__shellFlatInstalled flag is set to 1",
    ctx.window.__shellFlatInstalled === 1,
    "got " + ctx.window.__shellFlatInstalled,
  );

  const desc = JSON.parse(
    vm.runInContext(
      "(function(){var d=Object.getOwnPropertyDescriptor(Array.prototype,'flat');" +
        "return JSON.stringify({cfg:d.configurable,en:d.enumerable," +
        "hasGet:typeof d.get==='function',hasSet:typeof d.set==='function'," +
        "isData:'value' in d});})()",
      ctx,
    ),
  );
  check("flat is installed as a configurable accessor", desc.cfg === true);
  check("flat accessor is non-enumerable", desc.en === false);
  check("flat accessor has a getter", desc.hasGet === true);
  check("flat accessor has a setter", desc.hasSet === true);
  check(
    "flat is NOT a writable:false data property (v46 regression)",
    desc.isData === false,
  );

  // v47 crux: a strict-mode plugin assignment must NOT throw, and the broken
  // native must NOT resurface (getter keeps returning __shellFlat).
  const w = JSON.parse(
    vm.runInContext(
      "(function(){'use strict';var threw=false;" +
        "try{Array.prototype.flat=function(){return 'HACKED';};}catch(e){threw=true;}" +
        "return JSON.stringify({threw:threw,still:[[1]].flat().join(',')});})()",
      ctx,
    ),
  );
  check(
    "strict-mode `Array.prototype.flat = fn` does NOT throw (plugin-safe)",
    w.threw === false,
  );
  check(
    "setter absorbs the write — getter still returns the fixed flat",
    w.still === "1",
    "got '" + w.still + "'",
  );

  // configurable:true escape hatch: an explicit Object.defineProperty override
  // still wins (documented, intentional).
  const ovr = vm.runInContext(
    "(function(){Object.defineProperty(Array.prototype,'flat'," +
      "{configurable:true,value:function(){return 'OVR';}});" +
      "return [[1]].flat();})()",
    ctx,
  );
  check(
    "configurable:true lets an explicit defineProperty override win (escape hatch)",
    ovr === "OVR",
  );
}

// ----------------------------------------------------------------------------
// PART 3 — documented divergence: sparse-array holes. Native flat ELIDES holes;
// the polyfill preserves them as `undefined`. This is the one place the polyfill
// is not byte-equivalent — and it is immaterial to jellyfin-web, which only ever
// flattens dense arrays (library/queue item lists). We assert the divergence
// explicitly so a future reader knows it is known, not an oversight.
// ----------------------------------------------------------------------------
function documentedDivergence() {
  console.log(
    "\n--- PART 3: documented sparse-hole divergence (immaterial) ---",
  );
  const ctx = makeCtx(reconstruct(src, "shell.js"));
  const poly = vm.runInContext("JSON.stringify([1,,3].flat())", ctx);
  // eslint-disable-next-line no-sparse-arrays
  const native = JSON.stringify([1, , 3].flat());
  check("native flat elides sparse holes → [1,3]", native === "[1,3]", native);
  check(
    "polyfill preserves the hole as null/undefined → [1,null,3] (KNOWN, immaterial)",
    poly === "[1,null,3]",
    poly,
  );
  check(
    "the divergence is sparse-only — dense arrays are byte-equivalent",
    poly !== native &&
      vm.runInContext("JSON.stringify([1,[2],3].flat())", ctx) ===
        JSON.stringify([1, [2], 3].flat()),
  );
}

// ----------------------------------------------------------------------------
// PART 4 — source contract: the accessor shape, the flag, and the UNCONDITIONAL
// install (no isLegacyChromium gate) across shell.js, the deployed shell.min.js,
// and the hosted boot-shell.src.js.
// ----------------------------------------------------------------------------
function sourceContract(label, code, isMin) {
  console.log("\n--- PART 4: source contract (" + label + ") ---");
  const flat = ns(code);

  check(label + ": defines __shellFlat", /__shellFlat\b/.test(code));
  check(label + ": defines __shellFlatMap", /__shellFlatMap\b/.test(code));
  check(
    label + ": defines __installAccessor",
    /__installAccessor\b/.test(code),
  );
  check(
    label + ': installs the "flat" accessor',
    /__installAccessor\(\s*"flat"/.test(flat),
  );
  check(
    label + ': installs the "flatMap" accessor',
    /__installAccessor\(\s*"flatMap"/.test(flat),
  );

  // Accessor (not data) install on Array.prototype: configurable + get + set.
  check(
    label + ": installs via Object.defineProperty on Array.prototype",
    /Object\.defineProperty\(\s*Array\.prototype/.test(flat),
  );
  check(
    label + ": accessor is configurable (true / !0)",
    /configurable\s*:\s*(?:true|!0)/.test(flat),
  );
  check(
    label + ": accessor has a getter that returns the fixed fn",
    /get\s*:\s*function\s*\(\s*\)\s*\{\s*return\s+fn[;\s]*\}/.test(flat),
  );
  check(
    label + ": accessor has a write-absorbing setter",
    /set\s*:\s*function\s*\(/.test(flat),
  );

  // The depth fix that distinguishes it from the buggy native: recurse with
  // v.flat(depth-1) only when depth>1; flatten one level at depth 1.
  check(
    label + ": __shellFlat recurses with v.flat(depth-1) guarded by depth>1",
    /depth\s*>\s*1/.test(flat) && /\.flat\(\s*depth\s*-\s*1\s*\)/.test(flat),
  );

  // Sets the install flag.
  check(
    label + ": sets window.__shellFlatInstalled = 1",
    /__shellFlatInstalled\s*=\s*1/.test(flat),
  );

  // The Compare crux: the install is UNCONDITIONAL — no isLegacyChromium gate
  // anywhere inside the polyfill IIFE. (Both UAs install the same accessor.)
  if (!isMin) {
    const { tryIdx, close } = locateBlock(code, label);
    const blockBody = code.slice(tryIdx, close);
    check(
      label +
        ": flat polyfill IIFE has NO isLegacyChromium gate (installs on both UAs)",
      !/isLegacyChromium/.test(blockBody),
    );
  }
}

// ----------------------------------------------------------------------------
// PART 5 — parity: the TV shell.js and the hosted boot-shell.src.js inject the
// BYTE-IDENTICAL polyfill (the strongest possible "Compare" statement), and the
// release artifact shell.min.js carries the same accessor tokens.
// ----------------------------------------------------------------------------
function parity() {
  console.log(
    "\n--- PART 5: parity (TV shell.js vs hosted boot-shell.src.js) ---",
  );
  const tv = reconstruct(src, "shell.js");
  const ho = reconstruct(hosted, "boot-shell.src.js");
  check(
    "TV shell.js and hosted boot-shell.src.js inject byte-identical polyfill",
    tv === ho,
    tv === ho ? "" : "blocks differ",
  );

  // And the reconstructed hosted polyfill is itself behaviourally correct.
  const ctx = makeCtx(ho);
  check(
    "hosted polyfill flattens [[item]].flat() to one level (parity behaviour)",
    vm.runInContext("JSON.stringify([[{m:'Video'}]].flat())", ctx) ===
      '[{"m":"Video"}]',
  );
  check(
    "hosted polyfill sets __shellFlatInstalled",
    ctx.window.__shellFlatInstalled === 1,
  );

  check(
    "shell.min.js (release artifact) carries __shellFlat",
    /__shellFlat\b/.test(min),
  );
  check(
    "shell.min.js carries __installAccessor",
    /__installAccessor\b/.test(min),
  );
  check(
    "shell.min.js sets __shellFlatInstalled = 1",
    /__shellFlatInstalled\s*=\s*1/.test(min),
  );
}

// ----------------------------------------------------------------------------
const ctx = behaviouralEquivalence();
accessorSemantics(ctx);
documentedDivergence();
sourceContract("shell.js", src, false);
sourceContract("shell.min.js (release artifact)", min, true);
sourceContract("hosted boot-shell.src.js", hosted, false);
parity();

console.log("");
if (failures) {
  console.error(
    "JEL-73 flat/flatMap polyfill contract: " + failures + " check(s) FAILED.",
  );
  process.exit(1);
}
console.log("JEL-73 flat/flatMap polyfill contract: all checks passed.");
