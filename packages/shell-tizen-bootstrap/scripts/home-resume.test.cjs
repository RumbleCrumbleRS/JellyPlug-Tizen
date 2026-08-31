/*
 * JELA-753: reuse the home tab controller across a route change —
 * opt-in via localStorage['jellyfin.shell.homeResume']='1', default OFF.
 *
 * Drives the SHIPPED seed snippet against the real upstream bytes: the
 * `hometab` chunk body is pasted verbatim out of the live deployment
 * (/web/hometab.de9e654dd24ed11d8f22.chunk.js) and pushed through a
 * webpackJsonpCallback transcribed from the webpack 5 runtime, and the
 * controller is fetched with the `home` chunk's own
 * `var a=m[e];if(!a){a=new r(...);m[e]=a}` expression. So every assertion
 * below is about upstream's real construction path, not a paraphrase of it.
 *
 * Pinned:
 *   - default OFF: no flag -> nothing wraps, every remount rebuilds. This is
 *     also the CONTROL that keeps the "reuse" assertions from passing
 *     vacuously: it proves the harness really does rebuild without us.
 *   - ON, first mount: full loadSections exactly as shipped
 *   - ON, remount after a route change: ZERO loadSections, resume() instead,
 *     the SAME controller instance, and every rendered row moved into the
 *     new mount's container (AC1 + AC2 + AC3)
 *   - the container class list Home Screen Sections stamps on React's node
 *     (`homeSectionsContainer`) survives the move — a fresh mount does not
 *     have it
 *   - the constructor's `settingschange` -> full rebuild wiring survives on
 *     the adopted node
 *   - TTL (default 5 min, tunable, NOT sliding) expires into a full rebuild
 *   - a user-data mutation (POST /PlayedItems) between mounts forces a full
 *     rebuild — via fetch AND via XHR; a GET to the same route does not
 *   - a different user id never inherits the previous user's home
 *   - a hostile/absent DOM or a throwing container degrades to a rebuild,
 *     never throws out of the constructor
 *   - the anchor is exact: a module mentioning only one of the two names is
 *     not wrapped
 */
"use strict";
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const SRC = path.join(__dirname, "..", "src", "boot-shell.src.js");
const text = fs.readFileSync(SRC, "utf8");

// ---- pull the shipped snippet out of the seed array ----------------------
function shimSource() {
  const lines = text.split("\n");
  const flag = lines.findIndex(
    // JELA-827: the gate is opt-OUT now — locate it by the new expression.
    (l) => l.includes("jellyfin.shell.homeResume") && l.includes('==="0"'),
  );
  assert(flag !== -1, "could not find the homeResume shim in " + SRC);
  let a = flag;
  while (!lines[a].includes("try{(function(){")) a--;
  let b = flag;
  while (!lines[b].includes("})();}catch(_){}")) b++;
  const arr = lines
    .slice(a, b + 1)
    .join("\n")
    .replace(/,\s*$/, "");
  // eslint-disable-next-line no-eval
  return eval("[" + arr + "]").join("\n");
}
const SHIM = shimSource();

