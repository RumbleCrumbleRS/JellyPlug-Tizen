// JEL-624 cross-shell mirror-parity guard.
//
// shell.js (retail, hosted /shell/ drop) and boot-shell.src.js (HSB baked
// fallback) are hand-mirrored: dozens of functions are marked "lockstep with
// shell.js" / "mirror" in comments, but until this test NOTHING enforced it —
// verify_shell_src.py / verify_boot_shell_src.py only check src<->min WITHIN
// one package, so a fix applied to one shell and missed in the other shipped
// silently (it happened: JEL-178's txKey buster-stripping and the JEL-137-era
// alreadyRan() defer-watchdog double-run guard each live in only ONE shell —
// see INTENTIONAL_DIVERGENCES below).
//
// Mechanism — text equality is useless here (boot-shell.src.js is a
// compressed-style variant: comma-chained vars, `x||(x=y)` for `if(!x)x=y`),
// so both files are canonicalized through esbuild instead:
//
//   1. Whole-file pass: minifySyntax + target:es5. Kills comments, lowers
//      template literals (strings become single-line), and normalizes the
//      style deltas above, while keeping pretty-printed 2-space indentation.
//   2. Named function declarations are extracted from that output by
//      line-scanning (a declaration always starts its own line; string
//      literals can no longer span lines, so the brace-matching cannot be
//      fooled by JS-in-strings like the seed-script bodies).
//   3. Each function is then fully minified; two functions are "mirrored"
//      when those minified bytes are byte-identical. Local-variable names
//      are minified away, so consistent renames don't count as drift.
//
// Contract enforced:
//   - Every name in EXPECTED_MIRRORED exists in BOTH shells and is
//     canonically identical. (Catches: fix applied to one shell only,
//     one-sided rename/delete.)
//   - Every name in INTENTIONAL_DIVERGENCES exists in both shells, is NOT
//     identical (stale-entry guard), and each side's canonical hash matches
//     its pin. (Catches: editing a divergent-but-mirrored function on one
//     side without consciously re-pinning — the same silent-drift failure,
//     just for functions that legitimately differ.)
//   - Any OTHER function name shared by both shells must be canonically
//     identical (new mirrored functions are auto-guarded the moment they
//     appear in both files).
//   - LOCKSTEP_CONSTS (transpiler regexes / babel opts / cache epoch) are
//     literal-equal across shells.
//
// Version literals: boot-shell bakes the real widget version ("2.0.18")
// where retail uses the __SHELL_VER__ build substitution (JEL-332/379).
// Before hashing, the boot config.xml version is rewritten to __SHELL_VER__
// so release version bumps do not churn the pins (scenario12/13 in
// selftest.cjs already assert the literals match config.xml).
//
// Maintenance:
//   - Changed a mirrored function? Apply the SAME change to both
//     packages/shell-tizen/src/shell.js and
//     packages/shell-tizen-bootstrap/src/boot-shell.src.js.
//   - Changed an intentionally-divergent function (on both sides, on
//     purpose)? Re-pin: node cross-shell-parity.test.cjs --print-pins
//     and paste the emitted block over EXPECTED_MIRRORED /
//     INTENTIONAL_DIVERGENCES below. Pins also churn if the workspace
//     esbuild version changes minify output — same re-pin procedure, but
//     ONLY do it when the shell sources are untouched by your change.
//   - A divergent function converged (drift reconciled)? The stale-entry
//     guard fails; move the name to EXPECTED_MIRRORED.
//
// Run: node packages/shell-tizen-bootstrap/scripts/cross-shell-parity.test.cjs

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { transformSync } = require("esbuild");

const BOOT_SRC = path.join(__dirname, "..", "src", "boot-shell.src.js");
const RETAIL_SRC = path.join(
  __dirname,
  "..",
  "..",
  "shell-tizen",
  "src",
  "shell.js",
);
const CONFIG_XML = path.join(__dirname, "..", "src", "config.xml");

