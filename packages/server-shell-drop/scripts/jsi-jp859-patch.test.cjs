#!/usr/bin/env node
/*
 * jsi-jp859-patch.test.cjs — JELA-859 guard for jsi-jp859-patch.mjs.
 *
 * The patched snippet lives only on the live JS-Injector channel, so the edits
 * are anchored text replacements and anchor drift is the whole risk: an
 * upstream channel edit that moves an anchor must fail LOUDLY at patch time,
 * never silently ship "the pool is lean" when it is not.
 *
 * The fragments below are VERBATIM from the live `top10-badges` body (fetched
 * 2026-09-04, bundle sha256 d7b6a5b3…), stitched into a reduced stand-in module
 * with stubs only for the DOM half we do not touch. The RANKING is the real
 * shipped code — `w`, `Ce`, `ee`, `te`, `Ae`, `ne`, `le`, `z` are all verbatim
 * — so "the selection does not move" is checked against the implementation
 * that actually computes it, not against a model of it.
 *
 *  1) FAIL-CLOSED: every anchor must match exactly once; zero or two throws,
 *     and the patch must not be applicable twice.
 *  2) ES5 + balanced markers: the added code must survive Chromium 63 / V8 6.3.
 *  3) SHIPPED PATH: with the flag unset both consumers issue ONE query each,
 *     carrying neither EnableImages nor EnableUserData — exactly as today.
 *  4) SPLIT: with `jellyplug.top10.idsplit` the candidate query carries
 *     `EnableImages=false&EnableUserData=false` and is followed by exactly one
 *     `?Ids=` hydrate of the survivors.
 *  5) SELECTION IS UNMOVED (AC2): over 400 consecutive dayStamps the ids and
 *     their order are identical between the arms, on a library whose lean rows
 *     carry no ImageTags/UserData at all.
 *  6) DISPLAY FIELDS SURVIVE (AC3): imageTag / us / serverId / name / wide of
 *     every rendered item are identical to the shipped arm's.
 *  7) HYDRATE SHAPE: it asks for the survivors' ids only, with the jp754
 *     Fields decision applied to the EFFECTIVE type set.
 *  8) FAILURE PROPAGATES: a rejected hydrate rejects the row, so jp473's retry
 *     latch sees it and the day cache is never written with null image tags.
 *  9) PARTIAL HYDRATE: an id the server drops keeps its lean values.
 * 10) INTEROP: the jp672 widening path and jp512's type override still reach
 *     the hydrate with the effective type; the jp754 single-flight still
 *     collapses the pair.
 * 11) HOSTILE localStorage: a throwing store degrades to the shipped path.
 * 12) ENTRY SELECTION: the matcher must not catch the `detail-top10-rank`
 *     sibling entry.
 */
"use strict";

const assert = require("node:assert");
const path = require("node:path");
const vm = require("node:vm");

// --- verbatim from the live channel (2026-09-04) -----------------------------
const LIVE_US622 =
  'function jpUS622(x){var j=g.JellyPlug;return j&&typeof j.pickUserState=="function"?j.pickUserState(x):null}function jpUSM622(dd,hh,oo){var j=g.JellyPlug;oo&&j&&typeof j.mountUserState=="function"&&j.mountUserState(dd,hh,oo)}function jpUSK622(o){return o?(o.p?"p":"")+"|"+(o.c||0)+"|"+(o.pc||0):""}';

const LIVE_HELPERS =
  '/*jp622*//*jp671*/var jpWideTy671={Video:1,MusicVideo:1,Episode:1};function jpWide671(o){if(!o||!Object.prototype.hasOwnProperty.call(jpWideTy671,String(o.Type||"")))return!1;var a=o.PrimaryImageAspectRatio;return typeof a!="number"||!isFinite(a)||a<=0?!0:a>=1.15}/*jp671*//*jp754*//*jp838*/function jpOn754(f){try{var l8=g.localStorage;return!!(l8&&l8.getItem(f+"Disabled")!=="1"&&l8.getItem(f)!=="0")}catch(e){return!1}}function jpFlds754(ty){if(!jpOn754("jellyplug.top10.leanfields"))return"PrimaryImageAspectRatio,CriticRating";for(var a=String(ty==null?"":ty).split(","),i=0;i<a.length;i++)if(Object.prototype.hasOwnProperty.call(jpWideTy671,a[i].replace(/^\\s+|\\s+$/g,"")))return"PrimaryImageAspectRatio,CriticRating";return"CriticRating"}var jpFlight754=null;function jpKey754(d,u,t){return String(d)+"|"+String(u==null?"":u)+"|"+String(t==null?"":t)}function jpGet754(d,u,t){if(!jpOn754("jellyplug.top10.sharepool"))return null;var s=jpFlight754;return s&&s.k===jpKey754(d,u,t)&&s.b&&s.b.p?s.b.p:null}function jpPut754(d,u,t,b){if(!jpOn754("jellyplug.top10.sharepool"))return;jpFlight754={k:jpKey754(d,u,t),b:b}}function jpDrop754(d,u,t){var s=jpFlight754;s&&s.k===jpKey754(d,u,t)&&(jpFlight754=null)}';

