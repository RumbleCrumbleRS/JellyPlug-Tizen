#!/usr/bin/env node
/*
 * bundle-patch-lockstep.test.cjs — JELA-865 guard.
 *
 * BundleSourcePatcher.cs is a port of the shells' buildBundleSourcePatcher()
 * (JEL-436 v24/v25). The shell and the server must produce IDENTICAL bytes for
 * the same bundle, because on a flag-armed boot the TV executes the SERVER's
 * body while the shell's own scan is what QA runs to prove the patch landed
 * (JELA-865 AC5). Textual comparison of the two sources is not enough — the
 * shell builds its replacement by concatenation and C# by token substitution —
 * so this test executes both:
 *
 *   1. Extract the four regex literals + the replacement-building callback from
 *      shell.js and run the REAL shell patcher over a fixture.
 *   2. Extract the four pattern strings + ReplacementTemplate from
 *      BundleSourcePatcher.cs, rebuild them as JavaScript RegExps, and run the
 *      same algorithm over the same fixture.
 *   3. Require byte-identical output and identical patch counts.
 *
 * The C# patterns are written to be valid JavaScript regex source as well (the
 * .NET side compiles them with RegexOptions.ECMAScript for exactly that
 * reason), so step 2 is a faithful re-execution, not a re-implementation.
 *
 * Also pinned: the needle literal, the no-needle short circuit, and the
 * "needle present but nothing matched" case that must NOT publish.
 *
 * Run: node packages/server-plugin/scripts/bundle-patch-lockstep.test.cjs
 */
"use strict";
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const SHELL = fs.readFileSync(
  path.join(ROOT, "shell-tizen", "src", "shell.js"),
  "utf8",
);
const CS = fs.readFileSync(
  path.join(
    __dirname,
    "..",
    "Jellyfin.Plugin.JellyPlugShell",
    "BundleSourcePatcher.cs",
  ),
  "utf8",
);

// ---- 1. the shell's patcher, executed ---------------------------------------

const fnStart = SHELL.indexOf("function buildBundleSourcePatcher() {");
assert.ok(fnStart >= 0, "buildBundleSourcePatcher not found in shell.js");
// Brace matching is not safe here — the body is mostly regex literals full of
// `\{` and `\}`. shell.js indents every top-level function at two spaces, so
// the first `\n  }` after the declaration IS the closing brace.
const end = SHELL.indexOf("\n  }\n", fnStart);
assert.ok(end > 0, "could not find the end of buildBundleSourcePatcher");
const shellPatcher = new Function(
  "return (" +
    SHELL.slice(fnStart, end + 4).replace(
      "function buildBundleSourcePatcher()",
      "function ()",
    ) +
    ")();",
)();

// ---- 2. the C# patcher, re-executed in JavaScript ---------------------------

const patternBlock =
  /public static readonly string\[\] PatternSources\s*=\s*\{([\s\S]*?)\n    \};/.exec(
    CS,
  );
assert.ok(
  patternBlock,
  "PatternSources array not found in BundleSourcePatcher.cs",
);
// Verbatim (@"...") string literals: the only escape is a doubled quote.
const csPatterns = [...patternBlock[1].matchAll(/@"((?:[^"]|"")*)"/g)].map(
  (m) => m[1].replace(/""/g, '"'),
);
assert.strictEqual(csPatterns.length, 4, "expected the shells' four patterns");

const tokenMatch = /public const string ParamToken = "([^"]+)";/.exec(CS);
assert.ok(tokenMatch, "ParamToken not found");
const TOKEN = tokenMatch[1];

