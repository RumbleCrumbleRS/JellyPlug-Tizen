/*
 * JELA-67 M3 slice 2: the full native OK press through Lite.boot —
 * openNative → PlaybackInfo → canvas hole → session → exit restore /
 * SPA fallback — against a fake window/document/XHR/adapter, with the
 * shell's onOpen fork mimicked exactly as shell.js implements it.
 *
 * Pinned invariants:
 *   - openNative takes the press optimistically (true) and issues ONE
 *     PlaybackInfo POST; repeats during the pending window are
 *     swallowed, container types and no-adapter boots decline
 *   - direct-play answer → home canvas hidden, transparent OSD canvas
 *     appended, body background transparent (spike gate G2), player
 *     opened on stream.{ms.Container} with the card's posTicks resume
 *   - every pre-first-frame failure (decline, timeout, HTTP error,
 *     transcode-only) re-enters app.onOpen with the one-shot decline
 *     latch, so the shell fork lands on the M2 SPA deep-link — and the
 *     latch clears, so the NEXT press tries native again
 *   - back during playback: keys route to the session (home nav never
 *     moves), Stopped beacon fires, the home canvas + body background
 *     are restored, the card's posTicks is locally patched, and a
 *     second native playback works (G4 no-pipeline-leak shape)
 *   - destroy()/handoff() with a live session stop+close FIRST
 *     (v2.0.24 configEpoch teardown rule, design §4)
 *   - __shellLite.player carries the {st, ms, url} diag surface
 */
"use strict";
const assert = require("node:assert");
const { loadLite, fakeStorage } = require("./lite-testkit.cjs");

function fakeAvplay() {
  const calls = [];
  const self = {
    calls,
    listener: null,
    prepareOk: null,
    prepareErr: null,
    seekOk: null,
    seekErr: null,
    time: 0,
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
      getDuration: () => 600000,
      suspend: () => calls.push(["suspend"]),
      restore: () => calls.push(["restore"]),
    },
  };
  return self;
}

function fakeCtx() {
  const noop = () => {};
  return {
    clearRect: noop,
    fillRect: noop,
    fillText: noop,
    beginPath: noop,
    moveTo: noop,
    lineTo: noop,
    closePath: noop,
    fill: noop,
    strokeRect: noop,
    drawImage: noop,
  };
}

function fakeDoc() {
  const listeners = {};
  const body = {
    children: [],
    style: {},
    appendChild(el) {
      this.children.push(el);
      el.parentNode = {
        removeChild: (x) => {
          const i = body.children.indexOf(x);
          if (i >= 0) body.children.splice(i, 1);
          x.parentNode = null;
        },
      };
    },
  };
  return {
    hidden: false,
    body,
    listeners,
    createElement: () => ({
      width: 0,
      height: 0,
      style: {},
      getContext: fakeCtx,
    }),
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      const a = listeners[type] || [];
      const i = a.indexOf(fn);
      if (i >= 0) a.splice(i, 1);
    },
    key(keyCode) {
      for (const fn of listeners.keydown || []) {
        fn({ keyCode, preventDefault: () => {} });
      }
    },
  };
}

function harness(opts) {
  opts = opts || {};
  const sentXhr = [];
  function FakeXhr() {
    const x = {
      headers: {},
      readyState: 0,
      status: 0,
      responseText: "",
      open(method, url) {
        x.method = method;
        x.url = url;
      },
      setRequestHeader(k, v) {
        x.headers[k] = v;
      },
      send(body) {
        x.body = body ? JSON.parse(body) : null;
        sentXhr.push(x);
      },
      respond(status, obj) {
        x.status = status;
        x.responseText = obj == null ? "" : JSON.stringify(obj);
        x.readyState = 4;
        if (x.onreadystatechange) x.onreadystatechange();
      },
    };
    return x;
  }

  const timers = new Map();
  let seq = 1;
  const av = opts.noAvplay ? null : fakeAvplay();
  const doc = fakeDoc();
  const win = {
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
    setTimeout: (fn, ms) => {
      timers.set(seq, { fn, ms, interval: false });
      return seq++;
    },
    clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, ms) => {
      timers.set(seq, { fn, ms, interval: true });
      return seq++;
    },
    clearInterval: (id) => timers.delete(id),
    webapis: av ? { avplay: av.api } : undefined,
    tizen: opts.tizen,
    __shellLite: { st: "live" },
  };

  const Lite = loadLite({ XMLHttpRequest: FakeXhr });
  const app = Lite.boot(win, doc);
  assert.ok(app, "boot returns an app");

  // the shell fork, byte-for-byte in behaviour (shell.js onOpen)
  const deepLinks = [];
  app.onOpen = (item) => {
    let took = false;
    try {
      took = app.openNative(item) === true;
    } catch {
      took = false;
    }
    if (took) return;
    deepLinks.push(item && item.id);
  };

  const pbXhr = () => sentXhr.filter((x) => x.url.indexOf("PlaybackInfo") >= 0);
  const beacons = (p) => sentXhr.filter((x) => x.url.indexOf(p) >= 0);
  return { Lite, app, av, doc, win, timers, sentXhr, deepLinks, pbXhr, beacons };
}

