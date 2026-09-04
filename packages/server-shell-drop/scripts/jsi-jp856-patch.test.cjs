#!/usr/bin/env node
/*
 * jsi-jp856-patch.test.cjs — JELA-856 guard for jsi-jp856-patch.mjs.
 *
 * The patch lives only on the live JS-Injector channel, so it is an anchored
 * text replacement and anchor drift is the whole risk: an upstream edit that
 * moves `A()` must fail LOUDLY at patch time, never silently ship the
 * unpatched behaviour as if it were the fix.
 *
 * This does not source-assert — it BOOTS the patched entry in a vm against a
 * fake window and drives the real `armProbe` (= `T`, the JELA-110/542 "0 ms
 * probe"), so what is proven is behaviour, on the bytes that would deploy.
 *
 * What each check is protecting, mapped to the issue's acceptance:
 *
 *  1) FAIL-CLOSED anchoring. Exactly one anchor hit, name-exact entry match
 *     (the channel also carries "mediabar-guard", "mediabar-tizen5-rescue"
 *     and "mediabar-hero-types" — a loose /media-bar/i would hit them all),
 *     double-apply refused, rollback byte-exact.
 *  2) NO ES2019+. The added region runs on Tizen 5.0 / Chromium 63 / V8 6.3,
 *     where a syntax error does not degrade the feature — it kills the whole
 *     channel document for every entry after it.
 *  3) AC1 — with the shell globals present and the origin matching, the probe
 *     issues ZERO XHRs and still sees the hero assets.
 *  4) AC2 — `jp:mediabar-expected` still fires, and it fires LATE ENOUGH: the
 *     listener is registered AFTER the module runs, mimicking mediabar-guard,
 *     which is a separate channel entry positioned after media-bar. A
 *     synchronous callback would dispatch into an empty listener set and kill
 *     the pre-mount reservation. This is the check that would catch it.
 *  5) AC3 — fault injection, not assumption: no global at all, a stale global
 *     from a different origin, and the per-TV kill switch each take the XHR
 *     path with the original bytes.
 *  6) The RAW body matters: the callback must receive exactly what was
 *     published, so a consumer's `y()` scan sees the server's document rather
 *     than the shell's rewritten one.
 *
 * Run: node scripts/jsi-jp856-patch.test.cjs
 */
"use strict";

const assert = require("node:assert");
const path = require("node:path");
const vm = require("node:vm");
const { pathToFileURL } = require("node:url");

const { LIVE_MEDIABAR } = require("./jsi-jp856-fixture.cjs");

const ORIGIN = "http://srv.example:8096";
const INDEX_URL = ORIGIN + "/web/index.html";
const USER_ID = "u-42";

// A body whose `y()` scan finds a hero asset, so the probe arms.
const HERO_HTML =
  '<!DOCTYPE html><html><head><link rel="stylesheet" href="/web/slideshowpure.css">' +
  '<script src="/web/media-bar.js"></script></head><body>hero</body></html>';
// Deliberately different bytes for the XHR arm, so a test that "passes" by
// silently falling through to the network cannot be mistaken for a cache hit.
const XHR_HTML = HERO_HTML.replace("hero", "hero-from-network");
// A document the scan finds NOTHING in — used to prove which of the two
// bodies actually reached `y()`.
const NO_HERO_HTML =
  "<!DOCTYPE html><html><head></head><body>no hero here</body></html>";

// --- fake window ------------------------------------------------------------
// `c()` in the entry canonicalizes a URL through <a>.href, and the patch
// compares two canonicalized URLs, so the anchor stand-in must resolve
// relative URLs against the document base exactly as a browser would.
function makeWindow(opts) {
  const o = opts || {};
  const store = Object.assign({}, o.ls);
  const listeners = {};
  const timers = [];
  const xhrUrls = [];

  function createElement(tag) {
    if (tag === "a") {
      let href = "";
      return {
        set href(v) {
          href = new URL(String(v), INDEX_URL).href;
        },
        get href() {
          return href;
        },
      };
    }
    return {
      setAttribute() {},
      appendChild() {},
      style: {},
      set href(v) {
        this._href = v;
      },
      get href() {
        return this._href;
      },
    };
  }

  const doc = {
    createElement,
    createTextNode: (t) => ({ t }),
    createEvent: () => ({
      initEvent(type) {
        this.type = type;
      },
    }),
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementsByTagName: () => [],
    documentElement: { appendChild() {} },
    head: { appendChild() {} },
    body: { appendChild() {} },
  };

  function XMLHttpRequest() {
    this.open = (m, u) => {
      xhrUrls.push(u);
    };
    this.send = () => {
      timers.push(() => {
        this.readyState = 4;
        this.status = 200;
        this.responseText = o.xhrHtml !== undefined ? o.xhrHtml : XHR_HTML;
        this.onreadystatechange && this.onreadystatechange();
      });
    };
  }

  const win = {
    document: doc,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => {
        store[k] = String(v);
      },
    },
    XMLHttpRequest: o.noXhr ? null : XMLHttpRequest,
    setTimeout: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    setInterval: () => 0,
    clearInterval: () => {},
    clearTimeout: () => {},
    addEventListener: (t, fn) => {
      (listeners[t] = listeners[t] || []).push(fn);
    },
    dispatchEvent: (ev) => {
      (listeners[ev.type] || []).forEach((fn) => fn(ev));
      return true;
    },
    CustomEvent: function (type) {
      this.type = type;
    },
    ApiClient: {
      serverAddress: () => o.serverAddress || ORIGIN,
      getCurrentUserId: () => USER_ID,
    },
    console: { log() {}, warn() {}, error() {} },
    JellyPlug: {
      register(name, fn) {
        win.__registered = fn;
      },
    },
  };
  if (o.html !== undefined) win.__shellWebIndexHtml = o.html;
  if (o.origin !== undefined) win.__shellWebIndexOrigin = o.origin;

  return {
    win,
    store,
    xhrUrls,
    listeners,
    // Drain queued tasks (the XHR completion and our setTimeout hand-back are
    // both tasks) so "did the callback run at all" is separable from "did it
    // run synchronously".
    drain() {
      let n = 0;
      while (timers.length && n++ < 50) timers.shift()();
    },
  };
}

