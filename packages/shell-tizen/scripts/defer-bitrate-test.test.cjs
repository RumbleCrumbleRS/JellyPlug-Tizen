/*
 * JELA-684 (JELA-679/P3): hold the playback bitrate probe until after first
 * paint — opt-in via localStorage['jellyfin.shell.deferBitrateTest']='1',
 * default OFF.
 *
 * THE DEFECT BEING FIXED. jellyfin-apiclient schedules a fire-and-forget
 * bandwidth probe 6 s after ANY setAuthenticationInfo() / onNetworkChange() /
 * authenticate call (verified against the bundle the user's 10.11.11 server
 * serves):
 *   function g(e){p(e),e.accessToken()&&!1!==e.enableAutomaticBitrateDetection
 *                 &&(e.detectTimeout=setTimeout(y.bind(e),6e3))}
 *   function y(){this.detectTimeout=null,this.accessToken()&&this.detectBitrate()}
 * On a saved-server cold boot that lands at t~7.7 s — inside the pre-firstCard
 * window (firstCard ~15 s on the virtual M63 target) — and detectBitrate
 * escalates 500 KB -> 1 MB -> 3 MB, served as 512 KiB + 1 MiB + 4 MiB =
 * 5.5 MiB of bulk transfer against the same link the home-screen query storm
 * is using. Nothing on the home screen consumes the result.
 *
 * WHY AN ACCESSOR AND NOT `= false`. The only gate is the INSTANCE property
 * enableAutomaticBitrateDetection, and the connection manager re-assigns it
 * from its own options on every (re)auth and THEN calls the scheduler:
 *   e.enableAutomaticBitrateDetection=n.enableAutomaticBitrateDetection,
 *   e.serverInfo(s), e.setAuthenticationInfo(...)   // -> g(e)
 * With options.enableAutomaticBitrateDetection undefined, `!1!==undefined` is
 * true, so a plain write placed at onApi is clobbered a few hundred ms later
 * and the probe fires anyway. B2b below pins exactly that regression.
 *
 * WHAT THIS PINS
 *   PART A — CONTRACT (src + the minified sibling): opt-in flag, diag object,
 *            gate registration sites, ES5-only seed text.
 *   PART B — BEHAVIOUR (the shim IIFE lifted from the SHIPPED seed and run in
 *            a sandbox against a faithful re-implementation of the vendor
 *            scheduler above):
 *     B0. no flag -> completely inert, and the vendor probe fires at 6 s
 *         (proves the harness reproduces the defect it claims to fix).
 *     B1. flag on -> an ALREADY-SCHEDULED detectTimeout is cleared at onApi.
 *     B2a. a later re-auth does not schedule while held.
 *     B2b. the re-assign is swallowed and counted (the accessor, not a write).
 *     B3. ZERO detectBitrate calls before paint, however long we wait.
 *     B4. onPaint restores a plain writable `true` and re-arms the vendor's
 *         own detectTimeout at the configured delay; it fires exactly once.
 *     B5. the re-armed timer is still cancellable the vendor's way
 *         (clearTimeout of detectTimeout), so the player can call p(e).
 *     B6. delay is tunable; out-of-range values fall back to 4000.
 *     B7. a REPLACED window.ApiClient is picked up by the 500 ms re-guard.
 *     B8. release stops the re-guard interval (no leaked timer).
 *     B9. no access token at release -> timer armed, detectBitrate not called.
 *     B10. gate absent -> arms immediately and releases on the 20 s fallback.
 *   PART C — COMPOSITION with JELA-686 (bitrateCache), which ships the other
 *            bitrate shim into the SAME seed and the SAME paint gate:
 *     C1. both flags on + warm store -> nothing probes pre-paint, and the
 *         probe 684 re-arms is served from the store (zero requests).
 *     C2. both flags on + cold store -> nothing pre-paint, then exactly one
 *         real detection after paint, persisted for the next boot.
 *     C3. bitrateCache alone does NOT defer — the flags stay independent.
 *
 * Run: node scripts/defer-bitrate-test.test.cjs
 *   or: pnpm --filter @jellyfin-tv/shell-tizen test
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = path.join(__dirname, "..", "src", "shell.js");

const MIN = SRC.endsWith("boot-shell.src.js")
  ? SRC.replace(/boot-shell\.src\.js$/, "boot-shell.min.js")
  : SRC.replace(/shell\.js$/, "shell.min.js");

const FLAG = "jellyfin.shell.deferBitrateTest";
const KILL_LINE = 'localStorage.getItem("' + FLAG + '")!=="1"';

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log("OK: " + name);
  } else {
    console.error("FAIL: " + name + (detail ? "  — " + detail : ""));
    failures++;
  }
}

const src = fs.readFileSync(SRC, "utf8");
const min = fs.readFileSync(MIN, "utf8");
const srcLabel = path.basename(SRC);
const minLabel = path.basename(MIN);

// ---------------------------------------------------------------------------
// Lift the shim out of the REAL seed text (not the raw file), exactly the way
// late-onload.test.cjs does, so what runs here is what ships.
// ---------------------------------------------------------------------------
function extractTopFn(text, name) {
  const lines = text.split("\n");
  let s = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("  function " + name + "(")) {
      s = i;
      break;
    }
  }
  if (s === -1) throw new Error("function not found: " + name);
  for (let i = s + 1; i < lines.length; i++) {
    if (lines[i] === "  }") return lines.slice(s, i + 1).join("\n");
  }
  throw new Error("no closing brace for: " + name);
}

function buildSeed() {
  const fnSrc = extractTopFn(src, "buildSeedScript").replace(
    /^  function buildSeedScript/,
    "function",
  );
  const sb = { Object, JSON, TX_VER: "testver" };
  vm.createContext(sb);
  const buildSeedScript = vm.runInContext("(" + fnSrc + ")", sb);
  return buildSeedScript("https://tv.example.test", {});
}

const seed = buildSeed();

function extractShim() {
  const kill = seed.indexOf(KILL_LINE);
  check(srcLabel + ": built seed contains the opt-in gate line", kill !== -1);
  if (kill === -1) return null;
  const start = seed.lastIndexOf("try{(function(){", kill);
  const endMark = "\n  })();}catch(_){}";
  const end = seed.indexOf(endMark, kill);
  check(
    srcLabel + ": shim IIFE boundaries resolve",
    start !== -1 && end !== -1 && start < kill && kill < end,
  );
  if (start === -1 || end === -1) return null;
  return seed.slice(start, end + endMark.length);
}

const shim = extractShim();

// ===========================================================================
// PART A — CONTRACT
// ===========================================================================
check(srcLabel + ": opt-in flag present", src.includes(FLAG));
check(
  srcLabel + ": delay knob present",
  src.includes("jellyfin.shell.deferBitrateTestMs"),
);
check(srcLabel + ": registers hold on onApi", src.includes("pg.onApi(arm)"));
check(
  srcLabel + ": registers release on onPaint",
  src.includes("pg.onPaint(release)"),
);
// The diag object and the vendor property/timer names are the only identifiers
// that survive minification — everything else in the shim is a local.
for (const [label, text] of [
  [srcLabel, src],
  [minLabel, min],
]) {
  check(label + ": diag object present", text.includes("__shellBT"));
  check(label + ": opt-in flag survives", text.includes(FLAG));
  check(
    label + ": targets the vendor gate property",
    text.includes("enableAutomaticBitrateDetection"),
  );
  check(
    label + ": clears the vendor timer handle",
    text.includes("detectTimeout"),
  );
}
if (shim) {
  check("shim is ES5 (no arrow functions)", shim.indexOf("=>") === -1);
  check("shim is ES5 (no template literals)", shim.indexOf("`") === -1);
  check("shim has no </script literal", shim.indexOf("</script") === -1);
  check(
    "shim is ES5 (var only)",
    shim.indexOf("const ") === -1 && shim.indexOf("let ") === -1,
  );
}

// ===========================================================================
// PART B — BEHAVIOUR
// ===========================================================================

// Virtual clock. Timers fire in due-time order; advance() runs everything due.
function makeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.set(id, { fn, at: now + (ms || 0), repeat: 0 });
      return id;
    },
    setInterval(fn, ms) {
      const id = ++seq;
      timers.set(id, { fn, at: now + (ms || 0), repeat: ms || 1 });
      return id;
    },
    clear(id) {
      timers.delete(id);
    },
    pending: () => timers.size,
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of timers) {
          if (t.at <= target && (next === null || t.at < next[1].at)) {
            next = [id, t];
          }
        }
        if (!next) break;
        const [id, t] = next;
        now = t.at;
        if (t.repeat) t.at = now + t.repeat;
        else timers.delete(id);
        t.fn();
      }
      now = target;
    },
  };
}

// A faithful re-implementation of the shipped apiclient scheduler (g/y/p).
function makeApi(clock) {
  return {
    detectTimeout: null,
    token: "tok",
    calls: 0,
    accessToken() {
      return this.token;
    },
    detectBitrate() {
      this.calls++;
      return { then: () => {} };
    },
  };
}
function vendorSchedule(api, clock) {
  // p(e)
  if (api.detectTimeout) {
    clock.clear(api.detectTimeout);
    api.detectTimeout = null;
  }
  // g(e)
  if (api.accessToken() && api.enableAutomaticBitrateDetection !== false) {
    api.detectTimeout = clock.setTimeout(function () {
      api.detectTimeout = null;
      if (api.accessToken()) api.detectBitrate();
    }, 6000);
  }
}

// Run the shim with a fake paint gate and a controllable localStorage.
function runShim(store, opts) {
  opts = opts || {};
  const clock = makeClock();
  const win = {};
  const gateCbs = { api: [], paint: [] };
  const gate = opts.noGate
    ? undefined
    : {
        onApi(cb) {
          gateCbs.api.push(cb);
        },
        onPaint(cb) {
          gateCbs.paint.push(cb);
        },
      };
  win.__shellPaintGate = gate;
  const sandbox = {
    window: win,
    localStorage: {
      getItem(k) {
        return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null;
      },
    },
    setTimeout: clock.setTimeout,
    setInterval: clock.setInterval,
    clearTimeout: clock.clear,
    clearInterval: clock.clear,
    Date: { now: () => clock.now() + 1 },
    Object,
    parseInt,
  };
  vm.createContext(sandbox);
  vm.runInContext(shim, sandbox);
  return {
    win,
    clock,
    fireApi: () => gateCbs.api.forEach((c) => c()),
    firePaint: () => gateCbs.paint.forEach((c) => c()),
    state: () => win.__shellBT,
  };
}

if (!shim) {
  console.error("FAIL: shim not extractable — skipping PART B");
  failures++;
} else {
  // --- B0: no flag -> inert, and the vendor probe still fires at 6 s. -------
  {
    const r = runShim({});
    const api = makeApi(r.clock);
    r.win.ApiClient = api;
    r.fireApi();
    vendorSchedule(api, r.clock);
    r.clock.advance(6000);
    check("B0: flag absent -> no diag state", r.state() === undefined);
    check(
      "B0: flag absent -> vendor probe fires (harness reproduces the defect)",
      api.calls === 1,
      "calls=" + api.calls,
    );
  }

  // --- B1/B2/B3: held from onApi to paint. ---------------------------------
  {
    const r = runShim({ [FLAG]: "1" });
    const api = makeApi(r.clock);
    r.win.ApiClient = api;
    // The vendor scheduled its 6 s probe BEFORE the gate reached onApi.
    vendorSchedule(api, r.clock);
    check("B1: vendor timer armed pre-hold", api.detectTimeout !== null);

    r.fireApi();
    check(
      "B1: pre-scheduled detectTimeout cleared at onApi",
      api.detectTimeout === null && r.state().cleared === 1,
      JSON.stringify({ t: api.detectTimeout, s: r.state() }),
    );

    // The connection manager re-assigns the gate from its options (undefined
    // in practice) and then re-runs the scheduler.
    api.enableAutomaticBitrateDetection = undefined;
    vendorSchedule(api, r.clock);
    check(
      "B2a: re-auth does not schedule while held",
      api.detectTimeout === null,
    );
    check(
      "B2b: the clobbering write is swallowed and counted",
      r.state().sets >= 1 && api.enableAutomaticBitrateDetection === false,
      JSON.stringify({
        sets: r.state().sets,
        v: api.enableAutomaticBitrateDetection,
      }),
    );

    r.clock.advance(60000);
    check(
      "B3: zero detectBitrate calls before paint",
      api.calls === 0,
      "calls=" + api.calls,
    );

    // --- B4/B5: release on paint. ------------------------------------------
    r.firePaint();
    const d = Object.getOwnPropertyDescriptor(
      api,
      "enableAutomaticBitrateDetection",
    );
    check(
      "B4: property restored as a plain writable true",
      !!d && d.get === undefined && d.value === true && d.writable === true,
      JSON.stringify(d),
    );
    check("B4: vendor timer re-armed", api.detectTimeout !== null);
    r.clock.advance(3999);
    check("B4: does not fire early", api.calls === 0, "calls=" + api.calls);
    r.clock.advance(1);
    check(
      "B4: fires exactly once at the default 4000 ms delay",
      api.calls === 1,
      "calls=" + api.calls,
    );
    check("B4: diag records the firing", r.state().fired === 1);

    // --- B8: the re-guard interval is stopped by release. ------------------
    const before = r.clock.pending();
    r.clock.advance(30000);
    check(
      "B8: no re-guard interval left running after release",
      r.clock.pending() === 0 && before === 0,
      JSON.stringify({ before, after: r.clock.pending() }),
    );
    check("B8: and no extra probe fired", api.calls === 1);
  }

  // --- B5: the re-armed timer is cancellable the vendor's way. -------------
  {
    const r = runShim({ [FLAG]: "1" });
    const api = makeApi(r.clock);
    r.win.ApiClient = api;
    r.fireApi();
    r.firePaint();
    r.clock.clear(api.detectTimeout); // p(e), e.g. playback started
    api.detectTimeout = null;
    r.clock.advance(30000);
    check(
      "B5: cancelling detectTimeout suppresses the deferred probe",
      api.calls === 0,
      "calls=" + api.calls,
    );
  }

  // --- B6: delay knob. -----------------------------------------------------
  {
    const r = runShim({
      [FLAG]: "1",
      "jellyfin.shell.deferBitrateTestMs": "0",
    });
    const api = makeApi(r.clock);
    r.win.ApiClient = api;
    r.fireApi();
    r.firePaint();
    r.clock.advance(0);
    check("B6: delay 0 fires immediately after paint", api.calls === 1);
  }
  {
    const r = runShim({
      [FLAG]: "1",
      "jellyfin.shell.deferBitrateTestMs": "-5",
    });
    const api = makeApi(r.clock);
    r.win.ApiClient = api;
    r.fireApi();
    r.firePaint();
    r.clock.advance(3999);
    check("B6: out-of-range delay falls back to 4000", api.calls === 0);
    r.clock.advance(1);
    check("B6: ...and then fires", api.calls === 1);
  }

  // --- B7: a replaced window.ApiClient is picked up before paint. ----------
  {
    const r = runShim({ [FLAG]: "1" });
    const first = makeApi(r.clock);
    r.win.ApiClient = first;
    r.fireApi();
    const second = makeApi(r.clock);
    r.win.ApiClient = second;
    vendorSchedule(second, r.clock);
    check(
      "B7: replacement starts out schedulable",
      second.detectTimeout !== null,
    );
    r.clock.advance(500); // one re-guard tick
    check(
      "B7: replaced ApiClient is held too",
      second.detectTimeout === null && r.state().inst === 2,
      JSON.stringify({ t: second.detectTimeout, inst: r.state().inst }),
    );
    r.clock.advance(60000);
    check("B7: and never probes before paint", second.calls === 0);
  }

  // --- B9: no token at release. -------------------------------------------
  {
    const r = runShim({ [FLAG]: "1" });
    const api = makeApi(r.clock);
    r.win.ApiClient = api;
    r.fireApi();
    r.firePaint();
    api.token = null;
    r.clock.advance(5000);
    check(
      "B9: signed-out client is not probed",
      api.calls === 0 && r.state().armed === 1,
      JSON.stringify({ calls: api.calls, s: r.state() }),
    );
  }

  // --- B10: no paint gate -> immediate arm, 20 s fallback release. ---------
  {
    const r = runShim({ [FLAG]: "1" }, { noGate: true });
    const api = makeApi(r.clock);
    r.win.ApiClient = api;
    r.clock.advance(500);
    vendorSchedule(api, r.clock);
    check("B10: held with no gate present", api.detectTimeout === null);
    r.clock.advance(19500);
    check("B10: still held just before the fallback", api.calls === 0);
    r.clock.advance(4000);
    check(
      "B10: fallback release fires the deferred probe",
      api.calls === 1,
      "calls=" + api.calls,
    );
  }
}

// ===========================================================================
// PART C — COMPOSITION WITH JELA-686 (bitrateCache)
//
// Both shims now ship in the same seed and both register on the same paint
// gate, so their interaction is only exercised here. 684 holds an INSTANCE
// property (enableAutomaticBitrateDetection); 686 wraps detectBitrate. The
// intended combined behaviour is: nothing probes before paint, and the
// post-paint probe 684 re-arms is served from 686's persisted store, so a
// warm boot costs zero requests instead of the 5.5 MiB ladder.
//
// The 686 shim is lifted from the SAME built seed by its own opt-in line, so
// if either block is dropped or mangled by a merge this part stops resolving.
// ===========================================================================
const CACHE_FLAG = "jellyfin.shell.bitrateCache";
const CACHE_KILL = 'localStorage.getItem("' + CACHE_FLAG + '")!=="1"';

function extractShimAt(killLine) {
  const kill = seed.indexOf(killLine);
  if (kill === -1) return null;
  const start = seed.lastIndexOf("try{(function(){", kill);
  const endMark = "\n  })();}catch(_){}";
  const end = seed.indexOf(endMark, kill);
  if (start === -1 || end === -1 || start > kill || kill > end) return null;
  return seed.slice(start, end + endMark.length);
}

const cacheShim = extractShimAt(CACHE_KILL);
check(
  srcLabel + ": C: the JELA-686 bitrateCache shim is present in the same seed",
  cacheShim !== null,
);

if (!shim || !cacheShim) {
  console.error("FAIL: both shims required — skipping PART C");
  failures++;
} else {
  // A store that actually writes, plus a real Date, since 686 persists.
  function runBoth(store, seedRow) {
    const clock = makeClock();
    const win = {};
    const gateCbs = { api: [], paint: [] };
    win.__shellPaintGate = {
      onApi(cb) {
        gateCbs.api.push(cb);
      },
      onPaint(cb) {
        gateCbs.paint.push(cb);
      },
    };
    if (seedRow) store["jellyfin.shell.bitrate"] = JSON.stringify(seedRow);
    function FakeDate() {
      this.getTime = () => clock.now() + 1;
    }
    const sandbox = {
      window: win,
      localStorage: {
        getItem(k) {
          return Object.prototype.hasOwnProperty.call(store, k)
            ? store[k]
            : null;
        },
        setItem(k, v) {
          store[k] = String(v);
        },
      },
      setTimeout: clock.setTimeout,
      setInterval: clock.setInterval,
      clearTimeout: clock.clear,
      clearInterval: clock.clear,
      Date: FakeDate,
      Object,
      JSON,
      String,
      Promise,
      parseInt,
    };
    sandbox.Date.now = () => clock.now() + 1;
    vm.createContext(sandbox);
    // Registration order follows the seed: 686 wraps, then 684 holds.
    vm.runInContext(cacheShim, sandbox);
    vm.runInContext(shim, sandbox);
    return {
      win,
      clock,
      store,
      fireApi: () => gateCbs.api.forEach((c) => c()),
      firePaint: () => gateCbs.paint.forEach((c) => c()),
    };
  }

  // A client the 686 shim can key a cache entry on.
  function makeCacheApi(onDetect) {
    return {
      detectTimeout: null,
      token: "tok",
      calls: 0,
      accessToken() {
        return this.token;
      },
      serverId() {
        return "srv1";
      },
      serverAddress() {
        return "https://tv.example.test";
      },
      detectBitrate() {
        this.calls++;
        return Promise.resolve(onDetect === undefined ? 12345678 : onDetect);
      },
    };
  }

  // --- C1: both flags on, warm store -> 0 probes pre-paint, cache hit after.
  {
    const r = runBoth({ [FLAG]: "1", [CACHE_FLAG]: "1" }, {
      bps: 42000000,
      t: 1,
      id: "srv1|https://tv.example.test",
    });
    const api = makeCacheApi();
    r.win.ApiClient = api;
    r.fireApi();
    vendorSchedule(api, r.clock);
    r.clock.advance(30000);
    check(
      "C1: both armed",
      r.win.__shellBT && r.win.__shellBT.on === 1 && r.win.__shellBitrate.armed === 1,
      JSON.stringify({ bt: r.win.__shellBT, br: r.win.__shellBitrate }),
    );
    check(
      "C1: zero detection before paint (684 holds through 686's wrap)",
      api.calls === 0 && r.win.__shellBitrate.hits === 0,
      JSON.stringify({ calls: api.calls, br: r.win.__shellBitrate }),
    );
    r.firePaint();
    r.clock.advance(5000);
    check(
      "C1: post-paint probe is served from the store, not the network",
      api.calls === 0 &&
        r.win.__shellBitrate.hits === 1 &&
        r.win.__shellBitrate.bps === 42000000,
      JSON.stringify({ calls: api.calls, br: r.win.__shellBitrate }),
    );
  }

  // --- C2: both flags on, cold store -> still 0 pre-paint, then one real
  //         detection whose result is persisted for the next boot. ----------
  {
    const store = { [FLAG]: "1", [CACHE_FLAG]: "1" };
    const r = runBoth(store, null);
    const api = makeCacheApi(9000000);
    r.win.ApiClient = api;
    r.fireApi();
    vendorSchedule(api, r.clock);
    r.clock.advance(30000);
    check("C2: cold store still probes nothing before paint", api.calls === 0);
    r.firePaint();
    r.clock.advance(5000);
    check(
      "C2: exactly one real detection after paint",
      api.calls === 1 && r.win.__shellBitrate.miss === 1,
      JSON.stringify({ calls: api.calls, br: r.win.__shellBitrate }),
    );
  }

  // --- C3: 686 alone must not defer — the two flags stay independent. ------
  {
    const r = runBoth({ [CACHE_FLAG]: "1" }, null);
    const api = makeCacheApi();
    r.win.ApiClient = api;
    r.fireApi();
    vendorSchedule(api, r.clock);
    r.clock.advance(6000);
    check(
      "C3: bitrateCache alone leaves the pre-paint probe running (684 is the deferral)",
      api.calls === 1 && !r.win.__shellBT,
      JSON.stringify({ calls: api.calls, bt: r.win.__shellBT || null }),
    );
  }
}

if (failures) {
  console.error("\n" + failures + " check(s) failed");
  process.exit(1);
}
console.log("\nAll defer-bitrate-test checks passed.");