// Functions that are mirrored 1:1 today. Each must exist in both shells and
// stay canonically identical. Add new shared functions here when you mirror
// them (unlisted shared names are checked identical anyway; listing guards
// against a one-sided rename/delete dropping the name out of the shared set).
const EXPECTED_MIRRORED = [
  "withBootTimeout",
  "txFnv1a",
  "readBundlePatchState",
  "writeBundlePatchState",
  "webCacheEnabled",
  "readWebIndexCache",
  "readWebConfigCache",
  "writeWebConfigCache",
  "loadServerUrl",
  "saveServerUrl",
  "clearServerUrl",
  "normalizeServerUrl",
  "validateServer",
  "registerRemoteKeys",
  "installBackHandler",
  "exitApp",
  "generateDeviceId",
  "getDeviceId",
  "getSystemInfo",
  "isLegacyChromium",
  "isJellyfinWebBundle",
  "shellLog",
  "babelTranspile",
  "needsJQueryGate",
  "wrapForJQuery",
  "chromium56PolyfillBody",
  "injectChromium56Polyfills",
  "injectQaBeacon",
  "bootProgressBody",
  "injectBootProgress",
  "jsiChannelDisabled",
  "jsiChannelPath",
  "injectJsInjectorChannel",
  "txGetStatic",
  "txSetStatic",
  "txDropDisabled",
  "loadTxDropManifest",
  "txDropResolve",
  "needsTranspile",
  "neutralizeUntranspiled",
  "ensureBabelReady",
  "buildBundleSourcePatcher",
  "escAttr",
  "bail",
  "markDocumentWrite",
  "restoreCredsVault",
  "fin",
  "settle",
  "showError",
  "injectConnectStylesheet",
  "attachConnectForm",
  "bootstrap",
];