const LIVE_DEFAULTS =
  '/*jp754*/var b={enabled:!0,title:"Top 10 Today",limit:10,includeItemTypes:"Movie",poolSize:40,candidateLimit:500,sortBy:"SortName",sortOrder:"Ascending",imageMaxWidth:300,rowKeywords:["top 10","top ten","trending","most watched","most played","popular"]},O="jellyplug-top10",N="jp-rank-badge",Te="jp-top10-section",Z="jp-top10-card",C="jp:top10:";/*jp672*/var jpTtl672="From the Archive",jpCap672=5e3,jpSigP672="jp:t10sig:",jpSig672=null;function jpNoSig672(T){var s=String(T==null?"":T);return!!s&&(","+s+",").indexOf(",Movie,")===-1}function jpLs672(){try{return g.localStorage||null}catch(e){return null}}function jpWiden672(){var s=jpLs672();if(s)try{if(s.getItem("jellyplug.top10.widen672")==="0")return!1}catch(e){}return!0}function jpSigRd672(u){if(jpSig672!==null)return jpSig672;if(!u)return null;var s=jpLs672();if(s)try{var v=s.getItem(jpSigP672+String(u));if(v==="1")return 1;if(v==="0")return 0}catch(e){}return null}function jpSigWr672(u,v){jpSig672=v?1:0;if(!u)return;var s=jpLs672();if(s)try{s.setItem(jpSigP672+String(u),v?"1":"0")}catch(e){}}/*jp672*/function $(r){return r==null?"":String(r).replace(/\\s+/g," ").trim().toLowerCase()}function k(r){var l={},t;for(t in b)Object.prototype.hasOwnProperty.call(b,t)&&(l[t]=b[t]);if(r)for(t in r)Object.prototype.hasOwnProperty.call(r,t)&&r[t]!=null&&(l[t]=r[t]);var o=parseInt(l.limit,10);o>0||(o=b.limit),o>30&&(o=30),l.limit=o;var d=parseInt(l.poolSize,10);d>0||(d=b.poolSize),d<o&&(d=o),d>200&&(d=200),l.poolSize=d;var s=parseInt(l.candidateLimit,10);return s>0||(s=b.candidateLimit),s<d&&(s=d),s>5e3&&(s=5e3),l.candidateLimit=s,l}function B(r){return{SortBy:r.sortBy,SortOrder:r.sortOrder,Recursive:!0,IncludeItemTypes:r.includeItemTypes,Limit:r.candidateLimit,/*jp754*/Fields:jpFlds754(r.includeItemTypes),/*jp754*/EnableImageTypes:"Primary",ImageTypeLimit:1,EnableTotalRecordCount:!1}}function w(r,l){var t=[];r&&(Object.prototype.toString.call(r)==="[object Array]"?t=r:r.Items&&Object.prototype.toString.call(r.Items)==="[object Array]"&&(t=r.Items));for(var o=[],d=0;d<t.length&&o.length<l;d++){var s=t[d];if(s){var m=s.Id!=null?String(s.Id):s.id!=null?String(s.id):"";m&&o.push({id:m,name:s.Name!=null?String(s.Name):s.name!=null?String(s.name):"",serverId:s.ServerId!=null?String(s.ServerId):null,imageTag:Ce(s),critic:ee(s),us:jpUS622(s)/*jp671*/,wide:jpWide671(s)/*jp671*/})}}return o}';

const LIVE_CE_EE =
  'function Ce(r){return r&&r.ImageTags&&r.ImageTags.Primary!=null?String(r.ImageTags.Primary):null}function ee(r){if(!r)return null;var l=r.CriticRating!=null?r.CriticRating:r.criticRating!=null?r.criticRating:r.critic!=null?r.critic:null;if(l==null)return null;var t=Number(l);return typeof t=="number"&&isFinite(t)?t:null}function re(r){return String(r)}';

