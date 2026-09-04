# JELA-859 — the Top 10 candidate query stops hydrating 349 movies to render 10

Patch: `packages/server-shell-drop/scripts/jsi-jp859-patch.mjs`
Guard: `packages/server-shell-drop/scripts/jsi-jp859-patch.test.cjs`
Flag: `jellyplug.top10.idsplit` — **opt-in, dark by default.**

Prior art this builds on: `docs/top10-candidate-pool.md` (JELA-754, why
`candidateLimit` is not a knob) and `docs/jela830-ids-union.md` (the
cheap-list-then-`?Ids=`-hydrate shape).

## 1. The cost, and where it actually is

One request builds the pool, and it returns the whole Movie library:

```
GET /Users/{u}/Items?SortBy=SortName&SortOrder=Ascending&Recursive=true
    &IncludeItemTypes=Movie&Limit=500&Fields=CriticRating
    &EnableImageTypes=Primary&ImageTypeLimit=1&EnableTotalRecordCount=false
```

`TotalRecordCount` for Movie is **349**, so `Limit=500` truncates nothing. The
response is fully hydrated — `ImageTags`, `ImageBlurHashes`, `UserData` — for
every one of the 349, and then:

```
w(resp, candidateLimit)   ->  {id,name,serverId,imageTag,critic,us,wide} x349
z(items, day, 40, 10)     ->  seeded Fisher-Yates shuffle of the WHOLE list
                              -> .slice(0, poolSize=40)
                              -> le(): rank by CriticRating desc, nulls last
                              -> take limit=10
```

`z()` reads exactly two things: the **array order** — the shuffle seed is
FNV-1a of the dayStamp, not of any item field — and **`critic`**. `name`,
`serverId`, `imageTag`, `us` and `wide` are display fields, read only for the
`limit` items that survive.

So 339 of the 349 items are hydrated with images and user data purely to be
discarded, and the remaining 10 need those fields.

## 2. The change

`jpLean859` adds `EnableImages=false&EnableUserData=false` to the candidate
query; `jpHyd859` re-hydrates the survivors with one `?Ids=` request and copies
`name` / `serverId` / `imageTag` / `us` / `wide` back onto the already-selected
array, in place, in order.

Three call sites, all patched on their own anchors:

| site                                       | consumer                                         |
| ------------------------------------------ | ------------------------------------------------ |
| `Ue()` main path                           | the home row (the boot fetch)                    |
| `Ue()` `!g.Promise` fallback               | engines with no global Promise                   |
| `ie()` = `JellyPlugTop10.rankedTopForType` | `detail-top10-rank`'s "#3 in Movies Today" badge |

`B()` is wrapped once, and both consumers build their query through it.

### Why the rendered Top 10 cannot move

**Structurally.** `jpHyd859` runs _after_ `z()`. It writes display fields onto
the selected array and can neither add, drop nor reorder an entry. The
selection is a pure function of the lean response; the hydrate is a pure
function of the selection.

**And the lean response selects identically.** `EnableImages` /
`EnableUserData` change neither the row order (`SortBy=SortName`) nor
`CriticRating`, and jp465's `homeExcludedFilter` filters on `Id` alone (it
already issues its own `EnableImages:!1, EnableUserData:!1` query for exactly
that reason). Replaying the live module's own `parseItems` + `selectDailyTop`
exports over both live responses gives byte-identical id lists for **400
consecutive dayStamps**; the test reruns the same 400-day comparison through
the patched module end to end.

### Failure behaviour

A rejected hydrate is **not** caught — a failed pool stays a failed row, so
jp473's retry latch sees it and the `jp:top10:` day cache is never written with
null image tags. A hydrate that succeeds but omits an id (deleted between the
two calls) leaves that one entry's lean values and does not disturb its
neighbours.

## 3. Deliberately not done

- **`candidateLimit` is untouched at 500.** It is the daily rotation universe,
  not an oversized buffer — lowering it truncates the shuffle input to the
  alphabetically-first N and permanently excludes late-alphabet titles
  (`docs/top10-candidate-pool.md`, measured: `candidateLimit=200` shares 0 of
  10 ids with the shipped row).
