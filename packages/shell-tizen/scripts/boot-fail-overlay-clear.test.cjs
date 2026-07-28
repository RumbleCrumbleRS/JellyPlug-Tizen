// JELA-224 (WS-C, C2) verification — boot-failure overlay clear.
//
// When a saved-server boot cannot reach /web/ (slow / dead host, expired JWT,
// 404 channel), the shell falls back to its own connect form via
// attachConnectForm(). But two boot-time covers may still be on-screen at
// z-index max: the Instant-Home cached-home / skeleton (JEL-647,
// #__shell_instant_home) and the boot-progress dots (JEL-126, cleared via
// window.__shellBootProgressClear). Left up, they MASK the connect-form error
// for up to the 23 s Instant-Home settlecap — the boot reads as a blank hold
// instead of a clear "could not reach server" state.
//
// clearBootOverlays() (flag-dark: opt-in jellyfin.shell.bootFailOverlayClear=1)
// tears both covers down the moment the connect form is revealed. This test
// extracts the SHIPPED clearBootOverlays() out of BOTH shells and drives it
// through a DOM/window/localStorage stub, pinning:
//   - default OFF (no flag) is a pure no-op — pre-existing self-dismiss timing
//     is untouched;
//   - flag ON dismisses + removes Instant-Home, dismisses + removes
//     Direct-Home, and fires the boot-progress clear hook exactly once;
//   - additive-defensive: absent globals / a throwing localStorage never throw;
//   - attachConnectForm() actually calls clearBootOverlays() in both sources;
//   - the retail flag key ships in both deployed .min blobs.
//
// Run: node scripts/boot-fail-overlay-clear.test.cjs
"use strict";
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const REPO = path.join(__dirname, "..", "..", "..");
const SHELLS = [
  {
    name: "TV shell (shell-tizen)",
    src: path.join(REPO, "packages", "shell-tizen", "src", "shell.js"),
    min: path.join(REPO, "packages", "shell-tizen", "src", "shell.min.js"),
  },
  {
    name: "hosted boot-shell (bootstrap)",
    src: path.join(
      REPO,
      "packages",
      "shell-tizen-bootstrap",
      "src",
      "boot-shell.src.js",
    ),
    min: path.join(
      REPO,
      "packages",
      "shell-tizen-bootstrap",
      "src",
      "boot-shell.min.js",
    ),
  },
];

const FLAG = "jellyfin.shell.bootFailOverlayClear";

// ---- extract a top-level function by brace matching -------------------------
function extractFn(text, name, where) {
  const marker = "function " + name + "(";
  const start = text.indexOf(marker);
  assert(start !== -1, "could not find " + marker + " in " + where);
  let depth = 0;
  for (let j = text.indexOf("{", start); j < text.length; j++) {
    const c = text[j];
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return text.slice(start, j + 1);
  }
  throw new Error("unbalanced braces extracting " + name);
}

// ---- minimal DOM/window/localStorage stub -----------------------------------
function makeEnv(opts) {
  opts = opts || {};
  const removed = [];
  function mkEl(id) {
    const el = { id: id, parentNode: null };
    el.parentNode = {
      removeChild: function (node) {
        assert(node === el, "removeChild called with wrong node");
        removed.push(id);
        el.parentNode = null;
      },
    };
    return el;
  }
  const els = {};
  if (opts.ih) els["__shell_instant_home"] = mkEl("__shell_instant_home");
  if (opts.dh) els["__shell_direct_home"] = mkEl("__shell_direct_home");

  let clearCalls = 0;
  const window = {};
  if (opts.ihState) window.__shellIH = opts.ihState;
  if (opts.dhState) window.__shellDH = opts.dhState;
  if (opts.bootProgress)
    window.__shellBootProgressClear = function () {
      clearCalls++;
    };

  const document = {
    getElementById: function (id) {
      return els[id] || null;
    },
  };
  const localStorage = {
    getItem: function (k) {
      if (opts.lsThrows) throw new Error("storage blocked");
      return k === FLAG ? (opts.flag ? "1" : null) : null;
    },
  };
  return {
    run: function (fnSrc) {
      const fn = new Function(
        "window",
        "document",
        "localStorage",
        fnSrc + "; return clearBootOverlays;",
      )(window, document, localStorage);
      fn();
    },
    window: window,
    removed: removed,
    clearCalls: function () {
      return clearCalls;
    },
  };
}

