// JEL-238 verification — media-bar YouTube-iframe crash guard, baked natively
// into the shell so it ships in the signed .wgt (defense-in-depth for JEL-237).
//
// BACKGROUND (JEL-237, root-caused + on-device verified): the home media-bar
// slideshow spawns MULTIPLE concurrent YouTube /embed/ trailer iframes as it
// rotates. On Tizen 6.5 (Chromium 85, QN85QN90BAFXZA) each iframe decodes
// video; 2-3 concurrent hardware decoders exhaust native media/GPU memory and
// the whole app process crashes (running->false) ~20-40s after Home loads. The
// JS heap stays ~18MB the whole time, so it is a NATIVE crash, invisible to
// ordinary JS logging. New to 6.5: on Tizen 5.0 (M63) these iframes returned
// YouTube error 153 (file:// no Referer) and never actually decoded.
//
// The guard, on Tizen only, caps concurrent youtube/embed iframes to AT MOST
// ONE — dropping the older ones as the slideshow rotates — so a single trailer
// still plays but the decoders never get exhausted. It is content-pattern
// based (iframe src substrings), NOT plugin-name coupled, so it stays
// plugin-agnostic (see plugin-agnostic-shell.test.cjs). The same source was
// first deployed via the JS-Injector config and verified on-device in JEL-237;
// this test pins the baked-in shell copy.
//
// WHAT THIS PINS
//   PART A — CONTRACT (all four shipped artifacts): kill switch, Tizen UA gate,
//            diag counter, and the three iframe-src content patterns all
//            present; the guard never names a plugin.
//   PART B — EXECUTION (both src seeds, lifted into a fake-DOM vm):
//     B1. Tizen UA + 3 YT iframes present -> guard removes the 2 oldest, keeps
//         the most-recently-added, and __shellYtCaps == 2.
//     B2. a single YT iframe is left untouched (a trailer still plays).
//     B3. non-YouTube iframes are never removed.
//     B4. non-Tizen UA -> guard is a no-op (every iframe kept), so desktop and
//         mobile browsers keep all trailers.
//     B5. kill switch jellyfin.shell.ytIframeCapDisabled=1 -> fully off.
//     B6. the rotation tick (setInterval body) keeps capping as new iframes
//         arrive.
//
// Run: node scripts/mediabar-crashguard.test.cjs
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

// Extract the guard IIFE `(function(){if(localStorage.getItem("...crashguard..
// ")...})();` from a shell source. The kill-switch literal is unique to this
// block, and the only `})();}catch(_){}` after it is its IIFE close, so a
// non-greedy match isolates exactly the injected block.
function extractGuardIIFE(src) {
  const m = src.match(
    /(\(function\(\)\{if\(localStorage\.getItem\("jellyfin\.shell\.ytIframeCapDisabled"\)[\s\S]*?\}\)\(\);)\}catch\(_\)\{\}/,
  );
  return m ? m[1] : null;
}

