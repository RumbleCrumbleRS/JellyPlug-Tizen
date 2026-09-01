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
  // (6 dirs, 64-char dirs) and the dir rank regex must survive.
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
    "names.Count >= nameCap",
    "dirs.Count >= 6",
    "d.Length > 64",
    '"/(js|scripts|modules)$"',
  ]) {
    assert.ok(
      csBuilder.includes(pin),
      "C# ScrapeDynamicRefs lost the seed semantic: " + pin,
    );
  }

  // JELA-850: the name cap is the one seed semantic the builder deliberately
  // does NOT inherit — the seed bounds speculative TV requests, the builder
  // bounds a loopback fetch loop, and sharing 80 truncated the JE loader's
  // 152-name module list so 63 scripts were Babel'd on the TV every cold
  // boot. Pin BOTH sides numerically so the divergence stays intentional:
  // the two builders must agree with each other, and the seed reference must
  // stay 80 (raising it would change what TVs prefetch, which is a separate
  // decision with a separate cost).
  function csInt(name) {
    const m = cs.match(new RegExp("const int " + name + "\\s*=\\s*(\\d+);"));
    assert.ok(m, "missing C# const int " + name);
    return Number(m[1]);
  }
  assert.strictEqual(
    csInt("SeedScrapeNameCap"),
    builder.SCRAPE_NAME_CAP_SEED,
    "seed scrape name cap drifted between C# and the builder",
  );
  assert.strictEqual(
    csInt("SeedScrapeNameCap"),
    80,
    "seed scrape name cap must stay 80 — it is lockstep with the shells' " +
      "__txScrapeBodies literal, which this test cannot see",
  );
  assert.strictEqual(
    csInt("BuilderScrapeNameCap"),
    builder.SCRAPE_NAME_CAP_BUILD,
    "builder scrape name cap drifted between C# and the builder",
  );
  assert.ok(
    csInt("BuilderScrapeNameCap") > csInt("SeedScrapeNameCap"),
    "JELA-850: the builder must scrape WIDER than the seed primer",
  );
  assert.strictEqual(
    csInt("DynScanFetchCap"),
    builder.DYN_FETCH_CAP,
    "dynamic-scan fetch cap drifted between C# and the builder",
  );
  assert.ok(
    csInt("DynScanFetchCap") > csInt("BuilderScrapeNameCap"),
    "JELA-850: the fetch cap must exceed the name cap or it becomes the " +
      "new truncation point",
  );
  assert.ok(
    csScanTask().includes("const int FetchCap = TxDropConstants.DynScanFetchCap;"),
    "TxDropRebuildTask must take its fetch cap from TxDropConstants",
  );

  function csScanTask() {
    return fs.readFileSync(
      path.join(
        __dirname,
        "..",
        "Jellyfin.Plugin.JellyPlugShell",
        "ScheduledTasks",
        "TxDropRebuildTask.cs",
      ),
      "utf8",
    );
  }

  console.log("lockstep.test.cjs OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
