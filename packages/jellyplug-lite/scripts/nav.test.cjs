"use strict";
const assert = require("node:assert");
const { loadLite } = require("./lite-testkit.cjs");

const Lite = loadLite();

// movement + clamping
const nav = Lite.createNav([5, 3, 8]);
assert.strictEqual(nav.row, 0);
assert.strictEqual(nav.col(), 0);
assert.strictEqual(nav.move("left"), false); // clamped at row start
assert.strictEqual(nav.move("up"), false); // clamped at first row
assert.ok(nav.move("right"));
assert.ok(nav.move("right"));
assert.strictEqual(nav.col(), 2);

// per-row column memory
assert.ok(nav.move("down"));
assert.strictEqual(nav.row, 1);
assert.strictEqual(nav.col(), 0); // fresh row starts at 0
assert.ok(nav.move("right"));
assert.ok(nav.move("down"));
assert.strictEqual(nav.row, 2);
assert.ok(nav.move("up"));
assert.strictEqual(nav.col(), 1); // row 1 remembered col 1
assert.ok(nav.move("up"));
assert.strictEqual(nav.col(), 2); // row 0 remembered col 2

// right edge clamp on the short row
nav.row = 1;
nav.cols[1] = 2;
assert.strictEqual(nav.move("right"), false);

// bottom row clamp
nav.row = 2;
assert.strictEqual(nav.move("down"), false);

// empty nav never moves
const empty = Lite.createNav([]);
assert.strictEqual(empty.move("down"), false);
assert.strictEqual(empty.col(), 0);

// setRowCounts: SWR revalidation can shrink/grow rows under focus
const nav2 = Lite.createNav([4, 4]);
nav2.move("right");
nav2.move("right");
nav2.move("right"); // col 3
nav2.move("down");
nav2.move("down"); // clamped at row 1
nav2.setRowCounts([2, 4, 6]); // row 0 shrank under a remembered col 3
assert.strictEqual(nav2.cols[0], 1); // clamped to new count-1
assert.strictEqual(nav2.rowCount(), 3);
nav2.setRowCounts([2]); // rows removed under focus
assert.strictEqual(nav2.row, 0);
assert.strictEqual(nav2.cols.length, 1);

// key map covers the Tizen remote set. 10182 (SmartHub/Home) is
// deliberately ABSENT: Samsung reserves the Home key and never delivers
// it (physical-remote QA 2026-07-11) — Red is the only escape mapping.
assert.deepStrictEqual(Object.keys(Lite.KEYS).sort(), [
  "10009",
  "13",
  "37",
  "38",
  "39",
  "40",
  "403",
]);
assert.strictEqual(Lite.KEYS[10009], "back");
assert.strictEqual(Lite.KEYS[403], "escape");
assert.strictEqual(Lite.KEYS[10182], undefined);

console.log("nav.test.cjs OK");