const LIVE_RANK =
  'function te(r){for(var l=String(r==null?"":r),t=2166136261,o=0;o<l.length;o++)t^=l.charCodeAt(o),t+=(t<<1)+(t<<4)+(t<<7)+(t<<8)+(t<<24),t=t>>>0;return t>>>0}function Ae(r){var l=r>>>0;return function(){l=l+1831565813>>>0;var t=l;return t=Math.imul(t^t>>>15,t|1),t^=t+Math.imul(t^t>>>7,t|61),((t^t>>>14)>>>0)/4294967296}}function ne(r,l){for(var t=(r||[]).slice(),o=Ae(l>>>0),d=t.length-1;d>0;d--){var s=Math.floor(o()*(d+1)),m=t[d];t[d]=t[s],t[s]=m}return t}function le(r,l){for(var t=r||[],o=[],d=0;d<t.length;d++){var s=t[d]&&typeof t[d].critic=="number"&&isFinite(t[d].critic)?t[d].critic:null;o.push({item:t[d],idx:d,score:s})}o.sort(function(I,S){return I.score==null&&S.score==null?I.idx-S.idx:I.score==null?1:S.score==null?-1:S.score!==I.score?S.score-I.score:I.idx-S.idx});for(var m=l>0?l:t.length,y=[],h=0;h<o.length&&y.length<m;h++)y.push(o[h].item);return y}function z(r,l,t,o){var d=r||[],s=t>0?t:d.length,m=ne(d,te(l)).slice(0,s);return le(m,o)}';

const LIVE_IE =
  'function ie(r,l,t,o){var d=k(o);if(typeof d.fetch=="function"&&(!t||t===d.includeItemTypes)){var s;try{s=d.fetch(r,d)}catch(h){return E("config.fetch threw")}return s&&typeof s.then=="function"?s:E("config.fetch did not return a promise")}if(!r||typeof r.getItems!="function")return E("ApiClient.getItems unavailable");var m=k(o);t&&(m.includeItemTypes=t);var y=null;try{y=r.getCurrentUserId?r.getCurrentUserId():null}catch(h){y=null}return y?/*jp754*/function(){var jpT754=m.includeItemTypes,jpH754=jpGet754(l,y,jpT754);if(jpH754)return jpH754;var jpB754={p:null};jpPut754(l,y,jpT754,jpB754);var jpP754=jpW465(r.getItems(y,B(m))).then(function(h){var I=w(h,m.candidateLimit);return z(I,l,m.poolSize,m.limit)});jpB754.p=jpP754;try{jpP754["catch"](function(){jpDrop754(l,y,jpT754)})}catch(e754){}return jpP754}()/*jp754*/:E("no session yet (pre-auth); skipping fetch")}';

const LIVE_UE =
  'function Ue(e,a){if(typeof l.fetch=="function")return l.fetch(e,l);if(!e||typeof e.getItems!="function")return ge("ApiClient.getItems unavailable");var n=null;try{n=e.getCurrentUserId?e.getCurrentUserId():null}catch(u){n=null}if(!n)return ge("no session yet (pre-auth); skipping fetch");if(!g.Promise)return jpW465(e.getItems(n,B(l))).then(function(u){var i=w(u,l.candidateLimit);return z(i,a,l.poolSize,l.limit)});/*jp754*/var jpB754={p:null},jpR754=null;var jpP754=/*jp754*/new g.Promise(function(n0,n1){jpTy512(function(T0){var q0=B(l);T0&&(q0.IncludeItemTypes=T0);/*jp754*/q0.Fields=jpFlds754(q0.IncludeItemTypes);jpR754=[a,n,q0.IncludeItemTypes];/*jp672*/var jpN672=jpNoSig672(q0.IncludeItemTypes);jpSigWr672(n,jpN672);jpN672&&jpWiden672()&&q0.Limit<jpCap672&&(q0.Limit=jpCap672);/*jp672*/var jpH754=jpGet754(a,n,q0.IncludeItemTypes);if(jpH754){jpH754.then(n0,n1);return}jpPut754(a,n,q0.IncludeItemTypes,jpB754);/*jp754*/var p0=null;try{p0=jpW465(e.getItems(n,q0))}catch(e2){}p0&&typeof p0.then=="function"?p0.then(function(u){try{n0(z(w(u,/*jp672*/jpN672&&q0.Limit>l.candidateLimit?q0.Limit:/*jp672*/l.candidateLimit),a,l.poolSize,l.limit))}catch(e3){n1(e3)}},n1):n1("no item query path (jp512)")})})/*jp754*/;jpB754.p=jpP754;try{jpP754["catch"](function(){jpR754&&jpDrop754(jpR754[0],jpR754[1],jpR754[2])})}catch(e754){}return jpP754/*jp754*/}';

