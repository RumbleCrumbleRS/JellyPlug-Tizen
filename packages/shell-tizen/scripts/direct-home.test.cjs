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
 *   - dismiss: >=4 .card hydration, unhandled user input, login/selectserver
 *     route, 90 s idle cap; crossfade + removal
 *   - re-injection idempotency: second copy bumps gen, does not re-fetch,
 *     stale-generation interval self-cancels
 *   - all three injection sites present (widget doc, DOMParser path, fast path)
 *
 * JELA-33 (WS-A/C2, A2+A3) additions:
 *   - focus: first repaint focuses (0,0) and paints the synthetic outline
 *     ring (still divs only — no DOM focus, no tabbables)
 *   - D-pad: 37/39/38/40 move focus with clamping, are eaten
 *     (preventDefault+stopPropagation), mark navved, never dismiss
 *   - open: Enter (13) routes the SPA via location.hash
 *     "#/details?id=..&serverId=..", records dhopen + openMs, dismiss("open")
 *   - play: 415/10252 open with playIntent and a bounded poll that clicks the
 *     hydrated details page's .btnPlay exactly once
 *   - back: 10009/461/27 dismiss("back"), eaten
 *   - unhandled keys keep the A1 contract: dismiss("input"), NOT eaten
 *   - navved suppresses the hydration dismiss and stretches the 90 s idle cap
 *     to a 15 min absolute cap
 *   - A3 fusion: overlay's first creation fades in (opacity 0 -> 1) over the
 *     Instant-Home snapshot; rebuilds reappear opaque (no re-fade)
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
assert(
  body.indexOf("#/details?id=") !== -1,
  "JELA-33 A2: open-item wired to the SPA details route",
);
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
  let playBtn = null;
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
    querySelector(sel) {
      if (String(sel) === ".btnPlay") return playBtn;
      return null;
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
    setPlayButton(b) {
      playBtn = b;
    },
    // Returns the synthetic event so tests can assert eaten (preventDefault /
    // stopPropagation) vs passed-through keys.
    fire(type, props) {
      const e = Object.assign({ type, defaultPrevented: 0, stopped: 0 }, props);
      e.preventDefault = () => {
        e.defaultPrevented = 1;
      };
      e.stopPropagation = () => {
        e.stopped = 1;
      };
      (listeners[type] || []).forEach((fn) => fn(e));
      return e;
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
    // Simulates the document.open()/write() SPA index handoff: the window
    // object survives but ALL its event listeners are wiped along with the
    // whole DOM; the written document then re-executes the injected body.
    swapDoc() {
      for (const k in listeners) delete listeners[k];
      documentElement.children.length = 0;
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
  // JELA-54: hold-cover (default ON) stands the grid down entirely, so every
  // live-grid case below runs in the opted-out state — the exact state a
  // fielded TV is in after jellyfin.shell.instantHomeHoldCoverDisabled=1.
  // Case 1b pins the hold-cover default itself.
  return {
    jellyfin_credentials: CREDS,
    "jellyfin.shell.serverUrl": "http://srv",
    "jellyfin.shell.directHome": "1",
    "jellyfin.shell.instantHomeHoldCoverDisabled": "1",
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

// ---- 1b. JELA-54 hold-cover default: grid stands down even when opted in ------
// User-decided default (JELA-52 ask 00d36d8f): with Instant-Home active and
// hold-cover not opted out, the snapshot cover holds to the settled reveal —
// the grid (which would paint ABOVE the cover) must never fetch, paint, or
// bind input. __shellDHHeld is the QA marker for this stand-down.
{
  const env = makeEnv({
    store: {
      jellyfin_credentials: CREDS,
      "jellyfin.shell.serverUrl": "http://srv",
      "jellyfin.shell.directHome": "1",
    },
  });
  env.run();
  assert.strictEqual(overlayOf(env), null, "no overlay under hold-cover");
  assert.strictEqual(env.requests.length, 0, "no fetch under hold-cover");
  assert.strictEqual(env.timers.size, 0, "no timers under hold-cover");
  assert.strictEqual(env.window.__shellDH, undefined, "no grid state");
  assert.strictEqual(env.window.__shellDHHeld, 1, "stand-down marker set");
}

// ---- 1c. JELA-54: disabling Instant-Home entirely also frees the grid ---------
// With no cover to hold (instantHomeDisabled=1) the grid keeps its pre-JELA-54
// behavior even without the hold-cover opt-out.
{
  const env = makeEnv({
    store: {
      jellyfin_credentials: CREDS,
      "jellyfin.shell.serverUrl": "http://srv",
      "jellyfin.shell.directHome": "1",
      "jellyfin.shell.instantHomeDisabled": "1",
    },
  });
  env.run();
  assert(env.requests.length > 0, "grid fetches when Instant-Home is off");
  assert.strictEqual(env.window.__shellDHHeld, undefined, "no stand-down");
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
  // JELA-33 A3: first creation fades in over the Instant-Home snapshot.
  assert(
    overlay.style.cssText.indexOf("opacity:0") !== -1,
    "first paint starts transparent (crossfade over the snapshot)",
  );
  env.advance(100);
  assert.strictEqual(overlay.style.opacity, "1", "faded in");
  assert.strictEqual(env.timers.size, 1, "one watch interval armed");
  // JELA-33 A2: navigable at dhcard — grid + focus ring painted immediately.
  const G = env.window.__shellDH;
  assert.strictEqual(G.grid.length, 3, "3 grid rows tracked");
  assert.strictEqual(G.focusR, 0, "initial focus row 0");
  assert.strictEqual(G.focusC, 0, "initial focus col 0");
  assert.strictEqual(
    G.grid[0][0].el.style.outline,
    "4px solid #00a4dc",
    "focus ring painted on the first card",
  );
  assert.strictEqual(G.grid[0][0].id, "cw1", "item id carried on the grid");
  assert.strictEqual(
    G.navReadyMs,
    G.firstCardMs,
    "nav-ready coincides with dhcard",
  );
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

// ---- 6. dismiss: unhandled input (A1 escape hatch, NOT eaten) -----------------
{
  const env = makeEnv({ store: authedStore() });
  env.run();
  assert(overlayOf(env));
  const ev = env.fire("keydown", { keyCode: 66 });
  assert.strictEqual(env.window.__shellDH.why, "input");
  assert.strictEqual(ev.defaultPrevented, 0, "unhandled key passes through");
  assert.strictEqual(ev.stopped, 0, "unhandled key not stopped");
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

// ---- 12. A2: D-pad navigation, clamping, eaten keys ---------------------------
// Grid from fixtures: row0 Continue Watching (2 cards), row1 Next Up (1 card),
// row2 Latest Movies (2 cards).
{
  const env = makeEnv({ store: authedStore() });
  env.run();
  const G = env.window.__shellDH;
  const ev = env.fire("keydown", { keyCode: 39 });
  assert.strictEqual(G.focusC, 1, "right moves focus");
  assert.strictEqual(ev.defaultPrevented, 1, "nav key eaten (preventDefault)");
  assert.strictEqual(ev.stopped, 1, "nav key eaten (stopPropagation)");
  assert.strictEqual(G.navved, 1, "navved marked");
  assert.strictEqual(G.dismissed, 0, "nav never dismisses");
  assert.strictEqual(G.grid[0][0].el.style.outline, "", "ring left old card");
  assert.strictEqual(
    G.grid[0][1].el.style.outline,
    "4px solid #00a4dc",
    "ring moved to the new card",
  );
  env.fire("keydown", { keyCode: 39 });
  assert.strictEqual(G.focusC, 1, "right clamps at row end");
  env.fire("keydown", { keyCode: 40 });
  assert.strictEqual(G.focusR, 1, "down moves row");
  assert.strictEqual(G.focusC, 0, "col clamped to shorter row");
  env.fire("keydown", { keyCode: 40 });
  env.fire("keydown", { keyCode: 40 });
  assert.strictEqual(G.focusR, 2, "down clamps at last row");
  env.fire("keydown", { keyCode: 38 });
  assert.strictEqual(G.focusR, 1, "up moves row");
  env.fire("keydown", { keyCode: 37 });
  env.fire("keydown", { keyCode: 37 });
  assert.strictEqual(G.focusC, 0, "left clamps at 0");
}

// ---- 13. A2: Enter opens the focused item via the SPA hash route --------------
{
  const env = makeEnv({ store: authedStore() });
  env.run();
  const G = env.window.__shellDH;
  const ev = env.fire("keydown", { keyCode: 13 });
  assert.strictEqual(ev.defaultPrevented, 1, "enter eaten");
  assert.strictEqual(G.opened, 1);
  assert.strictEqual(G.openId, "cw1");
  assert(G.openMs >= 0, "openMs recorded");
  assert.strictEqual(
    env.location.hash,
    "#/details?id=cw1&serverId=s1",
    "SPA routed to the item details (serverId carried)",
  );
  assert.strictEqual(G.why, "open");
  assert.strictEqual(G.playIntent, 0, "plain open has no play intent");
  assert(env.marks.indexOf("dhopen") !== -1, "dhopen boot-phase recorded");
  env.advance(1000);
  assert.strictEqual(overlayOf(env), null, "overlay gone after open");
}

// ---- 14. A2: play key opens with playIntent and clicks .btnPlay once ----------
{
  const env = makeEnv({ store: authedStore() });
  env.run();
  const G = env.window.__shellDH;
  env.fire("keydown", { keyCode: 415 });
  assert.strictEqual(G.why, "play");
  assert.strictEqual(G.playIntent, 1);
  assert.strictEqual(env.location.hash, "#/details?id=cw1&serverId=s1");
  env.advance(3000);
  assert.strictEqual(G.played, 0, "no click before the details page hydrates");
  let clicks = 0;
  env.setPlayButton({
    disabled: false,
    click() {
      clicks++;
    },
  });
  env.advance(6000);
  assert.strictEqual(G.played, 1, "played once the button appeared");
  assert.strictEqual(clicks, 1, "clicked exactly once");
  env.advance(40000);
  assert.strictEqual(clicks, 1, "poll cleared after the click");
}

// ---- 15. A2: play poll abandons when the user routes elsewhere ----------------
{
  const env = makeEnv({ store: authedStore() });
  env.run();
  env.fire("keydown", { keyCode: 10252 });
  env.location.hash = "#/home.html";
  let clicks = 0;
  env.setPlayButton({
    disabled: false,
    click() {
      clicks++;
    },
  });
  env.advance(25000);
  assert.strictEqual(clicks, 0, "no click after the user routed away");
  assert.strictEqual(env.window.__shellDH.played, 0);
}

// ---- 16. A2: Back dismisses to the SPA, eaten ---------------------------------
{
  const env = makeEnv({ store: authedStore() });
  env.run();
  const ev = env.fire("keydown", { keyCode: 10009 });
  assert.strictEqual(env.window.__shellDH.why, "back");
  assert.strictEqual(ev.defaultPrevented, 1, "back eaten");
  assert.strictEqual(env.location.hash, "", "back does not route");
  env.advance(1000);
  assert.strictEqual(overlayOf(env), null, "overlay gone after back");
}

// ---- 17. A2: navved suppresses hydration dismiss; caps stretch ----------------
{
  const env = makeEnv({ store: authedStore() });
  env.run();
  env.fire("keydown", { keyCode: 39 });
  env.setCards([0, 1, 2, 3].map(() => visibleCard(env)));
  env.advance(5000);
  assert.strictEqual(
    env.window.__shellDH.dismissed,
    0,
    "SPA hydration must not yank the grid from under the user",
  );
  env.advance(91000);
  assert.strictEqual(
    env.window.__shellDH.dismissed,
    0,
    "90 s idle cap suspended while navved",
  );
  env.advance(901000);
  assert.strictEqual(env.window.__shellDH.why, "cap");
  assert.strictEqual(
    env.window.__shellDH.dismissed,
    1,
    "15 min absolute cap still fires",
  );
}

// ---- 18. A2: focus survives a document.write wipe + repaint -------------------
{
  const env = makeEnv({ store: authedStore() });
  env.run();
  env.fire("keydown", { keyCode: 39 });
  const G = env.window.__shellDH;
  assert.strictEqual(G.focusC, 1);
  env.documentElement.children.length = 0;
  env.advance(1500);
  assert(overlayOf(env), "repainted after wipe");
  assert.strictEqual(G.focusC, 1, "focus position preserved across rebuild");
  assert.strictEqual(
    G.grid[0][1].el.style.outline,
    "4px solid #00a4dc",
    "ring reapplied on the rebuilt overlay",
  );
  const ov = overlayOf(env);
  assert(
    ov.style.cssText.indexOf("opacity:1") !== -1,
    "rebuild reappears opaque (no re-fade)",
  );
}

// ---- 19. A2: keys pass through untouched when nothing is painted --------------
{
  const env = makeEnv({ store: authedStore(), responses: {} });
  env.run();
  assert.strictEqual(overlayOf(env), null, "nothing painted (all fetches 404)");
  const ev = env.fire("keydown", { keyCode: 39 });
  assert.strictEqual(ev.defaultPrevented, 0, "no overlay -> key not eaten");
  assert.strictEqual(ev.stopped, 0);
  assert.strictEqual(
    env.window.__shellDH.dismissed,
    0,
    "nothing to dismiss, SPA owns the key",
  );
}

// ---- 20. A2: keys still work after the document.open handoff (gen re-run) ----
// document.open() wipes ALL window listeners together with the DOM; the
// written document then re-executes the body (gen 2). The old once-per-G
// inputBound gate skipped the rebind there, leaving post-swap boots with a
// painted grid but dead keys (Q60R G1 QA, 2026-07-07: the swap lands ~1-3 s
// after T0, before a real user's first keypress). The bind is per-run now.
{
  const env = makeEnv({ store: authedStore() });
  env.run();
  const G = env.window.__shellDH;
  env.fire("keydown", { keyCode: 39 });
  assert.strictEqual(G.focusC, 1, "pre-swap nav works");
  env.swapDoc();
  env.run();
  assert.strictEqual(G.gen, 2, "same G, second generation");
  assert.strictEqual(G.inputBound, 2, "keydown rebound by the gen-2 run");
  assert(overlayOf(env), "overlay recreated by the gen-2 run");
  const ev = env.fire("keydown", { keyCode: 40 });
  assert.strictEqual(ev.defaultPrevented, 1, "post-swap key still eaten");
  assert.strictEqual(G.focusR, 1, "post-swap nav still moves focus");
  env.fire("keydown", { keyCode: 13 });
  assert.strictEqual(G.opened, 1, "post-swap Enter still opens");
  assert.strictEqual(G.dismissed, 1, "open dismissed the grid");
}

// ---- 21. A2: a survivor stale-gen listener is inert (no double-nav) ----------
// If an engine ever leaves the old listener alive across the handoff, the
// per-run rebind would make two live listeners; the gen guard in onKey must
// keep the stale one from double-acting.
{
  const env = makeEnv({ store: authedStore() });
  env.run();
  const G = env.window.__shellDH;
  env.documentElement.children.length = 0; // DOM wiped, listeners survive
  env.run();
  assert.strictEqual(G.inputBound, 2, "two live listeners");
  env.fire("keydown", { keyCode: 40 });
  assert.strictEqual(G.focusR, 1, "one keypress moves focus exactly one row");
}

console.log("direct-home.test.cjs: all assertions passed");
