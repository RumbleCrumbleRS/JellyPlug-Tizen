# JEL-59 — Compare: Legacy Chromium preload of main bundle + plugin scripts (`<link rel=preload>`)

**Verdict: behavior confirmed — the two-boot preload pipeline writes the four
URL lists on boot N and emits the matching `<link rel=preload as=script|style>`
on boot N+1, gated correctly to legacy Chromium. No shell defect. 33/33 checks
pass, hermetically (no live server needed).**

This ticket is **not** a server-data parity case like movie/series/search/
settings. The preload pipeline is a **shell-internal load optimization** that
runs **only on legacy Chromium** (M56/M63 Tizen WebViews). `<link rel=preload>`
warms the HTTP cache + V8 script-streaming parse pipeline; it **never changes
what renders**. So "TV vs browser" here is a _gating_ question, and the parity
proof is: the legacy (TV) path emits the right preloads, and the modern (browser)
path emits **none** — leaving the rendered DOM identical by construction.

## The pipeline (two boots, four keys)

| #   | First boot WRITES (`shell.js` → `shell.min.js`) | localStorage key                     | cap  |
| --- | ----------------------------------------------- | ------------------------------------ | ---- |
| 1   | main bundle URL (JEL-1289)                      | `jellyfin.shell.bundleUrl`           | 1    |
| 2   | plugin `<script src>` URLs (JEL-1654)           | `jellyfin.shell.pluginUrls`          | ≤100 |
| 3   | secondary `*.bundle.js` URLs (JEL-1924)         | `jellyfin.shell.secondaryBundleUrls` | ≤20  |
| 4   | `<link rel=stylesheet>` URLs (JEL-1959)         | `jellyfin.shell.stylesheetUrls`      | ≤20  |

On the **second** boot the `index.html` head IIFE (JEL-1967) reads those keys and,
**only when the WebView is legacy Chromium**, injects:

- `<link rel=preload as=script>` for the bundle + plugin + secondary URLs
- `<link rel=preload as=style>` for the stylesheet URLs

and publishes counters `window.__shellPreloadScripts` (main bundle + plugins),
`__shellPreloadSecondaries`, `__shellPreloadStylesheets`.

`__shellPreloadScripts` = `(bundle ? 1 : 0)` + (deduped, same-origin plugin URLs)
— exactly the ticket's "`__shellPreloadScripts` count matches."

## How the harness runs the REAL shipped code

`tooling/tv-validate/preload/verify-preload.mjs` (Node ≥18, `node:vm`; **no env,
no network, no credentials**).

- **PART A** extracts the literal preload `<script>` from `src/index.html` and
  executes it inside a `vm` sandbox with a mocked
  `window`/`document`/`localStorage`/`navigator`. `src/index.html` is the .wgt
  entry point (`config.xml` → `<content src="index.html"/>`) and ships **byte-
  for-byte** (`build-wgt.sh` does `cp -R src/. stage/`), so the bytes under test
  are the bytes that boot on the TV. No re-implementation.
- **PART B** pins the first-boot **write** side to source (`shell.js` source-of-
  record **and** the deployed `shell.min.js`) and proves the write-keys/caps are
  exactly the read-keys/caps — the round-trip contract that keeps the two boots
  from drifting apart.

## Results (33/33)

