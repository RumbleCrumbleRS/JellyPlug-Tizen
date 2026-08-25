#!/usr/bin/env node
/*
 * jsi-jp738-patch.test.cjs — JELA-738 guard for jsi-jp738-patch.mjs.
 *
 * The patched snippets live only on the live JS-Injector channel (the
 * jellyplug-theme source repo is gone), so these edits are anchored text
 * replacements. That makes anchor drift the whole risk: an upstream snippet
 * edit that changes an anchor must fail LOUDLY at patch time, never silently
 * apply zero edits and ship the unpatched behaviour as if it were the fix.
 *
 * The lookup functions below (`oe` in genre-rows, `M` in row-see-all) are
 * copied VERBATIM from the live channel bodies, so an upstream change to
 * either one shows up here as a failing anchor rather than as a silent no-op
 * deploy. Their helpers (`K`/`E`, the util namespace, the ApiClient) are
 * reduced stand-ins — the patch does not depend on their internals, only on
 * their shapes.
 *
 *  1) FAIL-CLOSED: every anchor must match exactly once; zero or two throws.
 *  2) ES5: the added code must survive Chromium 63 / V8 6.3.
 *  3) FLAG-DARK: with the flag absent, every name is resolved by its own
 *     SearchTerm query, exactly as shipped.
 *  4) BULK: with the flag on, N names cost ONE unfiltered request, and each
 *     name resolves to the same {id,name} the SearchTerm query returned.
 *  5) SHARED: row-see-all rides the SAME in-flight request genre-rows started,
 *     so the JELA-683 double-resolve collapses into it rather than doubling it.
 *  6) SHAPE: the one request asks for the fields the row code actually needs
 *     and nothing else (Fields=, no images, no total count).
 *  7) FALLBACK: a rejected bulk read, a malformed response, and a response
 *     that may be truncated at the limit each fall back to the shipped
 *     per-name query — a row is never lost.
 *  8) USER SWITCH: a different user id re-reads rather than answering from the
 *     previous user's list.
 *  9) COMPOSES: applying jp682 and jp738 to the same bodies works in EITHER
 *     order and both behaviours survive.
 */
"use strict";

const assert = require("node:assert");
const path = require("node:path");
const vm = require("node:vm");

const HERE = __dirname;

// --- verbatim from the live channel -----------------------------------------
const LIVE_OE =
  'function oe(e,t){var i=t!=null?String(t):"",a=i.toLowerCase();if(!i||!e||typeof e.getGenres!="function")return d.Promise?d.Promise.resolve(null):{then:function(c){return c(null),this}};if(p[a])return p[a];var u=n.safe("genre-rows.uid2",function(){return typeof e.getCurrentUserId=="function"?e.getCurrentUserId():null},null),l=n.safe("genre-rows.getGenres",function(){return e.getGenres(u,{SearchTerm:i,Limit:12})},null);return!l||typeof l.then!="function"?(p[a]=d.Promise?d.Promise.resolve(null):{then:function(c){return c(null),this}},p[a]):(p[a]=l.then(function(c){var h=c&&c.Items&&typeof c.Items.length=="number"?c.Items:[];return K(h,i)},function(){return null}),p[a])}';

const LIVE_M =
  'function M(e,o){var n=o!=null?String(o):"",s=n.toLowerCase();if(!n||!e||typeof e.getGenres!="function")return u.Promise?u.Promise.resolve(null):{then:function(i){return i(null),this}};if(m[s])return m[s];var f=t.safe("row-see-all.uid",function(){return typeof e.getCurrentUserId=="function"?e.getCurrentUserId():null},null),l=t.safe("row-see-all.getGenres",function(){return e.getGenres(f,{SearchTerm:n,Limit:12})},null);return!l||typeof l.then!="function"?(m[s]=u.Promise?u.Promise.resolve(null):{then:function(i){return i(null),this}},m[s]):(m[s]=l.then(function(i){var d=i&&i.Items&&typeof i.Items.length=="number"?i.Items:[];return E(d,n)},function(){return null}),m[s])}';

// The tail of tizen-compat's IIFE, where the store is installed. `s` is window
// and `n` is the JellyPlug namespace, exactly as in the live snippet.
const LIVE_TC_TAIL = "var B=M(),Y=[];for(var Q in B.disabled)Y.push(Q);";

