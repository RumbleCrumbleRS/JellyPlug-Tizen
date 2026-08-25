# Upstream report — `jellyfin/jellyfin`

**Status: DRAFT (JELA-734).** Awaiting CEO confirmation before filing. On accept, file
against `jellyfin/jellyfin` and flip this header to FILED with the issue link, exactly as
`docs/imageloader-worker-upstream-report.md` (JELA-701) was.

Verified by reading tag `v10.11.11`, which is the version our production server runs.
Every measurement below was taken against that server on 2026-08-25 with the JELA-692
pre-flight gate CLEAR before and after; timings are `x-response-time-ms`, interleaved
n = 5, first (cold) cycle reported separately from the warm median. Split out of JELA-731.

---

## Title

`Items/Latest` with an explicit `includeItemTypes` of a container type returns one item
instead of `limit` — and for `Series` the endpoint costs ~10x an equivalent sorted query

## Body

Two findings in `Items/Latest`, from the same read. The first is a correctness bug and is
the one worth acting on; the second is a performance observation we could not fully
attribute and are reporting as measurements plus ruled-out hypotheses.

---

### 1. `Items/Latest?includeItemTypes=Series` returns exactly one item (correctness)

`GET /Items/Latest?parentId=<a tvshows library>&includeItemTypes=Series&limit=16` returns
**1 item**, not 16. Reproduced on two independent TV libraries on the same server:

| request                                              | items returned | items that exist |
| ---------------------------------------------------- | -------------: | ---------------: |
| `parentId=<lib A>&includeItemTypes=Series&limit=16`  |          **1** |               31 |
| `parentId=<lib B>&includeItemTypes=Series&limit=16`  |          **1** |                9 |
| same, `limit=1` / `limit=50`                         |          **1** |           31 / 9 |
| same, `isPlayed=true` / `isPlayed=false`             |          **1** |           31 / 9 |
| same, **`groupItems=false`**                         |     **16 / 9** |           31 / 9 |
| `parentId=<lib A>&includeItemTypes=Episode&limit=16` |             16 |                — |
| `parentId=<lib A>&limit=16` (no `includeItemTypes`)  |             16 |                — |

`limit` has no effect, `isPlayed` has no effect, and `groupItems=false` fixes it — which
places the bug in the `GroupItems` branch.

**Mechanism.** `UserViewManager.GetItemsForLatestItems` (`Emby.Server.Implementations/
Library/UserViewManager.cs` L375-L397) routes a `tvshows` collection type into
`_libraryManager.GetLatestItemList(query, parents, CollectionType.tvshows)`. That lands in
`BaseItemRepository.GetLatestItemList` (`Jellyfin.Server.Implementations/Item/
BaseItemRepository.cs` L328):

```csharp
var subqueryGrouped = subquery
    .GroupBy(g => collectionType == CollectionType.tvshows ? g.SeriesName : g.Album)  // L344
    .Select(g => new { Key = g.Key, MaxDateCreated = g.Max(a => a.DateCreated) })
    .OrderByDescending(g => g.MaxDateCreated)
    .Select(g => g);

if (filter.Limit.HasValue)
{
    subqueryGrouped = subqueryGrouped.Take(filter.Limit.Value);                       // L355
}

filter.Limit = null;

var mainquery = PrepareItemQuery(context, filter);
mainquery = TranslateQuery(mainquery, context, filter);
mainquery = mainquery.Where(g => g.DateCreated >= subqueryGrouped.Min(s => s.MaxDateCreated)); // L362
```

The grouping key is `SeriesName`, which is the correct key for the `Episode` rows this
method was written for. **On a `Series` row `SeriesName` is null** — confirmed against the
API, `fields=SeriesName` comes back `null` for every series. So every series in the library
collapses into a single group with the null key. `Take(16)` then keeps that one group,
whose `MaxDateCreated` is the newest `DateCreated` in the whole library, and the L362
predicate `DateCreated >= <newest DateCreated>` admits exactly one row.

The same shape applies to `Season` (also null `SeriesName`), and by symmetry to the `music`
branch for any type whose `Album` is null — `MusicAlbum` itself, most obviously. We have no
music library to confirm that half, so treat it as read-from-source, not measured.

**Reachable without `parentId`.** The branch is chosen at L377-L384 from the _first_
library whose collection type is non-null:

```csharp
var collectionType = parents
    .Select(parent => parent switch
    {
        ICollectionFolder collectionFolder => collectionFolder.CollectionType,
        UserView userView => userView.CollectionType,
        _ => null
    })
    .FirstOrDefault(type => type is not null);
```

