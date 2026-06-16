// JEL-195 — plugin-agnosticism guard for the shipping shell seed.
//
// The shell is a thin loader: it must boot jellyfin-web 1:1 so *any* server
// plugin works. It must NOT embed behavioral code that reaches into the
// private internals of one particular plugin. JEL-187 had violated this with
// (1) a Media Bar (IAmParadox27 slideshowpure.js) rotation watchdog that read
// the plugin's private `window.slideshowPure.STATE.slideshow` shape and called
// `sp.nextSlide()`, and (2) a dead `window.Splide` focus-pause shim. Both were
// removed under JEL-195; the real, plugin-agnostic carousel fix lives in
// JEL-184 (serve the YouTube embed from an https origin so the plugin's own
// auto-advance timer restarts naturally).
//
// This guard builds the ACTUAL shipping seed (via the shipped
// buildSeedScript()) of BOTH source artifacts and asserts none of the
// plugin-internal coupling tokens appear in what ships. Building the seed (vs.
// grepping the source) means historical JS `//` comments are excluded — only
// the real runtime payload is checked.
//
// Run: node scripts/plugin-agnostic-shell.test.cjs

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

// Forbidden tokens: each names a single plugin's private internal contract or a
// library-specific shim that has no place in a thin, plugin-agnostic shell.
const FORBIDDEN = [
  // Media Bar (slideshowPure) plugin-internal coupling (JEL-187 watchdog).
  "slideshowPure",
  "currentSlideIndex",
  "isVideoPlaying",
  "slideInterval",
  "__shellMediaBarWatchdog",
  "__shellMediaBarKicks",
  "mediaBarWatchdogDisabled",
  // Splide library focus-pause shim (JEL-187, proven inert by JEL-188).
  "pauseOnFocus",
  "pauseOnHover",
  "__shellSplideFocusShim",
  "__shellSplideWrapped",
  "splideFocusPauseDisabled",
];

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

function buildSeed(src) {
  const fnSrc = extractTopFn(src, "buildSeedScript").replace(
    /^  function buildSeedScript/,
    "function",
  );
  const sb = { Object, JSON, TX_VER: "testver" };
  vm.createContext(sb);
  const buildSeedScript = vm.runInContext("(" + fnSrc + ")", sb);
  return buildSeedScript("https://tv.example.test", {});
}

for (const [label, file] of [
  ["shell.js", TV_SHELL],
  ["boot-shell.src.js", BOOT_SRC],
]) {
  const src = fs.readFileSync(file, "utf8");
  const seed = buildSeed(src);
  check(
    label + ": seed builds and is non-empty",
    typeof seed === "string" && seed.length > 0,
  );

  for (const token of FORBIDDEN) {
    check(
      label + ": shipping seed has no plugin-internal coupling — " + token,
      seed.indexOf(token) === -1,
      "found forbidden token in built seed",
    );
  }

  // Belt-and-suspenders: the JEL-187 IIFEs are gone, so the seed must not
  // wrap the global Splide constructor either.
  check(
    label + ": seed does not wrap window.Splide",
    !/Object\.defineProperty\(window,"Splide"/.test(seed),
  );
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL OK");
process.exit(failures ? 1 : 0);
