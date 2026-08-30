# JELA-732 — a private cache over `/HomeScreen/Section/{name}`

The Home Screen Sections plugin's row-**contents** endpoint answers with no
`Cache-Control` and no `ETag`. The complete live header set, before this change:

```
HTTP/2 200
content-type: application/json; charset=utf-8
x-response-time-ms: 347.2884
```

So every home load — every boot, every navigation back to home, every TV —
rebuilds every row from scratch. Measured server-side on the live origin
(JELA-730, two cold boots): `LatestShows` 636 / 1,063 ms,
`ContinueWatchingNextUp` 330 / 608 ms, `LatestMovies` 300 / 389 ms,
`BecauseYouWatched` ~125 ms — **1.4-2.2 s of query CPU per home load**, and
because the rows are issued concurrently the wall clock is the slowest of them.

A repeat is far cheaper than a first build (`LatestShows` 2,843 ms then
284/317/289/297 ms), which is the shape a cache is for. That warm window is
Jellyfin's own query/SQLite page cache, **not** a response cache — JELA-693
established that the bodies come back distinct every time, so a warm window is
not a cache and cannot be relied on.

**This is not the endpoint JELA-693/JELA-703 fixed.** Those covered
`/HomeScreen/Sections`, the section _list_. The section _contents_ were
explicitly out of scope there and stayed live. The trailing slash in the route
prefix (`/HomeScreen/Section/`) is what keeps the two apart, and it is pinned by
a test.

## What ships

`HomeScreenSectionCacheStartupFilter` — an `IStartupFilter`, the only
order-independent hook a Jellyfin plugin has into another component's pipeline
(JELA-709). It needs no fork of a third-party plugin we do not ship.

Two levers on one TTL (`HomeScreenSectionCacheSeconds`, default 30):

| lever                                                    | what it saves                                                                                                          |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| server-side memo (`HomeScreenSectionCache`)              | the whole rebuild — a repeat never re-runs the query                                                                   |
| `Cache-Control: private, max-age=TTL` + body-hash `ETag` | the request itself on a second boot inside the window; a revalidation that does happen costs a 304, not a rebuilt body |

Operator switches, all read **per request** (no restart):
`HomeScreenSectionCacheSeconds` (0 = off), `HomeScreenSectionCacheServerOnly`
(keep the memo, make TVs revalidate), `DisableHomeScreenSectionCache` (full
kill). All three are on the plugin's dashboard page.

## The constraints this had to satisfy

Straight from the JELA-693 post-mortem on the sibling cache in that same
plugin, where all four of these were defects:

1. **The ETag is a hash of the body.** JELA-693's root cause was a cache key
   (`Guid.NewGuid()`) that could never match, i.e. a cache that was never read.
2. **`no-store` is never shipped alongside it** — it would make the ETag inert.
3. **Reads are credential-scoped.** The upstream sections cache is keyed by
   hash alone and never compares `userId`. Here the key covers method + path +
   query + the caller's API token + `Origin`, so a stored body can only ever be
   replayed to the exact credential that already received it with a 200. A
   different credential is a different key and takes the normal authenticated
   path, so nothing here can widen an authorization decision.
4. **Entries expire and the store is bounded.** Upstream's grows without limit
   and its `LastAccessed` field is written and never read. Here every insert
   prunes what has expired and drops the oldest entry at `MaxEntries`.

Freshness: `ContinueWatchingNextUp` is the one row where a stale answer is
user-visible (resume position). 30 s is the ceiling that needs no invalidation
hook; going longer wants a real "watched" invalidator first.

## What being outermost costs, and how it is paid

First-registered startup filter is outermost, so this middleware sits _outside_
Jellyfin's routing, auth, CORS and response-time middleware. Three consequences,
each handled and each pinned by a test:

