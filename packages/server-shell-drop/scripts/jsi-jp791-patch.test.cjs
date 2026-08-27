#!/usr/bin/env node
/*
 * jsi-jp791-patch.test.cjs — JELA-791 guard for jsi-jp791-patch.mjs.
 *
 * The patched snippets live only on the live JS-Injector channel (the
 * jellyplug-theme source repo is gone), so these edits are anchored text
 * replacements. Anchor drift is the whole risk: an upstream snippet edit that
 * changes an anchor must fail LOUDLY at patch time, never silently apply zero
 * edits and ship the unpatched behaviour as if it were the fix.
 *
 * The s()/k() getter functions below are copied VERBATIM from the live channel
 * bodies (hero-runtime / match-score), so an upstream change to either shows
 * up here as a failing anchor rather than a silent no-op deploy. Their
 * surroundings (formatters, the profile pump, the config) are reduced
 * stand-ins — the patch depends only on their shapes.
 *
 *  1) FAIL-CLOSED: every anchor must match exactly once; zero or two throws.
 *  2) ES5: the added code must survive Chromium 63 / V8 6.3.
 *  3) FLAG-DARK: with the flag absent, both getters take the shipped jp317
 *     path even when the pool store holds the body, and no counter appears.
 *  4) STORE HIT: with the flag on and the body in the store, neither
 *     JellyPlug.getItem nor ApiClient.getItem is called, the memo is written
 *     exactly as the shipped cb writes it, and __jpMB791 proves the path.
 *  5) FALL-THROUGH: with the flag on but the item absent from the store
 *     (pruned / never primed / no slideshowPure), the shipped path runs.
 *  6) KILL SWITCH: heroPoolReadDisabled=1 beats the flag, per call.
 *  7) EPOCH (match-score): a profile reset between k() and the profile
 *     delivery discards the store answer — no stale memo write.
 *  8) ROUTING: patchConfig touches exactly the two intended entries and
 *     leaves hero look-alikes (hero-mute, hero-dots, hero-trailer-offset,
 *     detail-hero-trailer) alone.
 */
"use strict";

const assert = require("node:assert");
const path = require("node:path");
const vm = require("node:vm");

const HERE = __dirname;

/** A window stand-in with localStorage and call-recording API surfaces. */
function makeWin(flags) {
  const jpCalls = [];
  const apiCalls = [];
  const win = {
    localStorage: {
      getItem(k) {
        return Object.prototype.hasOwnProperty.call(flags, k) ? flags[k] : null;
      },
      setItem(k, v) {
        flags[k] = String(v);
      },
      removeItem(k) {
        delete flags[k];
      },
    },
    JellyPlug: {
      getItem(id, cb) {
        jpCalls.push(String(id));
        win.__pendingJp.push({ id: String(id), cb });
      },
    },
    ApiClient: {
      getCurrentUserId() {
        return "uid1";
      },
      getItem(uid, id) {
        apiCalls.push(String(id));
        return { then() {} };
      },
    },
    slideshowPure: { STATE: { slideshow: { loadedItems: {} } } },
    __pendingJp: [],
    __jpCalls: jpCalls,
    __apiCalls: apiCalls,
  };
  return win;
}

// --- hero-runtime stand-in: s() is VERBATIM from the live channel body ------
const HERO_RUNTIME_STANDIN =
  '(function(u){"use strict";var h="jp-runtime",C=6e8;' +
  "function T(f){var l=Number(f);if(!isFinite(l)||l<=0)return null;var a=Math.round(l/C);if(a<=0)return null;var o=Math.floor(a/60),s=a%60;return o>0&&s>0?o+\"h \"+s+\"m\":o>0?o+\"h\":s+\"m\"}" +
  '/*jp573*/function J(f){if(!f||f.Type!=="Series")return null;var l=f.ChildCount!=null?f.ChildCount:f.childCount!=null?f.childCount:null,a=Number(l);return!isFinite(a)||a<=0?null:(a=Math.round(a),a+(a===1?" Season":" Seasons"))}' +
  "var a={},o={};" +
  "function s(t,n){if(a.hasOwnProperty(t)){n(a[t]);return}if(!o[t]){var jp317J=u.JellyPlug,jp317S=jp317J&&typeof jp317J.getItem==\"function\"?jp317J:null,r=u.ApiClient;if(!(!jp317S&&(!r||typeof r.getItem!=\"function\"))){var i;try{i=r&&r.getCurrentUserId?r.getCurrentUserId():null}catch(e){i=null}o[t]=!0;var jp317K=function(e){delete o[t];if(!e)return;var v=/*jp573*/J(e)||T(e.RunTimeTicks);a[t]=v||\"\",n(a[t])};try{jp317S?jp317S.getItem(t,jp317K):r.getItem(i,t).then(jp317K,function(){delete o[t]})}catch(e){delete o[t]}}}}" +
  "u.__standin={ask:function(id,cb){s(id,cb)},memo:a};" +
  "})(WIN);";

