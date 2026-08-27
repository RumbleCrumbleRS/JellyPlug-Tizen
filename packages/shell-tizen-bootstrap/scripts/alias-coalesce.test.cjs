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
 */
"use strict";
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const SRC = path.join(__dirname, "..", "src", "boot-shell.src.js");
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
    },
    opts.flagOff ? {} : { "jellyfin.shell.aliasCoalesce": "1" },
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

A()
  .then(B)
  .then(C)
  .then(D)
  .then(E)
  .then(() => console.log("\nAll alias-coalesce checks passed."))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
