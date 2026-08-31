#!/usr/bin/env node
/*
 * jsi-jp816-patch.test.cjs — JELA-816 guard for jsi-jp816-patch.mjs.
 *
 * The patched snippet lives only on the live JS-Injector channel (the
 * jellyplug-theme source repo is gone), so these edits are anchored text
 * replacements. That makes anchor drift the whole risk: an upstream snippet
 * edit that moves an anchor must fail LOUDLY at patch time, never silently
 * apply zero edits and ship the unpatched behaviour as if it were the fix.
 *
 * `F` (row selection), `G` (the settle gate), `jpRst320` (the user-switch
 * reset) and the fan-out block inside `Z` are copied VERBATIM from the live
 * `genre-rows` body, so an upstream change to any of them shows up here as a
 * failing anchor rather than as a silent no-op deploy. Everything around them
 * (the ApiClient, the mount, the util namespace) is a reduced stand-in — the
 * patch does not depend on their internals, only on their shapes.
 *
 *  1) FAIL-CLOSED: every anchor must match exactly once; zero or two throws.
 *  2) ES5: the added code must survive Chromium 63 / V8 6.3.
 *  3) FLAG-DARK: with no flag, the patched body fans out all 14 candidates and
 *     mounts the same rows as the unpatched body — byte-for-byte same answer.
 *  4) ARMED: with the flag on, a healthy library costs exactly `maxRows`
 *     queries for exactly `maxRows` rows, and the rendered SET is identical to
 *     the unpatched body's (AC1 + AC2).
 *  5) KILL SWITCH: the disable key wins over the arm key, in the same boot.
 *  6) SHORT WAVE: thin genres pull the next candidates in, one wave at a time,
 *     and still land on the unpatched body's answer — a row is never lost.
 *  7) NEVER WORSE: a library where every candidate is thin costs the same 14
 *     queries the unpatched body costs, never more.
 *  8) FAILURES: a rejected query and a call site with no promise both behave
 *     as "no items" and pull one replacement candidate each.
 *  9) EDGES: maxRows of 0, and maxRows above the candidate count.
 * 10) USER SWITCH: a second user re-runs the whole wave sequence.
 * 11) COMPOSES WITH jp815: the live channel already wraps this fan-out in the
 *     row view gate's deferred thunk, so the patch must apply to that shape
 *     too and behave identically once the gate releases.
 */
"use strict";

const assert = require("node:assert");
const path = require("node:path");
const vm = require("node:vm");

const HERE = __dirname;

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
    'var _=51,M=' +
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
 */
