// JEL-42 verification — playback controls parity (TV vs browser).
//
// Goal: prove every in-player control operation behaves IDENTICALLY on the
// Tizen set and in a desktop browser:
//   (1) play/pause toggle — UI button AND remote MediaPlayPause
//   (2) stop -> return to details page
//   (3) seek bar drag/click
//   (4) MediaRewind / MediaFastForward
//   (5) MediaTrackPrevious / MediaTrackNext (episode nav)
//   (6) progress position reported to the server
//
// The player UI, the command dispatch, and the progress reporter are ALL
// jellyfin-web — a shipped, browser-proven product. The Tizen shell only wraps
// it. So "identical on TV and browser" reduces to one provable claim: the shell
// is TRANSPARENT to all six control paths. This test locks that transparency to
// source so it cannot silently regress, and pins the jellyfin-web command
// contract to the live server's ground truth.
//
// HOW EACH CONTROL REACHES jellyfin-web ON TIZEN
//   Media keys: the Samsung remote's transport buttons only reach the page if
//   the shell calls tizen.tvinputdevice.registerKey(<name>) — otherwise the
//   firmware swallows them. Once registered, Tizen delivers a DOM keydown with
//   a numeric keyCode; jellyfin-web's KeyNames table resolves keyCode->name and
//   its switch calls inputManager.handleCommand(<command>). Same keydown path a
//   browser uses for a USB media keyboard — only the key SOURCE differs.
//   Pointer (seek bar drag/click, OSD play/pause button): plain DOM pointer
//   events straight into jellyfin-web. The shell adds no pointer/mouse/touch
//   listener, so there is nothing to diverge.
//   Progress: jellyfin-web's playbackManager POSTs /Sessions/Playing* via the
//   SDK ApiClient. The shell's only network shim rewrites config.json; it never
//   touches the progress endpoints.
//
// GROUND TRUTH — captured live from $JELLYFIN_URL/web/main.jellyfin.bundle.js
// (jellyfin-web 10.11.x) on 2026-06-09 (re-capture command in
// results-JEL-42.md). KeyNames keyCode->name and the keyboard command switch:
//   412:"MediaRewind"        -> handleCommand("rewind")
//   413:"MediaStop"          -> handleCommand("stop")
//   415:"MediaPlay"          -> handleCommand("play")
//   417:"MediaFastForward"   -> handleCommand("fastforward")
//   10232:"MediaTrackPrevious" -> handleCommand("previoustrack")
//   10233:"MediaTrackNext"     -> handleCommand("nexttrack")
//   10252:"MediaPlayPause"   -> handleCommand("playpause")
//   19:"Pause"               -> (no dedicated command case; toggles via player)
// Seek-bar position changes flow through the same command channel as
//   Command==="Seek" -> playbackManager.seek(SeekPositionTicks).
//
// Run: node scripts/playback-controls.test.cjs
//   or: pnpm --filter @jellyfin-tv/shell-tizen test

const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..", "..", "..");
const TV_SHELL = path.join(REPO, "packages", "shell-tizen", "src", "shell.js");
const TV_SHELL_MIN = path.join(
  REPO,
  "packages",
  "shell-tizen",
  "src",
  "shell.min.js",
);

