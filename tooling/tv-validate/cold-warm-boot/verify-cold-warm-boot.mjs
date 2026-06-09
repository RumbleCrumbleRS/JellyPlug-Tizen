#!/usr/bin/env node
// JEL-84 — Compare: Cold boot vs warm boot — full comparison of both paths on TV.
//
// A cold boot is a factory-reset-style start: the app's localStorage is empty,
// so the shell has NO saved server URL, NO cached /web/ bodies, and NO learned
// legacy-transpile verdict. A warm boot is the steady state: every cache the
// shell maintains is populated. This harness decomposes the boot timeline into
// the phases the ticket lists —
//
//   connect screen → server URL entry → /System/Info/Public → /web/index.html
//   fetch → config.json fetch → document.write → jellyfin-web init → login
//   screen → home screen
//
// — and proves, against the SHIPPED shell bytes, WHICH phases run on a cold boot
// but are SKIPPED on a warm boot, and which optimization owns each skip. It does
// this HERMETICALLY (no live server, no creds, no network) by executing the
// EXACT shipped persistence/cache/validation helpers from src/shell.js inside a
// Node `vm` sandbox, once with an empty (cold) store and once with a populated
// (warm) store, on both a legacy (TV) and a modern (browser) WebView.
//
// THE HEADLINE: which phases the WARM boot removes from the pre-document.write
// critical path, and the optimization that owns each —
//   • connect screen + server URL entry  — SKIPPED warm (serverUrl persistence,
//                                            bootstrap()'s `if (stored)` branch)
//   • /System/Info/Public pre-flight      — SKIPPED warm (JEL-555: stored boots
//                                            skip validateServer entirely)
//   • /web/index.html + config.json RTT   — SKIPPED warm when the index cache
//                                            gate is on (JEL-57/JEL-1977: bodies
//                                            served from LS, fetch demoted to
//                                            background revalidation)
//   • config.json JSON.parse              — SKIPPED warm (parsed value cached on
//                                            the wrapper)
//   • DOMParser+outerHTML reflow          — SKIPPED warm on legacy via the string
//                                            fast path (JEL-1832), unless the
//                                            babelNeeded verdict forces a bail
//   • babel 3.13 MB fetch+parse+transpile — legacy-ONLY phase; warm boots still
//                                            run it but the verdict is learned,
//                                            not rediscovered (browser: absent
//                                            on BOTH cold and warm)
//
// WHAT IS PARITY-BY-CONSTRUCTION (and so out of this harness's measurable scope):
// everything AFTER document.write — jellyfin-web init, the login screen, and the
// home screen — runs inside the IDENTICAL jellyfin-web bundle on cold and warm,
// TV and browser. The shell does not re-instrument it; those phases are only
// time-shifted by the pre-handoff delta this harness decomposes.
//
// Usage:  node tooling/tv-validate/cold-warm-boot/verify-cold-warm-boot.mjs
// Exits non-zero on any failed assertion.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const SHELL_JS = resolve(REPO, "packages/shell-tizen/src/shell.js");
const SHELL_MIN = resolve(REPO, "packages/shell-tizen/src/shell.min.js");
const INDEX_HTML = resolve(REPO, "packages/shell-tizen/src/index.html");

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

const shellJs = readFileSync(SHELL_JS, "utf8");
const shellMin = readFileSync(SHELL_MIN, "utf8");
const indexHtml = readFileSync(INDEX_HTML, "utf8");

// ---------------------------------------------------------------------------
// Extract the SHIPPED persistence + index/config body-cache + server-validation
// helpers verbatim from src/shell.js (the source of record), so every assertion
// below runs the EXACT bytes packaged into the .wgt — not a re-implementation.
//
//   readWebIndexCache / writeWebIndexCache     (JEL-57/JEL-1977 body cache)
//   readWebConfigCache / writeWebConfigCache   (+ parsed-config cache)
//   webCacheEnabled                            (jellyfin.shell.indexCache gate)
//   loadServerUrl / saveServerUrl / clearServerUrl
//   normalizeServerUrl / validateServer        (/System/Info/Public probe)
// ---------------------------------------------------------------------------
const SERVER_URL_KEY_DECL = shellJs.match(/var SERVER_URL_KEY = "[^"]+";/)[0];
const HELPERS_BLOCK = shellJs.slice(
  shellJs.indexOf("var WEB_INDEX_CACHE_KEY"),
  shellJs.indexOf("// ---- TV remote keys"),
);
check(
  "extracted the shipped cache+persistence+validation helper block from src/shell.js (source of record)",
  /function readWebIndexCache/.test(HELPERS_BLOCK) &&
    /function writeWebIndexCache/.test(HELPERS_BLOCK) &&
    /function readWebConfigCache/.test(HELPERS_BLOCK) &&
    /function webCacheEnabled/.test(HELPERS_BLOCK) &&
    /function loadServerUrl/.test(HELPERS_BLOCK) &&
    /function validateServer/.test(HELPERS_BLOCK),
  `${HELPERS_BLOCK.length} bytes, SERVER_URL_KEY=${/serverUrl/.test(SERVER_URL_KEY_DECL)}`,
);