let checks = 0;
function ok(msg) {
  checks++;
  console.log("OK:", msg);
}

for (const shell of SHELLS) {
  const text = fs.readFileSync(shell.src, "utf8");
  const fnSrc = extractFn(text, "clearBootOverlays", shell.src);

  // Static ES5 contract (runs pre-polyfill on Chromium 56/63).
  assert(fnSrc.indexOf("=>") === -1, shell.name + ": no arrow functions");
  assert(fnSrc.indexOf("`") === -1, shell.name + ": no template literals");
  assert(
    fnSrc.indexOf(FLAG) !== -1,
    shell.name + ": gates on the " + FLAG + " flag",
  );

  // (1) Default OFF — pure no-op.
  {
    const ih = { dismissed: 0 };
    const dh = { dismissed: 0 };
    const env = makeEnv({
      flag: false,
      ih: true,
      dh: true,
      ihState: ih,
      dhState: dh,
      bootProgress: true,
    });
    env.run(fnSrc);
    assert.strictEqual(ih.dismissed, 0, shell.name + ": flag OFF leaves IH");
    assert.strictEqual(dh.dismissed, 0, shell.name + ": flag OFF leaves DH");
    assert.strictEqual(
      env.removed.length,
      0,
      shell.name + ": flag OFF removes nothing",
    );
    assert.strictEqual(
      env.clearCalls(),
      0,
      shell.name + ": flag OFF skips boot-progress clear",
    );
    ok(shell.name + ": default OFF is a no-op (self-dismiss timing untouched)");
  }

  // (2) Flag ON — full teardown.
  {
    const ih = { dismissed: 0 };
    const dh = { dismissed: 0 };
    const env = makeEnv({
      flag: true,
      ih: true,
      dh: true,
      ihState: ih,
      dhState: dh,
      bootProgress: true,
    });
    env.run(fnSrc);
    assert.strictEqual(ih.dismissed, 1, shell.name + ": ON dismisses IH");
    assert.strictEqual(dh.dismissed, 1, shell.name + ": ON dismisses DH");
    assert.deepStrictEqual(
      env.removed.sort(),
      ["__shell_direct_home", "__shell_instant_home"],
      shell.name + ": ON removes both overlay nodes",
    );
    assert.strictEqual(
      env.clearCalls(),
      1,
      shell.name + ": ON fires boot-progress clear exactly once",
    );
    ok(shell.name + ": flag ON dismisses + removes IH/DH + clears dots");
  }

  // (3) Additive-defensive — absent globals never throw.
  {
    const env = makeEnv({ flag: true }); // no IH/DH state, no elements, no hook
    assert.doesNotThrow(
      () => env.run(fnSrc),
      shell.name + ": ON with nothing present must not throw",
    );
    assert.strictEqual(env.removed.length, 0, shell.name + ": nothing to remove");
    ok(shell.name + ": flag ON with absent globals is a safe no-op");
  }

  // (4) Additive-defensive — a throwing localStorage returns early, no throw.
  {
    const ih = { dismissed: 0 };
    const env = makeEnv({ lsThrows: true, ih: true, ihState: ih });
    assert.doesNotThrow(
      () => env.run(fnSrc),
      shell.name + ": throwing localStorage must not throw",
    );
    assert.strictEqual(
      ih.dismissed,
      0,
      shell.name + ": throwing localStorage tears down nothing",
    );
    ok(shell.name + ": throwing localStorage fails safe (no teardown, no throw)");
  }

  // (5) attachConnectForm() wires the call so every connect-form path clears.
  const acf = extractFn(text, "attachConnectForm", shell.src);
  assert(
    acf.indexOf("clearBootOverlays()") !== -1,
    shell.name + ": attachConnectForm() must call clearBootOverlays()",
  );
  ok(shell.name + ": attachConnectForm() invokes clearBootOverlays()");

  // (6) The retail flag key ships in the deployed .min blob.
  const min = fs.readFileSync(shell.min, "utf8");
  assert(
    min.indexOf(FLAG) !== -1,
    shell.name + ": deployed .min ships the " + FLAG + " kill-switch key",
  );
  ok(shell.name + ": deployed .min ships the flag key");
}

console.log("\nboot-fail-overlay-clear.test.cjs: " + checks + " checks passed");
