// JEL-71 — live ground-truth verifier for the dialog / modal focus contract.
//
// The deterministic unit test
//   packages/shell-tizen/scripts/dialog-focus.test.cjs
// owns the SHELL side (transparency to dialog keys + the shell's own scopes()
// ranking the opened dialog as the top focus scope). The four user-visible
// behaviours JEL-71 asks about — focus trapping, D-pad confinement, back/Escape
// to close, and focus-return-to-trigger — are implemented by JELLYFIN-WEB
// (focusManager + dialogHelper + keyboardnavigation), and that bundle is
// byte-identical on the Tizen 5.0 (M63) WebView and a desktop browser. So those
// four are parity by construction; this script re-derives the contract they rely
// on from the LIVE web bundle the server actually serves, to prove a server
// upgrade has not silently changed it. It reads shipped JS — no media decode —
// so it is fast and deterministic.
//
// Run:  JELLYFIN_URL=https://host node tooling/tv-validate/dialog-focus/verify-dialog-contract.mjs
// Skips cleanly (exit 0) when JELLYFIN_URL is unset.

const BASE = (process.env.JELLYFIN_URL || "").replace(/\/$/, "");
if (!BASE) {
  console.log("SKIP: JELLYFIN_URL not set — live dialog contract check skipped.");
  process.exit(0);
}

const url = BASE + "/web/main.jellyfin.bundle.js";
const res = await fetch(url);
if (!res.ok) {
  console.error("FAIL: could not fetch " + url + " (HTTP " + res.status + ")");
  process.exit(1);
}
const src = await res.text();
console.log("Fetched " + url + " (" + src.length + " bytes)\n");

let failures = 0;
const ok = (n, c, d) => {
  console[c ? "log" : "error"](
    (c ? "OK:   " : "FAIL: ") + n + (!c && d ? "  — " + d : ""),
  );
  if (!c) failures++;
};

// ---------------------------------------------------------------------------
// (5) + (1)/(2) FOCUS TRAP / SCOPE
// focusManager clamps its focus scope to the TOPMOST opened dialog: it queries
// `.dialogContainer .dialog.opened`, takes the LAST match, and if the current
// scope node is not inside that dialog it replaces the scope with the dialog.
// This is the focus trap + D-pad confinement, and it is the SAME selector +
// `l[l.length-1]` pick the shell's own scopes() uses (see dialog-focus.test.cjs).
ok(
  "focusManager scope = topmost `.dialogContainer .dialog.opened` (focus trap)",
  /querySelectorAll\("\.dialogContainer \.dialog\.opened"\)\s*,\s*\w+\s*=\s*\w+\.length\s*\?\s*\w+\[\w+\.length-1\]\s*:\s*null;\s*\w+\s*&&\s*!\w+\.contains\(\w+\)\s*&&\s*\(\w+\s*=\s*\w+\)/.test(
    src,
  ),
);

// ---------------------------------------------------------------------------
// (3) BACK / ESCAPE CLOSES THE DIALOG
// 3a. TV remote BACK keycode 10009 (and 461) map to KeyName "Back".
ok('KeyNames maps 10009 -> "Back" (TV remote BACK)', /10009:"Back"/.test(src));
ok('KeyNames maps 461 -> "Back"', /461:"Back"/.test(src));

// 3b. On TV, Escape/Back are routed to the "back" command (keyboardnavigation).
//     (Browser fires Escape directly; TV's BACK arrives as the same "back".)
ok(
  'keyboardnavigation routes Escape -> handleCommand("back") on TV',
  /case"Escape":[^}]*\.tv\?[^}]*handleCommand\("back"\)/.test(src),
);

// 3c. dialogHelper closes the dialog when the "back" command fires, and STOPS
//     propagation so BACK closes the dialog WITHOUT also navigating the page.
ok(
  'dialogHelper closes on the "back" command (preventDefault + stopPropagation + close)',
  /"back"===\w+\.detail\.command&&\(\w+\.preventDefault\(\),\w+\.stopPropagation\(\),\w+\(\w+\)\)/.test(
    src,
  ),
);

// ---------------------------------------------------------------------------
// (4) FOCUS RETURNS TO THE TRIGGERING ELEMENT AFTER CLOSE
// 4a. On open, dialogHelper records the element that was focused (the trigger).
ok(
  "dialogHelper records the triggering activeElement on open",
  /\.activeElement=document\.activeElement/.test(src),
);
// 4b. On close, it restores focus to that saved element when it is still
//     focusable, else falls back to autoFocus inside the next scope.
ok(
  "dialogHelper restores focus to the saved trigger on close (else autoFocus)",
  /isCurrentlyFocusable\(\w+\.activeElement\)\?\w+\.\w+\.focus\(\w+\.activeElement\):\w+\.\w+\.autoFocus/.test(
    src,
  ),
);

console.log("");
if (failures) {
  console.error(
    failures +
      " live dialog contract check(s) FAILED — jellyfin-web bundle drifted; " +
      "re-verify focus trapping / back-to-close on TV and browser.",
  );
  process.exit(1);
}
console.log(
  "Live dialog/focus contract matches the pinned ground truth — focus trap, " +
    "BACK/Escape-to-close, and focus-return-to-trigger are intact (TV == browser).",
);