/** The genre list the fake server holds. Names as the server spells them. */
const LIBRARY = [
  "Action",
  "Adventure",
  "Animation",
  "Comedy",
  "Drama",
  "Horror",
  "Science Fiction",
  "Thriller",
];

/**
 * Boot the three patched snippets in one sandbox. Returns the two lookup
 * functions plus the log of requests the fake ApiClient served.
 *
 * `opts.library` overrides the server's genre list; `opts.fail` rejects the
 * bulk read; `opts.malformed` answers it without a usable `Items` array.
 */
function boot(mod, opts) {
  const o = opts || {};
  const flagOn = o.flagOn !== false;
  const backing = flagOn ? { [mod.FLAG_KEY]: "1" } : {};

  const bodies = {};
  for (const [name, live, patch] of [
    ["tc", LIVE_TC_TAIL, mod.PATCH_STORE],
    ["rows", LIVE_OE, mod.PATCH_ROWS],
    ["seeAll", LIVE_M, mod.PATCH_SEE_ALL],
  ]) {
    let body = live;
    for (const p of o.patches || [patch]) {
      if (
        p.entry.test(
          { tc: "tizen-compat", rows: "genre-rows", seeAll: "row-see-all" }[
            name
          ],
        )
      ) {
        body = mod.applyPatch(body, p);
      }
    }
    mod.assertEs5Additions(body);
    bodies[name] = body;
  }

  const calls = [];
  const sandbox = {
    __ls: {
      getItem(k) {
        return Object.prototype.hasOwnProperty.call(backing, k)
          ? backing[k]
          : null;
      },
      setItem(k, v) {
        backing[k] = String(v);
      },
      removeItem(k) {
        delete backing[k];
      },
    },
    __library: o.library || LIBRARY,
    __calls: calls,
    __fail: !!o.fail,
    __malformed: !!o.malformed,
    __userId: o.userId || "u1",
    __out: null,
  };
  vm.createContext(sandbox);

  const src = `
    var win = { localStorage: __ls, Promise: Promise };
    // ---- tizen-compat ----
    (function (s) {
      var n = {};
      function M() { return { disabled: {} }; }
      ${bodies.tc}
      s.JellyPlug = n;
    })(win);

    // a shared util namespace standing in for the real one
    var UTIL = { safe: function (name, fn, fallback) {
      if (typeof name === "function") { fallback = fn; fn = name; }
      try { return fn(); } catch (err) { return fallback; }
    } };

    // A shared ApiClient stand-in. Every getGenres is one "request"; a query
    // with a SearchTerm filters, one without returns the whole library — which
    // is exactly what the real endpoint does.
    var API = {
      getCurrentUserId: function () { return __userId; },
      serverId: function () { return "srv-A"; },
      getGenres: function (uid, q) {
        __calls.push({ uid: uid, q: q });
        if (q.SearchTerm != null) {
          var want = String(q.SearchTerm).toLowerCase();
          var hits = [];
          for (var i = 0; i < __library.length; i++) {
            if (__library[i].toLowerCase().indexOf(want) !== -1) {
              hits.push({ Id: "g-" + __library[i].toLowerCase(), Name: __library[i] });
            }
          }
          return Promise.resolve({ Items: hits.slice(0, q.Limit) });
        }
        if (__fail) return Promise.reject(new Error("boom"));
        if (__malformed) return Promise.resolve({ nope: true });
        var all = [];
        for (var j = 0; j < __library.length && j < q.Limit; j++) {
          all.push({ Id: "g-" + __library[j].toLowerCase(), Name: __library[j] });
        }
        return Promise.resolve({ Items: all });
      }
    };

    // ---- genre-rows ----
    var GR = (function () {
      var d = win, n = UTIL, p = {};
      function K(items, name) {
        var want = String(name).toLowerCase();
        for (var i = 0; i < items.length; i++) {
          var it = items[i];
          if (String(it.Name).toLowerCase() === want) {
            return { id: String(it.Id), name: String(it.Name) };
          }
        }
        return null;
      }
      ${bodies.rows}
      return oe;
    })();

    // ---- row-see-all ----
    var RSA = (function () {
      var u = win, t = UTIL, m = {};
      function E(items, name) {
        var want = String(name).toLowerCase();
        for (var i = 0; i < items.length; i++) {
          var it = items[i];
          if (String(it.Name).toLowerCase() === want) {
            return { id: String(it.Id), name: String(it.Name) };
          }
        }
        return null;
      }
      ${bodies.seeAll}
      return M;
    })();

    __out = { rows: GR, seeAll: RSA, api: API, win: win };
  `;
  vm.runInContext(src, sandbox);
  return {
    rows: sandbox.__out.rows,
    seeAll: sandbox.__out.seeAll,
    api: sandbox.__out.api,
    win: sandbox.__out.win,
    calls,
    backing,
  };
}

