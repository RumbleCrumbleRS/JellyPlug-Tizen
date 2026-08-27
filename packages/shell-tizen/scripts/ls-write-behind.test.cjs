// JELA-751 regression test — write-behind overlay for large localStorage
// cache bodies.
//
// Chromium's per-origin localStorage commit persists "what is pending when
// a commit fires"; the boot-cadence first commit fires ~5 s after the
// session's first write, and no later commit lands inside the boot burst.
// A first boot streams ~3.6 M chars of cache bodies over ~25 s, so only the
// head of the stream reaches disk — the JELA-748 0->39->86->152 three-boot
// priming curve. Byte-shrink arms (0.28x-0.52x) persisted the IDENTICAL key
// set as control; a single LATE burst persisted 152/152 (JELA-751 synthetic
// arm F-late). installLsWriteBehind therefore holds large cache bodies in a
// memory overlay and flushes them in ONE synchronous pass after a quiet
// period, so a single commit captures the full set.
//
// The contract pinned here:
//   - flag-dark: installs ONLY when jellyfin.shell.lsWriteBehind="1"; the
//     kill switch jellyfin.shell.lsWriteBehindDisabled="1" wins.
//   - holds ONLY localStorage string values >= 4096 chars whose key starts
//     with "shell.tx" (version slots, txc: bodies, the LRU map) or equals
//     "jellyfin.shell.bundlePatchState"; everything else writes through.
//   - reads stay consistent while held (wrapped getItem serves the
//     overlay); probing with inherited-property names ("constructor") must
//     NOT read as a hit; removeItem drops a held key; a re-set coalesces.
//   - sessionStorage traffic passes through (prototype is shared).
//   - flush: quiet timer (6 s, re-armed per held write) or hard cap (60 s,
//     armed once); one synchronous pass through the ORIGINAL setItem; a
//     quota throw loses only that key (soft-fail, counted in qe).
//   - post-flush writes go straight through (no re-hold).
//   - NO lifecycle listeners (lifecycle-resume contract) — timers only.
//   - both shells carry the shell-core marker AND the early hoisted call.
//
// Run: node scripts/ls-write-behind.test.cjs

const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..", "..", "..");
const TV_SHELL = path.join(REPO, "packages", "shell-tizen", "src", "shell.js");
const BOOT_SHELL = path.join(
  REPO,
  "packages",
  "shell-tizen-bootstrap",
  "src",
  "boot-shell.src.js",
);
const { loadFragments } = require(
  path.join(REPO, "packages", "shell-core", "expand.cjs"),
);

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log("OK: " + name);
  else {
    console.error("FAIL: " + name + (detail ? " — " + detail : ""));
    failures++;
  }
}

// --- both shells reference the shared fragment and arm it early -------------

const tvSrc = fs.readFileSync(TV_SHELL, "utf8");
const bootSrc = fs.readFileSync(BOOT_SHELL, "utf8");
for (const [label, src] of [
  ["shell.js", tvSrc],
  ["boot-shell.src.js", bootSrc],
]) {
  check(
    label + " carries the shell-core marker",
    src.includes("//@@SHELL_CORE:installLsWriteBehind@@"),
  );
  check(
    label + " calls installLsWriteBehind()",
    src.includes("installLsWriteBehind();"),
  );
}

// --- sandbox ----------------------------------------------------------------

const fragment = loadFragments().installLsWriteBehind;

function makeEnv(seedFlags) {
  const store = new Map();
  function Storage() {}
  Storage.prototype.setItem = function (k, v) {
    if (this.__throwOn && this.__throwOn === String(k))
      throw new Error("QuotaExceededError");
    store.set(String(k), String(v));
  };
  Storage.prototype.getItem = function (k) {
    return store.has(String(k)) ? store.get(String(k)) : null;
  };
  Storage.prototype.removeItem = function (k) {
    store.delete(String(k));
  };
  const localStorage = new Storage();
  const sessionStore = new Map();
  const sessionStorage = new Storage();
  // sessionStorage shares the prototype but must never touch `store` via
  // the overlay path; give it its own backing through instance shadowing.
  sessionStorage.setItem = function (k, v) {
    sessionStore.set(String(k), String(v));
  };
  sessionStorage.getItem = function (k) {
    return sessionStore.has(String(k)) ? sessionStore.get(String(k)) : null;
  };
  for (const [k, v] of Object.entries(seedFlags || {})) store.set(k, v);
  let listenerCalls = 0;
  const window = {
    Storage,
    localStorage,
    addEventListener: () => {
      listenerCalls++;
    },
  };
  let timers = [];
  let nextId = 1;
  const setTimeout = (fn, ms) => {
    timers.push({ id: nextId, fn, ms });
    return nextId++;
  };
  const clearTimeout = (id) => {
    timers = timers.filter((t) => t.id !== id);
  };
  const install = new Function(
    "window",
    "localStorage",
    "sessionStorage",
    "Storage",
    "setTimeout",
    "clearTimeout",
    "document",
    fragment + "\nreturn installLsWriteBehind;",
  )(window, localStorage, sessionStorage, Storage, setTimeout, clearTimeout, {
    addEventListener: () => {
      listenerCalls++;
    },
  });
  return {
    store,
    sessionStore,
    Storage,
    localStorage,
    sessionStorage,
    window,
    install,
    timers: () => timers,
    fire: (t) => {
      timers = timers.filter((x) => x.id !== t.id);
      t.fn();
    },
    listeners: () => listenerCalls,
  };
}

