/*
 * JELA-67 M3 slice 2: Lite.createPlaybackSession + Lite.createOsd —
 * one OK press end to end against fake adapter/reporter/OSD/timers.
 *
 * Pinned invariants (design doc §4):
 *   - first frame → reporter.start() (a failed open never reports)
 *   - repeated left/right presses COMPOUND into one debounced
 *     pipeline seek (G3: a live seek costs ~0.4-1s on the Q60R);
 *     the OSD previews the moving target immediately
 *   - seeks clamp to [0, duration - 2s] (tail guard vs
 *     onstreamcompleted races)
 *   - back → finish: position captured BEFORE stop() (G4 frozen
 *     clock), reporter.stop(final), onExit(ms, why), timers cleared
 *   - pre-first-frame error → onFallback (SPA path), never onExit,
 *     reporter untouched; post-first-frame error / stream end → onExit
 *   - a finished session is inert: keys return false, finish is
 *     idempotent, suspend/restore stop touching the adapter
 *   - OSD auto-hides 4s after the last show() but stays up while
 *     paused or buffering; every draw starts from clearRect (G2 —
 *     an opaque pixel covers the video plane)
 */
"use strict";
const assert = require("node:assert");
const { loadLite } = require("./lite-testkit.cjs");

const Lite = loadLite();

function fakeAvplay() {
  const calls = [];
  const self = {
    calls,
    listener: null,
    prepareOk: null,
    seekOk: null,
    seekErr: null,
    time: 0,
    duration: 600000,
    api: {
      open: (url) => calls.push(["open", url]),
      setListener: (l) => {
        self.listener = l;
      },
      setDisplayRect: () => {},
      prepareAsync: (ok, err) => {
        self.prepareOk = ok;
        self.prepareErr = err;
      },
      play: () => calls.push(["play"]),
      pause: () => calls.push(["pause"]),
      stop: () => calls.push(["stop"]),
      close: () => calls.push(["close"]),
      seekTo: (ms, ok, err) => {
        calls.push(["seekTo", ms]);
        self.seekOk = ok;
        self.seekErr = err;
      },
      getCurrentTime: () => self.time,
      getDuration: () => self.duration,
      suspend: () => calls.push(["suspend"]),
      restore: () => calls.push(["restore"]),
    },
  };
  return self;
}

function fakeTimers() {
  const live = new Map();
  let seq = 1;
  return {
    live,
    api: {
      setTimeout: (fn, ms) => {
        live.set(seq, { fn, ms, interval: false });
        return seq++;
      },
      clearTimeout: (id) => live.delete(id),
      setInterval: (fn, ms) => {
        live.set(seq, { fn, ms, interval: true });
        return seq++;
      },
      clearInterval: (id) => live.delete(id),
    },
    fire(pred) {
      for (const [id, t] of [...live.entries()]) {
        if (!pred || pred(t)) {
          if (!t.interval) live.delete(id);
          t.fn();
        }
      }
    },
  };
}

function harness(opts) {
  opts = opts || {};
  const av = fakeAvplay();
  const timers = fakeTimers();
  const events = [];
  const reporter = {
    start: () => events.push(["rep:start"]),
    progress: (e) => events.push(["rep:progress", e]),
    stop: (ms) => events.push(["rep:stop", ms]),
  };
  const osd = {
    shows: 0,
    draws: [],
    show() {
      this.shows++;
    },
    draw(s) {
      this.draws.push(s);
    },
  };
  let clock = 1000;
  const session = Lite.createPlaybackSession({
    avplay: av.api,
    reporter,
    osd,
    now: () => clock,
    setTimeout: timers.api.setTimeout,
    clearTimeout: timers.api.clearTimeout,
    setInterval: timers.api.setInterval,
    clearInterval: timers.api.clearInterval,
    runtimeMs: opts.runtimeMs || 0,
    urlAt: opts.urlAt || null,
    stopEncoding: opts.stopEncoding || null,
    diag: {},
    onExit: (ms, why) => events.push(["exit", ms, why]),
    onFallback: (why) => events.push(["fallback", why]),
  });
  return { av, timers, events, osd, session, tick: (ms) => (clock += ms) };
}

function firstFrame(h) {
  h.av.prepareOk();
  h.av.listener.oncurrentplaytime(h.av.time || 1);
}

// --- start → first frame → reporter.start, OSD tick armed -------------------
{
  const h = harness();
  assert.strictEqual(h.session.start("http://srv/v.mov", 0), true);
  assert.deepStrictEqual(h.av.calls[0], ["open", "http://srv/v.mov"]);
  assert.ok(
    [...h.timers.live.values()].some((t) => t.interval && t.ms === 500),
    "500ms OSD redraw tick armed",
  );
  assert.deepStrictEqual(h.events, [], "no beacon before first frame");
  h.av.time = 40;
  firstFrame(h);
  assert.deepStrictEqual(h.events, [["rep:start"]]);
  assert.ok(h.osd.shows > 0, "OSD shown on first frame");
}

