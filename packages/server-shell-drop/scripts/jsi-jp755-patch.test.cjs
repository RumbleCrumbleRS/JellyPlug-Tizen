#!/usr/bin/env node
/*
 * jsi-jp755-patch.test.cjs — JELA-755 guard for jsi-jp755-patch.mjs.
 *
 * The patched snippets live only on the live JS-Injector channel (the
 * jellyplug-theme source repo is gone), so these edits are anchored text
 * replacements. Anchor drift is the whole risk: an upstream snippet edit that
 * changes an anchor must fail LOUDLY at patch time, never silently apply zero
 * edits and ship the unpatched behaviour as if it were the fix.
 *
 * The jp305 statements below are copied VERBATIM from the live channel bodies
 * (my-list / watch-it-again / top-picks / match-score), so an upstream change
 * to any of them shows up here as a failing anchor rather than a silent no-op
 * deploy. Their surroundings (route helpers, the util namespace, the latch
 * variables) are reduced stand-ins — the patch depends only on their shapes.
 *
 *  1) FAIL-CLOSED: every anchor must match exactly once; zero or two throws.
 *  2) ES5: the added code must survive Chromium 63 / V8 6.3.
 *  3) FLAG-DARK: with the flag absent, a Back press to home clears every
 *     latch exactly as shipped, and the reset counter proves the shipped
 *     path ran (JELA-690: an arm reporting 0 is discarded).
 *  4) NAVKEEP: with the flag on, the latch survives home re-entry, kept
 *     counts it, and nothing is reset.
 *  5) DIRTY (match-score): with the flag on, a user-data event rebuilds the
 *     taste profile; with the flag off the registration is inert.
 *  6) KILL SWITCH: removing the flag mid-session restores the shipped reset
 *     on the very next navigation — no reboot needed.
 *  7) ROUTING: patchConfig touches exactly the four intended entries and
 *     leaves look-alikes (mylist-nav) alone.
 */
"use strict";

const assert = require("node:assert");
const path = require("node:path");
const vm = require("node:vm");

const HERE = __dirname;

// --- verbatim from the live channel (the jp305 regions) ---------------------
const LIVE_MY_LIST =
  'var jp5h=I(s.location&&s.location.hash);/*jp305 revalidate on home re-entry*/F(),s.addEventListener&&s.addEventListener("hashchange",function(){var jp5n=I(s.location&&s.location.hash);jp5n&&!jp5h&&(B=!1,E=null),jp5h=jp5n,F()});';

const LIVE_WIA =
  'var jp5h=T(c.location&&c.location.hash);/*jp305 revalidate on home re-entry*/q(),c.addEventListener&&c.addEventListener("hashchange",function(){var jp5n=T(c.location&&c.location.hash);jp5n&&!jp5h&&(K=!1,U=null),jp5h=jp5n,q()});';

const LIVE_TOP_PICKS =
  'var jp5h=U(c.location&&c.location.hash);/*jp305 revalidate on home re-entry*/z(),c.addEventListener&&c.addEventListener("hashchange",function(){var jp5n=U(c.location&&c.location.hash);jp5n&&!jp5h&&(j=!1,M=!1,_=null),jp5h=jp5n,z()});';

const LIVE_MATCH_SCORE =
  'jpH345=jpHome345(b.location&&b.location.hash),/*jp305*/b.addEventListener&&b.addEventListener("hashchange",function(){var jpN=jpHome345(b.location&&b.location.hash);jpN&&!jpH345&&jpRst345("home re-entry"),jpH345=jpN,D()},!1),D();';

const LIVE_HRL =
  's.addEventListener&&s.addEventListener("hashchange",function(){jpForget(),h()},!1),h();';

