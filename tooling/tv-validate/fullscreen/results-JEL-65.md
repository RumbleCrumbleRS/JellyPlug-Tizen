# JEL-65 — Compare: Fullscreen — `enableFullscreen` / `disableFullscreen` no-ops on TV

**Verdict: confirmed no-ops — harmless on TV, no glitch / layout change / error. 19/19 checks pass.**

`NativeShell.enableFullscreen()` and `NativeShell.disableFullscreen()` are empty
functions in every shell artifact the TV ever runs. Calling them does **nothing
observable** because the Tizen WebView is a permanently-fullscreen kiosk surface
— there is no smaller window to grow from or shrink to. The proof is structural:
an empty function body provably cannot toggle fullscreen, mutate layout, or
throw. The interesting part of this ticket is the *comparison*, which turns out
to be a common misconception worth pinning down precisely.

## There are TWO independent "fullscreen" mechanisms in jellyfin-web

The ticket frames the browser as a place where "these calls may toggle the
browser's fullscreen API." They do not — on **any** platform. The real
browser-fullscreen toggle lives in a separate code path:

### (A) `NativeShell.enableFullscreen` / `disableFullscreen` — _this ticket_

Native-window control for embedded shells (Electron / Tizen / webOS).
jellyfin-web's apphost module wraps both with an existence guard, then delegates
(captured live, byte-for-byte, from the bundle — see _Ground truth_):

```js
enableFullscreen: function () {
  var e;
  null !== (e = window.NativeShell) && void 0 !== e &&
    e.enableFullscreen && window.NativeShell.enableFullscreen();
},
disableFullscreen: function () { /* …same shape, disableFullscreen… */ },
```

- **On TV:** `window.NativeShell` exists with both methods, so the wrapper
  reaches the shell's body — which is `function () {}`. No-op, no throw, no
  layout touch.
- **In a plain desktop browser:** `window.NativeShell` is `undefined`, so the
  guard short-circuits and the wrapper itself does nothing. So these two methods
  **never touch the browser fullscreen API even in a browser.** They exist only
  so a native shell can drive the OS window. Tizen's window is always
  fullscreen, so an empty body is the correct and only sane implementation.

### (B) The `Fullscreen` SupportedCommand → `togglefullscreen` → `requestFullscreen`

This is the path that actually toggles the **browser** Fullscreen API — the
"browser behavior" the ticket has in mind. jellyfin-web advertises the
`Fullscreen` command **only when it is _not_ on a TV** (captured live):

```js
function () {
  if (browser.tv) return false;                 // ← TV: Fullscreen never advertised
  var e = document.documentElement;
  return !!(e.requestFullscreen || e.mozRequestFullScreen ||
            e.webkitRequestFullscreen || e.msRequestFullscreen ||
            document.createElement("video").webkitEnterFullscreen);
}() && supportedCommands.push(SupportedCommands.Fullscreen)
```

The `if (browser.tv) return false` removes the `togglefullscreen` capability on
a TV entirely — **independent of the shell**. So the divergence the ticket asks
about (real fullscreen toggling in a browser) lives in (B), and jellyfin-web
itself gates it off for TV. On the desktop browser (B) is live; on TV it is dead
by jellyfin-web's own design, and (A) is a no-op everywhere.

**Net:** nothing the shell does around fullscreen can glitch on TV — its method
bodies are empty, and the one mechanism that *would* change the viewport (B) is
not even offered on a TV.

## What the harness proves (19 checks)

`packages/shell-tizen/scripts/fullscreen-noop.test.cjs`:

| #   | Check                                                                                                 | Why it matters                                                              |
| --- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1   | `enableFullscreen`/`disableFullscreen` bodies in **shell.js** and **boot-shell.src.js** are empty after stripping comments/whitespace | A body with any statement could touch layout and diverge — empty cannot.    |
| 2   | The **deployed** blobs (`shell.min.js`, `boot-shell.min.js`) define both as `function(){}`            | The bytes that actually run on the TV match the source-of-record intent.    |
| 3   | The no-op bodies reference no `requestFullscreen`/DOM/`style.`/`tizen`/`webapis`/`location` token      | Belt-and-suspenders: flags any future "harmless-looking" non-empty edit.    |
| 4   | The apphost wrapper is existence-guarded before delegating, and the shell exposes the exact method name it calls | Guarantees (a) TV reaches our no-op and (b) browser short-circuits.         |
| 5   | The real browser Fullscreen command is advertised only when `!browser.tv` and keys off `requestFullscreen` | Pins that the divergent path is (B), TV-gated by jellyfin-web itself.       |
| 6   | The shell's `SupportedFeatures` list advertises **no** fullscreen capability                          | The shell never re-enables a togglefullscreen affordance with no TV target. |

All four shell artifacts are checked, so the contract cannot silently drift; the
two jellyfin-web ground-truth strings are pinned so a wrapper/gate rename
surfaces here rather than as a dead or crashing call on the TV.

## Ground truth (re-capture)

Strings (A) and (B) were captured from the live web client on 2026-06-09:

```sh
curl -s "$JELLYFIN_URL/web/main.jellyfin.bundle.js" -o /tmp/jf.bundle.js
# (A) apphost wrapper:
grep -o "enableFullscreen:function(){var e[^}]*}}" /tmp/jf.bundle.js
# (B) Fullscreen command TV-gate:
grep -o "function(){if[^}]*requestFullscreen[^}]*}()&&[^,]*Fullscreen)" /tmp/jf.bundle.js
```

jellyfin-web version: 10.11.x (matches the JEL-42 capture).

## Run

```
node packages/shell-tizen/scripts/fullscreen-noop.test.cjs
# or: pnpm --filter @jellyfin-tv/shell-tizen test   (wired into the suite)
```

## On-device note

No physical-TV step is required. The proof is structural: the shipped method
bodies are empty (cannot toggle, cannot throw), and the only viewport-changing
fullscreen path (the `Fullscreen` command) is removed on TV by jellyfin-web's
own `browser.tv` gate. A QA spot-check on the set would observe exactly nothing
when these methods run during photo-slideshow open/close — which is the expected
and verified behaviour.
