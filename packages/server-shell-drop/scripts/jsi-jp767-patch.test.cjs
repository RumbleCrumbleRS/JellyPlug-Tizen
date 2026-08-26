#!/usr/bin/env node
/*
 * jsi-jp767-patch.test.cjs — JELA-767 guard for jsi-jp767-patch.mjs.
 *
 * The patched snippet lives only on the live JS-Injector channel (the
 * jellyplug-theme source repo is gone), so these edits are anchored text
 * replacements. That makes anchor drift the whole risk: an upstream snippet
 * edit that changes an anchor must fail LOUDLY at patch time, never silently
 * apply zero edits and ship the unpatched behaviour as if it were the fix.
 *
 * `LIVE_BE` and `LIVE_LE` below are copied VERBATIM from the live
 * `results-filter-bar` body (the single fetch site and the pager math), so a
 * regeneration of the entry shows up here as a failing anchor rather than as
 * a silent no-op deploy. Their collaborators (the builders, the DOM mount,
 * the shell util object) are reduced stand-ins — the patch does not depend
 * on their internals, only on their shapes.
 *
 * What is asserted:
 *  1) FAIL-CLOSED: every anchor must match exactly once; zero or two throws.
 *  2) ENGINE: the added code is plain ES5 — the entry's own floor, below the
 *     Q60R's M63-class ceiling. No arrows, templates, const/let, async,
 *     `?.`, `??`, or ES2019 bare `catch{`.
 *  3) FLAG-DARK: with the flag absent the request census and every pager
 *     state are identical to the UNPATCHED bytes, and no counter bag exists.
 *  4) THE FIX: open + 4 Next + 4 Prev = 9 grid fetches with EXACTLY ONE
 *     count-enabled request, exact labels on every step, and this holds even
 *     when flag-off responses ECHO THE PAGE LENGTH (the AC0 danger shape —
 *     the response field must be ignored whenever the cache answered).
 *  5) LAST PAGE / EXACT MULTIPLE: hasNext false only on the genuine last
 *     page, including a library that is an exact multiple of the page size.
 *  6) SIGNATURE: a filter change and a route change each re-count exactly
 *     once; paging under the new signature is count-free.
 *  7) RESTORED START: a session restored at jpStart>0 with a cold cache (the
 *     jp592 saved-state path) sends the count exactly as shipped — the
 *     cache-presence gate, not a jpStart===0 gate.
 *  8) KILL SWITCH + FAIL-OPEN: the disable key restores shipped behaviour
 *     with the flag still on; a throwing localStorage reads as dark.
 *  9) ATTRIBUTION: window.__jpFB767 counts armed/countOn/countOff/hit/store.
 */
"use strict";

const assert = require("node:assert");
const path = require("node:path");
const vm = require("node:vm");

const HERE = __dirname;

// --- verbatim from the live channel -----------------------------------------
// The single grid fetch site, exactly as it ships.
const LIVE_BE =
  'function be(r,t,l){var i=b();if(!(!i||typeof i.getItems!="function")){var s=ee(i),d=t.kind==="search"?Z(s,t.query,u,a.fetchLimit):V(s,t.parentId,u,a.fetchLimit,t),c=++I;d.StartIndex=jpStart,d.EnableTotalRecordCount=!0;var rt=function(g){jpStart=Math.max(0,jpStart+g),jpFoc=!0,be(r,t,l)};Q(r,l,M([],i),!0),i.getItems(s,d).then(function(m){if(c===I){var y=W(m),g=Le(jpStart,y.length,m&&m.TotalRecordCount!=null?m.TotalRecordCount:null,a.fetchLimit);if(t.kind==="search"&&!y.length&&!jpStart){/*jp595*/var g5=e.getElementById(C);g5&&(g5.style.display="none"),ie(r),jpF(),jpRescue(),n.log("results-filter-bar: search grid empty; keeping native results.");return}Q(r,l,M(y,i,g,rt),!1),jpF(),jpRescue(),n.log("results-filter-bar: rendered "+y.length+" item(s) [start="+jpStart+" total="+(g.total==null?"?":g.total)+" "+t.kind+" type="+u.type+" genre="+(u.genre||"-")+" year="+(u.year||"all")+" sort="+u.sort+"].")}}).catch(function(m){c===I&&(Q(r,l,M([],i),!1),jpF(),jpRescue(),n.log("results-filter-bar: grid fetch failed ("+(m&&m.message)+")."))})}}';

