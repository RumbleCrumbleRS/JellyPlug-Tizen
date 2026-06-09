# JEL-56 — Compare: Bundle patch — serverId=null fix applied correctly — TV vs browser

**Verdict: confirmed correct, parity by design.** `patchPlaybackBundles()` is
invoked on every boot on both TV and browser, but its substantive work — the
`item or serverId cannot be null` CM/PM patch and the `BUNDLE_CACHE_KEY` state
cache — runs **only on legacy Chromium (<70)**, i.e. the Tizen 5.0/5.5 M56/M63
WebViews. On a modern browser (and on modern Tizen TVs) it early-returns and
flags `window.__shellBundlePatchSkipped = 1`. This is correct: the bug it
repairs is itself a Chromium-<70 `viewshow`-race failure (JEL-554 / JEL-436), so
a modern browser never reaches the throw and needs no patch.

- **17/17 runtime checks** — `verify-bundle-patch.mjs` executes the real
  `patchPlaybackBundles` under both UAs against a fake DOM/fetch/localStorage.
- **47/47 static + behavioural checks** —
  `packages/shell-tizen/scripts/bundle-patch.test.cjs` exercises the real cache
  - patcher functions and pins the boot wiring to `shell.js`, the deployed
    `shell.min.js`, and the hosted `boot-shell.src.js`.

## The four things the ticket asks us to prove

| #   | Ticket question                                                        | Result                                                                                                                                                | Evidence                   |
| --- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| 1   | `patchPlaybackBundles()` runs on the main bundle on TV **and** browser | Function is invoked on both; **scans the main bundle only on legacy Chromium** — modern UA early-returns (`__shellBundlePatchSkipped=1`, no fetch)    | Scenario 1 vs 2            |
| 2   | serverId=null patch (CM/PM regex scan) applied when needed             | Patcher fires only when the body contains `item or serverId cannot be null`; injects the `window.ApiClient` fallback and preserves the original throw | Scenario 1 + `.cjs` PART 2 |
| 3   | `BUNDLE_CACHE_KEY` written with `{v, url, needsPatch, body}`           | Confirmed; patched records also carry `patches`; over-cap / quota paths drop `body` but keep the verdict                                              | Scenario 1 + `.cjs` PART 1 |
| 4   | Warm boot uses the cached patched body instead of re-fetching          | Second legacy boot inlines the cached body, strips `<script src>`, tags `data-shell-bundle-from-cache="1"`, **zero network fetch**                    | Scenario 3                 |

## (A) The TV-vs-browser split is a runtime gate, not a code fork

`shell.js` ships identical bytes to TV and browser. The fork is decided at
runtime by `isLegacyChromium()` (UA `Chrome/Chromium < 70`, or the inability to
parse optional chaining `a?.b`). `patchPlaybackBundles()` opens with:

```js
if (!isLegacyChromium()) {
  window.__shellBundlePatchSkipped = 1;
  return Promise.resolve();
}
```

- **Legacy Tizen WebView (Chromium 56)** → fetches `main.*.bundle.js`, scans for
  the throw, patches, and writes `BUNDLE_CACHE_KEY`. (Scenario 1: fetched once,
  scanned 1, patches=1, src stripped, record written.)
- **Modern Chromium (Chrome 120) — every desktop browser and modern TV** →
  early-return: no fetch, `<script src>` untouched, nothing written to
  localStorage. (Scenario 2.)

The hosted bootstrap (`boot-shell.src.js`) applies the **same** legacy gate, the
**same** `BUNDLE_CACHE_KEY`, the same 3 MB body cap, and the same patcher
recovery contract (verified in `.cjs` PART 4).

## (B) The serverId=null patch

`buildBundleSourcePatcher()` targets the exact minified shape QA found in
`main.jellyfin.bundle.js` (JEL-537) and matches the single-check
(`function(e){if(!e)throw…}`), legacy double-check (`if(!e||!e.ServerId)`), and
arrow forms. The replacement injects three recoveries before the original
throw: null item → return `window.ApiClient`; object missing `ServerId` → inject
`window.ApiClient.serverId()`; otherwise the original throw still fires. The
patcher is only ever invoked after an `indexOf("item or serverId cannot be
null") < 0` pre-check, so unmatched bundles cost no regex pass and record a
`needsPatch:false` verdict.

## (C) The `BUNDLE_CACHE_KEY` state cache & warm boot

`writeBundlePatchState()` always persists `{v, url, needsPatch}`; it adds `body`
(and `patches` when patched) only when `body.length <= 3 MB`. On a quota throw it
retries body-less and flags `window.__shellMainBundleQuotaErr`. `v` is the shell
version (`__SHELL_VER__` token → `1.0.73` in `shell.min.js`), so any release that
touches the patcher auto-invalidates the cache; `readBundlePatchState()` returns
`null` on a `v` mismatch or corrupt JSON.

On warm boot, when `cache.url === url` and a `</script`-free body is present, the
shell inlines it (`textContent`), strips `src`/`defer`/`async`/`type`, tags
`data-shell-bundle-from-cache="1"`, and skips both the fetch and the regex scan
(Scenario 3: fetched=0, cache-body-hit, patch count carried over from the cached
record). The string-fast-path mirrors the same inline at the document layer.

## Documented divergence (not a parity break)

- The hosted bootstrap **additionally** caches the `vendors.*.bundle.js` body
  under a separate `jellyfin.shell.vendorsBundlePatchState` key — an additive
  optimisation absent from `shell.js`. It does not affect the main-bundle
  serverId fix or its cache key.
- `boot-shell.src.js` pins `BUNDLE_CACHE_VER` to a literal release string while
  `shell.js` carries the `__SHELL_VER__` build token; both bust the cache on a
  release change.

## How to reproduce

```
node tooling/tv-validate/bundle-patch/verify-bundle-patch.mjs   # 17/17 runtime
node packages/shell-tizen/scripts/bundle-patch.test.cjs          # 47/47 static
```

The `.cjs` guard also runs via `pnpm --filter @jellyfin-tv/shell-tizen test`.
