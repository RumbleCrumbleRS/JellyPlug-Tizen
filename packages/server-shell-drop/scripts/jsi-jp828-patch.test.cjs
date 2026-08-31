#!/usr/bin/env node
/*
 * jsi-jp828-patch.test.cjs — JELA-828 guard for jsi-jp828-patch.mjs.
 *
 * jp828 is a FLEET FLIP, so its risks are not jp816's. jp816 asked "does the
 * wave path render the same rows?" (answered there, 11 checks). jp828 asks a
 * narrower and more dangerous question: WHICH TVs take that path now, and can
 * we get them back? Every check below is a way that has gone wrong before:
 *
 *  1) FAIL-CLOSED READ SITE. The flip is one anchored text swap inside jp816's
 *     gate. Zero hits (jp816 not deployed, or already flipped) or two hits must
 *     throw, never patch nothing and report success (JELA-747/816).
 *  2) POLARITY, BY EXECUTION, ON THE REAL BODY. Not by grep: the arm key
 *     `jellyplug.rows.genreLazy` is a PREFIX of the kill key
 *     `…genreLazyDisabled`, the exact substring trap jp816's AC4 names. So the
 *     four arms are booted through the patched entry and counted on the wire:
 *     absent key => ARMED (8 queries), "0" => 14, kill "1" => 14, throwing
 *     localStorage => 14.
 *  3) THE KILL SWITCH STILL WINS after the flip, in the same boot, including
 *     when the arm key is explicitly "1".
 *  4) THE ROWS DO NOT MOVE. The flip changes who runs the wave path, never
 *     what it renders: the default-armed boot must mount the same 8 titles in
 *     the same order as the unpatched body's full fan-out.
 *  5) SEEDER POLARITY + DURABLE KILL (JELA-827). Virgin TV gets "1"; a TV
 *     holding "0" is never re-armed; and a "0" written by the rollback body
 *     survives a subsequent seeder pass.
 *  6) ROLLBACK IS A FULL INVERSE, NOT A DELETE (JELA-773/789). After the flip
 *     an absent key means ON, so dropping the entry would strand the fleet
 *     armed. Rollback must restore the read site AND write "0" — and the
 *     restored body must again be OFF for an absent key.
 *  7) ROUND TRIP + PRE-IMAGE (JELA-805). flip -> rollback restores the
 *     genre-rows entry byte-for-byte, and stripping the seeder + unflipping
 *     must reproduce the fetched config exactly, which is the only check that
 *     detects a foreign writer racing our POST.
 *  8) NO COLLATERAL. Every other channel entry byte-identical.
 *  9) ES5. The Q60R panel engine is M63-class and throws on ES2020+.
 * 10) NO DOUBLE-SEED, NO DOUBLE-FLIP.
 */
"use strict";

const assert = require("node:assert");
const path = require("node:path");
const vm = require("node:vm");

const HERE = __dirname;

const {
  CANDIDATES,
  MAX_ROWS,
  moduleSource,
  boot,
} = require("./jsi-jp816-fixture.cjs");

const FLAG = "jellyplug.rows.genreLazy";
const KILL = "jellyplug.rows.genreLazyDisabled";

/** A config shaped like the live one: the genre-rows entry plus neighbours. */
function makeConfig(rowsBody) {
  return {
    CustomJavaScripts: [
      { Name: "JellyPlug — util", Script: "/*util*/void 0;", Enabled: true },
      { Name: "JellyPlug — genre-rows", Script: rowsBody, Enabled: true },
      {
        Name: "JellyPlug — rowViewGate default-ON (JELA-815)",
        Script:
          '/*jp815seed*/(function(){try{var k="jellyplug.rows.viewgate";if(localStorage.getItem(k)!=="0"){localStorage.setItem(k,"1")}}catch(e){}})();\n',
        Enabled: true,
      },
    ],
  };
}