// --- OK toggles pause and reports pause/unpause ------------------------------
{
  const h = harness();
  h.session.start("u", 0);
  firstFrame(h);
  assert.strictEqual(h.session.key(13), true);
  assert.deepStrictEqual(h.events.pop(), ["rep:progress", "pause"]);
  assert.strictEqual(h.session.player.state(), "paused");
  assert.strictEqual(h.session.key(10252), true, "MediaPlayPause");
  assert.deepStrictEqual(h.events.pop(), ["rep:progress", "unpause"]);
  assert.strictEqual(h.session.player.state(), "playing");

  // dedicated Media keys are state-conditional, never toggles
  assert.strictEqual(h.session.key(415), true, "MediaPlay while playing");
  assert.strictEqual(h.session.player.state(), "playing", "no-op");
  h.session.key(19); // MediaPause
  assert.strictEqual(h.session.player.state(), "paused");
  h.session.key(19);
  assert.strictEqual(h.session.player.state(), "paused", "no-op");
  h.session.key(415);
  assert.strictEqual(h.session.player.state(), "playing");
}

// --- compound seek: presses accumulate, ONE pipeline seek after debounce ----
{
  const h = harness();
  h.session.start("u", 0);
  firstFrame(h);
  h.av.time = 100000;
  h.session.key(39); // +30s → 130000
  h.session.key(39); // +30s → 160000
  h.session.key(37); // -10s → 150000
  assert.strictEqual(
    h.av.calls.filter((c) => c[0] === "seekTo").length,
    0,
    "nothing hits the pipeline while the debounce is live",
  );
  const preview = h.osd.draws[h.osd.draws.length - 1];
  assert.strictEqual(preview.posMs, 150000, "OSD previews the moving target");
  h.timers.fire((t) => !t.interval && t.ms === Lite.SEEK_DEBOUNCE_MS);
  assert.deepStrictEqual(
    h.av.calls.filter((c) => c[0] === "seekTo"),
    [["seekTo", 150000]],
    "one settled seek",
  );
  h.av.time = 150000;
  h.av.seekOk();
  assert.deepStrictEqual(h.events.pop(), ["rep:progress", "timeupdate"]);
}

// --- seek clamps: floor 0, ceiling duration - 2s tail guard ------------------
{
  const h = harness();
  h.session.start("u", 0);
  firstFrame(h);
  h.av.time = 4000;
  h.session.key(37); // -10s → clamp 0
  h.timers.fire((t) => !t.interval && t.ms === Lite.SEEK_DEBOUNCE_MS);
  assert.deepStrictEqual(h.av.calls.filter((c) => c[0] === "seekTo").pop(), [
    "seekTo",
    0,
  ]);
  h.av.time = 590000; // duration 600000
  h.session.key(39); // +30s → clamp 598000
  h.timers.fire((t) => !t.interval && t.ms === Lite.SEEK_DEBOUNCE_MS);
  assert.deepStrictEqual(h.av.calls.filter((c) => c[0] === "seekTo").pop(), [
    "seekTo",
    598000,
  ]);
}

// --- runtimeMs is the clock before the pipeline knows its duration ----------
{
  const h = harness({ runtimeMs: 300000 });
  h.av.duration = 0; // adapter not ready
  h.session.start("u", 0);
  firstFrame(h);
  h.av.time = 299000;
  h.session.key(39);
  h.timers.fire((t) => !t.interval && t.ms === Lite.SEEK_DEBOUNCE_MS);
  assert.deepStrictEqual(h.av.calls.filter((c) => c[0] === "seekTo").pop(), [
    "seekTo",
    298000,
  ]);
}

// --- back: frozen position → reporter.stop → onExit, timers cleared ----------
{
  const h = harness();
  h.session.start("u", 0);
  firstFrame(h);
  h.av.time = 120000;
  assert.strictEqual(h.session.key(10009), true);
  const stopIdx = h.av.calls.findIndex((c) => c[0] === "stop");
  const closeIdx = h.av.calls.findIndex((c) => c[0] === "close");
  assert.ok(stopIdx >= 0 && closeIdx > stopIdx, "stop then close (G4)");
  assert.deepStrictEqual(h.events.slice(-2), [
    ["rep:stop", 120000],
    ["exit", 120000, "back"],
  ]);
  assert.strictEqual(h.timers.live.size, 0, "all timers cleared");
  assert.strictEqual(h.session.active(), false);
  assert.strictEqual(h.session.key(13), false, "finished session is inert");
  const n = h.events.length;
  h.session.finish("again");
  assert.strictEqual(h.events.length, n, "finish idempotent");
}

