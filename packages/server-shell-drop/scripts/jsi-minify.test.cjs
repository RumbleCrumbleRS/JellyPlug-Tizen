#!/usr/bin/env node
/*
 * jsi-minify.test.cjs — JEL-632 guard for jsi-minify-es5.mjs.
 *
 * 1) LOCKSTEP: the tool's ORACLE_SRC / PRECHECK_SRC / chrome:56 floor must
 *    stay byte-identical with MODERN_SYNTAX_RE_SRC / MODERN_PRECHECK_RE_SRC
 *    in BOTH shells — the tool's whole promise is "output the device
 *    precheck will fast-path", so drift here silently re-enables on-TV
 *    Babel for the channel.
 * 2) FUNCTION: modern fixture snippets come out (a) precheck-clean,
 *    (b) semantically intact when executed on a Chrome-56-era feature set,
 *    (c) with TOP-LEVEL names unmangled (snippets share globals across
 *    channel entries), (d) statement-terminated (concat-safe), (e) smaller.
 */
"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

const HERE = __dirname;
const REPO = path.join(HERE, "..", "..", "..");
const SHELLS = [
  path.join(REPO, "packages", "shell-tizen", "src", "shell.js"),
  path.join(
    REPO,
    "packages",
    "shell-tizen-bootstrap",
    "src",
    "boot-shell.src.js",
  ),
];

function extract(source, varName, file) {
  // Matches `<name> = <initializer>` where the initializer is a sequence of
  // string literals, `+`, whitespace, and (for PRECHECK) the identifier
  // MODERN_SYNTAX_RE_SRC — covering both shells' declaration styles
  // (shell.js `var X = "…";` and boot-shell's comma-chained `X =\n "…",`).
  // Commas/semicolons INSIDE string literals are consumed by the literal
  // alternative, so the first bare `,`/`;` terminates the match.
  const re = new RegExp(
    "[\\s(,;]" +
      varName +
      '\\s*=\\s*((?:"(?:[^"\\\\]|\\\\.)*"|MODERN_SYNTAX_RE_SRC|\\s|\\+)+)[,;]',
  );
  const m = source.match(re);
  assert.ok(m, varName + " not found in " + file);
  return vm.runInNewContext(
    m[1].replace(/MODERN_SYNTAX_RE_SRC/g, JSON.stringify(extractCache[file])),
  );
}
const extractCache = {};

