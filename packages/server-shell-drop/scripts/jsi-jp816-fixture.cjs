#!/usr/bin/env node
/*
 * jsi-jp816-fixture.cjs — the `genre-rows` channel entry, reduced to the region
 * the jp816/jp828 patches touch, plus a boot harness for it.
 *
 * Extracted verbatim from jsi-jp816-patch.test.cjs (JELA-816) when JELA-828
 * needed the same fixture to prove the fleet flip: `F` (row selection), `G`
 * (the settle gate), `jpRst320` (the user-switch reset) and the fan-out block
 * inside `Z` are copied VERBATIM from the live body, so an upstream change to
 * any of them shows up as a failing anchor rather than as a silent no-op
 * deploy. Everything around them (the ApiClient, the mount, the util
 * namespace) is a reduced stand-in.
 *
 * ONE copy of the live code, two guards: if this drifts from the channel, both
 * jp816 and jp828 fail together, which is the point.
 */
"use strict";

const assert = require("node:assert");
const vm = require("node:vm");

// --- verbatim from the live channel -----------------------------------------
// Row selection: walks candidates IN ORDER, keeps the first `f` that came back
// with at least M items and are not already covered by a native section.
const LIVE_F =
  "function F(n,r,s,f){for(var o=[],m=0;m<n.length&&o.length<f;m++){var v=n[m],C=r[I(v)];!C||C.length<M||T(v.genre,s)||o.push({cand:v,items:C,rank:String(_+o.length)})}return o}";

const LIVE_I =
  'function I(n){var r=n&&n.genre!=null?String(n.genre):"";return r.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"")}';

// The settle gate: shipped behaviour is "wait for ALL candidates, then select".
const LIVE_G =
  'function G(e){A||x<f.length||(A=F(f,L,Q(),o),n.log("genre-rows: selected "+A.length+" of "+f.length+" genres."),V(e),jpIdle())}';

const LIVE_LATCHES = "var $=!1,jpBz=!1,jpId=!1,jpFs=null,jpUid=null;";

const LIVE_RESET =
  'function jpRst320(){n.log("genre-rows: user changed \\u2014 reset fetch latch."),$=!1,L={},w={},p={},A=null,x=0,jpFs&&((d.clearTimeout||clearTimeout)(jpFs),jpFs=null),jpBz=!1,jpId=!1;var e=n.qsa("."+R),t;for(t=0;t<e.length;t++)e[t]&&e[t].parentNode&&e[t].parentNode.removeChild(e[t])}';

// The fan-out. `t` is the ApiClient, `i` the user id, `u` one candidate.
const LIVE_Z =
  'function Z(){var e=d.location;if(!(e&&!B(e.hash))){var t=S();if(!(!t||typeof t.getItems!="function")){var i=n.safe("genre-rows.uid",function(){return typeof t.getCurrentUserId=="function"?t.getCurrentUserId():null},null);if(i){if(jpUid!==i&&(jpUid&&jpRst320(),jpUid=i),!$){$=!0;jpBusy();for(var a=0;a<f.length;a++)(function(u){var l=I(u),c=me(t,i,u);if(!c){L[l]=null,x++,G(t);return}c.then(function(h){if(i!==jpUid)return;L[l]=/*jp655*/jpFlt655(/*jp655*/J(h)/*jp655*/,u)/*jp655*/,x++,G(t)},function(h){if(i!==jpUid)return;L[l]=null,x++,n.warn(\'genre-rows: fetch failed for "\'+(u&&u.genre)+\'": \'+h),G(t)})})(f[a])}V(t),ve()}}}}';

/*
 * The live channel already carries jp815 (row view gate), which wraps this same
 * fan-out in a deferred thunk: it inserts between `$=!0;` and `jpBusy()`, and
 * appends after the loop's `(f[a])`. Reproduced here VERBATIM from the live
 * `genre-rows` body so jp816's anchors are proven against the shape they will
 * actually be applied to. With no `rowViewGate` on the namespace the thunk runs
 * inline, which is exactly what the shipped gate does when it is disarmed.
 */
function withJp815(z) {
  const open = "!$){$=!0;jpBusy();";
  const close = "(f[a])}V(t),ve()";
  assert.strictEqual(z.split(open).length - 1, 1, "jp815 open anchor");
  assert.strictEqual(z.split(close).length - 1, 1, "jp815 close anchor");
  return z
    .replace(
      open,
      "!$){$=!0;/*jp815*/var jpG815=(d.JellyPlug&&d.JellyPlug.rowViewGate)||null;" +
        "var jpF815=function(){if(i!==jpUid)return;/*jp815*/jpBusy();",
    )
    .replace(
      close,
      '(f[a])/*jp815*/};if(jpG815&&jpG815.on())jpG815.hold("genre-rows",jpF815);' +
        "else jpF815();/*jp815*/}V(t),ve()",
    );
}

/** The shipped candidate list and caps (`U`, `M`, `O`, `_` in the live body). */
const CANDIDATES = [
  { genre: "Action", title: "Action" },
  { genre: "Comedy", title: "Comedy" },
  { genre: "Drama", title: "Critically Acclaimed Dramas" },
  { genre: "Adventure", title: "Adventure" },
  { genre: "Horror", title: "Trending in Horror" },
  { genre: "Animation", title: "Animation" },
  { genre: "Science Fiction", title: "Sci-Fi" },
  { genre: "Thriller", title: "Thrillers" },
  { genre: "Romance", title: "Romance" },
  { genre: "Documentary", title: "Award-Winning Documentaries" },
  { genre: "Family", title: "Family" },
  { genre: "Crime", title: "Crime" },
  { genre: "Fantasy", title: "Fantasy" },
  { genre: "Mystery", title: "Mystery" },
];
const MIN_ITEMS = 6;
const MAX_ROWS = 8;

