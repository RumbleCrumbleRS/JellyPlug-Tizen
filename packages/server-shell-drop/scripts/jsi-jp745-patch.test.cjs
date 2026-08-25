#!/usr/bin/env node
/*
 * jsi-jp745-patch.test.cjs — JELA-745 guard for jsi-jp745-patch.mjs.
 *
 * The patched snippets live only on the live JS-Injector channel (the
 * jellyplug-theme source repo is gone), so these edits are anchored text
 * replacements. That makes anchor drift the whole risk: an upstream snippet
 * edit that changes an anchor must fail LOUDLY at patch time, never silently
 * apply zero edits and ship the unpatched behaviour as if it were the fix.
 *
 * The six anchor strings below are copied VERBATIM from the live channel
 * bodies. Everything AROUND them is a reduced stand-in: this patch does not
 * touch any module's internals, it only adds one call to an apply function
 * that already exists, so what has to be proven is the CALL — when it happens,
 * how often, and what happens when it cannot.
 *
 * The stand-in module reproduces the four properties JELA-744 established for
 * all five real modules: a route guard on the first line of the apply, a
 * user-id read that returns null until the session resolves, a module-level
 * fetch latch, and a 300 ms debounce that calls the same apply. That is the
 * whole mechanism the patch exploits.
 *
 *   1) FAIL-CLOSED: every anchor must match exactly once; zero or two throws.
 *   2) ES5: the added code must survive Chromium 63 / V8 6.3.
 *   3) FLAG-DARK: with the flag absent nothing is registered, NO timer is
 *      created, and the query still goes out on the debounce exactly as
 *      shipped.
 *   4) PREFETCH: with the flag on the query goes out when the user id appears,
 *      not when the DOM goes quiet.
 *   5) ONE REQUEST: prefetching does not add a request — the module's own
 *      latch answers the debounced apply that runs later.
 *   6) MOUNT UNCHANGED: the row still mounts on the debounced apply, after the
 *      container exists. Fetch is decoupled from mount; mount is not moved.
 *   7) AC1 IN MINIATURE: all five modules issue in ONE round rather than one
 *      per debounce hop.
 *   8) OFF-HOME: a deep link fetches nothing, flag on or off.
 *   9) PRE-AUTH: with no session the poll gives up at the ceiling instead of
 *      spinning, and no request is made.
 *  10) USER SWITCH: the shipped user-change reset still refetches.
 *  11) IDEMPOTENT: a duplicate arm is refused; a module cannot double-fetch.
 *  11b) HELD BACK: top10-badges is defined and pinned but NOT applied — a
 *      matched warm rig pair measured its query moving 5,693 -> 12,005 ms.
 *  12) COMPOSES: jp738 and jp745 apply to tizen-compat in EITHER order.
 */
"use strict";

const assert = require("node:assert");
const path = require("node:path");
const vm = require("node:vm");

const HERE = __dirname;

// --- verbatim from the live channel -----------------------------------------
// The tail of tizen-compat's IIFE, where the namespace is published. `s` is
// window and `n` is the JellyPlug namespace, exactly as in the live snippet.
const LIVE_TC_TAIL = "n.__compatReady=!0,s.JellyPlug=n,";

// jp738's tizen-compat anchor, used only by the composition test.
const LIVE_TC_JP738 = "var B=M(),Y=[];for(var Q in B.disabled)";

/**
 * The five row modules, as the live channel spells them.
 *
 *   win    that snippet's window binding
 *   ns     that snippet's JellyPlug-util binding
 *   apply  the module's own apply function, which the debounce calls
 *   guard  the "row is busy" flag the onMutation callback checks
 *   deb    the module's 300 ms debounce entry point
 *   anchor VERBATIM from the live body
 */
