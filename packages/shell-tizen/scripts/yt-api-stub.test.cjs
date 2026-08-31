// JELA-725 verification — jp725 local YouTube IFrame API stub.
//
// BACKGROUND. The JELA-720 cold-boot census found boot touching 7 origins.
// One of them, www.youtube.com (2 requests / 13 KiB, first byte at 3,657 ms),
// is reached BEFORE first paint with nothing playing. Attribution (JELA-725
// thread): it is NOT jellyfin-web's youtubePlayer plugin — that one is already
// lazy, appending its tag only from setCurrentSrc() on the play path. It is the
// media bar (vendored slideshowpure, JSI entry `mediabar-tizen5-rescue`), whose
// init chain awaits loadYouTubeAPI() unconditionally before slidesInit():
//
//   loadYouTubeAPI=()=>(STATE.slideshow.ytPromise||(STATE.slideshow.ytPromise=
//     new Promise(e=>{
//       if(window.YT&&window.YT.Player){e(window.YT);return}          // <-- 1
//       if(window.onYouTubeIframeAPIReady=()=>e(window.YT),
//          !document.querySelector('script[src*="youtube.com/iframe_api"]')){
//         const t=document.createElement("script");
//         t.src="https://www.youtube.com/iframe_api";                 // <-- 2
//         ...insertBefore...
//       }})),STATE.slideshow.ytPromise)
//
// Line 1 runs before line 2. Defining window.YT.Player at seed time therefore
// resolves the promise synchronously and the tag at line 2 is never created —
// the origin leaves the pre-firstCard window entirely, and slidesInit() starts
// EARLIER rather than later (the ticket's suggested "defer the fetch" would
// have pushed it later, per the JELA-715 .bar-loading finding).
//
// The no-op Player cannot regress trailers on Tizen: the media bar only derives
// a videoId under jpQmNative() (an iframe contentWindow.queueMicrotask probe,
// native only on Chrome >= 71, so FALSE on Tizen 5.0 / M63), and JEL-238/484
// blanks every youtube iframe src to about:blank on Tizen anyway. The stub is
// consumed only by the awaited resolve, never by a playback path — which is why
// it stands down whenever the JEL-238 cap is disabled.
//
// WHAT THIS PINS
//   PART A — CONTRACT (all four shipped artifacts): enable flag, kill switch,
//            JEL-238 cap coupling, Tizen UA gate, diag counter, ES5 body, and
//            no plugin name in the block.
//   PART B — EXECUTION (both src seeds, lifted into a fake DOM vm):
//     B1. default (no flag) -> inert. The block ships FLAG-DARK.
//     B2. flag on + Tizen -> window.YT.Player is a constructor,
//         window.__shellYtApiStub === 1, YT.PlayerState populated.
//     B3. flag on + non-Tizen -> inert (desktop keeps the real API).
//     B4. flag on + own kill switch -> inert.
//     B5. flag on + JEL-238 cap disabled -> inert (coupling holds).
//     B6. a real window.YT already present is never clobbered.
//     B7. INTEGRATION: the REAL media-bar loadYouTubeAPI body, run against the
//         post-stub window, resolves AND creates no <script> tag / touches no
//         youtube.com URL. Flag-off control proves the tag would otherwise be
//         created, so B7 measures the stub and not the harness.
//     B8. a pre-existing onYouTubeIframeAPIReady is invoked (late-arm safety).
//     B9. the stubbed Player constructs and its methods are callable no-ops,
//         so a non-Tizen-gated caller could never throw.
//
// Run: node scripts/yt-api-stub.test.cjs
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

// Extract the jp725 IIFE. The enable-flag literal is unique to this block and
// the first `})();}catch(_){}` after it is its own IIFE close, so a non-greedy
// match isolates exactly the injected block.
function extractStubIIFE(src) {
  const m = src.match(
    /(\(function\(\)\{if\(localStorage\.getItem\("jellyfin\.shell\.ytApiStub"\)[\s\S]*?\}\)\(\);)\}catch\(_\)\{\}/,
  );
  return m ? m[1] : null;
}