// Stubs for the halves the patch does not touch. The ranking above is real.
const STANDIN_STUBS =
  "function jpW465(p){return p}" +
  "function E(r){return g.Promise.reject(new Error(r))}" +
  "function ge(e){return g.Promise.reject(new Error(e))}" +
  'var jpTyOverride="";function jpTy512(cb){cb(jpTyOverride)}';

// The live text that follows Ue(); kept so the stand-in ends where live does.
const LIVE_AFTER_ROW_FETCH =
  "/*jp512*/var T=null,pe=null,jpEmpty=null,jpUnused859=0;";

/** The reduced stand-in module, assembled so every anchor appears verbatim. */
function standInSource() {
  return (
    "(function(g){'use strict';" +
    STANDIN_STUBS +
    LIVE_US622 +
    LIVE_HELPERS +
    LIVE_DEFAULTS +
    LIVE_CE_EE +
    LIVE_RANK +
    LIVE_IE +
    "function mkRow(l){" +
    LIVE_UE +
    LIVE_AFTER_ROW_FETCH +
    "return Ue}" +
    "g.__jp859={ie:ie,mkRow:mkRow,B:B,k:k,w:w,z:z," +
    "setTy:function(t){jpTyOverride=t}};" +
    "})(this)"
  );
}

// --- a synthetic library with the shape the real one has --------------------
// 349 Movies, matching prod's TotalRecordCount, sorted by Name ascending like
// `SortBy=SortName` returns them. Ratings are sparse and repeat, so `le()`'s
// null-last + stable-index tie-break is genuinely exercised.
function makeLibrary(n) {
  const lib = [];
  for (let i = 0; i < n; i++) {
    const id = ("0000" + i).slice(-4) + "aaaabbbbccccddddeeeeffff11112222";
    const rated = i % 3 !== 0;
    lib.push({
      Id: id,
      Name: "Movie " + ("000" + i).slice(-3),
      ServerId: "srv1",
      Type: "Movie",
      CriticRating: rated ? 40 + ((i * 7) % 60) : null,
      PrimaryImageAspectRatio: 0.6666,
      ImageTags: { Primary: "tag" + i },
      ImageBlurHashes: { Primary: { ["tag" + i]: "W" + i } },
      UserData: {
        Played: i % 5 === 0,
        PlayedPercentage: i % 11,
        PlaybackPositionTicks: i,
      },
    });
  }
  lib.sort((a, b) => (a.Name < b.Name ? -1 : a.Name > b.Name ? 1 : 0));
  return lib;
}

/**
 * A server that honours the query knobs this patch turns. `Ids=` results come
 * back REVERSED, so an order-sensitive merge in jpHyd859 would fail loudly.
 */
function makeApi(lib, opts) {
  const o = opts || {};
  const calls = [];
  const api = {
    calls,
    getCurrentUserId() {
      return "u1";
    },
    getItems(uid, q) {
      calls.push({ uid, query: JSON.parse(JSON.stringify(q)) });
      let items;
      if (q.Ids != null) {
        if (o.failHydrate) return Promise.reject(new Error("hydrate boom"));
        const want = String(q.Ids).split(",");
        items = want
          .map((id) => lib.filter((x) => x.Id === id)[0])
          .filter(Boolean)
          .filter((x) => x.Id !== o.dropId)
          .reverse();
      } else {
        items = lib.slice(0, q.Limit);
      }
      const fields = String(q.Fields == null ? "" : q.Fields);
      const out = items.map((it) => {
        const c = Object.assign({}, it);
        if (q.EnableImages === false) {
          delete c.ImageTags;
          delete c.ImageBlurHashes;
        }
        if (q.EnableUserData === false) delete c.UserData;
        if (fields.indexOf("PrimaryImageAspectRatio") === -1)
          delete c.PrimaryImageAspectRatio;
        if (fields.indexOf("CriticRating") === -1) delete c.CriticRating;
        return c;
      });
      return Promise.resolve({ Items: out });
    },
  };
  return api;
}

