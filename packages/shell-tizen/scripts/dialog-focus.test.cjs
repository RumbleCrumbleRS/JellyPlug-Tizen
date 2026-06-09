// JEL-71 verification — Dialog & overlay interaction / modal focus trapping
// (TV vs browser).
//
// JEL-71 asks us to open dialogs (confirm dialogs, playback-quality dialogs) on
// TV and browser and verify five behaviours:
//   (1) focus is TRAPPED inside the dialog while it is open;
//   (2) D-pad navigation stays WITHIN the dialog;
//   (3) BACK (TV) or Escape (browser) CLOSES the dialog;
//   (4) focus RETURNS to the triggering element after the dialog closes;
//   (5) scopes() correctly identifies `.dialogContainer .dialog.opened` as the
//       TOP scope.
//
// WHY THIS REDUCES TO (shell transparency) + (a source-pinned scopes() rule)
// -------------------------------------------------------------------------
// Focus trapping, D-pad confinement, back-to-close and focus-restore are all
// implemented by jellyfin-web (focusManager + dialogHelper), NOT by the shell.
// That web bundle is byte-identical on the Tizen 5.0 (M63) WebView and a desktop
// browser, so items (1)–(4) are jellyfin-web behaviour and are parity BY
// CONSTRUCTION — provided the shell does not interfere. The live jellyfin-web
// contract those four items rely on is re-derived from the shipping bundle by
//   tooling/tv-validate/dialog-focus/verify-dialog-contract.mjs
// (JELLYFIN_URL=… node …). This deterministic test owns the SHELL side:
//
//   * The shell must stay transparent to the keys a dialog needs — it must NOT
//     bind Escape, must NOT preventDefault arrow/Tab keys except inside its
//     focus-rescue, and its BACK (10009) handler must early-return post-boot so
//     jellyfin-web's own "back" command reaches the open dialog and closes it.
//
//   * The shell carries its OWN scopes() inside the body-focus-rescue it injects
//     into the page (see shell.js "v58/v59" block). That scopes() must list
//     `.dialogContainer .dialog.opened` (the LAST/topmost opened dialog) as its
//     FIRST entry — item (5). This is not academic: when the M63 WebView drops
//     focus onto <body> while a dialog is open, the rescue/auto-focuser re-homes
//     focus using scopes(), and scope[0] being the dialog is exactly what keeps
//     the rescue INSIDE the dialog instead of leaking to the page behind it.
//     So the shell's scopes() rule REINFORCES jellyfin-web's trap rather than
//     fighting it — and it uses the identical selector + `l[l.length-1]` pick
//     that jellyfin-web's focusManager uses to clamp its own focus scope.
//
// This test does two things:
//   PART A (behavioural): lifts the EXACT vis()/fst()/scopes()/findT() functions
//     out of the shipping shell.js injection string and runs them against a fake
//     DOM, proving scopes()[0] is the opened dialog and findT() returns a
//     dialog-internal target (__shellLastScopeHit === 0) while a dialog is open,
//     and falls through to the page once it closes.
//   PART B (source contract): pins the shell-transparency + BACK-gate guarantees
//     in both shipping shells (shell.js source) and the deployed shell.min.js.
//
// Run: node scripts/dialog-focus.test.cjs
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

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log("OK:   " + name);
  } else {
    console.error("FAIL: " + name + (detail ? "  — " + detail : ""));
    failures++;
  }
}

const tvSrc = fs.readFileSync(TV_SHELL, "utf8");
const tvMin = fs.readFileSync(TV_SHELL_MIN, "utf8");

