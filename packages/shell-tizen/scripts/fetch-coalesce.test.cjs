/*
 * JELA-724: in-flight GET coalescer for allowlisted API paths.
 *
 * Plugin Pages 2.4.11.0 calls populateSidebar() once per added node inside
 * one MutationObserver batch (its `initialized` guard is tested only at the
 * top of mutationHandler, never inside the walk), so the JELA-720 census saw
 * SIX identical GET /PluginPages/User inside a 6 ms window on both cold
 * boots — 12 round trips, each GET dragging its own CORS preflight, for one
 * 345-byte body.
 *
 * Extracts the SHIPPED instantHomeBody() and drives it through the same
 * stubbed window the other instantHomeBody tests use, plus a controllable
 * fetch and a Response stub, pinning:
 *   - default ON: N concurrent identical allowlisted GETs -> ONE network
 *     call; every caller (leader included) gets its OWN Response whose body
 *     is independently readable, with the leader's status/headers preserved
 *   - NOT a cache: the slot is released when the leader's body is read, so a
 *     later GET goes to the network again (no staleness window)
 *   - scope: non-allowlisted paths, POSTs, bodies, AbortSignals and Request
 *     objects are never coalesced and reach the network untouched
 *   - a leader that rejects replays every waiter on the real network
 *     (worst case = pre-JELA-724 behaviour) and the leader itself rejects
 *   - suffix matching cannot be spoofed by a longer path segment
 *   - kill-switch jellyfin.shell.fetchCoalesceDisabled='1' restores the
 *     fetch-per-caller behaviour
 *   - jellyfin.shell.fetchCoalescePaths adds paths in the field, rejects
 *     entries that do not start with "/", and is capped at 32 total
 *   - one install per WINDOW: a re-run body (document.write swap) never
 *     double-wraps fetch
 *   - engines without a Response constructor stand the whole thing down
 *   - composition with JELA-51/685 apiWarm: the warm patch installs OUTSIDE
 *     the coalescer, so the warm store keeps first refusal
 *
 * Run: node scripts/fetch-coalesce.test.cjs
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

const PP = "/PluginPages/User";
const CREDS = JSON.stringify({
  Servers: [{ Id: "s1", AccessToken: "tok", UserId: "u1" }],
});

// ---- static contract checks ------------------------------------------------
assert(
  body.indexOf("jellyfin.shell.fetchCoalesceDisabled") !== -1,
  "kill-switch key present",
);
assert(
  body.indexOf("jellyfin.shell.fetchCoalescePaths") !== -1,
  "field override key present",
);
assert(body.indexOf('"' + PP + '"') !== -1, "default allowlist carries " + PP);
assert(body.indexOf("</script") === -1, "no </script literal");
assert(body.indexOf("=>") === -1, "body must be ES5 (no arrow functions)");
assert(body.indexOf("`") === -1, "body must be ES5 (no template literals)");
// The coalescer must be installed BEFORE the api-warm fetch patch so the warm
// store (which is one-shot) keeps first refusal on the URLs it prefetched.
assert(
  body.indexOf("__shellFC") < body.indexOf("__shellAW"),
  "coalescer installs before api-warm",
);

// ---- environment -----------------------------------------------------------
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
      init.headers instanceof Headers ? init.headers : new Headers(init.headers);
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

const URL_PP = "http://srv" + PP;
const PAYLOAD = JSON.stringify({
  TotalRecordCount: 1,
  Items: [{ Id: "a", Url: "u", Icon: "i", DisplayText: "d" }],
});

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
  // ---- 1. six concurrent identical GETs collapse to ONE network request ----
  await check("6 concurrent GETs -> 1 network call, 6 usable bodies", async () => {
    const env = makeEnv().run();
    assert(env.window.__shellFC && env.window.__shellFC.on, "__shellFC present");
    const ps = [];
    for (let i = 0; i < 6; i++) ps.push(env.window.fetch(URL_PP));
    assert.strictEqual(env.net.length, 1, "exactly one network call issued");
    assert.strictEqual(env.net[0].url, URL_PP, "leader carries the real URL");
    await env.serve(env.net[0], PAYLOAD, {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
    });
    const rs = await Promise.all(ps);
    assert.strictEqual(rs.length, 6);
    // Every caller must be able to read its OWN body: a shared Response would
    // let caller 1 drain the stream and break callers 2..6.
    const bodies = await Promise.all(rs.map((r) => r.json()));
    for (const b of bodies) assert.strictEqual(b.TotalRecordCount, 1);
    for (const r of rs) {
      assert.strictEqual(r.status, 200, "status preserved");
      assert.strictEqual(
        r.headers.get("content-type"),
        "application/json",
        "content-type preserved",
      );
    }
    const FC = env.window.__shellFC;
    assert.strictEqual(FC.lead, 1, "one leader");
    assert.strictEqual(FC.join, 5, "five joins");
    assert.strictEqual(FC.serve, 6, "six synthesized responses");
    assert.strictEqual(FC.err, 0, "no internal errors");
    assert.strictEqual(env.net.length, 1, "still one network call after settle");
  });

  // ---- 2. in-flight only: NOT a cache -------------------------------------
  await check("released after the leader settles (no staleness window)", async () => {
    const env = makeEnv().run();
    const a = env.window.fetch(URL_PP);
    await env.serve(env.net[0], PAYLOAD);
    await a;
    env.window.fetch(URL_PP);
    assert.strictEqual(env.net.length, 2, "a later GET re-fetches");
    assert.strictEqual(env.window.__shellFC.lead, 2, "counted as a new leader");
    assert.strictEqual(env.window.__shellFC.join, 0, "no join");
  });

  // ---- 3. scope: what must NEVER be coalesced -----------------------------
  await check("non-allowlisted / POST / body / signal / Request pass through", async () => {
    const env = makeEnv().run();
    const cases = [
      ["http://srv/Users/u1", undefined],
      [URL_PP, { method: "POST" }],
      [URL_PP, { body: "x" }],
      [URL_PP, { signal: {} }],
    ];
    for (const [u, o] of cases) {
      env.net.length = 0;
      env.window.fetch(u, o);
      env.window.fetch(u, o);
      assert.strictEqual(
        env.net.length,
        2,
        "not coalesced: " + u + " " + JSON.stringify(o),
      );
    }
    // A Request object (not a string URL) is opted out — its headers/signal
    // are invisible to the key.
    env.net.length = 0;
    env.window.fetch({ url: URL_PP, method: "GET" });
    env.window.fetch({ url: URL_PP, method: "GET" });
    assert.strictEqual(env.net.length, 2, "Request object not coalesced");
    assert.strictEqual(env.window.__shellFC.join, 0, "no joins recorded");
  });

  // ---- 4. distinct query strings are distinct keys ------------------------
  await check("query string is part of the key; fragment is not", async () => {
    const env = makeEnv().run();
    env.window.fetch(URL_PP + "?a=1");
    env.window.fetch(URL_PP + "?a=2");
    assert.strictEqual(env.net.length, 2, "different queries do not share");
    env.window.fetch(URL_PP + "?a=1#frag");
    assert.strictEqual(env.net.length, 2, "fragment stripped -> joins ?a=1");
    assert.strictEqual(env.window.__shellFC.join, 1);
  });

  // ---- 5. suffix match cannot be spoofed ----------------------------------
  await check("suffix match requires the leading slash", async () => {
    const env = makeEnv().run();
    const spoof = "http://srv/api/FakePluginPages/User";
    env.window.fetch(spoof);
    env.window.fetch(spoof);
    assert.strictEqual(env.net.length, 2, "FakePluginPages/User not matched");
    // ...but a genuine nested mount point still matches.
    env.net.length = 0;
    env.window.fetch("http://srv/base" + PP);
    env.window.fetch("http://srv/base" + PP);
    assert.strictEqual(env.net.length, 1, "/base/PluginPages/User matched");
  });

  // ---- 6. a rejecting leader replays every waiter -------------------------
  await check("leader rejection replays waiters on the network", async () => {
    const env = makeEnv().run();
    const lead = env.window.fetch(URL_PP);
    lead.catch(function () {}); // prevent unhandled-rejection before assert.rejects
    const w1 = env.window.fetch(URL_PP);
    const w2 = env.window.fetch(URL_PP);
    assert.strictEqual(env.net.length, 1);
    const boom = new Error("network down");
    env.net[0].reject(boom);
    await env.drain();
    await assert.rejects(() => lead, /network down/, "leader rejects natively");
    assert.strictEqual(env.net.length, 3, "both waiters replayed for real");
    assert.strictEqual(env.window.__shellFC.rep, 2, "replays counted");
    env.net[1].resolve(new env.Response(PAYLOAD));
    env.net[2].resolve(new env.Response(PAYLOAD));
    assert.strictEqual((await (await w1).json()).TotalRecordCount, 1);
    assert.strictEqual((await (await w2).json()).TotalRecordCount, 1);
  });

  // ---- 7. null-body statuses are synthesized without a body ---------------
  await check("204 is synthesized with a null body", async () => {
    const env = makeEnv().run();
    const ps = [env.window.fetch(URL_PP), env.window.fetch(URL_PP)];
    await env.serve(env.net[0], "", { status: 204 });
    const rs = await Promise.all(ps);
    for (const r of rs) {
      assert.strictEqual(r.status, 204);
      assert.strictEqual(await r.text(), "");
    }
  });

  // ---- 8. kill-switch ------------------------------------------------------
  await check("fetchCoalesceDisabled='1' restores fetch-per-caller", async () => {
    const env = makeEnv({
      store: { "jellyfin.shell.fetchCoalesceDisabled": "1" },
    }).run();
    assert(!env.window.__shellFC, "no coalescer state when disabled");
    env.window.fetch(URL_PP);
    env.window.fetch(URL_PP);
    assert.strictEqual(env.net.length, 2, "both callers hit the network");
  });

  // ---- 9. field-tunable allowlist -----------------------------------------
  await check("fetchCoalescePaths adds paths and rejects bad entries", async () => {
    const env = makeEnv({
      store: {
        "jellyfin.shell.fetchCoalescePaths":
          " /CustomTabs/Config , MediaBar/WebConfig ,/HomeScreen/Meta",
      },
    }).run();
    assert.strictEqual(
      env.window.__shellFC.n,
      3,
      "default + 2 valid overrides (the slash-less one is rejected)",
    );
    env.window.fetch("http://srv/CustomTabs/Config");
    env.window.fetch("http://srv/CustomTabs/Config");
    assert.strictEqual(env.net.length, 1, "added path coalesces");
    env.net.length = 0;
    env.window.fetch("http://srv/MediaBar/WebConfig");
    env.window.fetch("http://srv/MediaBar/WebConfig");
    assert.strictEqual(env.net.length, 2, "entry without a leading / ignored");
  });

  await check("fetchCoalescePaths is capped at 32 entries", async () => {
    const many = [];
    for (let i = 0; i < 64; i++) many.push("/p" + i);
    const env = makeEnv({
      store: { "jellyfin.shell.fetchCoalescePaths": many.join(",") },
    }).run();
    assert.strictEqual(env.window.__shellFC.n, 32, "capped at 32");
  });

  // ---- 10. one install per window -----------------------------------------
  await check("re-run body never double-wraps fetch", async () => {
    const env = makeEnv().run();
    const first = env.window.fetch;
    env.run();
    assert.strictEqual(env.window.fetch, first, "fetch not re-wrapped");
    assert.strictEqual(env.window.__shellFC.lead, 0, "state not reset");
  });

  // ---- 11. no Response constructor -> stand down ---------------------------
  await check("engines without Response stand the coalescer down", async () => {
    const env = makeEnv({ noResponse: true }).run();
    assert(!env.window.__shellFC, "no state without a Response constructor");
    env.window.fetch(URL_PP);
    env.window.fetch(URL_PP);
    assert.strictEqual(env.net.length, 2, "both callers hit the network");
  });

  if (failures) {
    console.error("\n" + failures + " check(s) FAILED");
    process.exit(1);
  }
  console.log("\nfetch-coalesce: all checks passed");
}

main();