- **CORS.** A hit short-circuits before Jellyfin's CORS middleware, so the
  filter captures `Access-Control-Allow-Origin` / `-Allow-Credentials` /
  `-Expose-Headers` on the miss and replays them on the hit. `Origin` is part of
  the key, so the replay is exact rather than approximate. Every cacheable body
  also gets `Vary: Origin` (JELA-688 shipped that bug once).

  **The capture must happen in an `OnStarting` callback, not after `next()`
  returns.** ASP.NET Core's CORS middleware does not write `Access-Control-*`
  inline — it registers an `OnStarting` callback and stamps them when the
  response actually begins. This filter buffers the body and the compression
  filter outside it buffers again, so the response has _not_ started when
  `next()` returns; header reads there see no CORS headers at all. JELA-732
  shipped that read and captured `AllowOrigin = null` on every entry, so every
  hit replayed nothing: measured on prod 1.0.37.0, a section cache hit came back
  with **no ACAO**, and a real M63 fetch from `Origin: null` — the shell's own
  request shape — failed with `Failed to fetch` while CDP showed a clean `200`
  (the JELA-687 divergence). JELA-794 moved the capture and the store into an
  `OnStarting` callback registered _before_ the inner pipeline runs; callbacks
  fire in reverse registration order, so it sees the finished header set.

  Correctness does not rest on that ordering argument. A cross-origin request
  whose ACAO could not be captured is **not stored** — a miss costs a rebuild, a
  hit that replays no ACAO is a dead row on every TV.

  `Vary: Origin` is unconditional, including on responses that carry no ACAO.
  M63 does not partition its HTTP cache by request mode (JELA-687), so the
  dangerous direction is the one the old ACAO-gated check missed: an entry
  stored for a request that sent no `Origin` carries no CORS headers and gets
  replayed into a later cross-origin fetch, which then fails for a body the
  server would have allowed.

- **`x-response-time-ms`.** Jellyfin's writer is inside and never runs on a
  short-circuit, so a hit emits its own. Without it every hit would vanish from
  the timing census that this work is measured by.
- **Auth.** Handled by the credential key above.

Not stored: anything that is not a 200 JSON body, anything carrying
`Set-Cookie`, anything already content-encoded (compression runs outside this
filter, so the store holds identity bytes), and anything over
`MaxBodyBytes`. A request that sends `Cache-Control: no-store` bypasses the
cache entirely.

Residual, bounded staleness: a token revoked mid-TTL keeps reading its own
already-authorized rows for up to the TTL. That is the same window any HTTP
client gets from `private, max-age=30`, and it is why the TTL is short and
operator-tunable.

## Verification

- `packages/server-plugin/scripts/hss-section-cache.test.cjs` — source pins in
  repo CI (the C# plugin is not compiled in this repo's node CI). Each pin
  guards a defect that actually shipped once, here or upstream.
- Pipeline proof: a scratch Kestrel host that registers the real services
  through `PluginServiceRegistrator` and runs the real filter over real HTTP
  against a fake downstream — 48/48 checks, including byte-identical repeat in
  **3.9 ms end-to-end / 1.88 ms server-side** against a 300 ms build, 304 on
  `If-None-Match`, per-credential isolation, TTL expiry serving fresh bytes,
  both kill switches, 500s never memoized, and the bounded store. Controller
  instantiation cannot exercise pipeline order, which is the whole point of this
  filter; JEL-141 bars the harness itself from `tooling/`, so it lives in the
  JELA-732 issue thread.
- Prod acceptance of the **server memo** half — JELA-733, on the JELA-112 rig:
  `X-JellyPlug-Section-Cache: hit`, byte-identical bodies 15/15, −1,278 ms of
  server work removed from a second boot.

### Panel acceptance of the CLIENT half (JELA-794, Q60R, 2026-08-29)

The rig cannot test HTTP caching at all (JELA-689), so the `private, max-age=TTL`
half was unproven until it ran on the real Tizen 5.0 panel over sdb + CDP.
Gate on `Network.responseReceived.fromDiskCache`; `requestServedFromCache` never
fires on M63.

**The TV does replay section responses from its own cache across an app restart.**
Same four section urls, cache cleared in boot A, app closed and relaunched, then
re-requested ~21 s later:

|                                                    | boot A (cache cleared)                | boot B (after restart)                              |
| -------------------------------------------------- | ------------------------------------- | --------------------------------------------------- |
| `/HomeScreen/Section/*` ×4                         | `fromDiskCache=false`, 2,779–3,459 ms | **`fromDiskCache=true`, 19–25 ms, 0 B on the wire** |
| `/web/*.bundle.js` (positive control, `immutable`) | network                               | `fromDiskCache=true`                                |
| `/web/index.html` (negative control, `no-store`)   | network                               | network                                             |

A natural SPA boot reproduces it unassisted: 2 of 5 section requests came back
`fromDiskCache` with `encodedDataLength=0`.

**Staleness cannot outlive the TTL on the device.** Resume position mutated
server-side, then the same url polled from the panel: the panel served the stale
body from its client cache for 27.1 s and picked up the change at **31.8 s**
against a 30 s `max-age` — one TTL, not two. `HomeScreenSectionCacheServerOnly`
is therefore not needed.

**Cache-key trap.** The client cache only hits when boot N+1 requests a
**byte-identical url**. The shell's queryAuth rewrite appends `&api_key=<token>`,
so a replay that omits it is a different key and reads as a false
"the TV did not cache" null. Reproduce the shell's exact url, not just its path.
