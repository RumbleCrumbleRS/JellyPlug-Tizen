// JEL-52 verification (static contract) — Movie details page Play/Resume on TV.
//
// WHY THIS GUARD EXISTS
//   The details page CONTENT (title/year/rating/runtime/genres/synopsis,
//   poster+backdrop, trailer button, Resume position) is 100% server-driven and
//   identical TV vs browser by construction — proven empirically by
//   tooling/tv-validate/movie-details/verify-movie-details.mjs.
//
//   The one thing that is NOT free on the TV is the Play/Resume button actually
//   WORKING. On Tizen 5.0 (Chromium 56) and other Chromium <70 WebViews,
//   navigating to a detail-page hash does NOT fire jellyfin-web's `viewshow`
//   lifecycle event. The itemDetails controller never runs reload(),
//   `currentItem` stays undefined, and clicking Play invokes playbackManager
//   with an item lacking ServerId — ConnectionManager.getApiClient throws
//   "item or serverId cannot be null" and no <video> is ever created
//   (root cause: JEL-436, confirmed on QN82Q60RAFXZA via the QA HUD).
//
//   The shell closes that gap with a legacy-gated workaround chain that brings
//   the TV Play/Resume button to parity with the browser:
//     1. On hashchange/popstate, synthesize a `viewshow` CustomEvent on the
//        active page so itemDetails.reload() runs and currentItem populates.
//     2. Wrap connectionManager.getApiClient so a null/ServerId-less item
//        resolves to the authenticated window.ApiClient instead of throwing.
//     3. Wrap playbackManager.play to inject ServerId and derive MediaType
//        from Type (Movie->Video) so getPlayer() resolves a real player.
//   All three are gated behind a Chromium-<70 (legacy) check so a modern
//   browser, which fires viewshow natively, skips the entire chain — which is
//   exactly why the browser path needs no help and the TV path does.
//
//   This test pins that chain to the live source-of-record (shell.js) and the
//   deployed release artifact (shell.min.js). If any link is removed or the
//   legacy gate is dropped, the TV Play button silently regresses to the
//   JEL-436 failure — this guard fails first.
//
// Run: node scripts/movie-details.test.cjs
//   or via the package `test` script.

const fs = require("fs");
const path = require("path");

const SHELL = path.join(__dirname, "..", "src", "shell.js");
const SHELL_MIN = path.join(__dirname, "..", "src", "shell.min.js");

const src = fs.readFileSync(SHELL, "utf8");
const min = fs.readFileSync(SHELL_MIN, "utf8");

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log("OK: " + name);
  } else {
    console.error("FAIL: " + name + (detail ? "  — " + detail : ""));
    failures++;
  }
}

// ----------------------------------------------------------------------------
// PART 1 — the detail-page viewshow synthesizer (link 1 of the chain).
// ----------------------------------------------------------------------------

// 1a. A `viewshow` CustomEvent is synthesized — this is what makes the
//     itemDetails controller reload() and populate currentItem on M56/M63.
check(
  "shell.js synthesizes a `viewshow` CustomEvent (detail-page reload trigger)",
  /new CustomEvent\(\s*"viewshow"/.test(src) &&
    /function\s+synthViewshow/.test(src),
);

// 1b. It re-fires on hash/route changes (detail navigation), not just once.
check(
  "shell.js re-synthesizes viewshow on hashchange/popstate",
  /addEventListener\(\s*"hashchange"/.test(src) &&
    /addEventListener\(\s*"popstate"/.test(src),
);

// 1c. The synth dispatches onto the active page view (.mainAnimatedPage / .page)
//     so the controller bound to that view receives it.
check(
  "shell.js targets the active page view for the synthetic viewshow",
  /\.mainAnimatedPage:not\(\.hide\)/.test(src) &&
    /dispatchEvent\(\s*ev\s*\)/.test(src),
);

// ----------------------------------------------------------------------------
// PART 2 — the play-dispatch hardening (links 2 & 3 of the chain).
// ----------------------------------------------------------------------------

// 2a. connectionManager.getApiClient is wrapped so a ServerId-less / null item
//     resolves to window.ApiClient instead of throwing "serverId cannot be null".
check(
  "shell.js wraps connectionManager.getApiClient (ServerId-less item fallback)",
  /function\s+__shellWrapGAC/.test(src) &&
    /getApiClient\s*=\s*__shellWrapGAC/.test(src),
);

// 2b. playbackManager.play is wrapped to inject ServerId and derive MediaType.
check(
  "shell.js wraps playbackManager.play (inject ServerId + derive MediaType)",
  /function\s+__shellPatchPM/.test(src) &&
    /cand\.play\s*=\s*function/.test(src),
);

// 2c. The Type->MediaType table maps Movie (and Trailer) to "Video" so
//     getPlayer() resolves a video player for a movie / its trailer.
check(
  'shell.js maps Movie+Trailer Type -> MediaType "Video" for getPlayer()',
  /Movie:\s*"Video"/.test(src) && /Trailer:\s*"Video"/.test(src),
);

// 2d. The btnPlay/btnReplay (Resume) click path is the one being repaired —
//     the shell instruments both so Play AND Resume are covered.
check(
  "shell.js handles both Play (btnPlay) and Resume (btnReplay) buttons",
  /btnPlay/.test(src) && /btnReplay/.test(src),
);

// ----------------------------------------------------------------------------
// PART 3 — the legacy gate. The whole chain must be Chromium-<70 only, so a
// modern browser (which fires viewshow natively) is untouched. This is the
// formal statement of "TV needs the fix, the browser does not".
// ----------------------------------------------------------------------------

check(
  "the workaround chain is gated to legacy Chromium (<70) only",
  /parseInt\(\s*m\[1\]\s*,\s*10\s*\)\s*<\s*70/.test(src) &&
    /if\s*\(\s*!legacy\s*\)\s*return\s*;/.test(src),
);

// ----------------------------------------------------------------------------
// PART 4 — the deployed release artifact (shell.min.js) carries the SAME chain.
// shell.min.js is what actually boots on the TV; if the build dropped any link,
// the source guard above would still pass while the device regressed.
// ----------------------------------------------------------------------------

const minMarkers = [
  ['new CustomEvent("viewshow"', /new CustomEvent\(\s*"viewshow"/],
  ["hashchange listener", /addEventListener\(\s*"hashchange"/],
  ["__shellWrapGAC", /__shellWrapGAC/],
  ['Movie:"Video" map', /Movie:\s*"Video"/],
  ["btnReplay (Resume) path", /btnReplay/],
  ["legacy <70 gate", /<\s*70/],
];
for (const [label, re] of minMarkers) {
  check("shell.min.js (release artifact) retains: " + label, re.test(min));
}

// ----------------------------------------------------------------------------
console.log("");
if (failures) {
  console.error(`JEL-52 detail-page contract: ${failures} FAILED.`);
  process.exit(1);
}
console.log("JEL-52 detail-page contract: all checks passed.");
