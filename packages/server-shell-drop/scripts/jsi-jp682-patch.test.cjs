#!/usr/bin/env node
/*
 * jsi-jp682-patch.test.cjs — JELA-682 guard for jsi-jp682-patch.mjs.
 *
 * The patched snippets live only on the live JS-Injector channel (the
 * jellyplug-theme source repo is gone), so these edits are anchored text
 * replacements. That makes anchor drift the whole risk: an upstream snippet
 * edit that changes an anchor must fail LOUDLY at patch time, never silently
 * apply zero edits and ship the unpatched behaviour as if it were the fix.
 *
 * The lookup functions below (`oe` in genre-rows, `M` in row-see-all) are
 * copied VERBATIM from the live channel bodies, so an upstream change to
 * either one shows up here as a failing anchor rather than as a silent
 * no-op deploy. Their helpers (`K`/`E`, the util namespace, the ApiClient)
 * are reduced stand-ins — the patch does not depend on their internals, only
 * on their shapes.
 *
 * 1) FAIL-CLOSED: every anchor must match exactly once; zero or two throws.
 * 2) ES5: the added code must survive Chromium 63 / V8 6.3.
 * 3) FLAG-DARK: with the flag absent, every boot resolves the name over the
 *    network exactly as shipped, and nothing is written to localStorage.
 * 4) CACHE: with the flag on, boot 2 resolves the name with zero requests and
 *    returns the same {id,name} boot 1 got from the server.
 * 5) INVALIDATION: a different server id drops the whole map; an absent server
 *    id neither reads nor writes (and must not wipe a good map); entries past
 *    MAX_AGE_MS are re-resolved; a name that resolved to nothing is not cached.
 * 6) SHARING: row-see-all reads the map genre-rows filled — the second module
 *    that resolves the same names stops paying for them too.
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

// --- a localStorage that survives a "reboot" ---------------------------------
function makeLocalStorage(backing) {
  return {
    _b: backing,
    getItem(k) {
      return Object.prototype.hasOwnProperty.call(this._b, k) ? this._b[k] : null;
    },
    setItem(k, v) {
      this._b[k] = String(v);
    },
    removeItem(k) {
      delete this._b[k];
    },
  };
}

/**
 * Boot the three patched snippets in one sandbox against a shared localStorage
 * backing object. Returns the two lookup functions plus a request counter.
 * Each call is a fresh boot: new in-memory memos, new store instance, same
 * persisted map.
 */
function boot(mod, backing, opts) {
  const o = opts || {};
  const genres = o.genres || { action: { Id: "g-action", Name: "Action" } };
  const serverId = "serverId" in o ? o.serverId : "srv-A";

  const tc = mod.applyPatch(LIVE_TC_TAIL, mod.PATCH_STORE);
  const rows = mod.applyPatch(LIVE_OE, mod.PATCH_ROWS);
  const seeAll = mod.applyPatch(LIVE_M, mod.PATCH_SEE_ALL);
  for (const body of [tc, rows, seeAll]) mod.assertEs5Additions(body);

  const calls = [];
  const sandbox = {
    __ls: makeLocalStorage(backing),
    __genres: genres,
    __serverId: serverId,
    __calls: calls,
    __out: null,
  };
  vm.createContext(sandbox);

  const src = `
    var win = { localStorage: __ls, Promise: Promise };
    // ---- tizen-compat ----
    (function (s) {
      var n = {};
      function M() { return { disabled: {} }; }
      ${tc}
      s.JellyPlug = n;
    })(win);

    // a shared util namespace standing in for the real one
    var UTIL = { safe: function (name, fn, fallback) {
      if (typeof name === "function") { fallback = fn; fn = name; }
      try { return fn(); } catch (err) { return fallback; }
    } };

    // a shared ApiClient stand-in; every getGenres is a "request"
    var API = {
      getCurrentUserId: function () { return "u1"; },
      serverId: function () { return __serverId; },
      getGenres: function (uid, q) {
        __calls.push(q.SearchTerm);
        var hit = __genres[String(q.SearchTerm).toLowerCase()];
        return Promise.resolve({ Items: hit ? [hit] : [] });
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
      ${rows}
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
      ${seeAll}
      return M;
    })();

    __out = { rows: GR, seeAll: RSA, api: API };
  `;
  vm.runInContext(src, sandbox);
  return { rows: sandbox.__out.rows, seeAll: sandbox.__out.seeAll, api: sandbox.__out.api, calls };
}

/** Objects cross a vm realm boundary, so compare them structurally. */
function plain(x) {
  return x == null ? x : JSON.parse(JSON.stringify(x));
}

