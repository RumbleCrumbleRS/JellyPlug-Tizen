// JEL-644: guards for the packages/shell-core extraction mechanism.
//
// Proves the marker/fragment plumbing is self-consistent and that the two
// expand() implementations (expand.py for build/verify, expand.cjs for the
// parity guard + test loader) agree byte-for-byte. The zero-shipped-byte
// property itself is proven by verify_shell_src.py / verify_boot_shell_src.py;
// this test protects the layer beneath them:
//
//   1. Every //@@SHELL_CORE:name@@ marker in each entry file resolves to a
//      fragment (no dangling markers -> expand() would throw at build time).
//   2. Every shell-core fragment is referenced by a marker in BOTH entry files
//      (no orphaned/half-wired fragment silently dropped from a shell).
//   3. Each fragment is a single named function declaration matching its name
//      and re-parses (catches a botched extraction).
//   4. expand.py and expand.cjs produce identical expansions of both entry
//      files (the two grammars cannot drift).
//
// Run: node packages/shell-core/scripts/expand.test.cjs

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { transformSync } = require("esbuild");
const { expand, loadFragments, markerNames } = require("../expand.cjs");

const ROOT = path.join(__dirname, "..", "..");
const RETAIL = path.join(ROOT, "shell-tizen", "src", "shell.js");
const BOOT = path.join(ROOT, "shell-tizen-bootstrap", "src", "boot-shell.src.js");
const CORE = path.join(__dirname, "..", "src", "shell-core.src.js");
const EXPAND_PY = path.join(__dirname, "..", "expand.py");

let failures = 0;
function fail(msg) {
  console.error("FAIL: " + msg);
  failures++;
}

const fragments = loadFragments();
const fragNames = Object.keys(fragments);
if (fragNames.length === 0) fail("no fragments parsed from shell-core.src.js");

const retailSrc = fs.readFileSync(RETAIL, "utf8");
const bootSrc = fs.readFileSync(BOOT, "utf8");
const retailMarkers = markerNames(retailSrc);
const bootMarkers = markerNames(bootSrc);

// 1. Every marker resolves to a fragment (expand throws otherwise).
for (const [label, names] of [
  ["shell.js", retailMarkers],
  ["boot-shell.src.js", bootMarkers],
]) {
  for (const n of names) {
    if (!(n in fragments))
      fail(label + ": marker " + n + " has no shell-core fragment");
  }
}

// 2. No orphan fragments: each fragment must be wired into BOTH shells.
const rSet = new Set(retailMarkers);
const bSet = new Set(bootMarkers);
for (const n of fragNames) {
  if (!rSet.has(n)) fail("fragment " + n + " is not referenced by shell.js");
  if (!bSet.has(n))
    fail("fragment " + n + " is not referenced by boot-shell.src.js");
}
// And no duplicate markers within a file (would double-inject).
for (const [label, names] of [
  ["shell.js", retailMarkers],
  ["boot-shell.src.js", bootMarkers],
]) {
  const seen = new Set();
  for (const n of names) {
    if (seen.has(n)) fail(label + ": duplicate marker for " + n);
    seen.add(n);
  }
}

// 3. Each fragment is a single named function declaration and re-parses.
for (const n of fragNames) {
  const body = fragments[n];
  if (!new RegExp("^\\s*function " + n + "\\s*\\(").test(body))
    fail("fragment " + n + " does not start with `function " + n + "(`");
  try {
    transformSync(body, { loader: "js" });
  } catch (e) {
    fail("fragment " + n + " does not parse: " + e.message.split("\n")[0]);
  }
}

// 4. expand.py and expand.cjs agree on both entry files.
function expandPy(file) {
  return execFileSync(
    "python3",
    [
      "-c",
      "import sys; sys.path.insert(0, sys.argv[1]); import expand; " +
        "sys.stdout.write(expand.expand(open(sys.argv[2], encoding='utf-8').read()))",
      path.join(__dirname, ".."),
      file,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
}
for (const [label, file, src] of [
  ["shell.js", RETAIL, retailSrc],
  ["boot-shell.src.js", BOOT, bootSrc],
]) {
  const js = expand(src);
  let py;
  try {
    py = expandPy(file);
  } catch (e) {
    fail("expand.py failed on " + label + ": " + String(e.message).split("\n")[0]);
    continue;
  }
  if (js !== py)
    fail("expand.py and expand.cjs disagree on " + label + " (length js=" + js.length + " py=" + py.length + ")");
}

if (failures) {
  console.error("\nshell-core expand: " + failures + " failure(s)");
  process.exit(1);
}
console.log(
  "shell-core expand OK: " +
    fragNames.length +
    " fragments, wired into both shells, expand.py ≡ expand.cjs",
);