const BIG = "x".repeat(5000);
const SMALL = "y".repeat(100);

// --- flag-dark gating -------------------------------------------------------

{
  const env = makeEnv({});
  const before = env.Storage.prototype.setItem;
  env.install();
  check(
    "flag off: prototype untouched",
    env.Storage.prototype.setItem === before,
  );
  check("flag off: no QA surface", env.window.__shellLsWB === undefined);
}
{
  const env = makeEnv({
    "jellyfin.shell.lsWriteBehind": "1",
    "jellyfin.shell.lsWriteBehindDisabled": "1",
  });
  const before = env.Storage.prototype.setItem;
  env.install();
  check(
    "kill switch wins over the enable flag",
    env.Storage.prototype.setItem === before,
  );
}

// --- hold / overlay-read / write-through ------------------------------------

{
  const env = makeEnv({ "jellyfin.shell.lsWriteBehind": "1" });
  env.install();
  const st = env.window.__shellLsWB;
  check("installs armed", !!st && st.st === "hold");

  env.localStorage.setItem("shell.tx35:slot-a", BIG);
  check(
    "big tx slot is held, not persisted",
    !env.store.has("shell.tx35:slot-a"),
  );
  check(
    "held value serves reads through getItem",
    env.localStorage.getItem("shell.tx35:slot-a") === BIG,
  );
  check("held counters track", st.q === 1 && st.qc === BIG.length);

  env.localStorage.setItem("shell.txLru35", BIG + BIG);
  check("LRU map key is held too", !env.store.has("shell.txLru35"));

  env.localStorage.setItem("jellyfin.shell.bundlePatchState", BIG);
  check(
    "bundlePatchState is held",
    !env.store.has("jellyfin.shell.bundlePatchState"),
  );

  env.localStorage.setItem("shell.tx35:ts:slot-a", SMALL);
  check(
    "small sibling keys write through",
    env.store.get("shell.tx35:ts:slot-a") === SMALL,
  );
  env.localStorage.setItem("jellyfin.shell.stylesheetBodies", BIG);
  check(
    "big out-of-scope keys write through",
    env.store.get("jellyfin.shell.stylesheetBodies") === BIG,
  );

  env.sessionStorage.setItem("shell.tx35:slot-b", BIG);
  check(
    "sessionStorage passes through",
    env.sessionStore.get("shell.tx35:slot-b") === BIG,
  );

  check(
    "inherited-name probe is not a hit",
    env.localStorage.getItem("constructor") === null,
  );

  // coalesce + remove
  env.localStorage.setItem("shell.tx35:slot-a", BIG + "z");
  check(
    "re-set coalesces in place",
    st.q === 3 && env.localStorage.getItem("shell.tx35:slot-a") === BIG + "z",
  );
  env.localStorage.removeItem("shell.txLru35");
  check(
    "removeItem drops a held key",
    st.q === 2 && env.localStorage.getItem("shell.txLru35") === null,
  );

  // timers: per-write quiet re-arm + one cap
  const quiet = env.timers().filter((t) => t.ms === 6000);
  const cap = env.timers().filter((t) => t.ms === 60000);
  check("one live quiet timer (re-armed per hold)", quiet.length === 1);
  check("one cap timer, armed once", cap.length === 1);

  // flush via the quiet timer; one key hits quota
  env.localStorage.__throwOn = "jellyfin.shell.bundlePatchState";
  env.fire(quiet[0]);
  check(
    "flush persists held tx slot",
    env.store.get("shell.tx35:slot-a") === BIG + "z",
  );
  check(
    "flush quota throw soft-fails that key only",
    !env.store.has("jellyfin.shell.bundlePatchState") && st.qe === 1,
  );
  check(
    "flush counters + state",
    st.st === "flushed" &&
      st.fl === 1 &&
      st.fc === BIG.length + 1 &&
      st.q === 0,
  );

  // post-flush behavior
  delete env.localStorage.__throwOn;
  env.localStorage.setItem("shell.tx35:slot-late", BIG);
  check(
    "post-flush big writes go straight through",
    env.store.get("shell.tx35:slot-late") === BIG,
  );
  check("no lifecycle listeners ever attached", env.listeners() === 0);
}

// --- double-install guard ---------------------------------------------------

{
  const env = makeEnv({ "jellyfin.shell.lsWriteBehind": "1" });
  env.install();
  const wrapped = env.Storage.prototype.setItem;
  env.install();
  check(
    "second install is a no-op (no double-wrap)",
    env.Storage.prototype.setItem === wrapped,
  );
}

if (failures) {
  console.error(failures + " failure(s)");
  process.exit(1);
}
console.log("\nAll JELA-751 ls-write-behind checks passed.");