- **`jellyplug.top10.leanfields` / `.sharepool` are not touched.** `jpOn754` is
  fail-open since jp838, so both are already armed fleet-wide, and leanfields
  is worth 491 B (0.9%).
- **The jp672 widening path is left alone.** With `Limit` widened to 5000 the
  lean query gets _more_ valuable, not less; the hydrate still asks for the
  `limit` survivors only.

## 4. Rig A/B — JELA-112 M63 (Chromium 63.0.3239 / V8 6.3), cold boot each

`n = 4` boots per arm, fresh `--user-data-dir` and a fresh chrome process every
boot (JELA-719: the in-process memory cache makes a second boot in the same
process a lie). Real WGT bootstrap from `file://`, tizen shim, real prod
library. Bytes are CDP `Network.loadingFinished.encodedDataLength`; `srvMs` is
the upstream's own `x-response-time-ms` response header, reported separately
from wall per JELA-822.

Arms differ **only** in the `jellyplug.top10.idsplit` localStorage key
(JELA-696): `off` and `on` run byte-identical patched channel bytes.

| arm                         | channel   | candidate GET | hydrate GET | **total**    | GETs |
| --------------------------- | --------- | ------------- | ----------- | ------------ | ---- |
| `ctl` — shipped channel     | 924,288 B | 52,343 B      | —           | **52,343 B** | 1    |
| `off` — patched, flag unset | 925,472 B | 52,337 B      | —           | **52,337 B** | 1    |
| `on` — patched, flag `"1"`  | 925,472 B | **20,016 B**  | **2,265 B** | **22,281 B** | 2    |

(medians of 4; per-boot values in §6)

**−57.4% on the boot-path Top-10 traffic, 52,337 B → 22,281 B**, for one extra
request. `off` sits on top of `ctl` — the dark patch is inert, as designed.

Server CPU moves with it. Candidate-query `srvMs`, medians of 4:

| arm   | candidate `srvMs` | hydrate `srvMs`   |
| ----- | ----------------- | ----------------- |
| `ctl` | 742.1             | —                 |
| `off` | 939.3             | —                 |
| `on`  | **245.1**         | 32 / 34 / 70 / 46 |

`ctl` and `off` are the same query and their `srvMs` spread (455–3157 ms across
8 boots) is the noise floor of this shared box; the `on` arm's 185–338 ms sits
entirely below every `ctl`/`off` sample, which is the same shape the byte
result has.

### Acceptance

| AC                                                             | result                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. `< 25 KB`, CDP on a cold boot, `candidateLimit` not lowered | **PASS** — 22,281 B, `Limit=500` unchanged (349 movies)                                                                                                                                                                                                 |
| 2. byte-identical Top 10 for a fixed dayStamp                  | **PASS** — **1** distinct rendered id list across all 12 boots of all 3 arms; plus 400 dayStamps identical in the unit test                                                                                                                             |
| 3. badge art + detail pill                                     | **PASS** — `10/10` `.jp-top10-thumb` carry a background image and 0 of 10 `imageTag`s are null in every arm; `data-jp-top10-art="ready"`; navigating to today's #1 mounts `.jp-detail-top10-rank` reading `TOP 10 #1 in Movies Today` in all three arms |
| 4. before/after, same method, `srvMs` separate                 | **PASS** — this section                                                                                                                                                                                                                                 |

The rendered row, identical in all 12 boots:

> Top Gun: Maverick · Star Trek · Incredibles 2 · Final Destination Bloodlines ·
> Doctor Strange · Shrek 2 · Zombieland · The Naked Gun · Elf · Avatar

## 5. Harness note — how the channel was substituted, and how NOT to

Production was never written. The arms are served by a byte-transparent local
reverse proxy that pipes everything upstream verbatim and answers only
`/JavaScriptInjector/public.js` from a local file.

**Do not reach for CDP interception on this rig.** Chromium 63 has no `Fetch`
domain at all, and its `Network.setRequestInterceptionEnabled` is
all-or-nothing (no URL patterns). Measured on a real boot, turning it on:

- zeroes **every** `loadingFinished.encodedDataLength` — the byte census
  becomes all-zero and looks like a cache hit;
