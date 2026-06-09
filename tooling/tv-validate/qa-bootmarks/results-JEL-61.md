# JEL-61 — Compare: QA overlay & boot marks — `window.__qaMarks` fields populated correctly

**Verdict: confirmed working and correct on TV and browser. 61/61 checks pass.**

With the QA overlay (`jellyfin.qa.overlay='1'`) and boot marks
(`jellyfin.qa.bootMarks.enabled='1'`) enabled, `window.__qaMarks` is populated
with all seven boot spans, the buffer is persisted to
`localStorage['jellyfin.qa.bootMarks.current']` on every mutation, and the next
boot rotates that into `localStorage['jellyfin.qa.bootMarks.prior']`.

```
node tooling/tv-validate/qa-bootmarks/verify-qa-bootmarks.mjs   # 61/61 PASS
```

## Why this is verifiable off-device (not a pixel capture)

Boot marks are a pure browser-side instrumentation channel, implemented entirely
in the head `<script>` IIFEs of `packages/shell-tizen/src/index.html`
(JEL-1973/1974, v68) plus `markDocumentWrite()` in `shell.js`. Correctness is
structural + runtime-deterministic and does **not** depend on the Tizen
WebView's rendering — only on (a) the boot-mark IIFE allocating
`window.__qaMarks` and persisting it, (b) the other head IIFEs +
`markDocumentWrite()` stamping their span into it, and (c) the next boot rotating
`current`→`prior`. The harness proves all three by source structure **and** by
executing the **exact IIFE bytes** from `index.html` (plus the real
`markDocumentWrite` lifted verbatim from `shell.js`) under both a modern-browser
and a legacy-Chromium (Tizen 5.5 / Chromium 69) navigator, across two boots that
share one `localStorage`.

## The TV-vs-browser truth (the "Compare" half of the ticket)

The boot-mark IIFE is **not UA-gated** — only `jellyfin.qa.bootMarks.enabled`
gates it — so the buffer, persistence and rotation are byte-for-byte identical on
TV and browser. The seven spans split into two groups:

| span                  | browser (Chrome/120) | TV (Tizen 5.5 / Chromium 69) | why                                               |
| --------------------- | -------------------- | ---------------------------- | ------------------------------------------------- |
| `tShellStart`         | ✅ populated         | ✅ populated                 | stamped at buffer allocation                      |
| `tFirstWebFetchStart` | ✅ populated         | ✅ populated                 | prefetch `idxFetch`, outside the legacy gate      |
| `tFirstWebFetchEnd`   | ✅ populated         | ✅ populated                 | prefetch `idxFetch` `.then()`                     |
| `tDocumentWrite`      | ✅ populated         | ✅ populated                 | `markDocumentWrite()` on the `document.open` path |
| `tBabelPreloadAppend` | **0 (by design)**    | ✅ populated                 | babel.min.js critical path — legacy only          |
| `tBabelScriptAppend`  | **0 (by design)**    | ✅ populated                 | babel.min.js critical path — legacy only          |
| `tBabelReady`         | **0 (by design)**    | ✅ populated                 | babel.min.js critical path — legacy only          |

The three babel spans are **legacy-Chromium-only by construction**: they time the
`babel.min.js` download/parse, and `babel.min.js` is only ever loaded on legacy
Chromium (`<70`). A modern browser never transpiles, so its babel IIFE
early-returns (`window.__ensureBabel = function(){return Promise.resolve()}`) and
those three spans legitimately stay `0`. This exactly mirrors the **JEL-56**
bundle-patch precedent — the instrumentation runs on both UAs; the
babel-specific work is legacy-only. So on the TV (the legacy path) **all seven**
populate; on a modern browser the four UA-independent spans populate and the
three babel spans stay `0` — the correct, designed behaviour, not a regression.

## Part A — source structure (gate + buffer + persist + rotate)

- The QA seed in `index.html` flips both gates: `jellyfin.qa.overlay='1'` (overlay
  HUD + beacon) and `jellyfin.qa.bootMarks.enabled='1'` (boot marks).
- The boot-mark IIFE is gated **only** by `bootMarks.enabled` — no `navigator`/UA
  reference inside it — and `if(!en){window.__qaMarks=null;return}` short-circuits
  when off.
- It allocates `window.__qaMarks` with all seven span fields plus `bootIndex` /
  `bootTs`, stamping `tShellStart` via `performance.now()` at allocation.
- `window.__qaMarksSave()` persists the buffer to `jellyfin.qa.bootMarks.current`
  and is invoked immediately after allocation.
- Rotation reads `.current` and writes it to `.prior` **before** the new buffer is
  allocated, so `.prior` holds the _previous_ boot's spans; `jellyfin.qa.bootIndex`
  increments each boot.
- The IIFE precedes `<script src="shell.min.js">` and every span-writer
  (preload/prefetch/babel) in document order.
- Each remaining span is stamped at exactly one documented, `if(window.__qaMarks)`-
  guarded, save-followed site: `tBabelPreloadAppend` (JEL-1973 preload IIFE),
  `tFirstWebFetchStart`/`tFirstWebFetchEnd` (prefetch `idxFetch`, outside the
  legacy gate), `tBabelScriptAppend`/`tBabelReady` (babel IIFE), and
  `tDocumentWrite` (`markDocumentWrite()` in `shell.js`).
- `tDocumentWrite` + the `.current` flush ship identically in `shell.js`,
  `shell.min.js` (release artifact) **and** `boot-shell.src.js` (hosted/bootstrap
  shell); `markDocumentWrite()` is invoked on the `document.write` boot path.
- The beacon (`qa-beacon.js`) shares the `jellyfin.qa.overlay` gate and reads the
  rotated `jellyfin.qa.bootMarks.prior` once, emitting it as `priorBootMarks`.

## Part B — runtime execution (two boots, one localStorage, both UAs)

Executing the exact IIFE bytes under each UA:

- **Boot 1** allocates `window.__qaMarks` (`bootIndex=1`), persists the full
  buffer to `.current` (all seven span keys present), and writes **no** `.prior`
  yet. The four UA-independent spans populate (`>0`) on both UAs; the three babel
  spans populate on TV and stay `0` on browser (and no `babel.min.js` `<script>`
  is appended on the modern UA).
- **Boot 2** advances the counter (`bootIndex=2`) and rotates boot 1's `.current`
  into `.prior` — `.prior` holds boot 1's complete span snapshot (verified
  field-by-field), while `.current` holds the fresh boot-2 buffer.

## Part C — gate-off safety

With `bootMarks.enabled` unset, the IIFE sets `window.__qaMarks = null` and writes
**no** `jellyfin.qa.bootMarks.*` keys — production builds never allocate the buffer
or touch boot-mark storage.

---

**Command**: `node tooling/tv-validate/qa-bootmarks/verify-qa-bootmarks.mjs   # 61/61 PASS`
