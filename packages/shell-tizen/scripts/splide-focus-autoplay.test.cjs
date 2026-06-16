// JEL-187 verification — media bar carousel auto-rotate on TV.
//
// The home "media bar" / EditorsChoice spotlight carousel uses Splide (@4.1.4)
// and never sets pauseOnFocus/pauseOnHover, so both default to TRUE. On a TV
// the D-pad focus lands inside the carousel and never leaves (no blur), so
// Splide's focusin handler pauses autoplay permanently — it advances once
// (slide 1 -> 2) then is stuck. A desktop browser is pointer-driven (no sticky
// focus) so it keeps rotating, which is why this only reproduces on the TV.
//
// The seed's Splide-focus shim wraps the global Splide constructor BEFORE the
// plugin's `new Splide(...)` runs and forces pauseOnFocus:false +
// pauseOnHover:false. With those false Splide never even binds the focus/hover
// listeners, so a sticky TV focus can never pause autoplay.
//
// This test extracts the shim from the ACTUAL built seed (via the shipped
// buildSeedScript()) of BOTH source artifacts and executes it in a sandbox
// with a fake Splide constructor, asserting the override is applied, other
// options are preserved, the wrap is idempotent, statics/prototype survive,
// and the kill switch disarms it.
//
// Run: node scripts/splide-focus-autoplay.test.cjs

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
  'localStorage.getItem("jellyfin.shell.splideFocusPauseDisabled")==="1"';

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

// Build the real seed text from a source artifact, then slice the shim IIFE
// out of it (from the kill-switch opener back to the enclosing try, forward
// to the first 2-space-indented IIFE closer).
function extractShim(src, label) {
  const fnSrc = extractTopFn(src, "buildSeedScript").replace(
    /^  function buildSeedScript/,
    "function",
  );
  const sb = { Object, JSON, TX_VER: "testver" };
  vm.createContext(sb);
  const buildSeedScript = vm.runInContext("(" + fnSrc + ")", sb);
  const seed = buildSeedScript("https://tv.example.test", {});
  const kill = seed.indexOf(KILL_LINE);
  check(label + ": built seed contains the kill-switch line", kill !== -1);
  if (kill === -1) return null;
  const start = seed.lastIndexOf("try{(function(){", kill);
  const endMark = "\n  })();}catch(_){}";
  const end = seed.indexOf(endMark, kill);
  check(
    label + ": shim IIFE boundaries resolve",
    start !== -1 && end !== -1 && start < kill && kill < end,
  );
  if (start === -1 || end === -1) return null;
  return seed.slice(start, end + endMark.length);
}

const TV_UA =
  "Mozilla/5.0 (SMART-TV; Linux; Tizen 5.0) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/63.0.3239.84 Safari/537.36";

// Minimal window with localStorage; the shim runs with `window` === sandbox
// global, so build via createContext on the window object itself.
function makeSandbox(opts) {
  const win = {};
  win.window = win;
  win.console = { error() {}, warn() {}, log() {} };
  win.navigator = { userAgent: TV_UA };
  win.localStorage = {
    getItem(k) {
      return (opts && opts.storage && opts.storage[k]) || null;
    },
  };
  win.Object = Object;
  if (opts && opts.preSplide) win.Splide = opts.preSplide;
  vm.createContext(win);
  return win;
}

// A stand-in for the CDN Splide constructor: records the last options object it
// was constructed with, exposes a `mount()` (the plugin chains `.mount()`), and
// carries an enumerable static so we can assert statics survive the wrap.
function makeFakeSplide() {
  function FakeSplide(sel, opts) {
    this.sel = sel;
    this.opts = opts;
    FakeSplide.lastSel = sel;
    FakeSplide.lastOpts = opts;
    FakeSplide.builds = (FakeSplide.builds || 0) + 1;
  }
  FakeSplide.prototype.mount = function () {
    return this;
  };
  FakeSplide.STATIC = 42; // enumerable own static
  return FakeSplide;
}