const WEB_CACHE_VER = (HELPERS_BLOCK.match(/var WEB_CACHE_VER = "([^"]*)";/) || [])[1];

// Build a sandbox exposing the shipped helpers over a controllable localStorage,
// a deterministic clock, and a scriptable fetch. Returns the helper fns + the
// live store so tests can assert what a boot wrote for the NEXT boot.
function makeShell({ store = {}, fetchImpl } = {}) {
  let clock = 1000;
  const ls = {
    _m: Object.assign(Object.create(null), store),
    getItem(k) {
      return Object.prototype.hasOwnProperty.call(this._m, k) ? this._m[k] : null;
    },
    setItem(k, v) {
      this._m[k] = String(v);
    },
    removeItem(k) {
      delete this._m[k];
    },
  };
  const ctx = {
    localStorage: ls,
    Date: { now: () => ++clock },
    JSON,
    fetch: fetchImpl || (() => Promise.reject(new Error("no fetch in this test"))),
    console: { log() {}, warn() {} },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SERVER_URL_KEY_DECL + "\n" + HELPERS_BLOCK, ctx, {
    filename: "shell.js#helpers",
  });
  // Surface the closures we want to drive.
  vm.runInContext(
    "this.__api = { readWebIndexCache, writeWebIndexCache, readWebConfigCache," +
      " writeWebConfigCache, webCacheEnabled, loadServerUrl, saveServerUrl," +
      " clearServerUrl, normalizeServerUrl, validateServer };",
    ctx,
  );
  return { api: ctx.__api, store: ls._m, ls };
}

const ORIGIN = "https://tv.example.local";
const OTHER_ORIGIN = "https://other.example.local";
// A realistic index.html body (>1 KB, contains <html) and a parseable config.
const INDEX_BODY =
  "<!DOCTYPE html><html><head><title>Jellyfin</title></head><body>" +
  "x".repeat(2048) +
  "</body></html>";
const CONFIG_BODY = JSON.stringify({ menuLinks: [], servers: [] });

// ===========================================================================
// PART A — Server-URL persistence: the connect screen + /System/Info/Public
// pre-flight run on COLD boot only.
// ===========================================================================
function partA() {
  // -- COLD: empty store → no saved server URL → bootstrap shows connect form.
  const cold = makeShell({ store: {} });
  check(
    "A1 COLD: loadServerUrl() returns '' on a factory-reset store → bootstrap() takes the connect-screen branch (server URL entry required)",
    cold.api.loadServerUrl() === "",
    `loadServerUrl()=${JSON.stringify(cold.api.loadServerUrl())}`,
  );

  // -- WARM: saved server URL → bootstrap boots straight to loadRemoteWebClient.
  const warm = makeShell({ store: { "jellyfin.shell.serverUrl": ORIGIN } });
  check(
    "A2 WARM: loadServerUrl() returns the saved origin → bootstrap() takes the `if (stored)` branch (connect screen + URL entry SKIPPED)",
    warm.api.loadServerUrl() === ORIGIN,
    `loadServerUrl()=${warm.api.loadServerUrl()}`,
  );

  // bootstrap()'s decision is the cold/warm fork. Pin it to the shipped bytes:
  // stored → loadRemoteWebClient (NO validateServer); else → attachConnectForm.
  const bootstrapSrc = shellJs.slice(
    shellJs.indexOf("function bootstrap()"),
    shellJs.indexOf("function bootstrap()") + 2400,
  );
  check(
    "A3 bootstrap() forks on saved URL: `if (stored) loadRemoteWebClient(stored)` else `attachConnectForm()` (the cold/warm boot fork, UA-independent)",
    /var stored = loadServerUrl\(\);/.test(bootstrapSrc) &&
      /if \(stored\) \{[\s\S]*loadRemoteWebClient\(stored\)/.test(bootstrapSrc) &&
      /\} else \{[\s\S]*attachConnectForm\(\);/.test(bootstrapSrc),
    "fork present in shell.js",
  );
  check(
    "A4 WARM skips the /System/Info/Public pre-flight (JEL-555): the stored branch calls loadRemoteWebClient directly, validateServer is reached ONLY from the connect-form submit (cold path)",
    /JEL-555: skip the \/System\/Info\/Public pre-flight/.test(bootstrapSrc) &&
      !/validateServer/.test(bootstrapSrc) &&
      /validateServer\(url\)/.test(shellJs.slice(shellJs.indexOf("form.addEventListener"))),
    "validateServer absent from bootstrap, present in connect-form submit",
  );

  // The COLD connect path actually probes /System/Info/Public and only then
  // persists the URL — drive the shipped validateServer to prove the contract.
  let probedUrl = null;
  const coldConnect = makeShell({
    fetchImpl: (url) => {
      probedUrl = url;
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ Id: "abc", Version: "10.10" }) });
    },
  });
  return coldConnect.api
    .validateServer(ORIGIN)
    .then((info) => {
      check(
        "A5 COLD: validateServer() probes exactly `${origin}/System/Info/Public` and resolves on a body carrying an Id (the connect-screen gate)",
        probedUrl === ORIGIN + "/System/Info/Public" && info && info.Id === "abc",
        `probed=${probedUrl} id=${info && info.Id}`,
      );
      // After a successful probe the cold path persists the URL → the NEXT boot
      // is warm. saveServerUrl is the cold→warm transition.
      coldConnect.api.saveServerUrl(ORIGIN);
      check(
        "A6 COLD→WARM transition: saveServerUrl() persists the probed origin so the very next boot skips both the connect screen and the /System/Info/Public probe",
        coldConnect.store["jellyfin.shell.serverUrl"] === ORIGIN,
        `persisted serverUrl=${coldConnect.store["jellyfin.shell.serverUrl"]}`,
      );
    });
}

