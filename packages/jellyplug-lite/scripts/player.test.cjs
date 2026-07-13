/*
 * JELA-67 M3 slice 1: Lite.createPlayer — the native AVPlay lifecycle
 * skeleton — driven end-to-end against a fake adapter, plus the
 * Lite.boot native-playback surface (nativeSupported / openNative).
 *
 * Pinned invariants (design doc docs/lite-m3-avplay-design.md §4 and
 * spike gate G4):
 *   - open(url, posMs) runs open → setListener → setDisplayRect →
 *     prepareAsync → (posMs ? seekTo : nothing) → play, in that order
 *   - stop()+close() ALWAYS run on any exit — stop(), stream end,
 *     adapter error, prepare failure — even when stop() itself throws
 *     (a leaked player wedges the platform pipeline until app restart)
 *   - one instance = one playback: a second open() is refused, teardown
 *     is idempotent, late async callbacks after teardown are inert
 *   - first oncurrentplaytime tick after play() = "first frame":
 *     diag.ms = prepare→firstFrame, onFirstFrame fires exactly once
 *   - currentTimeMs() freezes at the last observed tick once dead
 *     (the Resume-row local patch reads it after Back)
 *   - a failed resume-seek degrades to playing from 0, never to an
 *     error (bouncing to the SPA would be worse than losing the seek)
 *   - openNative declines synchronously for container items / missing
 *     adapter, and takes playable leaves optimistically — the async
 *     PlaybackInfo outcome and the full press-to-restore loop are
 *     native-flow.test.cjs territory (M3 slice 2)
 */
"use strict";
const assert = require("node:assert");
const { loadLite, fakeStorage } = require("./lite-testkit.cjs");

function fakeAvplay(opts) {
  opts = opts || {};
  const calls = [];
  const self = {
    calls,
    listener: null,
    prepareOk: null,
    prepareErr: null,
    seekOk: null,
    seekErr: null,
    time: 1234,
    api: {
      open: (url) => {
        calls.push(["open", url]);
        if (opts.openThrows) throw new Error("open boom");
      },
      setListener: (l) => {
        calls.push(["setListener"]);
        self.listener = l;
      },
      setDisplayRect: (x, y, w, h) => calls.push(["rect", x, y, w, h]),
      prepareAsync: (ok, err) => {
        calls.push(["prepareAsync"]);
        self.prepareOk = ok;
        self.prepareErr = err;
      },
      play: () => {
        calls.push(["play"]);
        if (opts.playThrows) throw new Error("play boom");
      },
      pause: () => calls.push(["pause"]),
      stop: () => {
        calls.push(["stop"]);
        if (opts.stopThrows) throw new Error("stop boom");
      },
      close: () => calls.push(["close"]),
      seekTo: (ms, ok, err) => {
        calls.push(["seekTo", ms]);
        self.seekOk = ok;
        self.seekErr = err;
      },
      getCurrentTime: () => {
        calls.push(["getCurrentTime"]);
        return self.time;
      },
      getDuration: () => 600000,
    },
  };
  return self;
}

function named(calls, name) {
  return calls.filter((c) => c[0] === name);
}

const Lite = loadLite();

function mkPlayer(av, extra) {
  let clock = 1000;
  const events = [];
  const diag = {};
  const player = Lite.createPlayer(
    Object.assign(
      {
        avplay: av.api,
        now: () => clock,
        diag,
        onFirstFrame: (ms) => events.push(["firstFrame", ms]),
        onEnd: () => events.push(["end"]),
        onError: (why) => events.push(["error", why]),
      },
      extra || {},
    ),
  );
  return { player, diag, events, tick: (ms) => (clock += ms) };
}

