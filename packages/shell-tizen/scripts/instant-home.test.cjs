/*
 * JEL-647: Instant-Home — paint cached home snapshot at boot.
 *
 * The shell persists a lightweight above-fold snapshot of the settled home
 * screen (section titles + card art URLs + geometry) into localStorage and
 * repaints it as a static NON-interactive overlay on the next boot, then
 * crossfades it away once the live home hydrates (or on first user input).
 *
 * This test extracts the SHIPPED instantHomeBody()/injectInstantHome() out
 * of the shell source and drives the overlay script through a virtual
 * clock + DOM stub, pinning:
 *   - paint: overlay rebuilt from a chunked LS snapshot, aria-hidden,
 *     pointer-events:none, boot-phase ring mark "snap" recorded once
 *   - paint gating: killswitch / no snapshot / unauthed / stale (> 7 d) /
 *     server-mismatch all suppress the overlay
 *   - dismiss: above-fold hydration (>= 4 .card), first user input,
 *     non-home route, 90 s absolute cap; crossfade + removal
 *   - document.write survival: overlay re-created by the watch tick after
 *     the DOM is wiped, without double-counting the ring mark
 *   - re-injection: generation counter makes the second copy own the
 *     timers (no double overlay, stale intervals self-cancel)
 *   - capture: home-route settle detection, section titles + img /
 *     background-image tiles, http(s)-only, rect-dedupe, >= 4 images
 *     required, chunked write with meta LAST, quota abort leaves no torn
 *     snapshot; round-trip repaint from a captured snapshot
 *   - capture scroll gate (JELA-22): only snapshots at window scrollY <= 8 px
 *     (pristine above-fold); a scrolled-down home never captures until the
 *     user returns to the top
 *   - all three injection sites present (widget doc, DOMParser path,
 *     string fast path)
 */
"use strict";
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const SRC = path.join(__dirname, "..", "src", "shell.js");
const text = fs.readFileSync(SRC, "utf8");

// ---- extract a top-level function by brace matching -------------------------
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
const injectFnSrc = extractFn("injectInstantHome");
const body = new Function(bodyFnSrc + "; return instantHomeBody();")();

// ---- static contract checks --------------------------------------------------
assert(
  body.indexOf("</script") === -1,
  "instantHomeBody must not contain a </script> literal",
);
assert(body.indexOf("=>") === -1, "body must be ES5 (no arrow functions)");
assert(body.indexOf("`") === -1, "body must be ES5 (no template literals)");
assert(
  body.indexOf("pointer-events:none") !== -1,
  "overlay must be pointer-events:none",
);
assert(body.indexOf("aria-hidden") !== -1, "overlay must be aria-hidden");
assert(
  body.indexOf("jellyfin.shell.instantHomeDisabled") !== -1,
  "kill switch key present",
);
// No focusable/tabbable markup is ever created: divs only.
assert(
  body.indexOf("tabindex") === -1 && body.indexOf("<a") === -1,
  "overlay must not create tabbables",
);
// All three injection sites.
assert(
  text.indexOf("injectInstantHome(document)") !== -1,
  "bootstrap() must inject into the widget document",
);
assert(
  text.indexOf("injectInstantHome(doc)") !== -1,
  "DOMParser write path must call injectInstantHome(doc)",
);
assert(
  text.indexOf('<script data-shell-instant-home="1">') !== -1,
  "string fast path must splice the instant-home script tag",
);

// ---- virtual clock + DOM stub ------------------------------------------------
const MK = "jellyfin.shell.instantHome";
const CREDS = JSON.stringify({
  Servers: [{ Id: "s1", AccessToken: "tok", UserId: "u1" }],
});