// ReplacementTemplate is a concatenation of regular (escaped) string literals
// and ParamToken references — evaluate it the way the C# compiler would.
const tplBlock = /public const string ReplacementTemplate =([\s\S]*?);\n/.exec(
  CS,
);
assert.ok(tplBlock, "ReplacementTemplate not found");
const template = tplBlock[1]
  .split("+")
  .map((piece) => piece.trim())
  .map((piece) => {
    if (piece === "ParamToken") return TOKEN;
    const lit = /^"((?:[^"\\]|\\.)*)"$/.exec(piece);
    assert.ok(lit, `unexpected ReplacementTemplate piece: ${piece}`);
    return lit[1].replace(/\\(.)/g, "$1");
  })
  .join("");

function csPatch(source) {
  let total = 0;
  let out = source;
  for (const src of csPatterns) {
    out = out.replace(new RegExp(src, "g"), (...args) => {
      total++;
      // args: match, group1 (prefix), group2 (param), group3 (quote), ...
      return args[1] + template.split(TOKEN).join(args[2]);
    });
  }
  return { source: out, patches: total };
}

// ---- 3. same bytes over a fixture -------------------------------------------

const NEEDLE = "item or serverId cannot be null";
const needleMatch = /public const string Needle = "([^"]+)";/.exec(CS);
assert.ok(needleMatch, "Needle constant not found");
assert.strictEqual(
  needleMatch[1],
  NEEDLE,
  "Needle drifted from the shell's locator",
);
assert.ok(SHELL.includes(NEEDLE), "shell.js no longer carries the needle");

const FIXTURE = [
  // The real minified shape QA confirmed in main.jellyfin.bundle.js (JEL-537).
  `x={key:"getApiClient",value:function(e){if(!e)throw new Error("${NEEDLE}");return e.ServerId&&(e=e.ServerId),this._apiClients.filter(f)}};`,
  // Arrow variant.
  `var g=(t)=>{if(!t)throw new Error('${NEEDLE}');return t;};`,
  // Legacy double-check shapes.
  `var h=function (q) { if ( ! q || ! q . ServerId ) { throw Error("${NEEDLE}") } return q };`,
  `var i=( z )=>{ if(!z||!z.ServerId) throw new Error("${NEEDLE}"); return z };`,
  // A decoy: the needle inside an unrelated string must not be rewritten.
  `console.log("${NEEDLE}");`,
].join("\n");

const shellOut = shellPatcher(FIXTURE);
const csOut = csPatch(FIXTURE);

assert.strictEqual(
  shellOut.patches,
  4,
  "fixture should exercise all four patterns exactly once each",
);
assert.strictEqual(csOut.patches, shellOut.patches, "patch counts diverged");
assert.strictEqual(csOut.source, shellOut.source, "patched bytes diverged");
assert.ok(
  csOut.source.includes(`console.log("${NEEDLE}");`),
  "the decoy string literal must survive untouched",
);
// Every rewritten site keeps the original throw as the final fallback.
assert.strictEqual(
  (
    csOut.source.match(
      /throw new Error\("item or serverId cannot be null"\)/g,
    ) || []
  ).length,
  4,
  "each patched site must still fall through to the original throw",
);

// ---- 4. the two decline paths -----------------------------------------------

const clean = "var a=1;function f(e){if(!e)throw new Error('other');return e}";
assert.strictEqual(csPatch(clean).patches, 0);
assert.strictEqual(csPatch(clean).source, clean);
assert.ok(
  /if \(result\.NeedleFound && result\.Patches == 0\)/.test(
    fs.readFileSync(
      path.join(
        __dirname,
        "..",
        "Jellyfin.Plugin.JellyPlugShell",
        "PatchedBundleService.cs",
      ),
      "utf8",
    ),
  ),
  "the service must decline to publish when the needle is present but nothing matched — " +
    "advertising `patchedBundle` there would claim a patch that was not made",
);

// ---- 5. the C# side compiles the patterns with JavaScript semantics ----------

assert.ok(
  /RegexOptions\.ECMAScript/.test(CS),
  "patterns must be compiled with RegexOptions.ECMAScript or \\w/\\s stop matching the shell",
);

console.log("bundle-patch-lockstep.test.cjs OK");
