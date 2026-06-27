// JEL-38 verification test — Babel transpilation of modern syntax in
// server-injected PLUGIN scripts, for legacy Chromium TVs (Tizen 5.0 / M56,
// Tizen 5.5 / M69), compared against a modern browser.
//
// What the ticket asks us to prove, per modern token named in JEL-38
// (optional chaining `?.`, nullish `??`, private class fields `#field`,
// BigInt literals `10n`, optional catch binding `catch{}` — plus the other
// tokens the shell's denylist guards: `||=`/`&&=`/`??=`, numeric separators):
//
//   1. DETECTION  — MODERN_SYNTAX_RE (the shell's needsTranspile() gate) must
//      MATCH the token. A token the regex misses is classified ES5-safe and
//      written RAW into the page -> SyntaxError on Chromium 56 (this is the
//      exact JEL-23 / JEL-27 `catch{}` failure mode).
//   2. LOWERING   — driving the SHIPPED babel.min.js with the EXACT transform
//      options the shell's plugin path uses, the token must be lowered to code
//      a legacy engine can PARSE. We prove this WITHOUT relying on the host
//      Node engine's native support: a correctly-lowered body must no longer
//      match MODERN_SYNTAX_RE (i.e. no M56/M63-fatal token survives).
//   3. SEMANTICS  — the lowered body must compute the SAME value the modern
//      source would ("runs without errors on TV that work in a modern
//      browser"). We execute it and compare to the expected result.
//   4. PARITY     — the TV shell (shell-tizen/src/shell.js) and the hosted /
//      bootstrap shell (shell-tizen-bootstrap/src/boot-shell.src.js) must use
//      the SAME regex and the SAME transform-options key, and BOTH shipped
//      babel bundles must lower identically. This is the "Compare" half.
//
// KNOWN LIMITATION (documented + asserted, not a regression): BigInt literals
// (`10n`) are DETECTED by the regex but Babel CANNOT lower them — BigInt is a
// runtime type, not syntactic sugar, and preset-env has no transform that
// emits an M56/M63-runnable equivalent. So a plugin using genuine BigInt
// literals would still fail on the TV even after a transpile pass. The regex
// still *detecting* `10n` is correct (conservative denylist); the limitation is
// in Babel, and no jellyfin-web builtin/server plugin uses BigInt. This test
// pins that reality so a future change to the regex/options can't silently
// imply BigInt is "handled".
//
// Run: node scripts/plugin-syntax-transpile.test.cjs
//   or: pnpm --filter @jellyfin-tv/shell-tizen test

const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..", "..", "..");
const TV_SHELL = path.join(REPO, "packages", "shell-tizen", "src", "shell.js");
const HOSTED_SHELL = path.join(
  REPO,
  "packages",
  "shell-tizen-bootstrap",
  "src",
  "boot-shell.src.js",
);
const TV_BABEL = path.join(
  REPO,
  "packages",
  "shell-tizen",
  "src",
  "babel.min.js",
);
const HOSTED_BABEL = path.join(
  REPO,
  "packages",
  "shell-tizen-bootstrap",
  "src",
  "babel.min.js",
);

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log("OK: " + name);
  } else {
    console.error("FAIL: " + name);
    failures++;
  }
}

// --- Extract the live denylist regex + opts-key from each shell source -------
// Pull the value out of source rather than hardcoding, so this test fails if a
// shell edit drops a token or the two shells drift apart.
function extractStringAfter(src, anchor) {
  const i = src.indexOf(anchor);
  if (i === -1) return null;
  // First double-quoted JS string literal after the anchor.
  const m = src.slice(i).match(/"((?:[^"\\]|\\.)*)"/);
  return m ? JSON.parse('"' + m[1] + '"') : null;
}

const tvSrc = fs.readFileSync(TV_SHELL, "utf8");
const hostedSrc = fs.readFileSync(HOSTED_SHELL, "utf8");

const tvReSrc = extractStringAfter(tvSrc, "MODERN_SYNTAX_RE_SRC");
const hostedReSrc = extractStringAfter(hostedSrc, "MODERN_SYNTAX_RE_SRC");
const tvOptsKey = extractStringAfter(tvSrc, "BABEL_OPTS_KEY");
const hostedOptsKey = extractStringAfter(hostedSrc, "BABEL_OPTS_KEY");

