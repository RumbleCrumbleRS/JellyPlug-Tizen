# Upstream report — `IAmParadox27/jellyfin-plugin-home-sections`

**Status: DRAFT (JELA-734).** Awaiting CEO confirmation before filing. On accept, file
against `IAmParadox27/jellyfin-plugin-home-sections` and flip this header to FILED with the
issue link, exactly as `docs/imageloader-worker-upstream-report.md` (JELA-701) was.

Verified by reading `main` at `dcf2484838ced76585499c767fae6451fff6f80e` (2026-06-28, the
current head). Every measurement below was taken against our production server
(Jellyfin `10.11.11`) on 2026-08-25 with the JELA-692 pre-flight gate CLEAR before and
after. Local evidence: `docs/latest-shows-row-cost.md` (JELA-731, the measurement and the
workaround we shipped).

---

## Title

The `Latest*` sections walk backwards through time in fixed 30-day windows — cost scales
with premiere-date sparsity, and a library with fewer than 16 eligible items walks all
1,237 windows

## Body

### Summary

`LatestShowsSection.GetResults` and `LatestSectionBase.GetResults` build their row by
looping backwards from `DateTime.Now` in fixed 30-day windows, issuing **one item query per
library per window**, until 16 distinct results have accumulated. The window never widens,
and the only other exit is a hard stop date — the year 1925 for shows, 1887 for everything
that inherits `LatestSectionBase`.

That makes the cost of the row a function of **how sparse the premiere dates are**, not of
how big the library is. Two consequences:

1. On a normal library it costs one round of queries per 30 days of quiet. On ours that is
   27 windows × 2 TV libraries = **54 queries and 1,166 ms of server time for a row of 16
   titles**, which makes `LatestShows` the slowest thing on the home screen.
2. If fewer than 16 distinct results _exist_ — a small library, or `HideWatchedItems` on a
   mostly-watched one — the accumulator can never reach 16 and the loop runs the **entire
   range to the stop date: 1,237 windows per library** for `LatestShows`, ~1,692 for
   `LatestSectionBase`. The cost is then _inversely_ related to library size.

Separately, every one of those queries sets `EnableTotalRecordCount = true` and discards
the count, which is a second pass over the same filtered set on each iteration.

### The code

`src/Jellyfin.Plugin.HomeScreenSections/HomeScreen/Sections/Latest/LatestShowsSection.cs`,
L70–L139 (`LatestSectionBase.cs` L85–L143 is the same shape with `Limit = 16` and a 1887
stop date):

```csharp
int dayIncrement = 30;
DateTime currentDate = DateTime.Now;
DateTime stopDate = DateTime.Parse("01/01/1925");
bool continueSearching = true;

do
{
    var mainQuery = folders.Select(x =>
    {
        // ... one query per library, per iteration
        var items = folder.GetItems(new InternalItemsQuery(user)
        {
            IncludeItemTypes = new[] { SectionItemKind },
            OrderBy          = new[] { (ItemSortBy.PremiereDate, SortOrder.Descending) },
            Limit            = 200,
            IsVirtualItem    = false,
            IsPlayed         = isPlayed,
            Recursive        = true,
            ParentId         = folder.Id,
            MaxPremiereDate  = currentDate,
            MinPremiereDate  = currentDate.Subtract(TimeSpan.FromDays(dayIncrement)),
            EnableTotalRecordCount = true   // "This might have to go"
        });
        return (Items: items.Items, items.Items.Count, items.TotalRecordCount);
    }).ToArray();

    // ... group the window's episodes by series, accumulate into selectedSeries ...

    if (selectedSeries.Count >= 16)
    {
        continueSearching = false;
    }

    currentDate = currentDate.Subtract(TimeSpan.FromDays(dayIncrement));

    if (currentDate < stopDate)
    {
        break;
    }
} while (continueSearching);
```

`dayIncrement` is assigned once and never changed. `TotalRecordCount` is read into a tuple
element that nothing downstream consumes.

### Reproduction 1 — the ordinary case (sparse recent months)

Replaying the loop over HTTP against our server, one request per window per library, with
the same filters the section uses:

