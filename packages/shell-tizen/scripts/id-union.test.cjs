/*
 * JELA-830: id-union coalescer for the boot Ids= hydration burst.
 *
 * The JELA-829 census found ELEVEN boot GETs carrying Ids=, asking for 339
 * item ids of which only 144 are distinct — three of them landing inside 62 ms
 * of each other with pairwise 100% id overlap, differing only in which Fields
 * they want. JELA-724/752's fetchCoalesce already allowlists /Users/*\/Items
 * and misses every one, because it keys on the byte-identical URL.
 *
 * Extracts the SHIPPED instantHomeBody() and drives it through the same
 * stubbed window the other instantHomeBody tests use, against a FAKE ITEM POOL
 * that answers Ids= queries the way the live server was probed to, pinning:
 *   - opt-in: with jellyfin.shell.idUnion absent the shim never installs and
 *     every request is on the wire (this is AC4's kill switch and the A/B
 *     control arm in one); windowMs='0' stands the batcher down too
 *   - N overlapping GETs to one route with different Fields -> ONE network
 *     request carrying the UNION of the ids, and every waiter gets EXACTLY
 *     the items it asked for: no foreign id, none short an id, its own
 *     TotalRecordCount, and its OWN independently-readable Response (AC2)
 *   - the union's Limit is >= the union's id count, or the server truncates
 *     somebody's items
 *   - Fields UNIONS; EnableImages/EnableUserData OR to true; ImageTypeLimit
 *     takes the max; and all four RESTRICTIVE params are DROPPED unless every
 *     member supplied one, because their absence means the permissive server
 *     default and a member that omits one must not be handed a SUBSET
 *   - never across base paths: /Items and /Users/{u}/Items never share a
 *     batch, and the anchored matcher cannot be spoofed by a suffix
 *   - opt-outs: Limit BELOW the caller's own id count (the server truncates an
 *     unordered result — probed), StartIndex != 0, an explicit
 *     EnableTotalRecordCount=true, a body, an AbortSignal, a Request object,
 *     a non-GET, a conditional/Range header, a differing header set
 *   - a batch that closes with ONE waiter re-issues that caller's ORIGINAL
 *     url untouched — the no-duplicate case is byte-identical to baseline
 *   - failure is always a downgrade to baseline, never a wrong body: a
 *     non-2xx, an unparseable body, a body with no Items array and a rejected
 *     merged fetch each replay EVERY waiter on the real network
 *   - a mutation over fetch OR over XHR dispatches pending batches at once,
 *     so a queued read cannot be overtaken by the write it preceded
 *   - the merged URL is capped by LENGTH, and exceeding it splits the batch
 *     rather than dropping a waiter
 *   - one install per WINDOW, and engines without Response stand it down
 *   - layering: idUnion installs AFTER fetchCoalesce and BEFORE api-warm
 *
 * Run: node scripts/id-union.test.cjs
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

const CREDS = JSON.stringify({
  Servers: [{ Id: "s1", AccessToken: "tok", UserId: "u1" }],
});
const BASE = "http://srv/Users/u1/Items";

// ---- static contract checks ------------------------------------------------
assert(
  body.indexOf("jellyfin.shell.idUnion") !== -1,
  "opt-in flag key present",
);
assert(
  body.indexOf("jellyfin.shell.idUnionWindowMs") !== -1,
  "window override key present",
);
assert(body.indexOf("</script") === -1, "no </script literal");
assert(body.indexOf("=>") === -1, "body must be ES5 (no arrow functions)");
assert(body.indexOf("`") === -1, "body must be ES5 (no template literals)");
// JELA-830 must NOT share JELA-724/752's kill switch: a patch that can only be
// disabled together with something flippable independently is not flag-dark.
assert(
  body.indexOf("jellyfin.shell.fetchCoalesceDisabled") <
    body.indexOf("jellyfin.shell.idUnion"),
  "idUnion carries its own flag, installed after fetchCoalesce",
);
// Layering: apiWarm -> playReplay -> idUnion -> fetchCoalesce -> native.
assert(
  body.indexOf("__shellFC") < body.indexOf("__shellIU"),
  "idUnion installs AFTER the coalescer (so it wraps it)",
);
assert(
  body.indexOf("__shellIU") < body.indexOf("__shellAW"),
  "idUnion installs BEFORE api-warm (warm store keeps first refusal)",
);

// ---- environment -----------------------------------------------------------
function makeResponseStub() {
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

// Fake item pool. Ids "i0".."i63" exist; anything else is a ghost the server
// simply does not return, exactly as the live probe behaved.
const POOL = {};
for (let i = 0; i < 64; i++) POOL["i" + i] = { Id: "i" + i, Name: "n" + i };
// 32-hex ids, the real shape, for the URL-length cap test.
const LONG = (i) => "abcdef0123456789abcdef01" + String(1e7 + i).slice(1);
for (let i = 0; i < 64; i++) POOL[LONG(i)] = { Id: LONG(i), Name: "L" + i };

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
  function FakeXHR() {
    this.readyState = 0;
    this.status = 0;
    this.responseText = "";
  }
  FakeXHR.prototype.open = function () {};
  FakeXHR.prototype.setRequestHeader = function () {};
  FakeXHR.prototype.send = function () {};
  window.XMLHttpRequest = FakeXHR;

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
      "jellyfin.shell.idUnion": "1",
    },
    opts.store || {},
  );
  if (opts.noFlag) delete store["jellyfin.shell.idUnion"];
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
    store,
    Response,
    Headers,
    // Answer a merged request out of the fake pool, the way the live server
    // was probed to: unknown ids are simply absent, TotalRecordCount is the
    // number of FOUND ids (pre-Limit), and Limit truncates.
    servePool(call, init, pool) {
      pool = pool || POOL;
      const q = call.url.slice(call.url.indexOf("?") + 1);
      const sp = {};
      for (const part of q.split("&")) {
        const i = part.indexOf("=");
        sp[part.slice(0, i).toLowerCase()] = decodeURIComponent(
          part.slice(i + 1),
        );
      }
      const ids = (sp.ids || "").split(",").filter(Boolean);
      const found = ids.filter((i) => pool[i]).map((i) => pool[i]);
      const lim = sp.limit === undefined ? Infinity : parseInt(sp.limit, 10);
      return env.serve(
        call,
        JSON.stringify({
          Items: found.slice(0, lim),
          TotalRecordCount: found.length,
          StartIndex: 0,
        }),
        init || {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json" },
        },
      );
    },
    serve(call, bodyText, init) {
      call.resolve(new Response(bodyText, init || {}));
      return env.drain();
    },
    drain() {
      let p = Promise.resolve();
      for (let i = 0; i < 12; i++)
        p = p.then(() => new Promise((r) => setImmediate(r)));
      return p;
    },
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
      );
      return env;
    },
  };
  return env;
}

function qs(url) {
  const out = {};
  const q = url.slice(url.indexOf("?") + 1);
  for (const part of q.split("&")) {
    const i = part.indexOf("=");
    out[part.slice(0, i)] = decodeURIComponent(part.slice(i + 1));
  }
  return out;
}
function idsOf(url) {
  return (qs(url).Ids || "").split(",").filter(Boolean);
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

const WIN = makeEnv().run().window.__shellIU.w;
assert(WIN > 0, "default window is positive");

async function main() {
  // ---- 1. AC4: opt-in. Key absent -> shim never installs, all on the wire --
  await check("flag absent: shim inert, every request on the wire", async () => {
    const env = makeEnv({ noFlag: true }).run();
    assert.strictEqual(env.window.__shellIU, undefined, "no __shellIU");
    for (let i = 0; i < 3; i++)
      env.window.fetch(BASE + "?Ids=i" + i + "&Fields=F" + i);
    assert.strictEqual(env.net.length, 3, "3 requests, unbatched");
    assert.strictEqual(env.net[0].url, BASE + "?Ids=i0&Fields=F0", "verbatim");
  });

  await check("windowMs='0' stands the batcher down", async () => {
    const env = makeEnv({
      store: { "jellyfin.shell.idUnionWindowMs": "0" },
    }).run();
    assert.strictEqual(env.window.__shellIU.w, 0, "window read as 0");
    for (let i = 0; i < 3; i++) env.window.fetch(BASE + "?Ids=i" + i);
    assert.strictEqual(env.net.length, 3, "no batching");
  });

  // ---- 2. AC2: the union, and an exact slice per waiter -------------------
  await check(
    "3 overlapping GETs -> 1 merged request; every waiter gets exactly its ids",
    async () => {
      const env = makeEnv().run();
      const A = ["i1", "i2", "i3"];
      const B = ["i2", "i3", "i4"];
      const C = ["i9"];
      const ps = [
        env.window.fetch(BASE + "?Ids=" + A.join(",") + "&Fields=Genres"),
        env.window.fetch(BASE + "?Ids=" + B.join(",") + "&Fields=RunTimeTicks"),
        env.window.fetch(BASE + "?Ids=" + C.join(",")),
      ];
      assert.strictEqual(env.net.length, 0, "nothing on the wire inside window");
      await env.advance(WIN);
      assert.strictEqual(env.net.length, 1, "ONE merged request");

      const merged = env.net[0].url;
      const mids = idsOf(merged);
      assert.deepStrictEqual(
        mids.slice().sort(),
        ["i1", "i2", "i3", "i4", "i9"],
        "merged ids are the UNION, de-duplicated",
      );
      assert(
        parseInt(qs(merged).Limit, 10) >= mids.length,
        "union Limit >= union id count",
      );
      assert.deepStrictEqual(
        qs(merged).Fields.split(",").sort(),
        ["Genres", "RunTimeTicks"],
        "Fields unions",
      );

      await env.servePool(env.net[0]);
      const bodies = await Promise.all(
        (await Promise.all(ps)).map((r) => r.json()),
      );
      const want = [A, B, C];
      for (let i = 0; i < 3; i++) {
        const got = bodies[i].Items.map((x) => x.Id);
        assert.deepStrictEqual(got.slice().sort(), want[i].slice().sort(),
          "waiter " + i + " got exactly its ids");
        assert.strictEqual(bodies[i].TotalRecordCount, want[i].length,
          "waiter " + i + " TotalRecordCount is its own slice length");
        assert.strictEqual(bodies[i].StartIndex, 0);
      }
      const c = env.window.__shellIU;
      assert.strictEqual(c.seen, 3);
      assert.strictEqual(c.net, 1);
      assert.strictEqual(c.join, 2);
      assert.strictEqual(c.ids, 7, "7 ids requested across the batch");
      assert.strictEqual(c.uids, 5, "5 distinct ids issued");
    },
  );

  await check("a waiter is never short an id the merged response carries",
    async () => {
      const env = makeEnv().run();
      // "zz" does not exist in the pool: the waiter must get its two real
      // items and NOT an invented third.
      const p1 = env.window.fetch(BASE + "?Ids=i5,zz,i6&Fields=A");
      const p2 = env.window.fetch(BASE + "?Ids=i7&Fields=B");
      await env.advance(WIN);
      await env.servePool(env.net[0]);
      const b1 = await (await p1).json();
      const b2 = await (await p2).json();
      assert.deepStrictEqual(b1.Items.map((x) => x.Id), ["i5", "i6"]);
      assert.strictEqual(b1.TotalRecordCount, 2, "ghost id is not counted");
      assert.deepStrictEqual(b2.Items.map((x) => x.Id), ["i7"],
        "no foreign id leaks into the other waiter");
    });

  await check("each waiter gets its OWN independently-readable body", async () => {
    const env = makeEnv().run();
    const ps = [
      env.window.fetch(BASE + "?Ids=i1&Fields=A"),
      env.window.fetch(BASE + "?Ids=i1&Fields=B"),
    ];
    await env.advance(WIN);
    await env.servePool(env.net[0]);
    const rs = await Promise.all(ps);
    assert(rs[0] !== rs[1], "distinct Response objects");
    await rs[0].text();
    const t = await rs[1].text();
    assert(t.indexOf("i1") !== -1, "second body still readable after the first");
  });

  // ---- 3. restrictive params: absence means the permissive default -------
  await check(
    "EnableImages/EnableUserData OR to true; ImageTypeLimit takes the max",
    async () => {
      const env = makeEnv().run();
      env.window.fetch(
        BASE + "?Ids=i1&EnableImages=false&EnableUserData=false&ImageTypeLimit=1",
      );
      env.window.fetch(
        BASE + "?Ids=i2&EnableImages=true&EnableUserData=true&ImageTypeLimit=3",
      );
      await env.advance(WIN);
      const q = qs(env.net[0].url);
      assert.strictEqual(q.EnableImages, "true");
      assert.strictEqual(q.EnableUserData, "true");
      assert.strictEqual(q.ImageTypeLimit, "3");
    },
  );

  await check(
    "a restrictive param one member OMITS is DROPPED, not unioned",
    async () => {
      const env = makeEnv().run();
      // The second caller omits EnableUserData / EnableImageTypes entirely,
      // which on the server means "give me all of it". Carrying the first
      // caller's restriction into the union would hand it a SUBSET.
      env.window.fetch(
        BASE + "?Ids=i1&EnableUserData=false&EnableImageTypes=Primary&ImageTypeLimit=1",
      );
      env.window.fetch(BASE + "?Ids=i2");
      await env.advance(WIN);
      const q = qs(env.net[0].url);
      assert(!("EnableUserData" in q), "EnableUserData dropped");
      assert(!("EnableImageTypes" in q), "EnableImageTypes dropped");
      assert(!("ImageTypeLimit" in q), "ImageTypeLimit dropped");
    },
  );

  await check("Fields is ADDITIVE: it survives a member that omits it", async () => {
    const env = makeEnv().run();
    env.window.fetch(BASE + "?Ids=i1&Fields=Genres");
    env.window.fetch(BASE + "?Ids=i2");
    await env.advance(WIN);
    assert.strictEqual(qs(env.net[0].url).Fields, "Genres");
  });

  // ---- 4. never across base paths ---------------------------------------
  await check("/Items and /Users/{u}/Items never share a batch", async () => {
    const env = makeEnv().run();
    env.window.fetch("http://srv/Items?Ids=i1&Fields=A");
    env.window.fetch("http://srv/Users/u1/Items?Ids=i2&Fields=A");
    await env.advance(WIN);
    assert.strictEqual(env.net.length, 2, "two routes, two requests");
    // Each closed with one waiter, so each carries its ORIGINAL url verbatim.
    const urls = env.net.map((c) => c.url).sort();
    assert.deepStrictEqual(urls, [
      "http://srv/Items?Ids=i1&Fields=A",
      "http://srv/Users/u1/Items?Ids=i2&Fields=A",
    ]);
  });

  await check("the anchored matcher is not a suffix test", async () => {
    const env = makeEnv().run();
    // "/Library/Items" ends with "/Items" but is not an allowlisted route;
    // a suffix matcher would swallow it.
    env.window.fetch("http://srv/Library/Items?Ids=i1");
    env.window.fetch("http://srv/Library/Items?Ids=i2");
    assert.strictEqual(env.net.length, 2, "untouched, straight to the wire");
  });

  // ---- 5. opt-outs -------------------------------------------------------
  // Each case uses two DISTINCT urls on purpose: two byte-identical GETs would
  // be joined by the JELA-724/752 coalescer underneath, which would mask a
  // pass-through and make this assertion meaningless.
  const optOuts = [
    ["Limit below the caller's own id count",
      BASE + "?Ids=i1,i2,i3&Limit=2", BASE + "?Ids=i4,i5,i6&Limit=2"],
    ["StartIndex != 0",
      BASE + "?Ids=i1&StartIndex=20", BASE + "?Ids=i2&StartIndex=20"],
    ["explicit EnableTotalRecordCount=true",
      BASE + "?Ids=i1&EnableTotalRecordCount=true",
      BASE + "?Ids=i2&EnableTotalRecordCount=true"],
    ["no Ids param at all", BASE + "?Limit=5&Fields=A", BASE + "?Limit=6&Fields=A"],
    ["empty Ids", BASE + "?Ids=&Limit=5", BASE + "?Ids=&Limit=6"],
    ["no query string", "http://srv/Users/u1/Items", "http://srv/Users/u2/Items"],
  ];
  for (const [label, u1, u2] of optOuts)
    await check("opt-out: " + label, async () => {
      const env = makeEnv().run();
      env.window.fetch(u1);
      env.window.fetch(u2);
      assert.strictEqual(env.net.length, 2, "both went straight to the wire");
      assert.strictEqual(env.net[0].url, u1, "url reaches the network verbatim");
    });

  await check("opt-out: body, AbortSignal, Request object, non-GET", async () => {
    const env = makeEnv().run();
    env.window.fetch(BASE + "?Ids=i1", { body: "x" });
    env.window.fetch(BASE + "?Ids=i2", { signal: {} });
    env.window.fetch({ url: BASE + "?Ids=i3" });
    env.window.fetch(BASE + "?Ids=i4", { method: "POST" });
    assert.strictEqual(env.net.length, 4, "all four reached the network");
  });

  await check("opt-out: a conditional/Range header", async () => {
    const env = makeEnv().run();
    const h = { "If-None-Match": "W/1" };
    env.window.fetch(BASE + "?Ids=i1", { headers: h });
    env.window.fetch(BASE + "?Ids=i2", { headers: h });
    // (distinct Ids, so the coalescer below cannot join them either)
    assert.strictEqual(env.net.length, 2, "never batched");
  });

  await check("differing header sets do not share a batch", async () => {
    const env = makeEnv().run();
    env.window.fetch(BASE + "?Ids=i1", { headers: { "X-Emby-Token": "a" } });
    env.window.fetch(BASE + "?Ids=i2", { headers: { "X-Emby-Token": "b" } });
    await env.advance(WIN);
    assert.strictEqual(env.net.length, 2, "two batches, one per header set");
  });

  await check("an identical header set DOES share, and is carried through",
    async () => {
      const env = makeEnv().run();
      const h = { "X-Emby-Token": "tok" };
      env.window.fetch(BASE + "?Ids=i1&Fields=A", { headers: h });
      env.window.fetch(BASE + "?Ids=i2&Fields=B", { headers: h });
      await env.advance(WIN);
      assert.strictEqual(env.net.length, 1, "one merged request");
      assert.strictEqual(
        env.net[0].opts.headers["X-Emby-Token"],
        "tok",
        "the merged fetch keeps the callers' auth header",
      );
    });

  // ---- 6. a lone waiter is byte-identical to baseline --------------------
  await check("a batch of ONE re-issues the ORIGINAL url untouched", async () => {
    const env = makeEnv().run();
    const url = BASE + "?Ids=i1,i2&Fields=Genres&EnableUserData=false&Limit=2";
    const p = env.window.fetch(url);
    await env.advance(WIN);
    assert.strictEqual(env.net.length, 1);
    assert.strictEqual(env.net[0].url, url, "verbatim, no rewriting");
    await env.servePool(env.net[0]);
    const b = await (await p).json();
    assert.deepStrictEqual(b.Items.map((x) => x.Id), ["i1", "i2"]);
    assert.strictEqual(env.window.__shellIU.pass, 1);
    assert.strictEqual(env.window.__shellIU.net, 0, "not counted as a merge");
  });

  // ---- 7. failure is a downgrade to baseline, never a wrong body ---------
  const failModes = [
    ["non-2xx", (env, c) => env.serve(c, "nope", { status: 503 }), "bad"],
    ["unparseable body", (env, c) => env.serve(c, "<html>", { status: 200 }), "bad"],
    ["body with no Items array", (env, c) => env.serve(c, "{}", { status: 200 }), "bad"],
    ["a rejected merged fetch", (env, c) => { c.reject(new Error("net")); return env.drain(); }, "rep"],
  ];
  for (const [label, fail, counter] of failModes)
    await check("failure: " + label + " replays every waiter", async () => {
      const env = makeEnv().run();
      const ps = [
        env.window.fetch(BASE + "?Ids=i1&Fields=A"),
        env.window.fetch(BASE + "?Ids=i2&Fields=B"),
      ];
      await env.advance(WIN);
      assert.strictEqual(env.net.length, 1, "merged once");
      await fail(env, env.net[0]);
      assert.strictEqual(env.net.length, 3, "both waiters replayed");
      assert.strictEqual(env.net[1].url, BASE + "?Ids=i1&Fields=A",
        "replay carries the ORIGINAL url");
      assert.strictEqual(env.net[2].url, BASE + "?Ids=i2&Fields=B");
      assert.strictEqual(env.window.__shellIU[counter], 1,
        counter + " counter incremented");
      await env.servePool(env.net[1]);
      await env.servePool(env.net[2]);
      const b = await (await ps[0]).json();
      assert.deepStrictEqual(b.Items.map((x) => x.Id), ["i1"],
        "the replayed waiter still gets a correct body");
    });

  // ---- 8. a mutation dispatches pending batches at once -------------------
  for (const [label, mutate] of [
    ["over fetch", (env) => env.window.fetch("http://srv/Items/i1/Played", { method: "POST" })],
    ["over XHR", (env) => new env.window.XMLHttpRequest().open("POST", "http://srv/x")],
  ])
    await check("a mutation " + label + " flushes pending batches", async () => {
      const env = makeEnv().run();
      env.window.fetch(BASE + "?Ids=i1&Fields=A");
      env.window.fetch(BASE + "?Ids=i2&Fields=B");
      assert.strictEqual(env.net.length, 0, "still batching");
      mutate(env);
      const merged = env.net.filter((c) => idsOf(c.url).length === 2);
      assert.strictEqual(merged.length, 1, "the batch went out before the write");
      assert.strictEqual(env.window.__shellIU.fl, 1, "flush counter");
    });

  // ---- 9. the URL-length cap splits, it does not drop --------------------
  await check("exceeding the URL cap splits the batch, losing no waiter",
    async () => {
      const env = makeEnv({
        store: { "jellyfin.shell.idUnionMaxUrl": "512" },
      }).run();
      assert.strictEqual(env.window.__shellIU.m, 512, "cap read back");
      const want = [];
      const ps = [];
      for (let i = 0; i < 8; i++) {
        const mine = Array.from({ length: 4 }, (_, k) => LONG(i * 4 + k));
        want.push(mine);
        ps.push(env.window.fetch(BASE + "?Fields=A&Ids=" + mine.join(",")));
      }
      await env.advance(WIN);
      assert(env.net.length > 1, "the cap split the batch");
      assert(env.window.__shellIU.cap > 0, "cap counter fired");
      for (const c of env.net)
        assert(c.url.length <= 900, "each url stays bounded: " + c.url.length);
      for (const c of env.net) await env.servePool(c);
      const bodies = await Promise.all(
        (await Promise.all(ps)).map((r) => r.json()),
      );
      for (let i = 0; i < 8; i++) {
        assert.deepStrictEqual(
          bodies[i].Items.map((x) => x.Id).sort(),
          want[i].slice().sort(),
          "waiter " + i + " kept every one of its items",
        );
      }
    });

  // ---- 10. AC1 against the REAL capture ----------------------------------
  // scripts/fixtures/jela829-ids-burst.json is the JELA-829 ATTR-b1 boot
  // census replayed at its recorded inter-arrival times. Host, api_key and
  // item ids are redacted per the evidence policy; the timings, the id COUNTS
  // and — the part that matters — the id OVERLAP between requests are
  // verbatim. AC1 is "11 -> <= 8 at a 250 ms window".
  await check("AC1: the JELA-829 capture collapses 11 Ids= GETs to <= 8",
    async () => {
      const fx = JSON.parse(
        fs.readFileSync(
          path.join(__dirname, "fixtures", "jela829-ids-burst.json"),
          "utf8",
        ),
      );
      assert.strictEqual(fx.reqs.length, 11, "the census had 11 Ids= GETs");
      const asked = fx.reqs.reduce((s, r) => s + r.ids, 0);
      const distinct = new Set();
      for (const r of fx.reqs)
        for (const id of idsOf(r.url)) distinct.add(id);
      assert.strictEqual(asked, 339, "339 ids requested");
      assert.strictEqual(distinct.size, 144, "of which 144 are distinct");

      // Every id in the fixture exists, so a slice can be checked exactly.
      const pool = {};
      for (const id of distinct) pool[id] = { Id: id, Name: "x" };
      const env = makeEnv().run();
      const ps = [];
      let t = 0;
      for (const r of fx.reqs) {
        await env.advance(r.t - t);
        t = r.t;
        ps.push({ want: idsOf(r.url), p: env.window.fetch(r.url) });
      }
      await env.advance(WIN + 1);
      const n = env.net.length;
      assert(n <= 8, "AC1: 11 -> " + n + " (must be <= 8)");

      for (const c of env.net) await env.servePool(c, undefined, pool);
      const bodies = await Promise.all(
        (await Promise.all(ps.map((x) => x.p))).map((r) => r.json()),
      );
      for (let i = 0; i < ps.length; i++) {
        assert.deepStrictEqual(
          bodies[i].Items.map((x) => x.Id).sort(),
          ps[i].want.slice().sort(),
          "capture waiter " + i + " got exactly its ids",
        );
      }
      console.log(
        "       (11 -> " + n + " requests at a " + WIN + " ms window; " +
          asked + " ids asked, " + distinct.size + " distinct)",
      );
    });

  // ---- 11. install discipline -------------------------------------------
  await check("one install per WINDOW: a re-run never double-wraps", async () => {
    const env = makeEnv();
    env.run();
    const first = env.window.fetch;
    env.run();
    assert.strictEqual(env.window.fetch, first, "fetch not re-wrapped");
  });

  await check("no Response constructor stands the whole thing down", async () => {
    const env = makeEnv({ noResponse: true }).run();
    assert.strictEqual(env.window.__shellIU, undefined, "not installed");
    env.window.fetch(BASE + "?Ids=i1");
    env.window.fetch(BASE + "?Ids=i2");
    assert.strictEqual(env.net.length, 2, "straight to the wire");
  });

  console.log(
    failures === 0
      ? "\nid-union: all checks passed"
      : "\nid-union: " + failures + " FAILURES",
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