// --- happy path: §4 call order, states, first-frame timing --------------
{
  const av = fakeAvplay();
  const { player, diag, events, tick } = mkPlayer(av);
  assert.strictEqual(player.state(), "idle");
  assert.strictEqual(diag.st, "idle");

  assert.strictEqual(player.open("http://srv/Videos/i/stream.mov", 0), true);
  assert.deepStrictEqual(
    av.calls.map((c) => c[0]),
    ["open", "setListener", "rect", "prepareAsync"],
    "§4 order up to prepareAsync",
  );
  assert.deepStrictEqual(av.calls[0], [
    "open",
    "http://srv/Videos/i/stream.mov",
  ]);
  assert.deepStrictEqual(av.calls[2], ["rect", 0, 0, 1920, 1080]);
  assert.strictEqual(player.state(), "preparing");
  assert.strictEqual(diag.url, "direct");

  tick(500);
  av.prepareOk();
  assert.strictEqual(named(av.calls, "seekTo").length, 0, "no seek at pos 0");
  assert.strictEqual(named(av.calls, "play").length, 1);
  assert.strictEqual(player.state(), "playing");

  tick(300);
  av.listener.oncurrentplaytime(40);
  assert.deepStrictEqual(events, [["firstFrame", 800]]);
  assert.strictEqual(diag.ms, 800);
  av.listener.oncurrentplaytime(500);
  assert.strictEqual(events.length, 1, "first frame fires exactly once");

  // live currentTimeMs polls the adapter
  av.time = 4321;
  assert.strictEqual(player.currentTimeMs(), 4321);
  assert.strictEqual(player.durationMs(), 600000);

  // pause / resume toggle
  assert.strictEqual(player.playPause(), true);
  assert.strictEqual(player.state(), "paused");
  assert.strictEqual(player.playPause(), true);
  assert.strictEqual(player.state(), "playing");

  // seek wrapper reports via the success callback (G3 shape)
  let seekResult = null;
  player.seekTo(30000, (ok) => (seekResult = ok));
  assert.deepStrictEqual(named(av.calls, "seekTo").pop(), ["seekTo", 30000]);
  av.seekOk();
  assert.strictEqual(seekResult, true);

  // stop: stop+close, frozen time, idempotent
  av.time = 99999;
  player.currentTimeMs(); // observe the final position while live
  const getCalls = named(av.calls, "getCurrentTime").length;
  player.stop();
  assert.strictEqual(player.state(), "closed");
  assert.strictEqual(diag.st, "closed");
  assert.strictEqual(named(av.calls, "stop").length, 1);
  assert.strictEqual(named(av.calls, "close").length, 1);
  assert.strictEqual(player.currentTimeMs(), 99999, "frozen after close");
  assert.strictEqual(
    named(av.calls, "getCurrentTime").length,
    getCalls,
    "dead player never touches the adapter clock",
  );
  assert.strictEqual(player.durationMs(), 0);
  player.stop();
  assert.strictEqual(named(av.calls, "close").length, 1, "teardown idempotent");

  // one-shot: the used instance refuses a second open
  assert.strictEqual(player.open("http://x", 0), false);
  assert.strictEqual(named(av.calls, "open").length, 1);
}

// --- resume: posMs > 0 seeks between prepare and play --------------------
{
  const av = fakeAvplay();
  const { player } = mkPlayer(av);
  player.open("u", 90000);
  av.prepareOk();
  assert.deepStrictEqual(named(av.calls, "seekTo"), [["seekTo", 90000]]);
  assert.strictEqual(named(av.calls, "play").length, 0, "no play before seek");
  av.seekOk();
  assert.strictEqual(named(av.calls, "play").length, 1);
  assert.strictEqual(player.state(), "playing");
}

// --- a failed resume-seek still plays from 0 (not fatal) -----------------
{
  const av = fakeAvplay();
  const { player, events } = mkPlayer(av);
  player.open("u", 90000);
  av.prepareOk();
  av.seekErr();
  assert.strictEqual(player.state(), "playing");
  assert.deepStrictEqual(events, [], "no error surfaced");
}

// --- prepare failure: teardown + onError ---------------------------------
{
  const av = fakeAvplay();
  const { player, events } = mkPlayer(av);
  player.open("u", 0);
  av.prepareErr("boom");
  assert.strictEqual(player.state(), "err");
  assert.strictEqual(named(av.calls, "stop").length, 1);
  assert.strictEqual(named(av.calls, "close").length, 1);
  assert.deepStrictEqual(events, [["error", "prepare:boom"]]);
}

