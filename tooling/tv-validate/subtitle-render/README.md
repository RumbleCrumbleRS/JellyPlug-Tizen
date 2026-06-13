# Subtitle track selection & rendering — browser vs Tizen M63 (JEL-44)

Verifies subtitle behavior for the comparison ticket
[JEL-44](/JEL/issues/JEL-44) under [JEL-28](/JEL/issues/JEL-28) (Full
Browser → Tizen 5.0 comparison): open the subtitle selector, toggle on/off,
switch tracks, and check that rendering on the M63 TV matches the desktop
browser across subtitle formats.

## The one thing the shell controls

Subtitle UI, rendering, and appearance CSS all live in jellyfin-web, which the
shell loads from `${server}/web/` **verbatim** (1:1 parity — see
`../../packages/shell-tizen/PARITY_NOTES.md`). The shell's **only** subtitle
lever is in `getDeviceProfile()`
(`packages/shell-tizen/src/shell.js`), which passes `enableSsaRender: true` and
advertises `subtitleappearancesettings` / `subtitleburnsettings`. That flag
decides whether the server delivers ASS/SSA as a client-rendered external track
or burns it into the video.

## Render path per codec (what actually differs)

| Subtitle codec              | Server delivery (TV & browser)                      | Client render path                            |
| --------------------------- | --------------------------------------------------- | --------------------------------------------- |
| `subrip` / SRT (text)       | **External**                                        | jellyfin-web HTML text overlay                |
| `ass` / `ssa` (SSA)         | **External** (because `enableSsaRender:true`)       | **SubtitlesOctopus** (libass-WASM) `<canvas>` |
| `pgssub`, `dvdsub` (bitmap) | **Encode** (server burns into the transcoded video) | none — pixels are in the video                |

The server treats the TV and the browser **identically** for every codec; the
only divergence vector is the client render engine (M63/Chrome 63 vs desktop V8).

## Scripts

All three are runnable in this sandbox. Set `JELLYFIN_URL`, `JELLYFIN_USER`,
`JELLYFIN_PASS` (the live Test test server).

### `subtitle-delivery.mjs` — server delivery matrix (no browser)

Authoritative. Auto-discovers one real item per codec, then asks the server
(`/Items/{id}/PlaybackInfo`) for the `DeliveryMethod` under the shell's TV
profile (`enableSsaRender:true`) vs a no-SSA profile. Proves the table above and
that flipping `enableSsaRender` would move ASS from client-render to server
burn-in. Exits non-zero on any surprise. Writes `subtitle-delivery.json`.

```
node subtitle-delivery.mjs
```

### `octopus-worker-syntax.cjs` — M63 parse-safety guard for the ASS renderer

ASS rendering loads `subtitles-octopus-worker.js` via `new Worker(url)`, which
**bypasses the shell's Babel transpile** (the shell only transpiles `<script>`
tags + plugin specs). If that worker bundle ever ships ES2020+ syntax, the M63
worker thread throws a `SyntaxError` and ASS silently fails while the browser is
fine. This guard fetches the worker, runs it through the **exact** shell Babel
(chrome:63), and fails only if genuine modern syntax is lowered. Today both the
WASM and asm.js workers are parse-safe (their `?.`/`#x` hits are inside libass's
embedded data tables). Re-run after any jellyfin-web upgrade.

```
node octopus-worker-syntax.cjs
```

### `subtitle-render-capture.mjs` — browser-side render baseline (CDP)

Drives headless Chrome-for-Testing (bring it up once with
`../dpad-nav-test/bootstrap-chromium.sh`), logs in, plays an item, opens the
subtitle selector, switches tracks, and records the render path + screenshots.
Confirmed live: the selector lists every track with its codec, and selecting an
ASS track instantiates a `canvas.libassjs-canvas` with
`video.textTracks.length === 0` — the client libass path, not native cues.

```
../dpad-nav-test/bootstrap-chromium.sh   # once → CDP on :9222
node subtitle-render-capture.mjs
```

The full comparison verdict and residual on-TV risks are recorded on the
Paperclip issue (JEL-44), not in the repo. See `../EVIDENCE-POLICY.md`.
