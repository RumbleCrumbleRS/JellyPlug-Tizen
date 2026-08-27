#!/usr/bin/env node
/*
 * jsi-jp768-patch.test.cjs — JELA-768 guard for jsi-jp768-patch.mjs.
 *
 * The patched snippet lives only on the live JS-Injector channel (the
 * jellyplug-theme source repo is gone), so these edits are anchored text
 * replacements. That makes anchor drift the whole risk: an upstream snippet
 * edit that changes an anchor must fail LOUDLY at patch time, never silently
 * apply zero edits and ship the unpatched behaviour as if it were the fix.
 *
 * `LIVE_BE`, `LIVE_P`, `LIVE_LE` and `LIVE_TE` below are copied VERBATIM from
 * the live `results-filter-bar` body, so a regeneration of the snippet shows
 * up here as a failing anchor rather than as a silent no-op deploy. Their
 * collaborators (Q, M, W, the apiClient, the DOM) are reduced stand-ins — the
 * patch does not depend on their internals, only on their shapes.
 *
 * What is asserted:
 *  1) FAIL-CLOSED: every anchor must match exactly once; zero or two throws.
 *  2) ES5: the added code must survive the Q60R's M63-class engine — the
 *     entry is pure ES5 and stays that way.
 *  3) FLAG-DARK: with the flag absent, the walk `open, Next, Next, Previous,
 *     Previous` costs five getItems calls and mounts the empty grid before
 *     every render, byte-identical to shipped behaviour.
 *  4) THE FIX: with the flag on, the same walk costs THREE getItems calls —
 *     the two back steps render from the store, with the correct page body
 *     and paging label, and WITHOUT the empty-grid mount (no blank flash).
 *  5) RACE: a cache hit still bumps the `I` race counter, so a stale
 *     in-flight response is discarded exactly as it is today.
 *  6) TTL: past the TTL a back step refetches (AC3 — watch-state cannot go
 *     indefinitely stale); the TTL is localStorage-tunable.
 *  7) INVALIDATION: P() — every filter or route change — drops the store.
 *  8) BOUNDED: paging deep holds the store at the cap via LRU eviction, and
 *     an evicted page refetches (AC4).
 *  9) EMPTY PAGES: an empty search result is never stored, so the jp595
 *     "keep native results" branch can never be served from cache.
 * 10) KILL SWITCH: the disable key restores shipped behaviour with the flag
 *     still on.
 */
"use strict";

