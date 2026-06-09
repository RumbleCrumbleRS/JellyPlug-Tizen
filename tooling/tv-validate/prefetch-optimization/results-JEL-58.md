# JEL-58 — Compare: Prefetch optimization — /web/index.html + config.json fetch fires in head IIFE

**Verdict: confirmed working and identical on TV and browser. 28/28 checks pass.**
The head IIFE in `index.html` issues `fetch()` for `/web/index.html` and
`/web/config.json` synchronously, before `shell.min.js` is fetched/parsed;
`window.__shellPrefetch.index` and `.config` are live `Promise` objects by the
time `loadRemoteWebClient` runs and adopts them; and the prefetch measurably
reduces the boot critical path by overlapping the `/web/` RTT with the shell
parse window.

Mechanism: **JEL-554 (v29)** — the prefetch IIFE in `packages/shell-tizen/src/index.html`.
Consumer: `loadRemoteWebClient()` in `packages/shell-tizen/src/shell.js` (and the
shipped `shell.min.js`). Harness: `verify-prefetch.mjs` (PART A/B offline; PART C
times the live Jellyfin test server; read-only, never prints credentials).

```
node tooling/tv-validate/prefetch-optimization/verify-prefetch.mjs   # 28/28 PASS
```

## Why this is verifiable off-device (not a pixel capture)

The prefetch is a pure boot mechanism in the head scripts; its correctness is
**structural + runtime-deterministic** and does not depend on the Tizen WebView
renderer. It depends only on (1) document script ORDER, (2) the IIFE calling
`fetch()` synchronously, and (3) `loadRemoteWebClient` adopting the in-flight
promises. We prove all three by source structure and by executing the **exact
IIFE bytes** from `index.html` under both a modern-browser and a legacy-Chromium
(Tizen) `navigator`. The timing claim is measured against the real server.

## The TV-vs-browser parity argument (structural, not coincidental)

In the IIFE, `pf = {baseUrl:b, index: idxFetch(), config: fetch(b+'config.json')}`
is built **before** the `if(legacy){…}` gate (asserted: pf-build byte-offset <
legacy-gate byte-offset). So the index/config prefetch fires **identically**
regardless of UA. The legacy branch only **adds** `<link rel=preload>` warmers
for the main bundle / plugins / secondary bundles / stylesheets (JEL-1967, v65) —
it never changes whether index/config are prefetched. The runtime sandbox
confirms this both ways: browser UA → 0 preload links, both prefetches present;
Tizen UA → preload warmers appended, both prefetches still present.

## Part A — Source structure (order + shape + adoption), UA-independent

- The prefetch IIFE exists and assigns `window.__shellPrefetch`.
- It appears **before** `<script src="shell.min.js">` in document order — script
  tags execute in order, so the fetches are issued before the browser begins
  fetching/parsing `shell.min.js`.
- `pf.index` ← `fetch(serverUrl+'/web/index.html')`, `pf.config` ←
  `fetch(serverUrl+'/web/config.json')`, parked on `{baseUrl,index,config}`.
- index/config fetch is OUTSIDE the legacy gate (TV == browser).
- The IIFE no-ops without a stored `jellyfin.shell.serverUrl` — prefetch is a
  **warm-boot** optimization (first/cold boot has no server to prefetch from yet).
- **Both** `shell.js` (source of record) and `shell.min.js` (shipped artifact)
  adopt `pf.index`/`pf.config` when `pf.baseUrl === baseUrl`, with a fresh
  `fetch()` fallback, and null `window.__shellPrefetch` afterwards so a
  connect-screen server change re-fetches against the new origin.

## Part B — Runtime execution of the exact IIFE (browser + TV)

The exact `<script>` bytes are executed with stub `window/document/navigator/
localStorage/performance/fetch` injected, once per UA:

| Assertion | browser (Chrome/120) | TV (Tizen 5.5 / Chromium 69) |
|---|---|---|
| `window.__shellPrefetch.index instanceof Promise` | ✅ | ✅ |
| `window.__shellPrefetch.config instanceof Promise` | ✅ | ✅ |
| `fetch()` fired for `/web/index.html` during IIFE | ✅ | ✅ |
| `fetch()` fired for `/web/config.json` during IIFE | ✅ | ✅ |
| legacy `<link rel=preload>` warmers | 0 (none) | 2 appended (additive) |

Both fetches are recorded **synchronously during the IIFE** (before control
returns), which — combined with the Part A document-order proof — establishes
that they fire **before `shell.min.js` is parsed**. A model of
`loadRemoteWebClient`'s adoption expression run against the post-IIFE state shows
it adopts the **same** promise objects (`indexFetch === pf.index`,
`configFetch === pf.config`, **0** fresh fetches) when `baseUrl` matches, and
issues fresh fetches on a server-URL mismatch.

## Part C — Timing: prefetch reduces total boot time (live server)

Modeled two ways and timed against the real server, medians over n=7 with a
warmed connection. `D` = the shell.min.js parse+boot window the prefetch overlaps
network with (representative fixed 150 ms for a deterministic apples-to-apples
comparison):

- **PREFETCH**: fire index+config at t0; overlap parse window `D`; then await →
  wall ≈ `max(D, RTT)`.
- **NO-PREFETCH**: parse for `D` first; then `loadRemoteWebClient` issues the
  fetch and awaits → wall ≈ `D + RTT`.

Representative run: `RTT≈30.7ms`, median prefetch `153.3ms` vs no-prefetch
`180.7ms` → **saved ≈ 27ms**, matching the predicted `min(D, RTT)` overlap savings
(the prefetch hides the full `/web/` RTT pair under the parse window). On real TV
networks the `/web/` RTT is materially larger than this sandbox's RTT to the test
server (the JEL-554 comment cites a full RTT pair, ~100–500 ms), so the on-device
savings are correspondingly larger; the model and the sign of the result are what
the harness pins down. Savings asymptote at `min(parse-window, RTT)`: when the
RTT exceeds the parse window the prefetch still hides a full parse-window's worth.

## Files

- `verify-prefetch.mjs` — the harness (28 checks).
- This document.

No production code changed — JEL-58 is a verification/compare ticket. The
optimization (JEL-554 + the JEL-1967/JEL-1973 preload layering it sits beside)
is confirmed present, correct, and UA-symmetric for the index/config prefetch.
