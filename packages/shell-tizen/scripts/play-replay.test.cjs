/*
 * JELA-757: play-path replay — the play chain must not re-download the item
 * the detail page is already standing on, and /Intros must not gate
 * PlaybackInfo.
 *
 * The JELA-756 census measured FOUR strictly serial round trips between the
 * play click and the <video> element:
 *
 *   GET /Users/{u}/Items/{id}/Intros
 *     -> GET /Users/{u}/Items/{id}       full item body, already on screen
 *       -> POST /Items/{id}/PlaybackInfo
 *         -> GET /videos/{id}/master.m3u8
 *
 * Hop 2 exists only so playAfterBitrateDetect can read `.MediaStreams`, and
 * it sits inside the Promise.all that gates PlaybackInfo. The JELA-752
 * coalescer above cannot absorb it: its replay window is 400 ms (2 s ceiling)
 * and the click is ~18 s after the detail open.
 *
 * Extracts the SHIPPED instantHomeBody() and drives it through the same
 * stubbed window the other instantHomeBody tests use, plus a controllable
 * fetch, a Response stub and a click dispatcher, pinning:
 *   - RECORD only the item the user is standing on (the id must be in
 *     location.hash at REQUEST time), and SERVE each entry exactly ONCE, to
 *     whoever asks next — which is playAfterBitrateDetect by construction.
 *     The second ask reaches the network, so this cannot become a cache.
 *   - AC1: the play hop is served from the store with ZERO network calls
 *   - a play click RE-OPENS the budget (an enhancement, not a prerequisite:
 *     the rig proved a capture-phase click listener never fires on this
 *     engine, on document or on window), and an unrelated click does not
 *   - the off-critical-path /Intros prefetch: scheduled on recording an item,
 *     replays the item GET's own init (auth headers/credentials/mode) so the
 *     key matches what upstream will ask for, is capped per window, is
 *     skipped when there are no headers to replay, and is not itself recorded
 *     or mistaken for the play chain arming
 *   - scope: /Users/*\/Items (the list), /Users/*\/Items/Latest, any query
 *     string, POSTs, bodies, AbortSignals and Request objects are never
 *     recorded or served
 *   - only 2xx is recorded; a 404/503 is passed through and leaves no entry
 *   - ANY mutation over fetch OR XHR flushes the whole store
 *   - the TTL expires a recorded entry
 *   - every caller gets its OWN Response whose body is independently readable
 *   - kill-switch jellyfin.shell.playReplayDisabled='1', and the four
 *     clamp-or-keep-the-default tunables
 *   - one install per WINDOW: a re-run body never double-wraps fetch
 *   - engines without a Response constructor stand the whole thing down
 *   - composition with JELA-752: the replay store installs OUTSIDE the
 *     coalescer, so a served replay never reaches it
 *
 * Run: node scripts/play-replay.test.cjs
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
const ID = "0123456789abcdef0123456789abcdef";
const BASE = "http://srv/Users/u1/Items/";
const URL_ITEM = BASE + ID;
const URL_INTROS = URL_ITEM + "/Intros";
// The one field the play path actually wants out of that 44.9 KB body.
const ITEM_BODY = JSON.stringify({
  Id: ID,
  Name: "Some Title",
  MediaStreams: [{ Type: "Video", Codec: "h264" }],
});
const INTROS_BODY = JSON.stringify({
  Items: [],
  TotalRecordCount: 0,
  StartIndex: 0,
});
// The apiclient always sends auth on getItem/getIntros; the prefetch replays
// exactly this object, which is what makes its key match upstream's.
const AUTH = { headers: { "x-emby-authorization": "MediaBrowser Token=tok" } };

// ---- static contract checks ------------------------------------------------
assert(
  body.indexOf("jellyfin.shell.playReplayDisabled") !== -1,
  "kill-switch key present",
);
for (const k of [
  "jellyfin.shell.playReplayTtlMs",
  "jellyfin.shell.playReplayArmMs",
  "jellyfin.shell.playReplayIntrosMs",
  "jellyfin.shell.playReplayIntrosMax",
  "jellyfin.shell.playReplayMinAgeMs",
  "jellyfin.shell.playReplayFlushAll",
]) {
  assert(body.indexOf(k) !== -1, "tunable " + k + " present");
}
assert(body.indexOf("</script") === -1, "no </script literal");
assert(body.indexOf("=>") === -1, "body must be ES5 (no arrow functions)");
assert(body.indexOf("`") === -1, "body must be ES5 (no template literals)");
// Installed AFTER the JELA-752 coalescer, so the replay store is the OUTER
// fetch wrapper and gets first refusal on the two URLs it owns; and BEFORE
// api-warm, so the (one-shot) warm store keeps first refusal overall.
assert(
  body.indexOf("__shellFC") < body.indexOf("__shellPA"),
  "replay store installs after the coalescer",
);
assert(
  body.indexOf("__shellPA") < body.indexOf("__shellAW"),
  "replay store installs before api-warm",
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
      className: "",
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
    addEventListener(type, fn, capture) {
      listeners.push({ type, fn, capture });
    },
  };

  // The detail route puts the item id in the hash before it fetches the
  // body; the replay store gates on that, so tests must stand somewhere.
  const location = { hash: "#!/details?id=" + ID };
  const listeners = [];
  const window = {
    innerWidth: 1920,
    innerHeight: 1080,
    pageYOffset: 0,
    __shellT0: 0,
    addEventListener(type, fn, capture) {
      listeners.push({ type, fn, capture, on: "window" });
    },
  };
  window.__shellPhase = function () {};
  const xhrOpens = [];
  function FakeXHR() {
    this.readyState = 0;
    this.status = 0;
    this.responseText = "";
  }
  FakeXHR.prototype.open = function (m, u) {
    xhrOpens.push({ method: m, url: u });
  };
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
      // Isolate the replay store from the JELA-752 coalescer unless a test
      // explicitly composes the two: the coalescer's own 400 ms replay window
      // would otherwise absorb the very repeat GETs these tests assert on.
      "jellyfin.shell.fetchCoalesceDisabled": "1",
    },
    opts.store || {},
  );
  if (opts.withCoalescer) delete store["jellyfin.shell.fetchCoalesceDisabled"];
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
    document,
    location,
    listeners,
    net,
    store,
    xhrOpens,
    Response,
    Headers,
    // Serve the pending call with a body and drain microtasks.
    serve(call, bodyText, init) {
      call.resolve(new Response(bodyText, init || {}));
      return env.drain();
    },
    // Resolve the single outstanding network call, asserting there is one.
    serveOnly(bodyText, init) {
      const pending = net.filter((c) => !c._done);
      assert.strictEqual(pending.length, 1, "exactly one call outstanding");
      pending[0]._done = true;
      return env.serve(pending[0], bodyText, init);
    },
    drain() {
      let p = Promise.resolve();
      for (let i = 0; i < 8; i++)
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
    // Dispatch a capture-phase click at a node whose ancestry is `chain`
    // (target first). Each entry is {cls} and/or {action}.
    click(chain) {
      let target = null;
      let prev = null;
      for (const spec of chain) {
        const n = makeNode("BUTTON");
        if (spec.cls) n.className = spec.cls;
        if (spec.action) n.setAttribute("data-action", spec.action);
        if (prev) prev.parentNode = n;
        else target = n;
        prev = n;
      }
      const ev = { target, type: "click" };
      for (const l of listeners) if (l.type === "click") l.fn(ev);
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
        location,
        () => ({ fontSize: "28px", borderTopLeftRadius: "6px" }),
        opts.noResponse ? undefined : Response,
      );
      return env;
    },
  };
  return env;
}

let failures = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(
      () => console.log("  ok  " + name),
      (e) => {
        failures++;
        console.error("  FAIL " + name + "\n       " + (e && e.message));
      },
    );
}

// Record one item body WITHOUT settling: the entry exists but is still
// inside the min-age floor, i.e. the state during the detail route's own
// concurrent burst.
async function recorded(opts) {
  const env = makeEnv(opts).run();
  env.window.fetch(URL_ITEM, AUTH);
  await env.serveOnly(ITEM_BODY);
  assert.strictEqual(env.window.__shellPA.rec, 1, "item recorded");
  return env;
}

// The real state at play time: the detail page has loaded, its /Intros
// prefetch has landed, and both entries are past the min-age floor.
async function primed(opts) {
  const env = await recorded(opts);
  await env.advance(1500); // the intros prefetch fires
  await env.serveOnly(INTROS_BODY);
  await env.advance(2000); // both entries clear the min-age floor
  assert.strictEqual(env.window.__shellPA.pfh, 1, "intros prefetch stored");
  return env;
}

async function main() {
  console.log("play-replay (JELA-757)");

  // ---- 1. default state ----------------------------------------------------
  await check("installs by default with the documented tunables", async () => {
    const env = makeEnv().run();
    const PA = env.window.__shellPA;
    assert(PA && PA.on === 1, "installed");
    assert.strictEqual(PA.t, 300000, "default TTL 300 s");
    assert.strictEqual(PA.w, 6000, "default arm window 6 s");
    assert.strictEqual(PA.d, 1500, "default intros prefetch delay 1.5 s");
    assert.strictEqual(PA.m, 12, "default intros prefetch cap 12");
    assert.strictEqual(PA.a, 2000, "default min age 2 s");
  });

  // ---- 2. one replay per entry, then the network ---------------------------
  // The budget is what makes this work without click detection: the entry can
  // only be the item the user is standing on, and the next reader of it is
  // playAfterBitrateDetect.
  await check("the FIRST repeat GET is served with NO network", async () => {
    const env = await primed();
    const before = env.net.length;
    const r = await env.window.fetch(URL_ITEM, AUTH);
    assert.strictEqual(env.net.length, before, "no network call");
    assert.strictEqual(env.window.__shellPA.srv, 1, "served from the store");
    assert.strictEqual(await r.text(), ITEM_BODY, "the recorded body");
  });

  await check("the SECOND repeat GET reaches the network", async () => {
    const env = await primed();
    await env.window.fetch(URL_ITEM, AUTH);
    const before = env.net.length;
    env.window.fetch(URL_ITEM, AUTH);
    await env.drain();
    assert.strictEqual(env.net.length, before + 1, "budget spent");
    assert.strictEqual(env.window.__shellPA.srv, 1, "still one serve");
  });

  // ---- 3. AC1: the play hop is served --------------------------------------
  await check("a .btnPlay click serves the item with NO network", async () => {
    const env = await primed();
    await env.click([{ cls: "detailButton-icon" }, { cls: "btnPlay raised" }]);
    assert.strictEqual(env.window.__shellPA.arm, 1, "armed by the click");
    const before = env.net.length;
    const r = await env.window.fetch(URL_ITEM, AUTH);
    assert.strictEqual(env.net.length, before, "no network call");
    assert.strictEqual(env.window.__shellPA.srv, 1, "served from the store");
    assert.strictEqual(r.status, 200, "status preserved");
    assert.deepStrictEqual(
      JSON.parse(await r.text()).MediaStreams,
      [{ Type: "Video", Codec: "h264" }],
      "MediaStreams — the only field the play path wants — survives",
    );
  });

  await check('data-action="resume" arms it too', async () => {
    const env = await primed();
    await env.click([{ cls: "cardImageContainer", action: "resume" }]);
    assert.strictEqual(env.window.__shellPA.arm, 1, "armed");
    await env.window.fetch(URL_ITEM, AUTH);
    assert.strictEqual(env.window.__shellPA.srv, 1, "served");
  });

  await check("an unrelated click does not re-open the budget", async () => {
    const env = await primed();
    await env.window.fetch(URL_ITEM, AUTH); // spends the budget
    await env.click([{ cls: "btnHome" }, { cls: "headerButton" }]);
    assert.strictEqual(env.window.__shellPA.arm, 0, "not armed");
    assert.strictEqual(env.window.__shellPA.cl, 1, "but the click WAS seen");
    const before = env.net.length;
    env.window.fetch(URL_ITEM, AUTH);
    await env.drain();
    assert.strictEqual(env.net.length, before + 1, "went to the network");
  });

  // ---- 4. the /Intros hop is served on its own budget ----------------------
  // Whether /Intros leads the chain (cinema mode), is absent (the resume
  // path), or trails it, each entry carries its own single replay.
  await check("the item and its intros each carry one replay", async () => {
    const env = await primed();
    const before = env.net.length;
    await env.window.fetch(URL_INTROS, AUTH);
    await env.window.fetch(URL_ITEM, AUTH);
    assert.strictEqual(env.net.length, before, "both served, no network");
    assert.strictEqual(env.window.__shellPA.sri, 1, "intros served");
    assert.strictEqual(env.window.__shellPA.srv, 1, "item served");
  });

  await check("an /Intros GET does NOT re-open the item's budget", async () => {
    const env = await primed();
    await env.window.fetch(URL_ITEM, AUTH); // spends the item's budget
    await env.window.fetch(URL_INTROS, AUTH); // spends the intros' own
    const before = env.net.length;
    env.window.fetch(URL_ITEM, AUTH);
    await env.drain();
    assert.strictEqual(env.net.length, before + 1, "still spent");
  });

  // ---- 5. a play click re-opens the budget ---------------------------------
  await check(
    "a play click re-opens the budget for a second play",
    async () => {
      const env = await primed();
      await env.window.fetch(URL_ITEM, AUTH);
      assert.strictEqual(env.window.__shellPA.srv, 1, "first served");
      await env.click([{ cls: "btnPlay" }]);
      const before = env.net.length;
      await env.window.fetch(URL_ITEM, AUTH);
      assert.strictEqual(
        env.net.length,
        before,
        "served again after the click",
      );
      assert.strictEqual(env.window.__shellPA.srv, 2, "two serves");
    },
  );

  // ---- 6. playReplayArmMs governs only the re-open -------------------------
  await check("playReplayArmMs='0' disables only the re-open", async () => {
    const env = await primed({
      store: { "jellyfin.shell.playReplayArmMs": "0" },
    });
    const before = env.net.length;
    await env.window.fetch(URL_ITEM, AUTH);
    assert.strictEqual(env.net.length, before, "first replay still served");
    await env.click([{ cls: "btnPlay" }]);
    assert.strictEqual(env.window.__shellPA.arm, 0, "never re-opens");
    env.window.fetch(URL_ITEM, AUTH);
    await env.drain();
    assert.strictEqual(env.net.length, before + 1, "no second replay");
  });

  // ---- 7. the off-critical-path /Intros prefetch ---------------------------
  await check("recording an item prefetches its /Intros later", async () => {
    const env = await recorded();
    assert.strictEqual(env.window.__shellPA.pf, 1, "one prefetch scheduled");
    assert.strictEqual(env.net.length, 1, "not issued yet");
    await env.advance(1500);
    assert.strictEqual(env.net.length, 2, "issued after the delay");
    assert.strictEqual(env.net[1].url, URL_INTROS, "the intros URL");
    assert.strictEqual(
      env.net[1].opts,
      AUTH,
      "replays the item GET's own init, so auth and the key match",
    );
    await env.serveOnly(INTROS_BODY);
    assert.strictEqual(env.window.__shellPA.pfh, 1, "prefetch stored");
    // ...and it must NOT be recorded a second time nor arm anything.
    assert.strictEqual(env.window.__shellPA.ric, 0, "not double-recorded");
    assert.strictEqual(env.window.__shellPA.arm, 0, "prefetch did not arm");
  });

  await check("the prefetched /Intros is served at play time", async () => {
    const env = await primed();
    const before = env.net.length;
    const r = await env.window.fetch(URL_INTROS, AUTH);
    assert.strictEqual(env.net.length, before, "no network for intros");
    assert.strictEqual(env.window.__shellPA.sri, 1, "intros served");
    assert.strictEqual(
      JSON.parse(await r.text()).TotalRecordCount,
      0,
      "the real server answer, not a synthesised one",
    );
    // The item hop follows in the same arm and is served too — the two hops
    // AC2 needs gone.
    await env.window.fetch(URL_ITEM, AUTH);
    assert.strictEqual(env.net.length, before, "item served too");
  });

  await check("a GET with no headers to replay is not prefetched", async () => {
    const env = makeEnv().run();
    env.window.fetch(URL_ITEM);
    await env.serveOnly(ITEM_BODY);
    assert.strictEqual(env.window.__shellPA.rec, 1, "still recorded");
    assert.strictEqual(env.window.__shellPA.pf, 0, "but not prefetched");
  });

  await check("the intros prefetch is capped per window", async () => {
    const env = makeEnv({
      store: { "jellyfin.shell.playReplayIntrosMax": "2" },
    }).run();
    for (let i = 0; i < 4; i++) {
      const id = "0123456789abcdef0123456789abcde" + i;
      env.location.hash = "#!/details?id=" + id;
      env.window.fetch(BASE + id, AUTH);
      await env.serveOnly(ITEM_BODY);
    }
    assert.strictEqual(env.window.__shellPA.rec, 4, "all four recorded");
    assert.strictEqual(env.window.__shellPA.pf, 2, "prefetch capped at 2");
  });

  await check("a failed prefetch is counted, not thrown", async () => {
    const env = await recorded();
    await env.advance(1500);
    const pending = env.net.filter((c) => !c._done);
    pending[0]._done = true;
    pending[0].reject(new Error("offline"));
    await env.drain();
    assert.strictEqual(env.window.__shellPA.pfe, 1, "counted as an error");
    assert.strictEqual(env.window.__shellPA.err, 0, "no internal error");
  });

  // ---- 8. scope ------------------------------------------------------------
  await check("non-item URLs are never recorded", async () => {
    const cases = [
      ["the /Items list", "http://srv/Users/u1/Items"],
      ["a named endpoint", "http://srv/Users/u1/Items/Latest"],
      ["a resume endpoint", "http://srv/Users/u1/Items/Resume"],
      ["a query string", URL_ITEM + "?fields=MediaStreams"],
      ["the userId alias", "http://srv/Items/" + ID + "?userId=u1"],
      ["a non-GUID id", "http://srv/Users/u1/Items/notaguid"],
      ["a sub-resource", URL_ITEM + "/ThemeMedia"],
    ];
    for (const [label, u] of cases) {
      const env = makeEnv().run();
      env.window.fetch(u, AUTH);
      await env.serveOnly(ITEM_BODY);
      assert.strictEqual(
        env.window.__shellPA.rec + env.window.__shellPA.ric,
        0,
        label + " must not be recorded",
      );
    }
  });

  await check("a dashed-GUID id is recorded", async () => {
    const gid = "01234567-89ab-cdef-0123-456789abcdef";
    const env = makeEnv().run();
    env.location.hash = "#!/details?id=" + gid;
    env.window.fetch("http://srv/Users/u1/Items/" + gid, AUTH);
    await env.serveOnly(ITEM_BODY);
    assert.strictEqual(env.window.__shellPA.rec, 1, "recorded");
  });

  await check("bodies, signals and Request objects opt out", async () => {
    const env = makeEnv().run();
    env.window.fetch(URL_ITEM, { headers: {}, body: "x" });
    env.window.fetch(URL_ITEM, { headers: {}, signal: {} });
    env.window.fetch({ url: URL_ITEM });
    await env.drain();
    assert.strictEqual(env.net.length, 3, "all three reached the network");
    assert.strictEqual(env.window.__shellPA.rec, 0, "none recorded");
  });

  await check("only 2xx is recorded", async () => {
    for (const status of [404, 503]) {
      const env = makeEnv().run();
      const p = env.window.fetch(URL_ITEM, AUTH);
      await env.serveOnly("", { status });
      await p;
      await env.advance(2000);
      assert.strictEqual(
        env.window.__shellPA.rec,
        0,
        status + " must not be recorded",
      );
      const before = env.net.length;
      env.window.fetch(URL_ITEM, AUTH);
      await env.drain();
      assert.strictEqual(
        env.net.length,
        before + 1,
        status + " leaves nothing to serve",
      );
    }
  });

  await check("a non-2xx status still reaches its caller", async () => {
    const env = makeEnv().run();
    const p = env.window.fetch(URL_ITEM, AUTH);
    await env.serveOnly("nope", { status: 404, statusText: "Not Found" });
    const r = await p;
    assert.strictEqual(r.status, 404, "status preserved");
    assert.strictEqual(await r.text(), "nope", "body preserved");
  });

  await check("a rejected fetch still rejects its caller", async () => {
    const env = makeEnv().run();
    const p = env.window.fetch(URL_ITEM, AUTH);
    env.net[0].reject(new Error("boom"));
    await assert.rejects(p, /boom/, "rejection propagates");
    assert.strictEqual(env.window.__shellPA.err, 0, "not swallowed as error");
  });

  // ---- 9. mutation flush ---------------------------------------------------
  await check("a POST over fetch flushes the store", async () => {
    const env = await primed();
    env.window.fetch("http://srv/Items/" + ID + "/PlaybackInfo", {
      method: "POST",
      body: "{}",
    });
    await env.drain();
    assert.strictEqual(env.window.__shellPA.fl, 1, "flushed");
    const before = env.net.length;
    env.window.fetch(URL_ITEM, AUTH);
    await env.drain();
    assert.strictEqual(env.net.length, before + 1, "nothing left to serve");
  });

  await check("a POST over XHR flushes the store", async () => {
    const env = await primed();
    const x = new env.window.XMLHttpRequest();
    x.open("POST", "http://srv/Users/u1/PlayedItems/" + ID);
    assert.strictEqual(env.window.__shellPA.fl, 1, "flushed");
    assert.strictEqual(
      env.xhrOpens.length,
      1,
      "the original open still ran through",
    );
    const before = env.net.length;
    env.window.fetch(URL_ITEM, AUTH);
    await env.drain();
    assert.strictEqual(env.net.length, before + 1, "nothing left to serve");
  });

  await check("a foreign plugin POST does NOT flush the store", async () => {
    // The rig caught POST /JellyfinEnhanced/user-settings/{u}/settings.json
    // landing mid-dwell and emptying the store on every single run.
    const env = await primed();
    env.window.fetch("http://srv/JellyfinEnhanced/user-settings/u1/x.json", {
      method: "POST",
      body: "{}",
    });
    await env.drain();
    assert.strictEqual(env.window.__shellPA.fl, 0, "not flushed");
    assert.strictEqual(env.window.__shellPA.fs, 1, "counted as skipped");
    const before = env.net.length;
    await env.window.fetch(URL_ITEM, AUTH);
    assert.strictEqual(env.net.length, before, "entry survived, still served");
  });

  await check("playReplayFlushAll='1' restores the blanket flush", async () => {
    const env = await primed({
      store: { "jellyfin.shell.playReplayFlushAll": "1" },
    });
    env.window.fetch("http://srv/JellyfinEnhanced/user-settings/u1/x.json", {
      method: "POST",
      body: "{}",
    });
    await env.drain();
    assert(env.window.__shellPA.fl > 0, "flushed");
    const before = env.net.length;
    env.window.fetch(URL_ITEM, AUTH);
    await env.drain();
    assert.strictEqual(env.net.length, before + 1, "nothing left to serve");
  });

  await check("a GET over XHR does NOT flush", async () => {
    const env = await primed();
    const x = new env.window.XMLHttpRequest();
    x.open("GET", URL_ITEM);
    assert.strictEqual(env.window.__shellPA.fl, 0, "not flushed");
  });

  // ---- 10. TTL -------------------------------------------------------------
  await check("a recorded entry EXPIRES after the TTL", async () => {
    const env = await primed();
    await env.advance(300001);
    const before = env.net.length;
    env.window.fetch(URL_ITEM, AUTH);
    await env.drain();
    assert.strictEqual(env.net.length, before + 1, "entry gone");
    assert.strictEqual(env.window.__shellPA.srv, 0, "nothing served");
  });

  // ---- 11. every caller gets its own readable body -------------------------
  await check("each served body is independently readable", async () => {
    const env = await primed();
    const a = await env.window.fetch(URL_ITEM, AUTH);
    await env.click([{ cls: "btnPlay" }]); // re-opens the budget
    const b = await env.window.fetch(URL_ITEM, AUTH);
    assert.notStrictEqual(a, b, "distinct Response objects");
    assert.strictEqual(await a.text(), ITEM_BODY, "first body readable");
    assert.strictEqual(await b.text(), ITEM_BODY, "second body readable");
  });

  await check("the recorded response headers are replayed", async () => {
    const env = makeEnv().run();
    const p = env.window.fetch(URL_ITEM, AUTH);
    await env.serveOnly(ITEM_BODY, {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
    await p;
    await env.advance(2000);
    const r = await env.window.fetch(URL_ITEM, AUTH);
    assert.strictEqual(
      r.headers.get("content-type"),
      "application/json; charset=utf-8",
      "content-type survives the replay",
    );
  });

  // ---- 12. credentials/mode are part of the key ----------------------------
  await check("a different request mode does not share an entry", async () => {
    const env = makeEnv().run();
    env.window.fetch(URL_ITEM, { headers: {}, mode: "no-cors" });
    await env.serveOnly(ITEM_BODY, { status: 200 });
    await env.advance(2000);
    const before = env.net.length;
    env.window.fetch(URL_ITEM, AUTH);
    await env.drain();
    assert.strictEqual(env.net.length, before + 1, "cors caller not served");
  });

  await check("unset credentials/mode join their explicit twins", async () => {
    const env = makeEnv().run();
    env.window.fetch(URL_ITEM, {
      headers: {},
      credentials: "same-origin",
      mode: "cors",
    });
    await env.serveOnly(ITEM_BODY);
    await env.advance(2000);
    const before = env.net.length;
    await env.window.fetch(URL_ITEM, { headers: {} });
    assert.strictEqual(env.net.length, before, "served — same normalised key");
  });

  // ---- 13. kill-switch and tunables ----------------------------------------
  await check(
    "playReplayDisabled='1' stands the whole thing down",
    async () => {
      const env = makeEnv({
        store: { "jellyfin.shell.playReplayDisabled": "1" },
      }).run();
      assert(!env.window.__shellPA, "no state");
      env.window.fetch(URL_ITEM, AUTH);
      env.window.fetch(URL_ITEM, AUTH);
      await env.drain();
      assert.strictEqual(env.net.length, 2, "both reached the network");
    },
  );

  await check("playReplayTtlMs='0' disables recording", async () => {
    const env = makeEnv({
      store: { "jellyfin.shell.playReplayTtlMs": "0" },
    }).run();
    env.window.fetch(URL_ITEM, AUTH);
    await env.serveOnly(ITEM_BODY);
    assert.strictEqual(env.window.__shellPA.rec, 0, "nothing recorded");
    const before = env.net.length;
    env.window.fetch(URL_ITEM, AUTH);
    await env.drain();
    assert.strictEqual(env.net.length, before + 1, "network");
  });

  await check("out-of-range tunables keep the defaults", async () => {
    const env = makeEnv({
      store: {
        "jellyfin.shell.playReplayTtlMs": "9999999",
        "jellyfin.shell.playReplayArmMs": "-1",
        "jellyfin.shell.playReplayIntrosMs": "nope",
        "jellyfin.shell.playReplayIntrosMax": "999",
      },
    }).run();
    const PA = env.window.__shellPA;
    assert.strictEqual(PA.t, 300000, "TTL default kept");
    assert.strictEqual(PA.w, 6000, "arm default kept");
    assert.strictEqual(PA.d, 1500, "intros delay default kept");
    assert.strictEqual(PA.m, 12, "intros cap default kept");
  });

  await check("in-range tunables are honoured", async () => {
    const env = makeEnv({
      store: {
        "jellyfin.shell.playReplayTtlMs": "60000",
        "jellyfin.shell.playReplayArmMs": "2000",
        "jellyfin.shell.playReplayIntrosMs": "0",
        "jellyfin.shell.playReplayIntrosMax": "1",
      },
    }).run();
    const PA = env.window.__shellPA;
    assert.strictEqual(PA.t, 60000, "TTL honoured");
    assert.strictEqual(PA.w, 2000, "arm honoured");
    assert.strictEqual(PA.d, 0, "intros delay honoured");
    assert.strictEqual(PA.m, 1, "intros cap honoured");
  });

  // ---- 13a. the min-age floor (rig-found) ---------------------------------
  // The detail route issues its item GET four times inside ~250 ms. Without a
  // floor those calls spend the single replay budget among themselves and
  // whether the play click 18 s later finds one left comes down to parity.
  // The floor hands that burst back to the JELA-752 coalescer.
  await check("a repeat INSIDE the min-age floor is not served", async () => {
    const env = await recorded();
    const before = env.net.length;
    env.window.fetch(URL_ITEM, AUTH);
    await env.drain();
    assert.strictEqual(env.net.length, before + 1, "went to the network");
    assert.strictEqual(env.window.__shellPA.srv, 0, "nothing served");
  });

  await check("the detail burst never spends the play budget", async () => {
    const env = makeEnv().run();
    for (let i = 0; i < 4; i++) env.window.fetch(URL_ITEM, AUTH);
    await env.drain();
    for (const c of env.net.filter((x) => !x._done)) {
      c._done = true;
      c.resolve(new env.Response(ITEM_BODY, {}));
    }
    await env.drain();
    assert.strictEqual(env.window.__shellPA.srv, 0, "burst served nothing");
    await env.advance(2000);
    const before = env.net.length;
    await env.window.fetch(URL_ITEM, AUTH); // the play hop
    assert.strictEqual(env.net.length, before, "play hop served");
    assert.strictEqual(env.window.__shellPA.srv, 1, "exactly one serve");
  });

  await check("playReplayMinAgeMs is clamped and honoured", async () => {
    assert.strictEqual(
      makeEnv({ store: { "jellyfin.shell.playReplayMinAgeMs": "99999" } }).run()
        .window.__shellPA.a,
      2000,
      "out-of-range keeps the default",
    );
    assert.strictEqual(
      makeEnv({ store: { "jellyfin.shell.playReplayMinAgeMs": "500" } }).run()
        .window.__shellPA.a,
      500,
      "in-range honoured",
    );
  });

  // ---- 13b. the route gate (rig-found) ------------------------------------
  // The first rig run recorded NINE item bodies — four of them home-row cards
  // fetched during boot — and prefetched intros for every one, which wasted
  // four boot requests AND evicted the detail item before the play click could
  // use it (srv:0). Only the item the user is standing on may be recorded.
  await check("an item that is not the current route is skipped", async () => {
    const env = makeEnv().run();
    const other = "ffffffffffffffffffffffffffffffff";
    env.window.fetch(BASE + other, AUTH);
    await env.serveOnly(ITEM_BODY);
    const PA = env.window.__shellPA;
    assert.strictEqual(PA.rec, 0, "not recorded");
    assert.strictEqual(PA.pf, 0, "and no intros prefetched for it");
    assert.strictEqual(PA.skip, 1, "counted as skipped");
  });

  await check(
    "a home card fetched before any detail route is skipped",
    async () => {
      const env = makeEnv().run();
      env.location.hash = "#!/home";
      env.window.fetch(URL_ITEM, AUTH);
      await env.serveOnly(ITEM_BODY);
      assert.strictEqual(env.window.__shellPA.rec, 0, "boot card not recorded");
      assert.strictEqual(env.window.__shellPA.pf, 0, "no boot prefetch");
    },
  );

  await check(
    "the route is tested at REQUEST time, not response time",
    async () => {
      const env = makeEnv().run();
      env.window.fetch(URL_ITEM, AUTH);
      // The user navigates away while the body is still in flight.
      env.location.hash = "#!/home";
      await env.serveOnly(ITEM_BODY);
      assert.strictEqual(env.window.__shellPA.rec, 1, "still recorded");
    },
  );

  // ---- 13c. one prefetch per item (rig-found) ------------------------------
  // The detail route issues its item GET several times over; without a
  // scheduled-set every one of them queues its own /Intros and they all find
  // the store still empty when they fire. The first rig run issued two.
  await check(
    "repeat item GETs schedule exactly ONE intros prefetch",
    async () => {
      const env = makeEnv().run();
      for (let i = 0; i < 4; i++) env.window.fetch(URL_ITEM, AUTH);
      await env.drain();
      for (const c of env.net.filter((x) => !x._done)) {
        c._done = true;
        c.resolve(new env.Response(ITEM_BODY, {}));
      }
      await env.drain();
      assert.strictEqual(env.window.__shellPA.rec, 4, "all four recorded");
      assert.strictEqual(env.window.__shellPA.pf, 1, "but ONE prefetch");
      await env.advance(1500);
      const intros = env.net.filter((c) => c.url === URL_INTROS);
      assert.strictEqual(intros.length, 1, "one /Intros on the wire");
    },
  );

  // ---- 13d. the click listener must survive document.write (rig-found) -----
  // The shell hands off with document.write(), which implicitly calls
  // document.open() and drops every document listener. The first rig run came
  // back ev:0 for exactly that reason.
  await check("the click listener is bound to WINDOW", async () => {
    const env = makeEnv().run();
    const onWindow = env.listeners.filter(
      (l) => l.type === "click" && l.on === "window",
    );
    assert.strictEqual(onWindow.length, 1, "registered on window");
    assert.strictEqual(onWindow[0].capture, true, "capture phase");
  });

  await check(
    "window+document registrations do not double-count a click",
    async () => {
      const env = await primed();
      await env.click([{ cls: "btnPlay" }]);
      assert.strictEqual(env.window.__shellPA.ev, 1, "counted once");
      assert.strictEqual(env.window.__shellPA.arm, 1, "armed once");
    },
  );

  // ---- 14. install discipline ----------------------------------------------
  await check("re-run body never double-wraps fetch", async () => {
    const env = makeEnv().run();
    const first = env.window.fetch;
    env.run();
    assert.strictEqual(env.window.fetch, first, "fetch not re-wrapped");
    assert.strictEqual(env.window.__shellPA.rec, 0, "state not reset");
  });

  await check("engines without Response stand the store down", async () => {
    const env = makeEnv({ noResponse: true }).run();
    assert(!env.window.__shellPA, "no state without a Response constructor");
    env.window.fetch(URL_ITEM, AUTH);
    env.window.fetch(URL_ITEM, AUTH);
    await env.drain();
    assert.strictEqual(env.net.length, 2, "both callers hit the network");
  });

  // ---- 15. composition with the JELA-752 coalescer -------------------------
  await check("a served replay never reaches the coalescer", async () => {
    const env = makeEnv({ withCoalescer: true }).run();
    assert(env.window.__shellFC, "coalescer installed");
    env.window.fetch(URL_ITEM, AUTH);
    await env.serveOnly(ITEM_BODY);
    await env.advance(2000); // clear the min-age floor (fires the prefetch)
    const leadBefore = env.window.__shellFC.lead;
    await env.window.fetch(URL_ITEM, AUTH);
    assert.strictEqual(env.window.__shellPA.srv, 1, "replay store served it");
    assert.strictEqual(
      env.window.__shellFC.lead,
      leadBefore,
      "the coalescer never saw the call",
    );
  });

  if (failures) {
    console.error("\n" + failures + " check(s) FAILED");
    process.exit(1);
  }
  console.log("\nplay-replay: all checks passed");
}

main();
