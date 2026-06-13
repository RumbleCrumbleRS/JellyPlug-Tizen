// JEL-138 verification — default the login "Remember Me" checkbox to CHECKED.
//
// Field report + browser-verified root cause (tooling/tv-validate/
// credential-persistence/results-JEL-138.md): jellyfin-web's `enableAutoLogin`
// localStorage flag is sticky. One login with the box unchecked flips it to
// "false", and every later login form then renders the box unchecked. OSK
// Enter submits from the password field WITHOUT passing the (D-pad-only-
// visible) checkbox, so each Enter-login silently reuses the stale "off"
// state and the token is dropped at the next launch. Board decision (JEL-138
// interaction c0b35a10 = "default_checked"): start the box checked each time
// the login screen appears, while an explicit uncheck for that login still
// works and is honored.
//
// WHAT THIS PINS
//   PART A — CONTRACT (all four shipped artifacts): kill switch, diag counter,
//            checkbox selector present; the nudge block itself never writes
//            enableAutoLogin (it must touch only the checkbox DOM state so the
//            JEL-134 vault opt-out gate keeps reading the user's real flag).
//   PART B — EXECUTION (both src seeds, lifted into a fake-DOM vm):
//     B1. sticky-false render: an unchecked box is flipped to checked on the
//         poll tick, __shellRememberMeChecks increments, and no write to the
//         stored enableAutoLogin flag is made.
//     B2. jellyfin-web applying stored-false AFTER element creation is beaten:
//         a programmatic .checked=false (no change event) is re-asserted.
//     B3. deliberate user uncheck (a `change` event) is honored — the poll
//         backs off and stops re-checking that element.
//     B4. re-check after a user uncheck (change → checked) resumes enforcement.
//     B5. a fresh login form (new element) re-defaults checked = no carryover.
//     B6. kill switch jellyfin.shell.rememberMeDefaultDisabled=1 → fully off.
//
// Run: node scripts/remember-me-default.test.cjs
//   or: pnpm --filter @jellyfin-tv/shell-tizen test

"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const REPO = path.join(__dirname, "..", "..", "..");
const TV_SHELL = path.join(REPO, "packages", "shell-tizen", "src", "shell.js");
const TV_SHELL_MIN = path.join(
  REPO,
  "packages",
  "shell-tizen",
  "src",
  "shell.min.js",
);
const BOOT_SRC = path.join(
  REPO,
  "packages",
  "shell-tizen-bootstrap",
  "src",
  "boot-shell.src.js",
);
const BOOT_MIN = path.join(
  REPO,
  "packages",
  "shell-tizen-bootstrap",
  "src",
  "boot-shell.min.js",
);

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log("OK: " + name);
  } else {
    console.error("FAIL: " + name + (detail ? "  — " + detail : ""));
    failures++;
  }
}

const tvSrc = fs.readFileSync(TV_SHELL, "utf8");
const tvMin = fs.readFileSync(TV_SHELL_MIN, "utf8");
const bootSrc = fs.readFileSync(BOOT_SRC, "utf8");
const bootMin = fs.readFileSync(BOOT_MIN, "utf8");

const ARTIFACTS = [
  ["shell.js", tvSrc],
  ["shell.min.js", tvMin],
  ["boot-shell.src.js", bootSrc],
  ["boot-shell.min.js", bootMin],
];

// Extract the nudge IIFE `(function(){...})();` from a shell source. The only
// `})();}catch(_){}` after the kill-switch marker is the IIFE close, so a
// non-greedy match isolates exactly the injected block.
function extractNudgeIIFE(src) {
  const m = src.match(
    /(\(function\(\)\{if\(localStorage\.getItem\("jellyfin\.shell\.rememberMeDefaultDisabled"\)[\s\S]*?\}\)\(\);)\}catch\(_\)\{\}/,
  );
  return m ? m[1] : null;
}

// ============================================================================
// PART A — CONTRACT
// ============================================================================
for (const [name, src] of ARTIFACTS) {
  check(
    name + ": remember-me kill switch present",
    src.includes("jellyfin.shell.rememberMeDefaultDisabled"),
  );
  check(
    name + ": diag counter present",
    src.includes("__shellRememberMeChecks"),
  );
  check(name + ": checkbox selector present", src.includes("chkRememberLogin"));
  const iife = extractNudgeIIFE(src);
  check(name + ": nudge IIFE extractable", !!iife);
  // The nudge must never write the sticky flag — it only flips the DOM box.
  check(
    name + ": nudge does not touch enableAutoLogin",
    iife != null && iife.indexOf("enableAutoLogin") === -1,
    "nudge block references enableAutoLogin",
  );
}

