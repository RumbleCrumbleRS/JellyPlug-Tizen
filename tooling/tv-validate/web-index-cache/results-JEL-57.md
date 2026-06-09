# JEL-57 — Web index cache (stale-while-revalidate for `/web/index.html`): TV vs browser

**Question:** with the web cache gate enabled (`jellyfin.shell.indexCache='1'`),
does the shell (1) cache the fetched `/web/index.html` body on first boot,
(2) resolve it from cache on the second boot while revalidating in the
background, (3) invalidate on origin mismatch or shell version bump, and
(4) reject bodies `>256 KB` or `<1 KB` — and is all of this identical on the
Tizen TV vs a desktop browser?

**Verdict: all four invariants hold, and TV-vs-browser behaviour is identical by
construction.** The cache layer (`webCacheEnabled`, `readWebIndexCache`,
`writeWebIndexCache`, `readWebConfigCache`, `writeWebConfigCache`) plus the
stale-while-revalidate boot fork use only `localStorage`, `JSON`, `Date.now()`
and `fetch` — **none branch on `tizen`/`webapis`** — so the TV and a browser
running the same shell cache, read, invalidate and revalidate the same way.

Harness: [`packages/shell-tizen/scripts/web-index-cache.test.cjs`](../../../packages/shell-tizen/scripts/web-index-cache.test.cjs)
(`pnpm --filter @jellyfin-tv/shell-tizen test`). 73 checks, all green.

## How the cache works (JEL-1977 / JEL-1980 lineage)

Off by default. The gate `jellyfin.shell.indexCache` enables it only on the
exact string `'1'` — `'0'`, `'true'`, and unset all stay off, so QA is opt-in.

Boot fork (`loadRemoteClient`, both shells, lines ~3209 in `shell.js`):

```
cacheGateOn = webCacheEnabled()
cachedIndex = cacheGateOn ? readWebIndexCache(serverUrl) : null
cachedConfig = cacheGateOn ? readWebConfigCache(serverUrl) : null
indexCacheHit = !!(cachedIndex && cachedConfig)

if (indexCacheHit):                       # ── SECOND BOOT ──
   __shellIndexCacheHits++, __shellWebIndexCacheAdopted = 1
   revalStart = Date.now()
   indexFetch  → on text → writeWebIndexCache(serverUrl, txt)   # background revalidate
                          → __shellIndexCacheSavedMs = Date.now() - revalStart
   configFetch → on text → writeWebConfigCache(serverUrl, txt)

indexPromise  = indexCacheHit ? Promise.resolve(cachedIndex.body)   # immediate, no network wait
                              : indexFetch → text → writeWebIndexCache(...)  # ── FIRST BOOT records ──
configPromise = indexCacheHit ? Promise.resolve(cachedConfig.parsed)
                              : configFetch → text → writeWebConfigCache(...)
```

## Invariant-by-invariant

| #   | Invariant (JEL-57)                                                                           | Where                                                                            | Evidence (behavioural + source)                                                                                                                                                                                                                                                                                                     |
| --- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | First boot fetches `/web/index.html` and caches the body under `jellyfin.shell.webIndexHtml` | `writeWebIndexCache`; miss-path `indexPromise`                                   | Lifted `writeWebIndexCache(origin, html)` stores a record under the canonical key carrying the exact body, origin, and version. Source: miss path calls `writeWebIndexCache(serverUrl, txt)` (gated) on the fetched text.                                                                                                           |
| 2   | Second boot resolves index from cache immediately + fires background revalidation            | hit-path `Promise.resolve(cachedIndex.body)` + `indexFetch`→`writeWebIndexCache` | New closures over the same store read the cached body back (immediate resolve), and the source fork resolves from `Promise.resolve(cachedIndex.body)` while the in-flight fetch still drains into `writeWebIndexCache` for the next boot. Config is pre-parsed (`cachedConfig.parsed`).                                             |
| 3   | Origin mismatch **or** shell version bump invalidates                                        | `readWebIndexCache` (`p.origin !== serverOrigin`, `p.v !== WEB_CACHE_VER`)       | Reading a record written for `origin A` while booting `origin B` returns `null`; a record stamped with a different version returns `null`. Both force a fresh fetch.                                                                                                                                                                |
| 4   | Bodies `>256 KB` or `<1 KB` rejected                                                         | `writeWebIndexCache` (`length < 1024`, `length > 262144`)                        | `<1 KB` and `>256 KB` bodies are not written; a `262144`-byte cap is the LS-quota guard. Bonus guard: a valid-size body with no `<html` marker is also rejected (truncated/error response).                                                                                                                                         |
| +   | Cached boot saves measurable time                                                            | hit path skips network from the pre-`document.write` critical path               | The hit resolves `indexPromise`/`configPromise` synchronously from LS instead of awaiting the `/web/index.html` + `/web/config.json` RTT pair (200–500 ms on a cold TV HTTP cache). The delta is timed into `__shellIndexCacheSavedMs` and adoptions counted in `__shellIndexCacheHits` for on-device QA to read from the diag HUD. |

## TV vs browser: identical by construction

None of the five cache functions reference a Tizen-only global; the harness
extracts each function body and asserts no `tizen`/`webapis` token appears. The
boot fork's only platform-variable input is `fetch`, which is the same Web API
on Chromium-on-Tizen and a desktop browser. So the four invariants above are
proven once and hold on both platforms.

## Two shells, one contract

Both the retail **bootstrap** (`boot-shell.src.js` / `.min.js`) and the full
**shell** (`shell.js` / `.min.js`) carry the same cache layer; the harness runs
the lifted functions from both source-of-record files and source-checks all
four blobs for the gate flag, cache key, and 256 KB cap so the deployed
minified artifacts cannot silently drift.

## Observation (informational, not a failure)

Each shell stamps cache records with its own `WEB_CACHE_VER` (its widget
version): `shell.js` carries the build-time placeholder `__SHELL_VER__`
(substituted by `build_shell_min.py`), `shell.min.js` is `1.0.73`, and both
bootstrap blobs are `1.0.87`. This per-shell version is **by design**: a single
device boots exactly one shell, and a cross-shell swap (or any version bump)
simply invalidates the cache and triggers a fresh fetch — the conservative,
correct behaviour (this is invariant 3b doing its job, not a bug).

## Status

Verification only — no shell behaviour was changed. The gate remains **off by
default**; this harness is the parity smoke that must pass before flipping
`jellyfin.shell.indexCache='1'` in a release. Added to the package `test`
script so it runs in CI alongside the other shell contract tests.
