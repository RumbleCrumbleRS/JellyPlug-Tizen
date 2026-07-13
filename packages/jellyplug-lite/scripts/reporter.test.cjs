/*
 * JELA-67 M3 slice 2: Lite.createReporter — the progress beacons that
 * make resume real (design doc §4, spike gate G5).
 *
 * Pinned invariants:
 *   - start → POST /Sessions/Playing; every 10s (injected interval) →
 *     /Sessions/Playing/Progress with EventName timeupdate + IsPaused
 *   - pause/unpause/seek call progress() with the matching EventName
 *   - stop(finalMs) → /Sessions/Playing/Stopped with the final
 *     PositionTicks (ms × 10000) — the value the server persists as
 *     UserData and the next boot's Continue Watching reads back
 *   - stop is one-shot: any later beacon (late interval tick, stray
 *     key) is inert, so a finished session can never be resurrected
 *   - a throwing postJson is swallowed — a lost beacon must never
 *     disturb playback
 */
"use strict";
const assert = require("node:assert");
const { loadLite } = require("./lite-testkit.cjs");

const Lite = loadLite();

// sandbox-realm objects vs host literals: normalize through JSON
const j = (o) => JSON.parse(JSON.stringify(o));

function harness(opts) {
  opts = opts || {};
  const posts = [];
  const intervals = new Map();
  let seq = 1;
  let posMs = 5000;
  let paused = false;
  const reporter = Lite.createReporter({
    base: "http://srv",
    token: "tok",
    postJson:
      opts.postJson ||
      ((url, headers, body) => posts.push({ url, headers, body })),
    itemId: "m1",
    mediaSourceId: "ms1",
    playSessionId: "ps1",
    positionMs: () => posMs,
    isPaused: () => paused,
    setInterval: (fn, ms) => {
      intervals.set(seq, { fn, ms });
      return seq++;
    },
    clearInterval: (id) => intervals.delete(id),
  });
  return {
    reporter,
    posts,
    intervals,
    setPos: (v) => (posMs = v),
    setPaused: (v) => (paused = v),
  };
}

// --- start: Playing beacon + 10s interval ----------------------------------
{
  const { reporter, posts, intervals } = harness();
  reporter.start();
  assert.strictEqual(posts.length, 1);
  assert.strictEqual(posts[0].url, "http://srv/Sessions/Playing");
  assert.deepStrictEqual(j(posts[0].headers), { "X-Emby-Token": "tok" });
  assert.deepStrictEqual(j(posts[0].body), {
    ItemId: "m1",
    MediaSourceId: "ms1",
    PlaySessionId: "ps1",
    PositionTicks: 5000 * 10000,
    PlayMethod: "DirectPlay",
    CanSeek: true,
  });
  assert.strictEqual(intervals.size, 1);
  assert.strictEqual([...intervals.values()][0].ms, 10000, "design §4 cadence");

  // interval tick → Progress with timeupdate + IsPaused
  const tick = [...intervals.values()][0].fn;
  tick();
  assert.strictEqual(posts[1].url, "http://srv/Sessions/Playing/Progress");
  assert.strictEqual(posts[1].body.EventName, "timeupdate");
  assert.strictEqual(posts[1].body.IsPaused, false);
  assert.strictEqual(posts[1].body.PlayMethod, "DirectPlay");

  // double start does not stack a second interval
  reporter.start();
  assert.strictEqual(intervals.size, 1);
}

// --- pause/unpause events carry live position + paused flag -----------------
{
  const { reporter, posts, setPos, setPaused } = harness();
  reporter.start();
  setPos(60000);
  setPaused(true);
  reporter.progress("pause");
  const p = posts[posts.length - 1];
  assert.strictEqual(p.body.EventName, "pause");
  assert.strictEqual(p.body.IsPaused, true);
  assert.strictEqual(p.body.PositionTicks, 60000 * 10000);
  setPaused(false);
  reporter.progress("unpause");
  assert.strictEqual(posts[posts.length - 1].body.EventName, "unpause");
  assert.strictEqual(posts[posts.length - 1].body.IsPaused, false);
}

// --- stop: final ticks, interval cleared, one-shot ---------------------------
{
  const { reporter, posts, intervals } = harness();
  reporter.start();
  reporter.stop(90000);
  const s = posts[posts.length - 1];
  assert.strictEqual(s.url, "http://srv/Sessions/Playing/Stopped");
  assert.deepStrictEqual(j(s.body), {
    ItemId: "m1",
    MediaSourceId: "ms1",
    PlaySessionId: "ps1",
    PositionTicks: 90000 * 10000,
  });
  assert.strictEqual(intervals.size, 0, "interval cleared");

  const n = posts.length;
  reporter.stop(999);
  reporter.progress("pause");
  reporter.start();
  assert.strictEqual(posts.length, n, "stopped reporter is fully inert");
}

// --- stop without finalMs falls back to positionMs() -------------------------
{
  const { reporter, posts, setPos } = harness();
  reporter.start();
  setPos(42000);
  reporter.stop();
  assert.strictEqual(
    posts[posts.length - 1].body.PositionTicks,
    42000 * 10000,
  );
}

// --- a throwing postJson never escapes ---------------------------------------
{
  const { reporter } = harness({
    postJson: () => {
      throw new Error("net down");
    },
  });
  reporter.start();
  reporter.progress("pause");
  reporter.stop(1);
}

console.log("reporter.test.cjs OK");