const movie = () => ({
  id: "m1",
  name: "Heat",
  type: "Movie",
  img: null,
  posTicks: 90000 * 10000, // resume at 90s
  runtimeTicks: 600000 * 10000,
});

// --- happy path: OK → PlaybackInfo → canvas hole → play → back → restore ----
{
  const h = harness();
  const item = movie();
  const homeCanvas = h.doc.body.children[0];
  assert.ok(homeCanvas, "home canvas mounted by boot");

  h.app.onOpen(item);
  assert.deepStrictEqual(h.deepLinks, [], "native took the press");
  assert.strictEqual(h.pbXhr().length, 1, "one PlaybackInfo POST");
  const pb = h.pbXhr()[0];
  assert.strictEqual(pb.method, "POST");
  assert.strictEqual(pb.url, "http://srv/Items/m1/PlaybackInfo?userId=u1");
  assert.strictEqual(pb.headers["X-Emby-Token"], "tok");
  assert.strictEqual(pb.headers["Content-Type"], "application/json");
  assert.ok(pb.body.DeviceProfile, "M63 profile in the body");
  assert.strictEqual(h.win.__shellLite.player.st, "info", "diag surface live");

  // double-OK while the answer is pending: swallowed, no second POST
  h.app.onOpen(item);
  assert.strictEqual(h.pbXhr().length, 1);
  assert.deepStrictEqual(h.deepLinks, []);

  pb.respond(200, {
    PlaySessionId: "ps1",
    MediaSources: [{ Id: "ms1", Container: "mov", SupportsDirectPlay: true }],
  });

  // canvas hole (G2)
  assert.strictEqual(homeCanvas.style.display, "none", "home canvas hidden");
  assert.strictEqual(h.doc.body.style.background, "transparent");
  assert.strictEqual(h.doc.body.children.length, 2, "OSD canvas appended");

  // §4 lifecycle with the spike-gotcha URL + resume seek from posTicks
  assert.deepStrictEqual(h.av.calls[0], [
    "open",
    "http://srv/Videos/m1/stream.mov?static=true&mediaSourceId=ms1&api_key=tok",
  ]);
  h.av.prepareOk();
  assert.deepStrictEqual(
    h.av.calls.filter((c) => c[0] === "seekTo"),
    [["seekTo", 90000]],
    "resume seek from the card's posTicks",
  );
  h.av.seekOk();
  assert.strictEqual(h.av.calls.filter((c) => c[0] === "play").length, 1);

  // first frame → Playing beacon with the session ids
  h.av.time = 90040;
  h.av.listener.oncurrentplaytime(90040);
  assert.strictEqual(h.beacons("/Sessions/Playing").length, 1);
  const start = h.beacons("/Sessions/Playing")[0];
  assert.strictEqual(start.body.PlaySessionId, "ps1");
  assert.strictEqual(start.body.MediaSourceId, "ms1");
  assert.strictEqual(start.body.PlayMethod, "DirectPlay");
  assert.strictEqual(h.win.__shellLite.player.st, "playing");
  assert.strictEqual(typeof h.win.__shellLite.player.ms, "number");

  // keys route to the session while it is live — home nav never moves
  const navRow = h.app.nav.row;
  h.doc.key(40); // down would move home focus
  assert.strictEqual(h.app.nav.row, navRow, "home nav untouched");
  h.doc.key(13); // OK = pause
  assert.strictEqual(h.win.__shellLite.player.st, "paused");
  const pauseBeacon = h.beacons("/Sessions/Playing/Progress").pop();
  assert.strictEqual(pauseBeacon.body.EventName, "pause");
  h.doc.key(13);

  // back: Stopped beacon, restore, local Resume patch
  h.av.time = 120000;
  h.doc.key(10009);
  assert.strictEqual(h.av.calls.filter((c) => c[0] === "stop").length, 1);
  assert.strictEqual(h.av.calls.filter((c) => c[0] === "close").length, 1);
  const stopped = h.beacons("/Sessions/Playing/Stopped");
  assert.strictEqual(stopped.length, 1);
  assert.strictEqual(stopped[0].body.PositionTicks, 120000 * 10000);
  assert.strictEqual(homeCanvas.style.display, "", "home canvas back");
  assert.strictEqual(h.doc.body.style.background, undefined);
  assert.strictEqual(h.doc.body.children.length, 1, "OSD canvas removed");
  assert.strictEqual(item.posTicks, 120000 * 10000, "local Resume patch");
  assert.strictEqual(h.timers.size, 0, "no timer leaks");

  // home nav works again
  h.doc.key(40);

  // …and a SECOND native playback starts clean (G4 shape)
  h.app.onOpen(item);
  assert.strictEqual(h.pbXhr().length, 2, "second press goes native again");
}