/** A window stand-in with a working hashchange bus and localStorage. */
const WIN_SRC = `
  function makeWin(flagBacking) {
    var listeners = [];
    var win = {
      location: { hash: "#!/home.html" },
      addEventListener: function (ev, fn) {
        if (ev === "hashchange") listeners.push(fn);
      },
      localStorage: {
        getItem: function (k) {
          return Object.prototype.hasOwnProperty.call(flagBacking, k)
            ? flagBacking[k]
            : null;
        },
        setItem: function (k, v) { flagBacking[k] = String(v); },
        removeItem: function (k) { delete flagBacking[k]; },
      },
      go: function (hash) {
        win.location.hash = hash;
        for (var i = 0; i < listeners.length; i++) listeners[i]();
      },
    };
    return win;
  }
  function isHome(h) {
    if (h == null) return true;
    var e = String(h).replace(/^#!?\\/*/, "").toLowerCase();
    var q = e.indexOf("?");
    if (q !== -1) e = e.slice(0, q);
    return e === "" || e === "home" || e === "home.html";
  }
`;

/**
 * Boot one row module's jp305 region (patched or not) in a sandbox.
 * Returns { win, state } where state exposes the latch and call log.
 */
function bootRow(mod, live, gate, opts) {
  const o = opts || {};
  const backing = {};
  if (o.flagOn) backing[mod.FLAG_KEY] = "1";
  const body = o.patched ? mod.applyPatch('"use strict";' + live, gate) : '"use strict";' + live;
  mod.assertEs5Additions(body);
  const sandbox = { __backing: backing, __out: null };
  vm.createContext(sandbox);
  // The latch stand-ins mirror each module's real shape: fetched?=true plus a
  // non-null promise latch. F/q/z apply stubs count invocations.
  vm.runInContext(
    WIN_SRC +
      `
    var win = makeWin(__backing);
    __out = (function (s) {
      var c = s, b = s;                      // alias: the modules differ only in name
      var B = true,  E = { p: 1 };           // my-list latch shape
      var K = true,  U = { p: 1 };           // watch-it-again latch shape
      var j = true,  M = true, _ = { p: 1 }; // top-picks latch shape
      var applies = 0;
      function I(h) { return isHome(h); }
      function T(h) { return isHome(h); }
      function U2(h) { return isHome(h); }
      // top-picks calls its route helper U; alias it without colliding with the latch U
      function F() { applies++; }
      function q() { applies++; }
      function z() { applies++; }
      ${body.replace("U(c.location&&c.location.hash)", "U2(c.location&&c.location.hash)").replace("var jp5n=U(c.location", "var jp5n=U2(c.location")}
      return {
        latch: function () { return { B: B, E: E, K: K, U: U, j: j, M: M, _: _ }; },
        applies: function () { return applies; },
      };
    })(win);
  `,
    sandbox,
  );
  return { win: vm.runInContext("win", sandbox), state: sandbox.__out, backing };
}

/** Boot the match-score jp305 region with jpRst345/onUserData observability. */
function bootMatchScore(mod, opts) {
  const o = opts || {};
  const backing = {};
  if (o.flagOn) backing[mod.FLAG_KEY] = "1";
  let body = '"use strict";' + LIVE_MATCH_SCORE;
  if (o.patched) body = mod.applyPatch(body, mod.PATCH_MATCH_SCORE);
  mod.assertEs5Additions(body);
  const sandbox = { __backing: backing, __out: null };
  vm.createContext(sandbox);
  vm.runInContext(
    WIN_SRC +
      `
    var win = makeWin(__backing);
    __out = (function (b) {
      var jpH345;
      var resets = [];
      var udCbs = [];
      var applies = 0;
      function jpHome345(h) { return isHome(h); }
      function jpRst345(why) { resets.push(why); }
      function D() { applies++; }
      var e = {
        onUserData: function (cb, label) { udCbs.push(cb); return function () {}; },
      };
      ${body}
      return {
        resets: resets,
        applies: function () { return applies; },
        fireUserData: function (why) {
          for (var i = 0; i < udCbs.length; i++) udCbs[i](why);
        },
        udCount: function () { return udCbs.length; },
      };
    })(win);
  `,
    sandbox,
  );
  return { win: vm.runInContext("win", sandbox), state: sandbox.__out, backing };
}