// ============================================================================
// PART A — CONTRACT
// ============================================================================
for (const [name, src] of ARTIFACTS) {
  check(
    name + ": enable flag present",
    src.includes('"jellyfin.shell.ytApiStub"'),
  );
  // JELA-827: pin the read EXPRESSION, not the key — "ytApiStub" also
  // substring-matches "ytApiStubDisabled". Minification preserves the
  // expression verbatim, so the same literal works for src and min.
  check(
    name + ': JELA-827: gate reads ==="0" (opt-OUT)',
    src.includes('localStorage.getItem("jellyfin.shell.ytApiStub")==="0"'),
  );
  check(
    name + ': JELA-827: old opt-in gate !=="1" is gone',
    !src.includes('localStorage.getItem("jellyfin.shell.ytApiStub")!=="1"'),
  );
  check(
    name + ": kill switch present",
    src.includes("jellyfin.shell.ytApiStubDisabled"),
  );
  check(
    name + ": JEL-238 cap coupling present",
    src.includes("jellyfin.shell.ytIframeCapDisabled"),
  );
  check(name + ": diag counter present", src.includes("__shellYtApiStub"));

  const iife = extractStubIIFE(src);
  check(name + ": stub IIFE extractable", !!iife);
  if (!iife) continue;

  check(
    name + ": Tizen UA gate inside block",
    /\/Tizen\/\.test\(navigator\.userAgent/.test(iife),
  );
  check(name + ": installs YT.Player", /window\.YT=\{[^}]*Player:/.test(iife));
  check(name + ": installs YT.PlayerState", iife.includes("PlayerState:"));
  // ES5 only — this runs pre-polyfill on Chromium 56/63.
  check(name + ": body is ES5 (no arrow functions)", iife.indexOf("=>") === -1);
  check(
    name + ": body is ES5 (no template literals)",
    iife.indexOf("`") === -1,
  );
  check(name + ": body is ES5 (no let/const)", !/\b(let|const)\s/.test(iife));
  check(name + ": no eval", iife.indexOf("eval(") === -1);
  // Content-pattern based, never plugin-name coupled.
  check(
    name + ": names no plugin (slideshowPure)",
    iife.indexOf("slideshowPure") === -1,
  );
  // The whole point: the block must not itself reference the origin it removes.
  check(
    name + ": block never names the youtube origin",
    iife.indexOf("youtube.com") === -1,
  );
}

// ============================================================================
// PART B — EXECUTION
// ============================================================================

// Minimal fake DOM. The block only uses localStorage, navigator.userAgent and
// window; the B7 integration additionally needs document.createElement /
// querySelector / getElementsByTagName to observe tag insertion.
// `defer: true` builds the sandbox WITHOUT executing the block, so a scenario
// can seed window state first and then call run(). Seeding after execution
// would be meaningless — the block runs once, at seed time.
function runStub(
  iife,
  { tizen = true, flag = "1", store: extra, defer = false } = {},
) {
  const store = {};
  if (flag !== null) store["jellyfin.shell.ytApiStub"] = flag;
  Object.assign(store, extra || {});

  const created = [];
  const inserted = [];
  const scripts = [{ tagName: "SCRIPT", src: "", parentNode: null }];
  scripts[0].parentNode = {
    insertBefore(node) {
      inserted.push(node);
      return node;
    },
  };

  const win = {};
  const sandbox = {
    window: win,
    navigator: {
      userAgent: tizen
        ? "Mozilla/5.0 (SmartHub; Tizen 5.0)"
        : "Mozilla/5.0 (X11; Linux) Chrome/120",
    },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
    },
    document: {
      createElement(tag) {
        const el = { tagName: String(tag).toUpperCase(), src: "" };
        created.push(el);
        return el;
      },
      querySelector: () => null,
      getElementsByTagName: () => scripts,
      documentElement: {},
    },
    Promise: Promise,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const run = () => vm.runInContext(iife, sandbox);
  if (!defer) run();
  return { sandbox, win, created, inserted, run };
}

// The REAL media-bar loadYouTubeAPI, transcribed from the vendored
// slideshowpure copy in JSI entry `mediabar-tizen5-rescue` (arrow functions
// lowered to ES5 for the vm; control flow and ORDER of the two branches are
// preserved exactly, which is the only thing under test here).
const LOAD_YT_API_SRC = `
  var STATE={slideshow:{ytPromise:null}};
  function loadYouTubeAPI(){
    if(STATE.slideshow.ytPromise)return STATE.slideshow.ytPromise;
    STATE.slideshow.ytPromise=new Promise(function(resolve){
      if(window.YT&&window.YT.Player){resolve(window.YT);return}
      window.onYouTubeIframeAPIReady=function(){resolve(window.YT)};
      if(!document.querySelector('script[src*="youtube.com/iframe_api"]')){
        var t=document.createElement("script");
        t.src="https://www.youtube.com/iframe_api";
        var s=document.getElementsByTagName("script")[0];
        s.parentNode.insertBefore(t,s);
      }
    });
    return STATE.slideshow.ytPromise;
  }
  window.__loadYouTubeAPI=loadYouTubeAPI;
`;

async function execScenarios(label, iife) {
  if (!iife) {
    check(label + ": stub IIFE present", false);
    return;
  }

  // B1: JELA-827 — the key is channel-seeded and the JSI channel runs only
  // after the lite->SPA handoff (JELA-802), so a cold boot has NO key. Absent
  // must therefore mean ON, or the stub is dead on every fresh install.
  {
    const r = runStub(iife, { flag: null });
    check(
      label + " B1: JELA-827 flag ABSENT -> stub installed (opt-OUT)",
      !!r.win.YT && typeof r.win.YT.Player === "function",
    );
    check(
      label + " B1: JELA-827 flag ABSENT -> diag set",
      r.win.__shellYtApiStub === 1,
    );
  }

  // B1b: JELA-827 kill switch — the flag itself set to "0" stands the block
  // down, proving the gate is live and not merely deleted. Note this kill is
  // NOT durable: the JELA-725 seeder re-writes ytApiStub="1" unless
  // ytApiStubDisabled==="1" (B4), which is the durable per-TV kill.
  {
    const r = runStub(iife, { flag: "0" });
    check(
      label + ' B1b: flag "0" -> inert (no window.YT)',
      r.win.YT === undefined,
    );
    check(
      label + ' B1b: flag "0" -> diag undefined',
      r.win.__shellYtApiStub === undefined,
    );
  }

  // B2: flag on + Tizen -> stub installed.
  {
    const r = runStub(iife);
    check(
      label + " B2: YT.Player is a constructor",
      typeof r.win.YT === "object" &&
        r.win.YT !== null &&
        typeof r.win.YT.Player === "function",
    );
    check(label + " B2: diag set", r.win.__shellYtApiStub === 1);
    check(
      label + " B2: PlayerState populated",
      !!r.win.YT &&
        r.win.YT.PlayerState.PLAYING === 1 &&
        r.win.YT.PlayerState.ENDED === 0 &&
        r.win.YT.PlayerState.CUED === 5,
    );
    check(
      label + " B2: installing the stub fetches nothing",
      r.created.length === 0 && r.inserted.length === 0,
    );
  }

  // B3: non-Tizen -> inert. Desktop/mobile keep the real API.
  {
    const r = runStub(iife, { tizen: false });
    check(label + " B3: non-Tizen inert", r.win.YT === undefined);
  }

  // B4: own kill switch.
  {
    const r = runStub(iife, {
      store: { "jellyfin.shell.ytApiStubDisabled": "1" },
    });
    check(label + " B4: kill switch inert", r.win.YT === undefined);
  }

  // B5: coupling — if the JEL-238 iframe cap is off, trailers are being
  // debugged, so the stub must stand down and let the real API load.
  {
    const r = runStub(iife, {
      store: { "jellyfin.shell.ytIframeCapDisabled": "1" },
    });
    check(
      label + " B5: stands down when JEL-238 cap disabled",
      r.win.YT === undefined,
    );
  }

  // B6: never clobber a real API that already loaded. Flag is ON here — the
  // early-out under test is the `window.YT&&window.YT.Player` guard, not the
  // flag check, so the YT must be seeded BEFORE the block runs.
  {
    const real = { Player: function Real() {}, __real: true };
    const r = runStub(iife, { defer: true });
    r.win.YT = real;
    r.run();
    check(label + " B6: existing YT untouched", r.win.YT === real);
    check(
      label + " B6: real API not counted as a stub install",
      r.win.__shellYtApiStub === undefined,
    );
  }

  // B7: INTEGRATION against the real loadYouTubeAPI body.
  {
    // Control: flag OFF -> the media bar DOES create the youtube.com tag.
    // JELA-827: the OFF arm must SEED "0" — an absent key is now an ON arm.
    const ctl = runStub(iife, { flag: "0" });
    vm.runInContext(LOAD_YT_API_SRC, ctl.sandbox);
    ctl.win.__loadYouTubeAPI();
    check(
      label + ' B7 control: flag "0" still creates the youtube tag',
      ctl.created.length === 1 &&
        ctl.created[0].src.indexOf("youtube.com/iframe_api") !== -1,
      "created=" + JSON.stringify(ctl.created.map((c) => c.src)),
    );
    check(
      label + " B7 control: tag inserted into the document",
      ctl.inserted.length === 1,
    );

    // Treatment: flag ON -> resolves with the stub, no tag, no origin.
    const r = runStub(iife);
    vm.runInContext(LOAD_YT_API_SRC, r.sandbox);
    const resolved = await r.win.__loadYouTubeAPI();
    check(
      label + " B7: loadYouTubeAPI resolves",
      resolved === r.win.YT && typeof resolved.Player === "function",
    );
    check(
      label + " B7: NO script element created",
      r.created.length === 0,
      "created=" + JSON.stringify(r.created.map((c) => c.src)),
    );
    check(
      label + " B7: NO tag inserted (origin never touched)",
      r.inserted.length === 0,
    );
    check(
      label + " B7: media bar never had to register its ready callback",
      r.sandbox.window.onYouTubeIframeAPIReady === undefined,
    );
  }

  // B8: a callback registered BEFORE the stub runs is still fired, so a
  // late-arming consumer cannot hang on an unresolved promise.
  {
    const r = runStub(iife, { defer: true });
    let fired = 0;
    r.win.onYouTubeIframeAPIReady = function () {
      fired++;
    };
    r.run();
    check(label + " B8: pre-existing ready callback invoked", fired === 1);
    check(label + " B8: stub still installed", !!r.win.YT);
  }

  // B9: the stubbed Player is constructible and every method is a safe no-op.
  {
    const r = runStub(iife);
    let threw = null;
    let p = null;
    try {
      p = new r.win.YT.Player("yt-player-1", {
        videoId: "abc",
        playerVars: { autoplay: 0 },
        events: { onReady: function () {}, onStateChange: function () {} },
      });
      p.mute();
      p.playVideo();
      p.pauseVideo();
      p.seekTo(0);
      p.unMute();
      p.setVolume(50);
      p.destroy();
    } catch (e) {
      threw = e;
    }
    check(
      label + " B9: Player constructs and methods no-op",
      threw === null,
      threw && threw.message,
    );
    check(
      label + " B9: getPlayerState returns UNSTARTED",
      p !== null && p.getPlayerState() === -1,
    );
  }
}

(async () => {
  await execScenarios("shell.js", extractStubIIFE(tvSrc));
  await execScenarios("boot-shell.src.js", extractStubIIFE(bootSrc));

  // The two seeds must ship the SAME block.
  check(
    "shell.js and boot-shell.src.js ship byte-identical jp725 blocks",
    extractStubIIFE(tvSrc) === extractStubIIFE(bootSrc),
  );

  if (failures) {
    console.error("\n" + failures + " FAILURE(S)");
    process.exit(1);
  }
  console.log("\nALL OK");
})();