const MODULES = [
  {
    key: "watch-it-again",
    patch: "PATCH_AGAIN",
    win: "c",
    ns: "t",
    apply: "q",
    guard: "b",
    deb: "fe",
    loadCall: true,
    anchor:
      'function de(){b||fe()}if(t.onMutation)t.onMutation(de,"watch-it-again")',
  },
  {
    key: "top-picks",
    patch: "PATCH_PICKS",
    win: "c",
    ns: "t",
    apply: "z",
    guard: "O",
    deb: "Se",
    loadCall: true,
    anchor:
      'function Ce(){O||Se()}if(t.onMutation)t.onMutation(Ce,"top-picks")',
  },
  {
    key: "my-list",
    patch: "PATCH_MYLIST",
    win: "s",
    ns: "t",
    apply: "F",
    guard: "T",
    deb: "ne",
    loadCall: true,
    anchor: 'function ae(){T||ne()}if(t.onMutation)t.onMutation(ae,"my-list")',
  },
  {
    key: "top10-badges",
    patch: "PATCH_TOP10",
    win: "g",
    ns: "r",
    apply: "X",
    guard: "R",
    deb: "V",
    loadCall: true,
    anchor:
      'function Se(){R||V()}if(r.onMutation)r.onMutation(Se,"top10-badges")',
  },
  {
    // genre-rows registers an inline callback and makes its load-time apply
    // call inside the same expression, so the anchor carries the call itself.
    key: "genre-rows",
    patch: "PATCH_GENRES",
    win: "d",
    ns: "n",
    apply: "Z",
    guard: null,
    deb: "W",
    loadCall: false,
    anchor: 'if(Z(),n.onMutation)n.onMutation(function(){W()},"genre-rows")',
  },
];

/**
 * A reduced module body carrying the VERBATIM anchor.
 *
 * Everything here mirrors the shipped shape that matters to this patch:
 * the apply short-circuits off the home route, returns before the latch while
 * `getCurrentUserId()` is null, memoizes its request, resets that memo when
 * the user id changes, and mounts only once a container exists.
 */
function moduleSrc(m, tail) {
  const guardDecl = m.guard ? `var ${m.guard}=!1;` : "";
  return (
    `(function(${m.win}){"use strict";` +
    `var ${m.ns}=${m.win}.__ns;` +
    guardDecl +
    `var L=null,U=null,st={key:${JSON.stringify(m.key)},applied:0,fetched:0,fetchedAt:[],mounted:-1};` +
    `${m.win}.__stats=st;` +
    // the module's 300 ms debounce, verbatim in shape
    `function ${m.deb}(){${m.win}.setTimeout(function(){${m.apply}()},300)}` +
    `function ${m.apply}(){` +
    `st.applied++;` +
    `if(!${m.win}.__home)return;` + // route guard, first line, as shipped
    `var api=${m.win}.ApiClient;if(!api)return;` +
    `var u=api.getCurrentUserId();if(!u)return;` +
    `if(U!==null&&U!==u){L=null}U=u;` +
    `if(!L){L=api.getItems(u);st.fetched++;st.fetchedAt.push(${m.win}.__now())}` +
    `if(!L||typeof L.then!="function")return;` +
    `L.then(function(items){if(${m.win}.__container)st.mounted=items.length})` +
    `}` +
    (m.loadCall ? `${m.apply}();` : "") +
    tail +
    `})(GLOBAL)`
  );
}

/**
 * A virtual clock. The store polls on setTimeout, the modules debounce on
 * setTimeout, and the whole claim is about ORDER — so time has to be driven,
 * not waited on. Microtasks are still real; `flush()` drains them.
 */
function makeClock() {
  let now = 0;
  let seq = 0;
  const q = [];
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = ++seq;
      q.push({ id, at: now + (ms | 0), fn });
      return id;
    },
    clearTimeout(id) {
      const i = q.findIndex((t) => t.id === id);
      if (i >= 0) q.splice(i, 1);
    },
    pending: () => q.length,
    /** Advance to `to`, running every timer due on the way. */
    async advance(to, flush) {
      for (;;) {
        q.sort((a, b) => a.at - b.at || a.id - b.id);
        if (!q.length || q[0].at > to) break;
        const t = q.shift();
        now = t.at;
        t.fn();
        await flush();
      }
      now = to;
      await flush();
    },
  };
}

const flush = () => new Promise((r) => setImmediate(r));