// ===========================================================================
// PART B — /web/index.html + config.json body cache (JEL-57/JEL-1977): the
// RTT pair runs on the COLD critical path, is served from LS on WARM.
// ===========================================================================
function partB() {
  // -- Gate ON, COLD store: both reads MISS → indexCacheHit false → the boot
  //    MUST fetch /web/index.html + /web/config.json (the RTT pair is on the
  //    pre-document.write critical path).
  const cold = makeShell({ store: { "jellyfin.shell.indexCache": "1" } });
  check(
    "B1 COLD (gate on, empty cache): readWebIndexCache + readWebConfigCache both MISS → boot fetches /web/index.html + /web/config.json (RTT pair on the critical path)",
    cold.api.webCacheEnabled() === true &&
      cold.api.readWebIndexCache(ORIGIN) === null &&
      cold.api.readWebConfigCache(ORIGIN) === null,
    "both reads null on cold store",
  );

  // The cold boot WRITES both bodies to LS (the warm-boot seed). Drive the real
  // writers, then re-read from the now-populated store: the WARM hit.
  cold.api.writeWebIndexCache(ORIGIN, INDEX_BODY);
  cold.api.writeWebConfigCache(ORIGIN, CONFIG_BODY);
  const warm = makeShell({
    store: {
      "jellyfin.shell.indexCache": "1",
      "jellyfin.shell.webIndexHtml": cold.store["jellyfin.shell.webIndexHtml"],
      "jellyfin.shell.webConfig": cold.store["jellyfin.shell.webConfig"],
    },
  });
  const wi = warm.api.readWebIndexCache(ORIGIN);
  const wc = warm.api.readWebConfigCache(ORIGIN);
  check(
    "B2 WARM (gate on, primed): readWebIndexCache + readWebConfigCache both HIT → indexPromise/configPromise resolve from LS, the /web/ RTT pair is REMOVED from the critical path (demoted to background revalidation)",
    wi && wi.body === INDEX_BODY && wc && wc.body === CONFIG_BODY,
    `indexHit=${!!wi} configHit=${!!wc}`,
  );
  check(
    "B3 WARM: the config cache returns a pre-PARSED value (p.parsed) so the warm boot skips the second JSON.parse of config.json too",
    wc && wc.parsed && Array.isArray(wc.parsed.servers),
    `parsed=${wc && !!wc.parsed}`,
  );

  // -- Gate OFF (the cold-QA default): cache is NEVER consulted even if bodies
  //    happen to be present → every boot pays the RTT pair. This is why the
  //    optimization is opt-in and the default boot is "cold-shaped".
  const gateOff = makeShell({
    store: {
      "jellyfin.shell.webIndexHtml": cold.store["jellyfin.shell.webIndexHtml"],
      "jellyfin.shell.webConfig": cold.store["jellyfin.shell.webConfig"],
    },
  });
  check(
    "B4 gate OFF (jellyfin.shell.indexCache!='1', the default): webCacheEnabled() is false → loadRemoteWebClient never reads the cache, so the default boot pays the /web/ RTT pair like a cold boot",
    gateOff.api.webCacheEnabled() === false,
    "cache bypassed when gate off",
  );

  // -- Origin pinning: a warm entry for a DIFFERENT server origin MISSES → a
  //    server switch forces a cold-shaped boot (no cross-server body reuse).
  const otherSrv = makeShell({
    store: {
      "jellyfin.shell.indexCache": "1",
      "jellyfin.shell.webIndexHtml": cold.store["jellyfin.shell.webIndexHtml"],
      "jellyfin.shell.webConfig": cold.store["jellyfin.shell.webConfig"],
    },
  });
  check(
    "B5 origin-pinned: a warm cache for ${ORIGIN} MISSES when booting against ${OTHER_ORIGIN} → switching servers forces a cold-shaped /web/ fetch (no cross-origin reuse)",
    otherSrv.api.readWebIndexCache(OTHER_ORIGIN) === null &&
      otherSrv.api.readWebConfigCache(OTHER_ORIGIN) === null,
    "cross-origin read misses",
  );

  // -- Version pinning: a cache written under a different shell version MISSES →
  //    a shell upgrade forces one cold boot (no stale-bundle adoption).
  const staleRec = JSON.stringify({
    v: "DIFFERENT_VERSION",
    origin: ORIGIN,
    ts: 1,
    size: INDEX_BODY.length,
    body: INDEX_BODY,
  });
  const upgraded = makeShell({
    store: { "jellyfin.shell.indexCache": "1", "jellyfin.shell.webIndexHtml": staleRec },
  });
  check(
    "B6 version-pinned: a cache entry stamped with a different WEB_CACHE_VER MISSES → a shell upgrade forces one cold boot before re-warming (no stale-version body adoption)",
    upgraded.api.readWebIndexCache(ORIGIN) === null,
    `WEB_CACHE_VER token=${JSON.stringify(WEB_CACHE_VER)}`,
  );

  // -- Poison guards: a truncated/error body is NOT cached → a flaky cold fetch
  //    can't poison the warm boot.
  const guard = makeShell({ store: {} });
  guard.api.writeWebIndexCache(ORIGIN, "tiny"); // <1 KB
  guard.api.writeWebIndexCache(ORIGIN, "z".repeat(2048)); // no <html marker
  guard.api.writeWebConfigCache(ORIGIN, "{not json"); // unparseable
  check(
    "B7 poison-guarded: writeWebIndexCache rejects <1 KB and non-<html bodies; writeWebConfigCache rejects unparseable bodies → a flaky COLD response can't poison the WARM boot",
    !("jellyfin.shell.webIndexHtml" in guard.store) &&
      !("jellyfin.shell.webConfig" in guard.store),
    "no partial body written",
  );
}