```
== PART A: second boot — real index.html preload IIFE (legacy vs modern) ==
PASS  extracted the shipped preload IIFE from src/index.html  — 2293 bytes
PASS  A1 legacy: every injected <link> is rel=preload  — 7 links
PASS  A1 __shellPreloadScripts === main bundle (1) + deduped same-origin plugins (2) = 3
PASS  A1 __shellPreloadSecondaries === 2 (deduped, cross-origin dropped)
PASS  A1 __shellPreloadStylesheets === 2 (deduped, cross-origin dropped)
PASS  A1 DOM: 5 <link as=script> + 2 <link as=style> injected into <head>
PASS  A1 first script preload is the MAIN BUNDLE
PASS  A1 cross-origin URLs are NOT preloaded (same-origin gate holds)
PASS  A1 duplicate plugin URL preloaded exactly once (dedup)
PASS  A1 stylesheet links use as=style, not as=script
PASS  A2 plugin preload capped at 100 (__shellPreloadScripts === 1 bundle + 100)  — from 130
PASS  A2 secondary bundle preload capped at 20  — from 25
PASS  A2 stylesheet preload capped at 20  — from 25
PASS  A3 bundle URL outside /web/ is NOT preloaded
PASS  A4 MODERN browser injects ZERO preload links (optimization is legacy-only)
PASS  A4 MODERN browser leaves __shellPreload* counters UNSET (undefined)
PASS  A4 MODERN browser still sets __shellPrefetch — shared path, only preload differs
PASS  A5 with no saved serverUrl the IIFE no-ops — nothing to preload on first boot

== PART B: first boot write side (shell.js + shell.min.js) + round-trip contract ==
PASS  B1 shell.js writes {bundleUrl,pluginUrls,secondaryBundleUrls,stylesheetUrls}  (4)
PASS  B2 deployed shell.min.js also writes all 4 keys  (4)
PASS  B3 plugin/secondary/stylesheet caps agree write↔read (100/20/20)  (3)
PASS  B4 plugin scan excludes the jellyfin-web client bundle (isJellyfinWebBundle)
PASS  B4 secondary scan excludes the MAIN bundle (SB_MAIN_RE)
PASS  B4 secondary + stylesheet scans apply a server same-origin gate
PASS  B5 round-trip: the 4 keys WRITTEN on boot N are exactly the 4 keys READ on boot N+1

33/33 checks passed.
```

## What each part proves against the ticket

- **Ticket checks (1)–(4) [first boot writes]** — PART B1/B2 prove `shell.js`
  **and** the deployed `shell.min.js` write all four keys; B4 proves the scans
  exclude the things they must (the jellyfin-web client bundle from the plugin
  list, the main chunk from the secondary list) and apply the same-origin gate;
  B3 pins the `≤100` plugin / `≤20` secondary / `≤20` stylesheet caps.
- **Ticket check [second boot emits `<link rel=preload as=script|style>` and
  `__shellPreloadScripts` count matches]** — PART A executes the real IIFE and
  asserts the exact DOM (`as=script` for bundle/plugins/secondary, `as=style`
  for stylesheets, all `rel=preload`), the counters, the same-origin gate, the
  `/web/` bundle-path gate, and dedup — including the cap boundary (130 plugin
  URLs → 100 preloads).
- **TV vs browser parity** — A4 proves a modern browser runs the same IIFE but
  injects **zero** preload links and leaves the counters undefined, while still
  setting `__shellPrefetch` (the shared index/config warm). The preload is
  purely a legacy-only timing optimization; the rendered DOM is identical.
- **Round-trip safety** — B5 proves the four keys written on boot N are exactly
  the four keys read on boot N+1, so the producer (`shell.js`) and consumer
  (`index.html`) cannot silently diverge.

## Scope notes

- **Hermetic by design.** The preload path has no server-data dimension, so —
  unlike the other `tv-validate` "Compare:" harnesses — this one needs no live
  Jellyfin server. It runs the literal shipped IIFE against a synthetic DOM and
  pins the write side to source, which is a complete proof of the pipeline's
  behavior. The legacy/modern branch is driven by a real M63-style vs Chrome-120
  `navigator.userAgent`.
- **Not pixel-timed on the physical TV.** Per the JEL-7 blockers, the locked M63
  TV cannot run an automated timing/inspector harness from the sandbox. The
  on-device _effect_ of preload (cache + V8 parse warm) is invisible to a DOM
  assertion anyway; what is verifiable — and what could regress — is that the
  correct `<link rel=preload>` elements are emitted with the correct gates/caps,
  which this proves. The shell additionally exposes the same counters on the QA
  pixel beacon (`PL:S/B/C/T`, `shell.js` ~L1206) for on-device confirmation.

```
Re-run: node tooling/tv-validate/preload/verify-preload.mjs
```