// ============================================================================
// PART B — EXECUTION
// ============================================================================
function makeCheckbox(initialChecked) {
  const listeners = {};
  return {
    checked: initialChecked,
    className: "chkRememberLogin emby-checkbox",
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    _fire(type) {
      (listeners[type] || []).slice().forEach((f) => f());
    },
    // user toggle: flips the box AND fires change (programmatic sets don't)
    _userToggle() {
      this.checked = !this.checked;
      this._fire("change");
    },
  };
}

function runSeed(iife, { killSwitch } = {}) {
  const store = {};
  if (killSwitch) store["jellyfin.shell.rememberMeDefaultDisabled"] = "1";
  let intervalFn = null;
  const state = { currentBox: null };
  const sandbox = {
    window: {},
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => {
        store[k] = String(v);
      },
    },
    document: {
      querySelector: (sel) => {
        // exercise the `.chkRememberLogin` fallback branch
        if (sel === ".manualLoginForm .chkRememberLogin") return null;
        if (sel === ".chkRememberLogin") return state.currentBox;
        return null;
      },
      addEventListener: () => {},
    },
    setInterval: (fn) => {
      intervalFn = fn;
      return 1;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(iife, sandbox);
  return {
    store,
    state,
    tick: () => intervalFn && intervalFn(),
    checks: () => sandbox.window.__shellRememberMeChecks,
  };
}

function execScenarios(label, iife) {
  if (!iife) {
    check(label + ": nudge IIFE present", false);
    return;
  }

  // B1 + B2: sticky-false render. jellyfin-web sets the box checked at create,
  // then re-applies stored-false. We model: box appears unchecked; tick flips
  // it; a later programmatic false (no change) is re-asserted on the next tick.
  {
    const r = runSeed(iife);
    r.state.currentBox = makeCheckbox(false);
    r.tick();
    check(
      label + " B1: unchecked box flipped to checked",
      r.state.currentBox.checked === true,
    );
    check(label + " B1: __shellRememberMeChecks incremented", r.checks() === 1);
    check(
      label + " B1: stored enableAutoLogin untouched",
      !("enableAutoLogin" in r.store),
    );
    // B2: jellyfin-web re-applies stored-false programmatically (no change)
    r.state.currentBox.checked = false;
    r.tick();
    check(
      label + " B2: programmatic false re-asserted to checked",
      r.state.currentBox.checked === true,
    );
  }

  // B3 + B4: deliberate user uncheck (change event) is honored, then re-check.
  {
    const r = runSeed(iife);
    r.state.currentBox = makeCheckbox(false);
    r.tick(); // -> checked
    r.state.currentBox._userToggle(); // user unchecks (change fires) -> false
    check(
      label + " B3: user uncheck lands false",
      r.state.currentBox.checked === false,
    );
    r.tick();
    r.tick();
    check(
      label + " B3: poll backs off after user uncheck",
      r.state.currentBox.checked === false,
    );
    // B4: user re-checks (change fires) -> enforcement resumes
    r.state.currentBox._userToggle(); // -> true
    r.state.currentBox.checked = false; // jellyfin re-applies false
    r.tick();
    check(
      label + " B4: enforcement resumes after user re-check",
      r.state.currentBox.checked === true,
    );
  }

  // B5: a fresh login form (new element) re-defaults checked — no carryover of
  // a prior uncheck across form instances.
  {
    const r = runSeed(iife);
    r.state.currentBox = makeCheckbox(false);
    r.tick();
    r.state.currentBox._userToggle(); // opt out on this instance
    r.tick();
    check(
      label + " B5: first instance honored unchecked",
      r.state.currentBox.checked === false,
    );
    r.state.currentBox = makeCheckbox(false); // fresh form element
    r.tick();
    check(
      label + " B5: fresh form instance re-defaults checked",
      r.state.currentBox.checked === true,
    );
  }

  // B6: kill switch fully disables the nudge.
  {
    const r = runSeed(iife, { killSwitch: true });
    r.state.currentBox = makeCheckbox(false);
    r.tick();
    check(
      label + " B6: kill switch leaves box untouched",
      r.state.currentBox.checked === false,
    );
    check(
      label + " B6: kill switch leaves diag undefined",
      r.checks() === undefined,
    );
  }
}

execScenarios("shell.js", extractNudgeIIFE(tvSrc));
execScenarios("boot-shell.src.js", extractNudgeIIFE(bootSrc));

if (failures) {
  console.error("\n" + failures + " FAILURE(S)");
  process.exit(1);
}
console.log("\nALL OK");