// --- match-score stand-in: k() is VERBATIM from the live channel body -------
const MATCH_SCORE_STANDIN =
  '(function(b){"use strict";' +
  "var t={label:\"Match\"},q={},F={},jpEp345=1,PROFILE={weights:{drama:1},maxWeight:1,signalItems:1};" +
  "var leSeen=[];function le(e,o,cfg){leSeen.push(e);return e&&e.Genres&&e.Genres.length?90:null}" +
  "var profileWaiters=[];function y(cb){profileWaiters.push(cb)}" +
  "function P(){return b.ApiClient||null}function p(x){try{return x&&x.getCurrentUserId?x.getCurrentUserId():null}catch(e){return null}}" +
  "function k(a,i){if(!a){i(null);return}if(Object.prototype.hasOwnProperty.call(q,a)){i(q[a]);return}if(!F[a]){var u=P(),jp317J=b.JellyPlug,jp317S=jp317J&&typeof jp317J.getItem==\"function\"?jp317J:null;if(!jp317S&&(!u||typeof u.getItem!=\"function\")){i(null);return}y(function(o){if(Object.prototype.hasOwnProperty.call(q,a)){i(q[a]);return}if(!F[a]){F[a]=!0;var v=p(u);/*jp345*/var jpE=jpEp345;var jp317K=function(c){if(jpE!==jpEp345)return;delete F[a];if(!c)return;var s=le(c,o,t);q[a]=s,i(s)};try{jp317S?jp317S.getItem(a,jp317K):u.getItem(v,a).then(jp317K,function(){jpE===jpEp345&&delete F[a]})}catch(c){delete F[a]}}})}}" +
  "b.__standin={ask:function(id,cb){k(id,cb)},memo:q,leSeen:leSeen," +
  "deliverProfile:function(){var w=profileWaiters.slice();profileWaiters=[];for(var i=0;i<w.length;i++)w[i](PROFILE)}," +
  "waiting:function(){return profileWaiters.length},bumpEpoch:function(){jpEp345++}};" +
  "})(WIN);";

