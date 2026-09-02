/*
 * JELA-742: alias coalescing for the two pairs the home fetches twice —
 * opt-in via localStorage['jellyfin.shell.aliasCoalesce']='1', default OFF.
 *
 * Extracts the SHIPPED instantHomeBody() and drives it through a DOM stub +
 * controllable XHR/fetch, pinning:
 *   - default OFF: no flag -> no __shellACo state, both aliases hit the net
 *   - kill-switch: aliasCoalesceDisabled=1 beats aliasCoalesce=1
 *   - prereq gates: missing creds or no http(s) base -> inert
 *   - AC1: /Items/{id} + /Users/{u}/Items/{id} collapse to ONE request, in
 *     either order, over fetch and over XHR; the second caller gets the
 *     first caller's body verbatim
 *   - AC2: /UserViews?userId={u} + /Users/{u}/Views collapse the same way
 *   - in-flight parking: a sibling asking while the first is still pending
 *     rides the same request; if that request fails it replays on the network
 *   - one-shot + TTL: a consumed slot is gone (third call goes to the
 *     network) and an entry older than the TTL is not served
 *   - auth-edge: a token change flushes the store, stale-user data is never
 *     served
 *   - SAFETY (the reason the key carries the residual query): callers whose
 *     other params differ never coalesce, a path user id that is not the
 *     logged-in user never coalesces, and trailing-segment/POST/foreign URLs
 *     are untouched
 *   - oversize bodies are not stored
 *   - XHR delivery: readyState/status/responseText/response shadowed, events
 *     fired; abort() before delivery suppresses it
 *
 * JELA-760 widens the SAME store into the series drill-down behind its own flag
 * localStorage['jellyfin.shell.itemCache']='1' (kill-switch
 * 'jellyfin.shell.itemCacheDisabled'), so sections F/G/H pin:
 *   - flag independence in both directions: itemCache alone arms the drill
 *     shapes without the views pair, aliasCoalesce alone arms neither
 *   - AC1: 14 reads of one item body (the count JELA-759 measured) collapse to
 *     ONE request — a one-shot slot covers one of them, a multi-read slot all
 *   - AC2: /Shows/{id}/Episodes, /Shows/NextUp and /Items/{id}/ThemeMedia are
 *     covered, the last over XHR, the transport a fetch-level join cannot reach
 *   - AC3: the four per-route pollers collapse on their own longer TTL
 *   - TTLs are real: an item slot expires at 30 s, config outlives it at 60 s
 *   - CLASSED invalidation: the third-party plugin write that lands inside
 *     every dwell (JELA-757) retires config only and must NOT empty the item
 *     slots; a play-state write and any unrecognised write do retire them; a
 *     write that cannot touch an item body retires nothing; both transports
 *   - with the drill flag off, JELA-742's behaviour is unchanged
 *
 * JELA-842 widens the same store once more, behind
 * localStorage['jellyfin.shell.cfgOnce'] (kill-switch
 * 'jellyfin.shell.cfgOnceDisabled', read FIRST), for the eight singleton CONFIG
 * endpoints JELA-840 measured 2-4x per cold boot. JELA-852 flipped that key
 * from opt-IN to opt-OUT: an ABSENT key arms it, only "0" stands it down, and
 * the kill switch still wins. Every section outside I therefore sets
 * cfgOnce='0' explicitly so it keeps testing one mechanism at a time.
 * Section I pins:
 *   - gating, and that cfgOnce arms the shim with neither sibling flag set
 *   - JELA-852 AC2/AC3: an unseeded store arms on boot 1 (I1b) and the same
 *     store plus cfgOnceDisabled=1 puts the duplicate GET back (I1c)
 *   - AC1: /CustomTabs/Config x5 = ONE request — four of them CONCURRENT, so
 *     only the in-flight park can collapse them — and all eight shapes over
 *     mixed fetch/XHR
 *   - the JELA-839 auth-style split: ?api_key=<token> and header-auth readers
 *     share one request, but a FOREIGN api_key never reads the store
 *   - safety: another user's preferences, /Plugins, /System/Configuration and
 *     /PluginPages/User all reach the network untouched
 *   - invalidation: ANY write retires EVERY S: slot, including the
 *     /DisplayPreferences write the JELA-760 flush exempts; both transports
 *   - and the one exemption the first A/B ring forced: a /Sessions,
 *     /QuickConnect or /shell/ write retires nothing (I6b)
 *   - the 120 s S: TTL, a token change, and a failed leader replaying
 *   - flag independence BOTH ways: cfgOnce must not arm the JELA-742 alias
 *     pair and aliasCoalesce must not arm the config shapes (I8)
 */
"use strict";
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const SRC = path.join(__dirname, "..", "src", "shell.js");
const text = fs.readFileSync(SRC, "utf8");

function extractFn(name) {
  const marker = "function " + name + "(";
  const start = text.indexOf(marker);
  assert(start !== -1, "could not find " + marker + " in " + SRC);
  let i = text.indexOf("{", start);
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    const c = text[j];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, j + 1);
    }
  }
  throw new Error("unbalanced braces extracting " + name);
}

const bodyFnSrc = extractFn("instantHomeBody");
const body = new Function(bodyFnSrc + "; return instantHomeBody();")();

// ---- static contract checks ------------------------------------------------
assert(
  body.indexOf("jellyfin.shell.aliasCoalesce") !== -1,
  "opt-in flag present",
);
assert(
  body.indexOf("jellyfin.shell.aliasCoalesceDisabled") !== -1,
  "reserved kill-switch honored",
);
assert(body.indexOf("__shellACo") !== -1, "counter surface present");
assert(body.indexOf("jellyfin.shell.cfgOnce") !== -1, "JELA-842 flag present");
// JELA-852 AC1. The whole read site is pinned as one literal because the two
// halves only mean something together: `flgO` is what makes the enable key
// opt-OUT (absent => armed on the FIRST boot), and putting the `!flg(...
// Disabled)` conjunct FIRST is what keeps that default revocable from boot 1
// on a fleet that has never seen either key. A refactor that reorders them, or
// that quietly reverts flgO to flg, fails here rather than in a census.
assert(
  body.indexOf(
    'var cCO=!flg("jellyfin.shell.cfgOnceDisabled")&&flgO("jellyfin.shell.cfgOnce");',
  ) !== -1,
  "JELA-852: cfgOnce is opt-OUT (flgO) and cfgOnceDisabled is read FIRST",
);
assert(
  body.indexOf("jellyfin.shell.cfgOnceDisabled") <
    body.indexOf('flgO("jellyfin.shell.cfgOnce")'),
  "JELA-842 kill-switch is read BEFORE the enable key",
);
assert(
  body.indexOf('flg("jellyfin.shell.cfgOnce")') === -1,
  "JELA-852: no opt-IN read of cfgOnce survives",
);
assert(body.indexOf("</script") === -1, "no </script literal");
assert(body.indexOf("=>") === -1, "body must be ES5 (no arrow functions)");
assert(body.indexOf("`") === -1, "body must be ES5 (no template literals)");
assert(body.indexOf("eval(") === -1, "coalesced responses are never evaluated");
console.log("OK: static contract (flag, kill-switch, ES5, no eval)");

// ---- fixtures --------------------------------------------------------------
const UID = "c36be5ddc9ad4742b3635e71af9fd147"; // 32 hex
const OTHER = "0123456789abcdef0123456789abcdef";
const ID1 = "33608dc7475b9f4d042c1e8fbf5a9bc2";
const ID2 = "3484cf779c998d9f98055b8c3e73bca6";
const SRV = "http://srv";
const CREDS = JSON.stringify({
  Servers: [
    { Id: "s1", AccessToken: "tok", UserId: UID, ManualAddress: "http://alt" },
  ],
});
const ITEM1 = JSON.stringify({
  Id: ID1,
  Name: "Slide One",
  UserData: { P: 1 },
});
const VIEWS = JSON.stringify({ Items: [{ Name: "Movies" }] });