// The pager/label math, exactly as it ships.
const LIVE_LE =
  'function Le(n,a,e,u){var o=parseInt(u,10);o>0||(o=S.fetchLimit);var v=n+1,p=n+a,I=e!=null&&e>=0?e:null,b=I!=null?""+I:a>=o?p+"+":""+p,k=a?"Showing "+v+"\\u2013"+p+" of "+b:"Showing 0 of "+b;return{from:v,to:p,total:I,limit:o,hasPrev:n>0,hasNext:I==null?a>=o:n+a<I,label:k}}';

// --- harness ----------------------------------------------------------------

/**
 * Assemble a runnable stand-in for the entry: module scope holds `f`, `S`,
 * and the verbatim `Le` (which is also the helpers' insertion anchor);
 * `X(env)` reproduces the closure `be()` lives in, with every collaborator
 * supplied by the harness.
 */
function baseSrc() {
  return (
    "var f=__env.f;" +
    "var S={enabled:!0,fetchLimit:80,maxGenres:50};" +
    LIVE_LE +
    "function X(env){" +
    "var e=env.doc,n=env.n,u=env.u,a=env.a,C='jp-fb-grid',I=0,jpStart=env.start||0,jpFoc=!1;" +
    "var b=function(){return env.api},ee=function(){return env.uid};" +
    "var V=env.V,Z=env.Z,Q=env.Q,M=env.M,W=env.W,ie=env.ie,jpF=env.jpF,jpRescue=env.jpRescue;" +
    LIVE_BE +
    "return{be:be,setStart:function(v){jpStart=v},getStart:function(){return jpStart}}}" +
    "__out.X=X;"
  );
}

/**
 * Boot one grid against a mock server.
 *
 * `opts.total` is the library size. `opts.offShape` controls what a FLAG-OFF
 * request gets back in TotalRecordCount: "echo" returns the page length (the
 * AC0 danger shape that collapses hasNext), "null" omits the field. Flag-ON
 * requests always get the real total — that part of the Jellyfin contract is
 * not in question.
 */