/**
 * Boot tizen-compat's tail plus the five row modules in one sandbox.
 *
 * `opts.flagOn`      arm the patch (default true)
 * `opts.uidAt`       virtual ms at which getCurrentUserId() starts answering
 *                    (null = never, i.e. pre-auth)
 * `opts.home`        home route (default true)
 * `opts.only`        restrict to a subset of module keys
 * `opts.patched`     apply the patch at all (default true)
 */
function boot(mod, opts) {
  const o = opts || {};
  const flagOn = o.flagOn !== false;
  const clock = makeClock();

  const calls = [];
  let uid = "";
  let container = false;

  const store = flagOn ? { [mod.FLAG_KEY]: "1" } : {};
  const GLOBAL = {
    localStorage: {
      getItem: (k) =>
        Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null,
    },
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (id) => clock.clearTimeout(id),
    __now: () => clock.now(),
    get __home() {
      return o.home !== false;
    },
    get __container() {
      return container;
    },
    ApiClient: {
      getCurrentUserId: () => uid,
      getItems: (u) => {
        calls.push({ uid: u, at: clock.now() });
        return Promise.resolve([{ Id: "a" }, { Id: "b" }]);
      },
    },
  };

  const ctx = vm.createContext({ GLOBAL, Promise, String, Object, Error });

  // tizen-compat: publish the namespace, with or without the store. Capturing
  // the onMutation callbacks is what lets a test drive the REAL debounce
  // cascade — a harness that never fires it would pass tests 3/5/6/10 for the
  // wrong reason.
  const cbs = [];
  const ns = {
    onMutation(fn) {
      cbs.push(fn);
    },
  };
  const tcSrc =
    `(function(s,n){"use strict";` +
    (o.patched === false
      ? `var _x=(${LIVE_TC_TAIL}0);`
      : `var _x=(${mod.applyPatch(LIVE_TC_TAIL + "0", mod.PATCH_STORE)});`) +
    `})(GLOBAL,GLOBAL.__ns)`;
  GLOBAL.__ns = ns;
  new vm.Script(tcSrc, { filename: "tizen-compat.js" }).runInContext(ctx);

  const stats = {};
  const wanted = MODULES.filter((m) => !o.only || o.only.indexOf(m.key) >= 0);
  for (const m of wanted) {
    const tail =
      o.patched === false ? m.anchor : mod.applyPatch(m.anchor, mod[m.patch]);
    new vm.Script(moduleSrc(m, tail), { filename: `${m.key}.js` }).runInContext(
      ctx,
    );
    stats[m.key] = GLOBAL.__stats;
  }

  return {
    clock,
    calls,
    stats,
    prefetch: () => GLOBAL.JellyPlug && GLOBAL.JellyPlug.rowPrefetch,
    login(at) {
      clock.setTimeout(() => {
        uid = o.uidValue || "u1";
      }, at - clock.now());
    },
    setUid(v) {
      uid = v;
    },
    showContainer() {
      container = true;
    },
    registered: () => cbs.length,
    /**
     * One hop of the debounce cascade: the body MutationObserver fires, every
     * registered module callback runs, each schedules its own 300 ms timer.
     * `await`ing past that timer is what delivers the apply.
     */
    async hop() {
      for (const fn of cbs) fn();
      await clock.advance(clock.now() + 301, flush);
    },
  };
}

/* -------------------------------------------------------------------------- */

let failures = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("1) fail-closed: a missing or duplicated anchor throws", async (mod) => {
  for (const m of MODULES) {
    assert.throws(
      () => mod.applyPatch("nothing here", mod[m.patch]),
      /matched 0 times/,
      `${m.key}: missing anchor must throw`,
    );
    assert.throws(
      () => mod.applyPatch(m.anchor + ";" + m.anchor, mod[m.patch]),
      /matched 2 times/,
      `${m.key}: duplicated anchor must throw`,
    );
    // ...and the happy path is a real edit, not a no-op.
    const out = mod.applyPatch(m.anchor, mod[m.patch]);
    assert.notStrictEqual(
      out,
      m.anchor,
      `${m.key}: patch must change the body`,
    );
    assert.ok(out.indexOf("/*jp745*/") >= 0, `${m.key}: marker missing`);
  }
  assert.throws(
    () => mod.applyPatch("nope", mod.PATCH_STORE),
    /matched 0 times/,
  );
});