// Functions that exist in both shells but legitimately differ. Every entry
// pins BOTH canonical hashes: editing either side without updating the pin
// fails CI, forcing the "did you mirror this?" question at review time.
// `class` is documentation: "hsb-feature" = boot-shell-only capability the
// retail shell intentionally lacks (usually blocked on the 128 KiB
// shell.min.js cap), "cosmetic" = semantically equal but esbuild cannot
// prove it, "drift" = KNOWN unreconciled divergence with a ticket.
const INTENTIONAL_DIVERGENCES = [
  {
    name: "writeWebIndexCache",
    class: "cosmetic",
    why: "retail `!(indexOf(...) >= 0)` vs boot `indexOf(...) < 0` — semantically equal (indexOf never NaN) but esbuild rightly won't rewrite `!(x>=0)` to `x<0`; align text when either side is next touched",
    retail: "09ea8abe5fb3c8ff",
    boot: "ebedff5fe1cedae0",
  },
  {
    name: "resolveDeviceName",
    class: "cosmetic",
    why: "retail wraps assignment in `(x = v, x)` sequence where boot returns the bare assignment expression — same value, different tokens; align text when either side is next touched",
    retail: "96b484d0dddbb667",
    boot: "e29de17205594eed",
  },
  {
    name: "buildSeedScript",
    class: "hsb-feature",
    why: "boot's seeded snippet gates plugin transpile on __ensureBabel() (HSB lazy-babel) and adds CSS:/FP: HUD rows; retail lacks the lazy-babel machinery (shell.min.js size cap)",
    // Re-pinned JEL-621: tx-drop resolver (__txResolve/__txDropGet) seeded into
    // both shells; divergence class unchanged (still hsb-feature).
    retail: "d1502ef55fac7fee",
    boot: "e85e83a832f7efcf",
  },
  {
    name: "buildDiagSeedScript",
    class: "hsb-feature",
    why: "boot HUD adds VB:/CSS: rows + pbl counter for its vendors-bundle/stylesheet caches, which retail does not have",
    retail: "47af3c01f68d0843",
    boot: "0c874c1d71f7bece",
  },
  {
    name: "qaBeaconBody",
    class: "hsb-feature",
    why: "retail returns the __QA_BEACON_BODY__ build-substitution placeholder (stripped in prod by qa-seed-strip); boot inlines the full JEL-1971 beacon body",
    retail: "41eab6ce5e73ed72",
    boot: "7d80607cd31d4d23",
  },
  {
    name: "txKey",
    class: "drift",
    why: "KNOWN DRIFT (JEL-630): retail strips only timestamp-like cache-buster params (JEL-178 PR#5); boot truncates the whole query string — and diverges from its own seeded __txKey which HAS the retail logic. Reconcile, then move to EXPECTED_MIRRORED",
    retail: "3bb0286276a6597e",
    boot: "032334d85af6da6a",
  },
  {
    name: "transpileLegacyScripts",
    class: "hsb-feature",
    why: "fast-path stability check counts boot-only pluginBabelLazy vs retail babelLazyTriggered — entangled with HSB lazy-babel; unify in shell-core extraction",
    retail: "59a159693c71a78d",
    boot: "4331928eaf0e5289",
  },
  {
    name: "transpileLegacyScriptsInner",
    class: "hsb-feature",
    why: "boot adds recordStylesheetBodies() capture + pluginBabelLazy counter for HSB stylesheet/lazy-babel caches",
    // Re-pinned JEL-618 (channel-cache walker skip + record hooks) and
    // JEL-621 (tx-drop resolve path + drop-hit channel-cache seed) — both
    // landed in BOTH shells; divergence class unchanged.
    retail: "97128e7cd7493763",
    boot: "24ac3385828aefc3",
  },
  {
    name: "patchPlaybackBundles",
    class: "hsb-feature",
    why: "boot integrates its vendors-bundle localStorage cache into bundle patching; retail has no vendors cache",
    retail: "62a5ed8218434b0f",
    boot: "fda5e5504252e1c3",
  },
  {
    name: "armDeferWatchdog",
    class: "drift",
    why: "KNOWN DRIFT (JEL-631): boot skips re-injection when alreadyRan() (__shellRegElCalls>0) — the JEL-137-era double-run guard; retail never got it. Port to retail, then move to EXPECTED_MIRRORED",
    retail: "a051c37dd3e70bd8",
    boot: "7f7b424c847affe3",
  },
  {
    name: "reinject",
    class: "drift",
    why: "nested in armDeferWatchdog — same JEL-631 alreadyRan() drift",
    retail: "33e76bf4c58cff25",
    boot: "840b717cc5375e5a",
  },
  {
    name: "tick",
    class: "drift",
    why: "nested in armDeferWatchdog — same JEL-631 alreadyRan() drift",
    retail: "94bdcdfcea25d776",
    boot: "00442a87a468161b",
  },
  {
    name: "maybeStringFastPath",
    class: "hsb-feature",
    why: "boot fast path additionally adopts vendors-bundle + stylesheet-body caches and bails on their misses; retail checks main bundle only",
    // Re-pinned JEL-618 (cached-channel-body splice landed in BOTH
    // shells; divergence class unchanged).
    retail: "bbd18216a03986be",
    boot: "9323bb152876f6b2",
  },
  {
    name: "loadRemoteWebClient",
    class: "hsb-feature",
    why: "boot wires vendors-bundle/stylesheet cache recording + lazy-babel markBabelNeeded into the load path; retail does not have those subsystems",
    retail: "b2abcabb38fb60b0",
    boot: "0e14ea9af3a9ce82",
  },
];

// Transpiler-critical consts marked "lockstep" in source comments. Compared
// as normalized initializer text.
const LOCKSTEP_CONSTS = [
  "MODERN_SYNTAX_RE_SRC",
  "MODERN_PRECHECK_RE_SRC",
  "BABEL_OPTS_KEY",
  "TX_CACHE_EPOCH",
];

let failures = 0;
function fail(msg) {
  console.error("FAIL: " + msg);
  failures++;
}
function fatal(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

function normalizeFile(src, label) {
  try {
    return transformSync(src, {
      minifySyntax: true,
      target: "es5",
      loader: "js",
    }).code;
  } catch (e) {
    fatal(
      label +
        " does not survive the esbuild es5 normalize pass: " +
        e.message.split("\n")[0],
    );
  }
}

// Extract every named function declaration from normalized (comment-free,
// single-line-string) esbuild output. Declarations start their own line;
// the matching close brace is the first later line that is exactly the same
// indentation + "}". Nested named declarations are extracted too (compared
// standalone AND as part of their parent's body).
function extractFunctions(norm, label) {
  const lines = norm.split("\n");
  const out = new Map();
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)function ([A-Za-z_$][\w$]*)\(/.exec(lines[i]);
    if (!m) continue;
    const indent = m[1];
    const name = m[2];
    let j = i;
    const oneLiner = !/\{$/.test(lines[i]) && /\}$/.test(lines[i]);
    if (!oneLiner) {
      const close = indent + "}";
      for (j = i + 1; j < lines.length; j++) {
        if (lines[j] === close || lines[j] === close + ";") break;
      }
      if (j === lines.length) {
        fatal(label + ": could not find close brace for function " + name);
      }
    }
    const body = lines.slice(i, j + 1).join("\n");
    if (!out.has(name)) out.set(name, []);
    out.get(name).push(body);
  }
  return out;
}