// --- Red (403) exits playback like Back --------------------------------------
{
  const h = harness();
  h.session.start("u", 0);
  firstFrame(h);
  h.session.key(403);
  assert.strictEqual(h.events.pop()[2], "back");
}

// --- pre-first-frame error → onFallback, reporter untouched ------------------
{
  const h = harness();
  h.session.start("u", 0);
  h.av.prepareErr("boom");
  assert.deepStrictEqual(h.events, [["fallback", "prepare:boom"]]);
  assert.strictEqual(h.session.active(), false);
  assert.strictEqual(h.timers.live.size, 0);
}

// --- post-first-frame error → normal exit (reporter closed) ------------------
{
  const h = harness();
  h.session.start("u", 0);
  firstFrame(h);
  // the error tears the player down BEFORE finish() can poll, so the
  // reported position is the last observed tick (G4 frozen clock)
  h.av.listener.oncurrentplaytime(30000);
  h.av.listener.onerror("PLAYER_ERROR_UNKNOWN");
  assert.deepStrictEqual(h.events.slice(-2), [
    ["rep:stop", 30000],
    ["exit", 30000, "err"],
  ]);
}

// --- stream end → exit with the final tick ------------------------------------
{
  const h = harness();
  h.session.start("u", 0);
  firstFrame(h);
  h.av.listener.oncurrentplaytime(599000);
  h.av.listener.onstreamcompleted();
  assert.deepStrictEqual(h.events.slice(-2), [
    ["rep:stop", 599000],
    ["exit", 599000, "end"],
  ]);
}

// --- suspend/restore (v2.0.24 interplay §4) guarded by liveness --------------
{
  const h = harness();
  h.session.start("u", 0);
  firstFrame(h);
  h.session.suspend();
  h.session.restore();
  assert.ok(h.av.calls.some((c) => c[0] === "suspend"));
  assert.ok(h.av.calls.some((c) => c[0] === "restore"));
  h.session.key(10009);
  const n = h.av.calls.length;
  h.session.suspend();
  h.session.restore();
  assert.strictEqual(h.av.calls.length, n, "dead session leaves AVPlay alone");
}

// --- unmapped keys are refused (boot swallows them anyway) --------------------
{
  const h = harness();
  h.session.start("u", 0);
  firstFrame(h);
  assert.strictEqual(h.session.key(65), false);
}

/* ---------------------------------------------------------------------------
 * JELA-137: keyframe resume tolerance + DirectStream (remux) sessions
 * ------------------------------------------------------------------------- */

// --- direct resume backs off the keyframe window (G5 +9.9s outlier) ----------
{
  const h = harness();
  h.session.start("u", 90000);
  h.av.prepareOk();
  assert.deepStrictEqual(
    h.av.calls.filter((c) => c[0] === "seekTo"),
    [["seekTo", 80000]],
    "resume target backed off by RESUME_KEYFRAME_BACK_MS",
  );
}

// --- a resume inside the back-off window plays from the head ------------------
{
  const h = harness();
  h.session.start("u", 8000);
  h.av.prepareOk();
  assert.strictEqual(h.av.calls.filter((c) => c[0] === "seekTo").length, 0);
  assert.strictEqual(h.av.calls.filter((c) => c[0] === "play").length, 1);
}

// --- remux: resume + seeks ride StartTimeTicks URLs, never the pipeline -------
{
  const urls = [];
  const kills = [];
  const h = harness({
    runtimeMs: 600000,
    urlAt: (ms) => {
      urls.push(ms);
      return "R?st=" + ms;
    },
    stopEncoding: () => kills.push(1),
  });
  h.session.start("R", 90000, "remux");
  assert.deepStrictEqual(
    h.av.calls[0],
    ["open", "R?st=80000"],
    "biased resume rides the URL",
  );
  h.av.prepareOk();
  assert.strictEqual(
    h.av.calls.filter((c) => c[0] === "seekTo").length,
    0,
    "no pipeline seek on a remux",
  );
  h.av.time = 0;
  h.av.listener.oncurrentplaytime(1); // stream-relative tick
  assert.deepStrictEqual(h.events, [["rep:start"]]);

  // the clock is absolute media time: URL offset + stream tick
  h.av.time = 5000;
  h.session.key(38); // OSD
  const shown = h.osd.draws[h.osd.draws.length - 1];
  assert.strictEqual(shown.posMs, 85000, "offset + tick");
  assert.strictEqual(
    shown.durMs,
    600000,
    "remux ignores pipeline duration — RunTimeTicks drives the bar",
  );

  // +30s settles into ONE restart: old player torn down, old ffmpeg job
  // reaped, fresh player on the new StartTimeTicks URL
  h.session.key(39);
  h.timers.fire((t) => !t.interval && t.ms === Lite.SEEK_DEBOUNCE_MS);
  assert.deepStrictEqual(kills, [1], "encoding reaped before the restart");
  const opens = h.av.calls.filter((c) => c[0] === "open");
  assert.deepStrictEqual(opens[1], ["open", "R?st=115000"]);
  assert.deepStrictEqual(urls, [80000, 115000]);
  const stopI = h.av.calls.findIndex((c) => c[0] === "stop");
  const secondOpenI = h.av.calls.lastIndexOf(
    h.av.calls.filter((c) => c[0] === "open")[1],
  );
  assert.ok(stopI >= 0 && stopI < secondOpenI, "teardown before reopen");

  // the restarted stream settles as a progress beacon, not a second start
  h.av.prepareOk();
  h.av.time = 10;
  h.av.listener.oncurrentplaytime(10);
  assert.strictEqual(
    h.events.filter((e) => e[0] === "rep:start").length,
    1,
    "reporter started exactly once across restarts",
  );
  assert.deepStrictEqual(h.events[h.events.length - 1], [
    "rep:progress",
    "timeupdate",
  ]);

  // back: frozen position is absolute (new offset + last tick)
  h.av.time = 2000;
  assert.strictEqual(h.session.key(10009), true);
  assert.deepStrictEqual(h.events.slice(-2), [
    ["rep:stop", 117000],
    ["exit", 117000, "back"],
  ]);
  assert.strictEqual(h.timers.live.size, 0, "no timer leaks across restarts");
  assert.strictEqual(h.session.player.state(), "closed");
}