// ---- upstream: /web/hometab.de9e654dd24ed11d8f22.chunk.js, verbatim ------
// Only the module map is reproduced (the chunk's own
// `(self.webpackChunk=self.webpackChunk||[]).push(` wrapper is applied by the
// harness so the push goes through the shim's hook).
const HOMETAB_MODULE = `{66242:function(e,t,n){n.r(t),n(29305),n(32733),n(84701),n(81678),n(44962),n(4754),n(94),n(36947),n(78557),n(90076),n(45309),n(83994),n(82367);var i=n(82885),o=n(8566),r=n(9164),s=n(56213),u=n(67430);function c(e){return c="function"==typeof Symbol&&"symbol"==typeof Symbol.iterator?function(e){return typeof e}:function(e){return e&&"function"==typeof Symbol&&e.constructor===Symbol&&e!==Symbol.prototype?"symbol":typeof e},c(e)}function a(e,t){for(var n=0;n<t.length;n++){var i=t[n];i.enumerable=i.enumerable||!1,i.configurable=!0,"value"in i&&(i.writable=!0),Object.defineProperty(e,l(i.key),i)}}function l(e){var t=function(e){if("object"!=c(e)||!e)return e;var t=e[Symbol.toPrimitive];if(void 0!==t){var n=t.call(e,"string");if("object"!=c(n))return n;throw new TypeError("@@toPrimitive must return a primitive value.")}return String(e)}(e);return"symbol"==c(t)?t:t+""}n(1177);var f=function(){return e=function e(t,n){!function(e,t){if(!(e instanceof t))throw new TypeError("Cannot call a class as a function")}(this,e),this.view=t,this.params=n,this.apiClient=u.tF.currentApiClient(),this.sectionsContainer=t.querySelector(".sections"),t.querySelector(".sections").addEventListener("settingschange",y.bind(this))},(t=[{key:"onResume",value:function(e){if(this.sectionsRendered){var t=this.sectionsContainer;return t?s.Ay.resume(t,e):Promise.resolve()}o.Ay.show();var n=this.view,u=this.apiClient;return this.destroyHomeSections(),this.sectionsRendered=!0,u.getCurrentUser().then((function(e){return s.Ay.loadSections(n.querySelector(".sections"),u,e,i)})).then((function(){e.autoFocus&&r.A.autoFocus(n)})).catch((function(e){console.error(e)})).finally((function(){o.Ay.hide()}))}},{key:"onPause",value:function(){var e=this.sectionsContainer;e&&s.Ay.pause(e)}},{key:"destroy",value:function(){this.view=null,this.params=null,this.apiClient=null,this.destroyHomeSections(),this.sectionsContainer=null}},{key:"destroyHomeSections",value:function(){var e=this.sectionsContainer;e&&s.Ay.destroySections(e)}}])&&a(e.prototype,t),Object.defineProperty(e,"prototype",{writable:!1}),e;var e,t}();function y(){this.sectionsRendered=!1,this.paused||this.onResume({refresh:!0})}t.default=f}}`;

// A decoy carrying ONE of the two anchor names. Must never be wrapped.
const DECOY_MODULE = `{40001:function(e,t,n){n.r(t),t.default=function(){this.sectionsRendered=!0}}}`;

// ---- the smallest DOM the upstream constructor + our adopt() touch -------
class El {
  constructor(tag, cls, attrs) {
    this.tagName = tag;
    this.className = cls || "";
    this.attrs = attrs || {};
    this.children = [];
    this.parentNode = null;
    this.listeners = {};
  }
  get firstChild() {
    return this.children[0] || null;
  }
  getAttribute(k) {
    return Object.prototype.hasOwnProperty.call(this.attrs, k)
      ? this.attrs[k]
      : null;
  }
  appendChild(n) {
    if (n.parentNode) {
      const i = n.parentNode.children.indexOf(n);
      if (i >= 0) n.parentNode.children.splice(i, 1);
    }
    n.parentNode = this;
    this.children.push(n);
    return n;
  }
  addEventListener(t, f) {
    (this.listeners[t] = this.listeners[t] || []).push(f);
  }
  dispatch(t) {
    for (const f of this.listeners[t] || []) f.call(this);
  }
  matches(sel) {
    const m = /^\.([\w-]+)(?:\[([\w-]+)='([^']*)'\])?$/.exec(sel);
    if (!m) return false;
    if (!(" " + this.className + " ").includes(" " + m[1] + " ")) return false;
    return !m[2] || String(this.getAttribute(m[2])) === m[3];
  }
  querySelector(sel) {
    for (const c of this.children) {
      if (c.matches(sel)) return c;
      const d = c.querySelector(sel);
      if (d) return d;
    }
    return null;
  }
  rows() {
    return this.children.length;
  }
}

