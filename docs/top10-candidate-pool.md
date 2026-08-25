# The Top 10 candidate pool — what it costs, and why it is not oversized

JELA-754. Measured 2026-08-25 against the prod library via `$JELLYFIN_URL`, and
by replaying the live `top10-badges` module's own exports in Node.

## The query

`jellyplug-top10` builds its candidate pool with one request:

```
GET /Users/{u}/Items?SortBy=SortName&SortOrder=Ascending&Recursive=true
    &IncludeItemTypes=Movie&Limit=500&Fields=PrimaryImageAspectRatio,CriticRating
    &EnableImageTypes=Primary&ImageTypeLimit=1&EnableTotalRecordCount=false
```

287,730 B for the test library. It ran **twice per session** — once at boot and
once on the first detail page opened.

## Why twice

Two consumers of the same query, neither aware of the other:

| #   | Caller                                                                                                     | Memo                                                                            | Reads `jp:top10:` cache?       |
| --- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------ |
| 1   | the row — `we()` → `Me()` → `Ue()`                                                                         | run-closure latch `T`/`pe`, keyed `dayStamp:userId`                             | writes it, and renders from it |
| 2   | `JellyPlugTop10.rankedTopForType` (`ie`), called by `detail-top10-rank` for the "#3 in Movies Today" badge | none of its own; `detail-top10-rank` memoises the promise per `type`+`dayStamp` | **no**                         |

`ie` goes straight to `ApiClient.getItems`. It only reads, never writes, which
is exactly why the ticket's before/after `jp:top10:` dump was byte-identical:
the second fetch cannot change the cache. `detail-top10-rank`'s own memo caps it
at one extra query per session, which is the observed "exactly twice".

The fix is the missing single-flight, not another cache — see
`packages/server-shell-drop/scripts/jsi-jp754-patch.mjs`, flag
`jellyplug.top10.sharepool`.

## Why `candidateLimit` must NOT be lowered to `poolSize`

`selectDailyTop(items, day, poolSize, limit)` does three things:

1. seeded Fisher-Yates shuffle of the **whole** candidate array, seed = FNV-1a
   of the dayStamp;
2. `.slice(0, poolSize)` — 40 by default (200 is the clamp ceiling, not the
   default);
3. rank that slice by `CriticRating` descending, keep `limit` (10).

So the candidate list is the daily **rotation universe**, not an oversized
buffer. Every candidate is reachable on some day; shrinking the list shrinks the
part of the library the row can ever show, and changes today's row outright.

Replaying `parseItems` + `selectDailyTop` from the live module over the live
pool — the library holds **348 Movies**, so `Limit=500` is not truncating at
all, it returns the entire Movie library:

| `candidateLimit`  | today's top 10 vs shipped | distinct titles over 365 days |
| ----------------- | ------------------------- | ----------------------------- |
| 500 (shipped)     | —                         | 138                           |
| 200               | **0 / 10 ids in common**  | 80                            |
| 40 (= `poolSize`) | **0 / 10 ids in common**  | 12                            |

Lowering it is a feature regression that also contradicts the ticket's own
"rendered row must be identical" requirement. The wire saving the ticket wanted
from it is bought instead by removing the duplicate fetch outright (−287,730 B)
plus the `Fields` trim below (−5.4% of the one that remains).

## `PrimaryImageAspectRatio` is dead weight on a Movie chart

The only reader is jp671's `jpWide671()`, which returns `false` immediately
unless the item's `Type` is `Video`, `MusicVideo` or `Episode`. The shipped
chart is `includeItemTypes:"Movie"`, so the field is parsed and discarded for
every item — 0 of 348 items had `wide === true`.

| Fields                                           | bytes               |
| ------------------------------------------------ | ------------------- |
| `PrimaryImageAspectRatio,CriticRating` (shipped) | 287,730             |
| `CriticRating`                                   | 272,183             |
| saving                                           | **15,547 B (5.4%)** |

`slimItems(selectDailyTop(...))` is byte-identical between the two responses.
The patch keeps the field whenever the query's type list contains a wide-capable
type, so an Episode or Video chart is unaffected — including when jp512's
`homeItemTypes` overrides the row's type set at runtime.

## Field weight of one candidate response (348 items, shipped query)