// ============================================================================
// PART A — CONTRACT
// ============================================================================
for (const [name, src] of ARTIFACTS) {
  check(
    name + ": crashguard kill switch present",
    src.includes("jellyfin.shell.ytIframeCapDisabled"),
  );
  check(
    name + ": Tizen UA gate present",
    /\/Tizen\/\.test\(navigator\.userAgent/.test(src),
  );
  check(name + ": diag counter present", src.includes("__shellYtCaps"));
  for (const pat of ['"youtube"', '"youtu.be"', '"/embed/"']) {
    check(
      name + ": iframe content pattern present — " + pat,
      src.includes(pat),
    );
  }
  const iife = extractGuardIIFE(src);
  check(name + ": guard IIFE extractable", !!iife);
  // Content-pattern based, never plugin-name coupled.
  check(
    name + ": guard names no plugin (slideshowPure)",
    iife != null && iife.indexOf("slideshowPure") === -1,
  );
}

// ============================================================================
// PART B — EXECUTION
// ============================================================================
function makeIframe(src) {
  const el = { tagName: "IFRAME", src: src, parentNode: null };
  return el;
}

// Minimal fake DOM: a flat live iframe collection backed by an array. The
// guard only uses getElementsByTagName("iframe"), parentNode.removeChild,
// MutationObserver (best-effort), and setInterval (best-effort) — model just
// those.
function runGuard(iife, { tizen = true, killSwitch = false } = {}) {
  const store = {};
  if (killSwitch) store["jellyfin.shell.ytIframeCapDisabled"] = "1";
  const iframes = [];
  let intervalFn = null;
  const parent = {
    removeChild(node) {
      const i = iframes.indexOf(node);
      if (i === -1) throw new Error("not a child");
      iframes.splice(i, 1);
      node.parentNode = null;
      return node;
    },
  };
  const sandbox = {
    window: {},
    navigator: {
      userAgent: tizen
        ? "Mozilla/5.0 (SmartHub; Tizen 6.5)"
        : "Mozilla/5.0 (X11; Linux) Chrome/120",
    },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
    },
    document: {
      // live HTMLCollection semantics: returns the same backing array
      getElementsByTagName: () => iframes,
      documentElement: {},
    },
    MutationObserver: function () {
      return { observe() {} };
    },
    setInterval: (fn) => {
      intervalFn = fn;
      return 1;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(iife, sandbox);
  return {
    iframes,
    add(src) {
      const el = makeIframe(src);
      el.parentNode = parent;
      iframes.push(el);
      return el;
    },
    tick: () => intervalFn && intervalFn(),
    caps: () => sandbox.window.__shellYtCaps,
  };
}

const YT = "https://www.youtube.com/embed/abc123?autoplay=1";
const YT2 = "https://www.youtube.com/embed/def456?autoplay=1";
const YT3 = "https://youtu.be/ghi789";
const NOTYT = "https://example.test/widget.html";

function execScenarios(label, iife) {
  if (!iife) {
    check(label + ": guard IIFE present", false);
    return;
  }

  // B1: three YT iframes already in the DOM before the guard runs. The guard's
  // initial cap() keeps the LAST one and removes the two older.
  {
    // Seed iframes, then run the guard so its cap() at load sees all three.
    // runGuard() runs the IIFE at construction with an empty list, so instead
    // pre-load via a custom builder: add three, then re-invoke the interval.
    const r = runGuard(iife);
    const a = r.add(YT);
    const b = r.add(YT2);
    const c = r.add(YT3);
    r.tick(); // simulate the periodic cap()
    check(
      label + " B1: capped to a single YouTube iframe",
      r.iframes.length === 1,
      "len=" + r.iframes.length,
    );
    check(
      label + " B1: keeps the most-recently-added iframe",
      r.iframes[0] === c,
    );
    check(
      label + " B1: removed iframes detached (parentNode nulled)",
      a.parentNode === null && b.parentNode === null,
    );
    check(label + " B1: __shellYtCaps counts the 2 removals", r.caps() === 2);
  }

  // B2: a single YT iframe is left playable.
  {
    const r = runGuard(iife);
    const a = r.add(YT);
    r.tick();
    check(
      label + " B2: single trailer kept",
      r.iframes.length === 1 && r.iframes[0] === a,
    );
    check(label + " B2: no removals counted", r.caps() === 0);
  }

  // B3: non-YouTube iframes are never touched.
  {
    const r = runGuard(iife);
    r.add(NOTYT);
    r.add(NOTYT);
    r.add(NOTYT);
    r.tick();
    check(label + " B3: non-YouTube iframes all kept", r.iframes.length === 3);
    check(label + " B3: no removals counted", r.caps() === 0);
  }

  // B4: non-Tizen client -> guard is inert (every trailer kept).
  {
    const r = runGuard(iife, { tizen: false });
    r.add(YT);
    r.add(YT2);
    r.add(YT3);
    r.tick();
    check(label + " B4: non-Tizen keeps all trailers", r.iframes.length === 3);
    check(label + " B4: diag undefined on non-Tizen", r.caps() === undefined);
  }

  // B5: kill switch fully disables the guard even on Tizen.
  {
    const r = runGuard(iife, { killSwitch: true });
    r.add(YT);
    r.add(YT2);
    r.tick();
    check(label + " B5: kill switch keeps all iframes", r.iframes.length === 2);
    check(
      label + " B5: kill switch leaves diag undefined",
      r.caps() === undefined,
    );
  }

  // B6: the rotation tick keeps capping as new iframes arrive after load.
  {
    const r = runGuard(iife);
    r.add(YT);
    r.tick();
    check(label + " B6: one trailer after first tick", r.iframes.length === 1);
    const c2 = r.add(YT2); // slideshow rotates in a new trailer
    r.tick();
    check(
      label + " B6: re-capped to one after rotation",
      r.iframes.length === 1,
    );
    check(label + " B6: keeps the newest after rotation", r.iframes[0] === c2);
  }
}

execScenarios("shell.js", extractGuardIIFE(tvSrc));
execScenarios("boot-shell.src.js", extractGuardIIFE(bootSrc));

if (failures) {
  console.error("\n" + failures + " FAILURE(S)");
  process.exit(1);
}
console.log("\nALL OK");