// Canonical form: full esbuild minify of the extracted declaration. This is
// also a syntax self-check on the extraction — a truncated extraction throws
// instead of silently comparing garbage.
function canon(fnText, name, label) {
  try {
    return transformSync(fnText, { minify: true, loader: "js" }).code;
  } catch (e) {
    fatal(
      label +
        ": extracted function " +
        name +
        " does not re-parse (extractor bug?): " +
        e.message.split("\n")[0],
    );
  }
}

// Lockstep consts are string literals, optionally `OTHER_CONST + "literal"`
// (MODERN_PRECHECK_RE_SRC). Capture exactly that initializer shape — the
// normalized output comma-chains several declarations onto one line, so
// "rest of line" would leak the neighbours in.
function extractConst(norm, name, label) {
  const re = new RegExp(
    "(?:^|[\\s,(;])" +
      name +
      ' = ((?:[A-Za-z_$][\\w$]* \\+ )?"(?:[^"\\\\]|\\\\.)*")',
  );
  const m = re.exec(norm);
  if (!m) {
    fail(
      label +
        ": lockstep const " +
        name +
        " not found (or initializer is no longer a plain string literal)",
    );
    return null;
  }
  return m[1];
}

const retailRaw = fs.readFileSync(RETAIL_SRC, "utf8");
const bootRaw = fs.readFileSync(BOOT_SRC, "utf8");
const configXml = fs.readFileSync(CONFIG_XML, "utf8");
const verMatch = /<widget[^>]*\bversion="([0-9.]+)"/.exec(configXml);
if (!verMatch) fatal("could not read widget version from bootstrap config.xml");
const WIDGET_VER = verMatch[1];

const retailNorm = normalizeFile(retailRaw, "shell.js");
const bootNorm = normalizeFile(bootRaw, "boot-shell.src.js");
const retailFns = extractFunctions(retailNorm, "shell.js");
const bootFns = extractFunctions(bootNorm, "boot-shell.src.js");

