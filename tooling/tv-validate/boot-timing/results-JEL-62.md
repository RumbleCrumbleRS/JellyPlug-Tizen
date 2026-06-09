# JEL-62 — Compare: Boot timing — shell start to first card rendered

**Verdict: the boot-marks pipeline correctly decomposes the shell-owned boot
span TV vs browser, and the difference is exactly one phase — the legacy-only
Babel transpile. No regression from the optimization milestones (prefetch,
preload, babel preload, index cache); every one still participates in the boot
path. 24/24 checks pass, hermetically (no live server, no creds, no network).**

## The boot timeline and who owns each phase

```
  tShellStart ──► tFirstWebFetchStart ──► tFirstWebFetchEnd ──► tDocumentWrite ──┊──► ApiClient init ──► first card visible
  └──────────────────── shell-owned span (instrumented in window.__qaMarks) ─────┘   └─ jellyfin-web internal (NOT shell-instrumented) ─┘
                                                                          document.open()/write() handoff ┘
```

The shell instruments the span it **owns** — from the head-IIFE boot
(`tShellStart`) to the `document.open()/write()` handoff to the remote web client
(`tDocumentWrite`). Everything **after** document.write — ApiClient init and the
first card paint — runs inside the **identical jellyfin-web bundle** on both UAs,
so it is **parity-by-construction**: same bytes, same code path, only **time-
shifted** by the shell's pre-handoff delta. The shell does not (and should not)
re-instrument jellyfin-web internals. First-card timing is observed **downstream**
by the QA beacon's `countCards()` and the HUD `cards:N` row (see PART B).

### The marks (`window.__qaMarks`, shipped in `src/index.html`)

| Mark                   | Stamped by                                                   | Fires on     |
| ---------------------- | ------------------------------------------------------------ | ------------ |
| `tShellStart`          | boot-mark initializer IIFE                                   | TV + browser |
| `tBabelPreloadAppend`  | babel-preload IIFE (`<link rel=preload babel.min.js>`)       | **TV only**  |
| `tBabelScriptAppend`   | `__ensureBabel` (eager kick appends `<script babel.min.js>`) | **TV only**  |
| `tBabelReady`          | babel `<script>` `onload` (V8 parse complete)                | **TV only**  |
| `tFirstWebFetchStart`  | prefetch IIFE, before `fetch('/web/index.html')`             | TV + browser |
| `tFirstWebFetchEnd`    | prefetch IIFE `.then()`                                      | TV + browser |
| `tDocumentWrite`       | `shell.js markDocumentWrite()`, before `document.open()`     | TV + browser |
| `bootIndex` / `bootTs` | initializer (rotates `current`→`prior`, increments index)    | TV + browser |

## The headline result — which phases are longer on TV

The **shared critical path** — shell-start, the `/web/` fetch span
(`tFirstWebFetchStart`→`End`), and the document-write handoff — fires on **both**
UAs in the same order. The phase that makes TV boot longer is the **Babel
transpile phase** (`tBabelPreloadAppend` → `tBabelScriptAppend` → `tBabelReady`):
the 3.13 MB Babel fetch + V8 parse + every legacy `<script>` re-transpile. It
fires **only** on the legacy M56/M63 WebView. On modern Chromium all three babel
marks stay **0** — there is no transpile phase at all. On the physical TV the
`/web/` RTT itself is also heavier (LAN 200–500 ms vs localhost), but that is the
same fetch on the same code path, just slower link — not an extra phase.

So "TV vs browser boot timing" decomposes to:

- **shared** — `tShellStart → tFirstWebFetchStart → tFirstWebFetchEnd → tDocumentWrite` (same marks, same order, both UAs)
- **TV-only added phase** — the Babel transpile sub-span, overlapped with the `/web/` RTT on babel-needed legacy boots
- **post-handoff (ApiClient init → first card)** — identical jellyfin-web bytes on both, time-shifted by the shell delta; observed off-device via the QA beacon

## How the harness runs the REAL shipped code

`tooling/tv-validate/boot-timing/verify-boot-timing.mjs` (Node ≥18, `node:vm`;
**no env, no network, no creds**).

- **PART A** extracts the **four** shipped head `<script>` boot-mark IIFEs from
  `src/index.html` (the `.wgt` entry point — `config.xml`
  `<content src="index.html"/>`, `build-wgt.sh` does `cp -R src/.`, so the bytes
  under test are the bytes that boot on the TV) **plus** the real
  `markDocumentWrite()` extracted verbatim from `shell.js`, and runs a **full
  cold boot** through them inside one `vm` sandbox under a **strictly-increasing
  clock** — so the captured timeline **order is itself the assertion**. It boots
  once as a legacy (TV) WebView and once as a modern (browser) one.
- **PART B** pins the marks contract to the shipped artifacts: the 9-field schema
  in `src/index.html`, the `markDocumentWrite()` stamp invoked at **both**
  `document.open()/write()` handoff sites in `shell.js`, the same stamp present
  in the **deployed** `shell.min.js`, the downstream one-shot
  `bootMarks.prior`→`payload.priorBootMarks` read in `qa-beacon.js`, and the
  `countCards()` first-card observer — then proves **no regression**: each
  optimization milestone still participates in the boot path.

## Results (24/24)

