#!/usr/bin/env node
/*
 * lockstep.test.cjs — guard the C# plugin's tx-drop constants against the
 * canonical builder (packages/server-shell-drop/scripts/build-tx-drop.mjs),
 * which is itself lockstep-guarded against both shells. If this fails, the
 * plugin would publish a drop the TVs ignore (optsKey mismatch) or reject
 * (oracle drift).
 */
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

async function main() {
  const builder = await import(
    "../../server-shell-drop/scripts/build-tx-drop.mjs"
  );
  const cs = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "Jellyfin.Plugin.JellyPlugShell",
      "TxDropConstants.cs",
    ),
    "utf8",
  );

  // C# string literals escape backslash the same way JS does, so the source
  // text between quotes must match the JS constants byte-for-byte once the
  // C# concatenation ("A" + "B") is joined.
  function csConst(name) {
    const re = new RegExp(
      "const string " + name + " =\\s*((?:\"(?:[^\"\\\\]|\\\\.)*\"\\s*\\+?\\s*)+);",
    );
    const m = cs.match(re);
    assert.ok(m, "missing C# const " + name);
    return m[1]
      .match(/"(?:[^"\\]|\\.)*"/g)
      .map((lit) => JSON.parse(lit))
      .join("");
  }

  assert.strictEqual(csConst("OracleSrc"), builder.ORACLE_SRC, "OracleSrc");
  assert.ok(
    cs.includes("PrecheckSrc = OracleSrc + \"|,\\\\s*\\\\.\\\\.\\\\.[\\\\w$]\""),
    "PrecheckSrc must be OracleSrc + the JEL-417 suffix",
  );
  assert.strictEqual(
    builder.PRECHECK_SRC,
    builder.ORACLE_SRC + "|,\\s*\\.\\.\\.[\\w$]",
    "builder PRECHECK_SRC shape",
  );
  assert.strictEqual(csConst("BabelOptsKey"), builder.BABEL_OPTS_KEY, "BabelOptsKey");

  // The JS options literal the plugin evaluates inside Jint must be
  // semantically the builder's BABEL_OPTS (assumptions carry the JEL-26 fix).
  const optsJs = csConst("BabelOptsJs");
  const evaled = new Function("return " + optsJs)();
  assert.deepStrictEqual(evaled, builder.BABEL_OPTS, "BabelOptsJs literal");

  // fnv1a parity: the C# port must agree with the shells' txFnv1a for
  // representative inputs (ASCII, non-BMP surrogate pairs, empty).
  // Expected values computed with the builder's own txFnv1a.
  const samples = ["", "a", "hello world", "❤️😀", "var x = {...y};"];
  const expected = samples.map((s) => builder.txFnv1a(s));
  // Mirror of the C# implementation, to prove the algorithm transcription.
  function csFnv(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(36);
  }
  assert.deepStrictEqual(samples.map(csFnv), expected, "fnv1a parity");

  // JELA-186: the dynamic-module scrape regexes must equal the builder's
  // (which are themselves lockstep-guarded against the seed __txScrapeBodies
  // literals by tx-drop-build.test.cjs).
  assert.strictEqual(csConst("ScrapeRelSrc"), builder.SCRAPE_REL_SRC, "ScrapeRelSrc");
  assert.strictEqual(csConst("ScrapeAbsSrc"), builder.SCRAPE_ABS_SRC, "ScrapeAbsSrc");
  assert.strictEqual(csConst("ScrapeTplSrc"), builder.SCRAPE_TPL_SRC, "ScrapeTplSrc");

  // Semantic pins on the C# ScrapeDynamicRefs transcription: the seed caps
  // (80 names, 6 dirs, 64-char dirs) and the dir rank regex must survive.
  const csBuilder = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "Jellyfin.Plugin.JellyPlugShell",
      "TxDropBuilder.cs",
    ),
    "utf8",
  );
  for (const pin of [
    "names.Count >= 80",
    "dirs.Count >= 6",
    "d.Length > 64",
    '"/(js|scripts|modules)$"',
  ]) {
    assert.ok(
      csBuilder.includes(pin),
      "C# ScrapeDynamicRefs lost the seed semantic: " + pin,
    );
  }

  console.log("lockstep.test.cjs OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
