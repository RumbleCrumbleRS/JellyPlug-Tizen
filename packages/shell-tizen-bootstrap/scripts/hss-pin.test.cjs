/*
 * JELA-703 (JELA-693 mitigation; upstream home-sections#269): client-side
 * pinned pageHash for /HomeScreen/Sections — opt-in via
 * localStorage['jellyfin.shell.hssPin']='1', default OFF.
 *
 * Extracts the SHIPPED instantHomeBody() and drives it through a virtual
 * clock + DOM stub + controllable XHR/fetch, pinning:
 *   - default OFF: no flag -> no __shellPH state, URLs pass untouched
 *   - ON: a GET whose path ends /HomeScreen/Sections gains
 *     PageHash=<Guid>&Page=1&NumResultsPerPage=1000 on both the fetch and
 *     the XHR path, and the Guid is in canonical 8-4-4-4-12 hex form
 *   - deterministic: same user + same bucket -> same key, fetch and XHR
 *     agree, repeat calls agree
 *   - per-user: a different UserId derives a different key (the plugin's
 *     cache reads are not user-scoped — shared keys share section lists)
 *   - time-bucketed: crossing the bucket boundary re-derives the key;
 *     'jellyfin.shell.hssPinBucketSecs' tunes the bucket within 60..86400
 *     and out-of-range values fall back to 3600
 *   - never fights the plugin's own pagination: a URL already carrying a
 *     PageHash (any case) is untouched
 *   - scope: /HomeScreen/Section/<name> fan-out, other paths, POSTs and
 *     non-string fetch inputs are untouched; missing creds -> untouched
 *   - one install per WINDOW: a re-run body (document.write swap) never
 *     double-appends
 *   - composition with JELA-51/685 apiWarm: the warm's own Sections XHR
 *     goes out PINNED (it seeds the entry the SPA's pinned request finds)
 *     while the store still serves the SPA's pre-rewrite URL
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
assert(body.indexOf("jellyfin.shell.hssPin") !== -1, "opt-in flag present");
assert(
  body.indexOf("jellyfin.shell.hssPinBucketSecs") !== -1,
  "bucket override honored",
);
assert(body.indexOf("</script") === -1, "no </script literal");
assert(body.indexOf("=>") === -1, "body must be ES5 (no arrow functions)");
assert(body.indexOf("`") === -1, "body must be ES5 (no template literals)");

const GUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UID = "u1";
const CREDS = JSON.stringify({
  Servers: [
    { Id: "s1", AccessToken: "tok", UserId: UID, ManualAddress: "http://alt" },
  ],
});
const SECTIONS = JSON.stringify({
  Items: [{ Section: "MyMedia" }, { Section: "NextUp" }],
});

function makeEnv(opts) {
  opts = opts || {};
  let now = opts.now || 0;
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
      // JELA-839 made queryAuth opt-OUT, so an empty store now arms the
      // JELA-740 shim and every pinned URL below would also gain
      // &api_key=<token>. This suite pins the PageHash rewrite, so it stands
      // that layer down; the hssPin x queryAuth composition is owned by
      // query-auth.test.cjs ("composition with JELA-703 hssPin").
      "jellyfin.shell.queryAuth": "0",
    },
    opts.pinOff ? {} : { "jellyfin.shell.hssPin": "1" },
    opts.warm ? { "jellyfin.shell.apiWarm": "1" } : {},
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

  return {
    window,
    document,
    store,
    xcalls,
    netCalls,
    FakeXHR,
    setNow(t) {
      now = t;
    },
    tick(ms) {
      now += ms || 0;
      for (const [id, t] of [...timers]) {
        if (t.next <= now) {
          if (!t.repeat) timers.delete(id);
          else t.next = now + t.ms;
          t.cb();
        }
      }
    },
    pendingX() {
      return xcalls.filter((x) => x.readyState !== 4 && !x.aborted);
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
  };
}

function pinnedParams(url) {
  const m = /[?&]PageHash=([^&]*)&Page=1&NumResultsPerPage=1000$/.exec(url);
  return m ? m[1] : null;
}

// ---- 1. default OFF ---------------------------------------------------------
{
  const env = makeEnv({ pinOff: true });
  env.run();
  assert(!env.window.__shellPH, "no flag -> no __shellPH state");
  env.window.fetch("http://srv/HomeScreen/Sections?UserId=" + UID);
  assert.strictEqual(
    env.netCalls[0].url,
    "http://srv/HomeScreen/Sections?UserId=" + UID,
    "fetch URL untouched when OFF",
  );
  const x = new env.window.XMLHttpRequest();
  x.open("GET", "http://srv/HomeScreen/Sections?UserId=" + UID);
  assert.strictEqual(
    x.url,
    "http://srv/HomeScreen/Sections?UserId=" + UID,
    "XHR URL untouched when OFF",
  );
}

// ---- 2. ON: fetch + XHR pinned with a canonical Guid, deterministically -----
{
  const env = makeEnv();
  env.run();
  assert(env.window.__shellPH && env.window.__shellPH.on, "__shellPH present");
  env.window.fetch("http://srv/HomeScreen/Sections?UserId=" + UID);
  const k1 = pinnedParams(env.netCalls[0].url);
  assert(k1, "fetch URL pinned: " + env.netCalls[0].url);
  assert(GUID_RE.test(k1), "key is a canonical Guid: " + k1);
  assert(
    env.netCalls[0].url.indexOf(
      "http://srv/HomeScreen/Sections?UserId=" + UID + "&PageHash=",
    ) === 0,
    "original URL preserved as prefix",
  );

  const x = new env.window.XMLHttpRequest();
  x.open("GET", "http://srv/HomeScreen/Sections?UserId=" + UID);
  const k2 = pinnedParams(x.url);
  assert(k2, "XHR URL pinned: " + x.url);
  assert.strictEqual(k1, k2, "fetch and XHR derive the same key");

  env.window.fetch("http://srv/HomeScreen/Sections?UserId=" + UID);
  assert.strictEqual(
    pinnedParams(env.netCalls[1].url),
    k1,
    "repeat call in the same bucket repeats the key",
  );
  assert.strictEqual(env.window.__shellPH.n, 3, "rewrite counter tracks");
  assert.strictEqual(env.window.__shellPH.u, k1, "last key surfaced");

  // querystring-less path still gains a "?"
  env.window.fetch("http://srv/HomeScreen/Sections");
  assert(
    /\?PageHash=/.test(env.netCalls[2].url),
    "no-query URL pinned with '?'",
  );
}

// ---- 3. per-user + per-bucket derivation ------------------------------------
{
  const envA = makeEnv();
  envA.run();
  envA.window.fetch("http://srv/HomeScreen/Sections?UserId=" + UID);
  const kA = pinnedParams(envA.netCalls[0].url);

  const envB = makeEnv({
    creds: JSON.stringify({
      Servers: [{ Id: "s1", AccessToken: "tok", UserId: "u2" }],
    }),
  });
  envB.run();
  envB.window.fetch("http://srv/HomeScreen/Sections?UserId=u2");
  const kB = pinnedParams(envB.netCalls[0].url);
  assert(kA && kB && kA !== kB, "different users derive different keys");

  // bucket roll: 60 s bucket, cross the boundary -> new key
  const envC = makeEnv({
    store: { "jellyfin.shell.hssPinBucketSecs": "60" },
  });
  envC.run();
  envC.window.fetch("http://srv/HomeScreen/Sections?UserId=" + UID);
  const kC1 = pinnedParams(envC.netCalls[0].url);
  envC.setNow(59 * 1000);
  envC.window.fetch("http://srv/HomeScreen/Sections?UserId=" + UID);
  const kC2 = pinnedParams(envC.netCalls[1].url);
  assert.strictEqual(kC1, kC2, "same 60 s bucket -> same key");
  envC.setNow(61 * 1000);
  envC.window.fetch("http://srv/HomeScreen/Sections?UserId=" + UID);
  const kC3 = pinnedParams(envC.netCalls[2].url);
  assert(kC3 && kC3 !== kC1, "crossing the bucket boundary re-derives");

  // out-of-range override falls back to 3600 (59 s stays in bucket 0)
  const envD = makeEnv({
    store: { "jellyfin.shell.hssPinBucketSecs": "5" },
  });
  envD.run();
  envD.window.fetch("http://srv/HomeScreen/Sections?UserId=" + UID);
  envD.setNow(59 * 1000);
  envD.window.fetch("http://srv/HomeScreen/Sections?UserId=" + UID);
  assert.strictEqual(
    pinnedParams(envD.netCalls[0].url),
    pinnedParams(envD.netCalls[1].url),
    "out-of-range bucket override ignored (3600 s default holds)",
  );
}

// ---- 4. never touched: pre-existing PageHash, other paths, POST, no creds ---
{
  const env = makeEnv();
  env.run();
  const untouched = [
    "http://srv/HomeScreen/Sections?UserId=u1&PageHash=abc&Page=2",
    "http://srv/HomeScreen/Sections?UserId=u1&pageHash=abc",
    "http://srv/HomeScreen/Section/NextUp?UserId=u1",
    "http://srv/HomeScreen/SectionsExtra?UserId=u1",
    "http://srv/System/Info",
  ];
  for (const u of untouched) {
    env.window.fetch(u);
    assert.strictEqual(
      env.netCalls[env.netCalls.length - 1].url,
      u,
      "untouched: " + u,
    );
  }
  env.window.fetch("http://srv/HomeScreen/Sections?UserId=u1", {
    method: "POST",
  });
  assert.strictEqual(
    env.netCalls[env.netCalls.length - 1].url,
    "http://srv/HomeScreen/Sections?UserId=u1",
    "POST fetch untouched",
  );
  const x = new env.window.XMLHttpRequest();
  x.open("POST", "http://srv/HomeScreen/Sections?UserId=u1");
  assert.strictEqual(
    x.url,
    "http://srv/HomeScreen/Sections?UserId=u1",
    "POST XHR untouched",
  );
  assert.strictEqual(env.window.__shellPH.n, 0, "no rewrites counted");

  const envNC = makeEnv({ creds: "null" });
  envNC.run();
  envNC.window.fetch("http://srv/HomeScreen/Sections?UserId=u1");
  assert.strictEqual(
    envNC.netCalls[0].url,
    "http://srv/HomeScreen/Sections?UserId=u1",
    "no creds -> untouched",
  );
}

// ---- 5. one install per window: re-run body never double-appends ------------
{
  const env = makeEnv();
  env.run();
  env.run(); // document.write swap re-runs the body in the same window
  env.window.fetch("http://srv/HomeScreen/Sections?UserId=" + UID);
  const u = env.netCalls[0].url;
  assert.strictEqual(
    (u.match(/PageHash=/g) || []).length,
    1,
    "exactly one PageHash after body re-run: " + u,
  );
}

// ---- 6. composition with apiWarm: warm XHR pinned, store still serves -------
{
  const env = makeEnv({ warm: true });
  env.run();
  const warmX = env.xcalls.find(
    (x) => x.url.indexOf("/HomeScreen/Sections?") !== -1,
  );
  assert(warmX, "warm issued a Sections request");
  const kW = pinnedParams(warmX.url);
  assert(kW, "warm Sections XHR goes out PINNED: " + warmX.url);
  assert.strictEqual(
    warmX.headers["X-Emby-Token"],
    "tok",
    "warm request still authenticated",
  );

  // resolve every in-flight prefetch so the store fills
  for (let guard = 0; guard < 30 && env.pendingX().length; guard++) {
    for (const x of env.pendingX()) {
      x.__respond(
        200,
        x.url.indexOf("/HomeScreen/Sections?") !== -1 ? SECTIONS : '{"ok":1}',
      );
    }
  }

  // the SPA asks with its ORIGINAL (pre-rewrite) URL shape; apiWarm's open
  // patch records that URL before the pin rewrites it, so the store key
  // still matches and the request is served without touching the network.
  const before = env.xcalls.length;
  const spa = new env.window.XMLHttpRequest();
  spa.open("GET", "http://srv/HomeScreen/Sections?UserId=" + UID);
  let delivered = 0;
  spa.onreadystatechange = function () {
    if (spa.readyState === 4) delivered = 1;
  };
  spa.send();
  env.tick(1); // fire the deferred store delivery (setTimeout(go, 0))
  assert(
    env.window.__shellAW && env.window.__shellAW.hits >= 1,
    "store hit recorded",
  );
  assert.strictEqual(env.xcalls.length, before, "no network XHR for the SPA");
  assert(delivered, "SPA request delivered from the store");
  assert.strictEqual(
    String(spa.responseText),
    SECTIONS,
    "served the warm Sections body",
  );
}

console.log("hss-pin.test.cjs OK");
