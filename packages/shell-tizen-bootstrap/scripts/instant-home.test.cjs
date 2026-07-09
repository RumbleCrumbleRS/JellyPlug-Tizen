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
 *   - JELA-43 WS-1 input shield (default ON since JELA-49; kill-switch
 *     jellyfin.shell.instantHomeInputShieldDisabled=1): D-pad/Enter
 *     swallowed under the overlay, Back/Return/Esc always escapes,
 *     moving-target Enter guard after the crossfade; stands down with no
 *     overlay or a painted Direct-Home grid
 *   - JELA-43 WS-2 settle-gated dismissal (default ON since JELA-49;
 *     kill-switch jellyfin.shell.instantHomeSettleDismissDisabled=1):
 *     >= 4 cards + 1.5 s stylesheet + above-fold-mutation quiet ->
 *     "settled"; hard hold cap 15 s ("settlecap"), tunable down only;
 *     sub-4 partial stall retained
 *   - kill-switched boots reproduce the stock v1.0.4.0 dismissal paths
 *     (cases 1-16 pin "hydrated"/"input"/90 s "cap" under the switches)
 */
"use strict";
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const SRC = path.join(__dirname, "..", "src", "boot-shell.src.js");
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

// JELA-49: WS-1+2 are default ON; these per-behavior kill-switches restore
// the stock (v1.0.4.0) input/hydration dismissal. Legacy cases below set them
// to pin that the kill-switched path still IS the stock behavior.
const SHIELD_OFF = "jellyfin.shell.instantHomeInputShieldDisabled";
const SETTLE_OFF = "jellyfin.shell.instantHomeSettleDismissDisabled";
const HOLD_OFF = "jellyfin.shell.instantHomeHoldCoverDisabled";

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
    fire(type, ev) {
      (listeners[type] || []).forEach((fn) => fn(ev || { type }));
    },
    // JELA-43: keydown with a spy-able event (shield eat = preventDefault +
    // stopPropagation + stopImmediatePropagation). Returns the event so
    // callers can assert .pd (prevented) / .sp / .sip.
    fireKey(code) {
      const ev = {
        type: "keydown",
        keyCode: code,
        pd: 0,
        sp: 0,
        sip: 0,
        preventDefault() {
          this.pd = 1;
        },
        stopPropagation() {
          this.sp = 1;
        },
        stopImmediatePropagation() {
          this.sip = 1;
        },
      };
      (listeners.keydown || []).forEach((fn) => fn(ev));
      return ev;
    },
    // Simulates the document.open()/write() SPA index handoff: the window
    // object survives but ALL its event listeners are wiped along with the
    // whole DOM; the written document then re-executes the injected body.
    swapDoc() {
      for (const k in listeners) delete listeners[k];
      documentElement.children.length = 0;
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
// (SETTLE_OFF: case 4 pins the stock >=4-cards "hydrated" dismissal)
{
  const store = makeSnapshotStore();
  store[SETTLE_OFF] = "1";
  const env = makeEnv({ store });
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

// ---- 5. input dismiss (stock path: shield kill-switched) -------------------------
{
  const store = makeSnapshotStore();
  store[SHIELD_OFF] = "1";
  const env = makeEnv({ store });
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

// ---- 6b. JELA-54 hold-cover (default): NO "dh" handoff — the cover holds ---------
// User-decided default (JELA-52 ask 00d36d8f): the snapshot cover holds to the
// settled reveal instead of handing off to the Direct-Home grid. Even with a
// painted grid faked in, the "dh" branch must be skipped while hold-cover is
// on (in a real hold-cover boot directHomeBody stands down and never paints).
{
  const env = makeEnv({ store: makeSnapshotStore() });
  env.run();
  assert(findOverlay(env), "snapshot painted");
  env.window.__shellDH = { painted: 1, dismissed: 0 };
  env.advance(1500);
  assert.strictEqual(
    env.window.__shellIH.dismissed,
    0,
    "hold-cover: no dh handoff, the cover holds",
  );
  assert(findOverlay(env), "snapshot still up under hold-cover");
}

// ---- 6c. JELA-54 opt-out restores the JELA-33 A3 fusion handoff ------------------
// With jellyfin.shell.instantHomeHoldCoverDisabled=1 the pre-JELA-54 contract
// is byte-for-byte back: the snapshot hands off to the painted grid via "dh".
// In the baked boot-shell __shellDH never exists, so the branch is a
// structural no-op there — this case pins both sides of that contract.
{
  const store = makeSnapshotStore();
  store[HOLD_OFF] = "1";
  const env = makeEnv({ store });
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

// ---- 7. 90 s absolute cap (stock backstop: settle-dismiss kill-switched) ---------
{
  const store = makeSnapshotStore();
  store[SETTLE_OFF] = "1";
  const env = makeEnv({ store });
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

// ---- 16. JELA-37: input dismiss still works after the document.open handoff --------
// document.open() wipes ALL window listeners together with the DOM; the
// written document then re-executes the body (gen 2). The old once-per-G
// inputBound gate skipped the rebind there, so between the swap and SPA
// hydration a remote keypress could NOT dismiss the snapshot. The bind is
// per-run now (same fix as Direct-Home PR #82 / direct-home test 20).
// (SHIELD_OFF: pins the stock keydown-dismiss path across the swap.)
{
  const store = makeSnapshotStore();
  store[SHIELD_OFF] = "1";
  const env = makeEnv({ store });
  env.run();
  const G = env.window.__shellIH;
  assert(findOverlay(env), "gen-1 overlay painted");
  assert.strictEqual(G.inputBound, 1, "gen-1 run bound keydown");
  env.swapDoc();
  env.run();
  assert.strictEqual(G.gen, 2, "same G, second generation");
  assert.strictEqual(G.inputBound, 2, "keydown rebound by the gen-2 run");
  assert(findOverlay(env), "overlay recreated by the gen-2 run");
  env.fire("keydown");
  assert.strictEqual(G.dismissed, 1, "post-swap key dismisses the snapshot");
  assert.strictEqual(G.why, "input");
  env.advance(3000);
  assert.strictEqual(
    findOverlay(env),
    null,
    "overlay gone after post-swap input",
  );
}

// ---- 16b. JELA-37: a stale-gen survivor listener is inert --------------------------
// If an engine ever leaves an old listener alive while a newer generation
// owns the overlay, the gen guard in oi must keep the stale one from
// dismissing the newer generation's snapshot out from under it.
{
  const env = makeEnv({ store: makeSnapshotStore() });
  env.run();
  const G = env.window.__shellIH;
  G.gen++; // a newer generation owns the overlay now
  env.fire("keydown");
  assert.strictEqual(G.dismissed, 0, "stale-gen listener goes inert");
}

// ============================================================================
// JELA-43 (JELA-41 WS-1+2): input shield + settle-gated dismissal. Default ON
// since JELA-49 (JELA-48 ACCEPT) — every case below this line runs with no
// flags set and exercises the shipped default; the "…Disabled" kill-switches
// are pinned by the legacy cases above (stock v1.0.4.0 behavior).
// ============================================================================

const CAPKEY = "jellyfin.shell.instantHomeSettleCapMs";

// ---- static contract: kill-switch keys + dismiss reasons exist, stock path kept ----
assert(
  body.indexOf('!flg("' + SHIELD_OFF + '")') !== -1,
  "input shield is default ON behind the Disabled kill-switch",
);
assert(
  body.indexOf('!flg("' + SETTLE_OFF + '")') !== -1,
  "settle dismissal is default ON behind the Disabled kill-switch",
);
assert(body.indexOf(CAPKEY) !== -1, "settle-cap tuning key present");
assert(
  body.indexOf('dismiss("input")') !== -1,
  "flag-off first-keydown dismiss path retained",
);
assert(body.indexOf('dismiss("back")') !== -1, "Back escape hatch present");
assert(body.indexOf('dismiss("settled")') !== -1, "settled dismissal present");
assert(body.indexOf('dismiss("settlecap")') !== -1, "settle hard cap present");
// CEO condition #1: the cap literal is 15000 and capLim rejects anything
// above it (tunable DOWN only).
assert(
  body.indexOf("v>=1000&&v<=15000") !== -1 &&
    body.indexOf("return 15000") !== -1,
  "settle cap clamps to <= 15000 ms (never tunable up)",
);

// Fake MutationObserver the body picks up via window.MutationObserver.
function fakeMO(env) {
  const state = { cb: null, observed: null, opts: null, disconnected: 0 };
  env.window.MutationObserver = function (cb) {
    state.cb = cb;
    this.observe = (t, o) => {
      state.observed = t;
      state.opts = o;
    };
    this.disconnect = () => {
      state.disconnected++;
    };
  };
  return state;
}

// ---- 17. WS-1 shield: D-pad + Enter swallowed, overlay stays up ---------------
{
  const store = makeSnapshotStore();
  const env = makeEnv({ store });
  env.run();
  assert(findOverlay(env), "overlay painted");
  const G = env.window.__shellIH;
  for (const code of [37, 38, 39, 40, 13]) {
    const ev = env.fireKey(code);
    assert.strictEqual(ev.pd, 1, "key " + code + " preventDefault");
    assert.strictEqual(ev.sp, 1, "key " + code + " stopPropagation");
    assert.strictEqual(ev.sip, 1, "key " + code + " stopImmediatePropagation");
  }
  assert.strictEqual(G.eaten, 5, "all five keydowns counted as eaten");
  assert.strictEqual(G.dismissed, 0, "shield never dismisses on D-pad");
  assert(findOverlay(env), "overlay still up after swallowed input");

  // ---- 18. WS-1 Back = mandatory escape hatch, eaten + immediate dismiss ------
  const back = env.fireKey(10009);
  assert.strictEqual(back.pd, 1, "Back eaten (never reaches the live page)");
  assert.strictEqual(G.backEsc, 1, "backEsc diag counter");
  assert.strictEqual(G.dismissed, 1, "Back always dismisses");
  assert.strictEqual(G.why, "back");
  env.advance(3000);
  assert.strictEqual(findOverlay(env), null, "overlay gone after Back");
  // post-dismiss keys pass through untouched (shield is overlay-scoped)
  const after = env.fireKey(37);
  assert.strictEqual(after.pd, 0, "no eat once the overlay is gone");
  assert.strictEqual(G.eaten, 5, "eaten counter frozen after dismissal");
}

// ---- 19. WS-1 shield stands down when no overlay painted (unauthed) -----------
{
  const env = makeEnv({ store: {} });
  env.run();
  assert.strictEqual(findOverlay(env), null, "unauthed: no overlay");
  const ev = env.fireKey(37);
  assert.strictEqual(ev.pd, 0, "keys pass through with no overlay");
  assert.strictEqual(env.window.__shellIH.dismissed, 0);
  assert.strictEqual(env.window.__shellIH.eaten, 0);
}

// ---- 20. WS-1 shield stands down under a painted Direct-Home grid -------------
// (JELA-54: a painted grid only exists when hold-cover is opted out — under
// the hold-cover default directHomeBody stands down and never paints, so the
// stand-down is inert there and the shield owns input for the full hold.)
{
  const store = makeSnapshotStore();
  store[HOLD_OFF] = "1";
  const env = makeEnv({ store });
  env.run();
  env.window.__shellDH = { painted: 1, dismissed: 0 };
  const ev = env.fireKey(39);
  assert.strictEqual(ev.pd, 0, "grid owns input: shield does not eat");
  assert.strictEqual(env.window.__shellIH.eaten, 0);
  env.advance(1500);
  assert.strictEqual(env.window.__shellIH.why, "dh", "tick hands off to grid");
}

// ---- 21. WS-1 Esc/461 variants also escape ------------------------------------
{
  for (const code of [461, 27]) {
    const store = makeSnapshotStore();
    const env = makeEnv({ store });
    env.run();
    env.fireKey(code);
    assert.strictEqual(env.window.__shellIH.why, "back", "code " + code);
  }
}

// ---- 22. WS-1 moving-target Enter guard after crossfade ------------------------
{
  const store = makeSnapshotStore();
  const env = makeEnv({ store });
  env.run();
  const G = env.window.__shellIH;
  const focused = env.makeNode("BUTTON");
  focused.rect = { width: 300, height: 180, top: 200, bottom: 380, left: 40 };
  env.document.activeElement = focused;
  env.fireKey(10009); // dismiss at t=0 arms the guard
  assert.strictEqual(G.why, "back");
  // focused rect stable since the first 200 ms sample -> Enter passes at 1 s
  env.advance(1000);
  const pass1 = env.fireKey(13);
  assert.strictEqual(pass1.pd, 0, "stable focus: Enter passes through");
  assert.strictEqual(G.entHeld, 0);
  // rect moves -> next sample marks it -> Enter within 400 ms is eaten
  focused.rect = { width: 300, height: 180, top: 460, bottom: 640, left: 40 };
  env.advance(1200);
  const held = env.fireKey(13);
  assert.strictEqual(held.pd, 1, "moved focus: Enter suppressed");
  assert.strictEqual(G.entHeld, 1);
  // re-arm: stable for > 400 ms -> Enter passes again
  env.advance(1800);
  const pass2 = env.fireKey(13);
  assert.strictEqual(pass2.pd, 0, "guard re-arms once the rect settles");
  assert.strictEqual(G.entHeld, 1);
  // guard window closes at 10 s: listener goes inert even if the rect moves
  env.advance(11000);
  focused.rect = { width: 300, height: 180, top: 700, bottom: 880, left: 40 };
  env.advance(11400);
  const late = env.fireKey(13);
  assert.strictEqual(late.pd, 0, "guard inert past its 10 s window");
  assert.strictEqual(G.entHeld, 1);
}

// ---- 23. WS-2 settled dismissal (no MutationObserver: gate degrades open) -----
{
  const store = makeSnapshotStore();
  const env = makeEnv({ store });
  env.run();
  env.setCards([
    visibleCard(env),
    visibleCard(env),
    visibleCard(env),
    visibleCard(env),
  ]);
  const G = env.window.__shellIH;
  // stylesheet-count clock starts at the first tick (700 ms): 4 cards alone
  // must NOT dismiss before 1.5 s of stylesheet stability
  env.advance(2100);
  assert.strictEqual(G.dismissed, 0, ">=4 cards alone no longer dismisses");
  env.advance(2800);
  assert.strictEqual(G.dismissed, 1, "settled once stylesheets stable 1.5 s");
  assert.strictEqual(G.why, "settled");
  assert.strictEqual(G.settleMs, 2800, "settleMs diag recorded");
}

// ---- 24. WS-2 above-fold mutations hold the overlay; below-fold do not --------
{
  const store = makeSnapshotStore();
  const env = makeEnv({ store });
  const mo = fakeMO(env);
  env.run();
  assert(mo.observed, "MutationObserver armed on documentElement");
  assert.strictEqual(mo.opts.childList, true);
  assert.strictEqual(mo.opts.subtree, true);
  env.setCards([
    visibleCard(env),
    visibleCard(env),
    visibleCard(env),
    visibleCard(env),
  ]);
  const G = env.window.__shellIH;
  const above = visibleCard(env);
  const below = env.makeNode("DIV");
  below.rect = { width: 300, height: 180, top: 1200, bottom: 1380, left: 40 };
  // keep mutating above-fold: overlay must hold well past the flag-off point
  env.advance(2500);
  mo.cb([{ target: above }]);
  env.advance(3500);
  assert.strictEqual(G.dismissed, 0, "above-fold mutation at 2.5 s holds");
  // below-fold mutation does NOT reset the settle clock
  mo.cb([{ target: below }]);
  env.advance(4200);
  assert.strictEqual(
    G.dismissed,
    1,
    "settles 1.5 s after last ABOVE-fold mutation",
  );
  assert.strictEqual(G.why, "settled");
  assert.strictEqual(mo.disconnected, 1, "observer disconnected on dismissal");
}

// ---- 25. WS-2 new stylesheets reset the settle clock ---------------------------
{
  const store = makeSnapshotStore();
  const env = makeEnv({ store });
  env.run();
  env.setCards([
    visibleCard(env),
    visibleCard(env),
    visibleCard(env),
    visibleCard(env),
  ]);
  env.document.styleSheets = { length: 1 };
  const G = env.window.__shellIH;
  env.advance(2100);
  env.document.styleSheets = { length: 2 }; // late chunk CSS lands
  env.advance(3500);
  assert.strictEqual(G.dismissed, 0, "new stylesheet at 2.8 s tick holds");
  env.advance(5000);
  assert.strictEqual(
    G.dismissed,
    1,
    "settles 1.5 s after stylesheet count stabilizes",
  );
  assert.strictEqual(G.why, "settled");
}

// ---- 26. WS-2 hard cap: 15 s default, tunable DOWN, clamped never-up -----------
{
  // default 15 s
  const store = makeSnapshotStore();
  const env = makeEnv({ store });
  env.run(); // no cards ever hydrate
  env.advance(14700);
  assert.strictEqual(env.window.__shellIH.dismissed, 0, "held at 14.7 s");
  env.advance(15400);
  assert.strictEqual(env.window.__shellIH.why, "settlecap", "capped at 15 s");
}
{
  // tuned down to 5 s
  const store = makeSnapshotStore();
  store[CAPKEY] = "5000";
  const env = makeEnv({ store });
  env.run();
  env.advance(5600);
  assert.strictEqual(
    env.window.__shellIH.why,
    "settlecap",
    "tuned-down cap honored",
  );
}
{
  // attempted tune UP is rejected -> still 15 s
  const store = makeSnapshotStore();
  store[CAPKEY] = "60000";
  const env = makeEnv({ store });
  env.run();
  env.advance(15400);
  assert.strictEqual(
    env.window.__shellIH.why,
    "settlecap",
    "cap can never be tuned above 15 s",
  );
}

// ---- 27. WS-2 partial-stall path only fires below 4 cards ----------------------
{
  const store = makeSnapshotStore();
  const env = makeEnv({ store });
  const mo = fakeMO(env);
  env.run();
  env.setCards([visibleCard(env), visibleCard(env)]); // stalls at 2 cards
  env.advance(9800);
  assert.strictEqual(
    env.window.__shellIH.why,
    "partial",
    "sub-4 stall still bails",
  );
}
{
  // >= 4 cards but never settled (constant above-fold churn) must NOT go
  // "partial" at 8 s — it holds to the settle cap.
  const store = makeSnapshotStore();
  const env = makeEnv({ store });
  const mo = fakeMO(env);
  env.run();
  env.setCards([
    visibleCard(env),
    visibleCard(env),
    visibleCard(env),
    visibleCard(env),
  ]);
  const churn = visibleCard(env);
  for (let t = 1000; t <= 15000; t += 1000) {
    env.advance(t);
    mo.cb([{ target: churn }]);
  }
  env.advance(16000);
  assert.strictEqual(
    env.window.__shellIH.why,
    "settlecap",
    ">=4 unsettled holds to the cap, never partial",
  );
}

// ---- 28. WS-1+2 combined: shield holds input the whole settle window -----------
{
  const store = makeSnapshotStore();
  const env = makeEnv({ store });
  env.run();
  const G = env.window.__shellIH;
  env.advance(1000);
  env.fireKey(40);
  env.advance(2000);
  env.fireKey(13);
  assert.strictEqual(G.eaten, 2, "keys eaten while settling");
  assert.strictEqual(G.dismissed, 0);
  env.setCards([
    visibleCard(env),
    visibleCard(env),
    visibleCard(env),
    visibleCard(env),
  ]);
  env.advance(4600);
  assert.strictEqual(G.why, "settled", "settles with shield active");
  const after = env.fireKey(37);
  assert.strictEqual(after.pd, 0, "input flows to the live page after settle");
}

console.log("instant-home.test.cjs: all assertions passed");