check("TV shell exposes MODERN_SYNTAX_RE_SRC", !!tvReSrc);
check("hosted shell exposes MODERN_SYNTAX_RE_SRC", !!hostedReSrc);
check(
  "PARITY: both shells use the SAME MODERN_SYNTAX_RE_SRC",
  tvReSrc != null && tvReSrc === hostedReSrc,
);
check(
  "PARITY: both shells use the SAME BABEL_OPTS_KEY",
  tvOptsKey != null && tvOptsKey === hostedOptsKey,
);

const MODERN_RE = new RegExp(tvReSrc || "x");

// EXACT transform options the shell's plugin transpile() uses (shell.js /
// boot-shell.src.js). The opts-key extracted above is the cache-derivation
// string for these; keep this literal in lockstep with it.
// JEL-354: target is chrome:56 (the documented runtime floor), NOT 63 — a 63
// target leaves ES2018 syntax (object-spread, async generators) un-lowered,
// which then SyntaxErrors on the Chromium-56 Q60R panels. Assert below that
// the extracted BABEL_OPTS_KEY actually carries chrome:56 so a future target
// drift can't pass this test silently.
const OPTS = {
  presets: [
    ["env", { targets: { chrome: "56" }, modules: false, loose: true }],
  ],
  assumptions: { iterableIsArray: true, arrayLikeIsIterable: true },
  sourceType: "script",
  compact: true,
  comments: false,
};
check(
  "JEL-354: BABEL_OPTS_KEY targets chrome:56 (runtime floor), not 63",
  typeof tvOptsKey === "string" &&
    /targets:\{chrome:56\}/.test(tvOptsKey) &&
    !/chrome:63/.test(tvOptsKey),
);

// --- The token matrix from JEL-38 -------------------------------------------
// `lowerable: false` => Babel cannot emit an M56/M63-runnable form (BigInt).
const CASES = [
  {
    name: "optional chaining ?.",
    src: "var o={a:{b:5}};var r=o?.a?.b;",
    probe: "r",
    expect: 5,
    lowerable: true,
  },
  {
    name: "nullish coalescing ??",
    src: 'var x=null;var r=x ?? "fallback";',
    probe: "r",
    expect: "fallback",
    lowerable: true,
  },
  {
    name: "logical assignment ||=",
    src: "var x=0;x||=7;var r=x;",
    probe: "r",
    expect: 7,
    lowerable: true,
  },
  {
    name: "numeric separator 1_000",
    src: "var r=1_000+1;",
    probe: "r",
    expect: 1001,
    lowerable: true,
  },
  {
    name: "private class field #field",
    src: "class C{#v=42;read(){return this.#v;}}var r=new C().read();",
    probe: "r",
    expect: 42,
    lowerable: true,
  },
  {
    name: "optional catch binding catch{}",
    src: 'var r="ok";try{throw 1;}catch{r="caught";}',
    probe: "r",
    expect: "caught",
    lowerable: true,
  },
  // JEL-354: ES2018 syntax Chrome 56 cannot parse. object-spread is extremely
  // common in server plugins ({...defaults,...opts}); a 63 target left it raw.
  {
    name: "object spread {...a,b}",
    src: "var d={a:1};var o={...d,b:2};var r=o.a+o.b;",
    probe: "r",
    expect: 3,
    lowerable: true,
  },
  {
    name: "object rest {x,...rest}",
    src: "var o={x:1,y:2,z:3};var {x,...rest}=o;var r=rest.y+rest.z;",
    probe: "r",
    expect: 5,
    lowerable: true,
  },
  {
    name: "object spread (leading only) {...a}",
    src: "var a={p:7};var o={...a};var r=o.p;",
    probe: "r",
    expect: 7,
    lowerable: true,
  },
  {
    name: "async generator async function*",
    src: "async function* gen(){yield 1;}var r=typeof gen;",
    probe: "r",
    expect: "function",
    lowerable: true,
  },
  {
    name: "async generator method async *m()",
    src: "var o={async *gen(){yield 1;}};var r=typeof o.gen;",
    probe: "r",
    expect: "function",
    lowerable: true,
  },
  {
    name: "for await...of",
    src: "async function h(s){var t=0;for await(const v of s){t+=v;}return t;}var r=typeof h;",
    probe: "r",
    expect: "function",
    lowerable: true,
  },
  {
    name: "BigInt literal 10n",
    src: "var r=(10n+5n).toString();",
    probe: "r",
    expect: "15",
    lowerable: false, // documented limitation — see header
  },
];