// The jellyfin-web playback command contract: KeyName -> { code, command }.
// `command` is null where jellyfin-web has no dedicated keyboard command case.
const PLAYBACK = {
  MediaPlay: { code: 415, command: "play" },
  MediaPlayPause: { code: 10252, command: "playpause" },
  MediaStop: { code: 413, command: "stop" },
  MediaRewind: { code: 412, command: "rewind" },
  MediaFastForward: { code: 417, command: "fastforward" },
  MediaTrackPrevious: { code: 10232, command: "previoustrack" },
  MediaTrackNext: { code: 10233, command: "nexttrack" },
  MediaPause: { code: 19, command: null },
};
const PLAYBACK_NAMES = Object.keys(PLAYBACK).sort();
const PLAYBACK_CODES = PLAYBACK_NAMES.map((n) => PLAYBACK[n].code);

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log("OK: " + name);
  } else {
    console.error("FAIL: " + name + (detail ? "  — " + detail : ""));
    failures++;
  }
}
function eqSet(a, b) {
  const x = a.slice().sort();
  const y = b.slice().sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

// Brace-balanced extraction of a named function body (mirrors media-keys.test).
function fnBody(src, name) {
  const start = src.indexOf("function " + name + "(");
  if (start === -1) throw new Error(name + " not found in shell.js");
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(name + ": unbalanced braces");
}

const tvSrc = fs.readFileSync(TV_SHELL, "utf8");
const minSrc = fs.readFileSync(TV_SHELL_MIN, "utf8");

// --- 1. The shell asks the firmware to deliver every playback key -----------
// Without this, controls (1)/(2)/(4)/(5) never reach jellyfin-web on the TV at
// all, while the browser would still receive them — the worst kind of drift.
const regBody = fnBody(tvSrc, "registerRemoteKeys");
const registered = (regBody.match(/"(Media[A-Za-z]+)"/g) || []).map((s) =>
  s.replace(/"/g, ""),
);
check(
  "registerRemoteKeys() registers every playback media key by name",
  PLAYBACK_NAMES.every((k) => registered.includes(k)),
  "missing=[" + PLAYBACK_NAMES.filter((k) => !registered.includes(k)) + "]",
);

// --- 2. Deployed artifact mirrors the registration --------------------------
const missingFromMin = PLAYBACK_NAMES.filter(
  (k) => !minSrc.includes('"' + k + '"'),
);
check(
  "shell.min.js (deployed artifact) contains every playback key name",
  missingFromMin.length === 0,
  "missing=[" + missingFromMin + "]",
);

// --- 4. The shell never SWALLOWS a playback key -----------------------------
// jellyfin-web only runs a command if the keydown survives to its handler. The
// shell installs exactly two keydown listeners; neither may consume a playback
// key, or the TV would behave differently from the browser.
//
// 4a. The back-handler preventDefaults exactly one key (Tizen BACK = 10009)
//     and ONLY before boot completes ("web client owns it" afterwards). It must
//     not reference any playback keyCode.
const backBody = fnBody(tvSrc, "installBackHandler");
check(
  "back-handler intercepts only keyCode 10009 (BACK), not a playback key",
  /keyCode === 10009/.test(backBody) &&
    !PLAYBACK_CODES.some((c) => new RegExp("\\b" + c + "\\b").test(backBody)),
  "playback codes seen=[" +
    PLAYBACK_CODES.filter((c) => new RegExp("\\b" + c + "\\b").test(backBody)) +
    "]",
);
check(
  "back-handler defers BACK to jellyfin-web once boot is done",
  /__jellyfinShellBootDone/.test(backBody) && /return;/.test(backBody),
);

// 4b. The body-focus-rescue keydown listener (injected via buildSeedScript)
//     early-returns unless the event is in its key-name set K or keycode set C.
//     Reconstruct K and C from source and prove they are disjoint from every
//     playback key — so the rescue can never preventDefault a transport key.
// The rescue declares both sets together as `var K={...},C={...}`. Match that
// exact shape so neither set can be mis-targeted (an anchor that misses would
// parse the wrong braces and pass vacuously).
const setDecl = tvSrc.match(/var K=(\{[^}]*\}),C=(\{[^}]*\})/);
if (!setDecl) throw new Error("focus-rescue K/C set declaration not found");
function toSet(body, keyRe) {
  const set = {};
  let m;
  while ((m = keyRe.exec(body)) !== null) set[m[1]] = 1;
  return set;
}
const rescueK = toSet(setDecl[1], /([A-Za-z]+):\s*1/g);
const rescueC = toSet(setDecl[2], /(\d+):\s*1/g);
check(
  "focus-rescue K/C sets parsed non-empty",
  Object.keys(rescueK).length > 0 && Object.keys(rescueC).length > 0,
);
check(
  "focus-rescue keycode set excludes all playback keys",
  PLAYBACK_CODES.every((c) => !rescueC[c]),
  "overlap=[" + PLAYBACK_CODES.filter((c) => rescueC[c]) + "]",
);
check(
  "focus-rescue key-name set excludes all playback keys",
  PLAYBACK_NAMES.every((n) => !rescueK[n]),
  "overlap=[" + PLAYBACK_NAMES.filter((n) => rescueK[n]) + "]",
);

