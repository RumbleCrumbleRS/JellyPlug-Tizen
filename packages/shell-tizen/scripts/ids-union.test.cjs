/*
 * JELA-830: coalesce the boot `Ids=` hydration burst by ID-UNION.
 *
 * The JELA-829 census (ATTR-b1-boot, shell a171f117, fleet flag state, cold
 * boot) found ELEVEN boot GETs carrying `Ids=`. Between them they ask for 339
 * item ids of which only 144 are distinct, and three of them land inside 62 ms
 * of each other with pairwise 100% id overlap — the same 21 items, three times,
 * differing only in which `Fields` are requested.
 *
 * The JELA-724/752 coalescer already allowlists `/Users/*​/Items` and already
 * has a window, a kill switch and counters, but it keys on the byte-identical
 * URL and no two of those eleven URLs are identical. This shim keys on
 * (route, credentials, mode, headers, non-unionable query) instead, unions the
 * `Ids`, and slices the merged response back down per waiter.
 *
 * Extracts the SHIPPED instantHomeBody() and drives it through the same stubbed
 * window the other instantHomeBody tests use, plus a fake clock, a fake network
 * and a fake ITEM POOL that answers `Ids=` queries the way the server does.
 *
 * The headline test REPLAYS THE CENSUS: scripts/fixtures/jela830-ids-burst.json
 * carries all eleven captured requests with their captured `t` offsets and
 * every non-host byte intact, and the test drives them at those offsets on the
 * fake clock. That is what pins the AC1 number to the measurement rather than
 * to a hand-written scenario.
 *
 * Pinned:
 *   - DARK BY DEFAULT: with jellyfin.shell.fcIdsUnion absent the shim is not
 *     installed at all and all eleven requests are on the wire (AC4's shape)
 *   - armed at the default 250 ms window the eleven collapse to SIX, and the
 *     339 id lookups to 144 (AC1: <= 8)
 *   - AC2, on every one of the eleven waiters: it receives exactly the ids it
 *     asked for — no foreign id, none short — in the server's own order, with
 *     TotalRecordCount equal to its own slice length
 *   - the batch key never merges across base paths, credentials, mode, request
 *     headers, or any non-unionable query parameter
 *   - the TotalRecordCount proof's preconditions are ENFORCED: StartIndex > 0
 *     and Limit < |Ids| are both refused the batch
 *   - union rules: Fields/EnableImageTypes unioned, EnableImages/EnableUserData
 *     OR'd, ImageTypeLimit maxed, Limit set to the union count, ETRC forced
 *     false on the wire; and the ABSENT-IS-PERMISSIVE rule — one member
 *     omitting EnableImageTypes or ImageTypeLimit drops it for the whole batch
 *   - a batch that closes with one member is re-issued VERBATIM (original url
 *     and init), so a singleton takes on no rewrite risk
 *   - fallback: a non-2xx union, an unparseable body, or a body with no Items
 *     array replays EVERY waiter on the real network with its original url,
 *     and no waiter is left half-resolved
 *   - scope: non-GETs, Request objects, bodies, AbortSignals, Range /
 *     If-None-Match / If-Modified-Since, and non-/Items routes are untouched
 *   - windowMs='0' stands the whole shim down; the window clamps to 0..2000
 *   - id normalisation: dashed and undashed GUIDs match the response's .Id
 *   - one install per WINDOW: a re-run body never double-wraps fetch
 *   - the shim installs AFTER the JELA-724 coalescer (so it gets first refusal
 *     and the coalescer still sees the union request) and BEFORE api-warm
 *
 * Run: node scripts/ids-union.test.cjs
 */
"use strict";
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const SRC = path.join(__dirname, "..", "src", "shell.js");
const text = fs.readFileSync(SRC, "utf8");
const FIXTURE = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "fixtures", "jela830-ids-burst.json"),
    "utf8",
  ),
);

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

const FLAG = "jellyfin.shell.fcIdsUnion";
const WKEY = "jellyfin.shell.fcIdsUnionWindowMs";
const CREDS = JSON.stringify({
  Servers: [{ Id: "s1", AccessToken: "tok", UserId: "u1" }],
});

