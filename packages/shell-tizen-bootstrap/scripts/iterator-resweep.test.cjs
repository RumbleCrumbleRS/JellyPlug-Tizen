// JEL-111 verification — DOM-collection iterator re-sweep + constructor
// setter traps.
//
// WHAT THE ISSUE ASKS US TO PROVE
//   "Main Menu Spins forever": after sign-in on the M63 the lazy home-route
//   chunks rebind the DOM collection constructors (window.NodeList et al.)
//   so querySelectorAll results stop being iterable, home render dies with
//   "Invalid attempt to iterate non-iterable instance" / "elements is not
//   iterable", and the loading spinner never hides. The fix must:
//     1. install an index-walk Symbol.iterator on collection prototypes that
//        lack one (original JEL-567 behaviour, kept);
//     2. DETERMINISTICALLY patch the REPLACEMENT constructor's prototype the
//        instant a bundle reassigns window.<ctor> (setter trap) — a timer
//        cannot win that race because the render that dies runs in the same
//        task as the clobber;
//     3. keep re-sweeping on a timer as a backstop, without stacking
//        intervals when the polyfill body executes again in the rewritten
//        document (`armed` latch);
//     4. ship the SAME logic in both deployed copies (boot-shell.src.js and
//        shell.js).
//
// STRATEGY
//   Extract the iterator IIFE (the block whose body mentions __shellIterFix)
//   from each source's chromium56PolyfillBody() line array, evaluate it in a
//   mock window/document sandbox with fake collection constructors, and
//   assert the contract above.

"use strict";

const fs = require("fs");
const path = require("path");

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
function ok(cond, label) {
  if (cond) {
    console.log("ok  - " + label);
  } else {
    failures++;
    console.error("FAIL - " + label);
  }
}

// Pull the polyfill body's line-array members between the IIFE opener and its
// closer, keeping only the string literals, then join exactly like the source
// does. The iterator block is the one that references __shellIterFix.
function extractIteratorBlock(file) {
  const src = fs.readFileSync(file, "utf8");
  const lines = src.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (
      /"\(function\(\)\{",\s*$/.test(lines[i]) &&
      lines
        .slice(i, i + 6)
        .join("\n")
        .includes("NodeList")
    ) {
      start = i;
      break;
    }
  }
  if (start < 0) throw new Error("iterator IIFE opener not found in " + file);
  const body = [];
  for (let i = start; i < lines.length; i++) {
    const m = lines[i].match(/^\s*(['"])(.*)\1,\s*$/);
    if (!m) continue; // comment lines inside the array
    body.push(m[2]);
    if (m[2] === "})();" && body.length > 1) break;
  }
  if (body[body.length - 1] !== "})();")
    throw new Error("iterator IIFE closer not found in " + file);
  // un-escape the JS string-literal escapes the source file uses
  return body.join("\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

const bootBlock = extractIteratorBlock(BOOT_SRC);
const shellBlock = extractIteratorBlock(SHELL_SRC);
ok(
  bootBlock === shellBlock,
  "boot-shell.src.js and shell.js embed IDENTICAL iterator IIFE bodies",
);
ok(
  bootBlock.includes("__shellIterFix"),
  "extracted block is the JEL-111 iterator fix (mentions __shellIterFix)",
);

// --- mock environment -------------------------------------------------------
function makeEnv() {
  const timeouts = [];
  const intervals = [];
  function FakeNodeList() {}
  function FakeHTMLCollection() {}
  // deliberately strip iterability
  delete FakeNodeList.prototype[Symbol.iterator];
  const win = {
    NodeList: FakeNodeList,
    HTMLCollection: FakeHTMLCollection,
  };
  const doc = {
    listeners: {},
    addEventListener(type, fn) {
      (this.listeners[type] = this.listeners[type] || []).push(fn);
    },
  };
  const env = {
    win,
    doc,
    timeouts,
    intervals,
    run(block) {
      const fn = new Function(
        "window",
        "document",
        "setTimeout",
        "setInterval",
        "clearInterval",
        block,
      );
      fn(
        win,
        doc,
        (cb, ms) => (timeouts.push({ cb, ms }), timeouts.length),
        (cb, ms) => (intervals.push({ cb, ms }), intervals.length),
        () => {},
      );
    },
  };
  return env;
}

// --- 1. initial sweep installs missing iterators -----------------------------
{
  const env = makeEnv();
  env.run(bootBlock);
  const st = env.win.__shellIterFix;
  ok(!!st && st.pass >= 1, "initial sweep ran (pass>=1)");
  ok(
    typeof env.win.NodeList.prototype[Symbol.iterator] === "function",
    "missing NodeList iterator installed by initial sweep",
  );
  const inst = new env.win.NodeList();
  inst[0] = "a";
  inst[1] = "b";
  inst.length = 2;
  ok([...inst].join("") === "ab", "installed iterator walks indices 0..length");
}

// --- 2. setter trap patches a REASSIGNED constructor synchronously ----------
{
  const env = makeEnv();
  env.run(bootBlock);
  const st = env.win.__shellIterFix;
  ok(st.trapped >= 2, "setter traps armed on present constructors");
  function Wrapper() {}
  ok(
    typeof Wrapper.prototype[Symbol.iterator] === "undefined",
    "precondition: wrapper prototype not iterable",
  );
  env.win.NodeList = Wrapper; // the clobber
  ok(st.trapHits >= 1, "trap saw the reassignment");
  ok(
    typeof Wrapper.prototype[Symbol.iterator] === "function",
    "trap patched the REPLACEMENT prototype synchronously (no timer needed)",
  );
  ok(env.win.NodeList === Wrapper, "trap getter returns the new constructor");
}

// --- 3. armed latch: re-execution doesn't stack intervals --------------------
{
  const env = makeEnv();
  env.run(bootBlock);
  const before = env.intervals.length;
  env.run(bootBlock); // simulate the rewritten-document copy executing
  const st = env.win.__shellIterFix;
  ok(
    env.intervals.length === before,
    "second execution arms no additional interval (armed latch)",
  );
  ok(st.pass >= 2, "second execution still contributes an immediate sweep");
}

// --- 4. backstop cadence shape ----------------------------------------------
{
  const env = makeEnv();
  env.run(bootBlock);
  ok(
    env.intervals.some((iv) => iv.ms === 250),
    "fast 250ms backstop interval armed",
  );
  const drop = env.timeouts.find((t) => t.ms === 90000);
  ok(!!drop, "90s downshift timeout armed");
  if (drop) {
    drop.cb();
    ok(
      env.intervals.some((iv) => iv.ms === 3000),
      "downshift arms 3s maintenance interval",
    );
  }
}

if (failures) {
  console.error("\n" + failures + " iterator-resweep check(s) FAILED");
  process.exit(1);
}
console.log("\nALL ITERATOR-RESWEEP CHECKS PASS");
