# @jellyfin-tv/shell-tizen

Thin Tizen browser-shell for Jellyfin. Loads the standard Jellyfin web
client (`${server}/web/`) so server-installed plugins render 1:1 -- no
vendored web client.

## Architecture

- Widget origin owns the document. We never navigate the WebView away
  from the widget; `tizen.*`/`webapis.*`/`window.NativeShell` only bind
  to widget-origin pages.
- On successful connect we fetch `${server}/web/index.html`, set
  `<base href>` to `${server}/web/`, inject `window.NativeShell` first,
  then write the remote markup back into our document via
  `document.open` / `document.write` / `document.close`. Scripts, CSS,
  and runtime XHR resolve to the live server.

See [JEL-2](/JEL/issues/JEL-2) for the full roadmap.

## Layout

```
src/
  index.html        connect screen, loads shell.js
  shell.js          connect flow + NativeShell + remote loader
  connect/connect.css
  icon.png
tizen/
  config.xml        widget manifest
scripts/
  build-wgt.sh      build entry point (bash)
PARITY_NOTES.md     intentional differences vs. desktop browser
```

## Build

Requires Tizen Studio CLI (`tizen` on PATH) plus an active signing
profile (`VirtualCertificate` for emulator, `TVs` Samsung partner cert
for retail TVs).

```bash
pnpm -C packages/shell-tizen build
```

Outputs: `packages/shell-tizen/dist/JellyfinShell.wgt`.

## Install + smoke

```bash
sdb -s emulator-26101 install dist/JellyfinShell.wgt
sdb shell 0 was_kill JelShellTV.Jellyfin
sdb shell 0 debug JelShellTV.Jellyfin
# parse port: <N>, then `sdb forward tcp:9223 tcp:<N>` for WebInspector.
```

QA parity script lives in `C:\Users\user\AppData\Local\Temp\jel-3-qa\`.
