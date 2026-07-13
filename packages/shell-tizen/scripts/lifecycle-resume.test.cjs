// JEL-68 verification — Background/foreground lifecycle (app pause & resume),
// compared TV-shell vs browser (background tab restore).
//
// What the issue asks us to prove, on switching away from the Jellyfin app
// (e.g. to the TV's live-TV input) and back:
//   1. the app resumes in the SAME state (same page, same focus);
//   2. video playback that was paused resumes / prompts correctly;
//   3. no JavaScript errors on background/foreground;
//   4. network connections re-establish.
//   + Compare with background-tab behaviour in a browser.
//
// THE THESIS — on the Tizen WRT (web runtime) backgrounding the app does NOT
// tear down the WebView; it maps to the W3C **Page Visibility API**
// (`visibilitychange` / `document.hidden`), exactly like backgrounding a
// browser tab. The DOM, the JS heap, the SPA route, the focused element,
// localStorage and any open sockets all survive. jellyfin-web owns EVERY
// lifecycle reaction (pausing video on hidden, reconnecting its ApiClient /
// WebSocket on visible, restoring its own last route). The shell registers NO
// competing lifecycle listener, so a warm resume is byte-for-byte identical on
// the TV WebView and in a desktop browser tab. We prove that transparency.
//
// HOW THE SHELL COULD (BUT DOES NOT) INTERFERE WITH RESUME — surfaces checked:
//   (a) lifecycle events — the shell binds NO pagehide / pageshow / freeze /
//       resume / pause / blur / focus listener and exactly ONE sanctioned
//       visibilitychange listener (JELA-66 v2.0.24 installResumeEpochCheck,
//       window-level, config-epoch check on foreground; see (e)), so it can
//       neither reset state, re-route, nor throw on a normal pause/resume.
//   (b) focus on resume — the body-focus rescue + proactive auto-focuser only
//       act when activeElement is BODY/HTML (isBodyF gate); they RESTORE focus
//       to a focusable, never move it OFF a live element. A warm resume keeps
//       the previously-focused element, so the rescue is a no-op there.
//   (c) playback — media keys (MediaPlay/Pause/PlayPause/Stop/…) are
//       registered BY NAME for jellyfin-web's own handlers; the shell binds no
//       keydown that preventDefaults a media key mid-session (its only
//       keyCode-bound preventDefault is BACK 10009, gated by
//       __jellyfinShellBootDone), so playbackManager owns pause/resume.
//   (d) network re-establishment — fetch/XHR are shimmed ONLY for config.json;
//       every data call passes through to the native transport and the
//       WebSocket constructor is NOT shimmed at all, so jellyfin-web's ApiClient
//       and socket reconnect natively on resume (cf. JEL-64).
//   (e) no forced reload/teardown on a NORMAL resume — the shell's single
//       location.reload() lives in installResumeEpochCheck (JELA-66 v2.0.24)
//       and fires ONLY when a resume-time /shell/manifest.json fetch proves
//       the server config epoch changed while the app was suspended (and
//       never mid-playback). Match / offline / no-record resumes keep the
//       DOM; the server-state teardown / connect-form still lives ONLY in
//       the boot-time loadRemoteWebClient(stored).catch.
//
// WHY "TV vs browser" REDUCES TO A SOURCE CHECK — backgrounding is delivered by
// the Page Visibility API on both platforms; nothing in the shell decides
// pause/resume behaviour off a `tizen`/`webapis` branch (the only
// tizen.application call is exit() in the BACK handler, i.e. LEAVING the app,
// not resuming). So warm-resume behaviour is identical by construction.
//
// TWO SHELLS, ONE CONTRACT — the retail artifact on the TV is the BOOTSTRAP
// (boot-shell.src.js / .min.js); the full shell (shell.js / .min.js) carries
// the same key/diag/seed layer. Both src shells are checked, and the deployed
// minified blobs are source-checked so they cannot silently drift.
//
// Run: node scripts/lifecycle-resume.test.cjs
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
let notes = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log("OK: " + name);
  } else {
    console.error("FAIL: " + name + (detail ? "  — " + detail : ""));
    failures++;
  }
}
function note(msg) {
  console.log("  NOTE: " + msg);
  notes++;
}

// JELA-66 (v2.0.24): the resume-epoch hook is a shell-core fragment; expand
// the //@@SHELL_CORE:name@@ markers so the src scans see the real code the
// build splices in (the .min blobs already carry it expanded).
const { expand } = require(
  path.join(REPO, "packages", "shell-core", "expand.cjs"),
);
const tvSrc = expand(fs.readFileSync(TV_SHELL, "utf8"));
const tvMin = fs.readFileSync(TV_SHELL_MIN, "utf8");
const bootSrc = expand(fs.readFileSync(BOOT_SRC, "utf8"));
const bootMin = fs.readFileSync(BOOT_MIN, "utf8");