```
iter  1: distinct series = 1    back to 2026-07-26
iter  3: distinct series = 2    back to 2026-05-27
iter 10: distinct series = 6    back to 2025-10-29
iter 20: distinct series = 15   back to 2025-01-02
iter 27: distinct series = 16   back to 2024-06-06   <- stops here
```

**27 iterations × 2 TV libraries = 54 queries, 1,166 ms of cumulative server time**, for a
row of 16 titles. Measured end to end, `GET /HomeScreen/Section/LatestShows` has an
`x-response-time-ms` median of 293.7 ms warm and 1,062.7 ms on a cold home load, against
60.7 ms for `LatestMovies` on the same box — and `LatestMovies` runs the identical loop.
The only difference is that our movie premiere dates are dense in recent months, so it
exits in a handful of windows.

An equivalent single ordered query per library — take the top-N episodes by premiere date,
group by series, keep 16 — answers the same row, **same 16 titles in the same order**, with
an `x-response-time-ms` median of 48.1 ms measured over HTTP (so including serialising 400
episode DTOs that an in-process implementation would never materialise).

### Reproduction 2 — the pathological case (fewer than 16 eligible results)

One of our two TV libraries holds 9 series. Scoping the same replay to it alone:

```
iter  1  back to 2026-07-26   distinct series =  0   (50 ms)
iter  5  back to 2026-03-28   distinct series =  0   (17 ms)
iter 20  back to 2025-01-02   distinct series =  2   (13 ms)
iter 40  back to 2023-05-13   distinct series =  3   (13 ms)
   ... 16 is unreachable: only 9 series exist ...
per-window server time: median 12.7 ms (n = 40)
```

The accumulator saturates at 9, `continueSearching` stays true, and the loop exits only
when `currentDate < stopDate`. From 2026-08-25 back to 1925-01-01 in 30-day steps is
**1,237 iterations**. That library contains **0 episodes with a premiere date before
1950**, so roughly 1,190 of those windows are guaranteed to run and guaranteed to return
nothing. At the measured 12.7 ms per window that projects to **~15.7 s of server CPU for a
single home row**, per library, on every request — and this is the _small_ library.

The same state is reachable on a large library: `HideWatchedItems` sets `IsPlayed = false`,
so a user who has watched all but a few series drops below the 16 threshold and takes the
same full walk.

(The 15.7 s is a projection from the measured per-window cost and the proven-empty tail,
not a single wall-clock measurement — we did not want to issue 1,237 requests against a
live server. The 1,237 window count and the empty tail are both measured.)

### Suggested fixes

Either one is small, and they are independent:

1. **Drop `EnableTotalRecordCount = true`** from `LatestShowsSection.cs` L100 and
   `LatestSectionBase.cs` L118. The count is never read. The comment already says
   `// This might have to go`.

2. **Stop walking.** The row is defined entirely by the top-N items by premiere date, so
   the windows compute something the answer does not depend on. One ordered query per
   library, grouped by series and truncated to 16, is the same answer. If that is too big a
   change, growing `dayIncrement` geometrically (`dayIncrement *= 2` at the bottom of the
   loop) turns 27 windows into ~5 and caps the pathological case at ~17 instead of 1,237 —
   a two-line change that removes the runaway.

3. Optionally, bound the loop by iteration count as well as by `stopDate`, so a library
   that can never reach 16 fails fast with a short row rather than scanning a century.

### Notes

- This is the second defect we have found in this plugin's home path. The first is
  [#269](https://github.com/IAmParadox27/jellyfin-plugin-home-sections/issues/269) — the
  `/HomeScreen/Sections` cache is keyed with `Guid.NewGuid()` when `pageHash` is omitted,
  so it is written and never read. Still open; the two land in the same request path and
  might be worth fixing together.
- We are carrying a local workaround (a `IStartupFilter` in our own plugin that answers
  `/HomeScreen/Section/LatestShows` from one ordered query and falls through to this plugin
  for every shape it cannot prove equivalent). We would much rather drop it. Happy to open
  a PR for either fix above if that is useful — say the word and we will.