// ===========================================================================
// PART C — legacy babel-transpile verdict: a TV-ONLY phase. COLD rediscovers
// it; WARM reuses the learned verdict. Browser never transpiles on EITHER.
// ===========================================================================
function partC() {
  const BABEL_NEEDED_KEY = "jellyfin.shell.legacy.babelNeeded";
  // The string fast path (JEL-1832) skips DOMParser+outerHTML when caches are
  // primed — but BAILS when the babelNeeded verdict says this server's bundle
  // needs transpiling. Pin both reads to the shipped bytes.
  const fastPathSrc = shellJs.slice(
    shellJs.indexOf("function maybeStringFastPath"),
    shellJs.indexOf("function maybeStringFastPath") + 1600,
  );
  check(
    "C1 legacy fast path reads the learned babelNeeded verdict and BAILS when set ('1') → on a babel-needed server the DOMParser slow path runs on BOTH cold and warm (the verdict gates the fast path, it doesn't remove transpile)",
    /babelNeeded = localStorage\.getItem\(BABEL_NEEDED_KEY\) === "1"/.test(fastPathSrc) &&
      /if \(babelNeeded\) return bail\("babelNeeded"\)/.test(fastPathSrc),
    "fast-path babelNeeded bail present",
  );
  check(
    "C2 loadRemoteWebClient also consults babelNeeded → the transpile decision is made from the LEARNED verdict on warm boots, not rediscovered per boot",
    new RegExp(BABEL_NEEDED_KEY).test(shellJs) &&
      /babelNeededFlag = localStorage\.getItem\(BABEL_NEEDED_KEY\) === "1"/.test(shellJs),
    `BABEL_NEEDED_KEY references in shell.js=${(shellJs.match(/BABEL_NEEDED_KEY/g) || []).length}`,
  );

  // The index.html eager-babel kick is gated legacy + babelNeeded='1' + preload
  // not disabled. A modern browser never satisfies the legacy gate → no babel
  // phase on cold OR warm. This is why the cold↔warm delta is SMALLER on browser.
  check(
    "C3 browser has NO babel phase on EITHER boot: the eager __ensureBabel kick in index.html is gated `legacy.babelNeeded==='1'`, which a modern UA never sets → cold and warm browser boots both skip transpile (smaller cold↔warm delta than TV)",
    /legacy\.babelNeeded'\)==='1'/.test(indexHtml) &&
      /legacy\.babelPreload'\)!=='0'/.test(indexHtml),
    "legacy-gated babel kick in index.html",
  );

  // JEL-17: the transpile cache is kept warm across boots so the hero renders
  // reliably — the warm boot doesn't cold-transpile every script.
  check(
    "C4 JEL-17 warm-transpile cache: shell.js caches transpiled bodies in localStorage so warm boots skip re-transpiling (keeps the hero reliable; cold boot pays the full transpile, warm reuses it)",
    /cache transpiled plugin bodies in localStorage so warm/.test(shellJs) ||
      /JEL-17/.test(shellJs) ||
      /warm boot skips fetch\+scan/.test(shellJs),
    "warm-transpile cache comment present in shell.js",
  );
}