/**
 * The live snippet reduced to the region this patch touches: the verbatim
 * selection/gate/reset/fan-out above, plus stand-ins for the ApiClient call
 * (`me`), the mount (`V`), the coverage scan (`Q`) and the response mapper
 * (`J`). Test hooks hang off `d.__t`.
 */
function moduleSource(opts) {
  const z = opts && opts.jp815 ? withJp815(LIVE_Z) : LIVE_Z;
  return (
    '(function(d){"use strict";' +
    "var _=51,M=" +
    MIN_ITEMS +
    ',R="jp-genre-row";' +
    "var f=d.__cfg.candidates,o=d.__cfg.maxRows;" +
    "var L={},x=0,A=null,w={},p={};" +
    LIVE_I +
    "function T(g,cov){if(!g||!cov||!cov.length)return!1;" +
    "for(var q=0;q<cov.length;q++)if(String(cov[q]).toLowerCase()===String(g).toLowerCase())return!0;return!1}" +
    LIVE_F +
    "function Q(){return d.__cfg.covered||[]}" +
    "function B(){return!0}function S(){return d.ApiClient}function ve(){}" +
    "function J(h){var r=h&&h.Items?h.Items:[],s=[],q;" +
    "for(q=0;q<r.length;q++)s.push({id:String(r[q].Id)});return s}" +
    "function jpFlt655(a){return a}" +
    "function me(e,uid,u){return e.getItems(uid,{Genres:String(u.genre)})}" +
    "function V(e){if(!A)return;for(var q=0;q<A.length;q++)d.__mounted.push(A[q].cand.title)}" +
    "function jpBusy(){}function jpIdle(){d.__idle++}" +
    LIVE_G +
    LIVE_LATCHES +
    LIVE_RESET +
    z +
    "d.__t={run:Z};" +
    "})(this)"
  );
}

/**
 * Boot one body against a fake ApiClient.
 *
 * `opts.thin` genres answer with fewer than MIN_ITEMS items; `opts.reject`
 * genres reject; `opts.nopromise` genres return no promise at all.
 *
 * `opts.flag` / `opts.kill` seed the two keys with "1". `opts.store` seeds
 * arbitrary key/value pairs and is applied LAST, which is what JELA-828 needs:
 * once the read site is opt-OUT the interesting arms are an ABSENT key and an
 * explicit "0", neither of which a boolean can express. `opts.throwLs` makes
 * every localStorage read throw — the third arm the read site distinguishes.
 */
async function boot(body, opts) {
  const o = opts || {};
  const store = {};
  if (o.flag) store["jellyplug.rows.genreLazy"] = "1";
  if (o.kill) store["jellyplug.rows.genreLazyDisabled"] = "1";
  Object.assign(store, o.store || {});
  const asked = [];
  const mounted = [];
  const thin = new Set(o.thin || []);
  const reject = new Set(o.reject || []);
  const nopromise = new Set(o.nopromise || []);
  let uid = o.uid || "u1";

  const sandbox = {
    __cfg: {
      candidates: o.candidates || CANDIDATES,
      maxRows: typeof o.maxRows === "number" ? o.maxRows : MAX_ROWS,
      covered: o.covered || [],
    },
    __mounted: mounted,
    __idle: 0,
    location: { hash: "#/home" },
    JellyPlug: {},
    Promise,
    setTimeout,
    clearTimeout,
    console,
    localStorage: {
      getItem: (k) => {
        if (o.throwLs) throw new Error("localStorage unavailable");
        return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null;
      },
    },
    ApiClient: {
      getCurrentUserId: () => uid,
      getItems: (u, q) => {
        const g = String(q.Genres || "");
        asked.push(g);
        if (nopromise.has(g)) return null;
        if (reject.has(g)) {
          return new Promise((_res, rej) => setTimeout(() => rej("boom"), 1));
        }
        const n = thin.has(g) ? 2 : 20;
        const items = [];
        for (let i = 0; i < n; i++) items.push({ Id: g + ":" + i });
        return new Promise((res) => setTimeout(() => res({ Items: items }), 1));
      },
    },
  };
  sandbox.n = null;
  const ctx = vm.createContext(sandbox);
  // The util namespace the live snippet is handed by the shim.
  ctx.n = {
    log() {},
    warn() {},
    safe(name, fn, dflt) {
      try {
        return fn();
      } catch (e) {
        return dflt;
      }
    },
    qsa: () => [],
    qs: () => null,
  };
  new vm.Script("var n=this.n;" + body, {
    filename: "genre-rows.test.js",
  }).runInContext(ctx);

  const api = {
    run: () => ctx.__t.run(),
    setUser: (u) => {
      uid = u;
    },
    async settle() {
      for (let i = 0; i < 60; i++) await new Promise((r) => setTimeout(r, 2));
    },
    asked,
    mounted,
  };
  return api;
}

module.exports = {
  LIVE_F,
  LIVE_I,
  LIVE_G,
  LIVE_LATCHES,
  LIVE_RESET,
  LIVE_Z,
  withJp815,
  CANDIDATES,
  MIN_ITEMS,
  MAX_ROWS,
  moduleSource,
  boot,
};
