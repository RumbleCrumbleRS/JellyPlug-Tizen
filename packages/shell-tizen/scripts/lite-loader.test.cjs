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
 *   - OK/Back from a live Lite app -> app.destroy() + hands off to the
 *     stubbed loadRemoteWebClient (st="handoff"), exactly once
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

const GOOD_BODY =
  "window.JellyPlugLite={boot:function(w,d){" +
  "w.__liteBootCalls=(w.__liteBootCalls||0)+1;" +
  "if(w.__liteNoSession)return null;" +
  "return w.__liteApp={destroyed:0,onOpen:null,onBack:null," +
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
  const fetchLog = [];
  const removedNodes = [];
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
      timers.push({ fn, ms });
      return timers.length;
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
      return Promise.reject(new Error("unexpected " + url));
    },
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
    boot: () => vm.runInContext('maybeBootLite("http://srv")', ctx),
    flushTimers: () => {
      const due = timers.splice(0);
      due.forEach((t) => t.fn());
    },
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
    check(
      "live: revalidate is manifest-only on sha match",
      env.fetchLog.length === 1 &&
        env.ctx.__shellLite.restock === "fresh" &&
        JSON.parse(env.store.get("jellyfin.lite.body")).sha === SHA,
    );
    // OK -> handoff to the SPA, exactly once
    const app = env.ctx.__liteApp;
    app.onOpen();
    app.onBack();
    check(
      "live: OK/Back hands off once, destroys app",
      env.ctx.__shellLite.st === "handoff" &&
        app.destroyed === 1 &&
        vm.runInContext("loadRemoteWebClientCalls.length", env.ctx) === 1,
    );
    check(
      "live: handoff boot will not re-enter lite",
      env.ctx.__shellLiteHandled === 1 && env.boot() === false,
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