const SRC_SHELLS = [
  ["shell.js", tvSrc],
  ["boot-shell.src.js", bootSrc],
];
const MIN_SHELLS = [
  ["shell.min.js", tvMin],
  ["boot-shell.min.js", bootMin],
];
const ALL_SHELLS = SRC_SHELLS.concat(MIN_SHELLS);

// The Page Visibility / lifecycle event names a host could bind to react to the
// app being paused/resumed. The shell must bind NONE of these — with ONE
// sanctioned exception since v2.0.24 (JELA-66): installResumeEpochCheck binds
// exactly one window-level 'visibilitychange' listener whose only teardown
// path is a config-epoch MISMATCH against a freshly fetched manifest (Part D3
// pins those gates). Every match / offline / no-record resume falls through
// untouched, so jellyfin-web's own handling still runs identically on TV and
// in a browser tab.
const LIFECYCLE_EVENTS = [
  "webkitvisibilitychange",
  "pagehide",
  "pageshow",
  "freeze",
  "resume",
  "pause",
  "blur",
  "focus",
];

// ============================================================================
// PART A — NO SHELL LIFECYCLE LISTENER (req 1 & 3: same state, no errors)
// ============================================================================
// If the shell bound an unsanctioned background/foreground listener it could
// reset SPA state, navigate, or throw on pause/resume. It binds only the
// v2.0.24 resume-epoch visibilitychange hook, so the WebView's preserved
// state (route, heap, focus) is handed straight back to jellyfin-web.
console.log(
  "=== PART A: the shell binds NO background/foreground listener ===",
);