function makeSnapshotStore(opts) {
  opts = opts || {};
  const items = opts.items || [
    { x: 40, y: 90, w: 300, h: 40, s: "Continue Watching", fs: 28 },
    {
      x: 40,
      y: 140,
      w: 320,
      h: 180,
      u: "http://srv/Items/1/Images/Primary",
      r: 6,
    },
    {
      x: 380,
      y: 140,
      w: 320,
      h: 180,
      u: "http://srv/Items/2/Images/Primary",
      r: 6,
    },
    {
      x: 720,
      y: 140,
      w: 320,
      h: 180,
      u: "http://srv/Items/3/Images/Primary",
      r: 6,
    },
    {
      x: 1060,
      y: 140,
      w: 320,
      h: 180,
      u: "http://srv/Items/4/Images/Primary",
      r: 6,
    },
  ];
  const bodyJson = JSON.stringify({ items });
  const CH = 24576;
  const store = {
    jellyfin_credentials: CREDS,
    "jellyfin.shell.serverUrl": opts.srv || "http://srv",
  };
  const n = Math.ceil(bodyJson.length / CH);
  for (let i = 0; i < n; i++) store[MK + "." + i] = bodyJson.substr(i * CH, CH);
  store[MK] = JSON.stringify({
    v: 1,
    ts: opts.ts != null ? opts.ts : 1,
    n,
    w: 1920,
    h: 1080,
    srv: opts.metaSrv || "http://srv",
  });
  return store;
}

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
      style: { cssText: "", opacity: "", backgroundImage: "" },
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
  let titles = [];
  let media = [];
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
      if (sel === ".sectionTitle") return titles;
      if (sel.indexOf("img") === 0) return media;
      return [];
    },
  };
  const listeners = {};
  const window = {
    innerWidth: 1920,
    innerHeight: 1080,
    // JELA-22: window scroll offset the capture gate reads via scy().
    pageYOffset: opts.scrollY || 0,
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
      if (opts.setThrows) throw new Error("QuotaExceededError");
      store[k] = String(v);
    },
    removeItem(k) {
      delete store[k];
    },
  };
  const location = { hash: opts.hash || "" };
  const getComputedStyle = function () {
    return { fontSize: "28px", borderTopLeftRadius: "6px" };
  };

  return {
    window,
    document,
    documentElement,
    timers,
    store,
    marks,
    location,
    setScroll(y) {
      window.pageYOffset = y;
    },
    setCards(list) {
      cards = list;
    },
    setTitles(list) {
      titles = list;
    },
    setMedia(list) {
      media = list;
    },
    makeNode,
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

function findOverlay(env) {
  return (
    env.documentElement.children.find((n) => n.id === "__shell_instant_home") ||
    null
  );
}
function visibleCard(env) {
  const n = env.makeNode("DIV");
  n.rect = { width: 300, height: 180, top: 200, bottom: 380, left: 40 };
  return n;
}

// ---- 1. paint happy path -------------------------------------------------------
{
  const env = makeEnv({ store: makeSnapshotStore() });
  env.run();
  const overlay = findOverlay(env);
  assert(overlay, "overlay painted from snapshot");
  assert.strictEqual(overlay.attrs["aria-hidden"], "true");
  assert(
    overlay.style.cssText.indexOf("pointer-events:none") !== -1,
    "overlay never intercepts input",
  );
  assert.strictEqual(overlay.children.length, 5, "1 title + 4 art tiles");
  const title = overlay.children.find((n) => n.textContent);
  assert(title && title.textContent === "Continue Watching");
  const tile = overlay.children.find(
    (n) => n.style.cssText.indexOf("url(") !== -1,
  );
  assert(
    tile &&
      tile.style.cssText.indexOf("http://srv/Items/1/Images/Primary") !== -1,
    "art tile carries the cached image URL",
  );
  assert.strictEqual(env.window.__shellIH.painted, 1);
  assert(env.marks.indexOf("snap") !== -1, "boot-phase ring mark recorded");
  assert.strictEqual(env.timers.size, 2, "watch + capture intervals armed");

  // ---- 2. survives with no hydration for a while ------------------------------
  env.advance(5000);
  assert(findOverlay(env), "overlay persists while home is not hydrated");

  // ---- 3. document.write wipe → watch tick re-creates it ----------------------
  env.documentElement.children.length = 0;
  env.advance(6000);
  assert(findOverlay(env), "overlay re-created after document.write wipe");
  assert.strictEqual(env.window.__shellIH.painted, 1, "painted flag stays 1");
  assert.strictEqual(
    env.marks.filter((m) => m === "snap").length,
    1,
    "ring mark recorded exactly once",
  );

  // ---- 4. hydration dismiss ----------------------------------------------------
  env.setCards([
    visibleCard(env),
    visibleCard(env),
    visibleCard(env),
    visibleCard(env),
  ]);
  env.advance(6400); // one watch tick past card hydration, before fade-out ends
  assert.strictEqual(env.window.__shellIH.dismissed, 1);
  assert.strictEqual(env.window.__shellIH.why, "hydrated");
  const fading = findOverlay(env);
  assert(fading && fading.style.opacity === "0", "crossfade started");
  env.advance(8500);
  assert.strictEqual(findOverlay(env), null, "overlay removed after fade");
}

// ---- 5. input dismiss -----------------------------------------------------------
{
  const env = makeEnv({ store: makeSnapshotStore() });
  env.run();
  assert(findOverlay(env));
  env.fire("keydown");
  assert.strictEqual(env.window.__shellIH.why, "input");
  env.advance(3000);
  assert.strictEqual(findOverlay(env), null, "overlay gone after input");
  // watch interval self-cancelled; capture interval may keep running
  assert(env.timers.size <= 1, "watch interval cancelled after dismissal");
}

// ---- 6. route dismiss -----------------------------------------------------------
{
  const env = makeEnv({ store: makeSnapshotStore() });
  env.run();
  env.location.hash = "#/login.html";
  env.advance(1500);
  assert.strictEqual(env.window.__shellIH.why, "route");
}

// ---- 6b. JELA-33 A3 fusion: live Direct-Home grid replaces the crossfade ---------
// When the (shell.js-only, opt-in) Direct-Home grid paints, the snapshot hands
// off to it instead of waiting for SPA hydration. In the baked boot-shell
// __shellDH never exists, so the branch is a structural no-op there — this
// case pins both sides of that contract.
{
  const env = makeEnv({ store: makeSnapshotStore() });
  env.run();
  assert(findOverlay(env), "snapshot painted");
  env.window.__shellDH = { painted: 1, dismissed: 0 };
  env.advance(1500);
  assert.strictEqual(env.window.__shellIH.why, "dh");
  assert.strictEqual(env.window.__shellIH.dismissed, 1);
  env.advance(3000);
  assert.strictEqual(
    findOverlay(env),
    null,
    "snapshot gone under the live grid",
  );
}
{
  const env = makeEnv({ store: makeSnapshotStore() });
  env.run();
  env.window.__shellDH = { painted: 0, dismissed: 0 };
  env.advance(3000);
  assert.strictEqual(
    env.window.__shellIH.dismissed,
    0,
    "an unpainted Direct-Home state must not steal the snapshot",
  );
}

// ---- 7. 90 s absolute cap -------------------------------------------------------
{
  const env = makeEnv({ store: makeSnapshotStore() });
  env.run();
  env.advance(91000);
  assert.strictEqual(env.window.__shellIH.why, "cap");
  env.advance(92000);
  assert.strictEqual(findOverlay(env), null);
}

// ---- 8. paint gating ------------------------------------------------------------
{
  // kill switch: nothing armed, no state object
  const store = makeSnapshotStore();
  store["jellyfin.shell.instantHomeDisabled"] = "1";
  const env = makeEnv({ store });
  env.run();
  assert.strictEqual(findOverlay(env), null, "kill switch suppresses overlay");
  assert.strictEqual(env.timers.size, 0, "kill switch arms no timers");
  assert.strictEqual(env.window.__shellIH, undefined);
}
{
  // JELA-32: no snapshot (first-ever boot) → non-blank skeleton placeholder
  const env = makeEnv({
    store: {
      jellyfin_credentials: CREDS,
      "jellyfin.shell.serverUrl": "http://srv",
    },
  });
  env.run();
  const overlay = findOverlay(env);
  assert(overlay, "first boot with no snapshot → skeleton overlay painted");
  assert.strictEqual(env.window.__shellIH.skeleton, 1, "flagged as skeleton");
  assert.strictEqual(
    env.window.__shellIH.snapAgeMs,
    -1,
    "skeleton age sentinel",
  );
  assert(
    overlay.children.length >= 8,
    "skeleton has multiple placeholder tiles",
  );
  // skeleton is content-free: never carries a library image/section URL
  assert(
    overlay.children.every((n) => n.style.cssText.indexOf("url(") === -1),
    "skeleton tiles carry no library data",
  );
  assert(
    overlay.style.cssText.indexOf("pointer-events:none") !== -1,
    "skeleton never intercepts input",
  );
  assert.strictEqual(overlay.attrs["aria-hidden"], "true");
  assert(
    env.marks.indexOf("snap") !== -1,
    "skeleton still records the ring mark",
  );
}
{
  // JELA-32: skeleton killswitch → first boot stays blank (snapshot repaint
  // still works; only the placeholder is suppressed)
  const env = makeEnv({
    store: {
      jellyfin_credentials: CREDS,
      "jellyfin.shell.serverUrl": "http://srv",
      "jellyfin.shell.instantHomeSkeletonDisabled": "1",
    },
  });
  env.run();
  assert.strictEqual(
    findOverlay(env),
    null,
    "skeleton killswitch → no first-boot overlay",
  );
}
{
  // unauthenticated → no overlay at all (not even a skeleton: unauthed boots
  // land on login, never home)
  const store = makeSnapshotStore();
  delete store.jellyfin_credentials;
  const env = makeEnv({ store });
  env.run();
  assert.strictEqual(findOverlay(env), null, "unauthed → no overlay");
}
{
  // JELA-32: expired snapshot (older than the bounded max-age) → falls back to
  // the skeleton so a stale library never paints, yet the boot is not blank
  const env = makeEnv({ store: makeSnapshotStore({ ts: 1 }), now: 172800100 });
  env.run();
  const overlay = findOverlay(env);
  assert(overlay, "expired snapshot → skeleton fallback (not blank)");
  assert.strictEqual(env.window.__shellIH.skeleton, 1, "expired → skeleton");
}
{
  // JELA-32: within the bounded max-age → the real snapshot still paints
  const env = makeEnv({ store: makeSnapshotStore({ ts: 1 }), now: 172799000 });
  env.run();
  assert(findOverlay(env), "snapshot within max-age paints");
  assert.strictEqual(
    env.window.__shellIH.skeleton,
    0,
    "real snapshot, not skeleton",
  );
  assert.strictEqual(
    env.window.__shellIH.snapAgeMs,
    172798999,
    "painted snapshot age recorded",
  );
}
{
  // JELA-32: operator override of the max-age (restore the legacy 7-day bound)
  // via localStorage — a 3-day-old snapshot that would expire under the 48h
  // default still paints
  const store = makeSnapshotStore({ ts: 1 });
  store["jellyfin.shell.instantHomeMaxAgeMs"] = "604800000";
  const env = makeEnv({ store, now: 259200000 });
  env.run();
  assert(
    findOverlay(env),
    "override widens max-age → older snapshot still paints",
  );
  assert.strictEqual(env.window.__shellIH.skeleton, 0);
}
{
  // server mismatch → skeleton (the old snapshot is for a different server;
  // the content-free placeholder is server-agnostic and safe to show)
  const env = makeEnv({
    store: makeSnapshotStore({ metaSrv: "http://other" }),
  });
  env.run();
  assert(findOverlay(env), "server mismatch → skeleton");
  assert.strictEqual(env.window.__shellIH.skeleton, 1);
}
{
  // corrupt chunk → skeleton (unreadable snapshot never paints torn content)
  const store = makeSnapshotStore();
  store[MK + ".0"] = "{not json";
  const env = makeEnv({ store });
  env.run();
  assert(findOverlay(env), "corrupt snapshot → skeleton");
  assert.strictEqual(env.window.__shellIH.skeleton, 1);
}
{
  // localStorage throwing never breaks boot
  const env = makeEnv({ storageThrows: true });
  env.run();
  assert.strictEqual(findOverlay(env), null);
}

// ---- 9. re-injection: newest copy owns the timers --------------------------------
{
  const env = makeEnv({ store: makeSnapshotStore() });
  env.run();
  env.run();
  const overlays = env.documentElement.children.filter(
    (n) => n.id === "__shell_instant_home",
  );
  assert.strictEqual(overlays.length, 1, "no double overlay");
  assert.strictEqual(env.window.__shellIH.gen, 2, "generation bumped");
  env.advance(2000);
  assert.strictEqual(
    env.timers.size,
    2,
    "stale generation intervals self-cancelled",
  );
}

// ---- 10. capture: settle on home, write chunked snapshot --------------------------
{
  const env = makeEnv({
    store: {
      jellyfin_credentials: CREDS,
      "jellyfin.shell.serverUrl": "http://srv",
    },
    hash: "#/home.html",
  });
  env.run();
  // settled home: 6 visible cards, 2 titles, 5 art nodes (1 dup rect, 1 data:)
  env.setCards([0, 1, 2, 3, 4, 5].map(() => visibleCard(env)));
  const t1 = env.makeNode("H2");
  t1.textContent = "  My Media  ";
  t1.rect = { width: 200, height: 40, top: 80, bottom: 120, left: 40 };
  const t2 = env.makeNode("H2");
  t2.textContent = "Below fold";
  t2.rect = { width: 200, height: 40, top: 2000, bottom: 2040, left: 40 };
  env.setTitles([t1, t2]);
  const media = [];
  for (let i = 0; i < 4; i++) {
    const img = env.makeNode("IMG");
    img.src = "http://srv/Items/" + i + "/Images/Primary?tag=abc";
    img.rect = {
      width: 320,
      height: 180,
      top: 140,
      bottom: 320,
      left: 40 + i * 340,
    };
    media.push(img);
  }
  const dup = env.makeNode("IMG");
  dup.src = "http://srv/dup";
  dup.rect = { width: 320, height: 180, top: 140, bottom: 320, left: 40 };
  media.push(dup);
  const dataUri = env.makeNode("IMG");
  dataUri.src = "data:image/png;base64,xxx";
  dataUri.rect = { width: 320, height: 180, top: 400, bottom: 580, left: 40 };
  media.push(dataUri);
  const bgDiv = env.makeNode("DIV");
  bgDiv.style.backgroundImage = 'url("http://srv/hero.jpg")';
  bgDiv.rect = { width: 1920, height: 500, top: 0, bottom: 500, left: 0 };
  media.push(bgDiv);
  env.setMedia(media);

  env.advance(6000); // 3 capture ticks: prime, stable, capture
  assert.strictEqual(env.window.__shellIH.captured, 1, "snapshot captured");
  const meta = JSON.parse(env.store[MK]);
  assert.strictEqual(meta.v, 1);
  assert.strictEqual(meta.srv, "http://srv");
  assert(meta.n >= 1);
  let joined = "";
  for (let i = 0; i < meta.n; i++) joined += env.store[MK + "." + i];
  const snap = JSON.parse(joined);
  const urls = snap.items.filter((it) => it.u).map((it) => it.u);
  assert(urls.indexOf("http://srv/hero.jpg") !== -1, "hero bg captured");
  assert(
    urls.filter((u) => u === "http://srv/dup").length === 0 ||
      urls.filter((u) => u.indexOf("http://srv/Items/0/") === 0).length +
        urls.filter((u) => u === "http://srv/dup").length <=
        1,
    "duplicate rect deduped",
  );
  assert(
    urls.every((u) => u.indexOf("http") === 0),
    "non-http art excluded",
  );
  const titlesCaptured = snap.items.filter((it) => it.s).map((it) => it.s);
  assert.deepStrictEqual(
    titlesCaptured,
    ["My Media"],
    "above-fold title only, trimmed",
  );

  // round-trip: fresh boot paints from what capture wrote
  const env2 = makeEnv({ store: env.store });
  env2.run();
  assert(findOverlay(env2), "captured snapshot paints on next boot");
}

// ---- 11. capture refuses thin results (< 4 images) --------------------------------
{
  const env = makeEnv({
    store: {
      jellyfin_credentials: CREDS,
      "jellyfin.shell.serverUrl": "http://srv",
    },
    hash: "#/home.html",
  });
  env.run();
  env.setCards([0, 1, 2, 3, 4, 5].map(() => visibleCard(env)));
  const img = env.makeNode("IMG");
  img.src = "http://srv/only";
  img.rect = { width: 320, height: 180, top: 140, bottom: 320, left: 40 };
  env.setMedia([img]);
  env.advance(10000);
  assert.strictEqual(env.window.__shellIH.captured, 0, "thin capture rejected");
  assert(!(MK in env.store), "no meta written");
}

// ---- 12. capture never fires off-home or unsettled ---------------------------------
{
  const env = makeEnv({
    store: {
      jellyfin_credentials: CREDS,
      "jellyfin.shell.serverUrl": "http://srv",
    },
    hash: "#/movies.html",
  });
  env.run();
  env.setCards([0, 1, 2, 3, 4, 5].map(() => visibleCard(env)));
  env.advance(20000);
  assert.strictEqual(
    env.window.__shellIH.captured,
    0,
    "off-home never captures",
  );
}

// ---- 12b. JELA-22: capture is pinned to the pristine above-fold (scrollY~0) ---------
// A settled home that is scrolled down must NOT be snapshotted (it would bake a
// mid-page card row like "Adventure" into the boot overlay); once scrolled back
// to the pristine top the very next stable window captures.
function settleHome(env) {
  env.setCards([0, 1, 2, 3, 4, 5].map(() => visibleCard(env)));
  const t1 = env.makeNode("H2");
  t1.textContent = "Continue Watching";
  t1.rect = { width: 300, height: 40, top: 80, bottom: 120, left: 40 };
  env.setTitles([t1]);
  const media = [];
  for (let i = 0; i < 5; i++) {
    const img = env.makeNode("IMG");
    img.src = "http://srv/Items/" + i + "/Images/Primary";
    img.rect = {
      width: 320,
      height: 180,
      top: 140,
      bottom: 320,
      left: 40 + i * 340,
    };
    media.push(img);
  }
  env.setMedia(media);
}
{
  // scrolled down the whole time → never captures
  const env = makeEnv({
    store: {
      jellyfin_credentials: CREDS,
      "jellyfin.shell.serverUrl": "http://srv",
    },
    hash: "#/home.html",
    scrollY: 400,
  });
  env.run();
  settleHome(env);
  env.advance(30000);
  assert.strictEqual(
    env.window.__shellIH.captured,
    0,
    "scrolled home never captures (no mid-page snapshot)",
  );
  assert(!(MK in env.store), "no snapshot written while scrolled");

  // scroll back to the pristine top → next stable window captures
  env.setScroll(0);
  env.advance(35000);
  assert.strictEqual(
    env.window.__shellIH.captured,
    1,
    "capture fires once scrolled back to scrollY~0",
  );
  assert(MK in env.store, "pristine above-fold snapshot written");
}
{
  // small residual scroll within tolerance (<= 8 px) still captures
  const env = makeEnv({
    store: {
      jellyfin_credentials: CREDS,
      "jellyfin.shell.serverUrl": "http://srv",
    },
    hash: "#/home.html",
    scrollY: 8,
  });
  env.run();
  settleHome(env);
  env.advance(8000);
  assert.strictEqual(
    env.window.__shellIH.captured,
    1,
    "scrollY within 8 px tolerance still counts as pristine top",
  );
}

// ---- 13. quota abort leaves no torn snapshot ----------------------------------------
{
  const env = makeEnv({
    store: {
      jellyfin_credentials: CREDS,
      "jellyfin.shell.serverUrl": "http://srv",
    },
    hash: "#/home.html",
    setThrows: true,
  });
  env.run();
  env.setCards([0, 1, 2, 3, 4, 5].map(() => visibleCard(env)));
  const media = [];
  for (let i = 0; i < 5; i++) {
    const img = env.makeNode("IMG");
    img.src = "http://srv/Items/" + i + "/img";
    img.rect = {
      width: 320,
      height: 180,
      top: 140,
      bottom: 320,
      left: 40 + i * 340,
    };
    media.push(img);
  }
  env.setMedia(media);
  env.advance(6000);
  assert.strictEqual(env.window.__shellIH.captured, 0);
  assert(!(MK in env.store), "meta removed on write failure");
  assert(env.window.__shellIH.err > 0, "failure counted, not thrown");
}

// ---- 14. chunking round-trip (multi-chunk snapshot) ---------------------------------
{
  const items = [];
  for (let i = 0; i < 80; i++) {
    items.push({
      x: 40,
      y: 140,
      w: 320,
      h: 180,
      u: "http://srv/Items/" + i + "/Images/Primary?tag=" + "x".repeat(400),
      r: 6,
    });
  }
  const store = makeSnapshotStore({ items });
  assert(JSON.parse(store[MK]).n >= 2, "fixture spans multiple chunks");
  const env = makeEnv({ store });
  env.run();
  const overlay = findOverlay(env);
  assert(overlay, "multi-chunk snapshot reassembles and paints");
  assert.strictEqual(overlay.children.length, 80);
}

// ---- 15. DOMParser-path injector carries the shipped body ---------------------------
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
    "instantHomeBody",
    injectFnSrc + "; return injectInstantHome;",
  )(() => body);
  inject(doc);
  assert.strictEqual(headChildren.length, 1);
  assert.strictEqual(headChildren[0].attrs["data-shell-instant-home"], "1");
  assert.strictEqual(headChildren[0].textContent, body);
}

console.log("instant-home.test.cjs: all assertions passed");
