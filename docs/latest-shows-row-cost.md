# Why the "Latest Shows" home row costs 21x the "Latest Movies" row

**JELA-731.** Measured against production 2026-08-25, JELA-692 pre-flight CLEAR
before and after every number below.

## Symptom

The home rows land one at a time and the card count does not settle until
8.6–9.0 s, against a healthy 2.26 s `firstCard`. The four
`/HomeScreen/Section/*` requests are issued concurrently at ~2.0 s, so the wall
clock of the home is set by the slowest of them, and the slowest is always
`LatestShows`:

| section (cold boot 2)    | issued |  returned | `x-response-time-ms` |
| ------------------------ | -----: | --------: | -------------------: |
| `BecauseYouWatched`      |  2,027 |     2,168 |                122.6 |
| `LatestMovies`           |  2,028 |     3,859 |                388.5 |
| `ContinueWatchingNextUp` |  2,028 |     6,162 |                608.3 |
| **`LatestShows`**        |  2,027 | **6,183** |          **1,062.7** |

## Root cause: a 30-day sliding window walked one month at a time

`Jellyfin.Plugin.HomeScreenSections`, `LatestShowsSection.GetResults`:

```csharp
DateTime currentDate = DateTime.Now;
DateTime stopDate = DateTime.Parse("01/01/1925");
do {
    var mainQuery = folders.Select(x => folder.GetItems(new InternalItemsQuery(user) {
        IncludeItemTypes = new[] { BaseItemKind.Episode },
        OrderBy         = new[] { (ItemSortBy.PremiereDate, SortOrder.Descending) },
        Limit           = 200,
        Recursive       = true,
        MaxPremiereDate = currentDate,
        MinPremiereDate = currentDate.Subtract(TimeSpan.FromDays(dayIncrement)),  // 30 days
        EnableTotalRecordCount = true                                             // asked for, discarded
    }));
    // ... group the window's episodes by series, accumulate ...
    if (selectedSeries.Count >= 16) continueSearching = false;
    currentDate = currentDate.Subtract(TimeSpan.FromDays(dayIncrement));
} while (continueSearching);
```

The loop starts at today and walks backwards **one 30-day window per
iteration**, running one episode query per TV library per window, until 16
distinct series have accumulated. Nothing widens the window; the only escape is
the year 1925.

So the cost is not a property of how big the library is — it is a property of
**how far back you have to go to find 16 series with a new episode**. A library
whose recent months are thin pays one round of queries per 30 days of quiet.

Replaying the loop against production (`window-walk` simulation, one HTTP
request per window per library):

```
iter  1: series= 1   back to 2026-07-26
iter  3: series= 2   back to 2026-05-27
iter 10: series= 6   back to 2025-10-29
iter 20: series=15   back to 2025-01-02
iter 27: series=16   back to 2024-06-06     <- stops here
```

**27 windows x 2 TV libraries = 54 queries, 1,166 ms of cumulative server time**
to produce a row of 16 titles. The Movies row runs the same loop over dense
recent premiere dates, stops in a handful of windows, and comes back in 36 ms.
That is the whole of the ~21x gap.

`EnableTotalRecordCount = true` doubles it: every one of those 54 queries also
pays a full count pass over its filtered set, and the count is never read.

### The correction this makes to the original ticket

JELA-731 was filed against `Users/{u}/Items/Latest?IncludeItemTypes=Series`, and
concluded that the cost "tracks the EPISODE count" at ~0.4 ms/episode, so it
would grow with the library. That endpoint is a different code path — the
section does not call it. The real driver is premiere-date _sparsity_, not
episode count, and adding episodes to recent months makes the section **faster**,
not slower. The remedies the ticket proposed still stand; the reason does not.

For the record, `Users/{u}/Items/Latest?IncludeItemTypes=Series` is itself
redundant: it returns the same 16 titles, in the same order, as a plain
`Items?IncludeItemTypes=Series&SortBy=DateCreated&SortOrder=Descending`, for
2,170 ms against 496 ms. That is worth an upstream report of its own; it is not
on this path.

## Fix: the windows are wasted work

The row is defined entirely by the top-N episodes by premiere date. So take
them in one ordered query per library, group by series, keep the 16 with the
newest episode — which is what `LatestShowsFastPath` does, behind
`LatestShowsFastPathStartupFilter` (`IStartupFilter`, the same hook JELA-709 /
714 / 722 use to reach routes this plugin does not own).

Interleaved, n=7, warm box, pre-flight CLEAR:

| arm                                            |      median |   min |   max |
| ---------------------------------------------- | ----------: | ----: | ----: |
| `HomeScreen/Section/LatestShows` (window walk) |    293.7 ms | 273.6 | 842.2 |
| `HomeScreen/Section/LatestMovies` (control)    |     60.7 ms |  59.3 | 368.2 |
| one ordered query x 2 TV libraries             | **48.1 ms** |  43.0 | 209.2 |

The 48.1 ms arm is measured over HTTP and therefore _includes_ building and
serializing 400 episode DTOs that the in-process path never materializes.

**Row parity.** The fast path returns the same 16 titles in the same order as
the live section — verified against production before the change:

```
Lioness | The Bear | Gold Rush | The Pitt | South Park | Tulsa King | 99 to Beat |
Alice in Borderland | Alone | Destination X | Severance | Invincible | Tehran |
I Love Lucy | Home Improvement | Bridgerton
```

The result is stable as the episode probe grows (200 → 400 → 800 → 1,600), so
the initial 200 is not load-bearing for correctness; the fast path doubles it
anyway when a library's first page yields fewer than 16 series.

## What it deliberately does not do

- **It does not cache.** There is no TTL and no stored body, so it cannot serve
  a stale "Latest" row. Response caching for `/HomeScreen/Section/*` is
  JELA-732, and layers on top of this rather than fighting it.
- **It does not model `HideWatchedItems`.** That section setting flips upstream
  to `IsPlayed = false`. When it is on — or cannot be read at all, because Home
  Screen Sections is absent or its config shape moved — the fast path steps
  aside and the real section serves the request.
- **It does not widen access.** The upstream route is `[Authorize]` and then
  trusts whatever `UserId` the caller passes. The fast path answers only for the
  caller's own user (or a server-wide API key) and hands every other shape back
  to the route that owns it.

Anything unexpected — missing services, an unresolvable user, any exception —
falls through to Home Screen Sections. Nothing is written to the response until
the whole body exists, so the fallback is always a clean one. The failure mode
is today's latency, never a wrong row. Operator override:
**Disable the Latest Shows fast path** on the plugin's settings page.

## Upstream

The window walk is an upstream defect and affects every Home Screen Sections
install, not just this one. Two changes would fix it there:

1. Drop `EnableTotalRecordCount = true` from both `LatestSectionBase` and
   `LatestShowsSection` — the count is never read.
2. Replace the fixed 30-day increment with a single ordered query (or, minimally,
   grow `dayIncrement` geometrically: 27 windows becomes ~5).

Related: `docs/hss-sections-cache-diagnosis.md` (the sibling
`/HomeScreen/Sections` cache defect, upstream `home-sections#269`),
`docs/perf-measurement-protocol.md` (the pre-flight gate every number here is
taken behind).