async function main() {
  const mod = await import("file://" + path.join(HERE, "jsi-jp682-patch.mjs"));
  const { PATCHES, applyPatch, assertEs5Additions, FLAG_KEY, STORE_KEY, MAX_AGE_MS } = mod;

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

  // ---- 2) ES5-only additions ----------------------------------------------
  for (const patch of PATCHES) {
    assertEs5Additions(patch.edits.map((e) => e.to).join("\n"));
  }
  assert.throws(() => assertEs5Additions("/*jp682*/const x = () => 1;"), /non-ES5/);
  // Only the marked regions are ours: an arrow OUTSIDE a marker pair is
  // upstream's business and must not be blamed on this patch.
  assertEs5Additions("const upstream = () => 1; /*jp682*/var mine=1;/*jp682*/");

  // ---- 3) flag-dark --------------------------------------------------------
  {
    const backing = {};
    for (let i = 0; i < 2; i++) {
      const b = boot(mod, backing);
      const got = await b.rows(b.api, "Action");
      assert.deepStrictEqual(plain(got), { id: "g-action", name: "Action" });
      assert.deepStrictEqual(plain(b.calls), ["Action"], "flag off: every boot resolves");
    }
    assert.deepStrictEqual(
      Object.keys(backing),
      [],
      "flag off: nothing is persisted",
    );
  }

  // ---- 4) cache hit on the second boot ------------------------------------
  {
    const backing = { [FLAG_KEY]: "1" };
    const b1 = boot(mod, backing);
    const first = await b1.rows(b1.api, "Action");
    assert.deepStrictEqual(plain(first), { id: "g-action", name: "Action" });
    assert.deepStrictEqual(plain(b1.calls), ["Action"], "first boot must resolve once");

    const b2 = boot(mod, backing);
    const second = await b2.rows(b2.api, "Action");
    assert.deepStrictEqual(plain(second), plain(first), "cached answer must match the server's");
    assert.deepStrictEqual(plain(b2.calls), [], "second boot must make zero requests");

    // and the in-boot memo still works on top of it
    await b2.rows(b2.api, "Action");
    assert.deepStrictEqual(plain(b2.calls), []);
  }

  // ---- 5a) a different server id drops the whole map ----------------------
  {
    const backing = { [FLAG_KEY]: "1" };
    const b1 = boot(mod, backing);
    await b1.rows(b1.api, "Action");

    const b2 = boot(mod, backing, { serverId: "srv-B", genres: { action: { Id: "b-action", Name: "Action" } } });
    const got = await b2.rows(b2.api, "Action");
    assert.deepStrictEqual(plain(b2.calls), ["Action"], "new server must re-resolve");
    assert.deepStrictEqual(plain(got), { id: "b-action", name: "Action" });

    const persisted = JSON.parse(backing[STORE_KEY]);
    assert.strictEqual(persisted.sid, "srv-B");
    assert.deepStrictEqual(
      Object.keys(persisted.m),
      ["action"],
      "the old server's ids must be dropped, not merged",
    );
    assert.strictEqual(persisted.m.action.v.id, "b-action");
  }

  // ---- 5b) an absent server id neither reads nor wipes ---------------------
  {
    const backing = { [FLAG_KEY]: "1" };
    const b1 = boot(mod, backing);
    await b1.rows(b1.api, "Action");
    const saved = backing[STORE_KEY];

    const b2 = boot(mod, backing, { serverId: null });
    await b2.rows(b2.api, "Action");
    assert.deepStrictEqual(plain(b2.calls), ["Action"], "no server id: must not serve from cache");
    assert.strictEqual(backing[STORE_KEY], saved, "no server id: must not touch the map");

    const b3 = boot(mod, backing);
    await b3.rows(b3.api, "Action");
    assert.deepStrictEqual(plain(b3.calls), [], "the good map survived the server-less boot");
  }

  // ---- 5c) stale entries are re-resolved ----------------------------------
  {
    const backing = { [FLAG_KEY]: "1" };
    const b1 = boot(mod, backing);
    await b1.rows(b1.api, "Action");

    const aged = JSON.parse(backing[STORE_KEY]);
    aged.m.action.t -= MAX_AGE_MS + 1000;
    backing[STORE_KEY] = JSON.stringify(aged);

    const b2 = boot(mod, backing);
    await b2.rows(b2.api, "Action");
    assert.deepStrictEqual(plain(b2.calls), ["Action"], "an entry past MAX_AGE_MS must re-resolve");
  }

  // ---- 5d) a name that resolved to nothing is not cached ------------------
  {
    const backing = { [FLAG_KEY]: "1" };
    const b1 = boot(mod, backing);
    const miss = await b1.rows(b1.api, "Nonesuch");
    assert.strictEqual(miss, null);

    const b2 = boot(mod, backing);
    await b2.rows(b2.api, "Nonesuch");
    assert.deepStrictEqual(
      b2.calls,
      ["Nonesuch"],
      "a negative result must not be remembered",
    );
  }

  // ---- 6) row-see-all shares the map genre-rows filled --------------------
  {
    const backing = { [FLAG_KEY]: "1" };
    const b1 = boot(mod, backing);
    await b1.rows(b1.api, "Action");
    assert.deepStrictEqual(plain(b1.calls), ["Action"]);

    const b2 = boot(mod, backing);
    const got = await b2.seeAll(b2.api, "Action");
    assert.deepStrictEqual(plain(got), { id: "g-action", name: "Action" });
    assert.deepStrictEqual(plain(b2.calls), [], "row-see-all must read the same map");
  }

  // row-see-all must also FILL it, for the boot order where it resolves first
  {
    const backing = { [FLAG_KEY]: "1" };
    const b1 = boot(mod, backing);
    await b1.seeAll(b1.api, "Action");
    const b2 = boot(mod, backing);
    await b2.rows(b2.api, "Action");
    assert.deepStrictEqual(plain(b2.calls), [], "genre-rows must read what row-see-all filled");
  }

  console.log("jsi-jp682-patch.test.cjs: all assertions passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
