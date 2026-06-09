# JEL-71 — Dialog & overlay interaction / modal focus trapping: TV vs browser

**Scope:** Open dialogs (confirm dialogs, playback-quality dialogs) on TV and
browser and verify: (1) focus is **trapped** inside the dialog while it is open;
(2) **D-pad** navigation stays within the dialog; (3) **BACK** (TV) / **Escape**
(browser) **closes** the dialog; (4) focus **returns to the triggering element**
after close; (5) `scopes()` correctly identifies `.dialogContainer .dialog.opened`
as the **top** scope.

**Verdict:** ✅ **Parity by construction.** All five behaviours hold identically
on the Tizen 5.0 (M63) WebView and a desktop browser:

- Items (1)–(4) are implemented by **jellyfin-web** (`focusManager` +
  `dialogHelper` + `keyboardnavigation`), and that bundle is byte-identical on
  both platforms. The only way the TV could diverge is if the shell interfered
  with a key the dialog needs — and it does not.
- Item (5) is satisfied **twice**: jellyfin-web's `focusManager` clamps its focus
  scope to the topmost `.dialogContainer .dialog.opened`, **and** the shell's own
  `scopes()` (inside its body-focus-rescue) ranks that exact selector as scope
  `[0]` — so the shell's rescue, if it ever fires, re-homes focus **inside** the
  open dialog rather than leaking it to the page behind.

Automated proof, both green:

- `packages/shell-tizen/scripts/dialog-focus.test.cjs` (wired into
  `pnpm --filter @jellyfin-tv/shell-tizen test`) — **16/16 pass**. Owns the shell
  side; **behaviourally runs the shipping `scopes()`/`findT()`** over a fake DOM.
- `tooling/tv-validate/dialog-focus/verify-dialog-contract.mjs` — **7/7 pass**
  against the live server bundle. Owns the jellyfin-web side; skips cleanly when
  `JELLYFIN_URL` is unset.

---

## Why this reduces to (shell transparency) + (a pinned `scopes()` rule)

A dialog is open and the user is interacting with it. The only way the TV could
behave differently from a browser is if the **shell** touched something the
dialog relies on. The shell can affect a dialog through exactly two surfaces, and
both are verified safe:

| #   | Surface                                  | Shell behaviour with a dialog open                                                                                                                                                                                                                                                                           | Effect on jellyfin-web's dialog                                                                                                                                                                                           |
| --- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a   | **Keys** (arrows / Tab / Enter / Escape) | The shell binds **no** Escape / keyCode-27 handler at all. Its only key listener besides BACK is the body-focus-rescue, which **early-returns unless `activeElement` is `<body>`** and only `preventDefault`s after a _successful_ re-focus. While focus is inside the dialog, the rescue is a strict no-op. | Every arrow / Tab / Enter / Escape reaches `focusManager` / `dialogHelper` unmodified → trapping, D-pad confinement, and Escape-to-close are pure jellyfin-web.                                                           |
| b   | **BACK** (Tizen keyCode 10009)           | The BACK handler **early-returns** once `window.__jellyfinShellBootDone` is set (post-boot, the web client owns BACK). It only `preventDefault`s + exits the app on the **pre-boot connect screen**, which is not a dialog context.                                                                          | Post-boot BACK (10009 → KeyName `"Back"` → `handleCommand("back")`) reaches `dialogHelper`, which closes the topmost dialog and `stopPropagation`s so the page does not also navigate. Same path as the browser's Escape. |

### TV == browser by construction

The shell's key gates reference **no** `tizen`/`webapis` global — the BACK gate
is just `keyCode === 10009 && __jellyfinShellBootDone`, and the rescue gate is
just `isBodyF()`. So the decision to stay out of the way is identical on TV and
browser. The deterministic test asserts the absence of any Escape handler and
the post-boot BACK early-return in both `shell.js` and the deployed
`shell.min.js`.

---

## The shell's `scopes()` mirrors jellyfin-web's own focus-trap rule (item 5)

jellyfin-web's `focusManager` clamps its navigation scope like this (lifted from
the live bundle):

```js
n = document.activeElement || window;
var l = document.querySelectorAll(".dialogContainer .dialog.opened"),
  c = l.length ? l[l.length - 1] : null;
c && !c.contains(n) && (n = c); // ← if focus isn't inside the topmost dialog, clamp the scope TO it
```

The shell's body-focus-rescue carries the **same** rule as the first entry of its
`scopes()` list:

```js
function scopes() {
  var out = [];
  var d = document.querySelectorAll(".dialogContainer .dialog.opened");
  if (d.length) out.push(d[d.length - 1]); // ← topmost opened dialog is scope[0]
  // …then active .page, then .skinHeader/#reactRoot chain, then document.body
  return out;
}
```

`findT()` walks `scopes()` in order and returns the first visible focusable, so
while a dialog is open `__shellLastScopeHit === 0` and any rescue/auto-focus lands
**inside** the dialog. `dialog-focus.test.cjs` proves this by running the real
extracted functions: scope `[0]` is the dialog, `findT()` returns a dialog button,
and once the dialog closes the same functions fall through to the page (the
trigger), never stranding focus.

---

## What the automated checks cover

### Shell side — `node packages/shell-tizen/scripts/dialog-focus.test.cjs`

- **Part A (behavioural):** extracts the exact `vis/fst/scopes/findT` helpers from
  the shipping `shell.js` injection string (unescaping the `\'` selector) and runs
  them over a fake DOM: dialog is scope `[0]`, ranks above the active `.page`,
  `findT()` targets a dialog-internal focusable (`hit === 0`), and after close it
  falls through to the page trigger.
- **Part B (source contract):** `scopes()` takes the topmost dialog
  (`d[d.length-1]`); BACK early-returns post-boot; **no** Escape / keyCode-27
  handler; the rescue is gated by `isBodyF()` and only `preventDefault`s after a
  successful re-focus; and the deployed `shell.min.js` carries the same scopes
  selector + BACK gate and likewise binds no Escape handler.

### jellyfin-web side — `JELLYFIN_URL=… node tooling/tv-validate/dialog-focus/verify-dialog-contract.mjs`

Re-derives from the live bundle: focus-trap scope clamp to topmost
`.dialogContainer .dialog.opened`; `10009`/`461` → KeyName `"Back"`; Escape →
`handleCommand("back")` on TV; `dialogHelper` closes on the `"back"` command with
`preventDefault` + `stopPropagation`; trigger `activeElement` saved on open and
restored on close (else `autoFocus`).

---

## Notes / non-issues

- **No device photo needed.** The behaviours are jellyfin-web's, running in the
  same bundle on both platforms; the only TV-specific variable is whether the
  shell interferes, which is pinned to source + live contract. (Per the standing
  rule, on-device confirmation would be self-captured, never requested as a
  manual photo.)
- **Pre-boot BACK exits the app** — intentional and out of scope here: there is no
  dialog before the remote web client boots.
- The shell's focus-rescue is a TV-only **safety net** for the M63 WebView's
  body-focus drops; on a desktop browser it simply never fires (focus does not
  fall to `<body>`), so it cannot create a divergence.
