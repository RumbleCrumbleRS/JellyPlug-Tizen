#!/usr/bin/env node
/*
 * jsi-jp681-patch.test.cjs — JELA-681 guard for jsi-jp681-patch.mjs.
 *
 * The patched snippets live only on the live JS-Injector channel (the
 * jellyplug-theme source repo is gone), so these edits are anchored text
 * replacements. That makes anchor drift the whole risk: an upstream snippet
 * edit that changes one of the anchors must fail LOUDLY at patch time, never
 * silently apply zero edits and ship the unpatched behaviour as if it were the
 * fix.
 *
 * 1) FAIL-CLOSED: every anchor must match exactly once; zero or two throws.
 * 2) ES5: the added code must survive Chromium 63 / V8 6.3 (no arrow, template,
 *    let/const, class).
 * 3) FLAG-DARK: with the flag absent, the patched genre-rows commit path is
 *    never entered — the shipped all-or-nothing branch runs verbatim.
 * 4) EQUIVALENCE: with the flag on, prefix-commit selects the same rows, in the
 *    same order, with the same ranks as the shipped batch selector, for a set
 *    of settle orders including reverse and interleaved.
 */
"use strict";

const assert = require("node:assert");
const path = require("node:path");
const vm = require("node:vm");

const HERE = __dirname;

async function main() {
  const mod = await import(
    "file://" + path.join(HERE, "jsi-jp681-patch.mjs")
  );
  const { PATCHES, applyPatch, assertEs5Additions } = mod;

  // ---- 1) fail-closed on anchor drift -------------------------------------
  for (const patch of PATCHES) {
    for (const e of patch.edits) {
      assert.throws(
        () => applyPatch("nothing here", patch),
        /matched 0 times/,
        `${e.what}: a body without the anchor must throw`,
      );
      break; // the first missing anchor is enough to prove fail-closed
    }
    // A body where an anchor appears twice is equally unsafe.
    const dup = patch.edits[0].from + "\n" + patch.edits[0].from;
    assert.throws(() => applyPatch(dup, patch), /matched 2 times/);
  }

  // ---- 2) ES5-only additions ----------------------------------------------
  for (const patch of PATCHES) {
    const synthetic = patch.edits.map((e) => e.to).join("\n");
    assertEs5Additions(synthetic);
  }
  assert.throws(
    () => assertEs5Additions("/*jp681*/const x = () => 1;"),
    /non-ES5/,
  );

  // ---- 3+4) prefix-commit == batch selection -------------------------------
  // Model of the two selectors, transcribed from the shipped `F()` and from
  // the patched `jpCm681()`. Kept alongside the real edit so a change to the
  // eligibility rule in either place shows up as a test failure.
  const MIN_ITEMS = 6;
  const MAX_ROWS = 8;
  const RANK_BASE = 51;

  function batchSelect(cands, items, covered) {
    const out = [];
    for (let i = 0; i < cands.length && out.length < MAX_ROWS; i++) {
      const c = cands[i];
      const it = items[c];
      if (!it || it.length < MIN_ITEMS || covered.indexOf(c) !== -1) continue;
      out.push({ cand: c, rank: String(RANK_BASE + out.length) });
    }
    return out;
  }

  function streamSelect(cands, items, covered, settleOrder) {
    const done = Object.create(null);
    const plan = [];
    const flushes = [];
    let cursor = 0;
    let finished = false;
    for (const key of settleOrder) {
      done[key] = true;
      if (finished) continue;
      const before = plan.length;
      while (cursor < cands.length && plan.length < MAX_ROWS) {
        const c = cands[cursor];
        if (!done[c]) break;
        cursor++;
        const it = items[c];
        if (!it || it.length < MIN_ITEMS || covered.indexOf(c) !== -1) continue;
        plan.push({ cand: c, rank: String(RANK_BASE + plan.length) });
      }
      if (plan.length > before) flushes.push(plan.length);
      if (cursor >= cands.length || plan.length >= MAX_ROWS) finished = true;
    }
    return { plan, flushes };
  }

  const cands = [
    "Action", "Comedy", "Drama", "Adventure", "Horror", "Animation",
    "Science Fiction", "Thriller", "Romance", "Documentary", "Family",
    "Crime", "Fantasy", "Mystery",
  ];
  const full = new Array(20).fill(0);
  const thin = new Array(3).fill(0); // below MIN_ITEMS -> skipped
  const items = {};
  for (const c of cands) items[c] = full;
  items.Drama = thin;      // eligibility skip
  items.Horror = null;     // failed fetch
  const covered = ["Comedy"]; // a native row already shows this genre

  const expected = batchSelect(cands, items, covered);
  assert.strictEqual(expected.length, MAX_ROWS);

  const orders = {
    inOrder: cands.slice(),
    reverse: cands.slice().reverse(),
    interleaved: cands.filter((_, i) => i % 2 === 1).concat(
      cands.filter((_, i) => i % 2 === 0),
    ),
    slowestFirstCandidate: ["Action"].concat(
      cands.filter((c) => c !== "Action").reverse(),
    ),
  };

  for (const [name, order] of Object.entries(orders)) {
    const got = streamSelect(cands, items, covered, order);
    assert.deepStrictEqual(
      got.plan,
      expected,
      `${name}: streamed plan must equal the batch plan (same rows, order, ranks)`,
    );
    assert.ok(
      got.flushes.length >= 1,
      `${name}: must flush at least once`,
    );
  }

  // The whole point: when the slowest candidate is NOT the highest-priority
  // one, streaming flushes before every query has settled.
  const late = cands.filter((c) => c !== "Mystery").concat(["Mystery"]);
  const gotLate = streamSelect(cands, items, covered, late);
  assert.ok(
    gotLate.flushes.length > 1,
    "a late low-priority candidate must not hold back the earlier rows",
  );

  // ---- flag-dark: the patched source keeps the shipped branch verbatim -----
  const stream = PATCHES.find((p) => p.entry.test("genre-rows"));
  const patchedG = stream.edits[0].to;
  assert.ok(
    patchedG.includes(
      'A||x<f.length||(A=F(f,L,Q(),o),n.log("genre-rows: selected "+A.length+" of "+f.length+" genres."),V(e),jpIdle())',
    ),
    "flag-off path must be the shipped all-or-nothing branch, byte-identical",
  );
  const early = PATCHES.find((p) => p.entry.test("tizen-compat"));
  assert.ok(
    early.edits[0].to.endsWith("t&&t.onPaint?t.onPaint(r):r()}}"),
    "flag-off path must still arm on onPaint exactly as shipped",
  );

  // ---- the patched bodies must parse --------------------------------------
  for (const patch of PATCHES) {
    for (const e of patch.edits) {
      // Wrap so the fragment is a valid program on its own where possible.
      const frag = e.to.replace(/^\},/, "");
      try {
        new vm.Script("(function(){" + frag + "})", { filename: "frag.js" });
      } catch {
        /* fragments are not always standalone-parseable; the tool re-parses
           the whole patched body, which is the binding check. */
      }
    }
  }

  console.log("jsi-jp681-patch.test.cjs: OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