// --- adapter open() throwing: open returns false, teardown ran -----------
{
  const av = fakeAvplay({ openThrows: true });
  const { player, events } = mkPlayer(av);
  assert.strictEqual(player.open("u", 0), false);
  assert.strictEqual(player.state(), "err");
  assert.strictEqual(named(av.calls, "close").length, 1);
  assert.deepStrictEqual(events, [["error", "open"]]);
}

// --- listener onerror mid-playback: teardown + onError -------------------
{
  const av = fakeAvplay();
  const { player, events } = mkPlayer(av);
  player.open("u", 0);
  av.prepareOk();
  av.listener.onerror("PLAYER_ERROR_INVALID_OPERATION");
  assert.strictEqual(player.state(), "err");
  assert.strictEqual(named(av.calls, "close").length, 1);
  assert.deepStrictEqual(events, [
    ["error", "avplay:PLAYER_ERROR_INVALID_OPERATION"],
  ]);
}

// --- stream end: teardown + onEnd (no error) ------------------------------
{
  const av = fakeAvplay();
  const { player, events } = mkPlayer(av);
  player.open("u", 0);
  av.prepareOk();
  av.listener.oncurrentplaytime(599000);
  av.listener.onstreamcompleted();
  assert.strictEqual(player.state(), "closed");
  assert.strictEqual(named(av.calls, "close").length, 1);
  assert.deepStrictEqual(events.pop(), ["end"]);
  assert.ok(!events.some((e) => e[0] === "error"));
  assert.strictEqual(player.currentTimeMs(), 599000, "final tick kept");
}

// --- G4 hard rule: stop() throwing must not skip close() ------------------
{
  const av = fakeAvplay({ stopThrows: true });
  const { player } = mkPlayer(av);
  player.open("u", 0);
  av.prepareOk();
  player.stop();
  assert.strictEqual(named(av.calls, "close").length, 1);
  assert.strictEqual(player.state(), "closed");
}

// --- teardown while preparing: the late prepare callback is inert ---------
{
  const av = fakeAvplay();
  const { player } = mkPlayer(av);
  player.open("u", 0);
  player.stop();
  assert.strictEqual(player.state(), "closed");
  av.prepareOk(); // arrives after the user already backed out
  assert.strictEqual(named(av.calls, "play").length, 0);
  assert.strictEqual(player.state(), "closed");
}

// --- play() throwing after prepare: teardown + onError ---------------------
{
  const av = fakeAvplay({ playThrows: true });
  const { player, events } = mkPlayer(av);
  player.open("u", 0);
  av.prepareOk();
  assert.strictEqual(player.state(), "err");
  assert.strictEqual(named(av.calls, "close").length, 1);
  assert.deepStrictEqual(events, [["error", "play"]]);
}

// --- seek wrapper guards: dead/idle player answers cb(false) ---------------
{
  const av = fakeAvplay();
  const { player } = mkPlayer(av);
  let r = null;
  player.seekTo(1000, (ok) => (r = ok));
  assert.strictEqual(r, false, "idle player refuses seeks");
  assert.strictEqual(named(av.calls, "seekTo").length, 0);

  player.open("u", 0);
  av.prepareOk();
  player.seekTo(-500, () => {});
  assert.deepStrictEqual(named(av.calls, "seekTo").pop(), ["seekTo", 0]);
}

// --- buffering flag tracks the listener pair -------------------------------
{
  const av = fakeAvplay();
  const { player } = mkPlayer(av);
  player.open("u", 0);
  av.prepareOk();
  assert.strictEqual(player.buffering(), false);
  av.listener.onbufferingstart();
  assert.strictEqual(player.buffering(), true);
  av.listener.onbufferingcomplete();
  assert.strictEqual(player.buffering(), false);
}

// --- custom display rect ----------------------------------------------------
{
  const av = fakeAvplay();
  const { player } = mkPlayer(av, { vw: 1280, vh: 720 });
  player.open("u", 0);
  assert.deepStrictEqual(named(av.calls, "rect")[0], ["rect", 0, 0, 1280, 720]);
}