function boot(src, opts) {
  const o = opts || {};
  const store = Object.assign({}, o.ls);
  const reqs = [];
  const mounts = [];
  const fw = {
    localStorage: o.brokenLs
      ? {
          getItem() {
            throw new Error("quota");
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
  const env = {
    f: fw,
    doc: {
      getElementById() {
        return null;
      },
    },
    n: {
      log() {},
    },
    u: o.u || { type: "all", genre: "", year: "all", sort: "name" },
    a: { fetchLimit: 80 },
    uid: "u1",
    start: o.start || 0,
    last: null,
    // Reduced builders: every filter dimension lands on the query object,
    // which is all the signature key needs from them.
    V(s, parentId, u2, limit, t2) {
      const p = {
        UserId: s,
        Recursive: true,
        IncludeItemTypes: u2.type,
        SortBy: u2.sort,
        Limit: limit,
        EnableTotalRecordCount: false,
      };
      if (parentId) p.ParentId = parentId;
      if (u2.genre) p.Genres = u2.genre;
      if (u2.year !== "all") p.Years = u2.year;
      if (t2 && t2.genreId) p.GenreIds = t2.genreId;
      return p;
    },
    Z(s, query, u2, limit) {
      return {
        UserId: s,
        SearchTerm: String(query == null ? "" : query),
        Recursive: true,
        SortBy: u2.sort,
        Limit: limit,
        EnableTotalRecordCount: false,
      };
    },
    Q() {},
    M(y, i, g, rt) {
      if (g) env.last = { g, rt, shown: y.length };
      return {};
    },
    W(m) {
      return (m && m.Items) || [];
    },
    ie() {},
    jpF() {},
    jpRescue() {},
    api: {
      getItems(s, d) {
        const snap = JSON.parse(JSON.stringify(d));
        reqs.push(snap);
        const total = typeof o.total === "number" ? o.total : 331;
        const start = d.StartIndex || 0;
        const nItems = Math.max(0, Math.min(80, total - start));
        const body = { Items: new Array(nItems).fill({ Id: "x" }) };
        if (d.EnableTotalRecordCount) {
          body.TotalRecordCount = total;
        } else if ((o.offShape || "echo") === "echo") {
          body.TotalRecordCount = nItems;
        }
        return Promise.resolve(body);
      },
    },
  };
  const sandbox = { __env: env, __out: {} };
  vm.runInNewContext(src, sandbox, { filename: "jp767-harness.js" });
  const grid = sandbox.__out.X(env);
  return { env, fw, reqs, mounts, grid };
}

const tick = () => new Promise((r) => setImmediate(r));

/** Drive the pager exactly the way Me() does: buttons exist only per state. */
async function open(h, t) {
  h.grid.be({}, t || { kind: "browse", parentId: "lib1" }, {});
  await tick();
  return h.env.last;
}
async function next(h) {
  assert.ok(h.env.last.g.hasNext, "Next pressed without a Next button");
  h.env.last.rt(h.env.last.g.limit);
  await tick();
  return h.env.last;
}
async function prev(h) {
  assert.ok(h.env.last.g.hasPrev, "Previous pressed without a button");
  h.env.last.rt(-h.env.last.g.limit);
  await tick();
  return h.env.last;
}

function countOn(h) {
  return h.reqs.filter((r) => r.EnableTotalRecordCount === true).length;
}

async function main() {
  const mod = await import("file://" + path.join(HERE, "jsi-jp767-patch.mjs"));
  const base = baseSrc();
  const patched = mod.applyPatch(base, mod.PATCH);
  new vm.Script(patched, { filename: "jp767-patched.js" });

  // 1) FAIL-CLOSED --------------------------------------------------------
  assert.throws(
    () => mod.applyPatch(base.replace(",c=++I;", ",c=++I ;"), mod.PATCH),
    /matched 0 times/,
    "missing anchor must throw",
  );
  assert.throws(
    () => mod.applyPatch(base + LIVE_LE, mod.PATCH),
    /matched 2 times/,
    "duplicated anchor must throw",
  );

  // 2) ENGINE: additions are plain ES5 ------------------------------------
  const added = mod.assertEs5Additions(patched);
  assert.ok(added.indexOf("jp767C") !== -1, "helper additions present");
  assert.throws(
    () => mod.assertEs5Additions(base),
    /no marked additions/,
    "unpatched body must not pass the additions check",
  );

  // patchConfig end-to-end on a channel-shaped config ----------------------
  const cfg = {
    CustomJavaScripts: [
      { Name: "JellyPlug — search-results", Script: "1" },
      { Name: "JellyPlug — results-filter-bar", Script: base },
    ],
  };
  const report = mod.patchConfig(cfg);
  assert.strictEqual(report.length, 1);
  assert.ok(cfg.CustomJavaScripts[1].Script.indexOf("jp767C") !== -1);
  assert.throws(
    () => mod.patchConfig({ CustomJavaScripts: [] }),
    /matched 0 channel entries/,
  );

  // 3) FLAG-DARK: byte-identical behaviour to the unpatched entry ---------
  for (const shape of ["echo", "null"]) {
    const a = boot(base, { offShape: shape });
    const b = boot(patched, { offShape: shape });
    for (const h of [a, b]) {
      await open(h);
      await next(h);
      await next(h);
      await prev(h);
    }
    // JSON-normalized: the pager object is built inside the vm realm, whose
    // Object.prototype is not the test realm's.
    assert.deepStrictEqual(b.reqs, a.reqs, "dark: request census differs");
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(b.env.last.g)),
      JSON.parse(JSON.stringify(a.env.last.g)),
      "dark: pager differs",
    );
    assert.strictEqual(
      b.fw.__jpFB767,
      undefined,
      "dark: counter bag must not exist",
    );
    assert.strictEqual(countOn(b), 4, "dark: every fetch still counts");
  }

  // 4) THE FIX: one count query for open + 4 Next + 4 Prev ----------------
  // 331 items, echo shape on flag-off responses: the response field is a lie
  // on every page but the first, and the pager must never see it.
  {
    const h = boot(patched, {
      ls: { [mod.FLAG_KEY]: "1" },
      total: 331,
      offShape: "echo",
    });
    let g = (await open(h)).g;
    assert.deepStrictEqual(
      [g.label, g.hasPrev, g.hasNext],
      ["Showing 1–80 of 331", false, true],
    );
    const labels = [];
    for (let i = 0; i < 4; i++) labels.push((await next(h)).g.label);
    assert.deepStrictEqual(labels, [
      "Showing 81–160 of 331",
      "Showing 161–240 of 331",
      "Showing 241–320 of 331",
      "Showing 321–331 of 331",
    ]);
    assert.strictEqual(h.env.last.g.hasNext, false, "genuine last page");
    for (let i = 0; i < 4; i++) await prev(h);
    g = h.env.last.g;
    assert.deepStrictEqual(
      [g.label, g.hasPrev, g.hasNext],
      ["Showing 1–80 of 331", false, true],
    );
    assert.strictEqual(h.reqs.length, 9, "9 grid fetches");
    assert.strictEqual(countOn(h), 1, "AC2: exactly one count-enabled fetch");
    assert.strictEqual(h.reqs[0].EnableTotalRecordCount, true, "the first");
    // 9) ATTRIBUTION
    assert.deepStrictEqual(JSON.parse(JSON.stringify(h.fw[mod.COUNTER_KEY])), {
      armed: 9,
      countOn: 1,
      countOff: 8,
      hit: 8,
      store: 1,
    });
  }

  // 5) EXACT MULTIPLE of the page size ------------------------------------
  {
    const h = boot(patched, {
      ls: { [mod.FLAG_KEY]: "1" },
      total: 160,
      offShape: "echo",
    });
    await open(h);
    const g = (await next(h)).g;
    assert.deepStrictEqual(
      [g.label, g.hasPrev, g.hasNext],
      ["Showing 81–160 of 160", true, false],
      "exact-multiple library: last page detected without an extra fetch",
    );
    assert.strictEqual(countOn(h), 1);
  }

  // 6) SIGNATURE: filter and route changes re-count once ------------------
  {
    const h = boot(patched, { ls: { [mod.FLAG_KEY]: "1" }, total: 331 });
    await open(h);
    await next(h);
    // filter change: the live P() resets jpStart and re-enters be() with the
    // mutated filter state; the new builder output is a new signature.
    h.env.u.genre = "Action";
    h.grid.setStart(0);
    await open(h);
    await next(h);
    // route change: a different parentId, same filter state.
    h.grid.setStart(0);
    await open(h, { kind: "browse", parentId: "lib2" });
    await next(h);
    assert.strictEqual(h.reqs.length, 6);
    assert.strictEqual(countOn(h), 3, "one count per signature");
    assert.strictEqual(h.reqs[3].EnableTotalRecordCount, false);
    assert.strictEqual(h.reqs[5].EnableTotalRecordCount, false);
  }

  // 7) RESTORED jpStart>0 with a cold cache (jp592 saved state) -----------
  {
    const h = boot(patched, {
      ls: { [mod.FLAG_KEY]: "1" },
      total: 331,
      start: 160,
      offShape: "echo",
    });
    const g = (await open(h)).g;
    assert.strictEqual(
      h.reqs[0].EnableTotalRecordCount,
      true,
      "cold cache mid-list must count",
    );
    assert.deepStrictEqual(
      [g.label, g.hasPrev, g.hasNext],
      ["Showing 161–240 of 331", true, true],
    );
  }

  // 8) KILL SWITCH + FAIL-OPEN --------------------------------------------
  {
    const h = boot(patched, {
      ls: { [mod.FLAG_KEY]: "1", [mod.KILL_KEY]: "1" },
    });
    await open(h);
    await next(h);
    assert.strictEqual(countOn(h), 2, "kill switch restores shipped counts");
    assert.strictEqual(h.fw[mod.COUNTER_KEY], undefined);
  }
  {
    const h = boot(patched, { brokenLs: true });
    await open(h);
    await next(h);
    assert.strictEqual(countOn(h), 2, "throwing localStorage reads as dark");
  }

  console.log("jsi-jp767-patch.test.cjs: all assertions passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
