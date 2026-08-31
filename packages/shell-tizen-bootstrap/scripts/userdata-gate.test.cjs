/*
 * JELA-761: idle-home `UserDataChanged` gate — opt-in via
 * localStorage['jellyfin.shell.udcGate']='1', default OFF.
 *
 * THE DEFECT BEING FIXED (measured in JELA-759, virtual Tizen 5.0 rig, warm
 * primed profile, 240 s of true idle with zero CDP traffic outbound):
 *
 *   UserDataChanged frames landed at +12.9 / +103.1 / +193.2 s — a dead
 *   regular 90.1-90.2 s period with nothing playing and no input. Each one
 *   was followed, with nothing from the client in front of it, by:
 *     +0.0 s  /web/66884.<hash>.css      (the hometab chunk stylesheet)
 *     +0.4 s  5 x /Users/{u}/Items       (home rows; IsUnplayed alone 82,861 B)
 *     +10.0 s 6 x /HomeScreen/Section/*  (BecauseYouWatched x3, ContinueWatching
 *                                         NextUp, LatestShows, LatestMovies)
 *   ~13 requests + ~13 CORS preflights, ~230 KB, every 90 s, forever:
 *   80 requests / 761,157 B of the idle window, extrapolating to ~2,430
 *   requests and ~23.7 MB per idle TV per hour. The screen changed by two
 *   cards across the whole window (282 -> 280).
 *
 * The client rebuilds the whole home for user-data changes that touch
 * nothing it is showing. This shim reads Data.UserDataList[].ItemId off the
 * frame and swallows it when no id is rendered in the document and none is
 * in the current route, coalesces the survivors, and holds them while the
 * page is hidden.
 *
 * WHAT THIS PINS
 *   PART A — CONTRACT (src + the minified sibling): opt-in flag, coalesce
 *            knob, diag object, ES5-only seed text.
 *   PART B — BEHAVIOUR (the shim IIFE lifted from the SHIPPED seed and run in
 *            a sandbox against a faithful re-enactment of the vendor socket
 *            handler + the JELA-759 frame shapes):
 *     B0.  no flag -> completely inert; the vendor handler sees every frame
 *          (proves the harness reproduces the defect it claims to fix).
 *     B1.  a UserDataChanged frame for ids that are NOT on screen is dropped.
 *     B2.  a UserDataChanged frame for an id that IS on screen is delivered.
 *     B3.  non-UserDataChanged frames (KeepAlive, Sessions, ...) pass
 *          untouched, and are not even parsed as JSON.
 *     B4.  malformed / unknown-shaped frames FAIL OPEN.
 *     B5.  the id match is dash- and case-insensitive (socket GUIDs are
 *          dashed, DOM data-id is not).
 *     B6.  an id present only in the route (location.hash) counts as shown.
 *     B7.  a burst of hitting frames inside the coalesce window costs ONE
 *          delivery; a frame carrying a NEW id inside the window still
 *          fires; after the window a repeat fires again.
 *     B8.  coalesceMs=0 disables coalescing but keeps the diff.
 *     B9.  hidden page -> the frame is HELD, then delivered exactly once on
 *          visibilitychange; a second hidden frame replaces the first.
 *     B10. a <video> in the document disables the gate entirely (playback
 *          progress pushes are for items that need not be in the DOM).
 *     B11. a querySelectorAll that throws fails open.
 *     B12. the addEventListener transport is gated the same way, and
 *          removeEventListener still removes the caller's own function.
 *     B13. one frame delivered to BOTH transports is classified ONCE — both
 *          handlers see it, or neither does.
 *     B14. the onmessage accessor round-trips (get returns what was set) and
 *          a non-function assignment is passed straight through.
 *     B15. the diag counters add up over a replay of the JELA-759 window.
 *   PART C — the idle-window ARITHMETIC: replaying the three measured pushes
 *            against a 280-card home whose ids the pushes do not touch
 *            yields zero rebuilds.
 *
 * Run: node scripts/userdata-gate.test.cjs
 *   or: pnpm --filter @jellyfin-tv/shell-tizen-bootstrap test
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = path.join(__dirname, "..", "src", "boot-shell.src.js");

const MIN = SRC.endsWith("boot-shell.src.js")
  ? SRC.replace(/boot-shell\.src\.js$/, "boot-shell.min.js")
  : SRC.replace(/shell\.js$/, "shell.min.js");

const FLAG = "jellyfin.shell.udcGate";
const KNOB = "jellyfin.shell.udcCoalesceMs";
// JELA-827: gate flipped to opt-OUT — an absent key means ON.
const KILL_LINE = 'localStorage.getItem("' + FLAG + '")==="0"';
const OLD_OPTIN_LINE = 'localStorage.getItem("' + FLAG + '")!=="1"';

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log("OK: " + name);
  } else {
    console.error("FAIL: " + name + (detail ? "  — " + detail : ""));
    failures++;
  }
}

const src = fs.readFileSync(SRC, "utf8");
const min = fs.readFileSync(MIN, "utf8");
const srcLabel = path.basename(SRC);
const minLabel = path.basename(MIN);

// ---------------------------------------------------------------------------
// Lift the shim out of the REAL seed text (not the raw file), the way
// defer-bitrate-test.test.cjs does, so what runs here is what ships.
// ---------------------------------------------------------------------------
function extractTopFn(text, name) {
  const lines = text.split("\n");
  let s = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("  function " + name + "(")) {
      s = i;
      break;
    }
  }
  if (s === -1) throw new Error("function not found: " + name);
  for (let i = s + 1; i < lines.length; i++) {
    if (lines[i] === "  }") return lines.slice(s, i + 1).join("\n");
  }
  throw new Error("no closing brace for: " + name);
}

function buildSeed() {
  const fnSrc = extractTopFn(src, "buildSeedScript").replace(
    /^  function buildSeedScript/,
    "function",
  );
  const sb = { Object, JSON, TX_VER: "testver" };
  vm.createContext(sb);
  const buildSeedScript = vm.runInContext("(" + fnSrc + ")", sb);
  return buildSeedScript("https://tv.example.test", {});
}

const seed = buildSeed();

function extractShim() {
  // JELA-827: pin the read EXPRESSION in src AND min, and pin that the old
  // fail-closed opt-in form is gone.
  const kill = seed.indexOf(KILL_LINE);
  check(srcLabel + ": built seed contains the opt-OUT gate line", kill !== -1);
  check(
    srcLabel + ": built seed no longer contains the opt-in gate line",
    seed.indexOf(OLD_OPTIN_LINE) === -1,
  );
  for (const [label, text] of [
    [srcLabel, src],
    [minLabel, min],
  ]) {
    check(
      label + ': JELA-827: carries the opt-OUT gate ("==="0"")',
      text.includes(KILL_LINE),
    );
    check(
      label + ': JELA-827: old opt-in gate ("!=="1"") is gone',
      !text.includes(OLD_OPTIN_LINE),
    );
  }
  if (kill === -1) return null;
  const start = seed.lastIndexOf("try{(function(){", kill);
  const endMark = "\n  })();}catch(_){}";
  const end = seed.indexOf(endMark, kill);
  check(
    srcLabel + ": shim IIFE boundaries resolve",
    start !== -1 && end !== -1 && start < kill && kill < end,
  );
  if (start === -1 || end === -1) return null;
  return seed.slice(start, end + endMark.length);
}

const shim = extractShim();

// ===========================================================================
// PART A — CONTRACT
// ===========================================================================
for (const [label, text] of [
  [srcLabel, src],
  [minLabel, min],
]) {
  check(label + ": opt-in flag survives", text.includes(FLAG));
  check(label + ": coalesce knob survives", text.includes(KNOB));
  check(label + ": diag object present", text.includes("__shellUdc"));
  check(
    label + ": targets the vendor message type",
    text.includes("UserDataChanged"),
  );
  check(
    label + ": reads the payload id list",
    text.includes("UserDataList") && text.includes("ItemId"),
  );
  check(
    label + ": wraps the WebSocket onmessage accessor",
    text.includes('Object.getOwnPropertyDescriptor(P,"onmessage")'),
  );
}
if (shim) {
  check("shim is ES5 (no arrow functions)", shim.indexOf("=>") === -1);
  check("shim is ES5 (no template literals)", shim.indexOf("`") === -1);
  check("shim has no </script literal", shim.indexOf("</script") === -1);
  check(
    "shim is ES5 (var only)",
    shim.indexOf("const ") === -1 && shim.indexOf("let ") === -1,
  );
}

// ===========================================================================
// PART B — BEHAVIOUR
// ===========================================================================

// --- a WebSocket good enough to be wrapped ---------------------------------
// Native-ish: onmessage lives as an accessor on the PROTOTYPE (that is what
// the shim hooks), listeners live per instance.
function makeWebSocketClass() {
  class FakeEventTarget {
    constructor() {
      this.__ls = [];
    }
    addEventListener(type, fn) {
      this.__ls.push({ type, fn });
    }
    removeEventListener(type, fn) {
      for (let i = this.__ls.length - 1; i >= 0; i--) {
        if (this.__ls[i].type === type && this.__ls[i].fn === fn)
          this.__ls.splice(i, 1);
      }
    }
  }
  class FakeWebSocket extends FakeEventTarget {
    constructor(url) {
      super();
      this.url = url;
      this.__onmessage = null;
    }
    // Deliver a raw frame the way a browser would: property handler first,
    // then every registered "message" listener, with ONE event object.
    __recv(data) {
      const ev = { type: "message", data, target: this };
      if (this.__onmessage) this.__onmessage.call(this, ev);
      for (const l of this.__ls.slice()) {
        if (l.type === "message") l.fn.call(this, ev);
      }
      return ev;
    }
  }
  Object.defineProperty(FakeWebSocket.prototype, "onmessage", {
    configurable: true,
    enumerable: true,
    get() {
      return this.__onmessage;
    },
    set(v) {
      this.__onmessage = v;
    },
  });
  return FakeWebSocket;
}

// --- a DOM good enough for [data-id] + visibility ---------------------------
function makeDom(ids, opts) {
  opts = opts || {};
  const nodes = ids.map((id) => ({
    getAttribute(n) {
      return n === "data-id" ? id : null;
    },
  }));
  const listeners = [];
  const doc = {
    visibilityState: opts.hidden ? "hidden" : "visible",
    querySelectorAll(sel) {
      if (opts.throwOnQuery) throw new Error("boom");
      if (sel !== "[data-id]") return [];
      return nodes;
    },
    getElementsByTagName(t) {
      if (t === "video") return opts.video ? [{}] : [];
      return [];
    },
    addEventListener(type, fn) {
      listeners.push({ type, fn });
    },
    __fire(type) {
      for (const l of listeners.slice()) if (l.type === type) l.fn({ type });
    },
  };
  return doc;
}

// --- the sandbox ------------------------------------------------------------
function boot(opts) {
  opts = opts || {};
  const store = Object.assign({}, opts.ls || {});
  // JELA-827: the gate is opt-OUT — an ABSENT key is an ON arm. `on:false`
  // must therefore SEED "0"; `on:"absent"` leaves the key unset (also ON).
  if (opts.on === false) store[FLAG] = "0";
  else if (opts.on !== "absent") store[FLAG] = "1";
  if (opts.coalesceMs !== undefined) store[KNOB] = String(opts.coalesceMs);

  const WS = makeWebSocketClass();
  const doc = makeDom(opts.ids || [], opts);
  let clock = opts.t0 === undefined ? 1000 : opts.t0;

  const win = {
    // visibilitychange is bound WINDOW-level by the shim (it must survive the
    // document.open()/write() handoff — the lifecycle-resume guard pins that),
    // and the event bubbles document -> window, so both surfaces share one
    // registry here.
    addEventListener: doc.addEventListener,
    WebSocket: WS,
    localStorage: {
      getItem(k) {
        return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null;
      },
      setItem(k, v) {
        store[k] = String(v);
      },
    },
    document: doc,
    location: { hash: opts.hash || "", search: opts.search || "" },
    console,
  };
  win.window = win;

  const sb = {
    window: win,
    document: doc,
    localStorage: win.localStorage,
    location: win.location,
    console,
    JSON,
    Object,
    parseInt,
    // Virtual clock: the shim only reads (new Date).getTime().
    Date: class extends Date {
      getTime() {
        return clock;
      }
    },
  };
  vm.createContext(sb);
  if (shim) vm.runInContext(shim, sb);

  return {
    win,
    doc,
    WS,
    diag: () => win.__shellUdc,
    tick: (ms) => {
      clock += ms;
    },
    open() {
      const ws = new WS("wss://tv.example.test/socket");
      const seen = [];
      ws.onmessage = (ev) => seen.push(ev.data);
      return { ws, seen };
    },
  };
}

// --- frame factories --------------------------------------------------------
function udc(ids) {
  return JSON.stringify({
    MessageType: "UserDataChanged",
    Data: {
      UserId: "9c8ae5f0b2ab4a9a9d8ff2f2a1c4d0e1",
      UserDataList: (Array.isArray(ids) ? ids : [ids]).map((id) => ({
        ItemId: id,
        Played: false,
        PlaybackPositionTicks: 0,
      })),
    },
  });
}
const KEEPALIVE = JSON.stringify({ MessageType: "KeepAlive" });

const ON_SCREEN = "aaaaaaaabbbbccccddddeeeeeeeeeeee";
const OFF_SCREEN = "ffffffff1111222233334444ffffffff";
const OTHER_OFF = "0123456789abcdef0123456789abcdef";

// --- B0: JELA-827 kill switch — flag "0" -> inert. This is the arm that proves
//     the gate is still live and was not merely deleted, AND it is the control
//     that reproduces the original defect. Rollback for this flag is
//     setItem(FLAG,"0"), NEVER removeItem.
{
  const s = boot({ on: false, ids: [ON_SCREEN] });
  const { ws, seen } = s.open();
  ws.__recv(udc([OFF_SCREEN]));
  ws.__recv(udc([OFF_SCREEN]));
  check('B0: flag "0" -> no diag object', s.diag() === undefined);
  check(
    'B0: flag "0" -> the vendor handler sees the rebuild trigger (defect reproduced)',
    seen.length === 2,
    "delivered " + seen.length,
  );
}

// --- B0b: JELA-827 — key ABSENT must behave EXACTLY like the seeded "1" arm.
//     The "1" is written by the jp807seed JSI channel entry, which runs only
//     after the lite->SPA handoff (JELA-802), so every cold boot reads null
//     here. Under the old `!== "1"` gate those boots swallowed nothing.
{
  const s = boot({ on: "absent", ids: [ON_SCREEN] });
  const { ws, seen } = s.open();
  ws.__recv(udc([OFF_SCREEN]));
  check("B0b: key absent -> diag object published (opt-OUT)", !!s.diag());
  check("B0b: key absent -> off-screen id dropped", seen.length === 0);
  check(
    "B0b: key absent -> counted as dropNoHit",
    s.diag() && s.diag().dropNoHit === 1,
  );
  ws.__recv(udc([ON_SCREEN]));
  check("B0b: key absent -> on-screen id still delivered", seen.length === 1);
}

// --- B1/B2: the diff --------------------------------------------------------
{
  const s = boot({ ids: [ON_SCREEN] });
  const { ws, seen } = s.open();
  ws.__recv(udc([OFF_SCREEN]));
  check("B1: off-screen id is dropped", seen.length === 0);
  check("B1: counted as dropNoHit", s.diag().dropNoHit === 1);
  ws.__recv(udc([ON_SCREEN]));
  check("B2: on-screen id is delivered", seen.length === 1);
  check("B2: counted as pass", s.diag().pass === 1);
  check("B2: card census recorded", s.diag().ids === 1);
}

// --- B3: other message types ------------------------------------------------
{
  const s = boot({ ids: [ON_SCREEN] });
  const { ws, seen } = s.open();
  ws.__recv(KEEPALIVE);
  ws.__recv(JSON.stringify({ MessageType: "Sessions", Data: [] }));
  ws.__recv("");
  check("B3: non-UserDataChanged frames pass untouched", seen.length === 3);
  check("B3: not counted as seen", s.diag().seen === 0);
}

// --- B4: fail open on odd shapes -------------------------------------------
{
  const s = boot({ ids: [ON_SCREEN] });
  const { ws, seen } = s.open();
  ws.__recv('{"MessageType":"UserDataChanged"'); // truncated JSON
  ws.__recv(JSON.stringify({ MessageType: "UserDataChanged", Data: {} }));
  ws.__recv(
    JSON.stringify({ MessageType: "UserDataChanged", Data: { UserDataList: [] } }),
  );
  ws.__recv(
    JSON.stringify({
      MessageType: "UserDataChanged",
      Data: { UserDataList: [{ Played: true }] },
    }),
  );
  ws.__recv({ not: "a string" });
  check("B4: malformed UserDataChanged frames fail open", seen.length === 5);
}

// --- B5: GUID formatting ----------------------------------------------------
{
  const dashed = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
  const s = boot({ ids: [ON_SCREEN] }); // DOM carries the dashless lowercase form
  const { ws, seen } = s.open();
  ws.__recv(udc([dashed]));
  check("B5: dashed/upper socket id matches dashless/lower DOM id", seen.length === 1);
}

// --- B6: the current route counts as shown ---------------------------------
{
  const s = boot({ ids: [], hash: "#/details?id=" + OFF_SCREEN });
  const { ws, seen } = s.open();
  ws.__recv(udc([OFF_SCREEN]));
  check("B6: id in location.hash counts as shown", seen.length === 1);
}
{
  const s = boot({ ids: [], hash: "#/home.html" });
  const { ws, seen } = s.open();
  ws.__recv(udc([OFF_SCREEN]));
  check("B6: unrelated route does not rescue an off-screen id", seen.length === 0);
}

// --- B7: coalescing ---------------------------------------------------------
{
  const s = boot({ ids: [ON_SCREEN, OTHER_OFF], coalesceMs: 3000 });
  const { ws, seen } = s.open();
  ws.__recv(udc([ON_SCREEN]));
  check("B7: first hitting frame delivers", seen.length === 1);
  s.tick(500);
  ws.__recv(udc([ON_SCREEN]));
  s.tick(500);
  ws.__recv(udc([ON_SCREEN]));
  check(
    "B7: repeats inside the window are coalesced away",
    seen.length === 1 && s.diag().dropDup === 2,
    "delivered " + seen.length + " dropDup " + s.diag().dropDup,
  );
  s.tick(100);
  ws.__recv(udc([OTHER_OFF]));
  check("B7: a NEW id inside the window still fires", seen.length === 2);
  s.tick(5000);
  ws.__recv(udc([ON_SCREEN]));
  check("B7: after the window a repeat fires again", seen.length === 3);
}

// --- B8: coalescing off, diff on -------------------------------------------
{
  const s = boot({ ids: [ON_SCREEN], coalesceMs: 0 });
  const { ws, seen } = s.open();
  ws.__recv(udc([ON_SCREEN]));
  ws.__recv(udc([ON_SCREEN]));
  check("B8: coalesceMs=0 delivers every hitting frame", seen.length === 2);
  ws.__recv(udc([OFF_SCREEN]));
  check("B8: coalesceMs=0 still drops off-screen frames", seen.length === 2);
}

// --- B9: hidden page --------------------------------------------------------
{
  const s = boot({ ids: [ON_SCREEN], hidden: true, coalesceMs: 0 });
  const { ws, seen } = s.open();
  ws.__recv(udc([ON_SCREEN]));
  check("B9: hidden -> held, not delivered", seen.length === 0 && s.diag().held === 1);
  ws.__recv(udc([ON_SCREEN]));
  check("B9: a second hidden frame replaces the held one", seen.length === 0);
  s.doc.visibilityState = "visible";
  s.doc.__fire("visibilitychange");
  check("B9: delivered exactly once on visibilitychange", seen.length === 1);
  s.doc.__fire("visibilitychange");
  check("B9: nothing left pending", seen.length === 1);
}

// --- B10: playback disables the gate ---------------------------------------
{
  const s = boot({ ids: [ON_SCREEN], video: true });
  const { ws, seen } = s.open();
  ws.__recv(udc([OFF_SCREEN]));
  check("B10: a <video> in the document fails open", seen.length === 1);
}

// --- B11: a throwing DOM fails open ----------------------------------------
{
  const s = boot({ ids: [ON_SCREEN], throwOnQuery: true });
  const { ws, seen } = s.open();
  ws.__recv(udc([OFF_SCREEN]));
  check("B11: querySelectorAll throwing fails open", seen.length === 1);
}

// --- B12: the addEventListener transport ------------------------------------
{
  const s = boot({ ids: [ON_SCREEN] });
  const ws = new s.WS("wss://tv.example.test/socket");
  const seen = [];
  const fn = (ev) => seen.push(ev.data);
  ws.addEventListener("message", fn);
  ws.__recv(udc([OFF_SCREEN]));
  check("B12: addEventListener transport is gated too", seen.length === 0);
  ws.__recv(udc([ON_SCREEN]));
  check("B12: and still delivers a hit", seen.length === 1);
  ws.removeEventListener("message", fn);
  ws.__recv(udc([ON_SCREEN]));
  check(
    "B12: removeEventListener removes the caller's own function",
    seen.length === 1,
  );
  const other = [];
  ws.addEventListener("open", () => other.push(1));
  check("B12: non-message listeners are untouched", other.length === 0);
}

// --- B13: one frame, both transports, one verdict ---------------------------
{
  const s = boot({ ids: [ON_SCREEN], coalesceMs: 3000 });
  const ws = new s.WS("wss://tv.example.test/socket");
  const a = [];
  const b = [];
  ws.onmessage = (ev) => a.push(ev.data);
  ws.addEventListener("message", (ev) => b.push(ev.data));
  ws.__recv(udc([ON_SCREEN]));
  check(
    "B13: both handlers see the same hitting frame",
    a.length === 1 && b.length === 1,
    "a=" + a.length + " b=" + b.length,
  );
  check("B13: classified once", s.diag().seen === 1 && s.diag().pass === 1);
  ws.__recv(udc([OFF_SCREEN]));
  check(
    "B13: both handlers lose the same dropped frame",
    a.length === 1 && b.length === 1,
  );
}

// --- B14: accessor hygiene --------------------------------------------------
{
  const s = boot({ ids: [ON_SCREEN] });
  const ws = new s.WS("wss://tv.example.test/socket");
  check("B14: onmessage starts null", ws.onmessage === null);
  const fn = () => {};
  ws.onmessage = fn;
  check("B14: get returns exactly what was set", ws.onmessage === fn);
  ws.onmessage = null;
  check("B14: a non-function assignment passes through", ws.onmessage === null);
  let threw = false;
  try {
    ws.__recv(udc([ON_SCREEN]));
  } catch (_) {
    threw = true;
  }
  check("B14: a frame with no handler does not throw", threw === false);
}

// --- B15/PART C: replay of the measured idle window -------------------------
// A 280-card home (JELA-759 counted 282 -> 280 across the window) and the
// three pushes it measured, none of which touches a rendered id.
{
  const home = [];
  for (let i = 0; i < 280; i++) {
    home.push(("00000000000000000000000000000" + i).slice(-32));
  }
  const s = boot({ ids: home, coalesceMs: 3000, t0: 0 });
  const { ws, seen } = s.open();
  const PUSH_AT = [12900, 103100, 193200];
  let t = 0;
  for (const at of PUSH_AT) {
    s.tick(at - t);
    t = at;
    ws.__recv(udc([OFF_SCREEN, OTHER_OFF]));
  }
  check(
    "C: the three measured idle pushes trigger ZERO home rebuilds",
    seen.length === 0,
    "delivered " + seen.length,
  );
  const d = s.diag();
  check(
    "B15: counters add up (seen 3, dropNoHit 3, pass 0, err 0)",
    d.seen === 3 && d.dropNoHit === 3 && d.pass === 0 && d.err === 0,
    JSON.stringify(d),
  );
  check("B15: the census saw the whole home", d.ids === 280);
  // ...and a push that DOES touch a rendered card still rebuilds.
  s.tick(90000);
  ws.__recv(udc([home[7]]));
  check("C: a push that touches a rendered card still delivers", seen.length === 1);
}

console.log(
  failures === 0
    ? "\nuserdata-gate: all checks passed"
    : "\nuserdata-gate: " + failures + " check(s) FAILED",
);
process.exit(failures === 0 ? 0 : 1);