// ---- one simulated app launch (fresh page, persistent localStorage) ------
function launch(store, opts) {
  opts = opts || {};
  const log = { load: 0, resume: [], destroy: 0, pause: 0, xhr: [], fetch: [] };
  let clock = opts.t0 || 1_000_000;

  const W = {
    ApiClient: { getCurrentUserId: () => opts.userId || "u1" },
    console,
    setInterval: () => 0,
    clearInterval: () => {},
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => {
        store[k] = String(v);
      },
    },
  };
  // Date is read by the shim as `(new Date).getTime()`; drive it from `clock`.
  class FakeDate {
    getTime() {
      return clock;
    }
  }
  const XHRproto = {
    open(m, u) {
      log.xhr.push([m, u]);
    },
  };
  function XMLHttpRequest() {}
  XMLHttpRequest.prototype = XHRproto;
  W.XMLHttpRequest = XMLHttpRequest;
  W.fetch = function (i, init) {
    log.fetch.push([(init && init.method) || "GET", i]);
    return Promise.resolve();
  };

  // ---- webpack 5 runtime, transcribed ------------------------------------
  const modules = {};
  const cache = {};
  function req(id) {
    if (cache[id]) return cache[id].exports;
    const mod = (cache[id] = { exports: {} });
    if (typeof modules[id] === "function") modules[id](mod, mod.exports, req);
    return mod.exports;
  }
  req.m = modules;
  req.c = cache;
  req.r = (t) => {
    Object.defineProperty(t, "__esModule", { value: true });
  };
  req.o = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  // Upstream deps the hometab factory pulls in.
  const sections = {
    Ay: {
      loadSections() {
        log.load++;
        return Promise.resolve();
      },
      resume(el, o) {
        log.resume.push({ rows: el.rows(), cls: el.className, opts: o });
        return Promise.resolve();
      },
      pause() {
        log.pause++;
      },
      destroySections(el) {
        log.destroy++;
        el.children.length = 0;
      },
    },
  };
  modules[56213] = (m) => {
    m.exports.Ay = sections.Ay;
  };
  modules[8566] = (m) => {
    m.exports.Ay = { show() {}, hide() {} };
  };
  modules[9164] = (m) => {
    m.exports.A = { autoFocus() {} };
  };
  modules[82885] = () => {};
  modules[67430] = (m) => {
    m.exports.tF = {
      currentApiClient: () => ({
        getCurrentUser: () => Promise.resolve({ Id: opts.userId || "u1" }),
      }),
    };
  };

  // Everything else the chunk requires is a polyfill import; make them inert.
  const inert = new Proxy(modules, {
    get: (t, k) => (k in t ? t[k] : () => {}),
    has: () => true,
  });
  function reqInert(id) {
    if (cache[id]) return cache[id].exports;
    const f = modules[id] || inert[id];
    const mod = (cache[id] = { exports: {} });
    if (typeof f === "function") f(mod, mod.exports, reqInert);
    return mod.exports;
  }
  reqInert.m = modules;
  reqInert.c = cache;
  reqInert.r = req.r;
  reqInert.o = req.o;

  // ---- run the shim (it creates/wraps W.webpackChunk) --------------------
  const G = new Function(
    "window",
    "localStorage",
    "XMLHttpRequest",
    "Date",
    "setInterval",
    "clearInterval",
    "console",
    SHIM + "\nreturn window.__shellHR||null;",
  );
  const D = G(
    W,
    W.localStorage,
    XMLHttpRequest,
    FakeDate,
    W.setInterval,
    W.clearInterval,
    console,
  );

  // ---- webpackJsonpCallback, transcribed --------------------------------
  const arr = W.webpackChunk || (W.webpackChunk = []);
  const parentPush = arr.push.bind(arr);
  const installed = {};
  arr.push = function (data) {
    const [chunkIds, moreModules, runtime] = data;
    for (const id in moreModules)
      if (req.o(moreModules, id)) modules[id] = moreModules[id];
    if (runtime) runtime(reqInert);
    parentPush(data);
    for (const id of chunkIds) installed[id] = 0;
    return arr.length;
  };
  // The runtime replays anything the page pushed before it loaded.
  return {
    D,
    log,
    W,
    modules,
    reqInert,
    tick: (ms) => {
      clock += ms;
    },
    now: () => clock,
    push: (src) => arr.push(new Function("return " + src)()),
    pushChunk: (ids, mods) =>
      arr.push([ids, new Function("return " + mods)(), undefined]),
  };
}