/** Objects cross a vm realm boundary, so compare them structurally. */
function plain(x) {
  return x == null ? x : JSON.parse(JSON.stringify(x));
}

const searchTerms = (calls) =>
  calls.filter((c) => c.q.SearchTerm != null).map((c) => c.q.SearchTerm);
const bulkCalls = (calls) => calls.filter((c) => c.q.SearchTerm == null);

/** What the home asks for: one lookup per configured genre row. */
async function resolveAll(fn, api, names) {
  const out = [];
  for (const n of names) out.push(fn(api, n));
  return plain(await Promise.all(out));
}

async function main() {
  const mod = await import("file://" + path.join(HERE, "jsi-jp738-patch.mjs"));
  const { PATCHES, applyPatch, assertEs5Additions, FLAG_KEY, BULK_LIMIT } = mod;
  const jp682 = await import(
    "file://" + path.join(HERE, "jsi-jp682-patch.mjs")
  );

  // ---- 1) fail-closed on anchor drift -------------------------------------
  for (const patch of PATCHES) {
    assert.throws(
      () => applyPatch("nothing here", patch),
      /matched 0 times/,
      "a body without the anchor must throw",
    );
    const dup = patch.edits[0].from + "\n" + patch.edits[0].from;
    assert.throws(() => applyPatch(dup, patch), /matched 2 times/);
  }
  // The anchors must be present in the live bodies EXACTLY once, or the patch
  // silently stops applying the day the snippet is reformatted.
  applyPatch(LIVE_OE, mod.PATCH_ROWS);
  applyPatch(LIVE_M, mod.PATCH_SEE_ALL);
  applyPatch(LIVE_TC_TAIL, mod.PATCH_STORE);

  // ---- 2) ES5-only additions ----------------------------------------------
  for (const patch of PATCHES) {
    assertEs5Additions(patch.edits.map((e) => e.to).join("\n"));
  }
  assert.throws(
    () => assertEs5Additions("/*jp738*/const x = () => 1;"),
    /non-ES5/,
  );
  // Only the marked regions are ours: an arrow OUTSIDE a marker pair is
  // upstream's business and must not be blamed on this patch.
  assertEs5Additions("const upstream = () => 1; /*jp738*/var mine=1;/*jp738*/");

  // ---- 3) flag-dark --------------------------------------------------------
  {
    const b = boot(mod, { flagOn: false });
    const got = await resolveAll(b.rows, b.api, LIBRARY);
    assert.deepStrictEqual(
      searchTerms(b.calls),
      LIBRARY,
      "flag off: one SearchTerm query per name, exactly as shipped",
    );
    assert.strictEqual(bulkCalls(b.calls).length, 0, "flag off: no bulk read");
    assert.deepStrictEqual(got[0], { id: "g-action", name: "Action" });
    assert.deepStrictEqual(
      Object.keys(b.backing),
      [],
      "flag off: nothing persisted",
    );
  }

  // ---- 4) bulk: N names, ONE request --------------------------------------
  const shipped = await (async () => {
    const b = boot(mod, { flagOn: false });
    return resolveAll(b.rows, b.api, LIBRARY);
  })();
  {
    const b = boot(mod, {});
    const got = await resolveAll(b.rows, b.api, LIBRARY);
    assert.strictEqual(b.calls.length, 1, "flag on: 8 names cost ONE request");
    assert.strictEqual(
      searchTerms(b.calls).length,
      0,
      "flag on: no SearchTerm query",
    );
    assert.deepStrictEqual(
      got,
      shipped,
      "every name resolves to the same {id,name} the per-name query returned",
    );
    // Nothing is persisted: this lever is in-memory only, so it is immune to
    // the localStorage quota freeze that inverts persisted levers.
    assert.deepStrictEqual(Object.keys(b.backing), [FLAG_KEY]);
  }

  // ---- 5) shared with row-see-all -----------------------------------------
  {
    const b = boot(mod, {});
    const [byRows, bySeeAll] = await Promise.all([
      resolveAll(b.rows, b.api, LIBRARY),
      resolveAll(b.seeAll, b.api, LIBRARY),
    ]);
    assert.strictEqual(
      b.calls.length,
      1,
      "both modules ride the same in-flight read (JELA-683 double-resolve collapses)",
    );
    assert.deepStrictEqual(byRows, shipped);
    assert.deepStrictEqual(bySeeAll, shipped);
  }

  // ---- 6) request shape ----------------------------------------------------
  {
    const b = boot(mod, {});
    await resolveAll(b.rows, b.api, ["Action"]);
    const q = plain(b.calls[0].q);
    assert.deepStrictEqual(q, {
      Limit: BULK_LIMIT,
      Fields: "",
      EnableImages: false,
      EnableTotalRecordCount: false,
    });
    assert.strictEqual(
      plain(b.calls[0].uid),
      "u1",
      "the read is scoped to the user",
    );
  }

  // ---- 7) fallbacks: a row is never lost -----------------------------------
  for (const [label, opts] of [
    ["rejected bulk read", { fail: true }],
    ["malformed response", { malformed: true }],
    // A library at the limit may have been truncated, so it cannot be trusted
    // as a superset of the answers.
    [
      "response at the limit",
      {
        library: Array.from({ length: BULK_LIMIT }, (_, i) =>
          i ? `G${i}` : "Action",
        ),
      },
    ],
  ]) {
    const b = boot(mod, opts);
    const got = await resolveAll(b.rows, b.api, ["Action", "Comedy"]);
    assert.deepStrictEqual(
      searchTerms(b.calls),
      ["Action", "Comedy"],
      `${label}: falls back to the shipped per-name query`,
    );
    assert.deepStrictEqual(
      got[0],
      { id: "g-action", name: "Action" },
      `${label}: row resolves`,
    );
  }
  // A rejected read must not poison later lookups into a permanent fallback
  // loop: the next lookup is allowed to try the bulk read again.
  {
    const b = boot(mod, { fail: true });
    await resolveAll(b.rows, b.api, ["Action"]);
    assert.strictEqual(bulkCalls(b.calls).length, 1);
    await resolveAll(b.seeAll, b.api, ["Comedy"]);
    assert.strictEqual(
      bulkCalls(b.calls).length,
      2,
      "a failed read is retried, not cached",
    );
  }

  // ---- 8) user switch ------------------------------------------------------
  {
    const b = boot(mod, {});
    await resolveAll(b.rows, b.api, ["Action"]);
    assert.strictEqual(b.calls.length, 1);
    b.api.getCurrentUserId = () => "u2";
    await resolveAll(b.seeAll, b.api, ["Comedy"]);
    assert.strictEqual(b.calls.length, 2, "a new user id re-reads");
    assert.strictEqual(plain(b.calls[1].uid), "u2");
  }

  // ---- 9) composes with jp682, in either order -----------------------------
  for (const order of [
    ["jp738 then jp682", [...PATCHES, ...jp682.PATCHES]],
    ["jp682 then jp738", [...jp682.PATCHES, ...PATCHES]],
  ]) {
    const [label, patches] = order;
    const b = boot(mod, { patches });
    // Both markers survived, and both flag gates are independent.
    for (const body of [LIVE_OE, LIVE_M]) {
      const entry = body === LIVE_OE ? "genre-rows" : "row-see-all";
      let out = body;
      for (const p of patches)
        if (p.entry.test(entry)) out = applyPatch.call(null, out, p);
      assert.ok(
        out.includes("/*jp738*/"),
        `${label}: jp738 applied to ${entry}`,
      );
      assert.ok(
        out.includes("/*jp682*/"),
        `${label}: jp682 applied to ${entry}`,
      );
      mod.assertEs5Additions(out);
      jp682.assertEs5Additions(out);
      new vm.Script(out, { filename: entry });
    }
    // jp738 armed, jp682 dark: one bulk read, correct answers.
    const got = await resolveAll(b.rows, b.api, LIBRARY);
    assert.strictEqual(b.calls.length, 1, `${label}: still one request`);
    assert.deepStrictEqual(got, shipped, `${label}: still the shipped answers`);
  }

  console.log("jsi-jp738-patch.test.cjs: all checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