function makeEnv(opts) {
  opts = opts || {};
  let now = 1000;
  let nextTimerId = 1;
  const timers = new Map();
  const setTimeoutStub = (cb, ms) => {
    const id = nextTimerId++;
    timers.set(id, { cb, next: now + (ms || 0) });
    return id;
  };
  const setIntervalStub = (cb, ms) => setTimeoutStub(cb, ms);
  const clearStub = (id) => timers.delete(id);
  function FakeDate() {
    this._t = now;
  }
  FakeDate.prototype.valueOf = function () {
    return this._t;
  };
  FakeDate.prototype.toISOString = function () {
    return "1970-01-01T00:00:00.000Z";
  };

  function makeNode(tag) {
    return {
      tagName: tag,
      id: "",
      parentNode: null,
      children: [],
      attrs: {},
      textContent: "",
      style: { cssText: "", opacity: "" },
      setAttribute(k, v) {
        this.attrs[k] = v;
      },
      getAttribute(k) {
        return k in this.attrs ? this.attrs[k] : null;
      },
      appendChild(n) {
        n.parentNode = this;
        this.children.push(n);
        return n;
      },
      removeChild(n) {
        const i = this.children.indexOf(n);
        if (i !== -1) this.children.splice(i, 1);
        n.parentNode = null;
        return n;
      },
      getBoundingClientRect() {
        return { width: 0, height: 0, top: 0, bottom: 0, left: 0 };
      },
    };
  }
  const documentElement = makeNode("HTML");
  const document = {
    documentElement,
    createElement: (t) => makeNode(String(t).toUpperCase()),
    getElementById() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
  const window = {
    innerWidth: 1920,
    innerHeight: 1080,
    pageYOffset: 0,
    __shellT0: 0,
    addEventListener() {},
  };
  window.__shellPhase = function () {};

  // ---- XHR stub: real enough to exercise addEventListener + dispatchEvent --
  const xcalls = [];
  function FakeXHR() {
    this.readyState = 0;
    this.status = 0;
    this.responseText = "";
    this.response = "";
    this.responseType = "";
    this.timeout = 0;
    this.headers = {};
    this.sent = false;
    this.aborted = false;
    this._ls = {};
  }
  FakeXHR.prototype.open = function (m, u) {
    this.method = String(m);
    this.url = String(u);
    this.readyState = 1;
  };
  FakeXHR.prototype.setRequestHeader = function (k, v) {
    this.headers[k] = v;
  };
  FakeXHR.prototype.send = function () {
    this.sent = true;
    xcalls.push(this);
  };
  FakeXHR.prototype.abort = function () {
    this.aborted = true;
  };
  FakeXHR.prototype.addEventListener = function (t, fn) {
    (this._ls[t] = this._ls[t] || []).push(fn);
  };
  FakeXHR.prototype.dispatchEvent = function (ev) {
    const t = ev && ev.type;
    for (const fn of this._ls[t] || []) fn.call(this, ev);
    const h = this["on" + t];
    if (typeof h === "function") h.call(this, ev);
    return true;
  };
  FakeXHR.prototype.__respond = function (status, txt) {
    if (this.aborted) return;
    this.readyState = 4;
    this.status = status;
    this.responseText = txt;
    this.response = txt;
    this.dispatchEvent({ type: "readystatechange" });
    this.dispatchEvent({ type: "load" });
    this.dispatchEvent({ type: "loadend" });
  };
  window.XMLHttpRequest = FakeXHR;

  // ---- fetch stub (the "network") ----
  const netCalls = [];
  window.fetch = function (u, o) {
    const url = String(u && u.url ? u.url : u);
    const rec = { url, opts: o || {}, resolve: null, reject: null };
    netCalls.push(rec);
    const p = new Promise((res, rej) => {
      rec.resolve = (status, txt) => {
        const mk = () => ({
          status,
          ok: status >= 200 && status < 300,
          __net: true,
          clone: mk,
          text: () => Promise.resolve(txt),
        });
        res(mk());
      };
      rec.reject = (e) => rej(e || new Error("net"));
    });
    rec.promise = p;
    return p;
  };

  const store = Object.assign(
    {
      jellyfin_credentials: opts.creds !== undefined ? opts.creds : CREDS,
      "jellyfin.shell.serverUrl": opts.srv !== undefined ? opts.srv : SRV,
      // This suite unit-tests the alias/item-cache mechanisms in isolation.
      // Without this, the JELA-752 in-flight coalescer's replay window (whose
      // expiry setTimeout never fires under this env's stubbed timers) serves
      // the TTL-refetch reads and the per-scenario request counts shift.
      "jellyfin.shell.fetchCoalesceDisabled": "1",
    },
    opts.flagOff ? {} : { "jellyfin.shell.aliasCoalesce": "1" },
    // JELA-852: cfgOnce is opt-OUT, so an ABSENT key now ARMS the block. Every
    // section outside I unit-tests one mechanism in isolation and asserts
    // request counts that a second armed mechanism would move (it also widens
    // cMAX from 8 to 24), so they stand cfgOnce down explicitly. Section I
    // passes cfgAbsent to exercise the shipped default — the ONLY place the
    // absent-key state is under test, which is what makes it the AC2 assert.
    opts.cfgAbsent ? {} : { "jellyfin.shell.cfgOnce": "0" },
    opts.store || {},
  );
  const localStorage = {
    getItem: (k) =>
      Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null,
    setItem(k, v) {
      store[k] = String(v);
    },
    removeItem(k) {
      delete store[k];
    },
  };

  async function drainMicro(n) {
    for (let i = 0; i < (n || 100); i++) await Promise.resolve();
  }

  return {
    window,
    store,
    xcalls,
    netCalls,
    drainMicro,
    tick(ms) {
      now += ms;
    },
    runTimers() {
      for (const [id, t] of [...timers]) {
        if (t.next <= now + 1e9) {
          timers.delete(id);
          t.cb();
        }
      }
    },
    net(frag) {
      return netCalls.filter((c) => c.url.indexOf(frag) !== -1);
    },
    run() {
      new Function(
        "window",
        "document",
        "localStorage",
        "setInterval",
        "clearInterval",
        "setTimeout",
        "clearTimeout",
        "Date",
        "location",
        "getComputedStyle",
        body,
      )(
        window,
        document,
        localStorage,
        setIntervalStub,
        clearStub,
        setTimeoutStub,
        clearStub,
        FakeDate,
        { hash: "" },
        () => ({ fontSize: "28px", borderTopLeftRadius: "6px" }),
      );
    },
  };
}

// Issue a GET through the patched fetch and return {promise, settle}.
function get(env, url, opts) {
  return env.window.fetch(SRV + url, opts);
}
async function bodyOf(p) {
  const r = await p;
  return await r.text();
}

// ---- A. gating -------------------------------------------------------------
async function A() {
  let e = makeEnv({ flagOff: true });
  e.run();
  assert(!e.window.__shellACo, "A1: default OFF leaves no state");
  const p1 = get(e, "/Items/" + ID1);
  e.net("/Items/" + ID1)[0].resolve(200, ITEM1);
  await bodyOf(p1);
  const p2 = get(e, "/Users/" + UID + "/Items/" + ID1);
  assert.strictEqual(
    e.netCalls.length,
    2,
    "A1: OFF -> both aliases reach the network",
  );
  e.netCalls[1].resolve(200, ITEM1);
  await bodyOf(p2);
  console.log("OK: A1: default OFF — no state, both aliases hit the network");

  e = makeEnv({ store: { "jellyfin.shell.aliasCoalesceDisabled": "1" } });
  e.run();
  assert(!e.window.__shellACo, "A2: kill-switch beats the opt-in flag");
  console.log("OK: A2: aliasCoalesceDisabled=1 beats aliasCoalesce=1");

  e = makeEnv({ creds: null });
  e.run();
  assert(!e.window.__shellACo, "A3: no credentials -> inert");
  e = makeEnv({ srv: "", creds: JSON.stringify({ Servers: [{ Id: "s" }] }) });
  e.run();
  assert(!e.window.__shellACo, "A4: no usable base -> inert");
  console.log("OK: A3/A4: missing credentials or base leaves the shim inert");
}

// ---- B. AC1 / AC2 over fetch ----------------------------------------------
async function B() {
  // B1 — the observed order: bare first, user-scoped ~700 ms later.
  let e = makeEnv();
  e.run();
  assert(e.window.__shellACo && e.window.__shellACo.on, "B1: armed");
  let p = get(e, "/Items/" + ID1);
  assert.strictEqual(e.netCalls.length, 1, "B1: first call goes to the net");
  e.netCalls[0].resolve(200, ITEM1);
  assert.strictEqual(await bodyOf(p), ITEM1, "B1: first caller unaffected");
  await e.drainMicro();

  let p2 = get(e, "/Users/" + UID + "/Items/" + ID1);
  assert.strictEqual(
    e.netCalls.length,
    1,
    "B1/AC1: the sibling issues NO second request",
  );
  assert.strictEqual(
    await bodyOf(p2),
    ITEM1,
    "B1: sibling gets the first body verbatim",
  );
  console.log("OK: B1/AC1: /Items/{id} then /Users/{u}/Items/{id} = 1 request");

  // B2 — reverse order.
  e = makeEnv();
  e.run();
  p = get(e, "/Users/" + UID + "/Items/" + ID2);
  e.netCalls[0].resolve(200, ITEM1);
  await bodyOf(p);
  await e.drainMicro();
  p2 = get(e, "/Items/" + ID2);
  assert.strictEqual(e.netCalls.length, 1, "B2: reverse order also collapses");
  assert.strictEqual(await bodyOf(p2), ITEM1, "B2: body served");
  console.log("OK: B2/AC1: the pair collapses in either order");

  // B3 — AC2, the views pair.
  e = makeEnv();
  e.run();
  p = get(e, "/UserViews?userId=" + UID);
  assert.strictEqual(e.netCalls.length, 1, "B3: first views call hits the net");
  e.netCalls[0].resolve(200, VIEWS);
  await bodyOf(p);
  await e.drainMicro();
  p2 = get(e, "/Users/" + UID + "/Views");
  assert.strictEqual(
    e.netCalls.length,
    1,
    "B3/AC2: /Users/{u}/Views is served from /UserViews",
  );
  assert.strictEqual(await bodyOf(p2), VIEWS, "B3: views body served");
  console.log("OK: B3/AC2: /UserViews and /Users/{u}/Views = 1 request");

  // B4 — in-flight parking: sibling asks before the first response lands.
  e = makeEnv();
  e.run();
  p = get(e, "/Items/" + ID1);
  p2 = get(e, "/Users/" + UID + "/Items/" + ID1);
  assert.strictEqual(e.netCalls.length, 1, "B4: sibling parks, issues nothing");
  e.netCalls[0].resolve(200, ITEM1);
  assert.strictEqual(await bodyOf(p), ITEM1, "B4: first caller served");
  assert.strictEqual(await bodyOf(p2), ITEM1, "B4: parked caller fed");
  console.log("OK: B4: an in-flight sibling rides the same request");

  // B5 — a failed first request replays the parked caller on the network.
  e = makeEnv();
  e.run();
  p = get(e, "/Items/" + ID1).catch(() => "err");
  p2 = get(e, "/Users/" + UID + "/Items/" + ID1);
  assert.strictEqual(e.netCalls.length, 1, "B5: parked");
  e.netCalls[0].reject();
  await e.drainMicro();
  assert.strictEqual(e.netCalls.length, 2, "B5: parked caller replays on net");
  e.netCalls[1].resolve(200, ITEM1);
  assert.strictEqual(await bodyOf(p2), ITEM1, "B5: replay serves the body");
  console.log("OK: B5: a failed first request replays the parked caller");
}

// ---- C. one-shot, TTL, auth ------------------------------------------------
async function C() {
  // C1 — one-shot: the third call for the same id goes to the network.
  let e = makeEnv();
  e.run();
  let p = get(e, "/Items/" + ID1);
  e.netCalls[0].resolve(200, ITEM1);
  await bodyOf(p);
  await e.drainMicro();
  await bodyOf(get(e, "/Users/" + UID + "/Items/" + ID1));
  assert.strictEqual(e.netCalls.length, 1, "C1: second served");
  const p3 = get(e, "/Users/" + UID + "/Items/" + ID1);
  assert.strictEqual(e.netCalls.length, 2, "C1: third call goes to the net");
  e.netCalls[1].resolve(200, ITEM1);
  await bodyOf(p3);
  console.log("OK: C1: entries are one-shot — a third call is a real request");

  // C2 — TTL: an entry older than the window is not served.
  e = makeEnv();
  e.run();
  p = get(e, "/Items/" + ID1);
  e.netCalls[0].resolve(200, ITEM1);
  await bodyOf(p);
  await e.drainMicro();
  e.tick(10001);
  const p2 = get(e, "/Users/" + UID + "/Items/" + ID1);
  assert.strictEqual(e.netCalls.length, 2, "C2: expired entry is not served");
  e.netCalls[1].resolve(200, ITEM1);
  await bodyOf(p2);
  console.log("OK: C2: an entry past the 10 s TTL is not served");

  // C3 — a token change flushes the store.
  e = makeEnv();
  e.run();
  p = get(e, "/Items/" + ID1);
  e.netCalls[0].resolve(200, ITEM1);
  await bodyOf(p);
  await e.drainMicro();
  e.store.jellyfin_credentials = JSON.stringify({
    Servers: [{ Id: "s1", AccessToken: "DIFFERENT", UserId: UID }],
  });
  const p4 = get(e, "/Users/" + UID + "/Items/" + ID1);
  assert.strictEqual(
    e.netCalls.length,
    2,
    "C3: another user's session is never served the stored body",
  );
  e.netCalls[1].resolve(200, ITEM1);
  await bodyOf(p4);
  console.log("OK: C3: a token change flushes the store");
}

// ---- D. safety: what must NOT coalesce ------------------------------------
async function D() {
  const cases = [
    {
      why: "D1: differing residual query params never coalesce",
      a: "/Items/" + ID1,
      b: "/Users/" + UID + "/Items/" + ID1 + "?Fields=Chapters",
    },
    {
      why: "D2: a path user id that is not the logged-in user is untouched",
      a: "/Items/" + ID1,
      b: "/Users/" + OTHER + "/Items/" + ID1,
    },
    {
      why: "D3: an explicit foreign userId= is untouched",
      a: "/Items/" + ID1,
      b: "/Items/" + ID1 + "?userId=" + OTHER,
    },
    {
      why: "D4: a trailing segment is a different resource",
      a: "/Items/" + ID1,
      b: "/Items/" + ID1 + "/Intros",
    },
    {
      why: "D5: a different item id is a different resource",
      a: "/Items/" + ID1,
      b: "/Users/" + UID + "/Items/" + ID2,
    },
    {
      why: "D6: views with differing params never coalesce",
      a: "/UserViews?userId=" + UID,
      b: "/Users/" + UID + "/Views?IncludeHidden=true",
    },
  ];
  for (const c of cases) {
    const e = makeEnv();
    e.run();
    const p = get(e, c.a);
    e.netCalls[0].resolve(200, ITEM1);
    await bodyOf(p);
    await e.drainMicro();
    const p2 = get(e, c.b);
    assert.strictEqual(e.netCalls.length, 2, c.why);
    e.netCalls[1].resolve(200, "{}");
    await bodyOf(p2);
    console.log("OK: " + c.why);
  }

  // D7 — a non-GET is never intercepted or recorded.
  let e = makeEnv();
  e.run();
  let p = get(e, "/Items/" + ID1, { method: "POST" });
  e.netCalls[0].resolve(200, ITEM1);
  await bodyOf(p);
  await e.drainMicro();
  const p2 = get(e, "/Users/" + UID + "/Items/" + ID1);
  assert.strictEqual(e.netCalls.length, 2, "D7: a POST never seeds the store");
  e.netCalls[1].resolve(200, ITEM1);
  await bodyOf(p2);
  console.log("OK: D7: POST is neither served nor recorded");

  // D8 — a foreign origin is untouched.
  e = makeEnv();
  e.run();
  p = e.window.fetch("http://elsewhere/Items/" + ID1);
  e.netCalls[0].resolve(200, ITEM1);
  await bodyOf(p);
  await e.drainMicro();
  const p3 = get(e, "/Users/" + UID + "/Items/" + ID1);
  assert.strictEqual(e.netCalls.length, 2, "D8: foreign origin never seeds");
  e.netCalls[1].resolve(200, ITEM1);
  await bodyOf(p3);
  console.log("OK: D8: a foreign origin is never coalesced with the server");

  // D9 — an error response is not stored.
  e = makeEnv();
  e.run();
  p = get(e, "/Items/" + ID1);
  e.netCalls[0].resolve(500, "boom");
  await bodyOf(p);
  await e.drainMicro();
  const p4 = get(e, "/Users/" + UID + "/Items/" + ID1);
  assert.strictEqual(e.netCalls.length, 2, "D9: a 500 is never served onward");
  e.netCalls[1].resolve(200, ITEM1);
  await bodyOf(p4);
  console.log("OK: D9: a non-2xx response is not stored");

  // D10 — an oversize body is not stored.
  e = makeEnv();
  e.run();
  p = get(e, "/Items/" + ID1);
  e.netCalls[0].resolve(200, "x".repeat(262145));
  await bodyOf(p);
  await e.drainMicro();
  const p5 = get(e, "/Users/" + UID + "/Items/" + ID1);
  assert.strictEqual(e.netCalls.length, 2, "D10: >256 KiB is not stored");
  e.netCalls[1].resolve(200, ITEM1);
  await bodyOf(p5);
  console.log("OK: D10: a body over the 256 KiB cap is not stored");
}

// ---- E. the XHR path -------------------------------------------------------
async function E() {
  // E1 — record over XHR, serve over XHR.
  let e = makeEnv();
  e.run();
  const x1 = new e.window.XMLHttpRequest();
  x1.open("GET", SRV + "/Items/" + ID1, true);
  x1.send();
  assert.strictEqual(e.xcalls.length, 1, "E1: first XHR reaches the network");
  x1.__respond(200, ITEM1);
  await e.drainMicro();

  const x2 = new e.window.XMLHttpRequest();
  x2.open("GET", SRV + "/Users/" + UID + "/Items/" + ID1, true);
  let done = null;
  x2.onload = function () {
    done = x2.responseText;
  };
  x2.send();
  assert.strictEqual(e.xcalls.length, 1, "E1/AC1: sibling XHR issues nothing");
  e.runTimers();
  assert.strictEqual(x2.readyState, 4, "E1: readyState shadowed");
  assert.strictEqual(x2.status, 200, "E1: status shadowed");
  assert.strictEqual(done, ITEM1, "E1: onload sees the coalesced body");
  assert.strictEqual(
    x2.getResponseHeader("Content-Type"),
    "application/json",
    "E1: content-type answered",
  );
  console.log("OK: E1/AC1: the pair collapses over XHR too");

  // E2 — abort() before delivery suppresses it.
  e = makeEnv();
  e.run();
  const y1 = new e.window.XMLHttpRequest();
  y1.open("GET", SRV + "/Items/" + ID1, true);
  y1.send();
  y1.__respond(200, ITEM1);
  await e.drainMicro();
  const y2 = new e.window.XMLHttpRequest();
  y2.open("GET", SRV + "/Users/" + UID + "/Items/" + ID1, true);
  let fired = 0;
  y2.onload = function () {
    fired++;
  };
  y2.send();
  y2.abort();
  e.runTimers();
  assert.strictEqual(fired, 0, "E2: an aborted XHR is never delivered");
  console.log("OK: E2: abort() before delivery suppresses the serve");

  // E3 — cross-transport: recorded over XHR, served over fetch.
  e = makeEnv();
  e.run();
  const z = new e.window.XMLHttpRequest();
  z.open("GET", SRV + "/UserViews?userId=" + UID, true);
  z.send();
  z.__respond(200, VIEWS);
  await e.drainMicro();
  const pf = get(e, "/Users/" + UID + "/Views");
  assert.strictEqual(
    e.netCalls.length,
    0,
    "E3/AC2: a fetch is served from an XHR-recorded body",
  );
  assert.strictEqual(await bodyOf(pf), VIEWS, "E3: body matches");
  console.log("OK: E3: record over XHR, serve over fetch");
}

// ---- JELA-760 fixtures -----------------------------------------------------
const SERIES = "aaaaaaaabbbbccccddddeeeeffff0001";
const SEASON = "aaaaaaaabbbbccccddddeeeeffff0002";
const EPISODE = "aaaaaaaabbbbccccddddeeeeffff0003";
const EPLIST = JSON.stringify({ Items: [{ Id: EPISODE, Name: "Ep 1" }] });
const TAGS = JSON.stringify({ tags: ["a"] });
const NOTIFY = JSON.stringify({ n: 0 });
// itemCache on, aliasCoalesce off — the two flags must be independent.
function icEnv(extra) {
  return makeEnv({
    flagOff: true,
    store: Object.assign({ "jellyfin.shell.itemCache": "1" }, extra || {}),
  });
}
const EPURL =
  "/Shows/" + SERIES + "/Episodes?SeasonId=" + SEASON + "&UserId=" + UID;

// ---- F. JELA-760 gating and flag independence ------------------------------
async function F() {
  // F1 — itemCache alone arms the block and covers the episode list.
  let e = icEnv();
  e.run();
  assert(e.window.__shellACo && e.window.__shellACo.on, "F1: armed");
  assert.strictEqual(e.window.__shellACo.ic, 1, "F1: drill mode reported");
  let p = get(e, EPURL);
  assert.strictEqual(e.netCalls.length, 1, "F1: first episode list hits net");
  e.netCalls[0].resolve(200, EPLIST);
  await bodyOf(p);
  await e.drainMicro();
  p = get(e, EPURL);
  assert.strictEqual(
    e.netCalls.length,
    1,
    "F1/AC1: the refetched episode list issues NO request",
  );
  assert.strictEqual(await bodyOf(p), EPLIST, "F1: body served verbatim");
  console.log("OK: F1: itemCache alone collapses /Shows/{id}/Episodes");

  // F2 — aliasCoalesce alone must NOT pick up the drill shapes.
  e = makeEnv();
  e.run();
  assert.strictEqual(e.window.__shellACo.ic, 0, "F2: drill mode off");
  p = get(e, EPURL);
  e.netCalls[0].resolve(200, EPLIST);
  await bodyOf(p);
  await e.drainMicro();
  p = get(e, EPURL);
  assert.strictEqual(
    e.netCalls.length,
    2,
    "F2: without itemCache the episode list is untouched",
  );
  e.netCalls[1].resolve(200, EPLIST);
  await bodyOf(p);
  console.log("OK: F2: the JELA-742 flag alone does not arm the drill shapes");

  // F3 — kill-switch.
  e = icEnv({ "jellyfin.shell.itemCacheDisabled": "1" });
  e.run();
  assert(!e.window.__shellACo, "F3: itemCacheDisabled=1 beats itemCache=1");
  console.log("OK: F3: itemCacheDisabled=1 beats itemCache=1");

  // F4 — the converse: itemCache must not silently ship JELA-742's views pair.
  e = icEnv();
  e.run();
  p = get(e, "/UserViews?userId=" + UID);
  e.netCalls[0].resolve(200, VIEWS);
  await bodyOf(p);
  await e.drainMicro();
  p = get(e, "/Users/" + UID + "/Views");
  assert.strictEqual(
    e.netCalls.length,
    2,
    "F4: the views pair stays behind aliasCoalesce",
  );
  e.netCalls[1].resolve(200, VIEWS);
  await bodyOf(p);
  console.log("OK: F4: itemCache does not arm the views pair");
}

// ---- G. multi-read, TTLs, key safety ---------------------------------------
async function G() {
  // G1 — the headline: the drill reads the same item body 14x. A one-shot slot
  // covers one of those; a multi-read slot covers all of them.
  let e = icEnv();
  e.run();
  let p = get(e, "/Users/" + UID + "/Items/" + SERIES);
  e.netCalls[0].resolve(200, ITEM1);
  await bodyOf(p);
  await e.drainMicro();
  for (let i = 0; i < 13; i++) {
    p = get(
      e,
      i % 2 ? "/Items/" + SERIES : "/Users/" + UID + "/Items/" + SERIES,
    );
    assert.strictEqual(await bodyOf(p), ITEM1, "G1: read " + i + " served");
  }
  assert.strictEqual(
    e.netCalls.length,
    1,
    "G1/AC1: 14 reads of the series body = 1 request",
  );
  assert.strictEqual(e.window.__shellACo.mh, 13, "G1: 13 multi-reads counted");
  assert.strictEqual(
    e.window.__shellACo.sv,
    ITEM1.length * 13,
    "G1: bytes kept off the wire counted",
  );
  console.log("OK: G1/AC1: 14 reads of one item body collapse to 1 request");

  // G2 — the slot is not immortal: past the item TTL it goes back to the net.
  e = icEnv();
  e.run();
  p = get(e, "/Users/" + UID + "/Items/" + SERIES);
  e.netCalls[0].resolve(200, ITEM1);
  await bodyOf(p);
  await e.drainMicro();
  e.tick(30001);
  p = get(e, "/Users/" + UID + "/Items/" + SERIES);
  assert.strictEqual(e.netCalls.length, 2, "G2: past the TTL it refetches");
  e.netCalls[1].resolve(200, ITEM1);
  await bodyOf(p);
  console.log("OK: G2: an item slot expires at itemCacheTtlMs (30 s default)");

  // G3 — config outlives items: 60 s vs 30 s, and each poller has its own key.
  e = icEnv();
  e.run();
  const cfgs = [
    ["/JellyfinEnhanced/tag-cache/" + UID, TAGS],
    ["/JellyfinEnhanced/user-settings/" + UID + "/settings.json", TAGS],
    ["/JellyfinEnhanced/jellyseerr/user-status", TAGS],
    ["/NotifySync/Data", NOTIFY],
  ];
  for (const [u, b] of cfgs) {
    const q = get(e, u);
    e.netCalls[e.netCalls.length - 1].resolve(200, b);
    await bodyOf(q);
    await e.drainMicro();
  }
  assert.strictEqual(e.netCalls.length, 4, "G3: each poller fetched once");
  const itm = get(e, "/Users/" + UID + "/Items/" + SEASON);
  e.netCalls[4].resolve(200, ITEM1);
  await bodyOf(itm);
  await e.drainMicro();
  e.tick(40000); // past the 30 s item TTL, inside the 60 s config TTL
  for (const [u, b] of cfgs) {
    assert.strictEqual(
      await bodyOf(get(e, u)),
      b,
      "G3: " + u + " still served",
    );
  }
  assert.strictEqual(
    e.netCalls.length,
    5,
    "G3/AC3: the four per-route pollers are answered from cache",
  );
  const late = get(e, "/Users/" + UID + "/Items/" + SEASON);
  assert.strictEqual(e.netCalls.length, 6, "G3: the item slot did expire");
  e.netCalls[5].resolve(200, ITEM1);
  await bodyOf(late);
  console.log("OK: G3/AC3: the per-route pollers collapse on a longer TTL");

  // G4 — NextUp and ThemeMedia (XHR in the wild) are covered too.
  e = icEnv();
  e.run();
  p = get(e, "/Shows/NextUp?seriesid=" + SERIES + "&UserId=" + UID);
  e.netCalls[0].resolve(200, EPLIST);
  await bodyOf(p);
  await e.drainMicro();
  p = get(e, "/Shows/NextUp?seriesid=" + SERIES + "&UserId=" + UID);
  assert.strictEqual(e.netCalls.length, 1, "G4: NextUp collapses");
  await bodyOf(p);
  const t1 = new e.window.XMLHttpRequest();
  t1.open("GET", SRV + "/Items/" + SEASON + "/ThemeMedia", true);
  t1.send();
  t1.__respond(200, EPLIST);
  await e.drainMicro();
  const t2 = new e.window.XMLHttpRequest();
  t2.open("GET", SRV + "/Items/" + SEASON + "/ThemeMedia", true);
  t2.send();
  assert.strictEqual(
    e.xcalls.length,
    1,
    "G4: ThemeMedia collapses over XHR — the transport a fetch-level join cannot reach",
  );
  console.log("OK: G4: NextUp (fetch) and ThemeMedia (XHR) collapse");

  // G5 — safety: a different projection is a different key, and a foreign user
  // is never served.
  e = icEnv();
  e.run();
  p = get(e, EPURL);
  e.netCalls[0].resolve(200, EPLIST);
  await bodyOf(p);
  await e.drainMicro();
  p = get(e, EPURL + "&Fields=Overview");
  assert.strictEqual(
    e.netCalls.length,
    2,
    "G5: a differing residual query never reads another projection",
  );
  e.netCalls[1].resolve(200, EPLIST);
  await bodyOf(p);
  p = get(e, "/Shows/" + SERIES + "/Episodes?UserId=" + OTHER);
  assert.strictEqual(e.netCalls.length, 3, "G5: a foreign userId is untouched");
  e.netCalls[2].resolve(200, EPLIST);
  await bodyOf(p);
  p = get(e, "/JellyfinEnhanced/tag-cache/" + OTHER);
  assert.strictEqual(
    e.netCalls.length,
    4,
    "G5: another user's tag-cache is untouched",
  );
  e.netCalls[3].resolve(200, TAGS);
  await bodyOf(p);
  console.log("OK: G5: differing params and foreign users never share a slot");
}

// ---- H. classed invalidation (the JELA-757 trap) ---------------------------
// Seed one item slot and two config slots — one under the plugin root that
// does the writing (JellyfinEnhanced) and one under a DIFFERENT plugin
// (NotifySync) — then fire `method url` and report which survived.
async function H() {
  async function seeded() {
    const e = icEnv();
    e.run();
    let p = get(e, "/Users/" + UID + "/Items/" + SERIES);
    e.netCalls[0].resolve(200, ITEM1);
    await bodyOf(p);
    await e.drainMicro();
    p = get(e, "/NotifySync/Data");
    e.netCalls[1].resolve(200, NOTIFY);
    await bodyOf(p);
    await e.drainMicro();
    p = get(e, "/JellyfinEnhanced/tag-cache/" + UID);
    e.netCalls[2].resolve(200, TAGS);
    await bodyOf(p);
    await e.drainMicro();
    assert.strictEqual(e.netCalls.length, 3, "H: seeded 3 slots");
    return e;
  }
  async function probe(e) {
    const before = e.netCalls.length;
    const a = get(e, "/Users/" + UID + "/Items/" + SERIES);
    const itemLive = e.netCalls.length === before;
    if (!itemLive) e.netCalls[e.netCalls.length - 1].resolve(200, ITEM1);
    await bodyOf(a);
    await e.drainMicro();
    const mid = e.netCalls.length;
    const b = get(e, "/NotifySync/Data");
    const cfgLive = e.netCalls.length === mid;
    if (!cfgLive) e.netCalls[e.netCalls.length - 1].resolve(200, NOTIFY);
    await bodyOf(b);
    await e.drainMicro();
    const mid2 = e.netCalls.length;
    const c = get(e, "/JellyfinEnhanced/tag-cache/" + UID);
    const cfgSameLive = e.netCalls.length === mid2;
    if (!cfgSameLive) e.netCalls[e.netCalls.length - 1].resolve(200, TAGS);
    await bodyOf(c);
    await e.drainMicro();
    return { item: itemLive, cfg: cfgLive, cfgSame: cfgSameLive };
  }

  // H1 — the exact write JELA-757 measured inside every dwell. A blanket flush
  // would empty the store here; the classed flush must spare the item slot.
  let e = await seeded();
  e.window.fetch(
    SRV + "/JellyfinEnhanced/user-settings/" + UID + "/settings.json",
    {
      method: "POST",
    },
  );
  e.netCalls[e.netCalls.length - 1].resolve(204, "");
  await e.drainMicro();
  let r = await probe(e);
  assert(r.item, "H1: a plugin write must NOT retire the item slot");
  assert(!r.cfgSame, "H1: it DOES retire its own plugin's config slots");
  console.log("OK: H1: a plugin-namespace write retires config only");

  // H1b — and the config half is scoped to the WRITING plugin's root. The
  // seven settings.json POSTs in the JELA-759 capture are all
  // JellyfinEnhanced's; retiring NotifySync's slot as well cost 16 of the
  // drill's requests for a body the write cannot reach.
  assert(r.cfg, "H1b: a write must NOT retire another plugin's config slot");
  console.log("OK: H1b: the config flush is scoped to the writing plugin");

  // H2 — a play-state write must retire the item bodies it can have changed.
  e = await seeded();
  e.window.fetch(SRV + "/Users/" + UID + "/PlayedItems/" + EPISODE, {
    method: "POST",
  });
  e.netCalls[e.netCalls.length - 1].resolve(200, "{}");
  await e.drainMicro();
  r = await probe(e);
  assert(!r.item, "H2: PlayedItems retires the item slots");
  assert(r.cfg && r.cfgSame, "H2: PlayedItems leaves config alone");
  console.log("OK: H2: a play-state write retires the item slots");

  // H3 — unknown shapes fail toward correctness.
  e = await seeded();
  e.window.fetch(SRV + "/Something/Unknown", { method: "PUT" });
  e.netCalls[e.netCalls.length - 1].resolve(200, "{}");
  await e.drainMicro();
  r = await probe(e);
  assert(!r.item, "H3: an unrecognised write still retires the item slots");
  console.log("OK: H3: an unrecognised write still retires items");

  // H4 — writes that provably cannot touch an item body are exempt.
  e = await seeded();
  e.window.fetch(SRV + "/DisplayPreferences/usersettings?userId=" + UID, {
    method: "POST",
  });
  e.netCalls[e.netCalls.length - 1].resolve(204, "");
  await e.drainMicro();
  r = await probe(e);
  assert(
    r.item && r.cfg && r.cfgSame,
    "H4: DisplayPreferences retires nothing",
  );
  console.log("OK: H4: an exempt write retires nothing");

  // H5 — the flush is transport-agnostic (ThemeMedia proved XHR is in play).
  e = await seeded();
  const x = new e.window.XMLHttpRequest();
  x.open("POST", SRV + "/Users/" + UID + "/FavoriteItems/" + SERIES, true);
  x.send();
  x.__respond(200, "{}");
  await e.drainMicro();
  r = await probe(e);
  assert(!r.item, "H5: an XHR write retires the item slots too");
  assert(r.cfg && r.cfgSame, "H5: and still spares config");
  console.log("OK: H5: the flush fires over XHR as well as fetch");

  // H6 — with the drill flag off, JELA-742's behaviour is byte-for-byte intact:
  // no flush hook, because there is no multi-read slot to retire.
  e = makeEnv();
  e.run();
  let p = get(e, "/Items/" + ID1);
  e.netCalls[0].resolve(200, ITEM1);
  await bodyOf(p);
  await e.drainMicro();
  e.window.fetch(SRV + "/Users/" + UID + "/PlayedItems/" + ID1, {
    method: "POST",
  });
  e.netCalls[e.netCalls.length - 1].resolve(200, "{}");
  await e.drainMicro();
  p = get(e, "/Users/" + UID + "/Items/" + ID1);
  assert.strictEqual(
    e.netCalls.length,
    2,
    "H6: without itemCache the alias pair still collapses across a write",
  );
  assert.strictEqual(await bodyOf(p), ITEM1, "H6: JELA-742 body served");
  assert.strictEqual(e.window.__shellACo.fl, 0, "H6: no flush accounted");
  console.log("OK: H6: the drill flag off leaves JELA-742 untouched");
}

// ---- I. JELA-842 cfgOnce: the singleton config shapes ----------------------
const CFG = JSON.stringify({ Tabs: [{ Id: 1 }] });
const CFG2 = JSON.stringify({ Tabs: [{ Id: 2 }] });

// cfgOnce ALONE — aliasCoalesce off, itemCache off — so every count below is
// attributable to this flag and nothing else. JELA-852: the key is left ABSENT
// rather than set to "1", so section I now measures the shipped opt-OUT
// default on a store that looks exactly like a fresh profile's.
function cfgEnv(extra) {
  return makeEnv({ flagOff: true, cfgAbsent: true, store: extra || {} });
}

async function I() {
  // I1 — gating, JELA-852 polarity. The explicit opt-out value "0" stands the
  // flag down; the kill switch still wins ahead of it on a boot that has never
  // seen either key ([[jela838-channel-flag-boot1-optout]]).
  let e = makeEnv({ flagOff: true });
  e.run();
  assert(!e.window.__shellACo, "I1: cfgOnce=0 -> inert");
  let p = get(e, "/CustomTabs/Config");
  e.netCalls[0].resolve(200, CFG);
  await bodyOf(p);
  await e.drainMicro();
  p = get(e, "/CustomTabs/Config");
  assert.strictEqual(
    e.netCalls.length,
    2,
    "I1: OFF -> the repeat hits the net",
  );
  e.netCalls[1].resolve(200, CFG);
  await bodyOf(p);

  e = cfgEnv({ "jellyfin.shell.cfgOnceDisabled": "1" });
  e.run();
  assert(!e.window.__shellACo, "I1: cfgOnceDisabled=1 beats the opt-OUT arm");

  e = cfgEnv();
  e.run();
  assert(
    e.window.__shellACo && e.window.__shellACo.co === 1,
    "I1: cfgOnce arms the shim on its own",
  );
  console.log("OK: I1: kill-switch first, arms without siblings");

  // I1b — JELA-852 AC2, the unit half of the two-boot arm proof. The store here
  // holds NO cfgOnce key at all, which is precisely a fresh profile's boot 1;
  // the block must already be armed. The three states are asserted together
  // because the flip's whole risk is that they collapse into each other: an
  // absent key must NOT read as OFF (that is the pre-flip bug this ticket
  // fixes), and "0" must NOT read as ON (that is the rollback path).
  e = cfgEnv();
  e.run();
  assert.strictEqual(
    e.store["jellyfin.shell.cfgOnce"],
    undefined,
    "I1b: the fixture really has no seeded enable key",
  );
  assert(
    e.window.__shellACo && e.window.__shellACo.co === 1,
    "I1b/AC2: an ABSENT cfgOnce key arms the coalescer on boot 1",
  );
  p = get(e, "/CustomTabs/Config");
  const dup = get(e, "/CustomTabs/Config");
  assert.strictEqual(
    e.netCalls.length,
    1,
    "I1b/AC2: the unseeded boot already collapses the duplicate",
  );
  e.netCalls[0].resolve(200, CFG);
  assert.strictEqual(await bodyOf(p), CFG, "I1b: first read served");
  assert.strictEqual(await bodyOf(dup), CFG, "I1b: parked read served");

  // I1c — JELA-852 AC3, the differential: the SAME unseeded store plus the kill
  // switch leaves the shim absent and the duplicate GET back on the wire.
  e = cfgEnv({ "jellyfin.shell.cfgOnceDisabled": "1" });
  e.run();
  assert(!e.window.__shellACo, "I1c/AC3: cfgOnceDisabled=1 disarms boot 1");
  p = get(e, "/CustomTabs/Config");
  e.netCalls[0].resolve(200, CFG);
  await bodyOf(p);
  await e.drainMicro();
  p = get(e, "/CustomTabs/Config");
  assert.strictEqual(
    e.netCalls.length,
    2,
    "I1c/AC3: killed -> the duplicate GET is back",
  );
  e.netCalls[1].resolve(200, CFG);
  await bodyOf(p);
  console.log("OK: I1b/I1c: absent key arms boot 1, cfgOnceDisabled revokes it");

  // I2 — AC1, the JELA-840 headline: /CustomTabs/Config asked 4x inside 82 ms.
  // All four are CONCURRENT, so only the in-flight park can collapse them.
  e = cfgEnv();
  e.run();
  const four = [
    get(e, "/CustomTabs/Config"),
    get(e, "/CustomTabs/Config"),
    get(e, "/CustomTabs/Config"),
    get(e, "/CustomTabs/Config"),
  ];
  assert.strictEqual(
    e.net("/CustomTabs/Config").length,
    1,
    "I2/AC1: 4 concurrent readers issue ONE request",
  );
  e.netCalls[0].resolve(200, CFG);
  for (const q of four)
    assert.strictEqual(await bodyOf(q), CFG, "I2: every reader gets the body");
  // and a fifth, arriving after the body landed, is served from the slot.
  await e.drainMicro();
  const fifth = get(e, "/CustomTabs/Config");
  assert.strictEqual(
    e.net("/CustomTabs/Config").length,
    1,
    "I2: a later reader is served from the completed slot (multi-read)",
  );
  assert.strictEqual(await bodyOf(fifth), CFG, "I2: fifth body verbatim");
  console.log("OK: I2/AC1: /CustomTabs/Config x5 = 1 request");

  // I3 — the whole measured cluster, one request each, mixed transports.
  // JELA-840 saw these split across fetch and XHR, which is exactly why the
  // fetch-level coalescers never caught them.
  e = cfgEnv();
  e.run();
  const SHAPES = [
    "/System/Info",
    "/System/Info/Public",
    "/DisplayPreferences/usersettings?userId=" + UID + "&client=emby",
    "/Branding/Configuration",
    "/JellyfinEnhanced/public-config",
    "/JellyfinEnhanced/private-config",
    "/JellyfinEnhanced/version",
    "/JellyfinEnhanced/locales/en-US.json",
  ];
  for (const u of SHAPES) {
    const first = get(e, u);
    assert.strictEqual(e.net(u).length, 1, "I3: " + u + " first call is real");
    e.net(u)[0].resolve(200, CFG);
    assert.strictEqual(await bodyOf(first), CFG, "I3: " + u + " body");
    await e.drainMicro();
    // repeat over XHR — the transport a fetch-level join cannot reach
    const x = new e.window.XMLHttpRequest();
    x.open("GET", SRV + u, true);
    let got = null;
    x.onload = function () {
      got = x.responseText;
    };
    const before = e.xcalls.length;
    x.send();
    assert.strictEqual(
      e.xcalls.length,
      before,
      "I3: " + u + " repeat issues no XHR",
    );
    e.runTimers();
    assert.strictEqual(got, CFG, "I3: " + u + " served over XHR");
    assert.strictEqual(e.net(u).length, 1, "I3: " + u + " stayed at 1 request");
  }
  console.log("OK: I3/AC1: all 8 shapes collapse to one request, fetch<->XHR");

  // I4 — the auth-style split. JELA-839 armed queryAuth on the first boot, so
  // the same endpoint is asked once as ?api_key=<token> and once with the
  // header. Those must collapse — but only when the key IS ours.
  e = cfgEnv();
  e.run();
  p = get(e, "/JellyfinEnhanced/version?api_key=tok");
  e.netCalls[0].resolve(200, CFG);
  await bodyOf(p);
  await e.drainMicro();
  p = get(e, "/JellyfinEnhanced/version");
  assert.strictEqual(
    e.net("/JellyfinEnhanced/version").length,
    1,
    "I4: query-auth and header-auth readers share one request",
  );
  assert.strictEqual(
    await bodyOf(p),
    CFG,
    "I4: body served across auth styles",
  );

  const foreign = get(e, "/JellyfinEnhanced/version?api_key=someoneelse");
  assert.strictEqual(
    e.net("/JellyfinEnhanced/version").length,
    2,
    "I4: a foreign api_key never reads this store",
  );
  e.netCalls[e.netCalls.length - 1].resolve(200, CFG2);
  assert.strictEqual(await bodyOf(foreign), CFG2, "I4: it gets its own answer");
  console.log(
    "OK: I4: api_key is dropped from the key only after a token check",
  );

  // I5 — safety: a foreign userId, an unlisted path, and a non-GET are all
  // untouched. /Plugins and /System/Configuration are admin-mutable from
  // another client and are deliberately NOT in the set.
  e = cfgEnv();
  e.run();
  p = get(e, "/DisplayPreferences/usersettings?userId=" + OTHER);
  e.netCalls[0].resolve(200, CFG);
  await bodyOf(p);
  await e.drainMicro();
  p = get(e, "/DisplayPreferences/usersettings?userId=" + OTHER);
  assert.strictEqual(
    e.netCalls.length,
    2,
    "I5: another user's preferences never coalesce",
  );
  e.netCalls[1].resolve(200, CFG);
  await bodyOf(p);
  for (const u of ["/Plugins", "/System/Configuration", "/PluginPages/User"]) {
    const n0 = e.netCalls.length;
    const q1 = get(e, u);
    e.netCalls[n0].resolve(200, CFG);
    await bodyOf(q1);
    await e.drainMicro();
    const q2 = get(e, u);
    assert.strictEqual(
      e.netCalls.length,
      n0 + 2,
      "I5: " + u + " is not in the set",
    );
    e.netCalls[n0 + 1].resolve(200, CFG);
    await bodyOf(q2);
  }
  console.log("OK: I5: foreign user / unlisted paths reach the network");

  // I6 — invalidation. A write must retire the config it can have changed, and
  // for S: slots that includes /DisplayPreferences — the path the JELA-760
  // flush exempts. Both transports.
  for (const mode of ["fetch", "xhr"]) {
    e = cfgEnv();
    e.run();
    p = get(e, "/DisplayPreferences/usersettings?userId=" + UID);
    e.netCalls[0].resolve(200, CFG);
    await bodyOf(p);
    await e.drainMicro();
    if (mode === "fetch") {
      e.window.fetch(SRV + "/DisplayPreferences/usersettings?userId=" + UID, {
        method: "POST",
      });
      e.netCalls[e.netCalls.length - 1].resolve(204, "");
    } else {
      const w = new e.window.XMLHttpRequest();
      w.open(
        "POST",
        SRV + "/DisplayPreferences/usersettings?userId=" + UID,
        true,
      );
      w.send();
      w.__respond(204, "");
    }
    await e.drainMicro();
    const n1 = e.netCalls.length;
    p = get(e, "/DisplayPreferences/usersettings?userId=" + UID);
    assert.strictEqual(
      e.netCalls.length,
      n1 + 1,
      "I6/" + mode + ": the write retired the slot",
    );
    e.netCalls[n1].resolve(200, CFG2);
    assert.strictEqual(await bodyOf(p), CFG2, "I6/" + mode + ": fresh body");
    assert(e.window.__shellACo.fl > 0, "I6/" + mode + ": flush accounted");
  }
  console.log("OK: I6: any write retires every S: slot, over fetch and XHR");

  // I6b — the ONE exemption, and it is not speculative: the first JELA-842 A/B
  // ring measured POST /Sessions/Capabilities/Full landing between the two
  // /DisplayPreferences reads on 4 of 4 armed boots, which retired the slot and
  // left that endpoint the only one in the set still fetched twice. Session
  // state and our own /shell/ beacons cannot change a config body.
  for (const w of [
    "/Sessions/Capabilities/Full",
    "/Sessions/Playing/Progress",
    "/QuickConnect/Authorize",
    "/shell/diag",
  ]) {
    e = cfgEnv();
    e.run();
    p = get(e, "/DisplayPreferences/usersettings?userId=" + UID);
    e.netCalls[0].resolve(200, CFG);
    await bodyOf(p);
    await e.drainMicro();
    e.window.fetch(SRV + w, { method: "POST" });
    e.netCalls[e.netCalls.length - 1].resolve(204, "");
    await e.drainMicro();
    const n2 = e.netCalls.length;
    p = get(e, "/DisplayPreferences/usersettings?userId=" + UID);
    assert.strictEqual(
      e.netCalls.length,
      n2,
      "I6b: " + w + " must NOT retire the config slots",
    );
    assert.strictEqual(
      await bodyOf(p),
      CFG,
      "I6b: " + w + " body still served",
    );
    assert.strictEqual(e.window.__shellACo.fl, 0, "I6b: no flush accounted");
  }
  console.log("OK: I6b: session-state and /shell/ writes retire nothing");

  // I7 — the TTL is real. The S: slots exist to span a ~6 s pre-paint fan-out,
  // not a session; at 120 s the slot is gone.
  e = cfgEnv();
  e.run();
  p = get(e, "/CustomTabs/Config");
  e.netCalls[0].resolve(200, CFG);
  await bodyOf(p);
  await e.drainMicro();
  e.tick(119000);
  p = get(e, "/CustomTabs/Config");
  assert.strictEqual(e.netCalls.length, 1, "I7: served inside the TTL");
  await bodyOf(p);
  e.tick(2000);
  p = get(e, "/CustomTabs/Config");
  assert.strictEqual(e.netCalls.length, 2, "I7: not served past 120 s");
  e.netCalls[1].resolve(200, CFG2);
  assert.strictEqual(await bodyOf(p), CFG2, "I7: refetched body");
  console.log("OK: I7: the 120 s S: TTL holds and then releases");

  // I8 — flag independence in both directions. cfgOnce must not arm the
  // JELA-742 alias pair, and aliasCoalesce must not arm the config shapes.
  e = cfgEnv();
  e.run();
  p = get(e, "/Items/" + ID1);
  e.netCalls[0].resolve(200, ITEM1);
  await bodyOf(p);
  await e.drainMicro();
  p = get(e, "/Users/" + UID + "/Items/" + ID1);
  assert.strictEqual(
    e.netCalls.length,
    2,
    "I8: cfgOnce does not arm the alias pair",
  );
  e.netCalls[1].resolve(200, ITEM1);
  await bodyOf(p);

  e = makeEnv();
  e.run();
  p = get(e, "/CustomTabs/Config");
  e.netCalls[0].resolve(200, CFG);
  await bodyOf(p);
  await e.drainMicro();
  p = get(e, "/CustomTabs/Config");
  assert.strictEqual(
    e.netCalls.length,
    2,
    "I8: aliasCoalesce does not arm the config shapes",
  );
  e.netCalls[1].resolve(200, CFG);
  await bodyOf(p);
  console.log(
    "OK: I8: cfgOnce and aliasCoalesce arm strictly their own shapes",
  );

  // I9 — a token change flushes: stale-user config is never served.
  e = cfgEnv();
  e.run();
  p = get(e, "/System/Info");
  e.netCalls[0].resolve(200, CFG);
  await bodyOf(p);
  await e.drainMicro();
  e.store.jellyfin_credentials = JSON.stringify({
    Servers: [{ Id: "s1", AccessToken: "tok2", UserId: UID }],
  });
  p = get(e, "/System/Info");
  assert.strictEqual(e.netCalls.length, 2, "I9: a token change flushes");
  e.netCalls[1].resolve(200, CFG2);
  assert.strictEqual(await bodyOf(p), CFG2, "I9: the new token's body");
  console.log("OK: I9: a token change flushes the config slots");

  // I10 — a failed leader is not cached and its parked waiters replay.
  e = cfgEnv();
  e.run();
  const a1 = get(e, "/JellyfinEnhanced/public-config");
  const a2 = get(e, "/JellyfinEnhanced/public-config");
  assert.strictEqual(
    e.net("/JellyfinEnhanced/public-config").length,
    1,
    "I10: the second reader parked",
  );
  e.netCalls[0].resolve(500, "boom");
  await bodyOf(a1);
  await e.drainMicro();
  assert.strictEqual(
    e.net("/JellyfinEnhanced/public-config").length,
    2,
    "I10: the parked reader replays on the network",
  );
  e.netCalls[1].resolve(200, CFG);
  assert.strictEqual(await bodyOf(a2), CFG, "I10: replayed body");
  console.log("OK: I10: a failed leader is never cached; waiters replay");
}

A()
  .then(B)
  .then(C)
  .then(D)
  .then(E)
  .then(F)
  .then(G)
  .then(H)
  .then(I)
  .then(() => console.log("\nAll alias-coalesce + item-cache checks passed."))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