async function main() {
  const tool = await import("file://" + path.join(HERE, "jsi-minify-es5.mjs"));

  // ---- 1) lockstep with both shells --------------------------------------
  for (const shellPath of SHELLS) {
    const src = fs.readFileSync(shellPath, "utf8");
    const oracle = extract(src, "MODERN_SYNTAX_RE_SRC", shellPath);
    extractCache[shellPath] = oracle;
    const precheck = extract(src, "MODERN_PRECHECK_RE_SRC", shellPath);
    assert.strictEqual(
      tool.ORACLE_SRC,
      oracle,
      "ORACLE_SRC drifted from " + shellPath,
    );
    assert.strictEqual(
      tool.PRECHECK_SRC,
      precheck,
      "PRECHECK_SRC drifted from " + shellPath,
    );
    // The lowering floor must match the shells' documented chrome:56 floor
    // (BABEL_OPTS_KEY is the canonical descriptor of that transform).
    const keyMatch = src.match(/[\s(,;]BABEL_OPTS_KEY\s*=\s*("[^"]+")/);
    assert.ok(keyMatch, "BABEL_OPTS_KEY not found in " + shellPath);
    assert.ok(
      JSON.parse(keyMatch[1]).includes("targets:{chrome:56}"),
      "shell BABEL_OPTS_KEY floor changed — revisit tool floor",
    );
  }
  const envPreset = tool.BABEL_LOWER_OPTS.presets[0];
  assert.strictEqual(envPreset[1].targets.chrome, "56", "tool floor drifted");
  assert.strictEqual(tool.ESBUILD_TARGET, "chrome56", "minify floor drifted");

  // ---- 2) functional ------------------------------------------------------
  const { createRequire } = require("node:module");
  const req = createRequire(path.join(HERE, "jsi-minify-es5.mjs"));
  // Load babel through the tool's own loader so the test tracks whatever
  // babel.min.js shape the shells ship (JEL-620 slim IIFE isn't require()-able).
  const Babel = tool.loadBabel(
    path.join(REPO, "packages", "shell-tizen", "src", "babel.min.js"),
  );
  const esbuild = req("esbuild");
  const ctx = { Babel, esbuild, minify: true };
  const PRECHECK_RE = new RegExp(tool.PRECHECK_SRC);

  // Snippet A: defines a shared top-level helper; uses every precheck
  // trigger class the slim chrome:56 babel actually LOWERS (optional
  // chaining, nullish, logical assign, object spread incl. INTERIOR
  // spread [JEL-417], optional catch binding, numeric separator). Chrome-56
  // NATIVE comma-spread / rest params are deliberately absent — those are
  // fail-closed by the gate (covered separately below), not lowered.
  const padding = "// " + "x".repeat(400) + "\n";
  const snippetA =
    padding +
    "function jpSharedHelper(base, bonus) {\n" +
    "  const merged = { a: 1, ...base, z: 26 };\n" +
    "  let count = merged.count ?? 1_000;\n" +
    "  count ||= 5;\n" +
    "  try { count += bonus; } catch { count = -1; }\n" +
    "  return { merged, count, tag: base?.tag ?? 'none' };\n" +
    "}\n" +
    "var jpChannelState = jpSharedHelper({ tag: 'seed', mid: true }, 15);\n";
  // Snippet B: separate channel entry consuming A's top-level global —
  // the cross-snippet contract that forbids top-level mangling.
  const snippetB =
    padding +
    "var jpChannelResult = jpSharedHelper(\n" +
    "  { tag: jpChannelState.tag, n: jpChannelState.count }, 6);\n";

  assert.ok(PRECHECK_RE.test(snippetA), "fixture A must trip the precheck");

  const outA = tool.transformSnippet(snippetA, ctx);
  const outB = tool.transformSnippet(snippetB, ctx);

  for (const [name, src, out] of [
    ["A", snippetA, outA],
    ["B", snippetB, outB],
  ]) {
    assert.ok(!PRECHECK_RE.test(out), name + " output trips precheck");
    assert.ok(out.length < src.length, name + " output did not shrink");
    assert.ok(/;\n$/.test(out), name + " output not statement-terminated");
  }
  assert.ok(
    /function jpSharedHelper\b/.test(outA),
    "top-level helper name was mangled — cross-snippet globals broken",
  );

  // Execute both transformed snippets in one bare context (concatenated,
  // like the served channel) and compare against untransformed semantics.
  function runChannel(aBody, bBody) {
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(aBody + bBody, sandbox);
    return sandbox.jpChannelResult;
  }
  // (JSON-compare: each vm context is its own realm, so prototype-identity
  // checks in deepStrictEqual would false-fail on plain objects.)
  const expected = runChannel(snippetA, snippetB);
  const actual = runChannel(outA, outB);
  assert.strictEqual(
    JSON.stringify(actual),
    JSON.stringify(expected),
    "transform changed semantics",
  );
  assert.strictEqual(actual.count, expected.count);

  // Already-clean ES5 input: no Babel pass, still minified + terminated.
  const es5 = "var jpPlainMarker = (function () { return 41 + 1; })()\n";
  assert.ok(!PRECHECK_RE.test(es5));
  const outEs5 = tool.transformSnippet(es5, ctx);
  assert.ok(/;\n$/.test(outEs5), "ES5 output not statement-terminated");
  const s2 = {};
  vm.createContext(s2);
  vm.runInContext(outEs5, s2);
  assert.strictEqual(s2.jpPlainMarker, 42);

  // ---- 2b) fail-closed on Chrome-56-native comma-spread / rest -------------
  // The slim chrome:56 babel keeps these (JEL-620 stubs transform-spread /
  // transform-parameters), so they still trip the shell precheck. The gate
  // must REJECT them loudly — shipping one would forfeit the JEL-618 raw fast
  // path for the whole concatenated channel.
  const rejects = [
    "function jpF(a, ...rest) { return jpG(a, rest.length); }\n", // rest params
    "var jpY = jpH(seed, ...items);\n", // call spread
    "var jpZ = [seed, ...items];\n", // array spread
  ];
  for (const bad of rejects) {
    assert.ok(PRECHECK_RE.test(bad), "reject fixture should trip precheck");
    assert.throws(
      () => tool.transformSnippet(bad, ctx),
      /comma-spread|precheck|stub/i,
      "gate must fail-close on: " + bad.trim(),
    );
  }
  // Leading (non-comma) spread is Chrome-56 native AND precheck-clean — it
  // must pass through untouched, not be falsely rejected.
  const leadClean = "var jpLead = jpMake(items[0]);\n";
  assert.ok(!PRECHECK_RE.test(leadClean));
  assert.ok(/;\n$/.test(tool.transformSnippet(leadClean, ctx)));

  // ---- 3) CLI end-to-end ---------------------------------------------------
  const { execFileSync } = require("node:child_process");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jel632-"));
  try {
    fs.mkdirSync(path.join(tmp, "in", "sub"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "in", "a.js"), snippetA);
    fs.writeFileSync(path.join(tmp, "in", "sub", "b.js"), snippetB);
    execFileSync(
      process.execPath,
      [
        path.join(HERE, "jsi-minify-es5.mjs"),
        "--dir",
        path.join(tmp, "in"),
        "--out-dir",
        path.join(tmp, "out"),
      ],
      { stdio: "pipe" },
    );
    const cliA = fs.readFileSync(path.join(tmp, "out", "a.js"), "utf8");
    const cliB = fs.readFileSync(path.join(tmp, "out", "sub", "b.js"), "utf8");
    assert.strictEqual(
      JSON.stringify(runChannel(cliA, cliB)),
      JSON.stringify(expected),
    );

    // Deploy-gate: un-lowerable input (BigInt has no chrome:56 lowering)
    // must fail the run, not slip through.
    fs.writeFileSync(path.join(tmp, "bad.js"), "var jpBig = 10n * 10n;\n");
    let failed = false;
    try {
      execFileSync(
        process.execPath,
        [
          path.join(HERE, "jsi-minify-es5.mjs"),
          "--file",
          path.join(tmp, "bad.js"),
          "--out-dir",
          path.join(tmp, "out"),
        ],
        { stdio: "pipe" },
      );
    } catch {
      failed = true;
    }
    assert.ok(failed, "un-lowerable input must exit non-zero");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log("jsi-minify.test.cjs: all assertions passed");
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
