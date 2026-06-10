// JEL-98 guard — the on-screen diagnostics overlay must be opt-in.
//
// BUG (JEL-98): a user installed a release .wgt straight from GitHub, following
// the README, and the green diagnostics overlay (`#__shell_diag`) rendered on
// top of the app — dumping shell version, transpile counters, and captured
// `registerElement` console errors over the UI. Root cause: buildDiagSeedScript()
// in BOTH shells called `start()` (which renders the visible <div>) on every
// boot, with no gate. The overlay was only ever meant for debugging.
//
// FIX: the visible overlay is now gated behind the SAME flag as shellLog() —
// localStorage['jellyfin.shell.debug'] === '1'. The error/warn/stat CAPTURE into
// window.__shellDiag still runs unconditionally (harnesses read it via REST/CDP),
// only the on-screen render is suppressed for retail users.
//
// This test executes the REAL seed script the shell emits (extracted from each
// source's buildDiagSeedScript) under a mock DOM, and asserts:
//   - flag unset  -> no `#__shell_diag` element is ever appended (retail default)
//   - flag === '1' -> the overlay element IS created (debugging still works)
//   - window.__shellDiag is populated either way (capture is unconditional)
// It also statically asserts the deployed blobs carry the gate.
//
// Run: node scripts/diag-overlay-gating.test.cjs

const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..", "..", "..");
const FILES = {
  "shell.js (TV)": path.join(REPO, "packages", "shell-tizen", "src", "shell.js"),
  "boot-shell.src.js (hosted/TV bootstrap)": path.join(
    REPO,
    "packages",
    "shell-tizen-bootstrap",
    "src",
    "boot-shell.src.js",
  ),
};
const BLOBS = {
  "shell.min.js": path.join(
    REPO,
    "packages",
    "shell-tizen",
    "src",
    "shell.min.js",
  ),
  "boot-shell.min.js": path.join(
    REPO,
    "packages",
    "shell-tizen-bootstrap",
    "src",
    "boot-shell.min.js",
  ),
};

let pass = 0;
let fail = 0;
function ok(msg) {
  pass++;
  console.log("OK  ", msg);
}
function bad(msg) {
  fail++;
  console.error("FAIL", msg);
}
function check(cond, msg) {
  cond ? ok(msg) : bad(msg);
}

// Pull `function buildDiagSeedScript(shellVersion){ ... }` out of a source file
// by brace-matching, so we run the actual shipped seed builder.
function extractFn(src, name) {
  const start = src.indexOf("function " + name + "(");
  if (start < 0) throw new Error("could not find function " + name);
  const open = src.indexOf("{", start);
  let depth = 0;
  let i = open;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
  }
  return src.slice(start, i);
}

// Minimal DOM/window mock sufficient for the seed script to run to completion.
// Records whether the visible overlay element is appended to <body>.
function runSeed(seedScript, debugFlag) {
  const appended = [];
  const byId = {};
  function makeEl() {
    return {
      id: "",
      style: { cssText: "" },
      textContent: "",
      setAttribute() {},
    };
  }
  const body = {
    appendChild(el) {
      appended.push(el);
      if (el.id) byId[el.id] = el;
    },
  };
  const store = {};
  if (debugFlag !== undefined) store["jellyfin.shell.debug"] = debugFlag;

  const win = {};
  const documentMock = {
    readyState: "complete",
    body,
    createElement: makeEl,
    getElementById(id) {
      return byId[id] || null;
    },
    addEventListener() {},
    querySelector() {
      return null;
    },
  };
  const sandbox = {
    window: win,
    document: documentMock,
    navigator: { userAgent: "Mozilla/5.0 (Tizen test)" },
    localStorage: {
      getItem(k) {
        return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null;
      },
    },
    console: { log() {}, warn() {}, error() {} },
    setInterval() {
      return 0;
    },
    clearInterval() {},
    setTimeout() {
      return 0;
    },
    Date: { now: () => 1000 },
  };
  win.addEventListener = () => {};
  win.__shellT0 = 1000;

  // Build the seed-builder, get the seed string, run it in the sandbox.
  const make = new Function(
    "return (" + extractFn(seedScript, "buildDiagSeedScript") + ")",
  )();
  const seed = make("1.0.0-test");
  const argNames = Object.keys(sandbox);
  const argVals = argNames.map((n) => sandbox[n]);
  // eslint-disable-next-line no-new-func
  new Function(...argNames, seed)(...argVals);

  return {
    overlayCreated: appended.some((el) => el.id === "__shell_diag"),
    diagCaptured: !!win.__shellDiag && Array.isArray(win.__shellDiag.errors),
  };
}

for (const [label, file] of Object.entries(FILES)) {
  const src = fs.readFileSync(file, "utf8");

  const off = runSeed(src, undefined);
  check(
    !off.overlayCreated,
    `${label}: NO overlay element when jellyfin.shell.debug is unset (retail default)`,
  );
  check(
    off.diagCaptured,
    `${label}: __shellDiag capture object still initialised when flag unset (harness reads intact)`,
  );

  const wrong = runSeed(src, "0");
  check(
    !wrong.overlayCreated,
    `${label}: NO overlay element when jellyfin.shell.debug === "0"`,
  );

  const on = runSeed(src, "1");
  check(
    on.overlayCreated,
    `${label}: overlay element IS created when jellyfin.shell.debug === "1" (debugging preserved)`,
  );

  // Static: the gate must reference the debug flag, and start() must be inside it.
  check(
    /__diagShow[\s\S]{0,120}jellyfin\.shell\.debug/.test(src) &&
      /if\(__diagShow\)\{if\(document\.readyState/.test(src),
    `${label}: visible-overlay dispatch is wrapped in the debug-flag gate`,
  );
  // Negative: no UN-gated top-level start dispatch left behind.
  check(
    !/}\n?\s*'if\(document\.readyState==="loading"\)\{document\.addEventListener\("DOMContentLoaded",start\);\}else\{start\(\);\}',/.test(
      src,
    ),
    `${label}: the old un-gated overlay dispatch is gone`,
  );
}

// Deployed blobs must carry the gate verbatim (no un-gated overlay ships).
for (const [label, blob] of Object.entries(BLOBS)) {
  const text = fs.readFileSync(blob, "utf8");
  check(
    text.includes("__diagShow") &&
      text.includes('jellyfin.shell.debug")==="1') &&
      text.includes("if(__diagShow){if(document.readyState"),
    `${label} (deployed): overlay render is debug-gated`,
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
