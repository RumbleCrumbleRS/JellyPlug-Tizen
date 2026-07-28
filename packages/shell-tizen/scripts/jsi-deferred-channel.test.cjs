/*
 * JELA-228 (WS-B1): post-first-card deferred JSI channel loader.
 *
 * WS-B1 splits the JS-Injector channel into a boot-CRITICAL body (the
 * jsiChannelPath override points the JEL-197 channel at it) and a DEFERRED body
 * of page-specific snippets (search / item-detail / player-idle) that never
 * render the home page. This loader fetches the deferred body ONLY AFTER the
 * first home card paints, so those ~32% of channel bytes leave the boot PARSE
 * path on M63 (the fleet floor, where boot cost is parse-dominated).
 *
 * This test extracts the SHIPPED jsiDeferredBody() out of shell.js and drives it
 * through stubbed window/localStorage/document/fetch + a virtual clock, pinning:
 *   - FLAG-DARK: inert (no interval armed, no fetch, nothing on window) unless
 *     localStorage['jellyfin.shell.jsiDeferredPath'] names the deferred route;
 *     the JEL-197 channel killswitch (jsiChannelDisabled) also suppresses it.
 *   - post-first-card trigger: nothing is fetched until window.__shellPhases
 *     marks card/home OR a `.card` appears in the DOM; a hard 60 s cap still
 *     delivers if a card never renders.
 *   - delivery: fetches `${server}${path}?_jsd=1` (cross-origin read as TEXT,
 *     credentials omitted, no-store) and inlines the body as ONE <script> with
 *     the data-shell-jsi-deferred marker via createElement + textContent (a
 *     "</script" literal in a snippet body cannot terminate the tag).
 *   - armed latch: a re-injected copy (fast-path splice + DOMParser inject, or a
 *     document.write re-run) is a no-op — the body is never fetched twice.
 *   - both written-document injection sites present (DOMParser path call +
 *     string fast-path splice) and the test chain runs this file.
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

const bodyFnSrc = extractFn("jsiDeferredBody");
const body = new Function(bodyFnSrc + "; return jsiDeferredBody();")();

// ---- static contract checks -------------------------------------------------
assert(
  body.indexOf("</script") === -1,
  "jsiDeferredBody must not contain a </script> literal (fast path splices it)",
);
assert(body.indexOf("=>") === -1, "body must be ES5 (no arrow functions)");
assert(body.indexOf("`") === -1, "body must be ES5 (no template literals)");
assert(
  body.indexOf('"jellyfin.shell.jsiDeferredPath"') !== -1,
  "flag-dark route gate missing (jsiDeferredPath)",
);
assert(
  body.indexOf('"jellyfin.shell.jsiChannelDisabled"') !== -1,
  "JEL-197 channel killswitch gate missing",
);
assert(
  body.indexOf("__shellJsiDeferredArmed") !== -1,
  "armed latch missing (re-injection would double-fetch)",
);
assert(
  body.indexOf('"data-shell-jsi-deferred"') !== -1,
  "injected body marker missing",
);
assert(body.indexOf("_jsd=1") !== -1, "freshness marker query missing");

// Both written-document injection sites.
assert(
  text.indexOf("injectJsiDeferredChannel(doc);") !== -1,
  "DOMParser-path injection site missing",
);
assert(
  /\w+Tag \+\s*jsiDeferredTag;/.test(text),
  "string fast-path splice missing (jsiDeferredTag must end the injected chain)",
);

// Test chain includes this file.
const pkg = fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8");
assert(
  pkg.indexOf("jsi-deferred-channel.test.cjs") !== -1,
  "jsi-deferred-channel.test.cjs missing from the npm test chain",
);

// ---- behavioural: stubbed env + virtual clock -------------------------------
function makeDoc() {
  const appended = [];
  const doc = {
    appended,
    card: null, // set to a truthy node to simulate a painted home card
    createElement() {
      return {
        attrs: {},
        setAttribute(k, v) {
          this.attrs[k] = v;
        },
      };
    },
    querySelector(sel) {
      return sel === ".card" ? doc.card : null;
    },
  };
  doc.body = {
    appendChild(el) {
      appended.push(el);
      return el;
    },
  };
  return doc;
}

function makeEnv(ls, docOverride) {
  const store = new Map(Object.entries(ls || {}));
  const clock = { now: 100000 };
  function FakeDate() {}
  FakeDate.prototype.valueOf = function () {
    return clock.now;
  };
  const intervals = [];
  const doc = docOverride || makeDoc();
  const fetches = [];
  const win = {};
  const env = {
    window: win,
    document: doc,
    fetches,
    clock,
    intervals,
    store,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    setInterval: (fn) => {
      intervals.push({ fn, cleared: false });
      return intervals.length;
    },
    clearInterval: (id) => {
      if (intervals[id - 1]) intervals[id - 1].cleared = true;
    },
    FakeDate,
    tick(advanceMs) {
      clock.now += advanceMs || 0;
      for (const iv of intervals) if (!iv.cleared) iv.fn();
    },
    run() {
      new Function(
        "window",
        "document",
        "localStorage",
        "setInterval",
        "clearInterval",
        "Date",
        body,
      )(
        win,
        doc,
        env.localStorage,
        env.setInterval,
        env.clearInterval,
        FakeDate,
      );
    },
  };
  // window.fetch mock: records the call, resolves with a text() body.
  win.fetch = function (url, opts) {
    const rec = { url, opts, resolve: null };
    fetches.push(rec);
    return {
      then(onOk) {
        // Simulate a 200 with a canned body (env.responseCode).
        const r = {
          ok: env.responseOk !== false,
          status: env.responseStatus || 200,
          text() {
            return { then: (f) => Promise.resolve(f(env.responseCode || "")) };
          },
        };
        try {
          const next = onOk(r);
          return {
            then(onText) {
              return Promise.resolve(
                next && next.then ? next.then(onText) : onText(next),
              );
            },
            catch() {
              return this;
            },
          };
        } catch (_) {
          return {
            then() {
              return this;
            },
            catch(f) {
              f();
              return this;
            },
          };
        }
      },
    };
  };
  return env;
}

const flush = () => new Promise((r) => setImmediate(r));

(async function run() {
  // Case 1: flag-dark — no jsiDeferredPath => fully inert.
  {
    const env = makeEnv({ "jellyfin.shell.serverUrl": "http://s.test" });
    env.run();
    assert(env.intervals.length === 0, "no route => no interval armed");
    assert(
      env.window.__shellJsiDeferredArmed === undefined,
      "no route => not armed",
    );
    assert(env.fetches.length === 0, "no route => no fetch");
  }

  // Case 2: killswitch beats a configured route.
  {
    const env = makeEnv({
      "jellyfin.shell.jsiDeferredPath": "/shell/jsi-deferred.js",
      "jellyfin.shell.jsiChannelDisabled": "1",
      "jellyfin.shell.serverUrl": "http://s.test",
    });
    env.run();
    assert(env.intervals.length === 0, "killswitch => no interval");
    assert(env.fetches.length === 0, "killswitch => no fetch");
  }

  // Case 3: route set but no card yet => armed, polling, but nothing fetched.
  {
    const env = makeEnv({
      "jellyfin.shell.jsiDeferredPath": "/shell/jsi-deferred.js",
      "jellyfin.shell.serverUrl": "http://s.test/",
    });
    env.run();
    assert(env.window.__shellJsiDeferredArmed === 1, "route => armed");
    assert(env.intervals.length === 1, "route => one poll interval");
    env.tick(1000); // still no card
    assert(env.fetches.length === 0, "no card => no fetch yet");
    assert(env.window.__shellJsiDeferred.fired === 0, "no card => not fired");
  }

  // Case 4: card appears => fetch fires once, body inlined with marker.
  {
    const doc = makeDoc();
    const env = makeEnv(
      {
        "jellyfin.shell.jsiDeferredPath": "/shell/jsi-deferred.js",
        "jellyfin.shell.serverUrl": "http://s.test/",
      },
      doc,
    );
    env.responseCode = "window.__deferredSnippet=1;/* </SCRIPT tolerated */";
    env.run();
    env.tick(1000); // no card
    assert(env.fetches.length === 0, "still no card");
    doc.card = { tag: "div" }; // home card paints
    env.tick(1000);
    await flush();
    await flush();
    assert(env.fetches.length === 1, "card => exactly one fetch");
    assert(
      env.fetches[0].url === "http://s.test/shell/jsi-deferred.js?_jsd=1",
      "fetch URL wrong: " + env.fetches[0].url,
    );
    assert(
      env.fetches[0].opts && env.fetches[0].opts.credentials === "omit",
      "fetch must omit credentials (cross-origin read)",
    );
    assert(doc.appended.length === 1, "body inlined as exactly one script");
    assert(
      doc.appended[0].attrs["data-shell-jsi-deferred"] === "1",
      "inlined script missing deferred marker",
    );
    assert(
      doc.appended[0].textContent === env.responseCode,
      "inlined body must be the fetched text verbatim",
    );
    assert(
      env.window.__shellJsiDeferred.injected === 1,
      "injected latch not set",
    );
    // Idempotent: a second poll tick does not re-fetch.
    env.tick(1000);
    assert(env.fetches.length === 1, "fired latch => no second fetch");
  }

  // Case 5: window.__shellPhases card mark also triggers (phase-based signal).
  {
    const env = makeEnv({
      "jellyfin.shell.jsiDeferredPath": "/d.js",
      "jellyfin.shell.serverUrl": "http://s.test",
    });
    env.responseCode = "1;";
    env.window.__shellPhases = {};
    env.run();
    env.tick(1000);
    assert(env.fetches.length === 0, "no phase mark => no fetch");
    env.window.__shellPhases.card = 9200;
    env.tick(1000);
    await flush();
    await flush();
    assert(env.fetches.length === 1, "phase card mark => fetch");
  }

  // Case 6: hard cap — a card that never renders still delivers past 60 s.
  {
    const env = makeEnv({
      "jellyfin.shell.jsiDeferredPath": "/d.js",
      "jellyfin.shell.serverUrl": "http://s.test",
    });
    env.responseCode = "1;";
    env.run();
    env.tick(59000);
    assert(env.fetches.length === 0, "before cap => no fetch");
    env.tick(2000); // now > 60 s
    await flush();
    await flush();
    assert(env.fetches.length === 1, "past 60 s cap => deliver anyway");
  }

  // Case 7: re-injected copy (fast-path splice + DOMParser inject) is a no-op.
  {
    const env = makeEnv({
      "jellyfin.shell.jsiDeferredPath": "/d.js",
      "jellyfin.shell.serverUrl": "http://s.test",
    });
    env.run();
    const firstCount = env.intervals.length;
    env.run(); // second copy on the same window
    assert(
      env.intervals.length === firstCount,
      "armed latch must stop a second copy from arming another interval",
    );
  }

  console.log("All JELA-228 jsi-deferred-channel checks passed.");
})().catch((e) => {
  console.error("FAIL:", e && e.stack ? e.stack : e);
  process.exit(1);
});
