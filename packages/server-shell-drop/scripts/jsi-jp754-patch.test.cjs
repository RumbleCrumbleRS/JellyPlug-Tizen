#!/usr/bin/env node
/*
 * jsi-jp754-patch.test.cjs — JELA-754 guard for jsi-jp754-patch.mjs.
 *
 * The patched snippet lives only on the live JS-Injector channel, so the edits
 * are anchored text replacements and anchor drift is the whole risk: an
 * upstream channel edit that moves an anchor must fail LOUDLY at patch time,
 * never silently ship "the pool is shared" when it is not.
 *
 * The fragments below are VERBATIM from the live `top10-badges` body (fetched
 * 2026-08-25), stitched into a reduced stand-in module with stubs for the DOM
 * half we do not touch. Upstream drift therefore shows up here as a failing
 * anchor, and every behavioural claim is checked by RUNNING the patched code.
 *
 *  1) FAIL-CLOSED: every anchor must match exactly once; zero or two throws,
 *     and the patch must not be applicable twice.
 *  2) ES5: the added code must survive Chromium 63 / V8 6.3.
 *  3) SHIPPED PATH: with both flags unset the two consumers issue TWO queries
 *     with the shipped `Fields`, exactly as today.
 *  4) SINGLE FLIGHT: with `jellyplug.top10.sharepool` the row and
 *     `rankedTopForType` share ONE query, in either order, and both callers
 *     get the identical ranked list.
 *  5) NO CROSS-TYPE ANSWERS: a Series badge must never be served from a Movie
 *     pool — neither via the config type nor via jp512's runtime override.
 *  6) REJECTION DE-REGISTERS: a failed pool is not replayed to the other
 *     consumer.
 *  7) LEAN FIELDS: `PrimaryImageAspectRatio` is dropped for a Movie chart and
 *     KEPT for a chart whose types can be wide (Video/MusicVideo/Episode).
 *  8) HOSTILE localStorage: a throwing store degrades to the shipped path.
 *  9) ENTRY SELECTION: the matcher must not catch the `detail-top10-rank`
 *     sibling entry.
 */
"use strict";

const assert = require("node:assert");
const path = require("node:path");
const vm = require("node:vm");

// --- verbatim from the live channel (2026-08-25) -----------------------------
const LIVE_WIDE =
  '/*jp671*/var jpWideTy671={Video:1,MusicVideo:1,Episode:1};function jpWide671(o){if(!o||!Object.prototype.hasOwnProperty.call(jpWideTy671,String(o.Type||"")))return!1;var a=o.PrimaryImageAspectRatio;return typeof a!="number"||!isFinite(a)||a<=0?!0:a>=1.15}/*jp671*/';

const LIVE_DEFAULTS_AND_QUERY =
  'var b={enabled:!0,title:"Top 10 Today",limit:10,includeItemTypes:"Movie",poolSize:40,candidateLimit:500,sortBy:"SortName",sortOrder:"Ascending",imageMaxWidth:300,rowKeywords:["top 10","top ten","trending","most watched","most played","popular"]},O="jellyplug-top10",N="jp-rank-badge",Te="jp-top10-section",Z="jp-top10-card",C="jp:top10:";function k(r){var l={},t;for(t in b)Object.prototype.hasOwnProperty.call(b,t)&&(l[t]=b[t]);if(r)for(t in r)Object.prototype.hasOwnProperty.call(r,t)&&r[t]!=null&&(l[t]=r[t]);var o=parseInt(l.limit,10);o>0||(o=b.limit),o>30&&(o=30),l.limit=o;var d=parseInt(l.poolSize,10);d>0||(d=b.poolSize),d<o&&(d=o),d>200&&(d=200),l.poolSize=d;var s=parseInt(l.candidateLimit,10);return s>0||(s=b.candidateLimit),s<d&&(s=d),s>5e3&&(s=5e3),l.candidateLimit=s,l}function B(r){return{SortBy:r.sortBy,SortOrder:r.sortOrder,Recursive:!0,IncludeItemTypes:r.includeItemTypes,Limit:r.candidateLimit,Fields:"PrimaryImageAspectRatio,CriticRating",EnableImageTypes:"Primary",ImageTypeLimit:1,EnableTotalRecordCount:!1}}';