```
PASS  extracted all 4 shipped boot-mark head IIFEs from src/index.html (in document order)
PASS  extracted the real markDocumentWrite() stamp from shell.js (source of record)

== PART A: drive the real boot-mark IIFEs — TV (legacy) vs browser (modern) timeline ==
PASS  A1 boot-mark initializer creates window.__qaMarks with the full 9-field schema  — fields=9
PASS  A1 bootIndex incremented (first boot → 1) and bootTs stamped
PASS  A2 TV core timeline is captured in order: tShellStart < tFirstWebFetchStart < tFirstWebFetchEnd < tDocumentWrite  — shellStart=1 webStart=3 webEnd=5 docWrite=7
PASS  A2 the /web/ fetch span is non-empty (tFirstWebFetchEnd > tFirstWebFetchStart) — prefetch RTT measured
PASS  A3 TV-only babel phase fires and is ordered: tBabelPreloadAppend ≤ tBabelScriptAppend ≤ tBabelReady (all > 0)  — preload=2 script=4 ready=6
PASS  A3 TV boot appended <link rel=preload babel.min.js> + <script src=babel.min.js>
PASS  A4 marks persisted to localStorage['jellyfin.qa.bootMarks.current'] as parseable JSON matching the schema
PASS  A5 browser core timeline captured in the same order (shared critical path)  — shellStart=1 webStart=2 webEnd=3 docWrite=4
PASS  A6 browser has NO babel phase — tBabelPreloadAppend/tBabelScriptAppend/tBabelReady all stay 0  — preload=0 script=0 ready=0
PASS  A6 browser appended NO babel.min.js <link>/<script> and __shellBabelPreload === 0
PASS  A7 both UAs run the SAME prefetch path — __shellPrefetch set on TV and browser
PASS  A8 second boot rotates last boot's marks into bootMarks.prior and increments bootIndex (1 → 2)
PASS  A9 with bootMarks.enabled unset, window.__qaMarks is null — production builds carry zero timing overhead

== PART B: pin the marks contract to shipped artifacts + no-regression ==
PASS  B1 src/index.html boot-mark initializer declares the exact 9-field schema  — 9/9
PASS  B2 shell.js invokes markDocumentWrite() at BOTH document.open/write handoff sites (fast + slow path)
PASS  B3 deployed shell.min.js carries tDocumentWrite + markDocumentWrite (artifact, not just source)
PASS  B4 qa-beacon reads bootMarks.prior once, nulls it (takePriorBootMarks), ships it as payload.priorBootMarks
PASS  B4 first-card is observed downstream — qa-beacon countCards() counts rendered .card/.listItem/.cardScalable
PASS  B5 no-regression: prefetch (JEL-58) still stamps tFirstWebFetchStart/End around the /web/index.html fetch
PASS  B5 no-regression: babel preload (JEL-1973) still stamps tBabelPreloadAppend + eagerly kicks __ensureBabel
PASS  B5 no-regression: preload (JEL-59) <link rel=preload> path still present in the prefetch IIFE, gated legacy
PASS  B5 no-regression: index cache (JEL-57) still consulted by shell.js around the document-write handoff

24/24 checks passed.
```

## What each part proves against the ticket

- **"measure … tShellStart → tFirstWebFetchStart → tFirstWebFetchEnd →
  tDocumentWrite"** — PART A drives the real IIFEs and asserts all four marks are
  stamped in the ticket's order on **both** UAs (A2/A5), with a non-empty fetch
  span (A2), and persisted to localStorage for the beacon (A4).
- **"ApiClient init → first card visible"** — these are jellyfin-web internal,
  not shell-instrumented; PART B4 documents how they are observed off-device
  (`countCards()` + the `bootMarks.prior`→beacon hop), and the doc explains they
  are parity-by-construction (identical bundle, only time-shifted).
- **"Identify which phases are longer on TV"** — A3 (babel phase fires, ordered,
  real DOM work) vs A6 (browser has **no** babel phase, marks stay 0). The
  TV-only added cost is the Babel transpile span; the `/web/` RTT is the same
  phase on a slower link.
- **"confirm no regressions from the optimization milestones (prefetch, preload,
  babel preload, index cache)"** — B5 pins each milestone to the shipped boot
  path: prefetch stamps the fetch marks (also proven live in A2), babel preload
  stamps + eager-kicks (A3), the legacy `<link rel=preload>` path coexists with
  the marks, and the index cache is still consulted by `shell.js`. A7 confirms
  both UAs share the prefetch path; A9 confirms the instrumentation is gated off
  in production builds (zero overhead).

## Scope notes

- **Hermetic by design.** Boot timing is shell-internal instrumentation with no
  server-data dimension, so — like the `preload`/`bundle-patch` harnesses — this
  one needs no live Jellyfin server. It runs the literal shipped IIFEs + the real
  `markDocumentWrite()` against a synthetic DOM under a deterministic clock, which
  is a complete proof of the pipeline's **ordering and gating** behavior. UA
  drives the legacy/modern branch (M63-style Chrome/63 vs Chrome/120).
- **Not wall-clock timed on the physical TV.** Per the JEL-7 blockers, the locked
  M63 TV cannot run an automated timing/inspector harness from the sandbox. Real
  millisecond spans are not asserted here — the clock is synthetic and monotonic
  to prove **order**, not duration. On-device, the same marks ship to the QA
  collector via `qa-beacon.js` (`payload.priorBootMarks`, the previous boot's full
  span set), so absolute TV-vs-browser durations are recoverable from beacon
  ndjson when a device session is run; what is verifiable here — and what could
  regress — is that the marks fire, in the right order, with the right gating,
  and that no optimization milestone dropped out of the path.

```
Re-run: node tooling/tv-validate/boot-timing/verify-boot-timing.mjs
```