function stubLs(initial) {
  const map = Object.assign(Object.create(null), initial);
  return {
    getItem: (k) => (k in map ? map[k] : null),
    setItem: (k, v) => {
      map[k] = String(v);
    },
    removeItem: (k) => {
      delete map[k];
    },
    _map: map,
  };
}

/** Run a channel snippet against a stub store and return the store. */
function runSeeder(snippet, initial) {
  const localStorage = stubLs(initial);
  new vm.Script(snippet, { filename: "seed.js" }).runInContext(
    vm.createContext({ localStorage }),
  );
  return localStorage;
}

(async function main() {
  const mod816 = await import(
    path.join("file://", HERE, "jsi-jp816-patch.mjs")
  );
  const mod = await import(path.join("file://", HERE, "jsi-jp828-patch.mjs"));

  /** The body as it is on the live channel today: jp815-wrapped, jp816 dark. */
  const DARK = mod816.applyPatch(
    moduleSource({ jp815: true }),
    mod816.PATCH_ROWS,
  );
  const UNPATCHED = moduleSource({ jp815: true });

  // --- 1) FAIL-CLOSED READ SITE ---------------------------------------------
  {
    assert.doesNotThrow(() => mod.flipReadSite(DARK));
    assert.throws(
      () => mod.flipReadSite(UNPATCHED),
      /matched 0 times/,
      "flipping a body without jp816 must throw, not no-op",
    );
    assert.throws(
      () => mod.flipReadSite(mod.flipReadSite(DARK)),
      /matched 0 times/,
      "the flip must not be applicable twice",
    );
    assert.throws(
      () => mod.flipReadSite(DARK + DARK),
      /matched 2 times/,
      "an ambiguous body must fail closed",
    );
    // Rollback direction is symmetric.
    assert.throws(
      () => mod.flipReadSite(DARK, { rollback: true }),
      /matched 0 times/,
      "un-flipping an un-flipped body must throw",
    );
    // The swap touches ONE character pair and nothing else.
    const flipped = mod.flipReadSite(DARK);
    assert.strictEqual(
      flipped.length,
      DARK.length,
      "the flip must be length-neutral",
    );
    assert.strictEqual(
      flipped.split(`getItem("${KILL}")==="1"`).length - 1,
      1,
      "the kill-switch test must survive the flip untouched",
    );
    assert.ok(
      flipped.indexOf(`getItem("${KILL}")==="1"`) <
        flipped.indexOf(`getItem("${FLAG}")!=="0"`),
      "the kill switch must still be tested BEFORE the arm key",
    );
    console.log("ok  1) read-site flip is fail-closed and surgical");
  }

  const FLIPPED = mod.flipReadSite(DARK);

  // --- 2) POLARITY, BY EXECUTION, ON THE REAL BODY --------------------------
  //
  // Counted on the wire, because the arm key is a PREFIX of the kill key and a
  // grep cannot tell the two reads apart.
  {
    const run = async (body, opts) => {
      const b = await boot(body, opts);
      b.run();
      await b.settle();
      return b;
    };
    const virgin = await run(FLIPPED, {});
    assert.strictEqual(
      virgin.asked.length,
      MAX_ROWS,
      "an unseeded TV must be ARMED after the flip (this is the whole point)",
    );
    const off = await run(FLIPPED, { store: { [FLAG]: "0" } });
    assert.strictEqual(
      off.asked.length,
      CANDIDATES.length,
      '"0" must take the shipped 14-query path',
    );
    const thrown = await run(FLIPPED, { throwLs: true });
    assert.strictEqual(
      thrown.asked.length,
      CANDIDATES.length,
      "unreadable localStorage must stand down to the shipped path",
    );
    // And the pre-flip body is still opt-in, which is what made the dark
    // deploy dark — the negative control for this whole check.
    const darkVirgin = await run(DARK, {});
    assert.strictEqual(
      darkVirgin.asked.length,
      CANDIDATES.length,
      "negative control: before the flip an unseeded TV is NOT armed",
    );
    console.log('ok  2) absent=ARMED, "0"=off, throw=off, pre-flip=off');
  }

  // --- 3) THE KILL SWITCH STILL WINS ----------------------------------------
  {
    for (const store of [{ [KILL]: "1" }, { [KILL]: "1", [FLAG]: "1" }]) {
      const b = await boot(FLIPPED, { store });
      b.run();
      await b.settle();
      assert.strictEqual(
        b.asked.length,
        CANDIDATES.length,
        `kill switch must win for ${JSON.stringify(store)}`,
      );
      assert.strictEqual(b.mounted.length, MAX_ROWS);
    }
    console.log("ok  3) the kill switch wins over the flipped default");
  }

  // --- 4) THE ROWS DO NOT MOVE ----------------------------------------------
  {
    const before = await boot(UNPATCHED, {});
    before.run();
    await before.settle();
    const after = await boot(FLIPPED, {});
    after.run();
    await after.settle();
    assert.deepStrictEqual(
      after.mounted,
      before.mounted,
      "the default-armed home must render the shipped rows, in order",
    );
    assert.deepStrictEqual(
      after.mounted,
      CANDIDATES.slice(0, MAX_ROWS).map((c) => c.title),
    );
    assert.strictEqual(before.asked.length, CANDIDATES.length);
    assert.strictEqual(after.asked.length, MAX_ROWS);
    console.log(
      `ok  4) same ${after.mounted.length} rows, ${before.asked.length} -> ${after.asked.length} queries`,
    );
  }

  // --- 5) SEEDER POLARITY + DURABLE KILL ------------------------------------
  {
    assert.strictEqual(runSeeder(mod.SEED_SRC, {})._map[FLAG], "1");
    assert.strictEqual(
      runSeeder(mod.SEED_SRC, { [FLAG]: "0" })._map[FLAG],
      "0",
      'a TV holding "0" must never be re-armed by the seeder',
    );
    assert.strictEqual(
      runSeeder(mod.SEED_SRC, { [FLAG]: "1" })._map[FLAG],
      "1",
    );
    // The rollback body writes "0", and that "0" survives a later seeder pass.
    const rolled = runSeeder(mod.ROLLBACK_SRC, { [FLAG]: "1" });
    assert.strictEqual(rolled._map[FLAG], "0");
    assert.strictEqual(runSeeder(mod.SEED_SRC, rolled._map)._map[FLAG], "0");
    // The seeder must not touch the kill switch either way.
    assert.strictEqual(runSeeder(mod.SEED_SRC, {})._map[KILL], undefined);
    console.log('ok  5) seeder arms a virgin TV and never overrides a "0"');
  }

  // --- 6) ROLLBACK IS A FULL INVERSE ----------------------------------------
  {
    const cfg = makeConfig(DARK);
    mod.patchConfig(cfg);
    const r = mod.patchConfig(cfg, { rollback: true });
    assert.strictEqual(r.action, "rollback");
    const rows = cfg.CustomJavaScripts.find((e) => /genre-rows/.test(e.Name));
    assert.strictEqual(rows.Script, DARK, "read site must be restored exactly");
    const seeder = cfg.CustomJavaScripts.find((e) =>
      (e.Script || "").includes(mod.ROLLBACK_MARKER),
    );
    assert.ok(seeder && seeder.Enabled, "the disarm entry must stay enabled");
    assert.strictEqual(
      cfg.CustomJavaScripts.filter((e) => (e.Script || "").includes(mod.MARKER))
        .length,
      0,
      "the seeder body must be gone, the ENTRY must not",
    );
    // A rolled-back TV that still carries the seeded "1" is OFF, because the
    // disarm body overwrites it — and an untouched TV is OFF because the read
    // site is opt-in again.
    const store = runSeeder(seeder.Script, { [FLAG]: "1" })._map;
    const b = await boot(rows.Script, { store });
    b.run();
    await b.settle();
    assert.strictEqual(b.asked.length, CANDIDATES.length);
    const virgin = await boot(rows.Script, {});
    virgin.run();
    await virgin.settle();
    assert.strictEqual(virgin.asked.length, CANDIDATES.length);
    console.log(
      "ok  6) rollback disarms both the seeded and the absent-key TV",
    );
  }

  // --- 7) ROUND TRIP + PRE-IMAGE --------------------------------------------
  {
    const fetched = makeConfig(DARK);
    const pre = JSON.stringify(fetched);
    const patched = JSON.parse(pre);
    const r = mod.patchConfig(patched);
    assert.strictEqual(r.action, "flip");
    assert.strictEqual(r.entries, 4);
    assert.notStrictEqual(
      JSON.stringify(patched),
      pre,
      "something must change",
    );
    assert.strictEqual(
      JSON.stringify(mod.reconstructPreImage(patched)),
      pre,
      "pre-image reconstruction must be byte-exact",
    );
    // A foreign writer landing between our fetch and our POST is exactly what
    // this catches: the reconstruction no longer matches what we fetched.
    const raced = JSON.parse(JSON.stringify(patched));
    raced.CustomJavaScripts[0].Script = "/*someone else*/void 0;";
    assert.notStrictEqual(JSON.stringify(mod.reconstructPreImage(raced)), pre);
    console.log("ok  7) round trip + byte-exact pre-image reconstruction");
  }

  // --- 8) NO COLLATERAL -----------------------------------------------------
  {
    const cfg = makeConfig(DARK);
    const before = cfg.CustomJavaScripts.map((e) => JSON.stringify(e));
    mod.patchConfig(cfg);
    const after = cfg.CustomJavaScripts.map((e) => JSON.stringify(e));
    assert.strictEqual(after[0], before[0], "the util entry must be untouched");
    assert.strictEqual(after[2], before[2], "jp815's seeder must be untouched");
    assert.notStrictEqual(after[1], before[1], "genre-rows must be flipped");
    assert.strictEqual(cfg.CustomJavaScripts.length, 4);
    console.log("ok  8) no collateral edits to the other 100+ entries");
  }

  // --- 9) ES5 ---------------------------------------------------------------
  {
    assert.doesNotThrow(() => mod.assertEs5(mod.SEED_SRC));
    assert.doesNotThrow(() => mod.assertEs5(mod.ROLLBACK_SRC));
    assert.throws(() => mod.assertEs5("const q=()=>1;"), /non-ES5/);
    assert.throws(() => mod.assertEs5("try{}catch{}"), /non-ES5/);
    // The flipped entry must still parse as a whole.
    assert.doesNotThrow(
      () => new vm.Script(FLIPPED, { filename: "flipped.js" }),
    );
    console.log("ok  9) seeder + rollback bodies are ES5 and parse");
  }

  // --- 10) NO DOUBLE-SEED, NO DOUBLE-FLIP -----------------------------------
  {
    const cfg = makeConfig(DARK);
    mod.patchConfig(cfg);
    assert.throws(() => mod.patchConfig(cfg), /already present/);
    // ...and after a rollback, the seeder entry still blocks a naive re-seed,
    // because re-flipping ON needs a remover of the "0" first.
    mod.patchConfig(cfg, { rollback: true });
    assert.throws(() => mod.patchConfig(cfg), /already present/);
    assert.throws(
      () => mod.patchConfig(makeConfig(DARK), { rollback: true }),
      /found 0 jp828 entries/,
    );
    assert.throws(
      () => mod.patchConfig({ CustomJavaScripts: [] }),
      /matched 0 channel entries/,
    );
    assert.throws(() => mod.patchConfig({}), /no CustomJavaScripts/);
    console.log("ok 10) refuses to double-seed or double-flip");
  }

  console.log("\njsi-jp828-patch.test.cjs: all checks passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
