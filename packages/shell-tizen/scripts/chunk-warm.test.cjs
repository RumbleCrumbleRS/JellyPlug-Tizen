/*
 * JELA-44 (JELA-41 WS-3): cold-boot chunk/CSS HTTP-cache warm under the
 * boot cover — opt-in via localStorage['jellyfin.shell.chunkWarm']='1',
 * default OFF.
 *
 * Extracts the SHIPPED instantHomeBody() (the warm engine rides the
 * Instant-Home script so it runs in every injected document and shares the
 * overlay lifecycle) and drives it through a virtual clock + DOM stub +
 * controllable fetch, pinning:
 *   - default OFF: no flag -> no __shellCW state, zero fetches
 *   - origin gate (JELA-47): warming is keyed on srv()'s ASSET origin — a
 *     missing/unparseable serverUrl is inert; the PAGE origin is irrelevant
 *     (the production Tizen app boots at file:///index.html — the old
 *     page-origin===srv-origin guard was permanently false there and left
 *     the warm inert on-device, masked by the http test origin here)
 *   - absolute URLs: every warm fetch hits cwo+path — root-relative paths
 *     are absolutized against srv()'s origin (a file:// page would resolve
 *     them to dead file:/// URLs); absolute publicPath URLs must sit on
 *     srv()'s origin, cross-origin ones are dropped (never a foreign warm)
 *   - live URL resolution: fake-chunk push into webpackChunk* captures
 *     __webpack_require__; p + u(id)/miniCssF(id) resolve the WS-0 chunk-id
 *     seed; ids missing from the live maps ("undefined" in the stringified
 *     name) are silently skipped — no guessed hashes, no 404 storm
 *   - static seed: stable UNVERSIONED plugin/theme paths queued after the
 *     resolved chunk URLs
 *   - bounded parallelism: never more than 4 in-flight fetches
 *   - one attempt per URL (dedupe), already-tagged script/link URLs skipped
 *     (never duplicates an in-flight page request), credentials:"omit"
 *   - abort on cover-gone: overlay dismissal drops the queue (st="dismiss");
 *     in-flight fetches complete and are counted
 *   - Direct-Home handoff survival: dismiss("dh") with a painted __shellDH
 *     grid keeps the cover "up" — warming proceeds (production directHome
 *     boots dismiss the snapshot BEFORE webpackChunk exists)
 *   - pre-start dismissal: cover gone before webpackChunk appears ends the
 *     poller with st="dismiss", zero fetches
 *   - one warm per boot: a re-injected body (document.write gen turnover)
 *     never restarts a started warm
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
assert(
  body.indexOf("jellyfin.shell.chunkWarm") !== -1,
  "chunkWarm opt-in flag key present",
);
assert(
  body.indexOf('credentials:"omit"') !== -1,
  "warm fetches must send credentials:omit (txPrime precedent)",
);
assert(body.indexOf("</script") === -1, "no </script literal");
assert(body.indexOf("=>") === -1, "body must be ES5 (no arrow functions)");
assert(body.indexOf("`") === -1, "body must be ES5 (no template literals)");
assert(
  body.indexOf("eval(") === -1 && body.indexOf("new Function") === -1,
  "warm responses are never evaluated",
);

// ---- virtual clock + DOM stub ----------------------------------------------
const CREDS = JSON.stringify({
  Servers: [{ Id: "s1", AccessToken: "tok", UserId: "u1" }],
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

  function makeNode(tag) {
    return {
      tagName: tag,
      id: "",
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
  let loadedTags = [];
  const document = {
    documentElement,
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
    querySelectorAll(sel) {
      sel = String(sel);
      if (sel.indexOf("script[src]") === 0) return loadedTags;
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

  // ---- controllable fetch stub ----
  const calls = []; // {url, opts, settled, resolve(ok), reject()}
  let inflight = 0;
  let maxInflight = 0;
  const auto = opts.autoResolve !== false;
  window.fetch = opts.noFetch
    ? undefined
    : function (url, fo) {
        const c = { url: String(url), opts: fo || {}, settled: false };
        inflight++;
        if (inflight > maxInflight) maxInflight = inflight;
        const p = new Promise((res, rej) => {
          c._res = res;
          c._rej = rej;
        });
        c.resolve = function (ok) {
          if (c.settled) return;
          c.settled = true;
          inflight--;
          c._res({
            ok: ok !== false,
            text: () => Promise.resolve("x"),
          });
        };
        c.reject = function () {
          if (c.settled) return;
          c.settled = true;
          inflight--;
          c._rej(new Error("net"));
        };
        calls.push(c);
        if (auto) c.resolve(true);
        return p;
      };

  const store = Object.assign(
    {
      jellyfin_credentials: CREDS,
      "jellyfin.shell.serverUrl":
        opts.srv !== undefined ? opts.srv : "http://srv",
    },
    opts.flagOff ? {} : { "jellyfin.shell.chunkWarm": "1" },
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
  const location = {
    hash: "",
    protocol: opts.protocol || "http:",
    host: opts.host || "srv",
  };
  const getComputedStyle = function () {
    return { fontSize: "28px", borderTopLeftRadius: "6px" };
  };

  async function drainMicro(n) {
    for (let i = 0; i < (n || 400); i++) await Promise.resolve();
  }

  return {
    window,
    document,
    documentElement,
    timers,
    store,
    calls,
    maxInflight: () => maxInflight,
    inflight: () => inflight,
    setLoadedTags(list) {
      loadedTags = list;
    },
    makeNode,
    drainMicro,
    fireKey(code) {
      const ev = {
        type: "keydown",
        keyCode: code,
        preventDefault() {},
        stopPropagation() {},
        stopImmediatePropagation() {},
      };
      (listeners.keydown || []).forEach((fn) => fn(ev));
      return ev;
    },
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
    async advance(toMs) {
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
        await drainMicro(50);
      }
      now = toMs;
      await drainMicro(50);
    },
  };
}

// webpack runtime stub: u()/miniCssF() stringify missing map entries with
// "undefined" exactly like the real minified runtime does. publicPath
// defaults to root-relative "/web/"; the file:// deployment sees webpack's
// auto publicPath as an ABSOLUTE URL (pass pubPath to pin that shape).
function makeWebpack(env, jsMap, cssMap, pubPath) {
  return {
    push(chunk) {
      assert(Array.isArray(chunk) && chunk.length === 3, "fake chunk shape");
      chunk[2]({
        p: pubPath === undefined ? "/web/" : pubPath,
        u: (id) => id + "." + jsMap[id] + ".chunk.js",
        miniCssF: (id) => id + "." + cssMap[id] + ".css",
      });
    },
  };
}

const JS_MAP = { 59258: "aaa", home: "bbb", "home-html": "ccc" };
const CSS_MAP = { home: "ddd" };

// ---- 1. default OFF: no state, no fetches ----------------------------------
(async () => {
  {
    const env = makeEnv({ flagOff: true });
    env.run();
    env.window.webpackChunkjellyfin = makeWebpack(env, JS_MAP, CSS_MAP);
    await env.advance(5000);
    assert(
      env.window.__shellCW === undefined,
      "1: flag off -> no __shellCW state",
    );
    assert(env.calls.length === 0, "1: flag off -> zero fetches");
  }

  // ---- 2. origin gate: unparseable srv() -> inert ---------------------------
  {
    for (const bad of ["", "not-a-url", "ftp://host"]) {
      const env = makeEnv({ srv: bad });
      env.run();
      env.window.webpackChunkjellyfin = makeWebpack(env, JS_MAP, CSS_MAP);
      await env.advance(5000);
      assert(
        env.window.__shellCW === undefined,
        "2: srv " + JSON.stringify(bad) + " -> no __shellCW state",
      );
      assert(
        env.calls.length === 0,
        "2: srv " + JSON.stringify(bad) + " -> zero fetches",
      );
    }
  }

  // ---- 2b. JELA-47: file:// page origin warms against srv()'s origin --------
  // The production Tizen app boots at file:///index.html; webpack's auto
  // publicPath resolves ABSOLUTE there (assets load from the server). All
  // warm URLs must be absolute on srv()'s origin, and a page tag carrying
  // the ABSOLUTE asset URL must still dedupe.
  {
    const env = makeEnv({ protocol: "file:", host: "" });
    env.run();
    const tag = env.makeNode("SCRIPT");
    tag.setAttribute("src", "http://srv/web/59258.aaa.chunk.js");
    env.setLoadedTags([tag]);
    env.window.webpackChunkjellyfin = makeWebpack(
      env,
      JS_MAP,
      CSS_MAP,
      "http://srv/web/",
    );
    await env.advance(3000);
    const cw = env.window.__shellCW;
    assert(cw && cw.started === 1, "2b: file:// page starts the warm");
    const urls = env.calls.map((c) => c.url);
    assert(
      urls.length > 0 && urls.every((u) => u.indexOf("http://srv/") === 0),
      "2b: every warm URL absolute on srv()'s origin: " + JSON.stringify(urls),
    );
    assert(
      urls.indexOf("http://srv/web/home.bbb.chunk.js") !== -1 &&
        urls.indexOf("http://srv/web/home.ddd.css") !== -1 &&
        urls.indexOf("http://srv/web/themes/dark/theme.css") !== -1,
      "2b: absolute-publicPath chunks + absolutized static seed fetched",
    );
    assert(
      urls.indexOf("http://srv/web/59258.aaa.chunk.js") === -1 && cw.sk === 1,
      "2b: absolute-attr page tag skipped (sk=1), never re-fetched",
    );
    assert(
      cw.done === 1 && cw.st === "done" && cw.f === urls.length,
      "2b: finished st=done on file://: " + JSON.stringify(cw),
    );
  }

  // ---- 2c. JELA-47: cross-origin publicPath chunks dropped, seed still warms
  {
    const env = makeEnv({ protocol: "file:", host: "" });
    env.run();
    env.window.webpackChunkjellyfin = makeWebpack(
      env,
      JS_MAP,
      CSS_MAP,
      "http://evil/web/",
    );
    await env.advance(3000);
    const cw = env.window.__shellCW;
    assert(cw && cw.started === 1, "2c: warm still starts");
    const urls = env.calls.map((c) => c.url);
    assert(
      urls.every((u) => u.indexOf("http://srv/") === 0),
      "2c: cross-origin publicPath URLs never fetched: " + JSON.stringify(urls),
    );
    assert(
      urls.indexOf("http://srv/web/themes/dark/theme.css") !== -1,
      "2c: static seed still warms on srv()'s origin",
    );
  }

  // ---- 3. happy path: live resolution + static seed, done -------------------
  {
    const env = makeEnv({});
    env.run();
    const G = env.window.__shellIH;
    assert(G && G.painted === 1, "3: overlay painted (skeleton)");
    // pre-existing page tag for one resolvable chunk -> must be skipped
    const tag = env.makeNode("SCRIPT");
    tag.setAttribute("src", "/web/59258.aaa.chunk.js");
    env.setLoadedTags([tag]);
    await env.advance(1000); // poller ticks, no webpackChunk yet
    assert(env.calls.length === 0, "3: nothing fetched before webpackChunk");
    env.window.webpackChunkjellyfin = makeWebpack(env, JS_MAP, CSS_MAP);
    await env.advance(2000);
    const cw = env.window.__shellCW;
    assert(cw && cw.started === 1 && cw.wpc === 1, "3: warm started, wpc=1");
    const urls = env.calls.map((c) => c.url);
    // JELA-47: every warm URL is absolutized against srv()'s origin even on
    // a same-origin page (one code path, no page-origin dependence)
    assert(
      urls.indexOf("http://srv/web/home.bbb.chunk.js") !== -1 &&
        urls.indexOf("http://srv/web/home.ddd.css") !== -1 &&
        urls.indexOf("http://srv/web/home-html.ccc.chunk.js") !== -1,
      "3: live-resolved chunk/css URLs fetched: " + JSON.stringify(urls),
    );
    assert(
      urls.indexOf("http://srv/web/59258.aaa.chunk.js") === -1 && cw.sk === 1,
      "3: chunk tagged with a ROOT-RELATIVE src skipped (sk=1), never re-fetched",
    );
    assert(
      urls.indexOf("http://srv/web/themes/dark/theme.css") !== -1 &&
        urls.indexOf("http://srv/JellyfinEnhanced/js/jellyseerr/api.js") !== -1,
      "3: static stable-path seed fetched (absolutized)",
    );
    assert(
      urls.every((u) => u.indexOf("undefined") === -1),
      "3: no undefined-hash URL ever fetched",
    );
    assert(
      urls.every((u) => u.indexOf("?") === -1),
      "3: no versioned/query URL in the warm set",
    );
    assert(
      new Set(urls).size === urls.length,
      "3: one attempt per URL (no duplicates)",
    );
    assert(
      env.calls.every((c) => c.opts.credentials === "omit"),
      "3: all warm fetches credentials:omit",
    );
    assert(env.maxInflight() <= 4, "3: never more than 4 in-flight");
    assert(
      cw.q === urls.length + cw.sk && cw.f === urls.length && cw.e === 0,
      "3: counters consistent: " + JSON.stringify(cw),
    );
    assert(
      cw.done === 1 && cw.st === "done" && cw.ms >= 0,
      "3: finished st=done: " + JSON.stringify(cw),
    );
    // one warm per boot: re-injected body (gen turnover) never restarts
    const before = env.calls.length;
    env.swapDoc();
    env.run();
    await env.advance(10000);
    assert(
      env.calls.length === before,
      "3: re-injected body never restarts a started warm",
    );
  }

  // ---- 4. bounded parallelism + dismissal aborts the queue ------------------
  {
    const env = makeEnv({ autoResolve: false });
    env.run();
    await env.advance(500);
    env.window.webpackChunkjellyfin = makeWebpack(env, JS_MAP, CSS_MAP);
    await env.advance(1500);
    const cw = env.window.__shellCW;
    assert(cw && cw.started === 1, "4: warm started");
    assert(
      env.calls.length === 4 && env.inflight() === 4,
      "4: exactly 4 issued while none settled",
    );
    // overlay dismissed (Back escape hatch -- the input shield is default ON
    // since JELA-49, so D-pad keys are eaten; Back always dismisses) ->
    // cover gone
    env.fireKey(10009);
    assert(env.window.__shellIH.dismissed === 1, "4: overlay dismissed");
    env.calls[0].resolve(true);
    await env.drainMicro();
    assert(
      env.calls.length === 4,
      "4: no new fetch after cover gone (queue dropped)",
    );
    env.calls[1].resolve(true);
    env.calls[2].resolve(false); // http error -> e++
    env.calls[3].reject(); // network error -> e++
    await env.drainMicro();
    assert(
      cw.done === 1 && cw.st === "dismiss" && cw.f === 2 && cw.e === 2,
      "4: in-flight completed + counted, st=dismiss: " + JSON.stringify(cw),
    );
  }

  // ---- 5. Direct-Home handoff: dismiss("dh") keeps the cover up -------------
  {
    const env = makeEnv({});
    env.window.__shellDH = { painted: 1, dismissed: 0 };
    env.run();
    await env.advance(1400); // watch tick dismisses "dh" before webpackChunk
    const G = env.window.__shellIH;
    assert(
      G.dismissed === 1 && G.why === "dh",
      "5: snapshot handed off to the Direct-Home grid",
    );
    env.window.webpackChunkjellyfin = makeWebpack(env, JS_MAP, CSS_MAP);
    await env.advance(3000);
    const cw = env.window.__shellCW;
    assert(
      cw && cw.started === 1 && cw.done === 1 && cw.st === "done" && cw.f > 0,
      "5: warm ran to completion under the DH grid: " + JSON.stringify(cw),
    );
  }

  // ---- 6. cover gone before webpackChunk -> st=dismiss, zero fetches --------
  {
    const env = makeEnv({});
    env.run();
    await env.advance(500);
    env.fireKey(10009); // Back escape dismisses (shield eats D-pad), no DH grid
    await env.advance(2000);
    env.window.webpackChunkjellyfin = makeWebpack(env, JS_MAP, CSS_MAP);
    await env.advance(5000);
    const cw = env.window.__shellCW;
    assert(
      cw && cw.started === 0 && cw.done === 1 && cw.st === "dismiss",
      "6: pre-start dismissal ends poller st=dismiss: " + JSON.stringify(cw),
    );
    assert(env.calls.length === 0, "6: zero fetches");
  }

  console.log("chunk-warm.test.cjs: all assertions passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