test("1b) fail-closed: patchConfig rejects a channel missing an entry", async (mod) => {
  assert.throws(
    () => mod.patchConfig({ CustomJavaScripts: [] }),
    /matched 0 channel entries/,
  );
  assert.throws(
    () =>
      mod.patchConfig({
        CustomJavaScripts: [
          { Name: "tizen-compat", Script: LIVE_TC_TAIL + "0;" },
          { Name: "tizen-compat (dupe)", Script: LIVE_TC_TAIL + "0;" },
        ],
      }),
    /matched 2 channel entries/,
  );
});

test("2) ES5: the added code survives Chromium 63", async (mod) => {
  for (const m of MODULES) {
    const out = mod.applyPatch(m.anchor, mod[m.patch]);
    mod.assertEs5Additions(out);
    new vm.Script(moduleSrc(m, out), { filename: `${m.key}.js` });
  }
  const tc = mod.applyPatch(LIVE_TC_TAIL + "0", mod.PATCH_STORE);
  mod.assertEs5Additions(tc);
  new vm.Script(`(function(s,n){var _x=(${tc});})`);

  // The guard only credits code between our own markers.
  assert.throws(
    () => mod.assertEs5Additions("let a=1;/*jp745*/const b=()=>2;/*jp745*/"),
    /non-ES5/,
  );
  mod.assertEs5Additions("let a=1;/*jp745*/var b=2;/*jp745*/");
});

test("3) flag-dark: nothing registers, no timer, shipped timing survives", async (mod) => {
  const h = boot(mod, { flagOn: false });
  assert.strictEqual(h.prefetch().on(), false, "flag must read off");
  assert.strictEqual(
    h.prefetch().stats().fired,
    0,
    "flag-dark must fire nothing",
  );
  assert.strictEqual(
    h.prefetch().stats().mods.length,
    0,
    "flag-dark must register nothing",
  );
  assert.strictEqual(
    h.clock.pending(),
    0,
    "flag-dark must create no poll timer",
  );

  assert.strictEqual(
    h.registered(),
    MODULES.length,
    "every module must still register with the debounce",
  );

  // The session resolves, but with the flag off nothing notices until the
  // debounce cascade calls the apply again.
  h.setUid("u1");
  await h.clock.advance(2000, flush);
  assert.strictEqual(h.calls.length, 0, "flag-dark must not prefetch");

  // The shipped path still works, unchanged: one hop, one query per module.
  await h.hop();
  assert.strictEqual(
    h.calls.length,
    MODULES.length,
    "flag-dark must still fetch on the debounce hop",
  );
  for (const m of MODULES) {
    assert.strictEqual(h.stats[m.key].fetched, 1, `${m.key}: exactly one`);
  }
});

test("4) prefetch: the query goes out when the user id appears", async (mod) => {
  const h = boot(mod, {});
  assert.strictEqual(h.prefetch().on(), true);
  assert.strictEqual(
    h.prefetch().stats().mods.length,
    MODULES.length,
    "every module must register",
  );

  await h.clock.advance(500, flush);
  assert.strictEqual(h.calls.length, 0, "no session yet: no query");

  h.login(1500);
  await h.clock.advance(1499, flush);
  assert.strictEqual(h.calls.length, 0, "still no session: no query");

  await h.clock.advance(1600, flush);
  assert.strictEqual(
    h.calls.length,
    MODULES.length,
    "every module must query once the id exists",
  );
  assert.strictEqual(h.prefetch().stats().fired, MODULES.length);
  for (const c of h.calls) {
    assert.strictEqual(c.uid, "u1");
    assert.ok(
      c.at <= 1500 + mod.POLL_MS,
      `query at ${c.at} ms must land within one poll step of the login`,
    );
  }
});