function makeStore(entries, hostile) {
  const m = Object.assign({}, entries);
  return {
    getItem(k) {
      if (hostile) throw new Error("localStorage is walled off");
      return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null;
    },
    setItem(k, v) {
      if (hostile) throw new Error("localStorage is walled off");
      m[k] = String(v);
    },
  };
}

/** The shell's jp622 user-state picker, reduced to what `w()` stores. */
const JELLYPLUG_SHIM = {
  pickUserState(x) {
    const u = x && x.UserData;
    if (!u) return null;
    return {
      p: !!u.Played,
      c: u.PlaybackPositionTicks || 0,
      pc: u.PlayedPercentage || 0,
    };
  },
};

function loadArm(src, store, lib, opts) {
  const api = makeApi(lib, opts);
  const sandbox = {
    localStorage: store,
    JellyPlug: JELLYPLUG_SHIM,
    Promise,
    console,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  new vm.Script(src, { filename: "standin.js" }).runInContext(sandbox);
  return { api, mod: sandbox.__jp859, sandbox };
}

function idsOf(list) {
  return list.map((x) => x.id).join(",");
}

/**
 * Each arm runs in its own vm realm, so its objects carry that realm's
 * Object.prototype and `deepStrictEqual` would reject an otherwise identical
 * item on identity of the prototype alone. Compare the values.
 */
function plain(x) {
  return JSON.parse(JSON.stringify(x));
}

// --- the patch under test ---------------------------------------------------
async function main() {
  const modPath = path.join(__dirname, "jsi-jp859-patch.mjs");
  const mod = await import("file://" + modPath);
  const {
    applyPatch,
    assertEs5Additions,
    patchConfig,
    PATCHES,
    PATCH_IDSPLIT,
    SPLIT_FLAG,
  } = mod;

  const clean = standInSource();
  const patched = applyPatch(clean, PATCH_IDSPLIT);
  const LIB = makeLibrary(349);
  const DAY = "2026-09-04";

  // 1) FAIL-CLOSED ------------------------------------------------------------
  assert.ok(patched.length > clean.length, "patch must add code");
  for (const e of PATCH_IDSPLIT.edits) {
    assert.strictEqual(
      clean.split(e.from).length - 1,
      1,
      `anchor "${e.what}" must match the live body exactly once`,
    );
  }
  assert.throws(
    () => applyPatch(patched, PATCH_IDSPLIT),
    /matched 0 times/,
    "the patch must not apply twice",
  );
  assert.throws(
    () =>
      applyPatch(
        clean.replace(
          "function B(r){return{SortBy:r.sortBy,",
          "function B(r){return{SortBy:r.sort_by,",
        ),
        PATCH_IDSPLIT,
      ),
    /jp859 anchor "leanquery:open" matched 0 times/,
    "anchor drift must fail loudly",
  );

  // 2) ES5 + balanced markers -------------------------------------------------
  assertEs5Additions(patched);
  new vm.Script(patched, { filename: "patched.js" });
  assert.throws(
    () => assertEs5Additions(patched.replace("var jpF859=", "let jpF859=")),
    /non-ES5/,
  );
  assert.throws(
    () =>
      assertEs5Additions(
        patched.replace("/*jp859*/var jpF859=", "var jpF859="),
      ),
    /unbalanced/,
  );

  // 3) SHIPPED PATH (flag unset) ---------------------------------------------
  {
    const off = loadArm(patched, makeStore({}), LIB);
    const rowOff = await off.mod.mkRow(off.mod.k(null))(off.api, DAY);
    assert.strictEqual(
      off.api.calls.length,
      1,
      "flag off must issue exactly one query",
    );
    const q = off.api.calls[0].query;
    assert.ok(!("EnableImages" in q), "flag off must not touch EnableImages");
    assert.ok(
      !("EnableUserData" in q),
      "flag off must not touch EnableUserData",
    );
    assert.strictEqual(q.Limit, 500);
    assert.strictEqual(q.IncludeItemTypes, "Movie");
    assert.strictEqual(rowOff.length, 10);
  }

  // 4) SPLIT (flag armed) -----------------------------------------------------
  {
    const on = loadArm(patched, makeStore({ [SPLIT_FLAG]: "1" }), LIB);
    const rowOn = await on.mod.mkRow(on.mod.k(null))(on.api, DAY);
    assert.strictEqual(
      on.api.calls.length,
      2,
      "armed must be candidate + hydrate",
    );
    assert.strictEqual(on.api.calls[0].query.EnableImages, false);
    assert.strictEqual(on.api.calls[0].query.EnableUserData, false);
    assert.strictEqual(
      on.api.calls[0].query.Limit,
      500,
      "candidateLimit must not move",
    );
    assert.ok(on.api.calls[1].query.Ids, "second call must be an Ids= hydrate");
    assert.strictEqual(rowOn.length, 10);
  }

  // 5) SELECTION IS UNMOVED, 400 consecutive dayStamps (AC2) -----------------
  {
    const off = loadArm(patched, makeStore({}), LIB);
    const on = loadArm(patched, makeStore({ [SPLIT_FLAG]: "1" }), LIB);
    const rowOff = off.mod.mkRow(off.mod.k(null));
    const rowOn = on.mod.mkRow(on.mod.k(null));
    for (let d = 0; d < 400; d++) {
      const day =
        "2026-" +
        String(1 + (d % 12)).padStart(2, "0") +
        "-" +
        String(1 + (d % 28)).padStart(2, "0") +
        "#" +
        d;
      const a = idsOf(await rowOff(off.api, day));
      const b = idsOf(await rowOn(on.api, day));
      assert.strictEqual(b, a, `dayStamp ${day}: selection moved`);
    }
    assert.strictEqual(off.api.calls.length, 400, "off arm: one query per day");
    assert.strictEqual(
      on.api.calls.length,
      800,
      "on arm: candidate + hydrate per day",
    );
  }

  // 6) DISPLAY FIELDS SURVIVE (AC3) ------------------------------------------
  {
    const off = loadArm(patched, makeStore({}), LIB);
    const on = loadArm(patched, makeStore({ [SPLIT_FLAG]: "1" }), LIB);
    const a = await off.mod.mkRow(off.mod.k(null))(off.api, DAY);
    const b = await on.mod.mkRow(on.mod.k(null))(on.api, DAY);
    assert.deepStrictEqual(
      plain(b),
      plain(a),
      "every rendered field must match the shipped arm",
    );
    for (const it of b) {
      assert.ok(it.imageTag, "badge art needs a Primary image tag");
      assert.ok(it.us && typeof it.us === "object", "jp622 needs UserData");
      assert.strictEqual(it.serverId, "srv1");
      assert.strictEqual(it.wide, false);
    }
  }

  // 7) HYDRATE SHAPE ----------------------------------------------------------
  {
    const on = loadArm(patched, makeStore({ [SPLIT_FLAG]: "1" }), LIB);
    const row = await on.mod.mkRow(on.mod.k(null))(on.api, DAY);
    const h = on.api.calls[1].query;
    assert.strictEqual(
      h.Ids,
      idsOf(row),
      "hydrate must ask for exactly the survivors",
    );
    assert.strictEqual(h.Limit, 10);
    assert.strictEqual(
      h.Fields,
      "CriticRating",
      "Movie chart keeps the jp754 lean Fields",
    );
    assert.strictEqual(h.EnableImageTypes, "Primary");
    assert.strictEqual(h.ImageTypeLimit, 1);
    assert.ok(!("EnableImages" in h), "the hydrate must NOT be lean");
    assert.ok(!("EnableUserData" in h), "the hydrate must NOT be lean");
  }
  {
    // a wide-capable chart keeps PrimaryImageAspectRatio on BOTH legs
    const on = loadArm(patched, makeStore({ [SPLIT_FLAG]: "1" }), LIB);
    on.mod.setTy("Episode");
    await on.mod.mkRow(on.mod.k(null))(on.api, DAY);
    assert.strictEqual(
      on.api.calls[0].query.Fields,
      "PrimaryImageAspectRatio,CriticRating",
    );
    assert.strictEqual(
      on.api.calls[1].query.Fields,
      "PrimaryImageAspectRatio,CriticRating",
    );
    assert.strictEqual(on.api.calls[1].query.Ids.split(",").length, 10);
  }

  // 8) FAILURE PROPAGATES -----------------------------------------------------
  {
    const on = loadArm(patched, makeStore({ [SPLIT_FLAG]: "1" }), LIB, {
      failHydrate: true,
    });
    await assert.rejects(
      on.mod.mkRow(on.mod.k(null))(on.api, DAY),
      /hydrate boom/,
      "a failed hydrate must fail the row, not render null art",
    );
  }

  // 9) PARTIAL HYDRATE --------------------------------------------------------
  {
    const off = loadArm(patched, makeStore({}), LIB);
    const expect = await off.mod.mkRow(off.mod.k(null))(off.api, DAY);
    const gone = expect[3].id;
    const on = loadArm(patched, makeStore({ [SPLIT_FLAG]: "1" }), LIB, {
      dropId: gone,
    });
    const got = await on.mod.mkRow(on.mod.k(null))(on.api, DAY);
    assert.strictEqual(
      idsOf(got),
      idsOf(expect),
      "a dropped id must not reorder the row",
    );
    assert.strictEqual(
      got[3].imageTag,
      null,
      "the dropped id keeps its lean values",
    );
    assert.strictEqual(
      got[4].imageTag,
      expect[4].imageTag,
      "its neighbours are unaffected",
    );
  }

  // 10) INTEROP with jp672 widening, jp512 override and the jp754 flight ------
  {
    const on = loadArm(patched, makeStore({ [SPLIT_FLAG]: "1" }), LIB);
    on.mod.setTy("Series");
    await on.mod.mkRow(on.mod.k(null))(on.api, DAY);
    assert.strictEqual(
      on.api.calls[0].query.Limit,
      5000,
      "jp672 widening still applies",
    );
    assert.strictEqual(on.api.calls[0].query.IncludeItemTypes, "Series");
    assert.strictEqual(on.api.calls[0].query.EnableImages, false);
    assert.strictEqual(
      on.api.calls[1].query.Fields,
      "CriticRating",
      "hydrate uses the EFFECTIVE type",
    );
  }
  {
    const on = loadArm(patched, makeStore({ [SPLIT_FLAG]: "1" }), LIB);
    const row = on.mod.mkRow(on.mod.k(null));
    const a = await row(on.api, DAY);
    const b = await on.mod.ie(on.api, DAY, null, null);
    assert.strictEqual(
      on.api.calls.length,
      2,
      "jp754 single-flight still collapses the pair",
    );
    assert.deepStrictEqual(
      plain(b),
      plain(a),
      "both consumers get the same hydrated list",
    );
  }
  {
    // rankedTopForType on its own still splits, and still hydrates.
    const on = loadArm(patched, makeStore({ [SPLIT_FLAG]: "1" }), LIB);
    const off = loadArm(patched, makeStore({}), LIB);
    const b = await on.mod.ie(on.api, DAY, null, null);
    const a = await off.mod.ie(off.api, DAY, null, null);
    assert.strictEqual(on.api.calls.length, 2);
    assert.strictEqual(off.api.calls.length, 1);
    assert.deepStrictEqual(plain(b), plain(a));
  }

  // 11) HOSTILE localStorage --------------------------------------------------
  {
    const on = loadArm(patched, makeStore({}, true), LIB);
    const row = await on.mod.mkRow(on.mod.k(null))(on.api, DAY);
    assert.strictEqual(
      on.api.calls.length,
      1,
      "a throwing store degrades to shipped",
    );
    assert.ok(!("EnableImages" in on.api.calls[0].query));
    assert.strictEqual(
      on.api.calls[0].query.Fields,
      "PrimaryImageAspectRatio,CriticRating",
    );
    assert.strictEqual(row.length, 10);
  }

  // 12) ENTRY SELECTION + patchConfig ----------------------------------------
  {
    const cfg = {
      CustomJavaScripts: [
        { Name: "JellyPlug — detail-top10-rank", Script: "/* untouched */" },
        { Name: "JellyPlug — top10-badges", Script: clean },
      ],
    };
    const report = patchConfig(cfg);
    assert.strictEqual(report.length, PATCHES.length);
    assert.strictEqual(report[0].name, "JellyPlug — top10-badges");
    assert.ok(report[0].delta > 0);
    assert.strictEqual(cfg.CustomJavaScripts[0].Script, "/* untouched */");
    assert.strictEqual(cfg.CustomJavaScripts[1].Script, patched);
    assert.throws(
      () => patchConfig({ CustomJavaScripts: [] }),
      /matched 0 channel entries/,
    );
  }

  console.log("jsi-jp859-patch.test.cjs: all checks passed");
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
