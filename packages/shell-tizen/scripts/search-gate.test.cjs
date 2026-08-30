/*
 * JELA-758: search fan-out idle gate (+ the delta-poll replay window).
 *
 * Typing ONE six-character query on the search route cost 55-68 requests and
 * 0.6-1.6 MB on the JELA-112 virtual Tizen 5.0 rig (JELA-756 census, n=3,
 * warm primed profiles, 700 ms keystroke cadence) against a 311-320 request
 * whole warm boot. The cost is not the query the user typed — it is every
 * PREFIX on the way to it: upstream debounces well under a TV keystroke gap,
 * so each accepted prefix pays a five-request fan-out. Measured for "matrix":
 * searchTerm=m cost 1,386,089 B while matr/matri/matrix cost 89/89/90 B each.
 *
 * Extracts the SHIPPED instantHomeBody() and drives it through the same
 * stubbed window the other instantHomeBody tests use, pinning:
 *   - default OFF: with no flag the gate stands down entirely and a search
 *     GET reaches the network on the same tick it always did
 *   - flag ON: a search GET is HELD, not sent, and is released once no new
 *     term has arrived for searchGateMs
 *   - supersede: a request bearing a DIFFERENT term rejects every held entry
 *     for the older term with an AbortError (name checked — the app branches
 *     on it) and only the newest term's fan-out reaches the network
 *   - the whole JELA-756 scenario: six prefixes x a five-request fan-out
 *     collapses to ONE fan-out, and it is the fan-out for the typed word
 *   - scope: non-search GETs, POSTs and bodied requests pass through
 *     untouched, so a miss is exactly today's behaviour
 *   - both spellings are gated: upstream's `searchTerm` and the injected
 *     plugin's `SearchTerm`
 *   - the caller's own AbortSignal still settles a held entry, so upstream
 *     cancelling a superseded query never leaves a promise pending
 *   - the 0..5000 clamp, and that a runaway queue (> 64 held) fails OPEN
 *   - one install per WINDOW: a re-run body never double-wraps fetch
 *   - install ORDER: the gate wraps OUTSIDE the JELA-724/752 coalescer, so a
 *     stale prefix is dropped before it can occupy a coalescer slot
 *   - JELA-758 delta window: /JellyfinEnhanced/tag-cache/{u}?since=... is
 *     replayed for fetchCoalesceDeltaWindowMs (default 15 s) rather than the
 *     400 ms fcW, because the nine polls a typed word triggers are ~700 ms
 *     apart and carry a byte-identical `since=` cursor; and that
 *     fetchCoalesceWindowMs='0' still disables it
 *
 * Run: node scripts/search-gate.test.cjs
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
  const i = text.indexOf("{", start);
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    const c = text[j];
    if (c === '"' || c === "'" || c === "`") {
      j++;
      while (j < text.length && text[j] !== c) {
        if (text[j] === "\\") j++;
        j++;
      }
      continue;
    }
    if (c === "/" && j + 1 < text.length && text[j + 1] === "/") {
      j = text.indexOf("\n", j);
      if (j < 0) break;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, j + 1);
    }
  }
  throw new Error("unbalanced braces extracting " + name);
}

const body = new Function(
  extractFn("instantHomeBody") + "; return instantHomeBody();",
)();

const PP = "/PluginPages/User";
const CREDS = JSON.stringify({
  Servers: [{ Id: "s1", AccessToken: "tok", UserId: "u1" }],
});

function makeResponseStub() {
  // Minimal WHATWG Response: enough to prove a body is consumable exactly
  // once, which is the invariant the coalescer must not break.
  function Headers(init) {
    this._m = {};
    if (init)
      for (const k of Object.keys(init)) this._m[k.toLowerCase()] = init[k];
  }
  Headers.prototype.get = function (k) {
    const v = this._m[String(k).toLowerCase()];
    return v === undefined ? null : v;
  };
  Headers.prototype.forEach = function (fn) {
    for (const k of Object.keys(this._m)) fn(this._m[k], k, this);
  };
  function Response(bodyText, init) {
    init = init || {};
    this.status = "status" in init ? init.status : 200;
    this.statusText = init.statusText || "";
    this.ok = this.status >= 200 && this.status < 300;
    this.headers =
      init.headers instanceof Headers
        ? init.headers
        : new Headers(init.headers);
    this._body = bodyText;
    this._used = false;
  }
  Response.prototype.text = function () {
    if (this._used)
      return Promise.reject(new TypeError("body stream already read"));
    this._used = true;
    return Promise.resolve(this._body === null ? "" : String(this._body));
  };
  Response.prototype.json = function () {
    return this.text().then(JSON.parse);
  };
  return { Response, Headers };
}

function makeEnv(opts) {
  opts = opts || {};
  const { Response, Headers } = makeResponseStub();
  let now = 0;
  let nextTimerId = 1;
  const timers = new Map();
  const setIntervalStub = (cb, ms) => {
    const id = nextTimerId++;
    timers.set(id, { cb, ms, next: now + ms, repeat: true });
    return id;
  };
  const setTimeoutStub = (cb, ms) => {
    const id = nextTimerId++;
    timers.set(id, { cb, ms, next: now + ms, repeat: false });
    return id;
  };
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
    getElementById: () => null,
    querySelectorAll: () => [],
  };

  const window = {
    innerWidth: 1920,
    innerHeight: 1080,
    pageYOffset: 0,
    __shellT0: 0,
    addEventListener() {},
  };
  window.__shellPhase = function () {};
  // A stub faithful enough for the JELA-758 XHR gate: send() records the URL
  // on `xnet` exactly as a real one would put it on the wire, and
  // dispatchEvent routes to the onabort handler axios registers.
  const xnet = [];
  function FakeXHR() {
    this.readyState = 0;
    this.status = 0;
    this.responseText = "";
    this._url = "";
    this.onabort = null;
    this.aborted = 0;
  }
  FakeXHR.prototype.open = function (m, u) {
    this._m = m;
    this._url = u;
  };
  FakeXHR.prototype.setRequestHeader = function () {};
  FakeXHR.prototype.send = function () {
    xnet.push(this._url);
  };
  FakeXHR.prototype.abort = function () {};
  FakeXHR.prototype.dispatchEvent = function (ev) {
    if (ev && ev.type === "abort") {
      this.aborted++;
      if (typeof this.onabort === "function") this.onabort(ev);
    }
    return true;
  };
  window.XMLHttpRequest = FakeXHR;

  // ---- controllable "network" ----
  const net = [];
  window.fetch = function (u, o) {
    const call = { url: typeof u === "string" ? u : u && u.url, opts: o || {} };
    call.promise = new Promise((res, rej) => {
      call.resolve = res;
      call.reject = rej;
    });
    net.push(call);
    return call.promise;
  };
  const store = Object.assign(
    {
      jellyfin_credentials: CREDS,
      "jellyfin.shell.serverUrl": "http://srv",
    },
    opts.store || {},
  );
  const localStorage = {
    getItem: (k) =>
      Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null,
    setItem: (k, v) => {
      store[k] = String(v);
    },
    removeItem: (k) => {
      delete store[k];
    },
  };

  const env = {
    window,
    net,
    xnet,
    store,
    Response,
    Headers,
    // Serve the pending leader call with a JSON body and drain microtasks.
    serve(call, bodyText, init) {
      call.resolve(new Response(bodyText, init || {}));
      return env.drain();
    },
    drain() {
      // The coalescer chains up to four .then hops (fetch -> snapshot ->
      // release -> synthesize); a handful of macrotask turns settles them all.
      let p = Promise.resolve();
      for (let i = 0; i < 8; i++)
        p = p.then(() => new Promise((r) => setImmediate(r)));
      return p;
    },
    // JELA-752: fire every one-shot timer due within `ms`, so the replay
    // window's EXPIRY is asserted rather than waited on.
    advance(ms) {
      now += ms;
      for (const [id, t] of Array.from(timers)) {
        if (!t.repeat && t.next <= now) {
          timers.delete(id);
          t.cb();
        }
      }
      return env.drain();
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
        "Response",
        "Event",
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
        opts.noResponse ? undefined : Response,
        function Ev(type) {
          this.type = type;
        },
      );
      return env;
    },
  };
  return env;
}

// ---- static contract checks ------------------------------------------------
assert(body.indexOf("jellyfin.shell.searchGate") !== -1, "gate flag present");
assert(
  body.indexOf("jellyfin.shell.searchGateMs") !== -1,
  "gate window key present",
);
assert(
  body.indexOf("jellyfin.shell.fetchCoalesceDeltaWindowMs") !== -1,
  "delta window key present",
);
assert(body.indexOf("</script") === -1, "no </script literal");
assert(body.indexOf("=>") === -1, "body must be ES5 (no arrow functions)");
assert(body.indexOf("`") === -1, "body must be ES5 (no template literals)");
// The gate must install AFTER the coalescer so it wraps OUTSIDE it: a stale
// prefix has to be dropped before it can take a coalescer slot.
assert(
  body.indexOf('flg("jellyfin.shell.searchGate")') >
    body.indexOf("jellyfin.shell.fetchCoalesceDisabled"),
  "gate installs after (outside) the JELA-724/752 coalescer",
);
assert(
  body.indexOf("jellyfin.shell.searchGatePaths") !== -1,
  "path allowlist is field-tunable",
);
// The fan-out is axios/XHR, not fetch — a fetch-only gate would be a null on
// every request that costs bytes.
assert(
  body.indexOf("SPX.send=function") !== -1,
  "the gate hooks XMLHttpRequest.send, not only fetch",
);

const U = "http://srv/Items?userId=u1&limit=800&recursive=true&searchTerm=";
const PAYLOAD = JSON.stringify({ Items: [], TotalRecordCount: 0 });
const ON = { "jellyfin.shell.searchGate": "1" };

// One accepted prefix costs five requests upstream, and they are NOT all on
// one transport: an in-page probe over a typed word caught the limit=800
// sweep, both limit=100 reads, /Persons and /Artists on axios/XHR (20/20),
// and only the injected plugin's /Users/{u}/Items on fetch.
function xhrGet(win, url) {
  const x = new win.XMLHttpRequest();
  x.open("GET", url);
  x.onabort = function () {};
  x.send(null);
  return x;
}

function fanOut(win, term) {
  const xs = [
    xhrGet(win, U + term),
    xhrGet(
      win,
      "http://srv/Items?limit=100&searchTerm=" + term + "&mediaTypes=Video",
    ),
    xhrGet(
      win,
      "http://srv/Items?limit=100&searchTerm=" +
        term +
        "&includeItemTypes=LiveTvProgram",
    ),
    xhrGet(win, "http://srv/Persons?limit=100&searchTerm=" + term),
    xhrGet(win, "http://srv/Artists?limit=100&searchTerm=" + term),
  ];
  // The plugin's fetch-transport call, same user query, same queue.
  const f = win.fetch(
    "http://srv/Users/u1/Items?SearchTerm=" + term + "&Limit=16",
  );
  // A superseded prefix rejects by design; swallow it so the harness does not
  // trip on an unhandled rejection.
  f.catch(function () {});
  return { xs, f };
}

let failures = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(
      () => console.log("ok   - " + name),
      (e) => {
        failures++;
        console.log("FAIL - " + name + ": " + (e && e.message));
      },
    );
}

async function main() {
  // ---- 1. default OFF: no flag, no gate ------------------------------------
  await check(
    "default OFF: a search GET reaches the network unheld",
    async () => {
      const env = makeEnv().run();
      assert.strictEqual(env.window.__shellSG, undefined, "gate not installed");
      env.window.fetch(U + "matrix");
      assert.strictEqual(env.net.length, 1, "fetch went straight out");
      xhrGet(env.window, U + "matrix");
      assert.strictEqual(env.xnet.length, 1, "and so did the XHR");
    },
  );

  // ---- 2. flag ON: held, then released, on BOTH transports -----------------
  await check(
    "flag ON: the fan-out is HELD on both transports, then released",
    async () => {
      const env = makeEnv({ store: ON }).run();
      assert.strictEqual(
        env.window.__shellSG.ms,
        800,
        "default window is 800 ms",
      );
      fanOut(env.window, "matrix");
      assert.strictEqual(env.xnet.length, 0, "no XHR on the wire while held");
      assert.strictEqual(env.net.length, 0, "no fetch on the wire while held");
      assert.strictEqual(env.window.__shellSG.xn, 5, "five XHRs seen");
      assert.strictEqual(env.window.__shellSG.fn, 1, "one fetch seen");
      await env.advance(800);
      assert.strictEqual(env.xnet.length, 5, "the XHR fan-out released");
      assert.strictEqual(env.net.length, 1, "and the fetch call with it");
      assert.strictEqual(env.window.__shellSG.rel, 6, "counted as released");
      assert.strictEqual(env.window.__shellSG.sup, 0, "nothing superseded");
    },
  );

  // ---- 3. a newer term supersedes the older one ----------------------------
  await check(
    "a newer term aborts the held prefix on both transports",
    async () => {
      const env = makeEnv({ store: ON }).run();
      const stale = fanOut(env.window, "ma");
      assert.strictEqual(env.xnet.length + env.net.length, 0, "prefix held");
      fanOut(env.window, "matrix");
      // XHR: settled by its own abort event, which is the path axios's
      // request.onabort already handles.
      assert.strictEqual(
        stale.xs[0].aborted,
        1,
        "the stale XHR got an abort event",
      );
      let name = null;
      await stale.f.then(
        () => {},
        (e) => {
          name = e && e.name;
        },
      );
      assert.strictEqual(
        name,
        "AbortError",
        "and the stale fetch rejected as an abort",
      );
      assert.strictEqual(env.window.__shellSG.sup, 6, "all six superseded");
      assert.strictEqual(
        env.xnet.length + env.net.length,
        0,
        "the stale prefix never went out",
      );
      await env.advance(800);
      assert.strictEqual(env.xnet.length, 5, "only the newest term is issued");
      assert(
        env.xnet.every((u) => u.indexOf("searchTerm=matrix") !== -1),
        "and every released URL carries the typed word",
      );
    },
  );

  // ---- 4. the whole JELA-756 scenario --------------------------------------
  await check("six typed prefixes cost ONE fan-out, not six", async () => {
    const env = makeEnv({ store: ON }).run();
    const word = "matrix";
    for (let i = 1; i <= word.length; i++) {
      fanOut(env.window, word.slice(0, i));
      // A TV keystroke gap is longer than the window, which is exactly the
      // case that made the shipped build pay a fan-out per prefix; the gate
      // must still collapse it, because each new term restarts the timer.
      assert.strictEqual(
        env.xnet.length + env.net.length,
        0,
        "nothing issued mid-word",
      );
    }
    await env.advance(800);
    assert.strictEqual(
      env.xnet.length + env.net.length,
      6,
      "one fan-out for the whole word",
    );
    assert.strictEqual(
      env.xnet.filter((u) => u.indexOf("limit=800") !== -1).length,
      1,
      "AC2: exactly one limit=800 sweep per typed word",
    );
    assert.strictEqual(
      env.window.__shellSG.sup,
      30,
      "the five stale prefixes were dropped",
    );
  });

  // ---- 4b. the app aborting a held XHR settles it --------------------------
  await check(
    "the app aborting a HELD XHR drops it and settles the caller",
    async () => {
      const env = makeEnv({ store: ON }).run();
      const x = xhrGet(env.window, U + "matrix");
      assert.strictEqual(env.xnet.length, 0, "held");
      x.abort();
      assert.strictEqual(x.aborted, 1, "the caller saw its abort event");
      assert.strictEqual(env.window.__shellSG.ab, 1, "counted as an abort");
      await env.advance(800);
      assert.strictEqual(
        env.xnet.length,
        0,
        "and it never reached the network",
      );
    },
  );

  // ---- 4c. path scope: /Genres is NOT a user query -------------------------
  await check(
    "JELA-738's /Genres?SearchTerm= bulk read is never gated",
    async () => {
      const env = makeEnv({ store: ON }).run();
      // Eight fixed-term lookups issued together. Under a term-only rule each
      // would supersede the last and only "Horror" would survive.
      const genres = ["Action", "Comedy", "Drama", "Horror"];
      genres.forEach((g) =>
        xhrGet(env.window, "http://srv/Genres?SearchTerm=" + g + "&Limit=12"),
      );
      assert.strictEqual(
        env.xnet.length,
        4,
        "all four went straight to the network",
      );
      assert.strictEqual(
        env.window.__shellSG.n,
        0,
        "none of them counted as a search",
      );
      // ...and a genre read must not disturb a search that IS in flight.
      fanOut(env.window, "matrix");
      xhrGet(env.window, "http://srv/Genres?SearchTerm=Thriller&Limit=12");
      await env.advance(800);
      assert.strictEqual(
        env.xnet.filter((u) => u.indexOf("searchTerm=matrix") !== -1).length,
        5,
        "the search fan-out still released intact",
      );
    },
  );

  // ---- 5. scope: everything else passes through ----------------------------
  await check(
    "non-search GETs, POSTs and bodied requests pass through",
    async () => {
      const env = makeEnv({ store: ON }).run();
      env.window.fetch("http://srv/Users/u1/Items/abc");
      assert.strictEqual(env.net.length, 1, "a plain GET is untouched");
      env.window.fetch(U + "matrix", { method: "POST" });
      assert.strictEqual(env.net.length, 2, "a POST is never held");
      env.window.fetch(U + "matrix", { body: "x" });
      assert.strictEqual(env.net.length, 3, "a bodied request is never held");
      assert.strictEqual(
        env.window.__shellSG.n,
        0,
        "none of them counted as search",
      );
      xhrGet(env.window, "http://srv/Users/u1/Items/abc");
      assert.strictEqual(env.xnet.length, 1, "a plain XHR GET is untouched");
    },
  );

  // ---- 6. both spellings ----------------------------------------------------
  await check(
    "the injected plugin's capital SearchTerm is gated too",
    async () => {
      const env = makeEnv({ store: ON }).run();
      env.window
        .fetch("http://srv/Users/u1/Items?SearchTerm=matrix&Limit=16")
        .catch(() => {});
      assert.strictEqual(env.net.length, 0, "held");
      assert.strictEqual(
        env.window.__shellSG.n,
        1,
        "counted as a search request",
      );
      await env.advance(800);
      assert.strictEqual(env.net.length, 1, "released");
    },
  );

  // ---- 7. the caller's own signal still settles a held entry ---------------
  await check(
    "upstream aborting a held query settles its promise",
    async () => {
      const env = makeEnv({ store: ON }).run();
      const listeners = [];
      const signal = {
        aborted: false,
        addEventListener(_ev, fn) {
          listeners.push(fn);
        },
      };
      const p = env.window.fetch(U + "matrix", { signal });
      let name = null;
      p.then(
        () => {},
        (e) => {
          name = e && e.name;
        },
      );
      assert.strictEqual(env.net.length, 0, "held");
      listeners.forEach((fn) => fn());
      await env.drain();
      assert.strictEqual(name, "AbortError", "the held promise rejected");
      assert.strictEqual(env.window.__shellSG.ab, 1, "counted as an abort");
      await env.advance(800);
      assert.strictEqual(env.net.length, 0, "and it never reached the network");
    },
  );

  await check(
    "a signal already aborted is rejected without being queued",
    async () => {
      const env = makeEnv({ store: ON }).run();
      const p = env.window.fetch(U + "matrix", { signal: { aborted: true } });
      let name = null;
      await p.then(
        () => {},
        (e) => {
          name = e && e.name;
        },
      );
      assert.strictEqual(name, "AbortError", "rejected up front");
      assert.strictEqual(env.net.length, 0, "nothing issued");
    },
  );

  // ---- 8. clamp -------------------------------------------------------------
  await check(
    "searchGateMs is clamped: out-of-range and junk keep the default",
    async () => {
      const mk = (v) =>
        makeEnv({
          store: {
            "jellyfin.shell.searchGate": "1",
            "jellyfin.shell.searchGateMs": v,
          },
        }).run().window.__shellSG.ms;
      assert.strictEqual(mk("1500"), 1500, "in range is honoured");
      assert.strictEqual(mk("0"), 0, "0 is a legal value");
      assert.strictEqual(
        mk("5001"),
        800,
        "above the ceiling keeps the default",
      );
      assert.strictEqual(mk("-1"), 800, "negative keeps the default");
      assert.strictEqual(mk("soon"), 800, "junk keeps the default");
    },
  );

  // ---- 9. a runaway queue fails OPEN ---------------------------------------
  await check(
    "a queue deeper than 64 falls through to the network",
    async () => {
      const env = makeEnv({ store: ON }).run();
      for (let i = 0; i < 64; i++) xhrGet(env.window, U + "matrix&i=" + i);
      assert.strictEqual(env.xnet.length, 0, "the first 64 are held");
      xhrGet(env.window, U + "matrix&i=64");
      assert.strictEqual(env.xnet.length, 1, "the 65th goes to the network");
      assert.strictEqual(
        env.window.__shellSG.drop,
        1,
        "counted as a fall-through",
      );
    },
  );

  // ---- 10. one install per window ------------------------------------------
  await check("a re-run body never double-wraps fetch", async () => {
    const env = makeEnv({ store: ON }).run();
    const first = env.window.fetch;
    env.run();
    assert.strictEqual(env.window.fetch, first, "fetch was not re-wrapped");
    assert.strictEqual(
      env.window.__shellSG.on,
      1,
      "the original gate is still live",
    );
  });

  // ---- 11. JELA-758 delta window on the tag-cache poll ---------------------
  const TC = "http://srv/JellyfinEnhanced/tag-cache/u1?since=1787634789447";
  await check(
    "the tag-cache delta poll is replayed for the long window",
    async () => {
      const env = makeEnv().run();
      assert.strictEqual(
        env.window.__shellFC.w,
        400,
        "fcW is still the 400 ms default",
      );
      const a = env.window.fetch(TC);
      await env.serve(env.net[0], PAYLOAD);
      await a;
      // 700 ms is a TV keystroke gap: past fcW, so without the delta window this
      // would re-fetch — which is exactly the x9 the JELA-756 census measured.
      await env.advance(700);
      env.window.fetch(TC);
      assert.strictEqual(env.net.length, 1, "replayed, not re-fetched");
      await env.advance(14000);
      env.window.fetch(TC);
      assert.strictEqual(env.net.length, 1, "still inside the 15 s window");
      await env.advance(1000);
      env.window.fetch(TC);
      assert.strictEqual(
        env.net.length,
        2,
        "and re-fetches once the window expires",
      );
    },
  );

  await check("a non-delta path keeps the short 400 ms window", async () => {
    const env = makeEnv().run();
    const a = env.window.fetch("http://srv" + PP);
    await env.serve(env.net[0], PAYLOAD);
    await a;
    await env.advance(700);
    env.window.fetch("http://srv" + PP);
    assert.strictEqual(
      env.net.length,
      2,
      "/PluginPages/User re-fetched after 400 ms",
    );
  });

  await check(
    "fetchCoalesceWindowMs='0' disables the delta window too",
    async () => {
      const env = makeEnv({
        store: { "jellyfin.shell.fetchCoalesceWindowMs": "0" },
      }).run();
      const a = env.window.fetch(TC);
      await env.serve(env.net[0], PAYLOAD);
      await a;
      env.window.fetch(TC);
      assert.strictEqual(
        env.net.length,
        2,
        "JELA-724 in-flight-only behaviour restored",
      );
    },
  );

  await check("the delta window is clamped and field-tunable", async () => {
    const mk = (v) =>
      makeEnv({
        store: { "jellyfin.shell.fetchCoalesceDeltaWindowMs": v },
      }).run();
    const env = mk("300001");
    const a = env.window.fetch(TC);
    await env.serve(env.net[0], PAYLOAD);
    await a;
    await env.advance(15001);
    env.window.fetch(TC);
    assert.strictEqual(env.net.length, 2, "out-of-range kept the 15 s default");
  });

  // ---- 12. engines without Promise stand the gate down ---------------------
  await check(
    "the gate needs Promise; the coalescer is unaffected",
    async () => {
      assert(
        body.indexOf('typeof Promise==="function"') !== -1,
        "install is guarded on Promise",
      );
    },
  );

  console.log(
    "\nsearch-gate: " + (failures ? failures + " FAILED" : "all checks passed"),
  );
  process.exit(failures ? 1 : 0);
}

main();