test("5) one request: the module latch answers the later debounced apply", async (mod) => {
  const h = boot(mod, {});
  h.login(1000);
  await h.clock.advance(1100, flush);
  assert.strictEqual(h.calls.length, MODULES.length);

  // Now let the debounce cascade run, repeatedly, as it does on a real boot.
  for (let i = 0; i < 5; i++) await h.hop();
  assert.strictEqual(
    h.calls.length,
    MODULES.length,
    "prefetch must not add a request",
  );
  for (const m of MODULES) {
    assert.ok(
      h.stats[m.key].applied > 5,
      `${m.key}: the debounced apply must still be running`,
    );
    assert.strictEqual(h.stats[m.key].fetched, 1, `${m.key}: one fetch only`);
  }
});

test("6) mount unchanged: the row still mounts once the container exists", async (mod) => {
  const h = boot(mod, {});
  h.login(1000);
  await h.clock.advance(1100, flush);
  for (const m of MODULES) {
    assert.strictEqual(
      h.stats[m.key].mounted,
      -1,
      `${m.key}: must not mount before the container exists`,
    );
    assert.strictEqual(h.stats[m.key].fetched, 1, `${m.key}: fetched once`);
  }

  // The container appears; the shipped debounced apply mounts from the latch,
  // with no new request. That is the decoupling this ticket asks for.
  h.showContainer();
  await h.hop();
  for (const m of MODULES) {
    assert.strictEqual(
      h.stats[m.key].mounted,
      2,
      `${m.key}: must mount on the debounced apply`,
    );
  }
  assert.strictEqual(h.calls.length, MODULES.length, "mount must not refetch");
});

test("7) AC1 in miniature: all five issue in ONE round", async (mod) => {
  const h = boot(mod, {});
  h.login(900);
  await h.clock.advance(1200, flush);
  const times = h.calls.map((c) => c.at);
  assert.strictEqual(times.length, 5, "five modules, five queries");
  const spread = Math.max(...times) - Math.min(...times);
  assert.strictEqual(
    spread,
    0,
    `all five must issue in the same tick, saw a ${spread} ms spread`,
  );

  // The unpatched channel is the contrast: nothing goes out at all until a
  // debounce hop calls the apply again.
  const dark = boot(mod, { patched: false });
  dark.setUid("u1");
  await dark.clock.advance(1200, flush);
  assert.strictEqual(dark.calls.length, 0, "unpatched: no query without a hop");
  await dark.hop();
  assert.strictEqual(dark.calls.length, 5, "unpatched: the hop is the trigger");
});

test("8) off-home: a deep link fetches nothing", async (mod) => {
  for (const flagOn of [true, false]) {
    const h = boot(mod, { home: false, flagOn });
    h.login(500);
    await h.clock.advance(3000, flush);
    assert.strictEqual(
      h.calls.length,
      0,
      `home=false flagOn=${flagOn}: must not fetch`,
    );
  }
});

test("9) pre-auth: the poll gives up at the ceiling", async (mod) => {
  const h = boot(mod, {}); // uid never set
  await h.clock.advance(mod.POLL_MS * (mod.MAX_POLLS + 5), flush);
  assert.strictEqual(h.calls.length, 0, "pre-auth must not fetch");
  assert.strictEqual(
    h.clock.pending(),
    0,
    "the poll must stop, not spin forever",
  );
  assert.ok(
    h.prefetch().stats().polls <= mod.MAX_POLLS + 1,
    "poll count must respect the ceiling",
  );
});

test("10) user switch: the shipped reset still refetches", async (mod) => {
  const h = boot(mod, { only: ["my-list"] });
  h.login(500);
  await h.clock.advance(600, flush);
  assert.strictEqual(h.calls.length, 1);

  // A different user id reaches the apply through the debounce, exactly as it
  // does today. The prefetch must not pin the first user's answer.
  h.setUid("u2");
  await h.hop();
  assert.strictEqual(h.calls.length, 2, "the user change must refetch");
  assert.strictEqual(h.calls[0].uid, "u1");
  assert.strictEqual(h.calls[1].uid, "u2", "the second query is the new user");
});

test("11) idempotent: a duplicate arm is refused", async (mod) => {
  const h = boot(mod, { only: ["my-list"] });
  const st = h.prefetch();
  assert.strictEqual(
    st.arm("my-list", () => {}),
    false,
    "duplicate refused",
  );
  assert.strictEqual(
    st.arm("", () => {}),
    false,
    "empty key refused",
  );
  assert.strictEqual(st.arm("other", null), false, "non-function refused");
  h.login(400);
  await h.clock.advance(500, flush);
  assert.strictEqual(h.calls.length, 1, "still exactly one query");
});

