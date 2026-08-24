# `/HomeScreen/Sections` — why the cache never helps

**JELA-693.** Diagnosis of `Jellyfin.Plugin.HomeScreenSections` **2.5.11.0** (the version
installed on our server), read from upstream source at tag `2.5.11.0`. All three defects
below are still present at upstream `HEAD` (`dcf2484`).

This supersedes the framing in JELA-685 and in JELA-693's own description. Both said HSS
cache entries were *"invalidated within 30 seconds despite `CacheTimeoutSeconds=86400`"*.
That is wrong twice over: `CacheTimeoutSeconds` does not govern this endpoint, and nothing
is invalidating anything. The cache is simply never read.

---

## 1. `CacheTimeoutSeconds` has nothing to do with `/HomeScreen/Sections`

It is referenced in exactly three places in the plugin, and none of them is the Sections
endpoint:

| site | effect |
|---|---|
| `HomeScreenController.SetCacheHeaders()` | `Cache-Control` **response header** on `home-screen-sections.js` / `.css` |
| `HomeScreenController.GetCachedImage()` | same header on `CachedImage/{cacheKey}` |
| `ImageCacheHelper` | timeout for the **image** cache |

`GetHomeScreenSections` — the `[HttpGet("Sections")]` action — never calls
`SetCacheHeaders()`. Confirmed against the live server: the response carries no
`Cache-Control` and no `ETag`.

So the config value everyone was reasoning about was always inert here. There was no
86,400-second promise to break.

## 2. The real cache is keyed by a value that is freshly randomised per request

There *is* a server-side cache: `UserSectionsDataCache.Cache`, a
`ConcurrentDictionary<Guid, UserSectionsData>` keyed by `pageHash`. Every request we make
takes this path (`HomeScreenSectionService.cs:87-97`):

```csharp
if (pageHash == null)
{
    pageHash = Guid.NewGuid();                    // a key nothing can ever have stored
    CacheSectionsForUser(userId, pageHash.Value); // so this is always a full cold build
    int totalSectionCount = m_dataCache.Cache[pageHash.Value].OrderedSections.SelectMany(x => x.Value).Count();
    return GetCachedSectionsForUser(userId, language, 1, totalSectionCount, pageHash.Value);
}
```

When the caller omits `pageHash`, the plugin **mints a brand-new random `Guid` as the cache
key**. A `Guid.NewGuid()` cannot match a stored entry, so the lookup misses **100% of the
time, permanently**. Not invalidated — never read.

The cache was only ever designed to serve *pagination within a single page load*: the
plugin's own client mints one `uuidv4()` per page load and replays it for pages 2, 3, …
It was never a cross-request or cross-boot cache, so there is nothing here to "pre-warm".

**And on this server even that never engages**, because `PageHash` is only sent when
pagination is on:

- our config: `LazyLoadEnabled: false`
- `HomeScreenController.cs:206` — `PaginationEnabled = cfg.LazyLoadEnabled`
- `loadSections.js:474` — `PageHash` is attached only `if (window.HssPageMeta.UsePagination)`

Our Tizen shell (`packages/shell-tizen/src/shell.js:3856`) sends no `pageHash` either. So
every home load, for every user, on both clients, pays a full section build.

This also explains an observation JELA-685 recorded but could not place: three back-to-back
requests returned **3636 / 3913 / 3637 bytes with three different SHA-256 digests**. A
response cache must return identical bytes. These differ because each request is an
independent build and sections are deliberately shuffled (`ConcurrentBag ... // we want
these randomly distributed among each other`).

## 3. Every doomed request still leaks an entry, and nothing evicts

Each of those guaranteed-miss requests still does `Cache.TryAdd(pageHash, userSectionsData)`
(`:176`), storing a full section set under a key no one will ever present again.

Across the whole plugin there is **no `TryRemove`, no `Clear`, and no cleanup task** for
this dictionary. The image cache has all three; this one has none.
`UserSectionsData.LastAccessed` is *written* at `:42` and **never read anywhere** — the
eviction it was meant to drive was never implemented.

Net: one permanently unreachable entry leaked per home load, bounded only by server restarts.

## 4. Cache reads are not scoped to the user who built the entry

`GetCachedSectionsForUser(Guid userId, …, Guid pageHash)` takes `userId` but **never
compares it** to the stored `userSectionsData.UserId`. The lookup is purely by `pageHash`.

Today this is unexploitable by accident, because keys are random Guids. But `PageHash` is a
client-supplied query parameter, so two authenticated users who present the same value get
whichever section list was built first. It also constrains any fix: **a client-side pinned
`pageHash` must be unique per user**, or users cross-contaminate.

---

## What the endpoint actually costs on a quiet box

Measured with `tooling/perf/hss-decay-probe.py` after `tooling/perf/preflight.sh` returned
**CLEAR** (all tasks Idle, `/System/Info` median **1.14 ms**, harness load 5.63/6). Gaps
shuffled; a `/System/Info` control sampled beside every datum.

The control sat at **~1.0-1.7 ms** throughout while Sections hits ran **0.3-6.5 s**. That
retires the ticket's headline numbers: the 5,725 / 11,577 / 14,457 / 16,097 ms readings were
taken through the Intro Skipper backfill (JELA-692), not off the endpoint. **On a quiet
server this endpoint costs roughly 0.3-6.5 s, not 5-16 s.**