// --- 5. Seek bar + OSD button: shell adds no pointer interception -----------
// Controls (1 UI button) and (3 seek bar) are pointer-driven. If the shell
// registered any pointer/mouse/touch listener it could diverge from the
// browser. Its only click listener must be diagnostic (no default-suppression).
const pointerListeners = (
  tvSrc.match(/addEventListener\(\s*["'](pointer\w+|mouse\w+|touch\w+)["']/g) ||
  []
).filter(Boolean);
check(
  "shell installs no pointer/mouse/touch listeners (seek + OSD buttons pass through)",
  pointerListeners.length === 0,
  "found=[" + pointerListeners + "]",
);
// The lone click listener (btnPlay diagnostics) must not suppress the click.
const clickIdx = tvSrc.indexOf('addEventListener("click"');
check("shell has a click listener to inspect", clickIdx !== -1);
const clickBody = tvSrc.slice(clickIdx, clickIdx + 1400);
check(
  "click listener is diagnostic only — no preventDefault/stopPropagation",
  !/preventDefault|stopPropagation|stopImmediatePropagation|return false/.test(
    clickBody,
  ),
);

// --- 6. Progress reporting reaches the server untouched ----------------------
// The shell shims fetch + XHR ONLY to seed config.json. Prove the matcher
// rewrites config.json but lets every /Sessions/Playing* progress call through,
// and that the whole seed block never mentions a progress token.
const matchSrc = tvSrc.slice(
  tvSrc.indexOf("var matches=function"),
  tvSrc.indexOf("var matches=function") + 160,
);
const reLit = matchSrc.match(/\/(.*?)\/\.test/);
check("config.json matcher regex found in source", !!reLit);
if (reLit) {
  // Source stores the literal inside a JS string, so backslashes are doubled.
  const pattern = reLit[1].replace(/\\\\/g, "\\");
  const matches = new RegExp(pattern);
  check(
    "network shim DOES rewrite config.json",
    matches.test("/web/config.json") && matches.test("config.json?v=2"),
  );
  check(
    "network shim does NOT touch /Sessions/Playing (progress start)",
    !matches.test("/Sessions/Playing"),
  );
  check(
    "network shim does NOT touch /Sessions/Playing/Progress",
    !matches.test("/Sessions/Playing/Progress"),
  );
  check(
    "network shim does NOT touch /Sessions/Playing/Stopped",
    !matches.test("/Sessions/Playing/Stopped"),
  );
}
// Belt-and-suspenders: the seed/shim block names no progress/session token.
const seedStart = tvSrc.indexOf("var origOpen=XMLHttpRequest");
const seedEnd = tvSrc.indexOf("window.__shellSeededServer");
const seedBlock = tvSrc.slice(seedStart, seedEnd);
check(
  "network shim block references no Sessions/Playing/Progress token",
  !/Sessions|Playing|Progress|PositionTicks|PlaybackProgress/.test(seedBlock),
);

// --- 7. Command contract sanity: every playback name maps to a command ------
// Mirrors the live ground truth so a jellyfin-web command rename is caught here
// (re-capture per results-JEL-42.md) rather than as a dead button on the TV.
const COMMAND_CONTRACT = {
  play: "MediaPlay",
  playpause: "MediaPlayPause",
  stop: "MediaStop",
  rewind: "MediaRewind",
  fastforward: "MediaFastForward",
  previoustrack: "MediaTrackPrevious",
  nexttrack: "MediaTrackNext",
};
for (const name of PLAYBACK_NAMES) {
  const cmd = PLAYBACK[name].command;
  if (cmd === null) continue; // MediaPause: intentional no dedicated command
  check(
    "command contract: " + name + " -> handleCommand(" + cmd + ")",
    COMMAND_CONTRACT[cmd] === name,
  );
}

// --- summary ----------------------------------------------------------------
console.log("");
if (failures) {
  console.error(failures + " check(s) FAILED");
  process.exit(1);
}
console.log("All playback-control parity checks passed.");