`parents` here is `GetUserRootFolder().GetChildren(user, true)` minus the user's
`LatestItemExcludes` (L283-L288). So on an install whose first such library is a `tvshows`
one, a plain `Items/Latest?includeItemTypes=Series` takes the same branch and returns one
item. On our server the first is a `boxsets` library, which is why the un-scoped call
happens to work here. That also means the endpoint's behaviour depends on library ordering
and on a per-user "hide from Latest" preference, which seems worth fixing on its own.

**Suggested fix.** Group by a key that is correct for the row type being returned —
`PresentationUniqueKey` is already used for exactly this elsewhere in the same file — or,
narrower, skip the grouped path entirely when `IncludeItemTypes` contains a type that is
its own container (`Series`, `Season`, `MusicAlbum`), since there is nothing to group.

---

### 2. `Items/Latest?includeItemTypes=Series` costs ~10x an equivalent sorted query

On the un-scoped call (the one that returns the right answer here), `Items/Latest` and a
plain sorted `/Items` return **the same 16 titles in the same order**, for roughly ten
times the server time:

| query                                                                                                      |  cold | warm median |
| ---------------------------------------------------------------------------------------------------------- | ----: | ----------: |
| `Users/{u}/Items/Latest?includeItemTypes=Series&limit=16`                                                  | 882.9 |   **923.3** |
| `Items?userId={u}&includeItemTypes=Series&recursive=true&sortBy=DateCreated&sortOrder=Descending&limit=16` |  79.3 |    **70.4** |

Order equivalence is exact, and is not an accident of ties: the 40 series on this server
have distinct `DateCreated` values down to sub-second precision, and adding the two
tiebreakers `Items/Latest` actually sorts on (`SortName`, `ProductionYear`, both
descending) leaves the result identical. Nor is it an accident of a library where a series'
folder `DateCreated` agrees with its newest episode — on this branch the query orders the
`Series` rows themselves by their own `DateCreated` (`UserViewManager.cs` L358-L364), which
is the same column the `/Items` comparison sorts on, so the two cannot diverge by
construction.

**What it is not.** The obvious explanation is the `Limit = limit * 5` over-fetch at
`UserViewManager.cs` L369. That is not it — the cost does not depend on `limit` at all:

| arm                                                                              | warm median |
| -------------------------------------------------------------------------------- | ----------: |
| `Items/Latest` `includeItemTypes=Series&limit=16` (query limit 80)               |    786.0 ms |
| `Items/Latest` `includeItemTypes=Series&limit=1` (query limit 5)                 |    740.7 ms |
| `Items/Latest` `includeItemTypes=Series` scoped to one library                   |    603.2 ms |
| `Items/Latest` `includeItemTypes=Series&enableImages=false&enableUserData=false` |    744.0 ms |
| `Items/Latest` `includeItemTypes=Episode`                                        |     29.3 ms |
| `Items/Latest` `includeItemTypes=Movie`                                          |     32.7 ms |
| `/Items` replicating **every** filter of the Latest query\*                      |     92.2 ms |
| `/Items` same, scoped to one library                                             |     53.8 ms |

\* `sortBy=DateCreated,SortName,ProductionYear` all descending, `limit=80`,
`isPlayed=false`, `isVirtualItem=false`, `enableTotalRecordCount=false` — the query
`GetItemsForLatestItems` builds at L357-L373.

So it is not the over-fetch (limit-independent), not DTO or image construction (disabling
both changes nothing, and the `limit=1` arm builds a single DTO), not the multi-library
`TopParentIds` scope (single-library is still 603 ms), and not the endpoint in general
(`Episode` and `Movie` are ~30 ms through the identical code). Replicating the query's
filters one at a time and then all together on `/Items` never reproduces it. Both paths
converge on `BaseItemRepository.GetItemList`, which is where we ran out of things we could
distinguish from outside the process.

We are reporting it because the measurement is solid and reproducible even though the
attribution is not — someone with a profiler on the DB layer should be able to close it
quickly. If it is useful we can run specific queries against this server on request; it has
~3,000 episodes across 40 series and reproduces every time.

### Impact

Finding 1 is a wrong answer, silently: a client asking `Items/Latest` for `Series` gets one
row and no error. Finding 2 is not on our own boot path — our home rows come from a plugin
that does not use this endpoint — but `jellyfin-web`'s own "Latest" rows do call it.