// --- Load both shipped babel bundles ----------------------------------------
function loadBabel(file) {
  const code = fs.readFileSync(file, "utf8");
  global.window = {};
  // Indirect eval -> global scope with real built-ins, the way a <script> runs.
  (0, eval)(code);
  return global.window.Babel || global.Babel || globalThis.Babel;
}

function runEquiv(transpiled, probe) {
  const fn = new Function(transpiled + "\nreturn (" + probe + ");");
  return fn();
}

const BUNDLES = [
  { label: "TV bundle (shell-tizen)", file: TV_BABEL },
  { label: "hosted bundle (bootstrap)", file: HOSTED_BABEL },
];

for (const b of BUNDLES) {
  console.log("\n--- " + b.label + " ---");
  let Babel;
  try {
    Babel = loadBabel(b.file);
  } catch (e) {
    check(b.label + ": babel.min.js loads/parses", false);
    console.error("   load error: " + e.message);
    continue;
  }
  check(
    b.label + ": exposes Babel.transform",
    Babel && typeof Babel.transform === "function",
  );
  if (!Babel || typeof Babel.transform !== "function") continue;

  for (const c of CASES) {
    // 1. DETECTION — the shell's gate must flag this token for transpile.
    check(b.label + " | DETECT " + c.name, MODERN_RE.test(c.src));

    // 2. LOWERING — transpile with the shell's exact options.
    let out = null;
    let txErr = null;
    try {
      out = Babel.transform(c.src, OPTS).code;
    } catch (e) {
      txErr = e.message;
    }
    check(b.label + " | TRANSFORM ok " + c.name, txErr == null && out != null);
    if (out == null) {
      if (txErr) console.error("   transform error: " + txErr);
      continue;
    }

    if (c.lowerable) {
      // The true "runs on M56/M63" proof: no fatal token survives. We use the
      // shell's OWN regex on the OUTPUT — independent of the host engine's
      // native support — so a token Node happens to support can't hide here.
      check(
        b.label + " | LOWERED clean (no M56/M63-fatal token left) " + c.name,
        !MODERN_RE.test(out),
      );
      // 3. SEMANTICS — same result as a modern browser.
      let got, runErr;
      try {
        got = runEquiv(out, c.probe);
      } catch (e) {
        runErr = e.message;
      }
      check(
        b.label + " | SEMANTICS " + c.name + " => " + JSON.stringify(c.expect),
        runErr == null && got === c.expect,
      );
      if (runErr) console.error("   run error: " + runErr);
    } else {
      // BigInt: documented limitation. Pin that Babel does NOT lower it (the
      // literal survives), so this test loudly flags any future assumption
      // that BigInt is handled. NOT counted as semantic success.
      check(
        b.label +
          " | BigInt NOT lowered (documented limitation: would fail on M56/M63) " +
          c.name,
        MODERN_RE.test(out) && /10n/.test(out),
      );
    }
  }
}

// --- JEL-354: ES2015 spread/rest forms must NOT be flagged -------------------
// Array spread, call spread, and rest params are ES2015 — Chromium 56 parses
// them natively, and Babel at the chrome:56 target passes them through
// UNCHANGED. The pre-check regex also doubles as the "fully lowered" oracle
// (the LOWERED-clean assertions above), so if it matched these forms a
// correctly-lowered body that still contains `[...a]` would falsely read as
// un-lowered. Pin that the object-spread additions did not over-reach into
// array/call spread.
const NON_MODERN = [
  { name: "array spread [...a]", src: "var a=[1,2];var b=[...a,3];" },
  { name: "call spread f(...a)", src: "function f(a,b){}f(...[1,2]);" },
  {
    name: "rest param (a,...rest)",
    src: "function g(a,...rest){return rest.length;}",
  },
];
for (const c of NON_MODERN) {
  check(
    "JEL-354: ES2015 " + c.name + " is NOT flagged (Chrome-56-native)",
    !MODERN_RE.test(c.src),
  );
}

if (failures) {
  console.error("\n" + failures + " CHECK(S) FAILED");
  process.exit(1);
}
console.log("\nALL JEL-38 PLUGIN-SYNTAX TRANSPILE CHECKS PASS");
