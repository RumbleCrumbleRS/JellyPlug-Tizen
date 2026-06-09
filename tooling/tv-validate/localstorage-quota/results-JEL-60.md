# JEL-60 — Compare: localStorage quota handling (graceful degradation on a full store) — TV vs browser

**Verdict: graceful degradation confirmed — no shell defect. 70/70 checks pass on both shells.**

A genuinely full localStorage is a realistic on-TV state: after several power-
cycles the shell's own bundle-body cache (≈200 KB–2.5 MB per blob) plus the
`/web/` index/config bodies push the per-origin store toward Tizen WebKit's ~5 MB
ceiling, and a `QuotaExceededError` on `setItem` is then expected — not
exceptional. The shell is built to survive it: every persistence write degrades
to a smaller write or a silent skip, and **no write path can throw out to the
boot sequence**. The harness
(`packages/shell-tizen/scripts/localstorage-quota.test.cjs`) proves all four
required behaviours by lifting the **shipped** persistence functions verbatim out
of each shell and running them against a fake `localStorage` that models a full
store: `setItem` throws `QuotaExceededError` once a byte budget is exceeded, while
`getItem`/`removeItem` keep working (so a prune frees real space).

## The four required behaviours (each proven behaviourally + by source)

| #   | Behaviour                                                                                      | What the shell does                                                                                                                                                                                              | Proof                          |
| --- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| 1   | **Bundle body cache** falls back to `{url, needsPatch}` without body, no crash                 | `writeBundlePatchState()` tries the full record (incl. patched body); on quota it sets `window.__shellMainBundleQuotaErr=1`, then `delete rec.body; delete rec.patches` and retries the tiny verdict-only record | Behaviour [1] + source B1      |
| 2   | **Transpile cache** calls `__txPrune()` to evict the **10 oldest LRU** entries before retrying | `__txSet()` catch → `__txPrune()` (sort LRU map by timestamp asc, `removeItem` the first `Math.min(n,10)`, persist the trimmed map) → retry `setItem`                                                            | Behaviour [2]/[2b] + source B2 |
| 3   | **Web index/config cache** silently skips the write                                            | `writeWebIndexCache()` / `writeWebConfigCache()` wrap `setItem` in `try { … } catch (_) {}` — no flag, no retry, no throw                                                                                        | Behaviour [3] + source B3      |
| 4   | **Server URL** still saves (smaller write)                                                     | `saveServerUrl()` is a ~25-byte write wrapped non-fatally; it fits headroom the multi-hundred-KB caches cannot                                                                                                   | Behaviour [4] + source B4      |

### Behaviour 1 — bundle body fallback

With a store too full for the ~200 KB body record but with room for a bodyless
one, `writeBundlePatchState()` does **not** throw, flags
`__shellMainBundleQuotaErr=1`, and persists `{v, url, needsPatch}` with **no
`body` and no `patches`**. On the next boot that record still short-circuits the
URL match while forcing a fetch/scan for the body — the warm-boot verdict
survives the quota. On a healthy store the same call **does** cache the body, so
the degradation is quota-only (not a regression of the fast path).

### Behaviour 2 — transpile LRU prune

Seeded with 12 cached transpiles (`k01` oldest … `k12` newest) and then driven
into quota, `__txSet()` of a fresh chunk evicts **exactly `k01..k10`** (the 10
oldest), leaves `k11`/`k12`, drops the evicted keys from the LRU map, and lands
the fresh entry after the prune frees space — leaving 3 `shell.tx*` entries. With
fewer than 10 entries present, `__txPrune()` clears `min(N,10)` = all of them.

### Behaviour 3 — index/config silent skip

On a store where nothing large fits, both `/web/` body writes return without
throwing and store **nothing**. There is no flag and no retry by design: the
`/web/` cache is a pure stale-while-revalidate optimization (JEL-57), so a missed
write simply means the next boot fetches over the network — correct degradation.

### Behaviour 4 — server URL still saves

On a near-full store with ~100 bytes of headroom, the ~49-byte
`jellyfin.shell.serverUrl` write **succeeds and round-trips**, while the big index
and bundle writes degrade (skip / bodyless). The connection that lets the app
reach the server is the most important state to preserve, and it is the cheapest
to write — so it wins the last bytes of quota.

### Bonus — localStorage entirely dead

With every `localStorage` op throwing (private-mode / disabled storage), **no
persistence call throws** and all readers degrade to `null`/`""`. The app boots
and runs without any persistence at all.

## Why this is a complete TV-vs-browser parity proof

Every degradation path uses only `localStorage`, `JSON`, `Date.now()` and
`window`; **none branch on `tizen`/`webapis`** (asserted in source check B5). So a
real TV (where quota is actually hit) and a desktop browser running the same
shell degrade **identically by construction** — the behavioural proof above
therefore covers both. Both the source-of-record shells (`shell.js`,
`boot-shell.src.js`) and the deployed minified blobs (`shell.min.js`,
`boot-shell.min.js`) are checked, so the contract cannot silently drift (B6).

## Run

```
node packages/shell-tizen/scripts/localstorage-quota.test.cjs
# or: pnpm --filter @jellyfin-tv/shell-tizen test   (wired into the suite)
```

## On-device note

No physical-TV step is required: the proof is behavioural against the shipped
bytes and the degradation paths are device-agnostic. The on-TV quota state itself
is observable in the shell diag string (`q=<n>` =
`window.__shellMainBundleQuotaErr`) for QA spot-checks if desired.
