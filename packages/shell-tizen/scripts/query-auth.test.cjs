/*
 * JELA-740 (accepted CEO confirmation 45f50c90): query-param auth for API
 * GETs. JELA-839 flipped it to opt-OUT — an ABSENT
 * localStorage['jellyfin.shell.queryAuth'] now means ON, because the read
 * site is instantHomeBody() at shell boot while the JELA-788 seeder that
 * wrote the '1' runs from the JSI channel AFTER the lite->SPA handoff, so
 * opt-in armed one boot late and left every cold boot paying 65-78 CORS
 * preflights. Two independent per-TV kills: queryAuth='0' (a SET, never a
 * removeItem) and queryAuthDisabled='1'.
 *
 * Extracts the SHIPPED instantHomeBody() and drives it through a DOM stub
 * + controllable XHR/fetch, pinning:
 *   - default ON (JELA-839): absent key -> __shellQA installs; a stored
 *     '1' (an already-seeded fleet TV) behaves identically
 *   - per-TV kill queryAuth='0': no __shellQA state, URLs and headers pass
 *     untouched; queryAuthDisabled beats an armed flag
 *   - ON, fetch + plain-object headers: an absolute GET carrying
 *     Authorization (MediaBrowser ... Token="...") loses the header and
 *     gains api_key=<token>; other headers survive; the CALLER's opts and
 *     headers objects are never mutated
 *   - ON, fetch + Headers instance: same via get/delete on a copy
 *   - X-Emby-Token raw value is accepted as the token source
 *   - scope: POSTs, relative URLs, Request-object inputs, header-less
 *     GETs and URLs already carrying api_key/ApiKey are untouched; an
 *     unparseable token (e.g. Bearer) falls through untouched (sk++)
 *   - XHR path: setRequestHeader buffers, send re-opens on the rewritten
 *     URL and replays only the non-auth headers AFTER the re-open (open
 *     resets headers on a real XHR — the stub models that)
 *   - XHR scope: POST / relative URLs keep the direct setRequestHeader
 *     path (auth header actually applied)
 *   - one install per WINDOW: a re-run body (document.write swap) never
 *     double-wraps fetch or the XHR prototype
 *   - Referer mitigation: a no-referrer meta lands once per document
 *   - composition with JELA-703 hssPin: a pinned Sections GET carries
 *     BOTH PageHash pagination and api_key, header stripped
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
assert(body.indexOf("jellyfin.shell.queryAuth") !== -1, "flag present");
assert(
  body.indexOf("jellyfin.shell.queryAuthDisabled") !== -1,
  "kill-switch honored",
);
// JELA-839: the gate must read through flgO (absent key = ON), not flg.
assert(
  body.indexOf('flgO("jellyfin.shell.queryAuth")') !== -1,
  "JELA-839: queryAuth gate is opt-OUT (flgO)",
);
assert(
  body.indexOf('flg("jellyfin.shell.queryAuth")') === -1,
  "JELA-839: no opt-in (flg) read of queryAuth survives",
);
assert(body.indexOf("</script") === -1, "no </script literal");
assert(body.indexOf("=>") === -1, "body must be ES5 (no arrow functions)");
assert(body.indexOf("`") === -1, "body must be ES5 (no template literals)");

const TOK = "tok740";
const AUTH =
  'MediaBrowser Client="Jellyfin Web", Device="d", DeviceId="i", Version="10", Token="' +
  TOK +
  '"';
const UID = "u1";
const CREDS = JSON.stringify({
  Servers: [
    { Id: "s1", AccessToken: TOK, UserId: UID, ManualAddress: "http://alt" },
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
    return "1970-01-01T00:00:00.000Z";
  };

  function makeNode(tag) {
    return {
      tagName: tag,
      id: "",
      name: "",
      content: "",
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
      insertBefore(n, ref) {
        n.parentNode = this;
        const i = ref ? this.children.indexOf(ref) : -1;
        if (i === -1) this.children.push(n);
        else this.children.splice(i, 0, n);
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
  const head = makeNode("HEAD");
  documentElement.appendChild(head);
  const document = {
    documentElement,
    head,
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

  // ---- controllable XHR stub (open RESETS headers, like a real XHR) ----
  const xcalls = [];
  function FakeXHR() {
    this.readyState = 0;
    this.status = 0;
    this.responseText = "";
    this.responseType = "";
    this.timeout = 0;
    this.headers = {};
    this.headerLog = [];
    this.sent = false;
    this.aborted = false;
    this.opens = [];
  }
  FakeXHR.prototype.open = function (m, u, a) {
    this.method = String(m);
    this.url = String(u);
    this.async = arguments.length > 2 ? !!a : true;
    this.readyState = 1;
    this.headers = {};
    this.opens.push(String(u));
  };
  FakeXHR.prototype.setRequestHeader = function (k, v) {
    this.headers[k] = v;
    this.headerLog.push([k, v]);
  };
  FakeXHR.prototype.send = function () {
    this.sent = true;
    xcalls.push(this);
  };
  FakeXHR.prototype.abort = function () {
    this.aborted = true;
  };
  window.XMLHttpRequest = FakeXHR;

  // ---- minimal Headers polyfill for the Headers-instance path ----
  function FakeHeaders(init) {
    this._m = {};
    if (init && init._m) {
      for (const k in init._m) this._m[k] = init._m[k];
    } else if (init) {
      for (const k in init) this._m[String(k).toLowerCase()] = init[k];
    }
  }
  FakeHeaders.prototype.get = function (k) {
    k = String(k).toLowerCase();
    return k in this._m ? this._m[k] : null;
  };
  FakeHeaders.prototype["delete"] = function (k) {
    delete this._m[String(k).toLowerCase()];
  };
  window.Headers = FakeHeaders;

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
      // This suite unit-tests the queryAuth rewrite in isolation. Without
      // this, the JELA-752 coalescer joins the same-URL GET pairs below
      // (its key is credentials+mode+URL, deliberately not auth headers)
      // and the netCalls indices shift.
      "jellyfin.shell.fetchCoalesceDisabled": "1",
    },
    // JELA-839: opt-OUT. The armed arm is now the ABSENT key, so the default
    // env seeds nothing and `qaOff` must SET "0" — a removeItem is an ON arm.
    opts.qaOff ? { "jellyfin.shell.queryAuth": "0" } : {},
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
    head,
    store,
    xcalls,
    netCalls,
    FakeXHR,
    FakeHeaders,
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

const API = "http://srv/Users/" + UID + "/Items/Latest?Limit=20";

// ---- 1. per-TV kill: queryAuth="0" ------------------------------------------
{
  const env = makeEnv({ qaOff: true });
  env.run();
  assert(!env.window.__shellQA, 'queryAuth="0" -> no __shellQA state');
  env.window.fetch(API, { headers: { Authorization: AUTH } });
  assert.strictEqual(env.netCalls[0].url, API, "fetch URL untouched when OFF");
  assert.strictEqual(
    env.netCalls[0].opts.headers.Authorization,
    AUTH,
    "auth header untouched when OFF",
  );
}

// ---- 1b. JELA-839: an ABSENT key ARMS (this is the whole flip) ---------------
// The cold-boot store below is the first-install state: no queryAuth key at
// all, because the JELA-788 JSI seeder has not run yet on this boot. Before
// JELA-839 this arm was inert and the boot paid a preflight per API GET.
{
  const env = makeEnv({});
  assert(
    env.store["jellyfin.shell.queryAuth"] === undefined,
    "1b: precondition — the cold-boot store holds no queryAuth key",
  );
  env.run();
  const qa = env.window.__shellQA;
  assert(qa && qa.on === 1, "1b: absent key -> __shellQA installs (opt-OUT)");
  env.window.fetch(API, { headers: { Authorization: AUTH } });
  assert.strictEqual(
    env.netCalls[0].url,
    API + "&api_key=" + TOK,
    "1b: cold-boot GET is rewritten to api_key (no preflight)",
  );
  assert.strictEqual(
    env.netCalls[0].opts.headers.Authorization,
    undefined,
    "1b: the non-safelisted auth header is gone",
  );
}

// ---- 1c. an already-seeded fleet TV ("1") behaves identically ----------------
{
  const env = makeEnv({ store: { "jellyfin.shell.queryAuth": "1" } });
  env.run();
  assert(env.window.__shellQA, '1c: stored "1" still arms');
  env.window.fetch(API, { headers: { Authorization: AUTH } });
  assert.strictEqual(
    env.netCalls[0].url,
    API + "&api_key=" + TOK,
    '1c: stored "1" rewrites exactly as the absent key does',
  );
}

// ---- 1d. a THROWING localStorage fails CLOSED -------------------------------
// Compiled out of the SHIPPED helper rather than driven through the whole
// body: under a store that throws for every key the body takes many other
// paths, so a bare "__shellQA is absent" would pass for the wrong reason.
// flgO must catch and return false — a device that cannot read its own kill
// switch must not arm an un-killable feature.
{
  const helper = /'(function flgO\(k\)\{[^']*?\})'/.exec(
    fs.readFileSync(SRC, "utf8"),
  );
  assert(helper, "1d: flgO helper found in the shipped source");
  const flgO = new Function("localStorage", helper[1] + "; return flgO;")({
    getItem() {
      throw new Error("SecurityError");
    },
  });
  assert.strictEqual(
    flgO("jellyfin.shell.queryAuth"),
    false,
    "1d: throwing localStorage -> flgO fails closed",
  );
  const flgOk = new Function("localStorage", helper[1] + "; return flgO;")({
    getItem: () => null,
  });
  assert.strictEqual(
    flgOk("jellyfin.shell.queryAuth"),
    true,
    "1d: absent key -> flgO is ON",
  );
}

// ---- 2. kill-switch beats the flag -----------------------------------------
{
  const env = makeEnv({
    store: { "jellyfin.shell.queryAuthDisabled": "1" },
  });
  env.run();
  assert(!env.window.__shellQA, "queryAuthDisabled -> no install");
}

// ---- 2b. queryAuthDisabled beats an explicitly seeded "1" -------------------
{
  const env = makeEnv({
    store: {
      "jellyfin.shell.queryAuth": "1",
      "jellyfin.shell.queryAuthDisabled": "1",
    },
  });
  env.run();
  assert(!env.window.__shellQA, "2b: Disabled beats a seeded arm");
}

// ---- 3. ON: fetch + plain-object headers ------------------------------------
{
  const env = makeEnv();
  env.run();
  const qa = env.window.__shellQA;
  assert(qa && qa.on === 1, "__shellQA present");
  const hdrs = { Authorization: AUTH, Accept: "application/json" };
  const opts = { method: "GET", headers: hdrs };
  env.window.fetch(API, opts);
  const c = env.netCalls[0];
  assert.strictEqual(
    c.url,
    API + "&api_key=" + TOK,
    "token moved to api_key: " + c.url,
  );
  assert(!("Authorization" in c.opts.headers), "Authorization stripped");
  assert.strictEqual(
    c.opts.headers.Accept,
    "application/json",
    "other headers survive",
  );
  assert.strictEqual(c.opts.method, "GET", "opts copied through");
  assert.strictEqual(hdrs.Authorization, AUTH, "caller headers not mutated");
  assert.strictEqual(opts.headers, hdrs, "caller opts not mutated");
  assert.strictEqual(qa.fr, 1, "fr counted");
  assert.strictEqual(qa.sw, 1, "sw counted");
  // no ? in the path -> api_key starts the query string
  env.window.fetch("http://srv/System/Info", {
    headers: { Authorization: AUTH },
  });
  assert.strictEqual(
    env.netCalls[1].url,
    "http://srv/System/Info?api_key=" + TOK,
    "bare path gains ?api_key",
  );
}

// ---- 4. ON: fetch + Headers instance ---------------------------------------
{
  const env = makeEnv();
  env.run();
  const h = new env.FakeHeaders({ Authorization: AUTH, Accept: "text/html" });
  env.window.fetch(API, { headers: h });
  const c = env.netCalls[0];
  assert.strictEqual(c.url, API + "&api_key=" + TOK, "Headers path rewrites");
  assert(c.opts.headers instanceof env.FakeHeaders, "still a Headers copy");
  assert.strictEqual(
    c.opts.headers.get("Authorization"),
    null,
    "auth deleted on the copy",
  );
  assert.strictEqual(
    c.opts.headers.get("Accept"),
    "text/html",
    "other Headers entries survive",
  );
  assert.strictEqual(h.get("Authorization"), AUTH, "caller Headers untouched");
}

// ---- 5. X-Emby-Token raw value ---------------------------------------------
{
  const env = makeEnv();
  env.run();
  env.window.fetch(API, { headers: { "X-Emby-Token": "raw99" } });
  assert.strictEqual(
    env.netCalls[0].url,
    API + "&api_key=raw99",
    "X-Emby-Token value used directly",
  );
}

// ---- 6. passthrough scope ---------------------------------------------------
{
  const env = makeEnv();
  env.run();
  const qa = env.window.__shellQA;
  const auth = { Authorization: AUTH };
  env.window.fetch(API, { method: "POST", headers: auth });
  assert.strictEqual(env.netCalls[0].url, API, "POST untouched");
  assert.strictEqual(
    env.netCalls[0].opts.headers.Authorization,
    AUTH,
    "POST keeps its auth header",
  );
  env.window.fetch("/Users/Me", { headers: auth });
  assert.strictEqual(env.netCalls[1].url, "/Users/Me", "relative untouched");
  env.window.fetch(API + "&api_key=zzz", { headers: auth });
  assert.strictEqual(
    env.netCalls[2].url,
    API + "&api_key=zzz",
    "existing api_key untouched",
  );
  env.window.fetch("http://srv/x?ApiKey=zzz", { headers: auth });
  assert.strictEqual(
    env.netCalls[3].url,
    "http://srv/x?ApiKey=zzz",
    "existing ApiKey untouched",
  );
  env.window.fetch({ url: API }, { headers: auth });
  assert.strictEqual(
    env.netCalls[4].url,
    API,
    "Request-object input untouched",
  );
  env.window.fetch(API);
  assert.strictEqual(env.netCalls[5].url, API, "header-less GET untouched");
  assert.strictEqual(qa.fr, 0, "no rewrites counted");
  // unparseable token: present auth header, no Token="..."
  env.window.fetch(API, { headers: { Authorization: "Bearer abc" } });
  assert.strictEqual(env.netCalls[6].url, API, "Bearer form untouched");
  assert.strictEqual(
    env.netCalls[6].opts.headers.Authorization,
    "Bearer abc",
    "Bearer header kept",
  );
  assert.strictEqual(qa.sk, 1, "skip counted");
}

// ---- 7. XHR: buffer, re-open rewritten, replay non-auth headers -------------
{
  const env = makeEnv();
  env.run();
  const qa = env.window.__shellQA;
  const x = new env.window.XMLHttpRequest();
  x.open("GET", API, true);
  x.setRequestHeader("Authorization", AUTH);
  x.setRequestHeader("Accept", "application/json");
  assert.deepStrictEqual(
    x.headers,
    {},
    "headers buffered, none applied before send",
  );
  x.send();
  assert.strictEqual(x.url, API + "&api_key=" + TOK, "re-opened rewritten");
  assert.strictEqual(x.async, true, "async preserved");
  assert.strictEqual(x.opens.length, 2, "exactly one re-open");
  assert.deepStrictEqual(
    x.headers,
    { Accept: "application/json" },
    "non-auth headers replayed after re-open, auth swallowed",
  );
  assert(x.sent, "request sent");
  assert.strictEqual(qa.xr, 1, "xr counted");
  assert.strictEqual(qa.sw, 1, "swallowed counted");
}

// ---- 8. XHR passthrough scope ----------------------------------------------
{
  const env = makeEnv();
  env.run();
  const p = new env.window.XMLHttpRequest();
  p.open("POST", API);
  p.setRequestHeader("Authorization", AUTH);
  assert.strictEqual(
    p.headers.Authorization,
    AUTH,
    "POST headers applied directly",
  );
  const r = new env.window.XMLHttpRequest();
  r.open("GET", "/rel");
  r.setRequestHeader("Authorization", AUTH);
  assert.strictEqual(
    r.headers.Authorization,
    AUTH,
    "relative-URL headers applied directly",
  );
  // GET with only innocuous headers: buffered, replayed verbatim at send
  const g = new env.window.XMLHttpRequest();
  g.open("GET", API);
  g.setRequestHeader("Accept", "application/json");
  g.send();
  assert.strictEqual(g.url, API, "no auth header -> URL untouched");
  assert.strictEqual(g.opens.length, 1, "no re-open");
  assert.deepStrictEqual(
    g.headers,
    { Accept: "application/json" },
    "buffered headers replayed",
  );
  assert.strictEqual(env.window.__shellQA.xr, 0, "no xhr rewrite counted");
}

// ---- 9. one install per WINDOW + meta once per document ---------------------
{
  const env = makeEnv();
  env.run();
  const qa1 = env.window.__shellQA;
  const f1 = env.window.fetch;
  const o1 = env.window.XMLHttpRequest.prototype.open;
  env.run(); // document.write swap re-runs the body on the same window
  assert.strictEqual(env.window.__shellQA, qa1, "state object stable");
  assert.strictEqual(env.window.fetch, f1, "fetch not double-wrapped");
  assert.strictEqual(
    env.window.XMLHttpRequest.prototype.open,
    o1,
    "XHR proto not double-wrapped",
  );
  const metas = env.head.children.filter(
    (n) => n.tagName === "META" && n.id === "__shellQAMeta",
  );
  assert.strictEqual(metas.length, 1, "exactly one referrer meta");
  assert.strictEqual(metas[0].name, "referrer", "meta name");
  assert.strictEqual(metas[0].content, "no-referrer", "meta content");
  assert.strictEqual(
    env.head.children[0],
    metas[0],
    "meta inserted at head start",
  );
}

// ---- 10. composition with JELA-703 hssPin -----------------------------------
{
  const env = makeEnv({ store: { "jellyfin.shell.hssPin": "1" } });
  env.run();
  const su = "http://srv/HomeScreen/Sections?UserId=" + UID;
  env.window.fetch(su, { headers: { Authorization: AUTH } });
  const u = env.netCalls[0].url;
  assert(
    /[?&]PageHash=[0-9a-f-]+&Page=1&NumResultsPerPage=1000&api_key=tok740$/.test(
      u,
    ),
    "pinned AND query-authed, api_key outermost: " + u,
  );
  assert(
    !("Authorization" in env.netCalls[0].opts.headers),
    "auth stripped on the pinned request",
  );
  const x = new env.window.XMLHttpRequest();
  x.open("GET", su);
  x.setRequestHeader("Authorization", AUTH);
  x.send();
  assert(
    /[?&]PageHash=[0-9a-f-]+&Page=1&NumResultsPerPage=1000&api_key=tok740$/.test(
      x.url,
    ),
    "XHR pinned AND query-authed: " + x.url,
  );
  assert(!("Authorization" in x.headers), "XHR auth swallowed");
}

console.log("query-auth.test.cjs: all checks passed");