function boot(body, opts) {
  const env = makeWindow(opts);
  const sandbox = {
    window: env.win,
    globalThis: undefined,
    module: { exports: {} },
    URL,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(body, sandbox, { filename: "media-bar.js" });
  env.exports = sandbox.module.exports;
  return env;
}

// Run the probe the way the fielded channel does: the module has already run,
// and only THEN does the next channel entry (mediabar-guard) subscribe.
function runProbe(env) {
  const seen = [];
  env.win.addEventListener("jp:mediabar-expected", () => seen.push("fired"));
  env.exports.armProbe({ log() {}, warn() {} });
  const firedSynchronously = seen.length > 0;
  env.drain();
  return { fired: seen.length > 0, firedSynchronously };
}

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log("OK: " + name);
  } catch (e) {
    console.error("FAIL: " + name + "  — " + e.message);
    failures++;
  }
}

(async () => {
  const mod = await import(
    pathToFileURL(path.join(__dirname, "jsi-jp856-patch.mjs")).href
  );
  const PATCHED = mod.applyPatch(LIVE_MEDIABAR);

  // --- 1. fail-closed anchoring --------------------------------------------
  check("anchor matches exactly once on the live entry", () => {
    assert.notStrictEqual(PATCHED, LIVE_MEDIABAR);
    assert.strictEqual(mod.isPatched(PATCHED), true);
    assert.strictEqual(mod.isPatched(LIVE_MEDIABAR), false);
  });

  check("a body without the anchor throws instead of no-op patching", () => {
    assert.throws(
      () => mod.applyPatch("(function(a){var s=a.document;})(window);"),
      /matched 0 times/,
    );
  });

  check("double-apply is refused (anchor would match twice)", () => {
    assert.throws(() => mod.applyPatch(PATCHED), /matched 0 times/);
    assert.throws(
      () => mod.patchConfig({ CustomJavaScripts: [{ Name: "JellyPlug — media-bar", Script: PATCHED }] }),
      /already patched/,
    );
  });

  check("entry match is name-exact (siblings are not touched)", () => {
    const siblings = [
      "JellyPlug — mediabar-guard",
      "JellyPlug — mediabar-tizen5-rescue (JELA-115)",
      "JellyPlug — mediabar-hero-types",
    ];
    for (const name of siblings) {
      assert.strictEqual(mod.PATCH.entry.test(name), false, name);
    }
    assert.strictEqual(mod.PATCH.entry.test("JellyPlug — media-bar"), true);
  });

  check("rollback restores the live body byte-for-byte", () => {
    assert.strictEqual(mod.rollbackPatch(PATCHED), LIVE_MEDIABAR);
    const cfg = {
      CustomJavaScripts: [{ Name: "JellyPlug — media-bar", Script: PATCHED }],
    };
    mod.patchConfig(cfg, { rollback: true });
    assert.strictEqual(cfg.CustomJavaScripts[0].Script, LIVE_MEDIABAR);
  });

  check("rollback on an unpatched entry throws rather than mangling it", () => {
    assert.throws(
      () =>
        mod.patchConfig(
          {
            CustomJavaScripts: [
              { Name: "JellyPlug — media-bar", Script: LIVE_MEDIABAR },
            ],
          },
          { rollback: true },
        ),
      /not patched/,
    );
  });

  // --- 2. engine safety -----------------------------------------------------
  check("added region carries no ES2019+ syntax and parses standalone", () => {
    mod.assertNoModernAdditions(PATCHED);
    new vm.Script(PATCHED, { filename: "patched.js" });
    const added = PATCHED.split("/*jp856*/")[1];
    assert.ok(added.length > 0);
    assert.strictEqual(/\?\.|\?\?|=>|`/.test(added), false);
    // Bare `catch {}` is ES2019 and also throws at parse on M63.
    assert.strictEqual(/catch\s*\{/.test(added), false);
  });

  // --- 3+4+6. AC1 / AC2: cache hit serves the probe, asynchronously ---------
  const hit = boot(PATCHED, {
    ls: { ["jp:mediabar:seen:" + USER_ID]: "1" },
    html: HERO_HTML,
    origin: ORIGIN,
  });
  const hitRun = runProbe(hit);

  check("AC1: steady-state probe issues ZERO /web/index.html requests", () => {
    assert.deepStrictEqual(hit.xhrUrls, []);
    assert.strictEqual(hit.win.__jpMB856, 1, "diag counter must prove it fired");
  });

  check("AC2: jp:mediabar-expected still fires", () => {
    assert.strictEqual(hitRun.fired, true);
  });

  check(
    "AC2: it fires ASYNCHRONOUSLY, so a later-registered guard still hears it",
    () => {
      assert.strictEqual(
        hitRun.firedSynchronously,
        false,
        "a synchronous dispatch would miss mediabar-guard's listener",
      );
    },
  );

  check(
    "the published body reaches y() intact (scan sees the cached document)",
    () => {
      // The network arm is stubbed to a document with NO hero assets, so the
      // reservation can only arm if the PUBLISHED string — unmodified, since
      // the hero <link> only exists there — is what got scanned.
      const env = boot(PATCHED, {
        ls: { ["jp:mediabar:seen:" + USER_ID]: "1" },
        html: HERO_HTML,
        origin: ORIGIN,
        xhrHtml: NO_HERO_HTML,
      });
      const run = runProbe(env);
      assert.deepStrictEqual(env.xhrUrls, []);
      assert.strictEqual(run.fired, true);
    },
  );

  check("a user with no hero history still does not probe at all", () => {
    const env = boot(PATCHED, { html: HERO_HTML, origin: ORIGIN });
    env.exports.armProbe({ log() {}, warn() {} });
    env.drain();
    assert.deepStrictEqual(env.xhrUrls, []);
    assert.strictEqual(
      env.win.__jpMB856,
      undefined,
      "the jp:mediabar:seen gate must still come first",
    );
  });

  check("origin with a trailing slash still matches (canonicalized compare)", () => {
    const env = boot(PATCHED, {
      ls: { ["jp:mediabar:seen:" + USER_ID]: "1" },
      html: HERO_HTML,
      origin: ORIGIN + "/",
    });
    runProbe(env);
    assert.deepStrictEqual(env.xhrUrls, []);
    assert.strictEqual(env.win.__jpMB856, 1);
  });

  // --- 5. AC3: fault injection — every miss takes the untouched XHR path ----
  const faults = [
    ["no shell global at all (non-Tizen / older shell)", {}],
    ["body published without an origin", { html: HERO_HTML }],
    ["origin published without a body", { origin: ORIGIN }],
    ["empty body published", { html: "", origin: ORIGIN }],
    [
      "stale global from a DIFFERENT server",
      { html: HERO_HTML, origin: "http://other.example:8096" },
    ],
    [
      "per-TV kill switch jellyplug.mediabar.jp856Off=1",
      {
        html: HERO_HTML,
        origin: ORIGIN,
        ls: { "jellyplug.mediabar.jp856Off": "1" },
      },
    ],
  ];
  for (const [label, extra] of faults) {
    check("AC3: " + label + " -> XHR path, unchanged", () => {
      const env = boot(
        PATCHED,
        Object.assign({}, extra, {
          ls: Object.assign(
            { ["jp:mediabar:seen:" + USER_ID]: "1" },
            extra.ls,
          ),
        }),
      );
      const run = runProbe(env);
      assert.deepStrictEqual(env.xhrUrls, [INDEX_URL], "must fetch over XHR");
      assert.strictEqual(env.win.__jpMB856, undefined, "cache path must not fire");
      assert.strictEqual(run.fired, true, "the reservation must still arm");
    });
  }

  // The unpatched entry is the control: same harness, one request, event fires.
  check("control: the UNPATCHED entry fetches once and arms", () => {
    const env = boot(LIVE_MEDIABAR, {
      ls: { ["jp:mediabar:seen:" + USER_ID]: "1" },
      html: HERO_HTML,
      origin: ORIGIN,
    });
    const run = runProbe(env);
    assert.deepStrictEqual(env.xhrUrls, [INDEX_URL]);
    assert.strictEqual(run.fired, true);
  });

  if (failures) {
    console.error("\njsi-jp856-patch: " + failures + " failure(s)");
    process.exit(1);
  }
  console.log("\nAll jp856 checks passed.");
})();
