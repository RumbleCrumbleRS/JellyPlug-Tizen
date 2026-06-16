// JEL-187 (corrected via JEL-188 on-device verify) — media bar carousel
// auto-rotate on TV.
//
// The user's real home carousel is the Media Bar plugin (IAmParadox27
// slideshowpure.js), NOT Splide — so the Splide pauseOnFocus shim is inert.
// slideshowpure's goToSlide() stops the auto-advance timer on every transition
// and, for a slide that HAS a trailer, only restarts it on the YouTube ENDED
// event. The YT player has no onError handler, and on the file:// TV the
// trailer fails (YT error 153, JEL-184) so ENDED never fires -> the timer never
// restarts -> the carousel sticks on the first trailer slide (on-device:
// stuck on slide index 1, timer stopped, not paused, no video playing).
//
// The seed's media-bar watchdog un-sticks it: when the active slide index has
// not advanced for a grace period while the timer is stopped, the show is not
// user-paused and no trailer is actually playing, it advances one slide. It
// must NEVER fire while a trailer legitimately plays (isVideoPlaying guard),
// while the timer is running, or while paused — so it stays harmless if/when
// JEL-184 lands.
//
// This test extracts the watchdog IIFE from the ACTUAL built seed (via the
// shipped buildSeedScript()) of BOTH source artifacts and drives its interval
// callback with a controllable clock + a fake window.slideshowPure, asserting
// the un-stick fires only in the stuck condition and the kill switch disarms.
//
// Run: node scripts/media-bar-watchdog.test.cjs

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const REPO = path.join(__dirname, "..", "..", "..");
const TV_SHELL = path.join(REPO, "packages", "shell-tizen", "src", "shell.js");
const BOOT_SRC = path.join(
  REPO,
  "packages",
  "shell-tizen-bootstrap",
  "src",
  "boot-shell.src.js",
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

const KILL_LINE =
  'localStorage.getItem("jellyfin.shell.mediaBarWatchdogDisabled")==="1"';

function extractTopFn(src, name) {
  const lines = src.split("\n");
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

// Build the real seed text, then slice the watchdog IIFE out of it (from the
// kill-switch line back to the enclosing `try{(function(){`, forward to the
// first 2-space-indented IIFE closer).
function extractWatchdog(src, label) {
  const fnSrc = extractTopFn(src, "buildSeedScript").replace(
    /^  function buildSeedScript/,
    "function",
  );
  const sb = { Object, JSON, TX_VER: "testver" };
  vm.createContext(sb);
  const buildSeedScript = vm.runInContext("(" + fnSrc + ")", sb);
  const seed = buildSeedScript("https://tv.example.test", {});
  const kill = seed.indexOf(KILL_LINE);
  check(label + ": built seed contains the watchdog kill-switch line", kill !== -1);
  if (kill === -1) return null;
  const start = seed.lastIndexOf("try{(function(){", kill);
  const endMark = "\n  })();}catch(_){}";
  const end = seed.indexOf(endMark, kill);
  check(
    label + ": watchdog IIFE boundaries resolve",
    start !== -1 && end !== -1 && start < kill && kill < end,
  );
  if (start === -1 || end === -1) return null;
  return seed.slice(start, end + endMark.length);
}

// A controllable sandbox: setInterval captures the watchdog tick callback (does
// not auto-run); Date.now() reads a mutable clock; location.hash is settable.
function makeSandbox(opts) {
  const win = {};
  win.window = win;
  win.console = { error() {}, warn() {}, log() {} };
  win.String = String;
  win.clock = 0;
  win.Date = { now: () => win.clock };
  win.__tick = null;
  win.setInterval = function (fn) {
    win.__tick = fn;
    return 1;
  };
  win.localStorage = {
    getItem(k) {
      return (opts && opts.storage && opts.storage[k]) || null;
    },
  };
  win.location = { hash: (opts && opts.hash) || "#/home" };
  vm.createContext(win);
  return win;
}

// Fake slideshowPure.STATE.slideshow whose nextSlide() advances the index and,
// like the real plugin, drops the timer entering each (trailer) slide.
function makeSlideshow(win, init) {
  const ss = {
    currentSlideIndex: init.idx || 0,
    totalItems: init.totalItems != null ? init.totalItems : 48,
    isPaused: !!init.isPaused,
    isVideoPlaying: !!init.isVideoPlaying,
    slideInterval: init.timerOn ? { timerId: 1 } : { timerId: null },
  };
  win.slideshowPure = {
    STATE: { slideshow: ss },
    nextSlide() {
      ss.currentSlideIndex += 1;
      ss.slideInterval = { timerId: null }; // trailer slide stops the timer
      win.slideshowPure.STATE.slideshow._kicks =
        (ss._kicks || 0) + 1;
      ss._kicks = (ss._kicks || 0) + 1;
    },
  };
  return ss;
}

for (const [label, file] of [
  ["shell.js", TV_SHELL],
  ["boot-shell.src.js", BOOT_SRC],
]) {
  const src = fs.readFileSync(file, "utf8");

  // -- contract pins on the source artifact --
  check(
    label + ": watchdog kill switch present",
    src.includes("jellyfin.shell.mediaBarWatchdogDisabled"),
  );
  check(
    label + ": watchdog exposes __shellMediaBarWatchdog sentinel",
    src.includes("__shellMediaBarWatchdog"),
  );
  check(
    label + ": watchdog reads slideshowPure.STATE.slideshow",
    src.includes("window.slideshowPure") &&
      src.includes("STATE") &&
      src.includes("slideshow"),
  );
  check(
    label + ": watchdog guards on isVideoPlaying (harmless when trailer plays)",
    src.includes("isVideoPlaying"),
  );
  check(
    label + ": watchdog guards on isPaused",
    src.includes("isPaused"),
  );
  check(
    label + ": watchdog checks the slideInterval timer",
    src.includes("slideInterval") && src.includes("timerId"),
  );
  check(
    label + ": watchdog advances via nextSlide",
    src.includes("nextSlide"),
  );

  const wd = extractWatchdog(src, label);
  if (!wd) continue;

  // Keys only off the plugin's own global; no per-item / brand coupling.
  check(
    label + ": watchdog has no Splide/EditorsChoice coupling",
    !/editorschoice|\bsplide\b/i.test(wd),
  );

  const GRACE = 10000;

  // -- T1: stuck trailer slide (timer off, not paused, no video) advances
  //        after the grace period, and only after it --
  {
    const win = makeSandbox();
    vm.runInContext(wd, win);
    check(label + " T1: watchdog armed", win.__shellMediaBarWatchdog === 1);
    check(label + " T1: interval callback registered", typeof win.__tick === "function");
    const ss = makeSlideshow(win, { idx: 1, timerOn: false });

    win.clock = 1000;
    win.__tick(); // first observation: records idx=1, lastChange=1000
    check(label + " T1: no premature advance on first tick", ss.currentSlideIndex === 1);

    win.clock = 1000 + GRACE - 1;
    win.__tick(); // still within grace
    check(label + " T1: no advance before grace elapses", ss.currentSlideIndex === 1);

    win.clock = 1000 + GRACE + 1;
    win.__tick(); // grace elapsed while stuck -> advance
    check(label + " T1: advances once grace elapses", ss.currentSlideIndex === 2);
  }

  // -- T2: never fires while a trailer is legitimately playing --
  {
    const win = makeSandbox();
    vm.runInContext(wd, win);
    const ss = makeSlideshow(win, { idx: 1, timerOn: false, isVideoPlaying: true });
    win.clock = 1000;
    win.__tick();
    win.clock = 1000 + GRACE + 5000;
    win.__tick();
    check(
      label + " T2: no advance while isVideoPlaying",
      ss.currentSlideIndex === 1,
    );
  }

  // -- T3: never fires while the auto-advance timer is running --
  {
    const win = makeSandbox();
    vm.runInContext(wd, win);
    const ss = makeSlideshow(win, { idx: 1, timerOn: true });
    win.clock = 1000;
    win.__tick();
    win.clock = 1000 + GRACE + 5000;
    win.__tick();
    check(label + " T3: no advance while timer running", ss.currentSlideIndex === 1);
  }

  // -- T4: never fires while paused --
  {
    const win = makeSandbox();
    vm.runInContext(wd, win);
    const ss = makeSlideshow(win, { idx: 1, timerOn: false, isPaused: true });
    win.clock = 1000;
    win.__tick();
    win.clock = 1000 + GRACE + 5000;
    win.__tick();
    check(label + " T4: no advance while paused", ss.currentSlideIndex === 1);
  }

  // -- T5: a natural index change resets the stall clock (no spurious kick) --
  {
    const win = makeSandbox();
    vm.runInContext(wd, win);
    const ss = makeSlideshow(win, { idx: 1, timerOn: false });
    win.clock = 1000;
    win.__tick(); // observe idx 1
    ss.currentSlideIndex = 2; // carousel moved on its own
    win.clock = 1000 + GRACE + 1;
    win.__tick(); // sees a new index -> resets, no advance
    check(label + " T5: index change resets stall (no kick)", ss.currentSlideIndex === 2);
    win.clock = 1000 + GRACE + 1 + GRACE + 1;
    win.__tick(); // now stuck on 2 long enough -> advance to 3
    check(label + " T5: advances again once newly stuck", ss.currentSlideIndex === 3);
  }

  // -- T6: dormant off the home view --
  {
    const win = makeSandbox({ hash: "#/movies" });
    vm.runInContext(wd, win);
    const ss = makeSlideshow(win, { idx: 1, timerOn: false });
    win.clock = 1000;
    win.__tick();
    win.clock = 1000 + GRACE + 5000;
    win.__tick();
    check(label + " T6: no advance when not on home", ss.currentSlideIndex === 1);
  }

  // -- T7: dormant with a single-slide (or empty) carousel --
  {
    const win = makeSandbox();
    vm.runInContext(wd, win);
    const ss = makeSlideshow(win, { idx: 0, totalItems: 1, timerOn: false });
    win.clock = 1000;
    win.__tick();
    win.clock = 1000 + GRACE + 5000;
    win.__tick();
    check(label + " T7: no advance with <2 items", ss.currentSlideIndex === 0);
  }

  // -- T8: kill switch leaves the watchdog unarmed --
  {
    const win = makeSandbox({
      storage: { "jellyfin.shell.mediaBarWatchdogDisabled": "1" },
    });
    vm.runInContext(wd, win);
    check(
      label + " T8: kill switch leaves watchdog unarmed",
      win.__shellMediaBarWatchdog === undefined && win.__tick === null,
    );
  }

  // -- T9: re-running the seed twice does not double-arm (idempotent) --
  {
    const win = makeSandbox();
    vm.runInContext(wd, win);
    win.__tick = null; // a second seed run would re-register only if not guarded
    vm.runInContext(wd, win);
    check(
      label + " T9: second arm is a no-op (guard holds)",
      win.__tick === null,
    );
  }
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL OK");
process.exit(failures ? 1 : 0);