const LIVE_RANKED_TOP =
  'function ie(r,l,t,o){var d=k(o);if(typeof d.fetch=="function"&&(!t||t===d.includeItemTypes)){var s;try{s=d.fetch(r,d)}catch(h){return E("config.fetch threw")}return s&&typeof s.then=="function"?s:E("config.fetch did not return a promise")}if(!r||typeof r.getItems!="function")return E("ApiClient.getItems unavailable");var m=k(o);t&&(m.includeItemTypes=t);var y=null;try{y=r.getCurrentUserId?r.getCurrentUserId():null}catch(h){y=null}return y?jpW465(r.getItems(y,B(m))).then(function(h){var I=w(h,m.candidateLimit);return z(I,l,m.poolSize,m.limit)}):E("no session yet (pre-auth); skipping fetch")}';

const LIVE_ROW_FETCH =
  'function Ue(e,a){if(typeof l.fetch=="function")return l.fetch(e,l);if(!e||typeof e.getItems!="function")return ge("ApiClient.getItems unavailable");var n=null;try{n=e.getCurrentUserId?e.getCurrentUserId():null}catch(u){n=null}if(!n)return ge("no session yet (pre-auth); skipping fetch");if(!g.Promise)return jpW465(e.getItems(n,B(l))).then(function(u){var i=w(u,l.candidateLimit);return z(i,a,l.poolSize,l.limit)});return new g.Promise(function(n0,n1){jpTy512(function(T0){var q0=B(l);T0&&(q0.IncludeItemTypes=T0);var p0=null;try{p0=jpW465(e.getItems(n,q0))}catch(e2){}p0&&typeof p0.then=="function"?p0.then(function(u){try{n0(z(w(u,l.candidateLimit),a,l.poolSize,l.limit))}catch(e3){n1(e3)}},n1):n1("no item query path (jp512)")})})}';

// The live text that follows Ue(); the "rowfetch:tail" anchor straddles it.
const LIVE_AFTER_ROW_FETCH = "/*jp512*/var T=null,pe=null,jpEmpty=null,";

// Stubs for the halves the patch does not touch. `z` returns a tagged object so
// the tests can prove both consumers received the SAME computed list.
const STANDIN_STUBS =
  "function jpW465(p){return p}" +
  'function E(r){return g.Promise.reject(new Error(r))}' +
  "function ge(e){return g.Promise.reject(new Error(e))}" +
  "function w(r,l){var t=r&&r.Items?r.Items:[];return t.slice(0,l)}" +
  "function z(r,l,t,o){var i=[],x;for(x=0;x<r.length;x++)i.push(r[x].Id);" +
  "return{day:l,pool:t,limit:o,ids:i.join(',')}}" +
  'var jpTyOverride="";function jpTy512(cb){cb(jpTyOverride)}';

/** The reduced stand-in module, assembled so every anchor appears verbatim. */
function standInSource() {
  return (
    "(function(g){'use strict';" +
    STANDIN_STUBS +
    LIVE_WIDE +
    LIVE_DEFAULTS_AND_QUERY +
    LIVE_RANKED_TOP +
    "function mkRow(l){" +
    LIVE_ROW_FETCH +
    LIVE_AFTER_ROW_FETCH +
    "jpUnused754=0;return Ue}" +
    "g.__jp754={ie:ie,mkRow:mkRow,B:B,k:k," +
    'setTy:function(t){jpTyOverride=t}};' +
    "})(this)"
  );
}

/** A sandbox that behaves like the M63 window the snippet runs in. */
function makeSandbox(store) {
  const calls = [];
  const sandbox = {
    Promise,
    calls,
    localStorage:
      store === "throws"
        ? {
            getItem() {
              throw new Error("SecurityError");
            },
          }
        : {
            getItem(k) {
              return Object.prototype.hasOwnProperty.call(store, k)
                ? store[k]
                : null;
            },
          },
  };
  sandbox.window = sandbox;
  return sandbox;
}

/** An ApiClient stand-in that records every query it is handed. */
function makeClient(sandbox, opts) {
  const o = opts || {};
  return {
    getCurrentUserId() {
      return o.uid || "u1";
    },
    getItems(uid, query) {
      sandbox.calls.push({ uid, query });
      if (o.reject) return Promise.reject(new Error("boom"));
      return Promise.resolve({
        Items: [
          { Id: "a", Type: "Movie" },
          { Id: "b", Type: "Movie" },
        ],
      });
    },
  };
}

