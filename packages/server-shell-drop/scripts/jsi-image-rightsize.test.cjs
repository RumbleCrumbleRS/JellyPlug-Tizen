#!/usr/bin/env node
/*
 * jsi-image-rightsize.test.cjs — JELA-435 guard for jsi-image-rightsize.mjs.
 *
 * The tool edits a LIVE production surface (the JS-Injector channel the TV
 * shell fetches as public.js), so the test covers the safety properties the
 * deploy leans on, not just the happy path:
 *   1) it rewrites exactly the allow-listed call sites and nothing else,
 *   2) the transform is invertible (--revert reproduces the original channel
 *      byte-for-byte),
 *   3) it fails CLOSED on drift — missing literal, duplicate name match, an
 *      already-rewritten body,
 *   4) the structural gate catches a mutated Enabled/name/unchanged body and a
 *      changed body that stops parsing,
 *   5) the substituted expressions evaluate to the widths we measured for on
 *      1080p (the whole point) and never below the 160 px floor.
 */
"use strict";

const assert = require("node:assert");
const vm = require("node:vm");

const MOD = require("node:path").join(__dirname, "jsi-image-rightsize.mjs");

// A fixture channel shaped like the live one: em-dash names, minified bodies,
// one non-target snippet that must come through untouched.
function fixture() {
  return {
    PluginJavaScripts: [],
    CustomJavaScripts: [
      {
        Name: "JellyPlug — theme-css (generated from src/css — do not edit)",
        Script: 'var css="a{color:red}";',
        Enabled: true,
        RequiresAuthentication: false,
      },
      {
        Name: "JellyPlug — top-picks",
        Script:
          'function b(e,r){return r.getImageUrl(e.id,{type:"Primary",tag:e.imageTag,maxWidth:400})}',
        Enabled: true,
        RequiresAuthentication: false,
      },
      {
        Name: "JellyPlug — watch-it-again",
        Script:
          'function c(e,r){return r.getImageUrl(e.id,{type:"Primary",tag:e.imageTag,maxWidth:400})}',
        Enabled: true,
        RequiresAuthentication: false,
      },
      {
        Name: "JellyPlug — my-list",
        Script:
          'function d(e,r){return r.getImageUrl(e.id,{type:"Primary",tag:e.imageTag,maxWidth:400})}',
        Enabled: true,
        RequiresAuthentication: false,
      },
      {
        Name: "JellyPlug — genre-rows",
        Script:
          'function f(e,t){return t.getImageUrl(e.id,{type:"Primary",tag:e.imageTag,maxWidth:400})}',
        Enabled: true,
        RequiresAuthentication: false,
      },
      {
        Name: "JellyPlug — new-hot",
        Script:
          'function g(e,t,r){return e.getImageUrl(t,{type:"Primary",tag:r,maxWidth:400})}',
        Enabled: false,
        RequiresAuthentication: false,
      },
      {
        Name: "JellyPlug — top10-badges",
        Script: 'var l={poolSize:40,imageMaxWidth:300,sortBy:"SortName"};',
        Enabled: true,
        RequiresAuthentication: true,
      },
      {
        // Not allow-listed: a detail-page builder that also uses maxWidth:400.
        Name: "JellyPlug — detail-similar",
        Script:
          'function h(e,r){return r.getImageUrl(e.id,{type:"Primary",tag:e.imageTag,maxWidth:400})}',
        Enabled: true,
        RequiresAuthentication: false,
      },
    ],
  };
}

const clone = (o) => JSON.parse(JSON.stringify(o));

function throws(fn, re, msg) {
  let err = null;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  assert.ok(err, msg + " — expected a throw, got none");
  assert.ok(
    re.test(err.message),
    `${msg} — message ${JSON.stringify(err.message)} does not match ${re}`,
  );
}