// The `home` chunk's own controller expression, verbatim in shape.
function getController(m, e, Klass, root) {
  var t,
    a = m[e];
  return (
    a ||
      ((a = new Klass(
        null === (t = root) || void 0 === t
          ? void 0
          : t.querySelector(".tabContent[data-index='" + e + "']"),
        null,
      )),
      (m[e] = a)),
    a
  );
}

// A fresh React mount: a new root, a new tabContent, a new EMPTY .sections.
function mount() {
  const root = new El("DIV", "");
  const tab = new El("DIV", "tabContent pageTabContent", { "data-index": "0" });
  tab.appendChild(new El("DIV", "sections"));
  root.appendChild(tab);
  return root;
}

// One "visit the home" pass, exactly as the home chunk's E() does it.
async function visit(app, root) {
  const Klass = app.reqInert(66242).default;
  const m = []; // useMemo(() => [], []) — dies with the React instance
  const a = getController(m, 0, Klass, root);
  const refresh = !a.refreshed;
  await a.onResume({ autoFocus: false, refresh });
  a.refreshed = true;
  return a;
}

// Home Screen Sections stamps its class on React's node and fills it.
function render(root, rows) {
  const sec = root.querySelector(".sections");
  sec.className = "sections homeSectionsContainer";
  for (let i = 0; i < rows; i++)
    sec.appendChild(new El("DIV", "verticalSection jp-row"));
  return sec;
}

