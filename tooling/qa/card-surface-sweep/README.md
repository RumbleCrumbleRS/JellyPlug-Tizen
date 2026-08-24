# Native card-surface sweep

Drives the local M63 rig through every native card surface in jellyfin-web and reports, per
surface, how many cards actually rendered and what threw getting there. Built for JELA-696 to
prove the blast radius of the cross-origin `Worker` crash; kept because "did this shell change
break a card grid?" is not a question a boot-timing harness can answer.

Findings and full method: `docs/jela696-worker-shim-blast-radius.md`.

## What you need

- The local Chromium-63 harness (`HARNESS`, default `/tmp/local-tizen-tester`).
- A served rig directory containing the WGT bootstrap page for the arm, `seed.html` (which
  writes the server URL + credentials into `localStorage` and sets `document.title='SEEDED'`),
  and `probe.js` loaded from the bootstrap page's `<head>`. See the JELA-681 rig recipe —
  point the bootloader's shell base at a local directory so you can serve an unmerged
  `shell.min.js`.
- Library and item ids from the server under test. There are **no defaults**: a wrong id
  renders an empty page, which reads exactly like the bug this sweep looks for.

## Run

```sh
export HARNESS=/tmp/local-tizen-tester OUT=/tmp/sweep PROF=/tmp/sweep/prof
export LIB_MOVIES=… LIB_SHOWS=… LIB_BOXSETS=… ITEM_MOVIE=… ITEM_SERIES=…
export HTTP_PORT=8087 CDP_PORT=9696 ARM_PAGE=index696.html

ARM=ctl node sweep.mjs ctl1     # e.g. kill switch set
ARM=fix node sweep.mjs fix1     # shipped default
```

Results land in `$OUT/<tag>.json`.

## Reading the output

- **Count cards scoped to the visible page.** The SPA keeps every page it has visited in the
  DOM behind `.hide`, so a document-wide `.card` count is dominated by pages you already left
  and reads roughly the same everywhere. `probe.js` already scopes; don't "simplify" that away.
- **`icHtml` is the robust metric** — total `innerHTML` bytes across the `.itemsContainer`s on
  the visible page. Under CPU load a healthy arm can look card-poor; it cannot look *empty*.
- **A run with `shim: null` measured nothing.** It means the shell never booted (usually the
  box was loaded). Discard it — do not read its zeros as breakage.
- **Card count cannot prove health on an empty shelf.** A surface with no content renders zero
  cards in both arms; the throw count is what separates "nothing to show" from "broken".
- `window.onerror` and `unhandledrejection` both stay at 0 through this class of failure. The
  `emby-itemscontainer.getItemsHtml` wrap in `probe.js` is the only reason throws are countable.
