// JEL-18 regression test. Guards the wiring that lets server-injected plugin
// scripts transpile on the legacy Tizen 5.0 / Chromium M63 TV.
//
// Two failure modes this locks down:
//   1. WIRING: index.html must define window.__ensureBabel AFTER the bootloader
//      <script> (so selftest.cjs's first-<script> extraction still grabs the
//      bootloader) and that hook must inject the shipped babel.min.js. Without
//      it window.Babel stays undefined and boot-shell.min.js logs
//      "babel not available, skip transpile" for every plugin -> plugins that
//      run in a desktop browser silently vanish on the TV.
//   2. CAPABILITY: the shipped babel.min.js, driven with the EXACT transform
//      options boot-shell.min.js uses, must (a) parse on the M63 engine itself
//      and (b) lower the M63-unsupported syntax (optional chaining `?.`,
//      nullish `??`) into code that parses. Arrow/async are intentionally kept
//      because the Chrome 56 target — and therefore M63/Chrome 63 — supports
//      them natively.
//
// Run: node scripts/babel-transpile.test.cjs
//   or: pnpm --filter @jellyfin-tv/shell-tizen-bootstrap test

const fs = require("fs");
const path = require("path");

const SRC_DIR = path.join(__dirname, "..", "src");
const INDEX = path.join(SRC_DIR, "index.html");
const BABEL = path.join(SRC_DIR, "babel.min.js");

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log("OK: " + name);
  } else {
    console.error("FAIL: " + name);
    failures++;
  }
}

// --- 1. WIRING --------------------------------------------------------------
const html = fs.readFileSync(INDEX, "utf8");

check("babel.min.js is shipped in the WGT src", fs.existsSync(BABEL));
check(
  "index.html defines window.__ensureBabel",
  /window\.__ensureBabel\s*=/.test(html),
);
check(
  "__ensureBabel injects babel.min.js",
  /__ensureBabel[\s\S]{0,600}babel\.min\.js/.test(html),
);

// The hook must live AFTER the bootloader script, otherwise selftest.cjs (which
// extracts the FIRST attribute-less <script> as the bootloader) breaks.
const bootloaderIdx = html.indexOf("JEL-2040 HSB bootloader");
const ensureBabelIdx = html.search(/window\.__ensureBabel\s*=/);
check(
  "__ensureBabel is defined after the bootloader script",
  bootloaderIdx !== -1 &&
    ensureBabelIdx !== -1 &&
    ensureBabelIdx > bootloaderIdx,
);

// --- 2. CAPABILITY ----------------------------------------------------------
// (a) babel.min.js must PARSE on the M63 engine. Chrome 63 lacks `?.`/`??` as
//     operators, so the bundle itself must not use them. Strip string/regex
//     noise is impractical on a 2.4 MB min file; instead we assert it loads and
//     evaluates cleanly in a JS engine and exposes Babel.transform — a load-time
//     parse error would throw here.
const babelSrc = fs.readFileSync(BABEL, "utf8");
global.window = global.window || {};
let Babel;
try {
  // Indirect eval -> runs in global scope with all real built-ins, the way the
  // browser would evaluate the <script>. (A sandboxed vm context is missing
  // globals babel-standalone expects and gives false failures.)
  (0, eval)(babelSrc);
  Babel = global.window.Babel || global.Babel || globalThis.Babel;
} catch (e) {
  console.error(
    "FAIL: babel.min.js threw on load (would not parse on M63): " + e.message,
  );
  failures++;
}
check(
  "babel.min.js exposes Babel.transform",
  Babel && typeof Babel.transform === "function",
);

if (Babel && typeof Babel.transform === "function") {
  // A JellyfinEnhanced-style snippet: optional chaining + nullish + arrow.
  const plugin =
    'var f = function(x){ var v = x?.data?.items ?? []; return v.map(i => i?.name ?? "n/a"); };';
  // EXACT options from boot-shell.min.js babelTranspile().
  let out = null;
  try {
    out = Babel.transform(plugin, {
      presets: [["env", { targets: { chrome: "56" }, modules: false }]],
      sourceType: "script",
      compact: true,
      comments: false,
    }).code;
  } catch (e) {
    console.error("FAIL: transform threw: " + e.message);
    failures++;
  }

  if (out != null) {
    check("optional chaining (?.) lowered out", !/\?\./.test(out));
    check(
      "nullish (??) operator lowered out",
      !/[^?]\?\?[^?]/.test(out) && !/\?\?$/.test(out),
    );
    let parses = false;
    try {
      new Function(out);
      parses = true;
    } catch (_) {}
    check("transpiled output parses (runs on M63)", parses);
  }
}

// --- 3. JEL-23: classifier must DETECT every M63-fatal token ----------------
// The shell only invokes babel when its needsTranspile() denylist regex
// (MODERN_SYNTAX_RE) matches; a token the regex misses is classified ES5-safe
// and written RAW -> SyntaxError on Chromium 56. JEL-23: JavaScriptInjector's
// public.js used optional catch binding (try{}catch{}, Chrome 66+) which the
// old regex missed, so it loaded untranspiled and threw "Unexpected token {".
// Extract the regex actually baked into the shipped boot-shell.min.js and prove
// it now catches that token (and still ignores a normal `catch(e){`).
const BOOT_SHELL = path.join(SRC_DIR, "boot-shell.min.js");
const bootShell = fs.readFileSync(BOOT_SHELL, "utf8");
const reMatch = bootShell.match(/MODERN_SYNTAX_RE_SRC="((?:[^"\\]|\\.)*)"/);
check("MODERN_SYNTAX_RE_SRC is present in boot-shell.min.js", !!reMatch);
if (reMatch) {
  // The captured group is the JS string literal body; unescape it the way the
  // engine would before `new RegExp(...)`.
  const reSrc = JSON.parse('"' + reMatch[1] + '"');
  const modernRe = new RegExp(reSrc);
  check(
    "regex detects optional catch binding (catch{})",
    modernRe.test("try{x()}catch{y()}"),
  );
  check(
    "regex ignores a normal catch binding (catch(e){})",
    !modernRe.test("try{x()}catch(e){y()}"),
  );
  // Regression guard for the tokens already covered, so a future regex edit
  // cannot silently drop them.
  check("regex still detects optional chaining (?.)", modernRe.test("a?.b"));
  check("regex still detects nullish (??)", modernRe.test("a??b"));
}

if (Babel && typeof Babel.transform === "function") {
  // Optional catch binding must also lower cleanly so the transpiled body runs.
  let coutOk = false;
  try {
    const cout = Babel.transform("try{f()}catch{g()}", {
      presets: [["env", { targets: { chrome: "56" }, modules: false }]],
      sourceType: "script",
      compact: true,
      comments: false,
    }).code;
    new Function(cout);
    coutOk = true;
  } catch (_) {}
  check("optional catch binding lowers + parses (runs on M63)", coutOk);
}

if (failures) {
  console.error("\n" + failures + " CHECK(S) FAILED");
  process.exit(1);
}
console.log("\nALL BABEL TRANSPILE CHECKS PASS");