function plain(x) {
  return x == null ? x : JSON.parse(JSON.stringify(x));
}

async function main() {
  const mod = await import("file://" + path.join(HERE, "jsi-jp755-patch.mjs"));
  const { PATCHES, applyPatch, assertEs5Additions, FLAG_KEY } = mod;

  // ---- 1) fail-closed on anchor drift -------------------------------------
  for (const patch of PATCHES) {
    assert.throws(
      () => applyPatch("nothing here", patch),
      /matched 0 times/,
      "a body without the anchor must throw",
    );
    const dup =
      '"use strict";"use strict";' +
      patch.edits[1].from +
      patch.edits[1].from;
    assert.throws(() => applyPatch(dup, patch), /matched 2 times/);
  }
  // The anchors must be present in the live jp305 regions EXACTLY once, or
  // the patch silently stops applying the day a snippet is reformatted.
  applyPatch('"use strict";' + LIVE_MY_LIST, mod.PATCH_MY_LIST);
  applyPatch('"use strict";' + LIVE_WIA, mod.PATCH_WATCH_IT_AGAIN);
  applyPatch('"use strict";' + LIVE_TOP_PICKS, mod.PATCH_TOP_PICKS);
  applyPatch('"use strict";' + LIVE_MATCH_SCORE, mod.PATCH_MATCH_SCORE);

  // ---- 2) ES5-only additions ----------------------------------------------
  for (const patch of PATCHES) {
    assertEs5Additions(patch.edits.map((e) => e.to).join("\n"));
  }
  assert.throws(
    () => assertEs5Additions("/*jp755*/const x = () => 1;/*jp755*/"),
    /non-ES5/,
  );
  assertEs5Additions("const upstream = () => 1; /*jp755*/var mine=1;/*jp755*/");

  // ---- 3+4+6) the three row modules ---------------------------------------
  const rows = [
    ["my-list", LIVE_MY_LIST, mod.PATCH_MY_LIST, (l) => l.B === false && l.E === null],
    ["watch-it-again", LIVE_WIA, mod.PATCH_WATCH_IT_AGAIN, (l) => l.K === false && l.U === null],
    ["top-picks", LIVE_TOP_PICKS, mod.PATCH_TOP_PICKS, (l) => l.j === false && l.M === false && l._ === null],
  ];
  for (const [name, live, gate, isReset] of rows) {
    // flag off, patched: shipped behaviour, reset counted
    {
      const b = bootRow(mod, live, gate, { patched: true, flagOn: false });
      b.win.go("#!/details?id=x");
      b.win.go("#!/home.html");
      assert.ok(isReset(plain(b.state.latch())), `${name}: flag off resets the latch as shipped`);
      const st = plain(b.win.__jp755);
      assert.deepStrictEqual(st[name], { kept: 0, reset: 1 }, `${name}: reset counted`);
    }
    // flag on, patched: latch survives, kept counted
    {
      const b = bootRow(mod, live, gate, { patched: true, flagOn: true });
      b.win.go("#!/details?id=x");
      b.win.go("#!/home.html");
      assert.ok(!isReset(plain(b.state.latch())), `${name}: flag on keeps the latch`);
      const st = plain(b.win.__jp755);
      assert.deepStrictEqual(st[name], { kept: 1, reset: 0 }, `${name}: kept counted`);
      assert.ok(b.state.applies() >= 2, `${name}: the apply still runs on re-entry`);
    }
    // kill switch: works on the NEXT navigation, no reboot
    {
      const b = bootRow(mod, live, gate, { patched: true, flagOn: true });
      b.win.go("#!/details?id=x");
      b.win.go("#!/home.html");
      assert.ok(!isReset(plain(b.state.latch())), `${name}: armed leg keeps`);
      b.win.localStorage.removeItem(FLAG_KEY);
      b.win.go("#!/details?id=y");
      b.win.go("#!/home.html");
      assert.ok(isReset(plain(b.state.latch())), `${name}: kill switch restores the shipped reset`);
      const st = plain(b.win.__jp755);
      assert.deepStrictEqual(st[name], { kept: 1, reset: 1 }, `${name}: both legs counted`);
    }
    // unpatched sanity: the live region still behaves as shipped
    {
      const b = bootRow(mod, live, gate, { patched: false });
      b.win.go("#!/details?id=x");
      b.win.go("#!/home.html");
      assert.ok(isReset(plain(b.state.latch())), `${name}: unpatched region resets`);
      assert.strictEqual(b.win.__jp755, undefined, `${name}: unpatched leaves no marker`);
    }
  }

  // ---- 3+4+5+6) match-score ------------------------------------------------
  // flag off, patched: shipped reset on re-entry; dirty registration inert
  {
    const b = bootMatchScore(mod, { patched: true, flagOn: false });
    b.win.go("#!/details?id=x");
    b.win.go("#!/home.html");
    assert.deepStrictEqual(plain(b.state.resets), ["home re-entry"], "ms: flag off resets as shipped");
    b.state.fireUserData("markPlayed");
    assert.strictEqual(plain(b.state.resets).length, 1, "ms: flag off — dirty signal inert");
    assert.deepStrictEqual(plain(b.win.__jp755)["match-score"], { kept: 0, reset: 1 });
  }
  // flag on, patched: no re-entry reset; dirty signal rebuilds the profile
  {
    const b = bootMatchScore(mod, { patched: true, flagOn: true });
    b.win.go("#!/details?id=x");
    b.win.go("#!/home.html");
    assert.deepStrictEqual(plain(b.state.resets), [], "ms: flag on keeps the profile");
    assert.strictEqual(b.state.udCount(), 1, "ms: dirty signal registered once");
    b.state.fireUserData("updateFavoriteStatus");
    assert.deepStrictEqual(
      plain(b.state.resets),
      ["user data changed (updateFavoriteStatus)"],
      "ms: flag on — user-data change rebuilds the profile",
    );
    assert.deepStrictEqual(plain(b.win.__jp755)["match-score"], { kept: 1, reset: 0 });
  }
  // kill switch
  {
    const b = bootMatchScore(mod, { patched: true, flagOn: true });
    b.win.go("#!/details?id=x");
    b.win.go("#!/home.html");
    assert.deepStrictEqual(plain(b.state.resets), []);
    b.win.localStorage.removeItem(FLAG_KEY);
    b.win.go("#!/details?id=y");
    b.win.go("#!/home.html");
    assert.deepStrictEqual(plain(b.state.resets), ["home re-entry"], "ms: kill switch restores");
  }
  // unpatched sanity
  {
    const b = bootMatchScore(mod, { patched: false });
    b.win.go("#!/details?id=x");
    b.win.go("#!/home.html");
    assert.deepStrictEqual(plain(b.state.resets), ["home re-entry"]);
    assert.strictEqual(b.state.udCount(), 0, "ms: unpatched registers nothing");
  }

  // ---- 3+4+5+6) home-resume-left -------------------------------------------
  function bootHrl(opts) {
    const o = opts || {};
    const backing = {};
    if (o.flagOn) backing[FLAG_KEY] = "1";
    let body = '"use strict";' + LIVE_HRL;
    if (o.patched) body = applyPatch(body, mod.PATCH_HOME_RESUME_LEFT);
    assertEs5Additions(body);
    const sandbox = { __backing: backing, __out: null };
    vm.createContext(sandbox);
    vm.runInContext(
      WIN_SRC +
        `
      var win = makeWin(__backing);
      __out = (function (s) {
        var forgets = 0, applies = 0, udCbs = [];
        function jpForget() { forgets++; }
        function h() { applies++; }
        var e = { onUserData: function (cb) { udCbs.push(cb); return function () {}; } };
        ${body}
        return {
          forgets: function () { return forgets; },
          applies: function () { return applies; },
          udCount: function () { return udCbs.length; },
          fireUserData: function () { for (var i = 0; i < udCbs.length; i++) udCbs[i]("x"); },
        };
      })(win);
    `,
      sandbox,
    );
    return { win: vm.runInContext("win", sandbox), state: sandbox.__out, backing };
  }
  {
    // flag off, patched: every hashchange still forgets, exactly as shipped
    const b = bootHrl({ patched: true, flagOn: false });
    b.win.go("#!/details?id=x");
    b.win.go("#!/home.html");
    assert.strictEqual(b.state.forgets(), 2, "hrl: flag off forgets on every hashchange");
    b.state.fireUserData();
    assert.strictEqual(b.state.forgets(), 2, "hrl: flag off — dirty signal inert");
    assert.deepStrictEqual(plain(b.win.__jp755)["home-resume-left"], { kept: 0, reset: 2 });
  }
  {
    // flag on, patched: cache survives navigation; dirty signal forgets
    const b = bootHrl({ patched: true, flagOn: true });
    b.win.go("#!/details?id=x");
    b.win.go("#!/home.html");
    assert.strictEqual(b.state.forgets(), 0, "hrl: flag on keeps the cache");
    assert.ok(b.state.applies() >= 3, "hrl: apply still runs per hashchange");
    b.state.fireUserData();
    assert.strictEqual(b.state.forgets(), 1, "hrl: flag on — user-data change forgets");
    assert.deepStrictEqual(plain(b.win.__jp755)["home-resume-left"], { kept: 2, reset: 0 });
  }
  {
    // kill switch
    const b = bootHrl({ patched: true, flagOn: true });
    b.win.go("#!/home.html");
    assert.strictEqual(b.state.forgets(), 0);
    b.win.localStorage.removeItem(FLAG_KEY);
    b.win.go("#!/details?id=y");
    assert.strictEqual(b.state.forgets(), 1, "hrl: kill switch restores the shipped forget");
  }
  {
    // unpatched sanity
    const b = bootHrl({ patched: false });
    b.win.go("#!/home.html");
    assert.strictEqual(b.state.forgets(), 1);
    assert.strictEqual(b.state.udCount(), 0, "hrl: unpatched registers nothing");
  }

  // ---- 7) patchConfig routes to exactly the right entries ------------------
  {
    const mk = (name, body) => ({ Name: name, Script: body });
    const cfg = {
      CustomJavaScripts: [
        mk("JellyPlug — my-list", '"use strict";' + LIVE_MY_LIST),
        mk("JellyPlug — mylist-nav", "var untouched=1;"),
        mk("JellyPlug — watch-it-again", '"use strict";' + LIVE_WIA),
        mk("JellyPlug — top-picks", '"use strict";' + LIVE_TOP_PICKS),
        mk("JellyPlug — match-score", '"use strict";' + LIVE_MATCH_SCORE),
        mk("JellyPlug — home-resume-left", '"use strict";' + LIVE_HRL),
        mk("JellyPlug — resume-cover-art", "var untouched=3;"),
        mk("JellyPlug — row-see-all", "var untouched=2;"),
      ],
    };
    const report = mod.patchConfig(cfg);
    assert.strictEqual(report.length, 5);
    assert.deepStrictEqual(
      report.map((r) => r.name).sort(),
      [
        "JellyPlug — home-resume-left",
        "JellyPlug — match-score",
        "JellyPlug — my-list",
        "JellyPlug — top-picks",
        "JellyPlug — watch-it-again",
      ],
    );
    assert.strictEqual(cfg.CustomJavaScripts[1].Script, "var untouched=1;");
    assert.strictEqual(cfg.CustomJavaScripts[6].Script, "var untouched=3;");
    assert.strictEqual(cfg.CustomJavaScripts[7].Script, "var untouched=2;");
    for (const r of report) assert.ok(r.delta > 0, `${r.name}: grew`);
  }

  console.log("jsi-jp755-patch.test.cjs: all checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