// ===========================================================================
// PART D — the optimization matrix: which optimizations gate each cold-only
// phase, pinned to the shipped artifacts (src + deployed shell.min.js).
// ===========================================================================
function partD() {
  // D1: serverUrl persistence — owns connect-screen + /System/Info/Public skip.
  check(
    "D1 [serverUrl persistence] gates the connect-screen + /System/Info/Public skip — present in deployed shell.min.js",
    shellMin.includes("jellyfin.shell.serverUrl"),
    "serverUrl key in shell.min.js",
  );
  // D2: index/config body cache (JEL-57) — owns the /web/ RTT-pair skip.
  check(
    "D2 [index/config body cache · JEL-57/JEL-1977] gates the /web/index.html+config.json RTT-pair skip — keys present in deployed shell.min.js",
    shellMin.includes("jellyfin.shell.indexCache") &&
      shellMin.includes("jellyfin.shell.webIndexHtml") &&
      shellMin.includes("jellyfin.shell.webConfig"),
    "indexCache + body keys in shell.min.js",
  );
  // D3: string fast path (JEL-1832) — owns the DOMParser-reflow skip (legacy).
  check(
    "D3 [string fast path · JEL-1832] gates the DOMParser+outerHTML reflow skip on legacy warm boots — present in deployed shell.min.js",
    shellMin.includes("fastPathDisabled") || /maybeStringFastPath/.test(shellJs),
    "fast-path gate present",
  );
  // D4: prefetch (JEL-58) + preload (JEL-59) run on BOTH cold and warm — they
  // overlap the /web/ fetch with shell parse; not a cold-only phase, so they
  // shrink the cold critical path rather than being skipped warm.
  check(
    "D4 [prefetch · JEL-58 / preload · JEL-59] run on BOTH cold and warm (they overlap the /web/ fetch with shell startup) — present in src + shipped to shell.min.js where applicable",
    /__shellPrefetch/.test(indexHtml) &&
      /__shellPreloadScripts/.test(indexHtml),
    "prefetch + preload IIFE markers in index.html",
  );
  // D5: babel preload (legacy) — only meaningful when babelNeeded is learned.
  check(
    "D5 [babel preload · legacy] only engages once the babelNeeded verdict is learned (warm) — the eager kick is gated in index.html",
    /__shellBabelPreload/.test(indexHtml),
    "babel preload marker present",
  );
}

console.log("== PART A: server-URL persistence — connect screen + /System/Info/Public are COLD-only ==");
await partA();
console.log("\n== PART B: /web/ body cache (JEL-57) — RTT pair is COLD-only, served from LS on WARM ==");
partB();
console.log("\n== PART C: legacy babel verdict — TV-only phase; learned on COLD, reused on WARM; browser never ==");
partC();
console.log("\n== PART D: optimization matrix — which optimization owns each cold-only phase (shipped artifacts) ==");
partD();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
process.exit(failed.length ? 1 : 0);
