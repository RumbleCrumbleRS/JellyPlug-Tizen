/*
 * JELA-29 (WS-A / JELA-24 Lever 1): Direct-Home render prototype.
 *
 * The shell can, on an authed saved-server auto-login boot, fetch real
 * home-section items straight from the Jellyfin API with the stored
 * AccessToken and paint a non-interactive card overlay BEFORE/without the
 * full web-client SPA bundle executes. It is an OPT-IN measurement prototype
 * (localStorage['jellyfin.shell.directHome']==='1', default OFF) that answers
 * the JELA-24 Lever-1 gate: how much of the warm-live ~9 s launch->first-card
 * floor is removable by skipping the bundle parse/eval.
 *
 * This test extracts the SHIPPED directHomeBody()/injectDirectHome() out of
 * the shell source and drives the overlay script through a virtual clock +
 * DOM stub + XHR stub, pinning:
 *   - default OFF: no flag => no fetch, no overlay, no timers, no state
 *   - static contract: ES5 (no arrow/template), no </script literal, overlay
 *     pointer-events:none + aria-hidden, divs only (no tabbables), opt-in key
 *   - happy path: X-Emby-Token auth header, the four home endpoints requested,
 *     movies/tvshows view preferred for Latest, rows painted from real items,
 *     window.__shellDH.firstCardMs + "dhcard" boot-phase recorded once
 *   - gating: missing creds / missing server => why "nocreds", no fetch
 *   - document.write survival: DOM wiped, watch tick repaints from cached rows
 *   - dismiss: >=4 .card hydration, first user input, login/selectserver
 *     route, 90 s absolute cap; crossfade + removal
 *   - re-injection idempotency: second copy bumps gen, does not re-fetch,
 *     stale-generation interval self-cancels
 *   - all three injection sites present (widget doc, DOMParser path, fast path)
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

const bodyFnSrc = extractFn("directHomeBody");
const injectFnSrc = extractFn("injectDirectHome");
const body = new Function(bodyFnSrc + "; return directHomeBody();")();

// ---- static contract checks --------------------------------------------------
assert(
  body.indexOf("</script") === -1,
  "directHomeBody must not contain a </script> literal",
);
assert(body.indexOf("=>") === -1, "body must be ES5 (no arrow functions)");
assert(body.indexOf("`") === -1, "body must be ES5 (no template literals)");
assert(
  body.indexOf("pointer-events:none") !== -1,
  "overlay must be pointer-events:none",
);
assert(body.indexOf("aria-hidden") !== -1, "overlay must be aria-hidden");
assert(
  body.indexOf("jellyfin.shell.directHome") !== -1,
  "opt-in / kill switch key present",
);
assert(
  body.indexOf("tabindex") === -1 && body.indexOf("<a") === -1,
  "overlay must not create tabbables",
);
assert(body.indexOf("X-Emby-Token") !== -1, "auth header present");
// All three injection sites.
assert(
  text.indexOf("injectDirectHome(document)") !== -1,
  "bootstrap() must inject into the widget document",
);
assert(
  text.indexOf("injectDirectHome(doc)") !== -1,
  "DOMParser write path must call injectDirectHome(doc)",
);
assert(
  text.indexOf('<script data-shell-direct-home="1">') !== -1,
  "string fast path must splice the direct-home script tag",
);

// ---- fixtures ----------------------------------------------------------------
const CREDS = JSON.stringify({
  Servers: [{ Id: "s1", AccessToken: "tok", UserId: "u1" }],
});
const DEFAULT_RESPONSES = {
  "/Users/u1/Items/Resume": {
    status: 200,
    body: {
      Items: [
        { Id: "cw1", ImageTags: { Primary: "t1" } },
        { Id: "cw2", ImageTags: { Primary: "t2" } },
      ],
    },
  },
  "/Shows/NextUp": {
    status: 200,
    body: {
      Items: [{ Id: "ep1", SeriesId: "ser1", SeriesPrimaryImageTag: "st1" }],
    },
  },
  "/UserViews": {
    status: 200,
    body: {
      Items: [
        { Id: "v-music", CollectionType: "music", Name: "Music" },
        { Id: "v-movies", CollectionType: "movies", Name: "Movies" },
      ],
    },
  },
  "/Users/u1/Items/Latest": {
    status: 200,
    body: [
      { Id: "m1", ImageTags: { Primary: "mt1" } },
      { Id: "m2", ImageTags: { Primary: "mt2" } },
    ],
  },
};

// ---- virtual clock + DOM + XHR stub ------------------------------------------
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

  function makeNode(tag) {
    return {
      tagName: tag,
      id: "",
      parentNode: null,
      children: [],
      attrs: {},
      textContent: "",
      rect: { width: 0, height: 0, top: 0, bottom: 0, left: 0 },
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
        if (i === -1) throw new Error("removeChild: not a child");
        this.children.splice(i, 1);
        n.parentNode = null;
        return n;
      },
      getBoundingClientRect() {
        return this.rect;
      },
    };
  }

  const documentElement = makeNode("HTML");
  let cards = [];
  function byId(node, id) {
    if (node.id === id) return node;
    for (const c of node.children) {
      const hit = byId(c, id);
      if (hit) return hit;
    }
    return null;
  }
  const document = {
    documentElement,
    createElement(t) {
      return makeNode(String(t).toUpperCase());
    },
    getElementById(id) {
      return byId(documentElement, id);
    },
    querySelectorAll(sel) {
      sel = String(sel);
      if (sel === ".card") return cards;
      return [];
    },
  };

  const listeners = {};
  const window = {
    innerWidth: 1920,
    innerHeight: 1080,
    __shellT0: opts.now || 0,
    addEventListener(t, fn) {
      (listeners[t] = listeners[t] || []).push(fn);
    },
  };
  const marks = [];
  window.__shellPhase = function (k) {
    marks.push(k);
  };

  const store = opts.store || {};
  const localStorage = {
    getItem(k) {
      if (opts.storageThrows) throw new Error("denied");
      return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null;
    },
    setItem(k, v) {
      store[k] = String(v);
    },
    removeItem(k) {
      delete store[k];
    },
  };
  const location = { hash: opts.hash || "" };

  const requests = [];
  const responses = opts.responses || DEFAULT_RESPONSES;
  function lookup(url) {
    for (const key in responses)
      if (url.indexOf(key) !== -1) return responses[key];
    return null;
  }
  function XHR() {
    this._headers = {};
    this.readyState = 0;
    this.status = 0;
    this.responseText = "";
  }
  XHR.prototype.open = function (method, url) {
    this._method = method;
    this._url = url;
  };
  XHR.prototype.setRequestHeader = function (k, v) {
    this._headers[k] = v;
  };
  XHR.prototype.send = function () {
    const rec = {
      url: this._url,
      headers: this._headers,
      method: this._method,
    };
    requests.push(rec);
    const r = lookup(this._url);
    // resolve synchronously (deterministic); mirrors an instant network.
    this.readyState = 4;
    if (r) {
      this.status = r.status;
      this.responseText =
        typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    } else {
      this.status = 404;
      this.responseText = "";
    }
    if (this.onreadystatechange) this.onreadystatechange();
  };

  return {
    window,
    document,
    documentElement,
    timers,
    store,
    marks,
    location,
    requests,
    makeNode,
    setCards(list) {
      cards = list;
    },
    fire(type) {
      (listeners[type] || []).forEach((fn) => fn({ type }));
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
        "XMLHttpRequest",
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
        XHR,
      );
    },
    advance(toMs) {
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
      }
      now = toMs;
    },
  };
}

function overlayOf(env) {
  return (
    env.documentElement.children.find((n) => n.id === "__shell_direct_home") ||
    null
  );
}
function visibleCard(env) {
  const n = env.makeNode("DIV");
  n.rect = { width: 300, height: 180, top: 200, bottom: 380, left: 40 };
  return n;
}
function authedStore() {
  return {
    jellyfin_credentials: CREDS,
    "jellyfin.shell.serverUrl": "http://srv",
    "jellyfin.shell.directHome": "1",
  };
}

// ---- 1. default OFF ----------------------------------------------------------
{
  const env = makeEnv({
    store: {
      jellyfin_credentials: CREDS,
      "jellyfin.shell.serverUrl": "http://srv",
    },
  });
  env.run();
  assert.strictEqual(overlayOf(env), null, "no overlay when flag absent");
  assert.strictEqual(env.requests.length, 0, "no fetch when flag absent");
  assert.strictEqual(env.timers.size, 0, "no timers armed when flag absent");
  assert.strictEqual(env.window.__shellDH, undefined, "no state when off");
}

// ---- 2. happy path -----------------------------------------------------------
{
  const env = makeEnv({ store: authedStore() });
  env.run();
  // four endpoints requested, all carrying the token
  const urls = env.requests.map((r) => r.url);
  assert(
    urls.some((u) => u.indexOf("/Users/u1/Items/Resume") !== -1),
    "Resume requested",
  );
  assert(
    urls.some((u) => u.indexOf("/Shows/NextUp?UserId=u1") !== -1),
    "NextUp requested with UserId",
  );
  assert(
    urls.some((u) => u.indexOf("/UserViews?userId=u1") !== -1),
    "UserViews requested",
  );
  assert(
    urls.some(
      (u) => u.indexOf("/Users/u1/Items/Latest?ParentId=v-movies") !== -1,
    ),
    "Latest requested for the movies view (not music)",
  );
  env.requests.forEach((r) =>
    assert.strictEqual(r.headers["X-Emby-Token"], "tok", "token header sent"),
  );

  const overlay = overlayOf(env);
  assert(overlay, "overlay painted from fetched rows");
  assert.strictEqual(overlay.attrs["aria-hidden"], "true");
  assert(
    overlay.style.cssText.indexOf("pointer-events:none") !== -1,
    "overlay never intercepts input",
  );
  // 3 sections (Continue Watching / Next Up / Latest Movies) each a title + cards
  const titles = overlay.children
    .filter((n) => n.textContent)
    .map((n) => n.textContent);
  assert(titles.indexOf("Continue Watching") !== -1, "CW title");
  assert(titles.indexOf("Next Up") !== -1, "Next Up title");
  assert(titles.indexOf("Latest Movies") !== -1, "Latest <view name> title");
  const artTiles = overlay.children.filter(
    (n) => n.style.cssText.indexOf("url(") !== -1,
  );
  assert(artTiles.length >= 4, "real card art tiles painted");
  // NextUp episode resolves to its series primary image
  assert(
    artTiles.some(
      (n) =>
        n.style.cssText.indexOf("/Items/ser1/Images/Primary") !== -1 &&
        n.style.cssText.indexOf("tag=st1") !== -1,
    ),
    "NextUp episode falls back to series primary image",
  );
  assert.strictEqual(env.window.__shellDH.enabled, 1);
  assert(env.window.__shellDH.firstCardMs >= 0, "firstCardMs recorded");
  assert.strictEqual(env.window.__shellDH.sections, 3, "3 sections painted");
  assert(env.window.__shellDH.cards >= 4, "card count recorded");
  assert(
    env.marks.indexOf("dhcard") !== -1,
    "dhcard boot-phase recorded for the ring",
  );
  assert.strictEqual(
    env.marks.filter((m) => m === "dhcard").length,
    1,
    "dhcard recorded exactly once",
  );
  assert.strictEqual(env.timers.size, 1, "one watch interval armed");
}

// ---- 3. gating: missing creds / server --------------------------------------
{
  const store = authedStore();
  delete store.jellyfin_credentials;
  const env = makeEnv({ store });
  env.run();
  assert.strictEqual(overlayOf(env), null, "no overlay unauthed");
  assert.strictEqual(env.requests.length, 0, "no fetch unauthed");
  assert.strictEqual(env.window.__shellDH.why, "nocreds");
}
{
  const store = authedStore();
  delete store["jellyfin.shell.serverUrl"];
  const env = makeEnv({ store });
  env.run();
  // no server url and creds carry no ManualAddress => nocreds
  assert.strictEqual(env.requests.length, 0, "no fetch without a base url");
  assert.strictEqual(env.window.__shellDH.why, "nocreds");
}

// ---- 4. document.write survival ---------------------------------------------
{
  const env = makeEnv({ store: authedStore() });
  env.run();
  assert(overlayOf(env), "painted");
  const before = env.window.__shellDH.rows.length;
  assert(before >= 3, "rows cached on the state object");
  const reqBefore = env.requests.length;
  // wipe the DOM (document.write) then let the watch tick run
  env.documentElement.children.length = 0;
  assert.strictEqual(overlayOf(env), null, "overlay gone after wipe");
  env.advance(1500);
  assert(overlayOf(env), "overlay repainted from cached rows after wipe");
  assert.strictEqual(
    env.requests.length,
    reqBefore,
    "no re-fetch on repaint (rows cached)",
  );
  assert.strictEqual(
    env.marks.filter((m) => m === "dhcard").length,
    1,
    "dhcard still recorded exactly once",
  );
}

// ---- 5. dismiss: hydration ---------------------------------------------------
{
  const env = makeEnv({ store: authedStore() });
  env.run();
  env.setCards([0, 1, 2, 3].map(() => visibleCard(env)));
  env.advance(800);
  assert.strictEqual(env.window.__shellDH.dismissed, 1);
  assert.strictEqual(env.window.__shellDH.why, "hydrated");
  const fading = overlayOf(env);
  assert(fading && fading.style.opacity === "0", "crossfade started");
  env.advance(1400);
  assert.strictEqual(overlayOf(env), null, "overlay removed after fade");
}

// ---- 6. dismiss: input -------------------------------------------------------
{
  const env = makeEnv({ store: authedStore() });
  env.run();
  assert(overlayOf(env));
  env.fire("keydown");
  assert.strictEqual(env.window.__shellDH.why, "input");
  env.advance(1000);
  assert.strictEqual(overlayOf(env), null, "overlay gone after input");
}

// ---- 7. dismiss: route -------------------------------------------------------
{
  const env = makeEnv({ store: authedStore() });
  env.run();
  env.location.hash = "#/login.html";
  env.advance(800);
  assert.strictEqual(env.window.__shellDH.why, "route");
}

// ---- 8. dismiss: 90 s cap ----------------------------------------------------
{
  const env = makeEnv({ store: authedStore() });
  env.run();
  env.advance(91000);
  assert.strictEqual(env.window.__shellDH.why, "cap");
  env.advance(92000);
  assert.strictEqual(overlayOf(env), null);
}

// ---- 9. re-injection idempotency --------------------------------------------
{
  const env = makeEnv({ store: authedStore() });
  env.run();
  const reqAfterFirst = env.requests.length;
  env.run();
  const overlays = env.documentElement.children.filter(
    (n) => n.id === "__shell_direct_home",
  );
  assert.strictEqual(overlays.length, 1, "no double overlay");
  assert.strictEqual(env.window.__shellDH.gen, 2, "generation bumped");
  assert.strictEqual(
    env.requests.length,
    reqAfterFirst,
    "second injection does not re-fetch",
  );
  env.advance(2000);
  assert.strictEqual(
    env.timers.size,
    1,
    "stale-generation interval self-cancelled",
  );
}

// ---- 10. localStorage throwing never breaks boot ----------------------------
{
  const env = makeEnv({ storageThrows: true });
  env.run();
  assert.strictEqual(overlayOf(env), null);
  assert.strictEqual(env.requests.length, 0);
}

// ---- 11. injector carries the shipped body ----------------------------------
{
  const headChildren = [];
  const doc = {
    createElement() {
      return {
        attrs: {},
        textContent: "",
        setAttribute(k, v) {
          this.attrs[k] = v;
        },
      };
    },
    head: {
      appendChild(n) {
        headChildren.push(n);
        return n;
      },
    },
  };
  const inject = new Function(
    "directHomeBody",
    injectFnSrc + "; return injectDirectHome;",
  )(() => body);
  inject(doc);
  assert.strictEqual(headChildren.length, 1);
  assert.strictEqual(headChildren[0].attrs["data-shell-direct-home"], "1");
  assert.strictEqual(headChildren[0].textContent, body);
}

console.log("direct-home.test.cjs: all assertions passed");