// ---- static contract checks ------------------------------------------------
assert(body.indexOf('flg("' + FLAG + '")') !== -1, "opt-in flag key present");
assert(body.indexOf(WKEY) !== -1, "window override key present");
assert(body.indexOf("__shellFCU") !== -1, "counters present");
assert(body.indexOf("</script") === -1, "no </script literal");
assert(body.indexOf("=>") === -1, "body must be ES5 (no arrow functions)");
assert(body.indexOf("`") === -1, "body must be ES5 (no template literals)");
// Install order fixes the CALL order: api-warm sees a request first, then the
// id-union batcher, then the JELA-724 coalescer, then the network. The union
// request itself therefore still passes through the coalescer.
assert(
  body.indexOf("__shellFC") < body.indexOf("__shellFCU") &&
    body.indexOf("__shellFCU") < body.indexOf("__shellAW"),
  "id-union installs after the coalescer and before api-warm",
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

function makeEnv(opts) {
  opts = opts || {};
  const { Response, Headers } = makeResponseStub();
  let now = 0;
  let nextTimerId = 1;
  const timers = new Map();
  const setTimeoutStub = (cb, ms) => {
    const id = nextTimerId++;
    timers.set(id, { cb, next: now + ms, repeat: false });
    return id;
  };
  const setIntervalStub = (cb, ms) => {
    const id = nextTimerId++;
    timers.set(id, { cb, next: now + ms, repeat: true });
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
      // Isolate the unit under test: the JELA-724 coalescer keys on the
      // byte-identical URL and none of these requests share one, so it can
      // never contribute to the counts below — but turning it off makes that a
      // fact rather than an argument.
      "jellyfin.shell.fetchCoalesceDisabled": "1",
      [FLAG]: "1",
    },
    opts.store || {},
  );
  if (opts.store)
    for (const k of Object.keys(opts.store))
      if (opts.store[k] === null) delete store[k];
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
    get now() {
      return now;
    },
    drain() {
      let p = Promise.resolve();
      for (let i = 0; i < 12; i++)
        p = p.then(() => new Promise((r) => setImmediate(r)));
      return p;
    },
    // Fire every one-shot timer due within `ms`, in due order, so the batch
    // window's CLOSE is asserted rather than waited on.
    advance(ms) {
      const target = now + ms;
      let p = Promise.resolve();
      const step = () => {
        const due = Array.from(timers)
          .filter(([, t]) => !t.repeat && t.next <= target)
          .sort((a, b) => a[1].next - b[1].next);
        if (!due.length) {
          now = target;
          return env.drain();
        }
        const [id, t] = due[0];
        timers.delete(id);
        now = t.next;
        t.cb();
        return env.drain().then(step);
      };
      return p.then(step);
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

// ---- fake item pool --------------------------------------------------------
// Answers an `Ids=` query the way the server does: filter the pool to the
// requested ids, return them in POOL order (a stable server sort), and report
// TotalRecordCount as the number that matched. Honours Limit so a truncation
// bug would show up rather than being masked.
function makePool(ids) {
  const norm = (s) => String(s).toLowerCase().replace(/-/g, "");
  const items = ids.map((id, i) => ({
    Id: norm(id),
    Name: "item-" + i,
    Type: "Movie",
  }));
  const byId = new Map(items.map((it) => [it.Id, it]));
  return {
    items,
    norm,
    answer(url) {
      const q = url.slice(url.indexOf("?") + 1);
      const params = new Map();
      for (const kv of q.split("&")) {
        if (!kv) continue;
        const e = kv.indexOf("=");
        params.set(
          e < 0 ? kv : kv.slice(0, e),
          e < 0 ? "" : decodeURIComponent(kv.slice(e + 1)),
        );
      }
      const want = new Set(
        (params.get("Ids") || "")
          .split(",")
          .filter(Boolean)
          .map((x) => norm(x)),
      );
      let hit = items.filter((it) => want.has(it.Id));
      const total = hit.length;
      const lim = params.has("Limit") ? parseInt(params.get("Limit"), 10) : NaN;
      if (lim >= 0) hit = hit.slice(0, lim);
      return {
        params,
        body: JSON.stringify({
          Items: hit,
          TotalRecordCount: total,
          StartIndex: 0,
        }),
      };
    },
    byId,
  };
}

// Drive the shimmed fetch and collect each waiter's parsed body.
function ask(env, url, init) {
  const rec = { url, done: false, err: null, json: null, status: null };
  rec.p = env.window
    .fetch(url, init)
    .then((r) => {
      rec.status = r.status;
      return r.text();
    })
    .then((t) => {
      rec.done = true;
      rec.json = t ? JSON.parse(t) : null;
    })
    .catch((e) => {
      rec.err = e;
    });
  return rec;
}

function serveAll(env, pool, from) {
  for (let i = from; i < env.net.length; i++) {
    const c = env.net[i];
    if (c.served) continue;
    c.served = true;
    c.resolve(
      new env.Response(pool.answer(c.url).body, {
        status: 200,
        headers: { "content-type": "application/json", "content-length": "1" },
      }),
    );
  }
  return env.drain();
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

// ---- census replay ---------------------------------------------------------
const CENSUS = FIXTURE.requests;
const censusIds = (url) =>
  decodeURIComponent(url.slice(url.indexOf("Ids=") + 4).split("&")[0]).split(
    ",",
  );
const ALL_IDS = [];
{
  const seen = new Set();
  for (const r of CENSUS)
    for (const id of censusIds(r.url))
      if (!seen.has(id)) {
        seen.add(id);
        ALL_IDS.push(id);
      }
}
assert.strictEqual(
  CENSUS.reduce((a, r) => a + r.idCount, 0),
  FIXTURE.totalIdsRequested,
  "fixture id total is self-consistent",
);
assert.strictEqual(ALL_IDS.length, FIXTURE.distinctIds, "fixture distinct ids");
assert.strictEqual(
  new Set(CENSUS.map((r) => r.url)).size,
  CENSUS.length,
  "no two census URLs are byte-identical (the JELA-724 coalescer cannot help)",
);

// Replay the eleven captured requests at their captured offsets on the fake
// clock, serving whatever reaches the network from the pool.
async function replayCensus(store) {
  const env = makeEnv({ store }).run();
  const pool = makePool(ALL_IDS);
  const recs = [];
  let t = 0;
  let served = 0;
  for (const r of CENSUS) {
    if (r.t > t) {
      await env.advance(r.t - t);
      t = r.t;
      await serveAll(env, pool, served);
      served = env.net.length;
    }
    recs.push(ask(env, r.url, { credentials: "same-origin" }));
    await env.drain();
  }
  // Close every outstanding batch and settle every outstanding request.
  for (let i = 0; i < 6; i++) {
    await env.advance(500);
    await serveAll(env, pool, 0);
  }
  await env.drain();
  return { env, pool, recs };
}

// AC2, applied to one waiter: exactly its ids, in the pool's order, and a
// TotalRecordCount that matches its own slice.
function assertExact(rec, pool, label) {
  assert(rec.done, label + ": waiter never settled (" + rec.err + ")");
  const want = censusIds(rec.url).map((x) => pool.norm(x));
  const got = rec.json.Items.map((it) => it.Id);
  const wantSet = new Set(want);
  for (const g of got) assert(wantSet.has(g), label + ": foreign id " + g);
  const gotSet = new Set(got);
  for (const w of want)
    assert(gotSet.has(w), label + ": short an id it asked for (" + w + ")");
  assert.strictEqual(got.length, want.length, label + ": duplicate ids");
  const expectOrder = pool.items
    .filter((it) => wantSet.has(it.Id))
    .map((it) => it.Id);
  assert.deepStrictEqual(got, expectOrder, label + ": server order not kept");
  assert.strictEqual(
    rec.json.TotalRecordCount,
    got.length,
    label + ": TotalRecordCount does not match the slice",
  );
  assert.strictEqual(rec.json.StartIndex, 0, label + ": StartIndex");
}

// ---- scenario helpers ------------------------------------------------------
const U = "http://srv/Users/u1/Items";
const idsOf = (n, base) =>
  Array.from(
    { length: n },
    (_, i) => "id" + String(base + i).padStart(30, "0"),
  );
function q(ids, extra) {
  return (
    U + "?Ids=" + encodeURIComponent(ids.join(",")) + (extra ? "&" + extra : "")
  );
}
function paramsOf(url) {
  const m = new Map();
  for (const kv of url.slice(url.indexOf("?") + 1).split("&")) {
    if (!kv) continue;
    const e = kv.indexOf("=");
    m.set(
      e < 0 ? kv : kv.slice(0, e),
      e < 0 ? "" : decodeURIComponent(kv.slice(e + 1)),
    );
  }
  return m;
}

async function main() {
  // ---- 1. dark by default ------------------------------------------------
  await check(
    "flag absent: shim is not installed and all 11 census GETs are on the wire",
    async () => {
      const { env } = await replayCensus({ [FLAG]: null });
      assert.strictEqual(
        env.window.__shellFCU,
        undefined,
        "no counters installed",
      );
      assert.strictEqual(env.net.length, 11, "eleven requests on the wire");
    },
  );

  // ---- 2. AC1: the census collapses ---------------------------------------
  let armed;
  await check(
    "armed at the default 250 ms window: 11 census GETs collapse to 6 (AC1 <= 8)",
    async () => {
      armed = await replayCensus();
      const IU = armed.env.window.__shellFCU;
      assert(IU && IU.on === 1, "counters installed");
      assert.strictEqual(IU.w, 250, "default window is 250 ms");
      assert(
        armed.env.net.length <= 8,
        "AC1: " + armed.env.net.length + " requests, want <= 8",
      );
      assert.strictEqual(
        armed.env.net.length,
        6,
        "simulated field-union figure at 250 ms",
      );
      assert.strictEqual(IU.batch, 11, "all eleven enrolled in a batch");
      assert.strictEqual(IU.err, 0, "no shim errors");
      assert.strictEqual(IU.fb, 0, "no fallback replays");
      // 11 waiters -> `fire` unions + `sing` verbatim re-issues == the wire.
      assert.strictEqual(
        IU.fire + IU.sing,
        armed.env.net.length,
        "every request on the wire is accounted for",
      );
    },
  );

  // ---- 3. AC2: every waiter gets exactly what it asked for -----------------
  await check(
    "AC2: all 11 waiters receive exactly their own ids, in server order",
    async () => {
      const { recs, pool, env } = armed;
      recs.forEach((r, i) => assertExact(r, pool, "census[" + i + "]"));
      const IU = env.window.__shellFCU;
      assert.strictEqual(
        IU.short,
        0,
        "no waiter short an id that was returned",
      );
      assert.strictEqual(IU.absent, 0, "no id missing from the union response");
      assert.strictEqual(
        recs.reduce((a, r) => a + r.json.Items.length, 0),
        FIXTURE.totalIdsRequested,
        "339 id lookups still delivered",
      );
      const wireIds = new Set();
      for (const c of env.net)
        for (const id of censusIds(c.url)) wireIds.add(pool.norm(id));
      assert.strictEqual(
        wireIds.size,
        FIXTURE.distinctIds,
        "only the 144 distinct ids ever reach the wire",
      );
    },
  );

  // ---- 4. route separation -------------------------------------------------
  await check("never merges across base paths", async () => {
    const env = makeEnv().run();
    const ids = idsOf(4, 1);
    const pool = makePool(ids);
    const a = ask(env, q(ids.slice(0, 2), "EnableTotalRecordCount=false"));
    const b = ask(
      env,
      "http://srv/Items?Ids=" +
        encodeURIComponent(ids.slice(2).join(",")) +
        "&EnableTotalRecordCount=false",
    );
    await env.drain();
    await env.advance(300);
    assert.strictEqual(env.net.length, 2, "two routes, two requests");
    assert(env.net[0].url.indexOf("/Users/u1/Items?") !== -1);
    assert(env.net[1].url.indexOf("/Items?") !== -1);
    await serveAll(env, pool, 0);
    assert(a.done && b.done, "both settled");
  });

  // ---- 5. the TotalRecordCount proof's preconditions are enforced ----------
  await check("StartIndex > 0 is refused the batch", async () => {
    const env = makeEnv().run();
    const ids = idsOf(4, 1);
    const pool = makePool(ids);
    ask(env, q(ids.slice(0, 2)));
    ask(env, q(ids.slice(2), "StartIndex=1"));
    await env.drain();
    assert.strictEqual(
      env.net.length,
      1,
      "the StartIndex one went straight out",
    );
    await env.advance(300);
    assert.strictEqual(
      env.net.length,
      2,
      "the other went alone when the batch closed",
    );
    await serveAll(env, pool, 0);
  });

  await check("Limit below the caller's own id count is refused", async () => {
    const env = makeEnv().run();
    const ids = idsOf(6, 1);
    const pool = makePool(ids);
    ask(env, q(ids.slice(0, 3), "Limit=2"));
    await env.drain();
    assert.strictEqual(env.net.length, 1, "straight to the network");
    assert.strictEqual(
      paramsOf(env.net[0].url).get("Limit"),
      "2",
      "url untouched",
    );
    ask(env, q(ids.slice(3), "Limit=3"));
    await env.drain();
    assert.strictEqual(env.net.length, 1, "Limit == |Ids| is eligible");
    await env.advance(300);
    await serveAll(env, pool, 0);
  });

  await check("StartIndex=0 is eligible", async () => {
    const env = makeEnv().run();
    const ids = idsOf(4, 1);
    const pool = makePool(ids);
    ask(env, q(ids.slice(0, 2), "StartIndex=0"));
    ask(env, q(ids.slice(2), "StartIndex=0"));
    await env.drain();
    await env.advance(300);
    assert.strictEqual(env.net.length, 1, "one union request");
    await serveAll(env, pool, 0);
  });

  // ---- 6. union rules ------------------------------------------------------
  await check(
    "union: Ids/Limit/Fields/EnableImageTypes/ImageTypeLimit/booleans",
    async () => {
      const env = makeEnv().run();
      const ids = idsOf(5, 1);
      const pool = makePool(ids);
      const a = ask(
        env,
        q(
          ids.slice(0, 3),
          "Fields=Overview,Genres&EnableImageTypes=Primary&ImageTypeLimit=1&EnableImages=false&EnableUserData=false&EnableTotalRecordCount=true&SortBy=SortName",
        ),
      );
      const b = ask(
        env,
        q(
          ids.slice(2),
          "Fields=Genres,DateCreated&EnableImageTypes=Backdrop&ImageTypeLimit=3&EnableImages=true&EnableUserData=true&EnableTotalRecordCount=false&SortBy=SortName",
        ),
      );
      await env.drain();
      await env.advance(300);
      assert.strictEqual(env.net.length, 1, "one union request");
      const p = paramsOf(env.net[0].url);
      assert.deepStrictEqual(
        p.get("Ids").split(",").sort(),
        ids.slice().sort(),
        "Ids unioned, deduped",
      );
      assert.strictEqual(p.get("Limit"), "5", "Limit == union id count");
      assert.deepStrictEqual(
        p.get("Fields").split(",").sort(),
        ["DateCreated", "Genres", "Overview"],
        "Fields unioned",
      );
      assert.deepStrictEqual(
        p.get("EnableImageTypes").split(",").sort(),
        ["Backdrop", "Primary"],
        "EnableImageTypes unioned",
      );
      assert.strictEqual(p.get("ImageTypeLimit"), "3", "ImageTypeLimit maxed");
      assert.strictEqual(
        p.has("EnableImages"),
        false,
        "EnableImages OR'd to the default true (omitted)",
      );
      assert.strictEqual(
        p.has("EnableUserData"),
        false,
        "EnableUserData OR'd to the default true (omitted)",
      );
      assert.strictEqual(
        p.get("EnableTotalRecordCount"),
        "false",
        "ETRC forced false on the wire",
      );
      assert.strictEqual(
        p.get("SortBy"),
        "SortName",
        "key params carried over",
      );
      await serveAll(env, pool, 0);
      assertExact({ ...a, url: q(ids.slice(0, 3)) }, pool, "a");
      // The ETRC=true caller still gets a correct count off the slice.
      assert.strictEqual(a.json.TotalRecordCount, 3, "synthesized count for a");
      assert.strictEqual(b.json.TotalRecordCount, 3, "synthesized count for b");
    },
  );

  await check(
    "both booleans stay false only when EVERY member says false",
    async () => {
      const env = makeEnv().run();
      const ids = idsOf(4, 1);
      const pool = makePool(ids);
      ask(env, q(ids.slice(0, 2), "EnableImages=false&EnableUserData=false"));
      ask(env, q(ids.slice(2), "EnableImages=false&EnableUserData=false"));
      await env.drain();
      await env.advance(300);
      const p = paramsOf(env.net[0].url);
      assert.strictEqual(p.get("EnableImages"), "false");
      assert.strictEqual(p.get("EnableUserData"), "false");
      await serveAll(env, pool, 0);
    },
  );

  await check(
    "absent is permissive: one member omitting EnableImageTypes/ImageTypeLimit drops it",
    async () => {
      const env = makeEnv().run();
      const ids = idsOf(4, 1);
      const pool = makePool(ids);
      ask(env, q(ids.slice(0, 2), "EnableImageTypes=Primary&ImageTypeLimit=1"));
      ask(env, q(ids.slice(2)));
      await env.drain();
      await env.advance(300);
      assert.strictEqual(env.net.length, 1, "still merged");
      const p = paramsOf(env.net[0].url);
      assert.strictEqual(
        p.has("EnableImageTypes"),
        false,
        "dropped, or the omitting member would lose Backdrop/Logo",
      );
      assert.strictEqual(p.has("ImageTypeLimit"), false, "dropped");
      await serveAll(env, pool, 0);
    },
  );

  // ---- 7. key separation ---------------------------------------------------
  await check(
    "a differing non-unionable parameter splits the batch",
    async () => {
      const env = makeEnv().run();
      const ids = idsOf(4, 1);
      const pool = makePool(ids);
      ask(env, q(ids.slice(0, 2), "IncludeItemTypes=Movie"));
      ask(env, q(ids.slice(2), "IncludeItemTypes=Series"));
      await env.drain();
      await env.advance(300);
      assert.strictEqual(env.net.length, 2, "two batches");
      await serveAll(env, pool, 0);
    },
  );

  await check("credentials and mode are part of the key", async () => {
    const env = makeEnv().run();
    const ids = idsOf(6, 1);
    const pool = makePool(ids);
    ask(env, q(ids.slice(0, 2)), { credentials: "same-origin" });
    ask(env, q(ids.slice(2, 4)), { credentials: "include" });
    ask(env, q(ids.slice(4)), { credentials: "same-origin", mode: "no-cors" });
    await env.drain();
    await env.advance(300);
    assert.strictEqual(env.net.length, 3, "three keys, three requests");
    await serveAll(env, pool, 0);
  });

  await check(
    "request headers are part of the key; conditional/ranged GETs opt out",
    async () => {
      const env = makeEnv().run();
      const ids = idsOf(8, 1);
      const pool = makePool(ids);
      ask(env, q(ids.slice(0, 2)), { headers: { "X-A": "1" } });
      ask(env, q(ids.slice(2, 4)), { headers: { "X-A": "1" } });
      ask(env, q(ids.slice(4, 6)), { headers: { "X-A": "2" } });
      ask(env, q(ids.slice(6)), { headers: { Range: "bytes=0-1" } });
      await env.drain();
      assert.strictEqual(env.net.length, 1, "the ranged GET went straight out");
      await env.advance(300);
      assert.strictEqual(
        env.net.length,
        3,
        "identical headers merged; a differing header did not",
      );
      const IU = env.window.__shellFCU;
      assert(IU.skip >= 1, "the ranged GET is counted as skipped");
      await serveAll(env, pool, 0);
    },
  );

  // ---- 8. singleton is re-issued verbatim ---------------------------------
  await check(
    "a one-member batch is re-issued with its original url",
    async () => {
      const env = makeEnv().run();
      const ids = idsOf(3, 1);
      const pool = makePool(ids);
      const url = q(ids, "Fields=Overview&EnableTotalRecordCount=true&Limit=9");
      const r = ask(env, url);
      await env.drain();
      assert.strictEqual(env.net.length, 0, "held for the window");
      await env.advance(250);
      assert.strictEqual(env.net.length, 1);
      assert.strictEqual(
        env.net[0].url,
        url,
        "byte-identical to the caller's url",
      );
      assert.strictEqual(
        env.window.__shellFCU.fire,
        0,
        "no union request was synthesized",
      );
      assert.strictEqual(
        env.window.__shellFCU.sing,
        1,
        "counted as a singleton",
      );
      assert.strictEqual(
        env.window.__shellFCU.fb,
        0,
        "not counted as a fallback",
      );
      await serveAll(env, pool, 0);
      assert(r.done, "settled");
      assert.strictEqual(
        r.json.TotalRecordCount,
        3,
        "the server's own answer, untouched",
      );
    },
  );

  // ---- 9. fallbacks --------------------------------------------------------
  for (const [label, mk] of [
    ["a non-2xx union", (env) => new env.Response("nope", { status: 503 })],
    [
      "an unparseable body",
      (env) => new env.Response("<html>", { status: 200 }),
    ],
    [
      "a body with no Items array",
      (env) => new env.Response(JSON.stringify({ Nope: 1 }), { status: 200 }),
    ],
  ]) {
    await check(label + " replays every waiter on the network", async () => {
      const env = makeEnv().run();
      const ids = idsOf(4, 1);
      const pool = makePool(ids);
      const uA = q(ids.slice(0, 2));
      const uB = q(ids.slice(2));
      const a = ask(env, uA);
      const b = ask(env, uB);
      await env.drain();
      await env.advance(300);
      assert.strictEqual(env.net.length, 1, "one union request");
      env.net[0].served = true;
      env.net[0].resolve(mk(env));
      await env.drain();
      assert.strictEqual(env.net.length, 3, "both waiters replayed");
      assert.strictEqual(env.net[1].url, uA, "replayed with A's original url");
      assert.strictEqual(env.net[2].url, uB, "replayed with B's original url");
      assert(!a.done && !b.done, "nobody was half-resolved");
      assert.strictEqual(env.window.__shellFCU.fb, 1, "fallback counted");
      await serveAll(env, pool, 1);
      assert(a.done && b.done, "both settled off the network");
      assert.strictEqual(a.json.Items.length, 2);
      assert.strictEqual(b.json.Items.length, 2);
    });
  }

  await check("a rejected union replays every waiter", async () => {
    const env = makeEnv().run();
    const ids = idsOf(4, 1);
    const pool = makePool(ids);
    const a = ask(env, q(ids.slice(0, 2)));
    const b = ask(env, q(ids.slice(2)));
    await env.drain();
    await env.advance(300);
    env.net[0].served = true;
    env.net[0].reject(new TypeError("offline"));
    await env.drain();
    assert.strictEqual(env.net.length, 3, "both replayed");
    await serveAll(env, pool, 1);
    assert(a.done && b.done);
  });

  // ---- 10. scope -----------------------------------------------------------
  await check(
    "out of scope: POST, Request object, body, AbortSignal",
    async () => {
      const env = makeEnv().run();
      const ids = idsOf(2, 1);
      const url = q(ids);
      env.window.fetch(url, { method: "POST" });
      env.window.fetch({ url, method: "GET" });
      env.window.fetch(url, { body: "x" });
      env.window.fetch(url, { signal: {} });
      await env.drain();
      assert.strictEqual(env.net.length, 4, "all four went straight out");
    },
  );

  await check("out of scope: a route that is not /Items", async () => {
    const env = makeEnv().run();
    env.window.fetch("http://srv/Shows/NextUp?Ids=a,b");
    env.window.fetch("http://srv/Users/u1/Items/abc?Ids=a,b");
    env.window.fetch("http://srv/Users/u1/Items");
    await env.drain();
    assert.strictEqual(env.net.length, 3, "untouched");
  });

  await check("out of scope: an empty Ids list", async () => {
    const env = makeEnv().run();
    env.window.fetch("http://srv/Users/u1/Items?Ids=&Limit=1");
    await env.drain();
    assert.strictEqual(env.net.length, 1, "untouched");
  });

  // ---- 11. window knob -----------------------------------------------------
  await check("windowMs='0' stands the whole shim down", async () => {
    const env = makeEnv({ store: { [WKEY]: "0" } }).run();
    assert.strictEqual(env.window.__shellFCU, undefined, "not installed");
    env.window.fetch(q(idsOf(2, 1)));
    await env.drain();
    assert.strictEqual(env.net.length, 1, "straight to the network");
  });

  await check("windowMs clamps to 0..2000 and rejects junk", async () => {
    assert.strictEqual(
      makeEnv({ store: { [WKEY]: "150" } }).run().window.__shellFCU.w,
      150,
    );
    assert.strictEqual(
      makeEnv({ store: { [WKEY]: "2000" } }).run().window.__shellFCU.w,
      2000,
    );
    assert.strictEqual(
      makeEnv({ store: { [WKEY]: "2001" } }).run().window.__shellFCU.w,
      250,
    );
    assert.strictEqual(
      makeEnv({ store: { [WKEY]: "-1" } }).run().window.__shellFCU.w,
      250,
    );
    assert.strictEqual(
      makeEnv({ store: { [WKEY]: "abc" } }).run().window.__shellFCU.w,
      250,
    );
    assert.strictEqual(
      makeEnv({ store: { [WKEY]: "" } }).run().window.__shellFCU.w,
      250,
    );
  });

  await check("a 150 ms window still meets AC1 on the census", async () => {
    const { env } = await replayCensus({ [WKEY]: "150" });
    assert(
      env.net.length <= 8,
      "AC1 at 150 ms: " + env.net.length + " requests, want <= 8",
    );
  });

  // ---- 12. id normalisation ------------------------------------------------
  await check(
    "dashed and undashed GUIDs match the response's .Id",
    async () => {
      const env = makeEnv().run();
      const flat = [
        "b05aa89cae93c9681c6c25e53c422c97",
        "1dabe0fa2ed87f683743a5ca1ecddc1f",
      ];
      const pool = makePool(flat);
      const dashed = "b05aa89c-ae93-c968-1c6c-25e53c422c97";
      const a = ask(env, q([dashed]));
      const b = ask(env, q([flat[1]]));
      await env.drain();
      await env.advance(300);
      assert.strictEqual(env.net.length, 1, "merged");
      await serveAll(env, pool, 0);
      assert.strictEqual(a.json.Items.length, 1, "dashed caller got its item");
      assert.strictEqual(a.json.Items[0].Id, flat[0]);
      assert.strictEqual(env.window.__shellFCU.short, 0, "nobody short");
    },
  );

  // ---- 13. caps ------------------------------------------------------------
  await check(
    "the union is capped and the overflow starts a new batch",
    async () => {
      const env = makeEnv().run();
      const ids = idsOf(300, 1);
      const pool = makePool(ids);
      for (let i = 0; i < 300; i += 50) ask(env, q(ids.slice(i, i + 50)));
      await env.drain();
      await env.advance(300);
      assert(env.net.length >= 2, "the cap forced more than one request");
      for (const c of env.net) {
        assert(
          c.url.length <= 6600,
          "url stays inside the guard: " + c.url.length,
        );
        const n = paramsOf(c.url).get("Ids").split(",").length;
        assert(n <= 200, "union id count capped: " + n);
      }
      await serveAll(env, pool, 0);
      assert.strictEqual(env.window.__shellFCU.short, 0);
      assert.strictEqual(env.window.__shellFCU.absent, 0);
    },
  );

  // ---- 14. one install per window -----------------------------------------
  await check("re-running the body never double-wraps fetch", async () => {
    const env = makeEnv().run();
    const first = env.window.fetch;
    env.run();
    assert.strictEqual(env.window.fetch, first, "fetch not re-wrapped");
  });

  await check("engines without Response stand the shim down", async () => {
    const env = makeEnv({ noResponse: true }).run();
    assert.strictEqual(env.window.__shellFCU, undefined);
  });

  console.log(
    failures
      ? "\n" + failures + " FAILURE(S)"
      : "\nall ids-union checks passed",
  );
  process.exit(failures ? 1 : 0);
}

main();