| field                     | bytes    | share |
| ------------------------- | -------- | ----- |
| `UserData`                | 62,690   | 20.9% |
| `ImageBlurHashes`         | 40,344   | 13.4% |
| `ImageTags`               | 21,228   | 7.1%  |
| `ServerId`                | 16,704   | 5.6%  |
| `PremiereDate`            | 16,512   | 5.5%  |
| `PrimaryImageAspectRatio` | 16,243   | 5.4%  |
| `Id`                      | 14,616   | 4.9%  |
| everything else           | ~112,000 | 37%   |

The consumer keeps only `id`, `name`, `serverId`, `imageTag`, `critic`, `us`
(from `UserData`) and `wide`. `UserData` and `ImageTags` are load-bearing, so
`EnableUserData=false` / `EnableImages=false` are not available:

| variant                | bytes   | why not                                              |
| ---------------------- | ------- | ---------------------------------------------------- |
| `EnableImages=false`   | 218,816 | drops `ImageTags` — the row loses its poster art     |
| `EnableUserData=false` | 210,189 | drops `UserData` — jp622 loses played/progress state |

`ImageBlurHashes` survives every documented combination that keeps `ImageTags`,
so its 13.4% is not reachable from the client. That is an upstream ask, not a
client-side lever.

## Rig result (JELA-112 virtual Tizen 5.0, primed profile, n=3 matched pairs)

Both arms run the SAME patched channel and differ only in the localStorage
flags (JELA-696), so the substitution itself cannot be confounded with. The
measurement is a request COUNT, so it is immune to the JELA-682 load confound
(loadavg ranged 2.0–5.4 across the ring with zero effect on the counts).

| arm           | pool GET @boot | pool GET @nav | total | CORS preflights | pool bytes/session |
| ------------- | -------------- | ------------- | ----- | --------------- | ------------------ |
| flag off (×3) | 1              | 1             | **2** | 2               | 575,885–575,895    |
| flag on (×3)  | 1              | **0**         | **1** | 1               | 272,387–272,411    |

`jp:top10:<today>:<user>` was seeded into every arm, so AC1's precondition
("the cache is present and matches today") held in all six runs.

AC4, diffed on the cache VALUE rather than the card count: the stored payload
is byte-identical (1,828 chars, same ids, same order) across all six runs —
`Moana, Creed, Arrival, Iron Man, Spider-Man: No Way Home, …` — matching the
Node replay. Card count was 49 in all six.

The rank badge still works off the shared pool. Navigating to `Arrival` (#3 in
today's list) mounts **"TOP 10 · #3 in Movies Today"** in BOTH arms — the flag-on
arm just does it with zero additional requests:

| arm      | badge text           | pool GET @nav |
| -------- | -------------------- | ------------- |
| flag off | `#3 in Movies Today` | 1             |
| flag on  | `#3 in Movies Today` | **0**         |

### Rig trap (cost three boots)

Shell v1.0.90 does **not** keep the channel in `jellyfin.shell.jsiChannel.c*` —
that key does not exist on this profile, so JELA-745's install recipe reports
"no meta" and every arm silently runs the shipped bytes. The channel URL carries
a `?v=` token, so JEL-178 stores its **transpiled** body under a
content-addressed slot `shell.tx<sid>:txc:<txFnv1a(SOURCE)>` (877,743 chars) and
`txGetStatic()` serves it with no further verification. The key is the hash of
the SOURCE, so patching the VALUE in place substitutes the executed code and
still reads as a cache hit — no `meta.h` to recompute. Find the slot by content
(`indexOf('jellyplug-top10')`), never by a hard-coded hash.

Second trap: `jp:top10:` does **not** survive between browser processes on this
rig (JELA-748 — Chromium's rate-limited localStorage commit, and the 877 KB
channel slot eats the write budget), so a "primed" profile boots with
`top10cache=0`. Seed the key explicitly, identically in both arms, or AC1's
precondition is never actually under test.

## Reproducing

The module ships a `module.exports` block, so its ranking is replayable in Node
without a browser (the JELA-743 trick):

```js
const M = require("./top10.js"); // the live channel entry body
const pool = JSON.parse(fs.readFileSync("pool.json", "utf8"));
const day = M.localDayStamp(Date.now());
const cfg = M.resolveConfig(null);
M.selectDailyTop(
  M.parseItems(pool, cfg.candidateLimit),
  day,
  cfg.poolSize,
  cfg.limit,
);
```

On 2026-08-25 that reproduces the live `jp:top10:2026-08-25:<user>` value
head-for-head (`#1 = Moana`, `b71940db…`), which is what makes it usable as the
AC4 oracle: diff the ids, never the rendered card count (JELA-738).