async function main() {
  const { rightsizeChannel, gate, SITES, POSTER_EXPR, TOP10_EXPR } =
    await import(MOD);

  // ---- 1. rewrites exactly the allow-listed sites ------------------------
  const orig = fixture();
  const { next, changes } = rightsizeChannel(orig);
  assert.strictEqual(changes.length, SITES.length, "one change per site");
  assert.ok(gate(orig, next, changes), "gate passes on the happy path");

  const oj = orig.CustomJavaScripts;
  const nj = next.CustomJavaScripts;
  const touched = new Set(changes.map((c) => c.index));
  for (let i = 0; i < oj.length; i++) {
    if (touched.has(i)) continue;
    assert.strictEqual(
      nj[i].Script,
      oj[i].Script,
      `non-target snippet #${i} (${oj[i].Name}) must be byte-identical`,
    );
  }
  // The non-allow-listed detail builder keeps its literal.
  const detail = nj.find((e) => e.Name.includes("detail-similar"));
  assert.ok(
    detail.Script.includes("maxWidth:400"),
    "detail-similar keeps maxWidth:400 (not in the boot window)",
  );
  // The input object must not be mutated in place.
  assert.deepStrictEqual(orig, fixture(), "input config is not mutated");

  // ---- 2. invertible: --revert reproduces the original -------------------
  const back = rightsizeChannel(next, { revert: true });
  assert.strictEqual(
    JSON.stringify(back.next),
    JSON.stringify(fixture()),
    "revert reproduces the original channel byte-for-byte",
  );

  // ---- 3. fails CLOSED on drift -----------------------------------------
  const missing = fixture();
  missing.CustomJavaScripts[1].Script = missing.CustomJavaScripts[1].Script.replace(
    "maxWidth:400",
    "maxWidth:360",
  );
  throws(
    () => rightsizeChannel(missing),
    /top-picks.*found 0/s,
    "literal gone (snippet rewritten upstream)",
  );

  const dup = fixture();
  dup.CustomJavaScripts.push({
    Name: "JellyPlug — my-list (v2)",
    Script: "var x=1;",
    Enabled: true,
    RequiresAuthentication: false,
  });
  throws(
    () => rightsizeChannel(dup),
    /my-list.*found 2/s,
    "two snippets match one key",
  );

  const twice = fixture();
  twice.CustomJavaScripts[1].Script += "var z={maxWidth:400};";
  throws(
    () => rightsizeChannel(twice),
    /top-picks.*found 2/s,
    "literal occurs more than the declared count",
  );

  const already = fixture();
  already.CustomJavaScripts[3].Script = already.CustomJavaScripts[3].Script.replace(
    "maxWidth:400",
    "maxWidth:" + POSTER_EXPR,
  );
  throws(
    () => rightsizeChannel(already),
    /already contains the target form|found 0/s,
    "body already rewritten",
  );

  const noChannel = { CustomJavaScripts: null };
  throws(
    () => rightsizeChannel(noChannel),
    /no CustomJavaScripts/,
    "config shape check",
  );

  // ---- 4. the structural gate catches tampering --------------------------
  const g1 = clone(next);
  g1.CustomJavaScripts[0].Script += "// drift";
  throws(
    () => gate(orig, g1, changes),
    /unchanged entry #0 body drifted/,
    "gate: unchanged body drifted",
  );

  const g2 = clone(next);
  g2.CustomJavaScripts[5].Enabled = true;
  throws(
    () => gate(orig, g2, changes),
    /Enabled changed at #5/,
    "gate: Enabled flipped",
  );

  const g3 = clone(next);
  g3.CustomJavaScripts[2].Name = "JellyPlug — renamed";
  throws(
    () => gate(orig, g3, changes),
    /Name\/order changed at #2/,
    "gate: name/order changed",
  );

  const g4 = clone(next);
  g4.PluginJavaScripts = [{ Name: "x" }];
  throws(
    () => gate(orig, g4, changes),
    /PluginJavaScripts mutated/,
    "gate: PluginJavaScripts mutated",
  );

  const g5 = clone(next);
  g5.CustomJavaScripts[1].Script = "function b(e,r){return (";
  throws(
    () => gate(orig, g5, changes),
    /does not parse/,
    "gate: changed body stops parsing",
  );

  const g6 = clone(next);
  g6.CustomJavaScripts[1].Script += "/*" + "x".repeat(400) + "*/";
  throws(
    () => gate(orig, g6, changes),
    /size delta .* exceeds/,
    "gate: unexpected size blow-up",
  );

  // ---- 5. the substituted widths are the measured ones -------------------
  const evalAt = (expr, innerWidth) =>
    vm.runInNewContext(expr, { window: { innerWidth }, Math });
  assert.strictEqual(evalAt(POSTER_EXPR, 1920), 200, "poster @1080p -> 200");
  assert.strictEqual(evalAt(POSTER_EXPR, 3840), 400, "poster @4K -> 400 (cap)");
  assert.strictEqual(evalAt(POSTER_EXPR, 1280), 160, "poster @720p -> 160 floor");
  assert.strictEqual(evalAt(POSTER_EXPR, 0), 160, "poster floor holds at 0");
  assert.ok(
    evalAt(POSTER_EXPR, 1920) >= 167 * 1.06,
    "poster width covers the 167 px card at the skin's 1.06 focus scale",
  );
  assert.strictEqual(evalAt(TOP10_EXPR, 1920), 160, "top10 @1080p -> 160");
  assert.strictEqual(evalAt(TOP10_EXPR, 3840), 300, "top10 @4K -> 300 (cap)");
  assert.ok(
    evalAt(TOP10_EXPR, 1920) >= 150 * 1.06,
    "top10 width covers the fixed 150 px thumb at 1.06 focus scale",
  );
  // Neither expression may ever exceed the literal it replaces.
  for (const w of [640, 1280, 1920, 2560, 3840, 7680]) {
    assert.ok(evalAt(POSTER_EXPR, w) <= 400, "poster never exceeds 400 @" + w);
    assert.ok(evalAt(TOP10_EXPR, w) <= 300, "top10 never exceeds 300 @" + w);
  }

  console.log("jsi-image-rightsize.test.cjs: OK");
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