// --- container items and no-adapter boots decline synchronously --------------
{
  const h = harness();
  h.app.onOpen({ id: "s1", name: "Show", type: "Series" });
  assert.deepStrictEqual(h.deepLinks, ["s1"], "Series → SPA deep-link");
  assert.strictEqual(h.pbXhr().length, 0);
}
{
  const h = harness({ noAvplay: true });
  assert.strictEqual(h.app.nativeSupported, false);
  h.app.onOpen(movie());
  assert.deepStrictEqual(h.deepLinks, ["m1"]);
}

// --- transcode-only answer → SPA fallback, latch clears for the next press ---
{
  const h = harness();
  const item = movie();
  h.app.onOpen(item);
  h.pbXhr()[0].respond(200, {
    MediaSources: [
      { Id: "x", Container: "mkv", SupportsDirectPlay: false, TranscodingUrl: "/t" },
    ],
  });
  assert.deepStrictEqual(h.deepLinks, ["m1"], "fell through to the deep-link");
  assert.strictEqual(h.av.calls.length, 0, "adapter never touched");
  assert.strictEqual(h.win.__shellLite.player.st, "err");

  // next press is a fresh native attempt, not a stuck latch
  h.app.onOpen(item);
  assert.strictEqual(h.pbXhr().length, 2);
  assert.deepStrictEqual(h.deepLinks, ["m1"], "no extra deep-link");
}

// --- HTTP error → SPA fallback ------------------------------------------------
{
  const h = harness();
  h.app.onOpen(movie());
  h.pbXhr()[0].respond(500, null);
  assert.deepStrictEqual(h.deepLinks, ["m1"]);
}

// --- PlaybackInfo timeout (3s, design §3) → SPA fallback ----------------------
{
  const h = harness();
  h.app.onOpen(movie());
  const t = [...h.timers.values()].find((x) => !x.interval && x.ms === 3000);
  assert.ok(t, "3s fallback timer armed");
  t.fn();
  assert.deepStrictEqual(h.deepLinks, ["m1"]);
  // the late reply is dropped, not replayed into a ghost session
  h.pbXhr()[0].respond(200, {
    MediaSources: [{ Id: "ms1", Container: "mov", SupportsDirectPlay: true }],
  });
  assert.strictEqual(h.av.calls.length, 0);
}

// --- prepare failure after direct-play GO → SPA fallback ----------------------
{
  const h = harness();
  const item = movie();
  const homeCanvas = h.doc.body.children[0];
  h.app.onOpen(item);
  h.pbXhr()[0].respond(200, {
    MediaSources: [{ Id: "ms1", Container: "mov", SupportsDirectPlay: true }],
  });
  h.av.prepareErr("boom");
  assert.deepStrictEqual(h.deepLinks, ["m1"], "pre-first-frame → SPA");
  assert.strictEqual(h.av.calls.filter((c) => c[0] === "close").length, 1);
  assert.strictEqual(homeCanvas.style.display, "", "home restored first");
  assert.strictEqual(h.doc.body.children.length, 1, "OSD canvas removed");
  assert.strictEqual(
    h.beacons("/Sessions/").length,
    0,
    "no beacon for a playback that never started",
  );
}

// --- destroy()/handoff() with a live session stop+close FIRST (§4) ------------
{
  const h = harness();
  h.app.onOpen(movie());
  h.pbXhr()[0].respond(200, {
    MediaSources: [{ Id: "ms1", Container: "mov", SupportsDirectPlay: true }],
  });
  h.av.prepareOk();
  h.av.seekOk();
  h.av.time = 5000;
  h.av.listener.oncurrentplaytime(5000);
  h.app.destroy();
  assert.strictEqual(h.av.calls.filter((c) => c[0] === "stop").length, 1);
  assert.strictEqual(h.av.calls.filter((c) => c[0] === "close").length, 1);
  assert.strictEqual(h.beacons("/Sessions/Playing/Stopped").length, 1);
}

// --- visibilitychange parks/unparks a live pipeline (v2.0.24 interplay) -------
{
  const h = harness();
  h.app.onOpen(movie());
  h.pbXhr()[0].respond(200, {
    MediaSources: [{ Id: "ms1", Container: "mov", SupportsDirectPlay: true }],
  });
  h.av.prepareOk();
  h.av.seekOk();
  h.av.listener.oncurrentplaytime(1);
  h.doc.hidden = true;
  for (const fn of h.doc.listeners.visibilitychange) fn();
  assert.ok(h.av.calls.some((c) => c[0] === "suspend"));
  h.doc.hidden = false;
  for (const fn of h.doc.listeners.visibilitychange) fn();
  assert.ok(h.av.calls.some((c) => c[0] === "restore"));
}

// --- media transport keys are registered when the platform offers them --------
{
  const registered = [];
  harness({
    tizen: { tvinputdevice: { registerKey: (k) => registered.push(k) } },
  });
  assert.deepStrictEqual(registered, [
    "MediaPlayPause",
    "MediaPlay",
    "MediaPause",
    "MediaRewind",
    "MediaFastForward",
  ]);
}
{
  const registered = [];
  harness({
    noAvplay: true,
    tizen: { tvinputdevice: { registerKey: (k) => registered.push(k) } },
  });
  assert.deepStrictEqual(registered, [], "no adapter → no media keys");
}

console.log("native-flow.test.cjs OK");