async function main() {
  const mod = await import(
    "file://" + path.join(HERE, "jsi-jp791-patch.mjs")
  );
  const {
    FLAG_KEY,
    KILL_KEY,
    PATCH_HERO_RUNTIME,
    PATCH_MATCH_SCORE,
    applyPatch,
    assertEs5Additions,
    patchConfig,
  } = mod;

  // 1) FAIL-CLOSED --------------------------------------------------------
  assert.throws(
    () => applyPatch("nothing to see here", PATCH_HERO_RUNTIME),
    /matched 0 times/,
    "drifted anchor must throw",
  );
  assert.throws(
    () =>
      applyPatch(
        HERO_RUNTIME_STANDIN + HERO_RUNTIME_STANDIN,
        PATCH_HERO_RUNTIME,
      ),
    /matched 2 times/,
    "double anchor must throw",
  );

  const heroPatched = applyPatch(HERO_RUNTIME_STANDIN, PATCH_HERO_RUNTIME);
  const msPatched = applyPatch(MATCH_SCORE_STANDIN, PATCH_MATCH_SCORE);

  // 2) ES5 ----------------------------------------------------------------
  assertEs5Additions(heroPatched);
  assertEs5Additions(msPatched);
  new vm.Script(heroPatched);
  new vm.Script(msPatched);

  function boot(src, flags) {
    const win = makeWin(flags);
    const ctx = vm.createContext({ WIN: win });
    new vm.Script(src).runInContext(ctx);
    return win;
  }

  const MOVIE = { Id: "m1", Type: "Movie", RunTimeTicks: 90 * 60 * 6e8 / 60, Genres: ["Drama"] };
  MOVIE.RunTimeTicks = 5400 * 1e7; // 90 min in ticks
  const SERIES = { Id: "s1", Type: "Series", ChildCount: 3, Genres: ["Drama"] };

  // 3) FLAG-DARK: store holds the body, flag absent -> shipped jp317 path --
  {
    const win = boot(heroPatched, {});
    win.slideshowPure.STATE.slideshow.loadedItems.m1 = MOVIE;
    let got;
    win.__standin.ask("m1", (v) => (got = v));
    assert.deepStrictEqual(win.__jpCalls, ["m1"], "dark: shipped path must run");
    assert.strictEqual(win.__jpMB791, undefined, "dark: no counter bag");
    win.__pendingJp[0].cb(MOVIE); // network resolves
    assert.strictEqual(got, "1h 30m");
  }

  // 4) STORE HIT (hero-runtime): no getItem, memo written, counter proves --
  {
    const win = boot(heroPatched, { [FLAG_KEY]: "1" });
    win.slideshowPure.STATE.slideshow.loadedItems.m1 = MOVIE;
    win.slideshowPure.STATE.slideshow.loadedItems.s1 = SERIES;
    let movie, series;
    win.__standin.ask("m1", (v) => (movie = v));
    win.__standin.ask("s1", (v) => (series = v));
    assert.strictEqual(movie, "1h 30m", "runtime chip from the store body");
    assert.strictEqual(series, "3 Seasons", "season chip from the store body");
    assert.deepStrictEqual(win.__jpCalls, [], "no JellyPlug.getItem");
    assert.deepStrictEqual(win.__apiCalls, [], "no ApiClient.getItem");
    assert.strictEqual(win.__jpMB791.hr, 2, "counter proves the store path");
    assert.strictEqual(win.__standin.memo.m1, "1h 30m", "memo written as shipped");
    let again;
    win.__standin.ask("m1", (v) => (again = v));
    assert.strictEqual(again, "1h 30m", "second ask answers from the memo");
    assert.strictEqual(win.__jpMB791.hr, 2, "memo hit does not re-count");
  }

  // 4b) STORE HIT (match-score): le() gets the store body via the profile --
  {
    const win = boot(msPatched, { [FLAG_KEY]: "1" });
    win.slideshowPure.STATE.slideshow.loadedItems.s1 = SERIES;
    let score;
    win.__standin.ask("s1", (v) => (score = v));
    assert.strictEqual(win.__standin.waiting(), 1, "waits on the taste profile");
    win.__standin.deliverProfile();
    assert.strictEqual(score, 90, "scored from the store body");
    assert.strictEqual(win.__standin.leSeen[0], SERIES, "le() saw the store body");
    assert.deepStrictEqual(win.__jpCalls, [], "no JellyPlug.getItem");
    assert.strictEqual(win.__jpMB791.ms, 1, "counter proves the store path");
    assert.strictEqual(win.__standin.memo.s1, 90, "memo written");
  }

  // 5) FALL-THROUGH: flag on, item not in the store -> shipped path --------
  {
    const win = boot(heroPatched, { [FLAG_KEY]: "1" });
    win.__standin.ask("gone1", () => {});
    assert.deepStrictEqual(win.__jpCalls, ["gone1"], "store miss falls through");
    assert.strictEqual(win.__jpMB791, undefined, "no store-hit counted");
  }
  {
    // no slideshowPure at all (media bar absent on this route)
    const win = boot(msPatched, { [FLAG_KEY]: "1" });
    delete win.slideshowPure;
    win.__standin.ask("s1", () => {});
    win.__standin.deliverProfile();
    assert.deepStrictEqual(win.__jpCalls, ["s1"], "no slideshowPure falls through");
  }

  // 6) KILL SWITCH --------------------------------------------------------
  {
    const win = boot(heroPatched, { [FLAG_KEY]: "1", [KILL_KEY]: "1" });
    win.slideshowPure.STATE.slideshow.loadedItems.m1 = MOVIE;
    win.__standin.ask("m1", () => {});
    assert.deepStrictEqual(win.__jpCalls, ["m1"], "kill switch restores shipped");
  }

  // 7) EPOCH (match-score): reset between ask and profile delivery ---------
  {
    const win = boot(msPatched, { [FLAG_KEY]: "1" });
    win.slideshowPure.STATE.slideshow.loadedItems.s1 = SERIES;
    let called = 0;
    win.__standin.ask("s1", () => called++);
    win.__standin.bumpEpoch();
    win.__standin.deliverProfile();
    assert.strictEqual(called, 0, "stale-epoch answer is discarded");
    assert.ok(
      !Object.prototype.hasOwnProperty.call(win.__standin.memo, "s1"),
      "no stale memo write",
    );
  }

  // 8) ROUTING ------------------------------------------------------------
  {
    const cfg = {
      CustomJavaScripts: [
        { Name: "JellyPlug — hero-runtime", Script: HERO_RUNTIME_STANDIN },
        { Name: "JellyPlug — match-score", Script: MATCH_SCORE_STANDIN },
        { Name: "JellyPlug — hero-mute", Script: "keep me" },
        { Name: "JellyPlug — hero-dots (JELA-94)", Script: "keep me" },
        { Name: "JellyPlug — hero-trailer-offset", Script: "keep me" },
        { Name: "JellyPlug — detail-hero-trailer", Script: "keep me" },
      ],
    };
    const report = patchConfig(cfg);
    assert.strictEqual(report.length, 2, "exactly two entries patched");
    assert.ok(cfg.CustomJavaScripts[0].Script.indexOf("/*jp791*/") >= 0);
    assert.ok(cfg.CustomJavaScripts[1].Script.indexOf("/*jp791*/") >= 0);
    for (let i = 2; i < 6; i++) {
      assert.strictEqual(
        cfg.CustomJavaScripts[i].Script,
        "keep me",
        `look-alike untouched: ${cfg.CustomJavaScripts[i].Name}`,
      );
    }
  }

  console.log("jsi-jp791-patch.test.cjs: all tests passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