Two things in that data matter, and they point in different directions — both are reported
because the second one is easy to mistake for a working cache.

**There is no response cache.** The `immediate` column is a re-hit issued with *zero* gap,
which a working cache would serve as a hit. Its median is **1,192 ms** (range 322-1,764) —
never hit-shaped. And across all 48 requests the probe recorded **48 distinct body hashes**.
A response cache must return identical bytes. This is exactly what `Guid.NewGuid()` predicts.

**But there is a real warm effect, and it is not HSS's.** Gap length does correlate with
cost: Spearman **rho = 0.659 (n=16)**, short gaps (<=10 s) median **780 ms** against long
gaps (>=20 s) median **3,519 ms**. So JELA-685's "warm window under 30 s" was a real
observation — its *attribution* was wrong. It cannot be the HSS section cache, which is
provably unreachable on this path and which returns different bytes every time. It is the
layer underneath: Jellyfin's own query results and the SQLite page cache staying warm for
about ten seconds. Nothing in HSS's configuration reaches it, which is why no tunable ever
moved this number.

(`rho(control, after-gap) = 0.397` — even on a pre-flighted box some of the spread still
tracks server state, so treat single readings here as soft.)

**The decisive test.** `hss-pagehash-probe.py` pins one `pageHash` (arm `SAME`) against a
fresh one per request (arm `DIFF`), 20 s between hits — past the alleged invalidation
window — with the arms **interleaved** so drift cannot favour either. Repeats only, prime
excluded, n=12 per arm:

| arm | min | median | max | body SHA |
|---|---:|---:|---:|---|
| `SAME` (pinned `pageHash`) | 1 ms | **4 ms** | 20 ms | identical within each cycle |
| `DIFF` (fresh `pageHash`) | 530 ms | **2,943 ms** | 8,563 ms | all 12 distinct |

**Zero overlap** — the slowest `SAME` hit (20 ms) is faster than the fastest `DIFF` hit
(530 ms). That is a ~700x separation on the median.

Entries in the `SAME` arm survived four consecutive 20 s gaps (80 s per cycle) at 1-6 ms
with byte-identical bodies. **Nothing is invalidating anything.** The cache works exactly as
designed the moment it is given a key that can be found; supplying `Guid.NewGuid()` is the
entire defect.

Note also what `SAME` shows about staleness: the body stayed byte-identical for the whole
cycle. Since nothing evicts (§3), a permanently pinned hash means a permanently frozen
section list.

## Consequences for JELA-685 and JELA-693

- **JELA-693's AC1 — "cold hit under ~500 ms" — is unreachable by configuration**, and as
  literally worded it is unreachable at all: a genuinely cold build costs 0.9-6 s even with
  the cache working (the `prime` hits above), because someone must always pay for the first
  build. No setting tunes a cache that is never read. What *is* reachable is the goal behind
  the AC — repeat hits at 1-20 ms instead of seconds — via option 2 below.
- **JELA-685 was right to refuse to build the scheduled pre-warm**, though not for the
  reason it gave. The blocker is not that re-warming inside a sub-30 s window is
  unaffordable; it is that there is **no cross-request cache to warm at all**.
- **A fork is not required to understand or report this.** Whether one is required to *fix*
  it is a separate decision — see below.

## Options, with their real costs

1. **File upstream.** The evidence is strong and the defects are present at `HEAD`. Costs us
   nothing but does not schedule a fix. A draft report is at
   `docs/hss-upstream-report.md`.
2. **Client-side pinned `pageHash`** (no fork; lives entirely in our shell). Send a
   per-user-unique `PageHash` plus `Page`/`NumResultsPerPage` so requests take the caching
   branch. **Measured effect is large and certain: 2,943 ms -> 4 ms median, no overlap.**
   **Three hazards, also all real and also measured:**
   - entries are never evicted, so a permanently pinned hash serves a **permanently stale**
     section list until the server restarts. A time-bucketed hash
     (`uuid5(userId + hour)`) bounds staleness but still leaks one entry per user per bucket.
   - it pins section shuffling, which is a user-visible behaviour change.
   - on a miss the plugin spawns a thread and **`SpinWait`s the request thread** until the
     entry appears, which is worse than the inline path it replaces.
3. **Fork.** Last resort; the programme has held internals read-only. The actual fix is
   small — reuse a `userId`-derived key, honour `LastAccessed`, and scope reads by user —
   but it carries ongoing maintenance.

**Recommendation: (1) now, and treat (2) as a separate costed ticket rather than a quick
win.** The 700x speedup makes (2) tempting, but it is not free: it trades server CPU for a
frozen home screen, and the honest version needs a time-bucketed key plus a per-user
derivation to avoid §4. The measured cost on a quiet box (0.3-6.5 s, not the 5-16 s this
ticket quotes) also makes the server-health case weaker than it looked. Neither (2) nor (3)
should be funded as a firstCard win — JELA-685 settled that separately (rho = 0.145, n=17).

## Reproducing

```bash
tooling/perf/preflight.sh                     # must print CLEAR
tooling/perf/hss-decay-probe.py    --user <userId> --out decay.json
tooling/perf/hss-pagehash-probe.py --user <userId> --out pagehash.json
```

Neither probe emits a verdict; both emit rows with a control column. Read
`docs/perf-measurement-protocol.md` first.