- inflates the upstream's `x-response-time-ms` 4–12x (1,028 ms → 4,395 ms;
  a 2.3 KB hydrate reported 12,066 ms) because the origin's body write blocks
  on the stalled CDP reader.

Both of the numbers this ticket is about are destroyed, and neither failure is
loud. The proxy leaves `Content-Encoding: gzip` bodies compressed and passes
`x-response-time-ms` through untouched — verified against a direct request:
52,057 B / gzip on both legs.

Also note the upstream `Via: 1.1 Caddy` front end **500s on forwarded
hop-by-hop headers** — a proxy must strip `connection` / `keep-alive` / `te` /
`trailer` / `transfer-encoding` / `upgrade` before forwarding.

## 6. Per-boot values

| boot  | arm | channel B | candidate B | hydrate B | total B | cand `srvMs` | hyd `srvMs` | thumbs w/ art | rank pills | detail pill          |
| ----- | --- | --------- | ----------- | --------- | ------- | ------------ | ----------- | ------------- | ---------- | -------------------- |
| ctl-A | ctl | 924,288   | 52,404      | —         | 52,404  | 764          | —           | 10/10         | 10         | (not probed)         |
| ctl-B | ctl | 924,288   | 52,349      | —         | 52,349  | 1,402        | —           | 10/10         | 10         | `#1 in Movies Today` |
| ctl-C | ctl | 924,288   | 52,336      | —         | 52,336  | 455          | —           | 10/10         | 10         | `#1 in Movies Today` |
| ctl-D | ctl | 924,288   | 52,324      | —         | 52,324  | 720          | —           | 10/10         | 10         | `#1 in Movies Today` |
| off-A | off | 925,472   | 52,349      | —         | 52,349  | 3,157        | —           | 10/10         | 10         | (not probed)         |
| off-B | off | 925,472   | 52,337      | —         | 52,337  | 1,255        | —           | 10/10         | 10         | `#1 in Movies Today` |
| off-C | off | 925,472   | 52,336      | —         | 52,336  | 624          | —           | 10/10         | 10         | `#1 in Movies Today` |
| off-D | off | 925,472   | 52,324      | —         | 52,324  | 531          | —           | 10/10         | 10         | `#1 in Movies Today` |
| on-A  | on  | 925,472   | 20,016      | 2,265     | 22,281  | 185          | 32          | 10/10         | 10         | (not probed)         |
| on-B  | on  | 925,472   | 20,016      | 2,265     | 22,281  | 237          | 34          | 10/10         | 10         | `#1 in Movies Today` |
| on-C  | on  | 925,472   | 20,016      | 2,265     | 22,281  | 338          | 70          | 10/10         | 10         | `#1 in Movies Today` |
| on-D  | on  | 925,472   | 20,016      | 2,264     | 22,280  | 253          | 46          | 10/10         | 10         | `#1 in Movies Today` |

The `on` arm's candidate response is **20,016 B in all four boots** while
`ctl`/`off` range over 80 B — the fat response carries `UserData`, which moves
with playback state between boots. Dropping it makes the pool query
deterministic as a side effect.

The `+1,184 B` channel delta (924,288 → 925,472) is the provenance signal: it
is recorded per boot, so an arm that silently ran the shipped bytes is visible
in the record rather than inferred.

## 7. Deploying

The patch is dark. Landing it changes nothing on a TV until
`jellyplug.top10.idsplit` is set to `"1"`.

```
# 1. snapshot + patch the LIVE config
node packages/server-shell-drop/scripts/jsi-jp859-patch.mjs \
     --config live-cfg.json --out patched-cfg.json
# 2. POST patched-cfg.json to the JavaScript Injector plugin config
#    (JELA-107/108 snapshot -> gate -> rollback discipline)
```

Rollback of the flip is `setItem("jellyplug.top10.idsplit", "0")` — under an
opt-IN read site `removeItem` is also an OFF arm, but keep the explicit `"0"`
habit (JELA-816/832: under opt-OUT read sites `removeItem` is an **ON** arm,
and the polarity of the next flag is not something to have to remember).