// ============================================================================
// PART A — BEHAVIOURAL: run the shell's real scopes()/findT() over a fake DOM
// ============================================================================
//
// Extract the helpers verbatim from the injected rescue string in shell.js.
// The block is `var K={…},C={…},S='…';function vis(n){…}function fst(s){…}
// function scopes(){…}function findT(){…}`. We MUST start at the `var K`/`S`
// prefix because fst() closes over the focusable-selector constant `S`; we end
// just before `function isBodyF(`.
const fnStart = tvSrc.indexOf("var K={ArrowUp");
const fnEnd = tvSrc.indexOf("function isBodyF(");
check(
  "shell.js exposes the K/S consts + vis/fst/scopes/findT focus helpers",
  fnStart !== -1 && fnEnd !== -1 && fnEnd > fnStart,
);
// The helpers live inside a single-quoted JS string literal in shell.js, so
// apostrophes in the selector are written `\'`. Unescape them to recover the
// exact code the WebView eval()s.
const helpers = tvSrc.slice(fnStart, fnEnd).replace(/\\'/g, "'");

// Sanity: the slice must contain all four helpers and the dialog selector.
check(
  "extracted helpers include scopes() + findT() + the dialog selector",
  /function scopes\(\)/.test(helpers) &&
    /function findT\(\)/.test(helpers) &&
    helpers.includes(".dialogContainer .dialog.opened"),
);

// --- minimal fake DOM -------------------------------------------------------
// A node is "focusable + visible" if it matches the rescue's selector S, has a
// non-null offsetParent and a non-empty bounding rect. We give every test node
// a real rect and a querySelectorAll that returns its declared focusables.
function makeNode(tag, focusables) {
  const node = {
    tagName: tag,
    offsetParent: {}, // non-null => visible per vis()
    getBoundingClientRect() {
      return { width: 100, height: 40 };
    },
    querySelectorAll() {
      return focusables || [];
    },
  };
  return node;
}

// Build a "playback quality" dialog with two buttons, plus a page behind it
// that also has a focusable (the trigger button that opened the dialog).
const dialogBtnA = makeNode("BUTTON");
const dialogBtnB = makeNode("BUTTON");
const dialogNode = makeNode("DIV", [dialogBtnA, dialogBtnB]);
const pageTrigger = makeNode("BUTTON");
const pageNode = makeNode("DIV", [pageTrigger]);

let dialogOpen = true;
const fakeDocument = {
  querySelectorAll(sel) {
    if (sel === ".dialogContainer .dialog.opened") {
      return dialogOpen ? [dialogNode] : [];
    }
    if (sel === ".page:not(.hide)") return [pageNode];
    return []; // header selectors etc.
  },
  querySelector() {
    return null; // no .skinHeader/#reactRoot in this fixture
  },
  getElementById() {
    return null; // no synthetic __shellST target
  },
};
const fakeWindow = {};

// Eval the helpers in a sandbox bound to our fakes. `var` declarations inside
// the Function body create the functions; we return scopes/findT to the test.
const sandbox = new Function(
  "document",
  "window",
  helpers + "\nreturn { scopes: scopes, findT: findT, fst: fst };",
);
const api = sandbox(fakeDocument, fakeWindow);

// (5) scopes()[0] is the opened dialog while a dialog is open.
let sc = api.scopes();
check(
  "scopes()[0] is the opened .dialogContainer .dialog.opened (TOP scope)",
  sc[0] === dialogNode,
  "got index0=" +
    (sc[0] === pageNode ? ".page" : String(sc[0] && sc[0].tagName)),
);
check(
  "scopes() ranks the dialog ABOVE the active .page",
  sc.indexOf(dialogNode) >= 0 &&
    sc.indexOf(pageNode) >= 0 &&
    sc.indexOf(dialogNode) < sc.indexOf(pageNode),
);

// (1)/(2) findT() (the rescue/auto-focus target picker) returns a focusable
// INSIDE the dialog, and records scope hit 0 — so a body-focus rescue while a
// dialog is open re-homes focus into the dialog, never the page behind it.
let target = api.findT();
check(
  "findT() returns a focusable INSIDE the open dialog",
  target === dialogBtnA,
  "expected dialog button, got " + String(target && target.tagName),
);
check(
  "findT() records __shellLastScopeHit === 0 while a dialog is open",
  fakeWindow.__shellLastScopeHit === 0,
  "hit=" + fakeWindow.__shellLastScopeHit,
);

// (4) Once the dialog closes, scopes() drops the dialog and findT() falls
// through to the page (the trigger lives there) — proving the dialog scope is
// transient and does not strand focus after close.
dialogOpen = false;
sc = api.scopes();
check("after close, scopes()[0] is NO LONGER the dialog", sc[0] !== dialogNode);
target = api.findT();
check(
  "after close, findT() falls through to the page (trigger) focusable",
  target === pageTrigger && fakeWindow.__shellLastScopeHit === 0, // page is now scopes()[0]
  "target=" +
    String(target && target.tagName) +
    " hit=" +
    fakeWindow.__shellLastScopeHit,
);

// ============================================================================
// PART B — SOURCE CONTRACT: shell transparency + BACK gate (both shells)
// ============================================================================

// B1. The shell's scopes() takes the LAST opened dialog — same pick jellyfin-web
//     focusManager uses (querySelectorAll(...).length?l[l.length-1]:null). This
//     guarantees the TOPMOST stacked dialog wins when dialogs nest.
check(
  "scopes() pushes the LAST (topmost) opened dialog: d[d.length-1]",
  /querySelectorAll\(".dialogContainer \.dialog\.opened"\);if\(d\.length\)out\.push\(d\[d\.length-1\]\)/.test(
    tvSrc,
  ),
);

// B2. BACK (10009) early-returns once the web client has booted, so post-boot
//     BACK is owned by jellyfin-web and can close an open dialog. Pre-boot
//     (connect screen) BACK still exits the app — that is intentional and is NOT
//     a dialog context.
check(
  "BACK handler early-returns post-boot (web client owns BACK to close dialogs)",
  /keyCode === 10009[\s\S]{0,120}__jellyfinShellBootDone\) return/.test(tvSrc),
);