for (const [label, file] of [
  ["shell.js", TV_SHELL],
  ["boot-shell.src.js", BOOT_SRC],
]) {
  const src = fs.readFileSync(file, "utf8");

  // -- contract pins on the source artifact --
  check(
    label + ": shim kill switch present",
    src.includes("jellyfin.shell.splideFocusPauseDisabled"),
  );
  check(
    label + ": shim exposes __shellSplideFocusShim sentinel",
    src.includes("__shellSplideFocusShim"),
  );
  check(
    label + ": shim forces pauseOnFocus off",
    src.includes("opts.pauseOnFocus=false"),
  );
  check(
    label + ": shim forces pauseOnHover off",
    src.includes("opts.pauseOnHover=false"),
  );
  check(
    label + ": shim intercepts the window.Splide global via defineProperty",
    src.includes('Object.defineProperty(window,"Splide"'),
  );

  const shim = extractShim(src, label);
  if (!shim) continue;

  // The shipped shim (no comments — it's built from the seed string array)
  // must key only off the generic window.Splide global, never a plugin name.
  check(
    label + ": built shim has no plugin-name coupling",
    !/editorschoice|mediabar|media-bar|splide@/i.test(shim),
  );

  // -- T1: Splide assigned AFTER the shim (the real CDN-load order) gets
  //        wrapped; pauseOnFocus/pauseOnHover forced off, other opts kept --
  {
    const win = makeSandbox();
    vm.runInContext(shim, win);
    check(label + " T1: shim armed", win.__shellSplideFocusShim === 1);

    const Fake = makeFakeSplide();
    win.Splide = Fake; // CDN UMD assigns the global -> setter wraps it
    const Wrapped = win.Splide;
    check(label + " T1: window.Splide replaced by a wrapper", Wrapped !== Fake);

    const inst = new Wrapped("#hero .splide", {
      type: "loop",
      autoplay: true,
      interval: 10000,
    });
    check(
      label + " T1: pauseOnFocus forced false",
      Fake.lastOpts.pauseOnFocus === false,
    );
    check(
      label + " T1: pauseOnHover forced false",
      Fake.lastOpts.pauseOnHover === false,
    );
    check(
      label + " T1: caller options preserved",
      Fake.lastOpts.type === "loop" &&
        Fake.lastOpts.autoplay === true &&
        Fake.lastOpts.interval === 10000,
    );
    check(
      label + " T1: real Splide instance returned (instanceof intact)",
      inst instanceof Fake,
    );
    check(
      label + " T1: instance still chainable (mount present)",
      typeof inst.mount === "function" && inst.mount() === inst,
    );
    check(label + " T1: wrap counter exposed", win.__shellSplideWrapped === 1);
    check(
      label + " T1: enumerable statics copied onto wrapper",
      Wrapped.STATIC === 42,
    );
  }

  // -- T2: Splide ALREADY present before the shim runs is wrapped too --
  {
    const Fake = makeFakeSplide();
    const win = makeSandbox({ preSplide: Fake });
    vm.runInContext(shim, win);
    check(
      label + " T2: pre-existing Splide replaced by wrapper",
      win.Splide !== Fake,
    );
    new win.Splide("#hero .splide", { autoplay: true });
    check(
      label + " T2: pre-existing Splide also gets focus pause disabled",
      Fake.lastOpts.pauseOnFocus === false &&
        Fake.lastOpts.pauseOnHover === false,
    );
  }

  // -- T3: idempotent — re-assigning the already-wrapped ctor doesn't
  //        double-wrap (no infinite nesting, options still forced) --
  {
    const win = makeSandbox();
    vm.runInContext(shim, win);
    const Fake = makeFakeSplide();
    win.Splide = Fake;
    const first = win.Splide;
    win.Splide = first; // assign the wrapper back through the setter
    check(label + " T3: wrapper is not re-wrapped", win.Splide === first);
    new win.Splide("#x", { autoplay: true });
    check(
      label + " T3: still forces options after re-assign",
      Fake.lastOpts.pauseOnFocus === false,
    );
  }

  // -- T4: kill switch leaves the global untouched (no wrap, no forcing) --
  {
    const win = makeSandbox({
      storage: { "jellyfin.shell.splideFocusPauseDisabled": "1" },
    });
    vm.runInContext(shim, win);
    check(
      label + " T4: kill switch leaves shim unarmed",
      win.__shellSplideFocusShim === undefined,
    );
    const Fake = makeFakeSplide();
    win.Splide = Fake;
    check(
      label + " T4: window.Splide untouched when killed",
      win.Splide === Fake,
    );
    new win.Splide("#x", { autoplay: true });
    check(
      label + " T4: options NOT forced when killed (plugin defaults kept)",
      Fake.lastOpts.pauseOnFocus === undefined &&
        Fake.lastOpts.pauseOnHover === undefined,
    );
  }
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL OK");
process.exit(failures ? 1 : 0);
