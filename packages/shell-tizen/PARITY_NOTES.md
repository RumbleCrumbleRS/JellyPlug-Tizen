# Parity notes: shell-tizen vs. desktop browser

This package's design goal is exact 1:1 parity with the standard Jellyfin
web client served at `${server}/web/`. The shell only owns the connect
screen + `window.NativeShell` injection; once the web client boots, every
view, plugin, and theme is rendered by the same code that runs in the
desktop browser.

QA parity checks should treat these intentional, web-client-driven
differences as expected (not shell defects):

1. **Connect screen** -- desktop loads the web client directly from the
   server; the shell shows its own connect form on first launch so the
   user can supply a server URL once. After the URL is saved, the shell
   loads `${server}/web/` and the connect screen is replaced verbatim by
   the web client. There is no shell chrome on subsequent screens.

2. **Stored server URL persistence** -- the shell persists the server URL
   in `localStorage['jellyfin.shell.serverUrl']`. To force the connect
   screen during testing, clear that key and reload. This is shell-only
   state; the web client's own credentials live in
   `localStorage['jellyfin_credentials']` exactly as in the browser.

3. **Detail / item-action TV layout** - jellyfin-web renders its TV-optimized layout when `NativeShell.AppHost.getDefaultLayout` returns `'tv'` (see `shell.js:199`). Action buttons (Play, Library, Shuffle, Mark watched, Heart) render inline beneath the title row; the desktop top-right toolbar and 3-dot overflow are not used. This is intrinsic web-client behavior, not a shell defect.

Source: [JEL-3 QA verdict](/JEL/issues/JEL-3#comment-ca52517e-fdbf-4e65-946a-01a9710184b9).