// B3. The shell binds NO Escape handler and never special-cases keyCode 27 —
//     so the browser's Escape-to-close reaches jellyfin-web's dialogHelper
//     unmodified. (TV closes via BACK->"back" command; browser via Escape.)
check(
  "shell.js binds no Escape / keyCode 27 handler",
  !/keyCode\s*===?\s*27/.test(tvSrc) && !/["']Escape["']/.test(tvSrc),
);

// B4. The ONLY key the shell preventDefaults outside its body-focus-rescue is
//     BACK. Inside the rescue, preventDefault/stopPropagation fire ONLY when
//     focus is on <body> (isBodyF gate) AND a target was focused — so while
//     focus is inside a dialog the rescue is a no-op and every arrow/Tab/Enter
//     reaches jellyfin-web's focusManager. Assert the isBodyF() short-circuit
//     guards the rescue listener.
check(
  "body-focus-rescue is gated by isBodyF() (no-op while focus is in the dialog)",
  /keydown",function\(e\)\{[\s\S]{0,140}if\(!isBodyF\(\)\)return;/.test(tvSrc),
);
check(
  "rescue only preventDefaults after a SUCCESSFUL re-focus (activeElement===t)",
  /document\.activeElement===t\)\{[\s\S]{0,80}e\.preventDefault\(\);e\.stopPropagation\(\)/.test(
    tvSrc,
  ),
);

// B5. Deployed blob parity — shell.min.js must carry the same scopes() selector
//     and the same post-boot BACK gate, or the device would run a contract the
//     source no longer describes.
check(
  "shell.min.js carries the scopes() dialog selector",
  tvMin.includes('querySelectorAll(".dialogContainer .dialog.opened")'),
);
check(
  "shell.min.js carries the post-boot BACK gate (10009 + __jellyfinShellBootDone)",
  tvMin.includes("10009") && tvMin.includes("__jellyfinShellBootDone"),
);
check(
  "shell.min.js binds no Escape / keyCode 27 handler",
  !/keyCode\s*===?\s*27/.test(tvMin) && !/["']Escape["']/.test(tvMin),
);

// --- summary ----------------------------------------------------------------
console.log("");
if (failures) {
  console.error(failures + " dialog-focus contract check(s) FAILED");
  process.exit(1);
}
console.log(
  "All dialog-focus checks passed — shell stays transparent to dialog keys and " +
    "its scopes() ranks the opened dialog as the top focus scope (TV == browser).",
);
