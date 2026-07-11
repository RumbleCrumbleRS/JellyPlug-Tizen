"use strict";
const assert = require("node:assert");
const { loadLite } = require("./lite-testkit.cjs");

const Lite = loadLite();
const L = Lite.layout;
const M = L.metrics;

// geometry basics
assert.strictEqual(L.rowY(0), M.topPad);
assert.strictEqual(L.rowY(2) - L.rowY(1), L.rowPitch());
assert.strictEqual(L.cardX(0), M.rowPadL);
assert.strictEqual(L.cardX(3) - L.cardX(2), M.cardW + M.gapX);

// vertical scroll: few rows -> no scroll; focused row parks at topPad
assert.strictEqual(L.maxScrollY(1), 0);
assert.strictEqual(L.targetScrollY(0, 8), 0);
const manyRows = 8;
assert.ok(L.maxScrollY(manyRows) > 0);
assert.strictEqual(
  L.targetScrollY(3, manyRows),
  Math.min(L.rowY(3) - M.topPad, L.maxScrollY(manyRows)),
);
// last row target never exceeds maxScrollY
assert.strictEqual(
  L.targetScrollY(manyRows - 1, manyRows),
  L.maxScrollY(manyRows),
);

// horizontal scroll: focused card parks at rowPadL, clamped at row end
assert.strictEqual(L.targetScrollX(0, 12), 0);
assert.strictEqual(L.targetScrollX(5, 12), L.cardX(5) - M.rowPadL);
assert.strictEqual(L.targetScrollX(11, 12), L.maxScrollX(12));
// short row never scrolls
assert.strictEqual(L.maxScrollX(3), 0);
assert.strictEqual(L.targetScrollX(2, 3), 0);

// visible window math: at scroll 0 the first card is col 0 and the range
// covers at least the cards that physically fit across 1920px
const vis0 = L.visibleCols(0, 40);
assert.strictEqual(vis0.first, 0);
const fits = Math.ceil((M.vw - M.rowPadL) / (M.cardW + M.gapX));
assert.ok(vis0.last >= fits - 1, `last ${vis0.last} < ${fits - 1}`);
assert.ok(vis0.last <= fits + 1, "overdraw pad should be ~1 card");

// scrolled window starts before the viewport edge (1-card pad, no pop-in)
const sx = L.targetScrollX(10, 40);
const vis10 = L.visibleCols(sx, 40);
assert.ok(vis10.first <= 10 - 1);
assert.ok(vis10.first >= 10 - 3);

// clamped to card count
const visEnd = L.visibleCols(L.maxScrollX(12), 12);
assert.strictEqual(visEnd.last, 11);
assert.strictEqual(L.visibleCols(0, 0), null);

// visible rows mirror the same contract
const vr = L.visibleRows(0, 8);
assert.strictEqual(vr.first, 0);
assert.ok(vr.last >= 1);
assert.strictEqual(L.visibleRows(0, 0), null);

// focus ring wraps the scaled card symmetrically
const fr = L.focusRect(0, 0);
const grow = (M.cardW * M.focusScale - M.cardW) / 2 + M.focusRingPad;
assert.ok(Math.abs(fr.x - (L.cardX(0) - grow)) < 1e-9);
assert.ok(
  Math.abs(fr.w - (M.cardW * M.focusScale + 2 * M.focusRingPad)) < 1e-9,
);
assert.ok(
  Math.abs(fr.h - (M.cardH * M.focusScale + 2 * M.focusRingPad)) < 1e-9,
);

console.log("layout.test.cjs OK");