// Canonical text for a name = all same-named declarations, canonicalized,
// sorted, joined — then version literals neutralized (see header).
function canonFor(map, name, label) {
  const texts = map
    .get(name)
    .map((t) => canon(t, name, label))
    .sort()
    .join("\n");
  return texts.split('"' + WIDGET_VER + '"').join('"__SHELL_VER__"');
}
function sha(text) {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

const divergentNames = new Set(INTENTIONAL_DIVERGENCES.map((d) => d.name));
const sharedNames = [...retailFns.keys()].filter((k) => bootFns.has(k));

// --print-pins: emit fresh EXPECTED_MIRRORED / INTENTIONAL_DIVERGENCES.
if (process.argv.includes("--print-pins")) {
  const mirrored = [];
  const divergent = [];
  for (const name of sharedNames) {
    const a = canonFor(retailFns, name, "shell.js");
    const b = canonFor(bootFns, name, "boot-shell.src.js");
    if (a === b) mirrored.push(name);
    else {
      const prev = INTENTIONAL_DIVERGENCES.find((d) => d.name === name);
      divergent.push({
        name,
        class: prev ? prev.class : "UNCLASSIFIED",
        why: prev ? prev.why : "TODO",
        retail: sha(a),
        boot: sha(b),
      });
    }
  }
  console.log(
    "const EXPECTED_MIRRORED = " + JSON.stringify(mirrored, null, 2) + ";",
  );
  console.log(
    "\nconst INTENTIONAL_DIVERGENCES = " +
      JSON.stringify(divergent, null, 2) +
      ";",
  );
  process.exit(0);
}

// 1. EXPECTED_MIRRORED: present in both, canonically identical.
for (const name of EXPECTED_MIRRORED) {
  if (!retailFns.has(name)) {
    fail(
      "mirrored function " +
        name +
        " missing from shell.js (renamed or deleted on one side only?)",
    );
    continue;
  }
  if (!bootFns.has(name)) {
    fail(
      "mirrored function " +
        name +
        " missing from boot-shell.src.js (renamed or deleted on one side only?)",
    );
    continue;
  }
  const a = canonFor(retailFns, name, "shell.js");
  const b = canonFor(bootFns, name, "boot-shell.src.js");
  if (a !== b) {
    fail(
      "MIRROR DRIFT in " +
        name +
        ": shell.js and boot-shell.src.js no longer agree (canon " +
        sha(a) +
        " vs " +
        sha(b) +
        "). Apply the change to BOTH shells; if the divergence is intentional, move the name to INTENTIONAL_DIVERGENCES with a reason + pins (--print-pins).",
    );
  }
}

// 2. INTENTIONAL_DIVERGENCES: present in both, NOT identical, pins match.
for (const entry of INTENTIONAL_DIVERGENCES) {
  const { name } = entry;
  if (!retailFns.has(name) || !bootFns.has(name)) {
    fail(
      "divergent-listed function " +
        name +
        " missing from " +
        (retailFns.has(name) ? "boot-shell.src.js" : "shell.js"),
    );
    continue;
  }
  const a = canonFor(retailFns, name, "shell.js");
  const b = canonFor(bootFns, name, "boot-shell.src.js");
  if (a === b) {
    fail(
      "stale divergence entry: " +
        name +
        " is now identical in both shells — move it to EXPECTED_MIRRORED.",
    );
    continue;
  }
  if (sha(a) !== entry.retail || sha(b) !== entry.boot) {
    fail(
      "pinned divergent function " +
        name +
        " changed (retail " +
        sha(a) +
        " vs pin " +
        entry.retail +
        ", boot " +
        sha(b) +
        " vs pin " +
        entry.boot +
        "). This function is mirrored-but-divergent (" +
        entry.class +
        ": " +
        entry.why +
        ") — check whether your change must ALSO land in the other shell, then re-pin via --print-pins. If pins broke after an esbuild version bump with no shell source change, just re-pin.",
    );
  }
}

// 3. Any other shared function must be identical (auto-guards new mirrors).
for (const name of sharedNames) {
  if (EXPECTED_MIRRORED.includes(name) || divergentNames.has(name)) continue;
  const a = canonFor(retailFns, name, "shell.js");
  const b = canonFor(bootFns, name, "boot-shell.src.js");
  if (a !== b) {
    fail(
      "new shared function " +
        name +
        " differs between shells. Mirror it exactly, or add an INTENTIONAL_DIVERGENCES entry with a reason (--print-pins).",
    );
  }
}

// 4. Lockstep transpiler consts.
for (const name of LOCKSTEP_CONSTS) {
  const a = extractConst(retailNorm, name, "shell.js");
  const b = extractConst(bootNorm, name, "boot-shell.src.js");
  if (a !== null && b !== null && a !== b) {
    fail(
      "lockstep const " +
        name +
        " diverged:\n  shell.js:          " +
        a +
        "\n  boot-shell.src.js: " +
        b,
    );
  }
}

// 5. Extraction sanity: the mirror surface is ~60 functions; a collapse here
// means the extractor regressed, not that the shells un-mirrored overnight.
if (sharedNames.length < 40) {
  fail(
    "only " +
      sharedNames.length +
      " shared functions extracted (expected ~60+) — extractor regression?",
  );
}

if (failures) {
  console.error("\ncross-shell-parity: " + failures + " failure(s)");
  process.exit(1);
}
console.log(
  "cross-shell-parity OK: " +
    sharedNames.length +
    " shared functions (" +
    (sharedNames.length - divergentNames.size) +
    " mirrored, " +
    INTENTIONAL_DIVERGENCES.length +
    " pinned-divergent), " +
    LOCKSTEP_CONSTS.length +
    " lockstep consts",
);
