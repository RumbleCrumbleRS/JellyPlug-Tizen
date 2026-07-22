/*
 * JELA-67 (M1 slice 2): JellyPlug Lite loader — opt-in canvas home
 * delivered over the JELA-66-shaped localStorage byte cache.
 *
 * Extracts the shipped Lite block from RETAIL shell.js (the loader is
 * deliberately retail-only, like directHome/diagBeacon — see the
 * cross-shell-parity pin) and drives it with fake localStorage / fetch /
 * timers, pinning:
 *   - default OFF: no flag -> maybeBootLite is inert (no diag object, no
 *     fetches, SPA path taken)
 *   - flag on, empty cache -> st="miss", SPA boots THIS boot, restock
 *     chain fetches manifest + lite.min.js?v=<liteSha256> and stores
 *     {v:1,sha,len,h,ts,body} with a txFnv1a-valid h
 *   - flag on, valid record -> st="live", returns true (SPA skipped),
 *     ZERO Lite fetches before the revalidate, instant-home overlay
 *     dismissed (node removed + __shellIH.dismissed=1 why="lite"),
 *     revalidate that matches the manifest sha stops without a body fetch
 *   - corrupt record (fnv1a mismatch) -> treated as miss, not exec'd
 *   - JellyPlugLite.boot returning null (no session) -> st="no-session",
 *     SPA path taken
 *   - body that throws -> st="exec-err", SPA path taken
 *   - manifest sha != rec.sha -> revalidate restocks the NEW bytes for
 *     the next boot (stale-one-boot SWR)
 *   - manifest without liteSha256 (old server plugin) -> restock stops
 *     quietly ("no-lite"), nothing stored
 *   - restock fetch failure -> retries on window timers
 *     (LITE_RESTOCK_MS chain), then restock="failed:net"
 *   - OK/Back/Menu from a live Lite app -> hands off to the stubbed
 *     loadRemoteWebClient (st="handoff"), exactly once; new lite bytes
 *     get app.handoff(msg) (canvas stays up with an "Opening…" overlay),
 *     old cached bytes fall back to app.destroy()
 *   - OK with a focused item deep-links: location.hash becomes
 *     #/details?id=<id>[&serverId=<sid>] BEFORE loadRemoteWebClient runs
 *     (M2); Back/Menu never touch the hash
 *   - d.app exposed on __shellLite for CDP key-nav counter QA
 *   - onMenu wired to toSpa (menu-key SPA escape hatch)
 *   - M2 pre-warm: ~4s after a live boot the loader fills
 *     window.__shellPrefetch with the /web/ index+config fetch pair
 *     (d.warm=1); skipped when the head-IIFE slot is already populated;
 *     a failed warm CLEARS the slot (handoff falls back to fresh
 *     fetches) and resets d.warm to 0; the TTL timer clears both too
 *   - M2 bg-warm (idle-deferred per the JELA-67 jank-spike verdict on
 *     the Q60R M63): a live boot arms a capture keydown listener + idle
 *     countdown; any key re-arms it; after ~5s of input idle a hidden
 *     1280x720 /web/ iframe warms the full SPA ONCE per boot
 *     (bgwarm: warming->warm->done, bgwarmMs on load); the iframe is
 *     dropped after a post-load linger, on a load-timeout, or the
 *     instant a handoff starts (never competes with the real SPA boot)
 * Plus static pins: the flag / record-key / manifest-key literals ship in
 * the committed retail shell.min.js and do NOT ship in the baked
 * boot-shell.min.js (the divergence is deliberate).
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const RETAIL_SRC = path.join(__dirname, "..", "src", "shell.js");
const RETAIL_MIN = path.join(__dirname, "..", "src", "shell.min.js");
const BOOT_MIN = path.join(
  __dirname,
  "..",
  "..",
  "shell-tizen-bootstrap",
  "src",
  "boot-shell.min.js",
);

let fails = 0;
function check(name, cond) {
  console.log((cond ? "OK: " : "FAIL: ") + name);
  if (!cond) fails++;
}

const src = fs.readFileSync(RETAIL_SRC, "utf8");

function extractBlock(startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker, start);
  if (start < 0 || end < 0 || end <= start)
    throw new Error("block markers missing: " + startMarker);
  return src.slice(start, end);
}

// txFnv1a + the whole Lite block, ending where loadRemoteWebClient begins.
const fnvBlock = extractBlock("  function txFnv1a(s) {", "\n  var TX_VER");
const liteBlock = extractBlock(
  "  // ---- JellyPlug Lite (JELA-67)",
  "  function loadRemoteWebClient(serverUrl) {",
);

function fnv(s) {
  // Independent mirror of txFnv1a (shift-multiply, base36) for building
  // records in tests.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(36);
}

// Models M3-slice-1+ lite bytes: handoff() present, serverId exposed,
// openNative controllable via w.__liteNativeMode ('take'|'throw'|other
// = decline) with every call recorded on app.nativeCalls.
const GOOD_BODY =
  "window.JellyPlugLite={boot:function(w,d){" +
  "w.__liteBootCalls=(w.__liteBootCalls||0)+1;" +
  "if(w.__liteNoSession)return null;" +
  "return w.__liteApp={destroyed:0,handoffs:0,handoffMsg:null," +
  "serverId:w.__liteNoServerId?null:'srv1'," +
  "onOpen:null,onBack:null,onMenu:null," +
  "nativeCalls:[]," +
  "openNative:function(it){this.nativeCalls.push(it);" +
  "if(w.__liteNativeMode==='throw')throw new Error('native boom');" +
  "return w.__liteNativeMode==='take'}," +
  "handoff:function(m){this.handoffs++;this.handoffMsg=m}," +
  "destroy:function(){this.destroyed++}}}};";

// Models slice-2/3 bytes still cached on TVs: destroy() only, and no
// openNative (the M3 fork must guard for it).
const OLD_BODY =
  "window.JellyPlugLite={boot:function(w,d){" +
  "return w.__liteApp={destroyed:0,onOpen:null,onBack:null,onMenu:null," +
  "destroy:function(){this.destroyed++}}}};";

function mkRec(body, sha) {
  return JSON.stringify({
    v: 1,
    sha: sha,
    len: body.length,
    h: fnv(body),
    ts: 1,
    body: body,
  });
}

function mkEnv(opts) {
  opts = opts || {};
  const store = new Map();
  if (opts.storage)
    Object.keys(opts.storage).forEach((k) => store.set(k, opts.storage[k]));
  const timers = [];
  let timerSeq = 0;
  const timerIds = new Map();
  const fetchLog = [];
  const removedNodes = [];
  const keyListeners = [];
  const frames = [];
  const spaCalls = [];
  const ctx = {
    console,
    Date,
    JSON,
    Promise,
    Error,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    setTimeout: (fn, ms) => {
      const t = { fn, ms };
      timers.push(t);
      timerIds.set(++timerSeq, t);
      return timerSeq;
    },
    clearTimeout: (id) => {
      const t = timerIds.get(id);
      const i = t ? timers.indexOf(t) : -1;
      if (i >= 0) timers.splice(i, 1);
    },
    document: {
      getElementById: (id) =>
        id === "__shell_instant_home" && !opts.noOverlay
          ? {
              parentNode: {
                removeChild: (n) => removedNodes.push(id),
              },
            }
          : null,
      addEventListener: (type, fn) => {
        if (type === "keydown") keyListeners.push(fn);
      },
      removeEventListener: (type, fn) => {
        const i = keyListeners.indexOf(fn);
        if (i >= 0) keyListeners.splice(i, 1);
      },
      createElement: (tag) => {
        const el = {
          tag,
          attrs: {},
          setAttribute(k, v) {
            this.attrs[k] = v;
          },
          onload: null,
          src: "",
          parentNode: null,
          removed: false,
        };
        if (tag === "iframe") frames.push(el);
        return el;
      },
      body: {
        appendChild: (el) => {
          el.parentNode = {
            removeChild: (n) => {
              n.removed = true;
            },
          };
          return el;
        },
      },
    },
    fetch: (url, o) => {
      fetchLog.push(url);
      if (url.indexOf("manifest.json") >= 0) {
        if (opts.manifestFails) return Promise.reject(new Error("net"));
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(opts.manifest || {}),
        });
      }
      if (url.indexOf("lite.min.js") >= 0) {
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(opts.liteBody || GOOD_BODY),
        });
      }
      if (url.indexOf("/web/") >= 0) {
        // M2 pre-warm pair (index.html + config.json)
        if (opts.webFails) return Promise.reject(new Error("net"));
        return Promise.resolve({ ok: true, text: () => Promise.resolve("") });
      }
      return Promise.reject(new Error("unexpected " + url));
    },
    location: { hash: "" },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(
    "var loadRemoteWebClientCalls=[];" +
      "function loadRemoteWebClient(u){loadRemoteWebClientCalls.push(u);return Promise.resolve()}\n" +
      fnvBlock +
      "\n" +
      liteBlock,
    ctx,
  );
  return {
    ctx,
    store,
    timers,
    fetchLog,
    removedNodes,
    keyListeners,
    frames,
    boot: () => vm.runInContext('maybeBootLite("http://srv")', ctx),
    flushTimers: () => {
      const due = timers.splice(0);
      due.forEach((t) => t.fn());
    },
    // Fire exactly one pending timer by its delay (bg-warm timers all use
    // distinct constants: idle 5000, timeout 45000, linger 20000).
    fire: (ms) => {
      const i = timers.findIndex((t) => t.ms === ms);
      if (i < 0) throw new Error("no pending timer with ms=" + ms);
      timers.splice(i, 1)[0].fn();
    },
    // Simulate a remote keydown reaching the shell's capture listener.
    key: () => keyListeners.slice().forEach((fn) => fn({ keyCode: 39 })),
  };
}

const drain = () => new Promise((r) => setImmediate(r));
const SHA = "a".repeat(64);
const SHA2 = "b".repeat(64);

async function main() {
  // 1. default OFF
  {
    const env = mkEnv();
    check("flag off: SPA path", env.boot() === false);
    check("flag off: no diag object", env.ctx.__shellLite === undefined);
    check("flag off: zero fetches", env.fetchLog.length === 0);
  }

  // 2. flag on, empty cache -> miss + restock
  {
    const env = mkEnv({
      storage: { "jellyfin.shell.liteEnabled": "1" },
      manifest: { liteSha256: SHA },
    });
    check("miss: SPA path", env.boot() === false);
    check("miss: st", env.ctx.__shellLite.st === "miss");
    env.flushTimers();
    await drain();
    check(
      "miss: manifest then body fetched",
      env.fetchLog.length === 2 &&
        env.fetchLog[0].indexOf("/shell/manifest.json?__lt=") > 0 &&
        env.fetchLog[1] === "http://srv/shell/lite.min.js?v=" + SHA,
    );
    const rec = JSON.parse(env.store.get("jellyfin.lite.body"));
    check(
      "miss: record stored with sha+fnv1a",
      rec.v === 1 &&
        rec.sha === SHA &&
        rec.len === GOOD_BODY.length &&
        rec.h === fnv(GOOD_BODY) &&
        rec.body === GOOD_BODY,
    );
    check(
      "miss: restock diag",
      env.ctx.__shellLite.restock === "stored b=" + GOOD_BODY.length,
    );
  }

  // 3. flag on, valid record -> live boot, SPA skipped
  {
    const env = mkEnv({
      storage: {
        "jellyfin.shell.liteEnabled": "1",
        "jellyfin.lite.body": mkRec(GOOD_BODY, SHA),
      },
      manifest: { liteSha256: SHA },
    });
    env.ctx.__shellIH = { dismissed: 0, why: "" };
    check("live: SPA skipped", env.boot() === true);
    check(
      "live: st + sha",
      env.ctx.__shellLite.st === "live" && env.ctx.__shellLite.sha === SHA,
    );
    check("live: boot called once", env.ctx.__liteBootCalls === 1);
    check("live: zero fetches on the critical path", env.fetchLog.length === 0);
    check(
      "live: instant-home overlay dismissed",
      env.removedNodes.length === 1 &&
        env.ctx.__shellIH.dismissed === 1 &&
        env.ctx.__shellIH.why === "lite",
    );
    env.flushTimers();
    await drain();
    const shellFetches = env.fetchLog.filter((u) => u.indexOf("/shell/") >= 0);
    const webFetches = env.fetchLog.filter((u) => u.indexOf("/web/") >= 0);
    check(
      "live: revalidate is manifest-only on sha match",
      shellFetches.length === 1 &&
        env.ctx.__shellLite.restock === "fresh" &&
        JSON.parse(env.store.get("jellyfin.lite.body")).sha === SHA,
    );
    // M2 pre-warm: the /web/ pair lands in the __shellPrefetch slot
    check(
      "live: pre-warm fetched /web/ index+config into __shellPrefetch",
      webFetches.length === 2 &&
        webFetches.indexOf("http://srv/web/index.html") >= 0 &&
        webFetches.indexOf("http://srv/web/config.json") >= 0 &&
        env.ctx.__shellPrefetch &&
        env.ctx.__shellPrefetch.baseUrl === "http://srv/web/" &&
        env.ctx.__shellLite.warm === 1,
    );
    // TTL timer (queued by the warm) clears the slot when it fires
    env.flushTimers();
    check(
      "live: warm TTL clears __shellPrefetch and resets warm to 0",
      env.ctx.__shellPrefetch === null && env.ctx.__shellLite.warm === 0,
    );
    // d.app exposed for CDP key-nav QA
    check(
      "live: d.app exposed on __shellLite",
      env.ctx.__shellLite.app === env.ctx.__liteApp,
    );
    // onMenu wired to toSpa escape hatch
    check(
      "live: onMenu is wired (not null)",
      typeof env.ctx.__liteApp.onMenu === "function",
    );
    // OK (no focused item) -> handoff to the SPA, exactly once. New lite
    // bytes keep the canvas up via handoff(); destroy() is not called.
    const app = env.ctx.__liteApp;
    app.onOpen();
    app.onBack();
    check(
      "live: OK/Back hands off once via app.handoff (no destroy)",
      env.ctx.__shellLite.st === "handoff" &&
        app.handoffs === 1 &&
        app.destroyed === 0 &&
        vm.runInContext("loadRemoteWebClientCalls.length", env.ctx) === 1,
    );
    check(
      "live: itemless OK never touches the hash",
      env.ctx.location.hash === "",
    );
    check(
      "live: handoff boot will not re-enter lite",
      env.ctx.__shellLiteHandled === 1 && env.boot() === false,
    );
  }

  // 3b. menu-key escape hatch -> same handoff path as OK/Back
  {
    const env = mkEnv({
      storage: {
        "jellyfin.shell.liteEnabled": "1",
        "jellyfin.lite.body": mkRec(GOOD_BODY, SHA),
      },
      manifest: { liteSha256: SHA },
    });
    env.boot();
    const app2 = env.ctx.__liteApp;
    app2.onMenu();
    check(
      "menu-key: onMenu hands off to SPA once",
      env.ctx.__shellLite.st === "handoff" &&
        app2.handoffs === 1 &&
        vm.runInContext("loadRemoteWebClientCalls.length", env.ctx) === 1,
    );
    check(
      "menu-key: escape never touches the hash",
      env.ctx.location.hash === "",
    );
    // second onMenu is a no-op (idempotent once st="handoff")
    app2.onMenu();
    check(
      "menu-key: second onMenu is a no-op",
      vm.runInContext("loadRemoteWebClientCalls.length", env.ctx) === 1,
    );
  }

  // 3c. M2 deep link: OK on a focused item routes the SPA to #/details
  {
    const env = mkEnv({
      storage: {
        "jellyfin.shell.liteEnabled": "1",
        "jellyfin.lite.body": mkRec(GOOD_BODY, SHA),
      },
      manifest: { liteSha256: SHA },
    });
    env.boot();
    const app = env.ctx.__liteApp;
    app.onOpen({ id: "it/1", name: "The Thing", type: "Movie" });
    check(
      "deep link: hash set to #/details with id+serverId before the SPA",
      env.ctx.location.hash ===
        "#/details?id=" + encodeURIComponent("it/1") + "&serverId=srv1" &&
        env.ctx.__shellLite.st === "handoff" &&
        vm.runInContext("loadRemoteWebClientCalls.length", env.ctx) === 1,
    );
    check(
      "deep link: handoff overlay names the item",
      app.handoffMsg === "Opening The Thing…",
    );
  }

  // 3d. deep link degrades without a credentials server id
  {
    const env = mkEnv({
      storage: {
        "jellyfin.shell.liteEnabled": "1",
        "jellyfin.lite.body": mkRec(GOOD_BODY, SHA),
      },
      manifest: { liteSha256: SHA },
    });
    env.ctx.__liteNoServerId = 1;
    env.boot();
    env.ctx.__liteApp.onOpen({ id: "it2", name: "X" });
    check(
      "deep link: no serverId -> #/details?id=… only",
      env.ctx.location.hash === "#/details?id=it2",
    );
  }

  // 3e. OLD cached lite bytes (no handoff()) still hand off via destroy
  {
    const env = mkEnv({
      storage: {
        "jellyfin.shell.liteEnabled": "1",
        "jellyfin.lite.body": mkRec(OLD_BODY, SHA),
      },
      manifest: { liteSha256: SHA },
    });
    env.boot();
    const app = env.ctx.__liteApp;
    app.onOpen({ id: "it3", name: "Y" });
    check(
      "old bytes: destroy fallback + deep link still set (no serverId)",
      app.destroyed === 1 &&
        env.ctx.__shellLite.st === "handoff" &&
        env.ctx.location.hash === "#/details?id=it3" &&
        vm.runInContext("loadRemoteWebClientCalls.length", env.ctx) === 1,
    );
  }

  // 3m. M3 fork default-OFF: no jellyfin.lite.native flag -> OK never
  // consults openNative, the M2 deep-link runs exactly as today
  {
    const env = mkEnv({
      storage: {
        "jellyfin.shell.liteEnabled": "1",
        "jellyfin.lite.body": mkRec(GOOD_BODY, SHA),
      },
      manifest: { liteSha256: SHA },
    });
    env.boot();
    const app = env.ctx.__liteApp;
    app.onOpen({ id: "it4", name: "Z", type: "Movie" });
    check(
      "native default-off: openNative never called, deep-link unchanged",
      app.nativeCalls.length === 0 &&
        env.ctx.location.hash === "#/details?id=it4&serverId=srv1" &&
        env.ctx.__shellLite.st === "handoff" &&
        vm.runInContext("loadRemoteWebClientCalls.length", env.ctx) === 1,
    );
  }

  // 3n. M3 fork flag on + openNative takes the press -> NO SPA: no hash,
  // no handoff, Lite stays live; a later Back still hands off normally
  {
    const env = mkEnv({
      storage: {
        "jellyfin.shell.liteEnabled": "1",
        "jellyfin.lite.native": "1",
        "jellyfin.lite.body": mkRec(GOOD_BODY, SHA),
      },
      manifest: { liteSha256: SHA },
    });
    env.boot();
    env.ctx.__liteNativeMode = "take";
    const app = env.ctx.__liteApp;
    const item = { id: "it5", name: "Heat", type: "Movie" };
    app.onOpen(item);
    check(
      "native take: openNative got the item, no SPA load, no hash, st live",
      app.nativeCalls.length === 1 &&
        app.nativeCalls[0] === item &&
        env.ctx.location.hash === "" &&
        env.ctx.__shellLite.st === "live" &&
        env.ctx.__shellLite.native === 1 &&
        app.handoffs === 0 &&
        vm.runInContext("loadRemoteWebClientCalls.length", env.ctx) === 0,
    );
    app.onOpen(item);
    check(
      "native take: d.native counts repeated takes",
      env.ctx.__shellLite.native === 2 &&
        vm.runInContext("loadRemoteWebClientCalls.length", env.ctx) === 0,
    );
    app.onBack();
    check(
      "native take: Back after native plays still hands off to the SPA",
      env.ctx.__shellLite.st === "handoff" &&
        app.handoffs === 1 &&
        vm.runInContext("loadRemoteWebClientCalls.length", env.ctx) === 1,
    );
  }

  // 3o. M3 fork flag on + openNative declines -> M2 deep-link fallback
  {
    const env = mkEnv({
      storage: {
        "jellyfin.shell.liteEnabled": "1",
        "jellyfin.lite.native": "1",
        "jellyfin.lite.body": mkRec(GOOD_BODY, SHA),
      },
      manifest: { liteSha256: SHA },
    });
    env.boot();
    const app = env.ctx.__liteApp;
    app.onOpen({ id: "it6", name: "Y", type: "Series" });
    check(
      "native decline: falls through to the deep-link",
      app.nativeCalls.length === 1 &&
        env.ctx.location.hash === "#/details?id=it6&serverId=srv1" &&
        env.ctx.__shellLite.st === "handoff" &&
        env.ctx.__shellLite.native === undefined &&
        vm.runInContext("loadRemoteWebClientCalls.length", env.ctx) === 1,
    );
  }

  // 3p. M3 fork flag on + openNative THROWS -> deep-link fallback (the
  // user is never stuck on a broken native path)
  {
    const env = mkEnv({
      storage: {
        "jellyfin.shell.liteEnabled": "1",
        "jellyfin.lite.native": "1",
        "jellyfin.lite.body": mkRec(GOOD_BODY, SHA),
      },
      manifest: { liteSha256: SHA },
    });
    env.boot();
    env.ctx.__liteNativeMode = "throw";
    const app = env.ctx.__liteApp;
    app.onOpen({ id: "it7", name: "W", type: "Movie" });
    check(
      "native throw: falls through to the deep-link",
      app.nativeCalls.length === 1 &&
        env.ctx.location.hash === "#/details?id=it7&serverId=srv1" &&
        env.ctx.__shellLite.st === "handoff" &&
        vm.runInContext("loadRemoteWebClientCalls.length", env.ctx) === 1,
    );
  }

  // 3q. M3 fork flag on + OLD cached bytes (no openNative) -> guarded,
  // deep-link fallback via destroy()
  {
    const env = mkEnv({
      storage: {
        "jellyfin.shell.liteEnabled": "1",
        "jellyfin.lite.native": "1",
        "jellyfin.lite.body": mkRec(OLD_BODY, SHA),
      },
      manifest: { liteSha256: SHA },
    });
    env.boot();
    const app = env.ctx.__liteApp;
    app.onOpen({ id: "it8", name: "V", type: "Movie" });
    check(
      "native flag + old bytes: no openNative -> deep-link via destroy",
      app.destroyed === 1 &&
        env.ctx.location.hash === "#/details?id=it8" &&
        env.ctx.__shellLite.st === "handoff" &&
        vm.runInContext("loadRemoteWebClientCalls.length", env.ctx) === 1,
    );
  }

  // 3f. pre-warm defers to a live head-IIFE prefetch slot
  {
    const env = mkEnv({
      storage: {
        "jellyfin.shell.liteEnabled": "1",
        "jellyfin.lite.body": mkRec(GOOD_BODY, SHA),
      },
      manifest: { liteSha256: SHA },
    });
    const headPf = { baseUrl: "http://srv/web/" };
    env.ctx.__shellPrefetch = headPf;
    env.boot();
    env.flushTimers();
    await drain();
    check(
      "pre-warm: head prefetch present -> no /web/ fetches, slot untouched",
      env.fetchLog.filter((u) => u.indexOf("/web/") >= 0).length === 0 &&
        env.ctx.__shellPrefetch === headPf,
    );
  }

  // 3g. failed pre-warm clears the slot (handoff falls back to fresh)
  {
    const env = mkEnv({
      storage: {
        "jellyfin.shell.liteEnabled": "1",
        "jellyfin.lite.body": mkRec(GOOD_BODY, SHA),
      },
      manifest: { liteSha256: SHA },
      webFails: true,
    });
    env.boot();
    env.flushTimers();
    await drain();
    check(
      "pre-warm: fetch failure clears __shellPrefetch",
      env.ctx.__shellPrefetch === null,
    );
    // CEO nit (PR #116): a cleared slot must flip the diag back
    check(
      "pre-warm: fetch failure resets __shellLite.warm to 0",
      env.ctx.__shellLite.warm === 0,
    );
  }

  // 3h. M2 bg-warm: idle countdown kicks a hidden full-SPA iframe once,
  // load -> linger -> the live document is dropped (caches stay warm)
  {
    const env = mkEnv({
      storage: {
        "jellyfin.shell.liteEnabled": "1",
        "jellyfin.lite.body": mkRec(GOOD_BODY, SHA),
      },
      manifest: { liteSha256: SHA },
    });
    env.boot();
    check(
      "bgwarm: armed on live boot (capture keydown listener + idle timer)",
      env.keyListeners.length === 1 &&
        env.timers.filter((t) => t.ms === 5000).length === 1,
    );
    check(
      "bgwarm: nothing warms before the idle fires",
      env.frames.length === 0,
    );
    env.fire(5000);
    const fr = env.frames[0];
    check(
      "bgwarm: idle kick appends the hidden 1280x720 /web/ iframe",
      env.frames.length === 1 &&
        fr.src === "http://srv/web/index.html" &&
        fr.attrs.style.indexOf("visibility:hidden") >= 0 &&
        fr.attrs.style.indexOf("width:1280px") >= 0 &&
        fr.attrs.style.indexOf("pointer-events:none") >= 0 &&
        env.ctx.__shellLite.bgwarm === "warming" &&
        env.ctx.__shellLiteBgWarm === 1,
    );
    check(
      "bgwarm: keydown listener detached at kick (once per boot)",
      env.keyListeners.length === 0,
    );
    check(
      "bgwarm: load-timeout guard armed",
      env.timers.some((t) => t.ms === 45000),
    );
    fr.onload();
    check(
      "bgwarm: load flips diag to warm + bgwarmMs, timeout swapped for linger",
      env.ctx.__shellLite.bgwarm === "warm" &&
        typeof env.ctx.__shellLite.bgwarmMs === "number" &&
        !env.timers.some((t) => t.ms === 45000) &&
        env.timers.some((t) => t.ms === 20000),
    );
    env.fire(20000);
    check(
      "bgwarm: linger drops the live iframe (bgwarm=done)",
      fr.removed === true && env.ctx.__shellLite.bgwarm === "done",
    );
  }

  // 3i. any keydown re-arms the idle countdown — the warm never starts
  // while the user is driving the remote
  {
    const env = mkEnv({
      storage: {
        "jellyfin.shell.liteEnabled": "1",
        "jellyfin.lite.body": mkRec(GOOD_BODY, SHA),
      },
      manifest: { liteSha256: SHA },
    });
    env.boot();
    env.key();
    env.key();
    check(
      "bgwarm: keys re-arm — exactly one pending idle timer, no iframe",
      env.timers.filter((t) => t.ms === 5000).length === 1 &&
        env.frames.length === 0,
    );
    env.fire(5000);
    check("bgwarm: idle after keys still warms", env.frames.length === 1);
  }

  // 3j. handoff mid-warm kills the iframe — the SPA boot must never
  // compete with its own warm-up for the single M63 main thread
  {
    const env = mkEnv({
      storage: {
        "jellyfin.shell.liteEnabled": "1",
        "jellyfin.lite.body": mkRec(GOOD_BODY, SHA),
      },
      manifest: { liteSha256: SHA },
    });
    env.boot();
    env.fire(5000);
    const fr = env.frames[0];
    env.ctx.__liteApp.onBack();
    check(
      "bgwarm: handoff removes the warming iframe + its timeout guard",
      fr.removed === true &&
        !env.timers.some((t) => t.ms === 45000) &&
        env.ctx.__shellLite.st === "handoff",
    );
  }

  // 3k. handoff before the countdown disarms the warm entirely
  {
    const env = mkEnv({
      storage: {
        "jellyfin.shell.liteEnabled": "1",
        "jellyfin.lite.body": mkRec(GOOD_BODY, SHA),
      },
      manifest: { liteSha256: SHA },
    });
    env.boot();
    env.ctx.__liteApp.onMenu();
    check(
      "bgwarm: handoff disarms — listener gone, idle timer cleared, no iframe",
      env.keyListeners.length === 0 &&
        !env.timers.some((t) => t.ms === 5000) &&
        env.frames.length === 0,
    );
  }

  // 3l. wedged server: load never fires -> timeout abandons the iframe
  {
    const env = mkEnv({
      storage: {
        "jellyfin.shell.liteEnabled": "1",
        "jellyfin.lite.body": mkRec(GOOD_BODY, SHA),
      },
      manifest: { liteSha256: SHA },
    });
    env.boot();
    env.fire(5000);
    env.fire(45000);
    check(
      "bgwarm: load-timeout abandons the iframe (bgwarm=timeout)",
      env.frames[0].removed === true &&
        env.ctx.__shellLite.bgwarm === "timeout",
    );
  }

  // 3m. JELA-137: a live native AVPlay session defers the warm — the
  // iframe boot stalls the single M63 main thread mid-movie (M3 QA:
  // one G1 inflated to 4.1s). Poll again next idle window; latch and
  // keydown re-arm listener stay intact; session end releases the warm.
  {
    const env = mkEnv({
      storage: {
        "jellyfin.shell.liteEnabled": "1",
        "jellyfin.lite.body": mkRec(GOOD_BODY, SHA),
      },
      manifest: { liteSha256: SHA },
    });
    env.boot();
    env.ctx.__shellLite.player = { st: "playing" };
    env.fire(5000);
    check(
      "bgwarm: native session live → defer, no iframe, latch unconsumed",
      env.frames.length === 0 &&
        env.ctx.__shellLite.bgwarm === "defer-native" &&
        env.ctx.__shellLiteBgWarm === undefined &&
        env.keyListeners.length === 1 &&
        env.timers.filter((t) => t.ms === 5000).length === 1,
    );
    env.ctx.__shellLite.player.st = "paused";
    env.fire(5000);
    check(
      "bgwarm: paused still defers (any non-terminal player state)",
      env.frames.length === 0 &&
        env.timers.filter((t) => t.ms === 5000).length === 1,
    );
    env.ctx.__shellLite.player.st = "closed";
    env.fire(5000);
    check(
      "bgwarm: session end releases the deferred warm",
      env.frames.length === 1 && env.ctx.__shellLiteBgWarm === 1,
    );
  }

  // 3n. JELA-137: a bailed native attempt (player diag st=err) never
  // blocks the warm — err is terminal
  {
    const env = mkEnv({
      storage: {
        "jellyfin.shell.liteEnabled": "1",
        "jellyfin.lite.body": mkRec(GOOD_BODY, SHA),
      },
      manifest: { liteSha256: SHA },
    });
    env.boot();
    env.ctx.__shellLite.player = { st: "err" };
    env.fire(5000);
    check(
      "bgwarm: terminal player state does not defer",
      env.frames.length === 1,
    );
  }

  // 4. corrupt record (fnv1a mismatch) -> miss, never exec'd
  {
    const bad = JSON.parse(mkRec(GOOD_BODY, SHA));
    bad.h = bad.h + "x";
    const env = mkEnv({
      storage: {
        "jellyfin.shell.liteEnabled": "1",
        "jellyfin.lite.body": JSON.stringify(bad),
      },
      manifest: { liteSha256: SHA },
    });
    check("corrupt rec: SPA path", env.boot() === false);
    check("corrupt rec: st=miss", env.ctx.__shellLite.st === "miss");
    check(
      "corrupt rec: body never exec'd",
      env.ctx.__liteBootCalls === undefined,
    );
  }

  // 5. no stored session -> SPA owns login
  {
    const env = mkEnv({
      storage: {
        "jellyfin.shell.liteEnabled": "1",
        "jellyfin.lite.body": mkRec(GOOD_BODY, SHA),
      },
      manifest: { liteSha256: SHA },
    });
    env.ctx.__liteNoSession = 1;
    check("no-session: SPA path", env.boot() === false);
    check("no-session: st", env.ctx.__shellLite.st === "no-session");
    env.flushTimers();
    await drain();
    check(
      "no-session: still revalidates (manifest-only on match)",
      env.fetchLog.length === 1 && env.ctx.__shellLite.restock === "fresh",
    );
  }

  // 6. throwing body -> exec-err, SPA path, and the bad blob gets REPLACED
  // (haveSha=null restock — found live on the Q60R: a cached blob the M63
  // could not parse stuck the TV on exec-err every boot because rec.sha
  // still matched the fetch sha).
  {
    const body = 'throw new Error("boom")';
    const env = mkEnv({
      storage: {
        "jellyfin.shell.liteEnabled": "1",
        "jellyfin.lite.body": mkRec(body, SHA),
      },
      manifest: { liteSha256: SHA2 },
    });
    check("exec-err: SPA path", env.boot() === false);
    check("exec-err: st", env.ctx.__shellLite.st === "exec-err");
    env.flushTimers();
    await drain();
    const rec = JSON.parse(env.store.get("jellyfin.lite.body"));
    check(
      "exec-err: restock replaces the bad blob",
      rec.sha === SHA2 && rec.body === GOOD_BODY,
    );
  }

  // 7. sha mismatch -> restock new bytes for the NEXT boot (SWR)
  {
    const newBody = GOOD_BODY + ";1";
    const env = mkEnv({
      storage: {
        "jellyfin.shell.liteEnabled": "1",
        "jellyfin.lite.body": mkRec(GOOD_BODY, SHA),
      },
      manifest: { liteSha256: SHA2 },
      liteBody: newBody,
    });
    check("swr: stale rec still boots", env.boot() === true);
    env.flushTimers();
    await drain();
    const rec = JSON.parse(env.store.get("jellyfin.lite.body"));
    check(
      "swr: new bytes stored under new sha",
      rec.sha === SHA2 && rec.body === newBody && rec.h === fnv(newBody),
    );
  }

  // 8. old server plugin (no liteSha256) -> stop quietly, nothing stored
  {
    const env = mkEnv({
      storage: { "jellyfin.shell.liteEnabled": "1" },
      manifest: {},
    });
    env.boot();
    env.flushTimers();
    await drain();
    check(
      "no-lite server: restock stops, nothing stored",
      env.ctx.__shellLite.restock === "no-lite" &&
        !env.store.has("jellyfin.lite.body") &&
        env.fetchLog.length === 1,
    );
  }

  // 9. restock failure -> window-timer retries, then failed:net
  {
    const env = mkEnv({
      storage: { "jellyfin.shell.liteEnabled": "1" },
      manifestFails: true,
    });
    env.boot();
    env.flushTimers(); // attempt 1 (0ms)
    await drain();
    check(
      "retry: first failure re-arms a timer",
      env.ctx.__shellLite.restock === "retry1:net" && env.timers.length === 1,
    );
    env.flushTimers(); // attempt 2
    await drain();
    env.flushTimers(); // attempt 3
    await drain();
    check(
      "retry: exhausts to failed:net",
      env.ctx.__shellLite.restock === "failed:net" && env.timers.length === 0,
    );
  }

  // 10. static pins on the committed blobs
  {
    const retailMin = fs.readFileSync(RETAIL_MIN, "utf8");
    const bootMin = fs.readFileSync(BOOT_MIN, "utf8");
    for (const lit of [
      "jellyfin.shell.liteEnabled",
      "jellyfin.lite.native",
      "jellyfin.lite.body",
      "liteSha256",
      "/shell/lite.min.js?v=",
    ]) {
      check("retail shell.min.js ships " + lit, retailMin.indexOf(lit) >= 0);
      check(
        "boot-shell.min.js deliberately omits " + lit,
        bootMin.indexOf(lit) < 0,
      );
    }
  }

  console.log(
    fails === 0
      ? "lite-loader.test.cjs OK"
      : "lite-loader.test.cjs: " + fails + " failure(s)",
  );
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