function load(mod, store, clientOpts) {
  const sandbox = makeSandbox(store);
  const src = mod.applyPatch(standInSource(), mod.PATCH_SHARE);
  mod.assertEs5Additions(src);
  vm.runInNewContext(src, sandbox, { filename: "top10-badges.standin.js" });
  return { sandbox, api: sandbox.__jp754, client: makeClient(sandbox, clientOpts) };
}

const DAY = "2026-08-25";

let mod;
before();
async function before() {
  mod = await import(path.join(__dirname, "jsi-jp754-patch.mjs"));
  await run();
}

async function run() {
  const {
    PATCH_SHARE,
    PATCHES,
    applyPatch,
    assertEs5Additions,
    patchConfig,
    SHARE_FLAG,
    FIELDS_FLAG,
    SHIPPED_FIELDS,
    LEAN_FIELDS,
  } = mod;

  // --- 1) fail-closed anchors ------------------------------------------------
  const clean = standInSource();
  const patched = applyPatch(clean, PATCH_SHARE);
  assert.ok(patched.length > clean.length, "patch must add code");
  for (const e of PATCH_SHARE.edits) {
    assert.strictEqual(
      clean.split(e.from).length - 1,
      1,
      `anchor "${e.what}" must appear exactly once in the live shape`,
    );
  }
  assert.throws(
    () => applyPatch(patched, PATCH_SHARE),
    /matched 0 times/,
    "re-applying the patch must throw, not double-inject",
  );
  assert.throws(
    () => applyPatch(clean.replace("Limit:r.candidateLimit", "Limit:r.cl"), PATCH_SHARE),
    /anchor "fields" matched 0 times/,
    "anchor drift in B() must fail loudly",
  );
  new vm.Script(patched, { filename: "patched.js" });

  // --- 2) ES5 ---------------------------------------------------------------
  assertEs5Additions(patched);
  assert.throws(
    () => assertEs5Additions(patched.replace("var jpFlight754=null;", "let jpFlight754=null;")),
    /non-ES5/,
    "a let inside our markers must be caught",
  );

  // --- 3) shipped path: two queries, shipped Fields --------------------------
  {
    const { sandbox, api, client } = load(mod, {});
    const cfg = api.k(null);
    await api.mkRow(cfg)(client, DAY);
    await api.ie(client, DAY, "Movie", null);
    assert.strictEqual(sandbox.calls.length, 2, "flags off must keep both queries");
    for (const c of sandbox.calls) {
      assert.strictEqual(c.query.Fields, SHIPPED_FIELDS);
      assert.strictEqual(c.query.Limit, 500);
      assert.strictEqual(c.query.IncludeItemTypes, "Movie");
    }
  }

  // --- 4) single flight, both orders ----------------------------------------
  {
    const { sandbox, api, client } = load(mod, { [SHARE_FLAG]: "1" });
    const rowResult = await api.mkRow(api.k(null))(client, DAY);
    const badgeResult = await api.ie(client, DAY, "Movie", null);
    assert.strictEqual(sandbox.calls.length, 1, "row then badge must share one query");
    assert.deepStrictEqual(badgeResult, rowResult, "both callers get the same list");
  }
  {
    const { sandbox, api, client } = load(mod, { [SHARE_FLAG]: "1" });
    const badgeResult = await api.ie(client, DAY, "Movie", null);
    const rowResult = await api.mkRow(api.k(null))(client, DAY);
    assert.strictEqual(sandbox.calls.length, 1, "badge then row must share one query");
    assert.deepStrictEqual(rowResult, badgeResult);
  }
  // a different day must not be answered from yesterday's flight
  {
    const { sandbox, api, client } = load(mod, { [SHARE_FLAG]: "1" });
    await api.mkRow(api.k(null))(client, DAY);
    await api.ie(client, "2026-08-26", "Movie", null);
    assert.strictEqual(sandbox.calls.length, 2, "a new dayStamp must refetch");
  }
  // a different user must not be answered from another user's flight
  {
    const { sandbox, api } = load(mod, { [SHARE_FLAG]: "1" });
    await api.mkRow(api.k(null))(makeClient(sandbox, { uid: "u1" }), DAY);
    await api.ie(makeClient(sandbox, { uid: "u2" }), DAY, "Movie", null);
    assert.strictEqual(sandbox.calls.length, 2, "a new user must refetch");
  }

  // --- 5) no cross-type answers ---------------------------------------------
  {
    const { sandbox, api, client } = load(mod, { [SHARE_FLAG]: "1" });
    await api.mkRow(api.k(null))(client, DAY); // Movie pool
    await api.ie(client, DAY, "Series", { includeItemTypes: "Movie,Series" });
    assert.strictEqual(sandbox.calls.length, 2, "a Series badge must not read a Movie pool");
    assert.strictEqual(sandbox.calls[1].query.IncludeItemTypes, "Series");
  }
  {
    // jp512 may override the ROW's type set at runtime; the key must follow it.
    const { sandbox, api, client } = load(mod, { [SHARE_FLAG]: "1" });
    api.setTy("Series");
    await api.mkRow(api.k(null))(client, DAY);
    assert.strictEqual(sandbox.calls[0].query.IncludeItemTypes, "Series");
    await api.ie(client, DAY, "Movie", null);
    assert.strictEqual(
      sandbox.calls.length,
      2,
      "a jp512-overridden row pool must not answer a Movie badge",
    );
  }

  // --- 6) a rejected pool de-registers --------------------------------------
  {
    const { sandbox, api, client } = load(mod, { [SHARE_FLAG]: "1" }, { reject: true });
    await api.mkRow(api.k(null))(client, DAY).then(
      () => assert.fail("expected rejection"),
      () => {},
    );
    const second = makeClient(sandbox, {});
    await api.ie(second, DAY, "Movie", null);
    assert.strictEqual(sandbox.calls.length, 2, "a failed pool must not be replayed");
  }

  // --- 7) lean Fields --------------------------------------------------------
  {
    const { sandbox, api, client } = load(mod, { [FIELDS_FLAG]: "1" });
    await api.mkRow(api.k(null))(client, DAY);
    assert.strictEqual(sandbox.calls[0].query.Fields, LEAN_FIELDS, "Movie chart drops the ratio");
    assert.strictEqual(api.B(api.k({ includeItemTypes: "Episode" })).Fields, SHIPPED_FIELDS);
    assert.strictEqual(api.B(api.k({ includeItemTypes: "Movie, Episode" })).Fields, SHIPPED_FIELDS);
    assert.strictEqual(api.B(api.k({ includeItemTypes: "MusicVideo" })).Fields, SHIPPED_FIELDS);
    assert.strictEqual(api.B(api.k({ includeItemTypes: "Movie,Series" })).Fields, LEAN_FIELDS);
  }
  {
    // jp512's runtime override must re-decide Fields, not inherit B()'s answer.
    const { sandbox, api, client } = load(mod, { [FIELDS_FLAG]: "1" });
    api.setTy("Episode");
    await api.mkRow(api.k(null))(client, DAY);
    assert.strictEqual(sandbox.calls[0].query.IncludeItemTypes, "Episode");
    assert.strictEqual(
      sandbox.calls[0].query.Fields,
      SHIPPED_FIELDS,
      "an Episode pool still needs PrimaryImageAspectRatio for jp671 wide",
    );
  }
  {
    const { api } = load(mod, {});
    assert.strictEqual(api.B(api.k(null)).Fields, SHIPPED_FIELDS, "flag off keeps the shipped query");
  }

  // --- 8) hostile localStorage ----------------------------------------------
  {
    const { sandbox, api, client } = load(mod, "throws");
    await api.mkRow(api.k(null))(client, DAY);
    await api.ie(client, DAY, "Movie", null);
    assert.strictEqual(sandbox.calls.length, 2, "a throwing store degrades to shipped");
    assert.strictEqual(sandbox.calls[0].query.Fields, SHIPPED_FIELDS);
  }

  // --- 9) entry selection ----------------------------------------------------
  {
    const cfg = {
      CustomJavaScripts: [
        { Name: "JellyPlug — detail-top10-rank", Script: "void 0;" },
        { Name: "JellyPlug — top10-badges", Script: standInSource() },
      ],
    };
    const report = patchConfig(cfg);
    assert.strictEqual(report.length, PATCHES.length);
    assert.strictEqual(report[0].name, "JellyPlug — top10-badges");
    assert.ok(report[0].delta > 0);
    assert.strictEqual(cfg.CustomJavaScripts[0].Script, "void 0;", "sibling entry untouched");
  }
  assert.throws(
    () => patchConfig({ CustomJavaScripts: [{ Name: "JellyPlug — detail-top10-rank" }] }),
    /matched 0 channel entries/,
  );

  console.log("jsi-jp754-patch.test.cjs: all checks passed");
}