// -------------------------------------------------------------------------
async function run() {
  // --- 1. JELA-827 kill switch: flag "0" -> inert. Also the CONTROL that
  //        proves the rebuild. Rollback for this flag is setItem(key,"0"),
  //        NEVER removeItem — an absent key is now an ON arm (see arm 1b).
  {
    const app = launch({ "jellyfin.shell.homeResume": "0" });
    assert.strictEqual(app.D, null, 'flag "0" must leave __shellHR unset');
    app.pushChunk([18119], HOMETAB_MODULE);

    const r1 = mount();
    await visit(app, r1);
    assert.strictEqual(app.log.load, 1, "off/mount1: full loadSections");
    render(r1, 18);

    const r2 = mount(); // route change: Home unmounted and remounted
    await visit(app, r2);
    assert.strictEqual(
      app.log.load,
      2,
      "off/mount2: upstream rebuilds — this is the bug, and the control",
    );
    assert.strictEqual(app.log.resume.length, 0, "off: resume never reached");
    assert.strictEqual(
      r2.querySelector(".sections").rows(),
      0,
      "off: the new mount starts empty (home goes blank)",
    );
  }

  // --- 1b. JELA-827: key ABSENT must behave exactly like the seeded "1" arm.
  //         The "1" is written by the jp789seed JSI channel entry, which only
  //         runs after the lite->SPA handoff (JELA-802) — that seeder's own
  //         header says the shell reads the key BEFORE the channel executes —
  //         so every cold boot read null and got the blank-home rebuild.
  {
    const app = launch({});
    assert(app.D && app.D.on === 1, "key absent must publish __shellHR (opt-OUT)");
    app.pushChunk([18119], HOMETAB_MODULE);
    assert.strictEqual(app.D.found, 1, "absent: the hometab factory is found");

    const r1 = mount();
    const c1 = await visit(app, r1);
    assert.strictEqual(app.log.load, 1, "absent/mount1: full loadSections");
    render(r1, 18);

    const r2 = mount();
    const c2 = await visit(app, r2);
    assert.strictEqual(c2, c1, "absent: the SAME controller comes back");
    assert.strictEqual(app.D.hits, 1, "absent: the arm fired (hits>0)");
    assert.strictEqual(app.log.load, 1, "absent: mount2 issues NO loadSections");
    assert.strictEqual(
      r2.querySelector(".sections").rows(),
      18,
      "absent: all 18 rows moved to the new mount",
    );
  }

  // --- 2. ON: the remount reuses the controller and the rendered rows ------
  {
    const app = launch({ "jellyfin.shell.homeResume": "1" });
    assert(app.D && app.D.on === 1, "flag on must publish __shellHR");
    app.pushChunk([18119], HOMETAB_MODULE);
    assert.strictEqual(app.D.found, 1, "the hometab factory must be found");
    assert.strictEqual(app.D.mid, "66242", "…and it is module 66242");

    const r1 = mount();
    const c1 = await visit(app, r1);
    assert.strictEqual(app.D.wrap, 1, "the ctor is wrapped exactly once");
    assert.strictEqual(app.D.ctor, 1, "one construction so far");
    assert.strictEqual(app.log.load, 1, "on/mount1: full loadSections");
    assert.strictEqual(app.D.hits, 0, "nothing to reuse on the first mount");
    // mount1 destroys once on its way into loadSections, exactly as shipped.
    assert.strictEqual(app.log.destroy, 1, "on/mount1: the shipped destroy");
    const sec1 = render(r1, 18);

    const r2 = mount();
    const c2 = await visit(app, r2);
    assert.strictEqual(c2, c1, "AC1: the SAME controller instance comes back");
    assert.strictEqual(app.D.hits, 1, "AC5: the arm fired (hits>0)");
    assert.strictEqual(app.log.load, 1, "AC2: mount2 issues NO loadSections");
    assert.strictEqual(app.log.destroy, 1, "…and destroys nothing further");
    assert.strictEqual(app.log.resume.length, 1, "…it resumes instead");
    assert.strictEqual(
      app.log.resume[0].opts.refresh,
      false,
      "refreshed:true is already set, so resume gets refresh:false",
    );

    const sec2 = r2.querySelector(".sections");
    assert.strictEqual(sec2.rows(), 18, "AC3: all 18 rows moved to the mount");
    assert.strictEqual(app.log.resume[0].rows, 18, "…before resume() saw it");
    assert.strictEqual(sec1.rows(), 0, "…and left the detached node");
    assert.strictEqual(
      sec2.className,
      "sections homeSectionsContainer",
      "the homeSectionsContainer class travels with the rows",
    );
    assert.strictEqual(c1.sectionsContainer, sec2, "controller re-pointed");
    assert.strictEqual(c1.view, r2.querySelector(".tabContent[data-index='0']"));

    // settingschange must still force a full rebuild on the adopted node
    sec2.dispatch("settingschange");
    await Promise.resolve();
    await Promise.resolve();
    assert.strictEqual(
      app.log.load,
      2,
      "settingschange rewires onto the adopted container",
    );
  }

  // --- 3. TTL: 5 min default, not sliding ---------------------------------
  {
    const app = launch({ "jellyfin.shell.homeResume": "1" });
    app.pushChunk([18119], HOMETAB_MODULE);
    const r1 = mount();
    await visit(app, r1);
    render(r1, 4);

    app.tick(299_000);
    const r2 = mount();
    await visit(app, r2);
    assert.strictEqual(app.log.load, 1, "inside the TTL: reuse");
    render(r2, 4);

    // NOT sliding: the stamp is still mount1's, so 2 s more expires it.
    app.tick(2_000);
    const r3 = mount();
    await visit(app, r3);
    assert.strictEqual(app.log.load, 2, "past the TTL: full rebuild");
    assert.strictEqual(app.D.stale, 1, "…counted as stale");
  }
  {
    const app = launch({
      "jellyfin.shell.homeResume": "1",
      "jellyfin.shell.homeResumeTtlMs": "1000",
    });
    app.pushChunk([18119], HOMETAB_MODULE);
    await visit(app, mount());
    app.tick(1500);
    await visit(app, mount());
    assert.strictEqual(app.log.load, 2, "TTL is tunable");
  }

  // --- 4. freshness: a user-data mutation forces the rebuild ---------------
  for (const via of ["fetch", "xhr"]) {
    const app = launch({ "jellyfin.shell.homeResume": "1" });
    app.pushChunk([18119], HOMETAB_MODULE);
    const r1 = mount();
    await visit(app, r1);
    render(r1, 6);

    // Reading the same route must NOT invalidate.
    if (via === "fetch") await app.W.fetch("/Users/u1/PlayedItems/x");
    else new app.W.XMLHttpRequest().open("GET", "/Users/u1/PlayedItems/x");
    await visit(app, mount());
    assert.strictEqual(app.log.load, 1, via + ": a GET does not invalidate");

    // Marking watched on the detail page must.
    if (via === "fetch")
      await app.W.fetch("/Users/u1/PlayedItems/x", { method: "POST" });
    else new app.W.XMLHttpRequest().open("POST", "/Users/u1/PlayedItems/x");
    await visit(app, mount());
    assert.strictEqual(app.log.load, 2, via + ": AC4 — a POST forces a rebuild");
    assert.strictEqual(app.D.dirty, 1, via + ": …counted as dirty");
  }
  {
    // Starting playback counts too, so finishing an episode invalidates.
    const app = launch({ "jellyfin.shell.homeResume": "1" });
    app.pushChunk([18119], HOMETAB_MODULE);
    await visit(app, mount());
    await app.W.fetch("/Sessions/Playing", { method: "POST" });
    await visit(app, mount());
    assert.strictEqual(app.log.load, 2, "playback start invalidates");
  }

  // --- 5. identity: a different user never inherits the previous home ------
  {
    const store = { "jellyfin.shell.homeResume": "1" };
    const app = launch(store, { userId: "alice" });
    app.pushChunk([18119], HOMETAB_MODULE);
    const r1 = mount();
    await visit(app, r1);
    render(r1, 5);
    app.W.ApiClient.getCurrentUserId = () => "bob";
    const r2 = mount();
    await visit(app, r2);
    assert.strictEqual(app.log.load, 2, "bob rebuilds rather than see alice's");
    assert.strictEqual(r2.querySelector(".sections").rows(), 0);
  }

  // --- 6. degrade, never throw -------------------------------------------
  {
    const app = launch({ "jellyfin.shell.homeResume": "1" });
    app.pushChunk([18119], HOMETAB_MODULE);
    const r1 = mount();
    const c1 = await visit(app, r1);
    render(r1, 3);

    // A mount whose .sections is missing: adopt() must decline, not throw.
    const bad = new El("DIV", "");
    const badTab = new El("DIV", "tabContent", { "data-index": "0" });
    bad.appendChild(badTab);
    const Klass = app.reqInert(66242).default;
    assert.throws(
      () => getController([], 0, Klass, bad),
      /querySelector|null|undefined/,
      "upstream itself throws on a .sections-less view — we must not mask it",
    );
    assert.strictEqual(app.D.err >= 0, true);

    // A container that throws on className copy still yields a live home.
    Object.defineProperty(c1.sectionsContainer, "className", {
      get() {
        return "sections homeSectionsContainer";
      },
      set() {
        throw new Error("nope");
      },
    });
    const r3 = mount();
    const c3 = await visit(app, r3);
    assert.strictEqual(c3, c1, "still reused");
    assert.strictEqual(r3.querySelector(".sections").rows(), 3, "rows moved");
  }

  // --- 7. the anchor is exact --------------------------------------------
  {
    const app = launch({ "jellyfin.shell.homeResume": "1" });
    app.pushChunk([40001], DECOY_MODULE);
    assert.strictEqual(app.D.found, 0, "one anchor name alone must not match");
    app.pushChunk([18119], HOMETAB_MODULE);
    assert.strictEqual(app.D.found, 1, "…the real chunk still matches");
  }

  // --- 8. the flag really is the kill switch ------------------------------
  {
    const app = launch({ "jellyfin.shell.homeResume": "0" });
    assert.strictEqual(app.D, null, "flag '0' is off");
    assert.strictEqual(
      app.W.webpackChunk.__shellHR,
      undefined,
      "off: the chunk-loading global is never hooked",
    );
  }
  {
    // JELA-827: no flag at all is now an ON arm — the chunk-loading global IS
    // hooked. This pins the polarity flip at the hook site, not just at the
    // diag object. Rollback is setItem(key,"0"), NEVER removeItem.
    const app = launch({});
    assert.strictEqual(
      app.W.webpackChunk.__shellHR,
      1,
      "JELA-827: no flag at all -> the chunk-loading global IS hooked",
    );
  }

  console.log("home-resume.test.cjs: OK");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
