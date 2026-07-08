/*
 * JELA-51 (JELA-41 WS-5): home-sections API data prefetch + SPA intercept —
 * opt-in via localStorage['jellyfin.shell.apiWarm']='1', default OFF.
 *
 * Extracts the SHIPPED instantHomeBody() and drives it through a virtual
 * clock + DOM stub + controllable XHR/fetch, pinning:
 *   - default OFF: no flag -> no __shellAW state, zero prefetch requests
 *   - kill-switch: apiWarmDisabled=1 beats apiWarm=1 (reserved for the WS-6
 *     default-ON flip, honored already)
 *   - prereq gates: missing creds or no http(s) base -> inert; srv() empty
 *     falls back to the stored ManualAddress (JELA-47 origin rule: the
 *     SERVER origin keys everything, the page origin is never consulted)
 *   - prefetch: tag-cache FIRST, Sections SECOND, WS-4 deterministic list,
 *     X-Emby-Token auth, bounded 8-wide, one request per canonical URL
 *   - chained fan-out: Section/* URLs built from the Sections RESPONSE
 *     (AdditionalData preserved, NextUp gets NextUpDateCutoff +
 *     EnableRewatching=false, hostile section names dropped)
 *   - intercept match: fetch served from the store without network; query
 *     params match order-insensitively; NextUpDateCutoff and "_" cache-
 *     busters are fuzz-dropped; the ManualAddress alias origin matches too
 *   - one-shot: a served URL is consumed; the next identical call goes to
 *     the network (miss counted)
 *   - pending-attach: a SPA call while the prefetch is in flight parks on
 *     the same request (tag-cache case) and is fed on completion; a failed
 *     prefetch replays the SPA call on the network
 *   - miss/expiry: never-prefetched URLs pass through untouched; entries
 *     expire after the 60 s TTL
 *   - auth-edge: a token change flushes the store (st="auth"), stale-user
 *     data is never served
 *   - XHR delivery: readyState/status/responseText/response(+json)
 *     shadowed, on* handlers fired, content-type header answered; abort()
 *     before delivery suppresses it; POST is never intercepted
 *   - DH-handoff/gen-turnover survival: a re-run body (document.write swap)
 *     never re-prefetches, and the window-level patches keep serving
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
assert(body.indexOf("jellyfin.shell.apiWarm") !== -1, "opt-in flag present");
assert(
  body.indexOf("jellyfin.shell.apiWarmDisabled") !== -1,
  "reserved kill-switch honored",
);
assert(body.indexOf("X-Emby-Token") !== -1, "prefetch authenticates");
assert(body.indexOf("</script") === -1, "no </script literal");
assert(body.indexOf("=>") === -1, "body must be ES5 (no arrow functions)");
assert(body.indexOf("`") === -1, "body must be ES5 (no template literals)");
assert(
  body.indexOf("eval(") === -1,
  "prefetched responses are never evaluated",
);

// ---- fixtures ----------------------------------------------------------------
const UID = "u1";
const CREDS = JSON.stringify({
  Servers: [
    { Id: "s1", AccessToken: "tok", UserId: UID, ManualAddress: "http://alt" },
  ],
});
const SECTIONS = JSON.stringify({
  Items: [
    { Section: "MyMedia" },
    { Section: "NextUp" },
    { Section: "BecauseYouWatched", AdditionalData: "guid-1" },
    { Section: "Genre", AdditionalData: "Thriller" },
    { Section: "Bad Name!" }, // hostile name -> dropped
  ],
});

function makeEnv(opts) {
  opts = opts || {};
  let now = 0;
  let nextTimerId = 1;
  const timers = new Map();
  function setIntervalStub(cb, ms) {
    const id = nextTimerId++;
    timers.set(id, { cb, ms, next: now + ms, repeat: true });
    return id;
  }
  function setTimeoutStub(cb, ms) {
    const id = nextTimerId++;
    timers.set(id, { cb, ms, next: now + ms, repeat: false });
    return id;
  }
  function clearStub(id) {
    timers.delete(id);
  }
  function FakeDate() {
    this._t = now;
  }
  FakeDate.prototype.valueOf = function () {
    return this._t;
  };
  FakeDate.prototype.toISOString = function () {
    return "1970-01-01T00:00:00." + ("00" + (this._t % 1000)).slice(-3) + "Z";
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
    createElement(t) {
      return makeNode(String(t).toUpperCase());
    },
    getElementById(id) {
      function byId(node) {
        if (node.id === id) return node;
        for (const c of node.children) {
          const hit = byId(c);
          if (hit) return hit;
        }
        return null;
      }
      return byId(documentElement);
    },
    querySelectorAll() {
      return [];
    },
  };

  const listeners = {};
  const window = {
    innerWidth: 1920,
    innerHeight: 1080,
    pageYOffset: 0,
    __shellT0: 0,
    addEventListener(t, fn) {
      (listeners[t] = listeners[t] || []).push(fn);
    },
  };
  window.__shellPhase = function () {};

  // ---- controllable XHR stub ----
  const xcalls = []; // every instance that reached real send()
  function FakeXHR() {
    this.readyState = 0;
    this.status = 0;
    this.responseText = "";
    this.responseType = "";
    this.timeout = 0;
    this.headers = {};
    this.sent = false;
    this.aborted = false;
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
  FakeXHR.prototype.__respond = function (status, txt) {
    if (this.aborted) return;
    this.readyState = 4;
    this.status = status;
    this.responseText = txt;
    if (typeof this.onreadystatechange === "function")
      this.onreadystatechange();
  };
  window.XMLHttpRequest = FakeXHR;

  // ---- fetch spy (the "network") ----
  const netCalls = [];
  window.fetch = function (u, o) {
    netCalls.push({ url: String(u && u.url ? u.url : u), opts: o || {} });
    return Promise.resolve({ ok: true, __net: true, text: () => "" });
  };

  const store = Object.assign(
    {
      jellyfin_credentials: opts.creds !== undefined ? opts.creds : CREDS,
      "jellyfin.shell.serverUrl":
        opts.srv !== undefined ? opts.srv : "http://srv",
    },
    opts.flagOff ? {} : { "jellyfin.shell.apiWarm": "1" },
    opts.store || {},
  );
  const localStorage = {
    getItem(k) {
      return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null;
    },
    setItem(k, v) {
      store[k] = String(v);
    },
    removeItem(k) {
      delete store[k];
    },
  };
  const location = { hash: "" };
  const getComputedStyle = function () {
    return { fontSize: "28px", borderTopLeftRadius: "6px" };
  };

  async function drainMicro(n) {
    for (let i = 0; i < (n || 200); i++) await Promise.resolve();
  }

  return {
    window,
    document,
    timers,
    store,
    xcalls,
    netCalls,
    FakeXHR,
    drainMicro,
    pendingX() {
      return xcalls.filter((x) => x.readyState !== 4 && !x.aborted);
    },
    findX(frag) {
      return xcalls.find((x) => x.url.indexOf(frag) !== -1);
    },
    swapDoc() {
      for (const k in listeners) delete listeners[k];
      documentElement.children.length = 0;
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
        location,
        getComputedStyle,
      );
    },
    async resolveAll(map) {
      // answer every in-flight prefetch (Sections gets the fixture)
      for (let guard = 0; guard < 30; guard++) {
        const open = this.pendingX();
        if (!open.length) break;
        for (const x of open) {
          let bodyTxt = '{"ok":1}';
          let code = 200;
          if (x.url.indexOf("/HomeScreen/Sections?") !== -1) bodyTxt = SECTIONS;
          if (map) {
            for (const frag in map) {
              if (x.url.indexOf(frag) !== -1) {
                code = map[frag].status !== undefined ? map[frag].status : 200;
                bodyTxt =
                  map[frag].text !== undefined ? map[frag].text : bodyTxt;
              }
            }
          }
          x.__respond(code, bodyTxt);
        }
        await drainMicro(50);
      }
    },
    async advance(toMs) {
      for (;;) {
        let nextTimer = null;
        let nextId = null;
        for (const [id, t] of timers) {
          if (t.next <= toMs && (!nextTimer || t.next < nextTimer.next)) {
            nextTimer = t;
            nextId = id;
          }
        }
        if (!nextTimer) break;
        now = nextTimer.next;
        if (nextTimer.repeat) nextTimer.next = now + nextTimer.ms;
        else timers.delete(nextId);
        nextTimer.cb();
        await drainMicro(30);
      }
      now = toMs;
      await drainMicro(30);
    },
  };
}

(async () => {
  // ---- 1. default OFF / kill-switch / prereq gates --------------------------
  {
    const env = makeEnv({ flagOff: true });
    env.run();
    await env.advance(3000);
    assert(env.window.__shellAW === undefined, "1: flag off -> no __shellAW");
    assert(env.xcalls.length === 0, "1: flag off -> zero prefetch requests");
  }
  {
    const env = makeEnv({
      store: { "jellyfin.shell.apiWarmDisabled": "1" },
    });
    env.run();
    await env.advance(3000);
    assert(env.window.__shellAW === undefined, "1b: kill-switch -> inert");
    assert(env.xcalls.length === 0, "1b: kill-switch -> zero requests");
  }
  {
    const env = makeEnv({ creds: null });
    env.run();
    await env.advance(3000);
    assert(env.window.__shellAW === undefined, "1c: no creds -> inert");
  }
  {
    const env = makeEnv({
      srv: "",
      creds: JSON.stringify({
        Servers: [{ Id: "s1", AccessToken: "tok", UserId: UID }],
      }),
    });
    env.run();
    await env.advance(3000);
    assert(env.window.__shellAW === undefined, "1d: no http base -> inert");
  }
  {
    // srv() empty falls back to the stored ManualAddress
    const env = makeEnv({ srv: "" });
    env.run();
    await env.advance(1000);
    const aw = env.window.__shellAW;
    assert(aw && aw.on === 1 && aw.started === 1, "1e: ManualAddress base ok");
    assert(
      env.xcalls.every((x) => x.url.indexOf("http://alt/") === 0),
      "1e: prefetches issued against the ManualAddress base",
    );
  }

  // ---- 2. prefetch shape: order, auth, bound, chain --------------------------
  {
    const env = makeEnv({});
    env.run();
    const aw = env.window.__shellAW;
    assert(aw && aw.on === 1 && aw.started === 1, "2: started");
    assert(aw.q === 39, "2: WS-4 deterministic list enqueued, q=" + aw.q);
    assert(
      env.xcalls.length === 8 && env.pendingX().length === 8,
      "2: bounded 8-wide while none settled",
    );
    assert(
      env.xcalls[0].url === "http://srv/JellyfinEnhanced/tag-cache/" + UID,
      "2: tag-cache is the FIRST prefetch (13 s lever)",
    );
    assert(
      env.xcalls[1].url === "http://srv/HomeScreen/Sections?UserId=" + UID,
      "2: Sections is the SECOND prefetch (unlocks the fan-out)",
    );
    assert(
      env.xcalls.every(
        (x) =>
          x.headers["X-Emby-Token"] === "tok" &&
          x.method === "GET" &&
          x.timeout === 30000,
      ),
      "2: every prefetch is an authed bounded GET",
    );
    await env.resolveAll();
    assert(
      aw.q === 43 && aw.f === 43 && aw.e === 0,
      "2: 39 static + 4 chained all fetched: " + JSON.stringify(aw),
    );
    const fan = env.xcalls
      .map((x) => x.url)
      .filter((u) => u.indexOf("/HomeScreen/Section/") !== -1);
    assert(
      fan.length === 4 &&
        fan.indexOf("http://srv/HomeScreen/Section/MyMedia?UserId=u1") !== -1 &&
        fan.indexOf(
          "http://srv/HomeScreen/Section/BecauseYouWatched?UserId=u1&AdditionalData=guid-1",
        ) !== -1 &&
        fan.indexOf(
          "http://srv/HomeScreen/Section/Genre?UserId=u1&AdditionalData=Thriller",
        ) !== -1,
      "2: fan-out mirrors the Sections response: " + JSON.stringify(fan),
    );
    const nu = fan.filter((u) => u.indexOf("/Section/NextUp?") !== -1)[0];
    assert(
      nu &&
        nu.indexOf("NextUpDateCutoff=1970-01-01T00%3A00%3A00") !== -1 &&
        nu.indexOf("EnableRewatching=false") !== -1,
      "2: NextUp fan-out carries cutoff + EnableRewatching: " + nu,
    );
    assert(
      fan.every((u) => u.indexOf("Bad") === -1),
      "2: hostile section name dropped",
    );
    assert(
      new Set(env.xcalls.map((x) => x.url)).size === env.xcalls.length,
      "2: one request per URL",
    );
    assert(
      aw.st === "done" && aw.ms >= 0,
      "2: st=done when drained: " + JSON.stringify(aw),
    );

    // ---- 3. intercept: fetch match + fuzz + alias origin + one-shot ---------
    const r1 = await env.window.fetch("http://srv/System/Configuration");
    assert(!r1.__net, "3: served from store, not network");
    assert(r1.status === 200 && (await r1.text()) === '{"ok":1}', "3: body");
    assert(env.netCalls.length === 0, "3: zero network calls so far");
    assert(aw.hits === 1, "3: hit counted");
    const r1b = await env.window.fetch("http://srv/System/Configuration");
    assert(
      r1b.__net === true && env.netCalls.length === 1 && aw.misses === 1,
      "3: one-shot -> second identical call passes through + miss",
    );
    const r2 = await env.window.fetch(
      "http://srv/DisplayPreferences/usersettings?client=emby&userId=" + UID,
    );
    assert(!r2.__net, "3: param order is canonicalized");
    const r3 = await env.window.fetch(
      "http://srv/JellyfinEnhanced/user-settings/u1/settings.json?_=9999",
    );
    assert(!r3.__net, "3: '_' cache-buster fuzz-dropped");
    const r4 = await env.window.fetch("http://alt/Plugins");
    assert(!r4.__net, "3: ManualAddress alias origin matches");
    const rPost = await env.window.fetch("http://srv/CustomTabs/Config", {
      method: "POST",
    });
    assert(rPost.__net === true, "3: POST never intercepted");
    const rMiss = await env.window.fetch("http://srv/Never/Prefetched");
    assert(rMiss.__net === true, "3: unknown URL passes through untouched");

    // ---- 4. intercept: XHR delivery + NextUpDateCutoff fuzz -----------------
    const x = new env.window.XMLHttpRequest();
    x.open(
      "GET",
      "http://srv/HomeScreen/Section/NextUp?UserId=u1&NextUpDateCutoff=2099-01-01T00%3A00%3A00.000Z&EnableRewatching=false",
    );
    let loads = 0;
    let rsc = 0;
    x.onload = function () {
      loads++;
    };
    x.onreadystatechange = function () {
      if (x.readyState === 4) rsc++;
    };
    x.send();
    assert(!x.sent, "4: matching XHR never reaches the network");
    await env.advance(env.timers.size ? 20000 : 20000);
    assert(
      x.readyState === 4 && x.status === 200 && rsc === 1 && loads === 1,
      "4: XHR delivered with events (rsc=" + rsc + ", loads=" + loads + ")",
    );
    assert(x.responseText === '{"ok":1}', "4: responseText served");
    assert(
      x.getResponseHeader("Content-Type") === "application/json",
      "4: content-type answered",
    );
    const hitsBefore = aw.hits;
    const xj = new env.window.XMLHttpRequest();
    xj.open(
      "GET",
      "http://srv/HomeScreen/Section/Genre?UserId=u1&AdditionalData=Thriller",
    );
    xj.responseType = "json";
    xj.send();
    await env.advance(21000);
    assert(
      xj.response && xj.response.ok === 1 && aw.hits === hitsBefore + 1,
      "4: responseType=json gets a parsed response",
    );

    // ---- 5. DH-handoff / gen-turnover survival ------------------------------
    const qBefore = aw.q;
    const xBefore = env.xcalls.length;
    env.swapDoc();
    env.window.__shellDH = { painted: 1, dismissed: 0 };
    env.run();
    await env.advance(25000);
    assert(
      env.window.__shellAW === aw && aw.q === qBefore,
      "5: re-run body never re-prefetches (one warm per window)",
    );
    assert(env.xcalls.length === xBefore, "5: no new prefetch XHRs");
    const r5 = await env.window.fetch("http://srv/HomeScreen/Meta");
    assert(!r5.__net, "5: intercept still serves after the swap");
  }

  // ---- 6. pending-attach: SPA parks on the in-flight prefetch ---------------
  {
    const env = makeEnv({});
    env.run();
    const aw = env.window.__shellAW;
    const tc = env.findX("/tag-cache/");
    assert(tc && tc.readyState !== 4, "6: tag-cache prefetch in flight");
    let served = null;
    const p = env.window
      .fetch("http://srv/JellyfinEnhanced/tag-cache/" + UID)
      .then((r) => {
        served = r;
      });
    await env.drainMicro();
    assert(served === null, "6: SPA parked on the pending prefetch");
    assert(aw.hits === 1, "6: pending-attach counts as a hit");
    tc.__respond(200, '{"tags":1}');
    await env.drainMicro();
    await p;
    assert(
      served && !served.__net && (await served.text()) === '{"tags":1}',
      "6: parked SPA fed by the prefetch response",
    );
    assert(env.netCalls.length === 0, "6: network untouched");

    // failed pending prefetch replays the SPA call on the network
    const sx = env.findX("/System/Info/Public");
    let served2 = null;
    const p2 = env.window.fetch("http://srv/System/Info/Public").then((r) => {
      served2 = r;
    });
    await env.drainMicro();
    sx.__respond(500, "boom");
    await env.drainMicro();
    await p2;
    assert(
      served2 && served2.__net === true && env.netCalls.length === 1,
      "6: errored prefetch -> SPA call replays on the network",
    );
    assert(aw.e >= 1, "6: prefetch error counted");
  }

  // ---- 7. expiry (60 s TTL) --------------------------------------------------
  {
    const env = makeEnv({});
    env.run();
    await env.resolveAll();
    const aw = env.window.__shellAW;
    await env.advance(120000);
    const r = await env.window.fetch("http://srv/System/Configuration");
    assert(
      r.__net === true && aw.misses >= 1,
      "7: expired entry passes through + miss",
    );
  }

  // ---- 8. auth-edge: token change flushes the store --------------------------
  {
    const env = makeEnv({});
    env.run();
    await env.resolveAll();
    const aw = env.window.__shellAW;
    env.store.jellyfin_credentials = JSON.stringify({
      Servers: [{ Id: "s1", AccessToken: "tok2", UserId: UID }],
    });
    const r = await env.window.fetch("http://srv/System/Configuration");
    assert(r.__net === true, "8: token change -> network");
    assert(aw.st === "auth", "8: st=auth recorded");
    const r2 = await env.window.fetch("http://srv/Plugins");
    assert(r2.__net === true, "8: store flushed for every key");
    assert(aw.hits === 0, "8: stale-user data never served");
  }

  // ---- 9. abort before delivery ----------------------------------------------
  {
    const env = makeEnv({});
    env.run();
    await env.resolveAll();
    const x = new env.window.XMLHttpRequest();
    x.open("GET", "http://srv/System/Configuration");
    let fired = 0;
    x.onreadystatechange = function () {
      if (x.readyState === 4) fired++;
    };
    x.send();
    x.abort();
    await env.advance(20000);
    assert(fired === 0 && x.readyState !== 4, "9: aborted XHR never delivered");
  }

  console.log("api-warm.test.cjs: all assertions passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