async function boot(body, opts) {
  const o = opts || {};
  const store = {};
  if (o.flag) store["jellyplug.rows.genreLazy"] = "1";
  if (o.kill) store["jellyplug.rows.genreLazyDisabled"] = "1";
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
      getItem: (k) =>
        Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null,
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

(async function main() {
  const mod = await import(
    path.join("file://", HERE, "jsi-jp816-patch.mjs")
  );

  // --- 1) FAIL-CLOSED -------------------------------------------------------
  {
    const src = moduleSource();
    assert.doesNotThrow(() => mod.applyPatch(src, mod.PATCH_ROWS));
    for (const edit of mod.PATCH_ROWS.edits) {
      const missing = src.split(edit.from).join("/*gone*/");
      assert.throws(
        () => mod.applyPatch(missing, mod.PATCH_ROWS),
        new RegExp(`jp816 anchor "${edit.what}" matched 0`),
        `anchor ${edit.what} must fail closed when it is gone`,
      );
      const doubled = src.replace(edit.from, edit.from + edit.from);
      assert.throws(
        () => mod.applyPatch(doubled, mod.PATCH_ROWS),
        /matched 2 times/,
        `anchor ${edit.what} must fail closed when it is ambiguous`,
      );
    }
    // A second application must not stack.
    assert.throws(
      () => mod.applyPatch(mod.applyPatch(src, mod.PATCH_ROWS), mod.PATCH_ROWS),
      /matched 0 times/,
      "the patch must not be applicable twice",
    );
    // patchConfig demands exactly one matching channel entry.
    assert.throws(
      () => mod.patchConfig({ CustomJavaScripts: [] }),
      /matched 0 channel entries/,
    );
    assert.throws(
      () =>
        mod.patchConfig({
          CustomJavaScripts: [
            { Name: "JellyPlug — genre-rows", Script: src },
            { Name: "JellyPlug — genre-rows (copy)", Script: src },
          ],
        }),
      /matched 2 channel entries/,
    );
    const cfg = {
      CustomJavaScripts: [{ Name: "JellyPlug — genre-rows", Script: src }],
    };
    const report = mod.patchConfig(cfg);
    assert.strictEqual(report.length, 1);
    assert.ok(report[0].delta > 0, "the patched entry must grow");
    console.log("ok  1) fail-closed anchors + single-entry config gate");
  }

  // --- 2) ES5 ---------------------------------------------------------------
  {
    const patched = mod.applyPatch(moduleSource(), mod.PATCH_ROWS);
    assert.doesNotThrow(() => mod.assertEs5Additions(patched));
    new vm.Script(patched, { filename: "es5-check.js" });
    // The guard must actually catch a modern edit inside OUR markers.
    assert.throws(
      () => mod.assertEs5Additions("a/*jp816*/const q=()=>1;/*jp816*/b"),
      /non-ES5/,
    );
    // ...and must not blame us for modern syntax elsewhere in the snippet.
    assert.doesNotThrow(() =>
      mod.assertEs5Additions("const q=1;/*jp816*/var z=2;/*jp816*/"),
    );
    console.log("ok  2) additions are ES5 (Chromium 63 / V8 6.3)");
  }

  const LIVE = moduleSource();
  const PATCHED = mod.applyPatch(LIVE, mod.PATCH_ROWS);

  async function run(body, opts) {
    const b = await boot(body, opts);
    b.run();
    await b.settle();
    return b;
  }

  const HEALTHY_ROWS = CANDIDATES.slice(0, MAX_ROWS).map((c) => c.title);

  // --- 3) FLAG-DARK ---------------------------------------------------------
  {
    const live = await run(LIVE, {});
    const dark = await run(PATCHED, {});
    assert.strictEqual(live.asked.length, 14, "shipped body fans out all 14");
    assert.deepStrictEqual(live.mounted, HEALTHY_ROWS);
    assert.deepStrictEqual(dark.asked, live.asked, "dark: same queries");
    assert.deepStrictEqual(dark.mounted, live.mounted, "dark: same rows");
    console.log("ok  3) flag-dark is byte-for-byte the shipped behaviour");
  }

  // --- 4) ARMED: AC1 (queries == rows) + AC2 (same rendered set) ------------
  {
    const live = await run(LIVE, {});
    const armed = await run(PATCHED, { flag: true });
    assert.strictEqual(armed.asked.length, MAX_ROWS, "armed: one query per row");
    assert.strictEqual(
      armed.asked.length,
      armed.mounted.length,
      "AC1: genre GETs == genre rows rendered",
    );
    assert.deepStrictEqual(
      armed.mounted,
      live.mounted,
      "AC2: the rendered set is unchanged in kind and order",
    );
    assert.deepStrictEqual(
      armed.asked,
      CANDIDATES.slice(0, MAX_ROWS).map((c) => c.genre),
      "armed: it asks for the first maxRows candidates, in order",
    );
    assert.strictEqual(
      live.asked.length - armed.asked.length,
      6,
      "AC3: six fewer genre GETs per boot (plus their preflights)",
    );
    console.log("ok  4) armed: 8 queries, 8 rows, identical rendered set");
  }

  // --- 5) KILL SWITCH -------------------------------------------------------
  {
    const killed = await run(PATCHED, { flag: true, kill: true });
    const live = await run(LIVE, {});
    assert.strictEqual(killed.asked.length, 14, "kill switch restores the 14");
    assert.deepStrictEqual(killed.mounted, live.mounted);
    console.log("ok  5) the kill switch wins over the arm key");
  }

  // --- 6) SHORT WAVE --------------------------------------------------------
  {
    const thin = ["Comedy", "Horror"];
    const live = await run(LIVE, { thin });
    const armed = await run(PATCHED, { flag: true, thin });
    assert.deepStrictEqual(armed.mounted, live.mounted, "no row is lost");
    assert.strictEqual(armed.mounted.length, MAX_ROWS);
    assert.strictEqual(
      armed.asked.length,
      MAX_ROWS + thin.length,
      "exactly one replacement query per thin genre",
    );
    console.log("ok  6) a short wave pulls replacements and loses no row");
  }

  // --- 7) NEVER WORSE -------------------------------------------------------
  {
    const thin = CANDIDATES.slice(1).map((c) => c.genre); // only Action survives
    const live = await run(LIVE, { thin });
    const armed = await run(PATCHED, { flag: true, thin });
    assert.deepStrictEqual(armed.mounted, live.mounted);
    assert.strictEqual(armed.mounted.length, 1);
    assert.strictEqual(
      armed.asked.length,
      live.asked.length,
      "worst case costs exactly what the shipped body costs, never more",
    );
    console.log("ok  7) the worst case is parity with the shipped fan-out");
  }

  // --- 8) FAILURES ----------------------------------------------------------
  {
    const live = await run(LIVE, { reject: ["Comedy"], nopromise: ["Horror"] });
    const armed = await run(PATCHED, {
      flag: true,
      reject: ["Comedy"],
      nopromise: ["Horror"],
    });
    assert.deepStrictEqual(armed.mounted, live.mounted, "no row is lost");
    assert.strictEqual(armed.mounted.length, MAX_ROWS);
    assert.strictEqual(armed.asked.length, MAX_ROWS + 2);
    console.log("ok  8) a rejected query and a missing promise cost one row each");
  }

  // --- 9) EDGES -------------------------------------------------------------
  {
    const zero = await run(PATCHED, { flag: true, maxRows: 0 });
    assert.strictEqual(zero.asked.length, 0, "maxRows 0 asks for nothing");
    assert.strictEqual(zero.mounted.length, 0);

    const wide = await run(PATCHED, { flag: true, maxRows: 20 });
    const liveWide = await run(LIVE, { maxRows: 20 });
    assert.strictEqual(wide.asked.length, 14, "never more than the candidates");
    assert.deepStrictEqual(wide.mounted, liveWide.mounted);

    const covered = await run(PATCHED, { flag: true, covered: ["Comedy"] });
    const liveCovered = await run(LIVE, { covered: ["Comedy"] });
    assert.deepStrictEqual(covered.mounted, liveCovered.mounted);
    assert.strictEqual(
      covered.asked.length,
      MAX_ROWS + 1,
      "a genre a native section already covers costs one replacement query",
    );
    console.log("ok  9) maxRows 0 / above the candidate count / covered genre");
  }

  // --- 10) USER SWITCH ------------------------------------------------------
  {
    const b = await boot(PATCHED, { flag: true });
    b.run();
    await b.settle();
    assert.strictEqual(b.asked.length, MAX_ROWS);
    assert.strictEqual(b.mounted.length, MAX_ROWS);
    b.setUser("u2");
    b.run();
    await b.settle();
    assert.strictEqual(
      b.asked.length,
      2 * MAX_ROWS,
      "a user switch re-runs the wave sequence from candidate 1",
    );
    assert.deepStrictEqual(
      b.mounted.slice(MAX_ROWS),
      HEALTHY_ROWS,
      "the second user gets the same rows",
    );
    console.log("ok 10) a user switch resets the wave state");
  }

  // --- 11) COMPOSES WITH jp815 --------------------------------------------
  {
    const live815 = moduleSource({ jp815: true });
    assert.ok(
      live815.indexOf("jpF815") !== -1,
      "the jp815 shape must actually differ from the shipped one",
    );
    const patched815 = mod.applyPatch(live815, mod.PATCH_ROWS);
    mod.assertEs5Additions(patched815);
    new vm.Script(patched815, { filename: "jp815-compose.js" });

    const base = await run(live815, {});
    const armed = await run(patched815, { flag: true });
    assert.strictEqual(base.asked.length, 14);
    assert.strictEqual(armed.asked.length, MAX_ROWS);
    assert.strictEqual(armed.asked.length, armed.mounted.length);
    assert.deepStrictEqual(armed.mounted, base.mounted);

    // ...and the shipped-shape anchors must NOT match the jp815 shape, which
    // is why they are scoped to the loop rather than to its surroundings.
    for (const edit of mod.PATCH_ROWS.edits) {
      assert.strictEqual(
        live815.split(edit.from).length - 1,
        1,
        `anchor ${edit.what} must still match exactly once under jp815`,
      );
    }
    console.log("ok 11) composes with the live jp815 row view gate");
  }

  console.log("\njsi-jp816-patch.test.cjs: all checks passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