test("11b) top10-badges is defined but HELD BACK from the applied set", async (mod) => {
  // Measured regression, not a style choice: arming top10 moved its query from
  // 5,693 ms to 12,005 ms on a matched warm pair. Its fetch latch is keyed on
  // a DOM lookup (`j(S())`), unlike every other module in scope, so a
  // pre-render call latches under a key the real call never matches.
  assert.ok(
    mod.PATCHES.indexOf(mod.PATCH_TOP10) < 0,
    "PATCH_TOP10 must not be in the applied set",
  );
  assert.ok(
    mod.HELD_BACK.indexOf(mod.PATCH_TOP10) >= 0,
    "PATCH_TOP10 must be declared held back, not silently dropped",
  );
  assert.strictEqual(mod.PATCHES.length, 5, "store + four row modules");
  // patchConfig must therefore leave top10-badges byte-identical.
  const top10 = MODULES.filter((m) => m.key === "top10-badges")[0];
  const cfg = {
    CustomJavaScripts: [
      { Name: "tizen-compat", Script: LIVE_TC_TAIL + "0;" },
      { Name: "watch-it-again", Script: MODULES[0].anchor },
      { Name: "top-picks", Script: MODULES[1].anchor },
      { Name: "my-list", Script: MODULES[2].anchor },
      { Name: "top10-badges", Script: top10.anchor },
      { Name: "genre-rows", Script: MODULES[4].anchor },
    ],
  };
  mod.patchConfig(cfg);
  const after = cfg.CustomJavaScripts.filter(
    (e) => e.Name === "top10-badges",
  )[0];
  assert.strictEqual(
    after.Script,
    top10.anchor,
    "top10-badges must come out of patchConfig unchanged",
  );
});

test("12) composes: jp738 and jp745 apply in either order", async (mod) => {
  // jp738 ships on its own branch (PR #183). When it is not present the
  // disjointness is still asserted structurally below; when it IS present the
  // real either-order composition is exercised.
  const jp738Path = path.join(HERE, "jsi-jp738-patch.mjs");
  const body = LIVE_TC_JP738 + "Y.push(Q);" + LIVE_TC_TAIL + "0;";

  // Structural: jp745 never touches jp738's anchor region, and vice versa.
  const mine = mod.applyPatch(body, mod.PATCH_STORE);
  assert.strictEqual(
    mine.split(LIVE_TC_JP738).length - 1,
    1,
    "jp745 must leave jp738's anchor intact and unique",
  );

  if (!require("node:fs").existsSync(jp738Path)) {
    console.log("      (jp738 not on this branch; structural check only)");
    return;
  }
  const jp738 = await import("file://" + jp738Path);
  const a = mod.applyPatch(
    jp738.applyPatch(body, jp738.PATCH_STORE),
    mod.PATCH_STORE,
  );
  const b = jp738.applyPatch(
    mod.applyPatch(body, mod.PATCH_STORE),
    jp738.PATCH_STORE,
  );
  for (const out of [a, b]) {
    assert.ok(out.indexOf("n.genreBulk=") >= 0, "jp738 store survives");
    assert.ok(out.indexOf("n.rowPrefetch=") >= 0, "jp745 store survives");
    mod.assertEs5Additions(out);
    jp738.assertEs5Additions(out);
    new vm.Script(`(function(s,n){${out}})`);
  }
});

(async () => {
  const mod = await import("file://" + path.join(HERE, "jsi-jp745-patch.mjs"));
  for (const [name, fn] of tests) {
    try {
      await fn(mod);
      console.log(`ok    ${name}`);
    } catch (err) {
      failures++;
      console.error(`FAIL  ${name}\n      ${err && err.message}`);
    }
  }
  if (failures) {
    console.error(`\n${failures} failing`);
    process.exit(1);
  }
  console.log(`\n${tests.length} passing`);
})();