const assert = require("node:assert");
const { existsSync, readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const HERE = __dirname;

// --- verbatim from the live channel -----------------------------------------
// be() — the grid fetch — exactly as it ships.
const LIVE_BE = `function be(r,t,l){var i=b();if(!(!i||typeof i.getItems!="function")){var s=ee(i),d=t.kind==="search"?Z(s,t.query,u,a.fetchLimit):V(s,t.parentId,u,a.fetchLimit,t),c=++I;d.StartIndex=jpStart,d.EnableTotalRecordCount=!0;var rt=function(g){jpStart=Math.max(0,jpStart+g),jpFoc=!0,be(r,t,l)};Q(r,l,M([],i),!0),i.getItems(s,d).then(function(m){if(c===I){var y=W(m),g=Le(jpStart,y.length,m&&m.TotalRecordCount!=null?m.TotalRecordCount:null,a.fetchLimit);if(t.kind==="search"&&!y.length&&!jpStart){/*jp595*/var g5=e.getElementById(C);g5&&(g5.style.display="none"),ie(r),jpF(),jpRescue(),n.log("results-filter-bar: search grid empty; keeping native results.");return}Q(r,l,M(y,i,g,rt),!1),jpF(),jpRescue(),n.log("results-filter-bar: rendered "+y.length+" item(s) [start="+jpStart+" total="+(g.total==null?"?":g.total)+" "+t.kind+" type="+u.type+" genre="+(u.genre||"-")+" year="+(u.year||"all")+" sort="+u.sort+"].")}}).catch(function(m){c===I&&(Q(r,l,M([],i),!1),jpF(),jpRescue(),n.log("results-filter-bar: grid fetch failed ("+(m&&m.message)+")."))})}}`;

// P() — the reset funnel every filter and route change goes through.
const LIVE_P = `function P(g2){/*jp592*/jpStart=0;var r=f.location,t=q(r?r.hash:null);if(t.kind){jpFg592=g2||null,/*jp592*/jpLastCard=null,jpArm=!1,jpSave();var l=re();l&&(t.kind==="search"&&(t.query=te(l,t.hashQuery)),De(b(),t,function(){le(b(),t,function(i){ue(l,t,i)})}))}}`;

// Le() — the paging maths the hit path re-uses.
const LIVE_LE = `function Le(n,a,e,u){var o=parseInt(u,10);o>0||(o=S.fetchLimit);var v=n+1,p=n+a,I=e!=null&&e>=0?e:null,b=I!=null?""+I:a>=o?p+"+":""+p,k=a?"Showing "+v+"–"+p+" of "+b:"Showing 0 of "+b;return{from:v,to:p,total:I,limit:o,hasPrev:n>0,hasNext:I==null?a>=o:n+a<I,label:k}}`;

// Te() — the route signature (kept verbatim so a signature change is loud).
const LIVE_TE = `function Te(r){return r.kind+"|"+(r.parentId||"")+"|"+(r.genreId||"")+"|"+(r.studioId||"")+"|"+(r.personId||"")+"|"+(r.query||"")+(r.singleType?"|"+r.singleType:"")/*jp586*/}`;

// --- harness ----------------------------------------------------------------
// The stand-ins around the verbatim functions. Q records every mount (the
// empty "loading" mount IS the blank flash the ticket measures); M carries
// the pager closure out so the test can press Next/Previous the way the
// remote does. ES5 throughout, like the snippet itself.
const HARNESS_SRC =
  '(function(f){"use strict";' +
  "var e=f.document;" +
  "var S={enabled:!0,fetchLimit:4};" +
  "var a=S;" +
  'var u={type:"all",genre:null,year:"all",sort:"default"};' +
  "var I=0,v=!1,jpStart=0,jpFoc=!1,jpLastCard=null,jpArm=!1,jpFg592=null;" +
  'var C="jp-filter-grid";' +
  "var n={log:function(m){f.__h.logs.push(m)},qs:function(){return null},qsa:function(){return[]},safe:function(nm,fn){fn()}};" +
  "function b(){return f.__h.apiClient}" +
  'function ee(r){return "user1"}' +
  'function Z(s,q2,uu,lim){return{UserId:s,SearchTerm:String(q2||""),Limit:lim,Kind:"search",Type:uu.type,Genre:uu.genre,Year:uu.year,Sort:uu.sort}}' +
  'function V(s,pid,uu,lim,t){return{UserId:s,ParentId:pid||null,Limit:lim,Kind:"browse",Type:uu.type,Genre:uu.genre,Year:uu.year,Sort:uu.sort}}' +
  "function W(m){var arr=m&&m.Items?m.Items:[];var out=[],i2;for(i2=0;i2<arr.length;i2++)out.push({id:String(arr[i2].Id),name:arr[i2].Name||\"\"});return out}" +
  "function Q(r,t,l,i){v=!0,f.__h.mounts.push({loading:!!i,count:l&&l.items?l.items.length:0,label:l&&l.g?l.g.label:null,first:l&&l.items&&l.items.length?l.items[0].id:null,rt:l&&l.rt?l.rt:null})}" +
  "function M(r,t,g,rt){return{items:r,g:g||null,rt:rt||null}}" +
  "function jpF(){}" +
  "function jpRescue(){}" +
  "function ie(r){}" +
  "function q(h){return f.__h.route}" +
  "function re(){return{}}" +
  "function te(l,hq){return hq||\"\"}" +
  "function De(r,t,cb){cb()}" +
  "function le(r,t,cb){cb([])}" +
  "function ue(l,t,i){}" +
  "function jpSave(){}" +
  LIVE_LE +
  LIVE_TE +
  LIVE_BE +
  LIVE_P +
  "f.__h.be=be,f.__h.P=P,f.__h.Te=Te,f.__h.state=function(){return{jpStart:jpStart,I:I}}" +
  "})(window)";

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Boot one patched module. `flags` lands in localStorage; `total` sizes the
 * fake library (fetchLimit is 4, so page k is items 4k..4k+3). The clock the
 * store sees is `boot.clock.t` — advance it to age entries.
 */
function boot(mod, opts) {
  const o = opts || {};
  const ls = Object.assign({}, o.flags || {});
  const clock = { t: 1000000 };
  const total = o.total == null ? 10 : o.total;
  const h = {
    logs: [],
    mounts: [],
    calls: [],
    route: o.route || { kind: "browse", parentId: "lib1" },
    apiClient: null,
  };
  h.apiClient = {
    getItems: function (s, d) {
      h.calls.push(JSON.parse(JSON.stringify(d)));
      const items = [];
      for (
        let k = d.StartIndex;
        k < Math.min(d.StartIndex + d.Limit, total);
        k++
      ) {
        items.push({ Id: "it" + k, Name: "N" + k });
      }
      return Promise.resolve({ Items: items, TotalRecordCount: total });
    },
  };
  const sandbox = { console };
  sandbox.window = sandbox;
  sandbox.document = {
    getElementById: function () {
      return null;
    },
  };
  sandbox.localStorage = {
    getItem: function (k) {
      return Object.prototype.hasOwnProperty.call(ls, k) ? ls[k] : null;
    },
  };
  sandbox.Date = function () {
    this.getTime = function () {
      return clock.t;
    };
  };
  sandbox.__h = h;
  vm.createContext(sandbox);
  new vm.Script(mod.src, { filename: "results-filter-bar.patched.js" }).runInContext(
    sandbox,
  );
  return { h, sandbox, clock, ls };
}

/** The last non-loading mount — where the live pager closure comes out. */
function lastRender(h) {
  for (let i = h.mounts.length - 1; i >= 0; i--) {
    if (!h.mounts[i].loading) return h.mounts[i];
  }
  throw new Error("no rendered mount yet");
}

/** Press Next/Previous the way Me()'s buttons do: through the rt closure. */
async function press(b, delta) {
  lastRender(b.h).rt(delta);
  await tick();
  await tick();
}

async function open(b) {
  b.h.be({}, b.h.route, {});
  await tick();
  await tick();
}

/** Mounts recorded since index `from`, as loading/render flags. */
function mountsSince(h, from) {
  return h.mounts.slice(from).map((m) => (m.loading ? "empty" : "render"));
}

async function main() {
  const mod = await import(
    "file://" + path.join(HERE, "jsi-jp768-patch.mjs")
  );

  // Patch the harness ONCE — the verbatim texts inside it are what exercises
  // every anchor on every test run.
  let patched = HARNESS_SRC;
  for (const p of mod.PATCHES) patched = mod.applyPatch(patched, p);
  const added = mod.assertEs5Additions(patched);
  assert.ok(added.indexOf("jpPC768") !== -1, "helpers not among additions");
  new vm.Script(patched, { filename: "patched-harness.js" });
  const M = { src: patched };
  const FLAG_ON = {};
  FLAG_ON[mod.FLAG_KEY] = "1";

  // 1) FAIL-CLOSED --------------------------------------------------------
  for (const p of mod.PATCHES) {
    assert.throws(
      () => mod.applyPatch("var nothing_here=1;", p),
      /matched 0 times/,
      p.edits[0].what + " must fail on a missing anchor",
    );
    assert.throws(
      () => mod.applyPatch(HARNESS_SRC + HARNESS_SRC, p),
      /matched 2 times/,
      p.edits[0].what + " must fail on a duplicated anchor",
    );
  }

  // 2) ES5 ----------------------------------------------------------------
  assert.throws(
    () => mod.assertEs5Additions("/*jp768*/var a=(x)=>x;/*jp768*/"),
    /non-ES5/,
    "an arrow in a marked region must be rejected",
  );
  assert.throws(
    () => mod.assertEs5Additions("no markers at all"),
    /did not apply/,
    "a body with no marked additions must be rejected",
  );
  // Unmarked modern syntax OUTSIDE the markers is not ours to veto.
  mod.assertEs5Additions("const x=1;/*jp768*/var y=2;/*jp768*/let z=3;");

  // 3) FLAG-DARK control --------------------------------------------------
  {
    const b = boot(M);
    await open(b);
    await press(b, 4);
    await press(b, 4);
    await press(b, -4);
    await press(b, -4);
    assert.strictEqual(b.h.calls.length, 5, "control walk must stay 5 fetches");
    assert.deepStrictEqual(
      mountsSince(b.h, 0),
      ["empty", "render", "empty", "render", "empty", "render", "empty", "render", "empty", "render"],
      "control must mount the empty grid before every render",
    );
    assert.strictEqual(
      b.sandbox.__jpFB768,
      undefined,
      "control must not even allocate the counter bag",
    );
  }

  // 4) THE FIX ------------------------------------------------------------
  {
    const b = boot(M, { flags: FLAG_ON });
    await open(b); //            page 0  -> fetch
    await press(b, 4); //        page 1  -> fetch
    await press(b, 4); //        page 2  -> fetch
    const mark = b.h.mounts.length;
    await press(b, -4); //       page 1  -> store
    await press(b, -4); //       page 0  -> store
    assert.strictEqual(
      b.h.calls.length,
      3,
      "AC1 shape: Next,Next,Previous,Previous must cost 2 page fetches, not 4",
    );
    assert.deepStrictEqual(
      mountsSince(b.h, mark),
      ["render", "render"],
      "a cached back step must render WITHOUT the empty-grid mount",
    );
    const back1 = b.h.mounts[mark];
    const back0 = b.h.mounts[mark + 1];
    assert.strictEqual(back1.first, "it4", "back to page 1 must show item 4");
    assert.strictEqual(back0.first, "it0", "back to page 0 must show item 0");
    assert.strictEqual(back0.count, 4, "cached page 0 must hold 4 items");
    assert.strictEqual(
      back0.label,
      "Showing 1–4 of 10",
      "the cached paging label must come from the stored total",
    );
    const c = b.sandbox.__jpFB768;
    assert.deepStrictEqual(
      { hit: c.hit, miss: c.miss, put: c.put, exp: c.exp, ev: c.ev, inv: c.inv },
      { hit: 2, miss: 3, put: 3, exp: 0, ev: 0, inv: 0 },
      "counters must attribute 3 misses, 3 stores, 2 hits",
    );

    // 5) RACE: a hit bumps I, so a stale in-flight response self-discards.
    const iBefore = b.sandbox.__h.state().I;
    await press(b, 4); // page 1 again — a hit
    assert.strictEqual(b.h.calls.length, 3, "page 1 again must be a hit");
    assert.strictEqual(
      b.sandbox.__h.state().I,
      iBefore + 1,
      "a cache hit must still bump the race counter",
    );

    // 6) TTL: past 60 s the entry is dead and the step refetches (AC3).
    b.clock.t += 60001;
    await press(b, -4); // page 0 — expired
    assert.strictEqual(b.h.calls.length, 4, "an expired page must refetch");
    assert.strictEqual(b.sandbox.__jpFB768.exp, 1, "expiry must be attributed");

    // 7) INVALIDATION: P() drops everything and resets to page 0.
    b.sandbox.__h.P();
    assert.strictEqual(b.sandbox.__jpFB768.inv, 1, "P() must invalidate");
    assert.strictEqual(b.sandbox.__h.state().jpStart, 0, "P() resets jpStart");
    await open(b); // page 0 — store is empty now
    assert.strictEqual(
      b.h.calls.length,
      5,
      "after P() the same page must go back to the network",
    );
  }

  // 6b) TTL override key --------------------------------------------------
  {
    const flags = Object.assign({}, FLAG_ON);
    flags[mod.TTL_KEY] = "5000";
    const b = boot(M, { flags });
    await open(b);
    await press(b, 4);
    b.clock.t += 5001;
    await press(b, -4); // page 0 — expired under the shortened TTL
    assert.strictEqual(b.h.calls.length, 3, "the TTL override must be honoured");
  }

  // 8) BOUNDED (AC4) ------------------------------------------------------
  {
    const b = boot(M, { flags: FLAG_ON, total: 40 });
    await open(b); // page 0
    for (let k = 0; k < 6; k++) await press(b, 4); // pages 1..6
    assert.strictEqual(b.h.calls.length, 7, "seven distinct pages fetch");
    const c = b.sandbox.__jpFB768;
    assert.strictEqual(c.put, 7, "every page was offered to the store");
    assert.strictEqual(c.ev, 2, "the store must have evicted down to the cap");
    await press(b, -4); // page 5 — recent, must be a hit
    assert.strictEqual(b.h.calls.length, 7, "a recent page must be a hit");
    // Walk back to page 0 — evicted long ago, must refetch.
    for (let k = 0; k < 5; k++) await press(b, -4);
    assert.ok(
      b.h.calls.some((d) => d.StartIndex === 0 && b.h.calls.indexOf(d) > 6),
      "an evicted page must go back to the network",
    );
  }

  // 9) EMPTY PAGES --------------------------------------------------------
  {
    const b = boot(M, {
      flags: FLAG_ON,
      total: 0,
      route: { kind: "search", query: "zz" },
    });
    await open(b);
    assert.ok(
      b.h.logs.some((l) => l.indexOf("keeping native results") !== -1),
      "the jp595 empty-search branch must still run",
    );
    await open(b);
    assert.strictEqual(b.h.calls.length, 2, "an empty page is never stored");
    assert.strictEqual(b.sandbox.__jpFB768.put, 0, "no store of empty pages");
  }

  // 10) KILL SWITCH -------------------------------------------------------
  {
    const flags = Object.assign({}, FLAG_ON);
    flags[mod.KILL_KEY] = "1";
    const b = boot(M, { flags });
    await open(b);
    await press(b, 4);
    await press(b, -4);
    assert.strictEqual(b.h.calls.length, 3, "kill switch restores shipped behaviour");
    assert.strictEqual(b.sandbox.__jpFB768, undefined, "and allocates nothing");
  }

  // Opportunistic: when the live-channel snapshot is on this box, run the
  // real patchConfig over a copy so the anchors are verified against the
  // FULL entry body, not just the verbatim excerpts above.
  const SNAP = "/tmp/jela681-jsi.json";
  if (existsSync(SNAP)) {
    const cfg = JSON.parse(readFileSync(SNAP, "utf8"));
    const report = mod.patchConfig(cfg);
    assert.strictEqual(report.length, 1);
    assert.ok(report[0].delta > 0, "live patch must add bytes");
    console.log(
      "ok  live snapshot: " + report[0].name + " +" + report[0].delta + " B",
    );
  } else {
    console.log("ok  live snapshot not present on this box — anchors exercised via verbatim excerpts only");
  }

  console.log("ok  jsi-jp768-patch: all assertions passed");
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
