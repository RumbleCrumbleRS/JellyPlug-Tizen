// JEL-129 verification — late window.onload rescue (legacy Chromium only).
//
// Server plugins that arm themselves via `window.onload = fn` (EditorsChoice,
// the home "media bar" spotlight) work in a real browser because they run as
// true deferred <script src> tags BEFORE the load event. Inside the shell's
// rewritten document on Chromium 56, deferred bundles never auto-execute
// after document.open/write (JEL-99), so `load` fires early while the
// inlined/jQuery-gated plugin body runs much later — its onload assignment
// lands AFTER load and is silently dead (JEL-88: tx executed, ecAdded=0,
// splide=undefined). The seed's late-onload shim restores browser parity by
// invoking late-registered load handlers (property assignment or
// window.addEventListener("load", ...)) once, asynchronously.
//
// This test extracts the shim from the ACTUAL built seed (via the shipped
// buildSeedScript()) of both source artifacts and executes it in a sandbox
// under TV and browser userAgents with a virtual timer.
//
// Run: node scripts/late-onload.test.cjs

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
  'localStorage.getItem("jellyfin.shell.lateOnloadDisabled")==="1"';

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
  "(KHTML, like Gecko) Chrome/56.0.2924.0 Safari/537.36";
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Sandbox with virtual timers and a minimal window/document. The shim runs
// with `window` === sandbox global (its window.* and bare references must hit
// the same object), so build via createContext on the window object itself.
function makeSandbox(ua, opts) {
  const timers = [];
  const loadListeners = [];
  const win = {};
  win.window = win;
  win.console = { error() {}, warn() {}, log() {} };
  win.navigator = { userAgent: ua };
  win.localStorage = {
    getItem(k) {
      return (opts && opts.storage && opts.storage[k]) || null;
    },
  };
  win.document = {
    readyState: (opts && opts.readyState) || "loading",
    createEvent() {
      return {
        type: null,
        initEvent(t) {
          this.type = t;
        },
      };
    },
  };
  win.setTimeout = function (fn, ms) {
    timers.push({ fn, ms });
    return timers.length;
  };
  win.addEventListener = function (type, fn) {
    if (type === "load") loadListeners.push(fn);
  };
  win.Object = Object;
  win.Function = Function;
  vm.createContext(win);
  return {
    win,
    flushTimers() {
      while (timers.length) timers.shift().fn();
    },
    fireLoad() {
      win.document.readyState = "complete";
      // copy: listeners registered during dispatch must not fire this round
      loadListeners.slice().forEach((fn) => fn({ type: "load" }));
    },
  };
}

for (const [label, file] of [
  ["shell.js", TV_SHELL],
  ["boot-shell.src.js", BOOT_SRC],
]) {
  const src = fs.readFileSync(file, "utf8");

  // -- contract pins on the source artifact --
  check(
    label + ": shim kill switch present",
    src.includes("jellyfin.shell.lateOnloadDisabled"),
  );
  check(
    label + ": shim exposes __shellLateOnloadShim sentinel",
    src.includes("__shellLateOnloadShim"),
  );
  check(
    label + ": shim shadows window.onload via defineProperty",
    src.includes('Object.defineProperty(window,"onload"'),
  );

  const shim = extractShim(src, label);
  if (!shim) continue;

  // -- T1: TV UA, pre-load assignment still fires exactly once at load --
  {
    const sb = makeSandbox(TV_UA);
    vm.runInContext(shim, sb.win);
    check(
      label + " T1: shim armed on TV UA",
      sb.win.__shellLateOnloadShim === 1,
    );
    let runs = 0;
    sb.win.onload = function () {
      runs++;
    };
    sb.flushTimers();
    check(label + " T1: pre-load assignment does NOT run early", runs === 0);
    sb.fireLoad();
    sb.flushTimers();
    check(label + " T1: handler ran exactly once at load", runs === 1);
    sb.fireLoad(); // a second (bogus) load must not double-run
    sb.flushTimers();
    check(label + " T1: no double-run on repeated load", runs === 1);
  }

  // -- T2: TV UA, POST-load property assignment fires once (the JEL-129 fix) --
  {
    const sb = makeSandbox(TV_UA);
    vm.runInContext(shim, sb.win);
    sb.fireLoad();
    let runs = 0;
    sb.win.onload = function () {
      runs++;
    };
    check(label + " T2: late handler deferred (async)", runs === 0);
    sb.flushTimers();
    check(label + " T2: late onload assignment ran exactly once", runs === 1);
    check(
      label + " T2: assign/run counters exposed",
      sb.win.__shellLateOnloadAssigns === 1 &&
        sb.win.__shellLateOnloadRuns === 1,
    );
  }

  // -- T3: TV UA, readyState already complete (load fired before shim's
  //        listener could see it) — assignment still rescued --
  {
    const sb = makeSandbox(TV_UA, { readyState: "complete" });
    vm.runInContext(shim, sb.win);
    let runs = 0;
    sb.win.onload = function () {
      runs++;
    };
    sb.flushTimers();
    check(label + " T3: readyState=complete assignment rescued", runs === 1);
  }

  // -- T4: TV UA, late window.addEventListener("load") rescued --
  {
    const sb = makeSandbox(TV_UA);
    vm.runInContext(shim, sb.win);
    sb.fireLoad();
    let runs = 0;
    sb.win.addEventListener("load", function () {
      runs++;
    });
    sb.flushTimers();
    check(label + " T4: late addEventListener('load') ran once", runs === 1);
  }

  // -- T5: browser UA — shim self-disables, native semantics untouched --
  {
    const sb = makeSandbox(BROWSER_UA);
    vm.runInContext(shim, sb.win);
    check(
      label + " T5: shim inert on modern browser UA",
      sb.win.__shellLateOnloadShim === undefined,
    );
    sb.fireLoad();
    let runs = 0;
    sb.win.onload = function () {
      runs++;
    };
    sb.flushTimers();
    check(
      label + " T5: no late rescue in browser (parity: spec behavior)",
      runs === 0,
    );
  }

  // -- T6: kill switch disables the shim on TV --
  {
    const sb = makeSandbox(TV_UA, {
      storage: { "jellyfin.shell.lateOnloadDisabled": "1" },
    });
    vm.runInContext(shim, sb.win);
    check(
      label + " T6: kill switch leaves shim unarmed",
      sb.win.__shellLateOnloadShim === undefined,
    );
  }
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL OK");
process.exit(failures ? 1 : 0);