/* ---------------------------------------------------------------------------
 * Lite.createOsd + Lite.fmtTime
 * ------------------------------------------------------------------------- */

function fakeCtx() {
  const ops = [];
  const rec =
    (name) =>
    (...a) =>
      ops.push([name, ...a]);
  return {
    ops,
    clearRect: rec("clearRect"),
    fillRect: rec("fillRect"),
    fillText: rec("fillText"),
    beginPath: rec("beginPath"),
    moveTo: rec("moveTo"),
    lineTo: rec("lineTo"),
    closePath: rec("closePath"),
    fill: rec("fill"),
  };
}

// --- fmtTime ------------------------------------------------------------------
{
  assert.strictEqual(Lite.fmtTime(0), "0:00");
  assert.strictEqual(Lite.fmtTime(65000), "1:05");
  assert.strictEqual(Lite.fmtTime(600000), "10:00");
  assert.strictEqual(Lite.fmtTime(3600000), "1:00:00");
  assert.strictEqual(Lite.fmtTime(3661000), "1:01:01");
  assert.strictEqual(Lite.fmtTime(45296000), "12:34:56");
  assert.strictEqual(Lite.fmtTime(-5), "0:00", "negatives clamp");
}

// --- auto-hide + paused/buffering pinning --------------------------------------
{
  let clock = 0;
  const ctx = fakeCtx();
  const osd = Lite.createOsd({ ctx, title: "Heat", now: () => clock });
  const idle = { posMs: 0, durMs: 0, paused: false, buffering: false };

  assert.strictEqual(osd.visible(), false, "starts hidden");
  assert.strictEqual(osd.draw(idle), false);
  const clears = ctx.ops.filter((o) => o[0] === "clearRect").length;
  osd.draw(idle);
  assert.strictEqual(
    ctx.ops.filter((o) => o[0] === "clearRect").length,
    clears,
    "hidden draws clear once, then stay idle",
  );

  osd.show();
  assert.strictEqual(osd.visible(), true);
  assert.strictEqual(osd.draw(idle), true, "visible OSD draws");
  clock += 4000;
  assert.strictEqual(osd.visible(), false, "auto-hidden after 4s");
  assert.strictEqual(osd.draw(idle), false);

  // paused/buffering keep the overlay up past the hide deadline
  assert.strictEqual(osd.draw({ ...idle, paused: true }), true);
  assert.strictEqual(osd.draw({ ...idle, buffering: true }), true);
}

// --- every visible draw starts from clearRect (G2 transparency) ----------------
{
  const ctx = fakeCtx();
  const osd = Lite.createOsd({ ctx, title: "T", now: () => 0 });
  osd.show();
  osd.draw({ posMs: 60000, durMs: 600000, paused: false, buffering: true });
  assert.strictEqual(ctx.ops[0][0], "clearRect", "clear before any paint");
  assert.ok(
    ctx.ops.some((o) => o[0] === "fillText" && o[1] === "1:00 / 10:00"),
    "clock rendered",
  );
  assert.ok(
    ctx.ops.some((o) => o[0] === "fillText" && o[1] === "T"),
    "title rendered",
  );
  assert.ok(
    ctx.ops.some((o) => o[0] === "fillText" && String(o[1]).indexOf("Buffering") === 0),
    "buffering indicator rendered",
  );
}

console.log("session.test.cjs OK");
