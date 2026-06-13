// JEL-143 debug-variant build test. Asserts build_bootstrap.py produces two
// distinct WGTs:
//   - JellyPlug.wgt        — retail, index.html byte-identical to src.
//   - JellyPlug-Debug.wgt  — debug, with a seed <script> injected as the FIRST
//     element of <body> (before the bootloader IIFE) that turns on BOTH
//     diagnostic overlays via localStorage. Executing that seed must set
//     jellyfin.shell.debug='1' and jellyfin.shell.hsbDebug='1'.
//
// Run: node packages/shell-tizen-bootstrap/scripts/debug-variant.test.cjs

const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { execFileSync } = require("child_process");

const PKG = path.join(__dirname, "..");
const BUILD = path.join(__dirname, "build_bootstrap.py");
const SRC_INDEX = path.join(PKG, "src", "index.html");

function fail(msg) {
  console.error("FAIL:", msg);
  process.exit(1);
}

// Read index.html out of a .wgt (a zip) without external `unzip`.
function readIndexFromWgt(wgt) {
  const out = execFileSync(
    "python3",
    [
      "-c",
      'import sys,zipfile;print(zipfile.ZipFile(sys.argv[1]).read("index.html").decode("utf-8"),end="")',
      wgt,
    ],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  return out;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jel143-"));

// Build both variants (unsigned raw zips — enough to inspect payload).
// --no-manifest so this throwaway build never rewrites the committed
// manifest.bootstrap.json (which always lands in the package root).
execFileSync("python3", [BUILD, "--out", tmp, "--no-manifest"], {
  stdio: "ignore",
});
execFileSync("python3", [BUILD, "--debug", "--out", tmp, "--no-manifest"], {
  stdio: "ignore",
});

const retailWgt = path.join(tmp, "JellyPlug.wgt");
const debugWgt = path.join(tmp, "JellyPlug-Debug.wgt");

if (!fs.existsSync(retailWgt))
  fail("retail build did not produce JellyPlug.wgt");
if (!fs.existsSync(debugWgt))
  fail("debug build did not produce JellyPlug-Debug.wgt");

const srcIndex = fs.readFileSync(SRC_INDEX, "utf8");
const retailIndex = readIndexFromWgt(retailWgt);
const debugIndex = readIndexFromWgt(debugWgt);

// 1. Retail index.html is byte-identical to the committed source.
if (retailIndex !== srcIndex)
  fail("retail index.html differs from src/index.html (must be untouched)");

// 2. Debug seed marker present in debug, absent in retail.
const MARKER = "JellyPlug-Debug build (JEL-143)";
if (retailIndex.includes(MARKER)) fail("retail WGT leaked the debug seed");
if (!debugIndex.includes(MARKER)) fail("debug WGT is missing the debug seed");

// 3. Seed runs BEFORE the bootloader: its <script> index precedes the first
//    other <script> (the bootloader IIFE) in document order.
const seedPos = debugIndex.indexOf("<script>/* " + MARKER);
const bodyPos = debugIndex.indexOf("<body>");
const firstScriptAfterBody = debugIndex.indexOf("<script>", bodyPos);
if (seedPos < 0) fail("debug seed <script> not found");
if (seedPos !== firstScriptAfterBody)
  fail("debug seed is not the first <script> in <body>");

// 4. Executing the seed body sets BOTH overlay flags.
const seedMatch = debugIndex
  .slice(seedPos)
  .match(/<script>([\s\S]*?)<\/script>/);
if (!seedMatch) fail("could not extract debug seed script body");
const store = {};
const sandbox = {
  localStorage: {
    setItem: (k, v) => {
      store[k] = String(v);
    },
    getItem: (k) => (k in store ? store[k] : null),
  },
};
vm.runInNewContext(seedMatch[1], sandbox);
if (store["jellyfin.shell.debug"] !== "1")
  fail("seed did not set jellyfin.shell.debug='1'");
if (store["jellyfin.shell.hsbDebug"] !== "1")
  fail("seed did not set jellyfin.shell.hsbDebug='1'");

// 5. The two WGTs are actually different bytes.
if (fs.readFileSync(retailWgt).equals(fs.readFileSync(debugWgt))) {
  fail("retail and debug WGTs are byte-identical");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(
  "PASS: build_bootstrap.py emits distinct retail + debug WGTs; debug seed enables both overlays",
);