// --- isPlayableLeaf matrix (design doc §1 fork) -----------------------------
{
  for (const t of ["Movie", "Episode", "Video", "MusicVideo"]) {
    assert.strictEqual(Lite.isPlayableLeaf(t), true, t + " is a leaf");
  }
  for (const t of ["Series", "BoxSet", "Playlist", "Season", "", undefined]) {
    assert.strictEqual(Lite.isPlayableLeaf(t), false, t + " is not a leaf");
  }
}

// --- Lite.boot surface: nativeSupported + openNative routing stance --------
function fakeXhr() {
  return { open() {}, setRequestHeader() {}, send() {} };
}
function fakeDoc() {
  return {
    createElement: () => ({
      width: 0,
      height: 0,
      style: {},
      getContext: () => ({}),
    }),
    body: { appendChild: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}
function fakeWin(webapis) {
  let seq = 1;
  return {
    localStorage: fakeStorage({
      jellyfin_credentials: JSON.stringify({
        Servers: [
          {
            Id: "s1",
            AccessToken: "tok",
            UserId: "u1",
            ManualAddress: "http://srv",
          },
        ],
      }),
    }),
    requestAnimationFrame: () => {},
    setTimeout: () => seq++,
    clearTimeout: () => {},
    setInterval: () => seq++,
    clearInterval: () => {},
    webapis,
  };
}

{
  const LiteB = loadLite({ XMLHttpRequest: fakeXhr });
  const av = fakeAvplay();
  const app = LiteB.boot(fakeWin({ avplay: av.api }), fakeDoc());
  assert.ok(app, "boot returns an app with stored creds");
  assert.strictEqual(app.nativeSupported, true);
  // slice 2: playable leaves are taken optimistically (PlaybackInfo
  // decides async); containers/nothing decline; and the adapter is
  // never touched before a direct-play GO
  assert.strictEqual(app.openNative({ id: "i", type: "Series" }), false);
  assert.strictEqual(app.openNative(null), false);
  assert.strictEqual(app.openNative({ id: "i", type: "Movie" }), true);
  assert.strictEqual(av.calls.length, 0, "no adapter call before the GO");
}

{
  const LiteB = loadLite({ XMLHttpRequest: fakeXhr });
  const app = LiteB.boot(fakeWin(undefined), fakeDoc());
  assert.strictEqual(app.nativeSupported, false, "no webapis → unsupported");
  assert.strictEqual(app.openNative({ id: "i", type: "Movie" }), false);
}

// --- card model carries the resume position (design doc §4) ----------------
{
  const api = Lite.createApi({
    base: "http://srv",
    token: "tok",
    userId: "u1",
    fetchJson: (url, headers, cb) => {
      if (url.indexOf("/Items/Resume") >= 0) {
        return cb(null, {
          Items: [
            {
              Id: "m1",
              Name: "Heat",
              Type: "Movie",
              RunTimeTicks: 102e9,
              UserData: { PlaybackPositionTicks: 48e8 },
            },
          ],
        });
      }
      cb(null, { Items: [] });
    },
  });
  let sections;
  api.home((err, s) => (sections = s));
  const card = sections[0].items[0];
  assert.strictEqual(card.posTicks, 48e8);
  assert.strictEqual(card.runtimeTicks, 102e9);
}

// items without UserData / RunTimeTicks default to 0 (never undefined —
// the SWR JSON round-trip must stay shape-stable)
{
  const api = Lite.createApi({
    base: "http://srv",
    token: "tok",
    userId: "u1",
    fetchJson: (url, headers, cb) => {
      if (url.indexOf("/Items/Resume") >= 0) {
        return cb(null, { Items: [{ Id: "m2", Name: "X", Type: "Movie" }] });
      }
      cb(null, { Items: [] });
    },
  });
  let sections;
  api.home((err, s) => (sections = s));
  assert.strictEqual(sections[0].items[0].posTicks, 0);
  assert.strictEqual(sections[0].items[0].runtimeTicks, 0);
}

console.log("player.test.cjs OK");