for (const [label, src] of ALL_SHELLS) {
  for (const ev of LIFECYCLE_EVENTS) {
    // Match the listener-registration forms the shell would have to use:
    //   addEventListener("ev"        document.addEventListener('ev'
    //   window.onev =                document.onev =
    const reAdd = new RegExp(
      "addEventListener\\(\\s*[\"']" + ev + "[\"']",
      "i",
    );
    const reOn = new RegExp("\\.on" + ev + "\\s*=", "i");
    const bound = reAdd.test(src) || reOn.test(src);
    check(
      "no '" + ev + "' lifecycle listener bound by " + label,
      !bound,
      bound ? "found a " + ev + " registration" : "",
    );
  }
  // The single sanctioned visibilitychange registration (JELA-66 v2.0.24):
  // exactly ONE, and it is window-level so it survives the
  // document.open()/write() handoff (same contract as installBackHandler).
  const vis = src.match(/addEventListener\(\s*["']visibilitychange["']/g) || [];
  check(
    "exactly one 'visibilitychange' listener (resume-epoch hook) in " + label,
    vis.length === 1,
    "found " + vis.length + " registrations",
  );
  check(
    "the visibilitychange listener is window-level (survives doc.write) in " +
      label,
    /window\.addEventListener\(\s*["']visibilitychange["']/.test(src),
  );
}

// ============================================================================
// PART B — FOCUS IS PRESERVED ON RESUME (req 1: same focus)
// ============================================================================
// On a warm resume the WebView keeps the previously-focused element. The
// shell's focus machinery (body-focus rescue + proactive auto-focuser) is gated
// to isBodyF() — it only fires when activeElement is BODY/HTML, i.e. when focus
// is ALREADY lost. It RESTORES focus to a focusable; it never moves focus off a
// live element, so it cannot disturb a resume that preserved focus.
console.log("");
console.log(
  "=== PART B: focus restorer is gated to BODY focus (preserve-safe) ===",
);

for (const [label, src] of SRC_SHELLS) {
  check(
    "isBodyF() gate present (focus rescue only acts when on BODY/HTML) in " +
      label,
    /function isBodyF\(\)\{var a=document\.activeElement;return !a\|\|a===document\.body\|\|a\.tagName==="HTML";\}/.test(
      src,
    ),
  );
  // The keydown rescue early-returns unless focus is on BODY (`if(!isBodyF())return`).
  check(
    "keydown focus-rescue early-returns when focus is NOT on BODY in " + label,
    /if\(!isBodyF\(\)\)return;/.test(src),
  );
  // The proactive auto-focuser interval also guards on `if(!nowBody)return`
  // (nowBody=isBodyF()), so it skips entirely while a real element holds focus.
  check(
    "proactive auto-focuser skips while a real element holds focus (if(!nowBody)return) in " +
      label,
    /var nowBody=isBodyF\(\);[\s\S]{0,400}if\(!nowBody\)return;/.test(src),
  );
}

// ============================================================================
// PART C — PLAYBACK PAUSE/RESUME IS JELLYFIN-WEB'S (req 2)
// ============================================================================
// The shell registers the media keys BY NAME (tizen.tvinputdevice.registerKey)
// so they reach jellyfin-web's playbackManager; it does not implement its own
// play/pause. Its ONLY keyCode-bound preventDefault is BACK (10009), gated by
// __jellyfinShellBootDone, so no media key is swallowed mid-session.
console.log("");
console.log("=== PART C: playback pause/resume belongs to jellyfin-web ===");

const MEDIA_KEYS = ["MediaPlay", "MediaPause", "MediaPlayPause", "MediaStop"];
for (const [label, src] of SRC_SHELLS) {
  for (const k of MEDIA_KEYS) {
    check(
      'media key "' +
        k +
        '" is registerKey-registered (handed to web client) in ' +
        label,
      new RegExp('"' + k + '"').test(src),
    );
  }
  check(
    "media keys are registered via tizen.tvinputdevice.registerKey in " + label,
    /tizen\.tvinputdevice\.registerKey\(/.test(src),
  );
  // BACK (10009) is the ONLY keyCode the shell ties exitApp/preventDefault to,
  // and it yields to the web client once booted — no media key is intercepted.
  check(
    "BACK (10009) yields to web client post-boot (__jellyfinShellBootDone) in " +
      label,
    /keyCode === 10009\)\s*\{\s*if \(window\.__jellyfinShellBootDone\) return;/.test(
      src,
    ) || /__jellyfinShellBootDone\) return/.test(src),
  );
  check(
    "shell implements no MediaPause/MediaPlay key handler of its own in " +
      label,
    !/case\s*["']MediaPause["']|keyName\s*===\s*["']MediaPause["']/.test(src),
  );
}

// ============================================================================
// PART D — NETWORK RE-ESTABLISHES NATIVELY ON RESUME (req 4)
// ============================================================================
// jellyfin-web's ApiClient + WebSocket reconnect on visibility-restore. The
// shell shims fetch/XHR ONLY for config.json (every data call passes through to
// the native transport) and does NOT shim the WebSocket constructor at all, so
// the reconnect path runs unmodified — TV == browser (cf. JEL-64).
console.log("");
console.log("=== PART D: socket/data reconnect runs natively on resume ===");

// D1. WebSocket is never shimmed — jellyfin-web's socket reconnect is native.
for (const [label, src] of ALL_SHELLS) {
  check(
    "WebSocket constructor is NOT shimmed/overridden in " + label,
    !/window\.WebSocket\s*=|WebSocket\.prototype\./.test(src),
  );
}

// D2. The fetch shim intercepts ONLY config.json; data calls pass through, so
//     ApiClient HTTP polls fail/recover natively. Lift the exact predicate.
function liftMatchesRegex(src, label) {
  const m = src.match(
    /var matches=function\(u\)\{return (\/.*?\/)\.test\(String\(u\|\|""\)\)/,
  );
  if (!m) throw new Error(label + ": shim matches() predicate not found");
  const body = m[1]
    .replace(/^\//, "")
    .replace(/\/$/, "")
    .replace(/\\\\/g, "\\");
  return new RegExp(body);
}
const RESUME_DATA_CALLS = [
  "https://srv.example/System/Info", // ApiClient connection re-probe
  "https://srv.example/Sessions/Playing/Progress", // playback session re-sync
  "https://srv.example/Users/abc/Items/Resume", // resume row refresh
  "https://srv.example/socket?api_key=xyz", // socket handshake URL (HTTP form)
];
for (const [label, src] of SRC_SHELLS) {
  const re = liftMatchesRegex(src, label);
  let passOk = true;
  for (const u of RESUME_DATA_CALLS) {
    if (re.test(u)) {
      passOk = false;
      note(label + ": UNEXPECTED intercept of resume call " + u);
    }
  }
  check(
    label + ": resume data/socket calls pass through to native transport",
    passOk,
  );
  check(
    label + ": fetch shim defers non-config.json to native fetch",
    /return origFetch\.call\(this,i,init\)/.test(src),
  );
}

// D3. No forced reload/teardown on a NORMAL resume: since v2.0.24 (JELA-66)
//     the resume-epoch hook owns the shell's ONLY location.reload() call, and
//     it fires solely on a config-epoch MISMATCH against a freshly fetched
//     manifest — never while playback is live, never when the manifest is
//     unreachable/field-less (offline resumes keep the DOM), never without an
//     adopted epoch record. Pin each gate so the reload cannot silently grow
//     new trigger paths.
for (const [label, src] of ALL_SHELLS) {
  const reloads = src.match(/location\s*\.\s*reload\s*\(/g) || [];
  check(
    "location.reload() appears exactly once (resume-epoch mismatch only) in " +
      label,
    reloads.length === 1,
    "found " + reloads.length + " call(s)",
  );
}
for (const [label, src] of SRC_SHELLS) {
  check(
    "resume reload is gated on epoch mismatch (match path returns first) in " +
      label,
    /String\(m\.configEpoch\) === String\(rec\.epoch\)/.test(src) &&
      /g\.st = "match";\s*\n\s*return;/.test(src),
  );
  check(
    "resume reload defers while playback is live (Lite AVPlay or SPA <video>) in " +
      label,
    /if \(playbackLive\(\)\) \{\s*\n\s*g\.st = "defer";/.test(src),
  );
  check(
    "manifest unreachable / field absent keeps the resumed DOM in " + label,
    /g\.st = m \? "nofield" : "err";\s*\n\s*return;/.test(src),
  );
  check(
    "no adopted epoch record -> no check (boot path owns first adoption) in " +
      label,
    /if \(!rec \|\| rec\.origin !== url \|\| !rec\.epoch\) return;/.test(src),
  );
  check(
    "resume-epoch hook honors its kill switch + the config-epoch master switch in " +
      label,
    /resumeCheckOff\(\) \|\| !ceGateOn\(\)/.test(src) &&
      /jellyfin\.shell\.resumeEpochDisabled/.test(src),
  );
}

// ============================================================================
// PART E — TV == BROWSER BY CONSTRUCTION
// ============================================================================
// Backgrounding is delivered by the Page Visibility API on both platforms. The
// only tizen.application reference is exit() inside the BACK handler (LEAVING
// the app), never a resume branch. So warm-resume behaviour cannot diverge.
console.log("");
console.log("=== PART E: TV == browser (no tizen branch decides resume) ===");

for (const [label, src] of SRC_SHELLS) {
  // Match actual property accesses (`tizen.application.<...>`), not the bare
  // `tizen.application)` truthiness guard in exitApp().
  const appCalls = src.match(/tizen\.application\.[^\n;]*/g) || [];
  const onlyExit = appCalls.every((c) =>
    /getCurrentApplication\(\)\.exit/.test(c),
  );
  check(
    "tizen.application is used ONLY for exit() (no pause/resume branch) in " +
      label,
    appCalls.length > 0 && onlyExit,
    appCalls.length === 0
      ? "no tizen.application reference found"
      : appCalls.join(" | "),
  );
}

// ============================================================================
// PART F — OBSERVATIONS (informational; never fails the build)
// ============================================================================
console.log("");
console.log("=== PART F: observations ===");

// The QA beacon (gated behind localStorage['jellyfin.qa.overlay']==='1') is the
// only code that reads document.hidden: it PAUSES outbound telemetry while the
// app is backgrounded and resumes on foreground. It draws nothing and changes
// no jellyfin-web state, so it is parity-neutral; production builds never trip
// the gate.
const beaconHiddenGate = /tick paused when document\.hidden/.test(bootSrc);
note(
  "QA beacon is the only document.hidden reader: it merely PAUSES telemetry " +
    "while backgrounded (gated behind jellyfin.qa.overlay==='1', off in retail). " +
    "It is parity-neutral — draws nothing, mutates no web-client state. " +
    (beaconHiddenGate
      ? "(beacon comment confirms the pause-on-hidden gate)"
      : ""),
);

// The one genuine TV-specific divergence from a browser tab: under memory
// pressure Tizen may TERMINATE a backgrounded app. Relaunch is then a COLD boot
// — bootstrap() reloads the saved server URL (JEL-555 skips the pre-flight) and
// jellyfin-web restores its own last view from its persisted state. This is the
// "reopen a closed tab" analogue, not a warm resume, and is expected.
const coldResumePath =
  /loadRemoteWebClient\(stored\)/.test(tvSrc) &&
  /loadRemoteWebClient\(stored\)/.test(bootSrc);
note(
  "Cold resume (OOM relaunch): if Tizen kills the backgrounded app, relaunch " +
    "cold-boots via bootstrap() -> loadRemoteWebClient(savedUrl) (JEL-555 " +
    "skips the pre-flight); jellyfin-web restores its own last route from its " +
    "persisted state. Analogous to reopening a closed browser tab, not a warm " +
    "resume. " +
    (coldResumePath
      ? "(both shells re-enter via loadRemoteWebClient(stored))"
      : ""),
);
note(
  "On-device (Tizen 5.0 / M63) repro + evidence channel: see " +
    "tooling/tv-validate/lifecycle-resume/results-JEL-68.md.",
);

// --- summary ----------------------------------------------------------------
console.log("");
if (notes) {
  console.log(
    notes +
      " observation(s) — see tooling/tv-validate/lifecycle-resume/results-JEL-68.md",
  );
}
if (failures) {
  console.error(failures + " check(s) FAILED");
  process.exit(1);
}
console.log("All lifecycle-resume (JEL-68) checks passed.");
