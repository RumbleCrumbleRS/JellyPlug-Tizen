# Upstream report — `IAmParadox27/jellyfin-plugin-home-sections`

**Status: FILED 2026-08-24 with CEO sign-off (JELA-693) as
<https://github.com/IAmParadox27/jellyfin-plugin-home-sections/issues/269>.** The text
below is the report as filed.

Verified against tag `2.5.11.0` (our installed version) and `HEAD` (`dcf2484`) — all three
defects are present in both.

---

## Title

`/HomeScreen/Sections` cache is unreachable when `pageHash` is omitted — guaranteed miss, plus an unbounded leak

## Body

Hi — while profiling a Jellyfin server we traced multi-second `/HomeScreen/Sections`
response times to the section cache never being read. I think there are three separate
issues here; happy to split them if you'd prefer.

### 1. Omitting `pageHash` mints a fresh key, so the lookup can never hit

`HomeScreenSectionService.MonitorLiveUpdatedSectionsForUser`:

```csharp
if (pageHash == null)
{
    pageHash = Guid.NewGuid();                    // brand-new key
    CacheSectionsForUser(userId, pageHash.Value); // therefore always a full build
    ...
}
```

A `Guid.NewGuid()` key cannot match anything already in `UserSectionsDataCache.Cache`, so
every request that omits `pageHash` pays a full section build.

This is not an edge case — it is the default path. `PageHash` is only sent when pagination
is enabled:

- `HomeScreenController.cs:206` — `PaginationEnabled = cfg.LazyLoadEnabled`
- `loadSections.js:474` — `getSectionsData.PageHash` is set only inside
  `if (window.HssPageMeta.UsePagination)`

So on any server with `LazyLoadEnabled: false`, **the plugin's own web client never sends
`PageHash`**, and every home load rebuilds every section from scratch. On our server that
is a measured **0.3-6.5 s of server CPU per home load, per user**, for a ~4 KB response
(times are the server's own `x-response-time-ms`, measured with the box otherwise idle —
`/System/Info` sat at ~1 ms throughout).

Confirming it is the key and not the cache: pinning one `pageHash` across repeated
requests 20 s apart, against a fresh `pageHash` per request, interleaved, n=12 per arm
(server's own `x-response-time-ms`, box idle):

| arm | min | median | max | response body |
|---|---:|---:|---:|---|
| pinned `pageHash` | 1 ms | **4 ms** | 20 ms | byte-identical |
| fresh `pageHash` | 530 ms | **2,943 ms** | 8,563 ms | all distinct |

No overlap between the arms. The cache itself works perfectly — it just never gets a key it
can find on the default path. (Entries also survived four consecutive 20 s gaps unchanged,
so nothing is expiring or invalidating them.)

### 2. Unreachable entries are still stored, and nothing ever evicts them

Those guaranteed-miss requests still execute
`m_dataCache.Cache.TryAdd(pageHash.Value, userSectionsData)`, storing a complete section set
under a key no client will ever present again.

There is no `TryRemove`, no `Clear`, and no cleanup task anywhere for
`UserSectionsDataCache.Cache`. (`ImageCacheService` has all of these — this cache has none.)

`UserSectionsData.LastAccessed` is assigned in `GetCachedSectionsForUser` but is **never
read anywhere in the codebase**, which suggests the intended time-based eviction was never
implemented.

Net effect: one permanently unreachable entry leaked per home load, growing until restart.

### 3. Cached entries are not scoped to the user who created them

`GetCachedSectionsForUser(Guid userId, string? language, int page, int pageSize, Guid pageHash)`
accepts `userId` but never compares it with the stored `userSectionsData.UserId` — the
lookup is by `pageHash` alone.

Since `PageHash` is a client-supplied query parameter, two authenticated users who present
the same value will share a section list. Random Guids make this unlikely to happen by
accident, but it also means a client cannot safely pin a `pageHash` without deriving it
per-user, and a deliberately chosen constant would cross user boundaries.

### Possible direction

For (1), deriving the default key from something stable and user-scoped — rather than
`Guid.NewGuid()` — would let the existing cache actually serve repeat requests. That would
need (2) to land alongside it (otherwise entries become permanently stale) and (3) to make
it safe.

I'm not sending a PR blind since the caching semantics are yours to decide — particularly
how long a section list *should* stay warm, given sections are intentionally shuffled per
page load. Happy to put one together if a direction sounds right.

### Environment

- Plugin `2.5.11.0`; also confirmed by reading `HEAD` (`dcf2484`)
- Jellyfin `10.11.11`, Linux x64
- Relevant config: `LazyLoadEnabled: false`, `NumSectionsPerPage: 10`,
  `CacheTimeoutSeconds: 86400`, `DeveloperMode: false`

Thanks for the plugin — this is meant as a useful bug report, not a complaint.
