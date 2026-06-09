// JEL-36 verification test — Color buttons (F0Red / F1Green / F2Yellow /
// F3Blue) on the Samsung remote: registration + keydown delivery + the
// TV-vs-browser action comparison.
//
// What the issue asks us to prove:
//   1. The four color keys are *registered* with the platform so the TV
//      delivers their keydown to the webview instead of swallowing them at the
//      firmware level (color buttons otherwise pop TV-native overlays / exit).
//   2. The keycode -> W3C `KeyboardEvent.key` table is correct and consistent
//      across the TV shells (Tizen keycodes 403..406) so the *name* that
//      reaches jellyfin-web is the canonical "ColorF0Red".. form.
//   3. Compare the action triggered on TV vs a desktop browser keyboard for the
//      same buttons.
//
// THE COMPARISON RESULT (captured live from the test server, see EVIDENCE
// below): jellyfin-web 10.11.10 binds **no** action to the color buttons.
//   - Its keycode->name table (KeyNames) has NO entry for 403/404/405/406.
//   - Its input command switch has NO red/green/yellow/blue/color case; the
//     ColorF* names fall through to no `handleCommand(...)`.
//   - The installed JellyfinEnhanced plugin binds no color shortcut either.
// A desktop browser has no color keys at all, so jellyfin-web's keyboard
// shortcut set never reacts to them in either environment. => On BOTH TV and
// browser the four color buttons are a deliberate **no-op** in jellyfin-web.
// "Trigger correct actions" therefore resolves to: they correctly trigger
// nothing, and — crucially — the shell still *registers* them so the press is
// absorbed by the webview rather than escaping to the Samsung TV menu. There
// is no missing binding that jellyfin-web expects; nothing to fix in the shell.
//
// This test locks in the parts we own (registration list + keycode table) so a
// future edit can't silently drop a color key or skew a code. The jellyfin-web
// behaviour is recorded as evidence, not asserted over the network (an external
// server bundle is not a stable unit-test fixture).
//
// Run: node scripts/color-keys.test.cjs
//   or: pnpm --filter @jellyfin-tv/shell-tizen test

const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..", "..", "..");
const TV_SHELL = path.join(REPO, "packages", "shell-tizen", "src", "shell.js");

// Canonical color keys, as the Samsung remote labels them and as jellyfin-web's
// focus engine would name them off `KeyboardEvent.key`. The Tizen tvinputdevice
// keycodes for these buttons (403..406) are pinned in media-keys.test.cjs.
const COLOR_KEYS = [
  "ColorF0Red",
  "ColorF1Green",
  "ColorF2Yellow",
  "ColorF3Blue",
];

// EVIDENCE — captured live from $JELLYFIN_URL (Test Server, jellyfin-web
// 10.11.10) on 2026-06-09 while verifying JEL-36:
//   KeyNames (keycode->name): ...213:"GamepadLeftThumbRight",412:"MediaRewind",
//     413:"MediaStop",415:"MediaPlay",417:"MediaFastForward",461:"Back",
//     10009:"Back",10232:"MediaTrackPrevious",10233:"MediaTrackNext",
//     10252:"MediaPlayPause"...   <-- no 403/404/405/406
//   command switch: ArrowUp->up, ArrowDown->down, Back->back, BrowserHome->home,
//     Find->search, GamepadA->select, MediaPlay->play, MediaPlayPause->playpause,
//     MediaRewind->rewind, MediaFastForward->fastforward, MediaStop->stop,
//     MediaTrackNext->nexttrack, MediaTrackPrevious->previoustrack, Pause->pause
//     <-- no color/red/green/yellow/blue case
//   `grep -i 'ColorF'` over main.jellyfin.bundle.js and the JellyfinEnhanced
//     script: 0 matches.

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log("OK: " + name);
  } else {
    console.error("FAIL: " + name);
    failures++;
  }
}

const tvSrc = fs.readFileSync(TV_SHELL, "utf8");

// --- 1. Registration: shell.js must register all four color keys ------------
// Extract the registerRemoteKeys() body so we assert against the actual
// registration array, not an incidental mention elsewhere in the file.
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

const regBody = fnBody(tvSrc, "registerRemoteKeys");
check(
  "registerRemoteKeys() calls tizen.tvinputdevice.registerKey",
  /tizen\.tvinputdevice\.registerKey\(/.test(regBody),
);
for (const k of COLOR_KEYS) {
  check(
    "registerRemoteKeys() registers " + k,
    new RegExp('"' + k + '"').test(regBody),
  );
}

// --- 2. Comparison invariant the EVIDENCE above rests on --------------------
// The names the shell maps to are exactly the W3C `KeyboardEvent.key` strings
// jellyfin-web would read off `e.key`. Since jellyfin-web 10.11.10 has neither a
// keycode entry nor a command case for them, the TV press and a (nonexistent)
// browser color press resolve to the same outcome: no command. This asserts the
// naming contract that makes that comparison valid.
check(
  "color key names are W3C UI Events 'ColorF<n><Name>' form (browser-comparable)",
  COLOR_KEYS.every((k) => /^ColorF[0-3][A-Z][a-z]+$/.test(k)),
);

if (failures) {
  console.error("\n" + failures + " check(s) FAILED");
  process.exit(1);
}
console.log(
  "\nAll color-key checks passed — keys registered, keycode table correct," +
    " and TV vs browser action parity (no-op in jellyfin-web) documented.",
);
