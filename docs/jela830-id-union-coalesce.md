# JELA-830 — coalescing the boot `Ids=` hydration burst by id-union

Split out of [JELA-829](./jela829-home-row-seam-census.md), which found this lever by
census. This document is the design, the measurements that fixed each rule, and the
two constraints from the ticket that the measurements changed.

Ships **flag-dark**: `jellyfin.shell.idUnion` is seeded nowhere. With the key absent
the shim never installs and every request is on the wire, so the OFF arm is the
current fleet behaviour byte for byte.

---

## 1. The defect

Eleven boot GETs carry `Ids=`. Between them they ask for **339 item ids of which only
144 are distinct**. Requests 8, 9 and 10 land inside **62 ms of each other with
pairwise 100 % id overlap** — the same 21 items fetched three times, differing only in
which `Fields` are asked for.

The shell already owns the machinery. `fetchCoalesce` (JELA-724 / JELA-752) allowlists
`/Users/*/Items`, already has a window, a kill switch and counters — and misses every
one of these, because it keys on the **byte-identical URL**.

The fix generalises the key from "identical URL" to "same route + same non-`Ids`
params ⇒ union the `Ids`", and slices the merged response per waiter.

## 2. It is a batcher, not a join — and that is only affordable here

The existing coalescer joins a request to one already **in flight**. That cannot work
here: the leader cannot know the union until the window closes, so the first caller
must be **held** for the window. That is a real latency cost, paid by whoever asks
first.

It is affordable in this one place because the whole burst fires at **+19 s to +30 s
after nav**, well after firstCard. The window's added latency is paid by post-paint
hydration, not by paint. Nothing about this shape generalises to a pre-paint request,
and the flag is scoped accordingly.

A batch that closes with **one** waiter re-issues that caller's **original URL
untouched** — no rewriting, no slicing. The no-duplicate case is byte-identical to
baseline plus the delay.

## 3. Two ticket constraints that the measurements changed

The ticket listed five constraints. Three were adopted as written. Two were probed
against the live server first, and the probe changed both.

### 3.1 `EnableTotalRecordCount` — the constraint as written would have missed AC1

The ticket said: _"Only merge requests with `EnableTotalRecordCount=false` — a caller
that wants the count cannot be served from a filtered slice."_

Four of the eleven (requests 0, 1, 2, 4) carry **no `EnableTotalRecordCount` at all**,
and it defaults to `true`. Read literally, the constraint excludes them, which leaves
the census at **exactly 8** against an AC of "≤ 8" — no margin at all, and one boot
whose timings drift slightly fails.

So it was probed. Six queries against the live server, `/Users/{u}/Items?Ids=`:

| probe | query                             | result                        |
| ----- | --------------------------------- | ----------------------------- |
| A     | 3 ids, `Limit=3`, ETRC absent     | `TotalRecordCount=3`, 3 items |
| B     | 5 ids, `Limit=5`, ETRC absent     | `TotalRecordCount=4`, 4 items |
| C     | 5 ids, `Limit=2`, ETRC absent     | `TotalRecordCount=4`, 2 items |
| D     | 5 ids, no Limit, **ETRC=false**   | `TotalRecordCount=4`, 4 items |
| E     | 3 real ids + 1 bogus, ETRC absent | `TotalRecordCount=3`, 3 items |
| F     | 5 ids, no Limit, ETRC absent      | `TotalRecordCount=4`, 4 items |

Two things fall out. `EnableTotalRecordCount=false` does **not** suppress the count on
this server (D returns it anyway), and in every case — absent or false — the count is
**the number of requested ids that exist** (E: the bogus id is not counted), which is
exactly the length of the per-waiter slice, before any `Limit` is applied.

So the count is not an obstacle: it is exactly reconstructable. `EnableTotalRecordCount`
is kept as a **strict key param** — never unioned, so an absent-ETRC caller and a
`false` caller still never share a batch — and absent-ETRC callers are merged with each
other. An **explicit** `ETRC=true` still opts out; no request in the census has one, so
that costs nothing.

**This is a deliberate deviation from the ticket's constraint list.** It is what takes
the result from 8 (at the AC boundary) to 6.

### 3.2 `Limit` — the real hazard is not truncation, it is that the result is unordered

The ticket said the union's `Limit` must be ≥ the union's id count or the server
truncates a waiter's items. True, and implemented. But probe C found the sharper
problem: 5 ids with `Limit=2` returned the **3rd and 4th** ids, not the 1st and 2nd.
A `Ids=` query with no `SortBy` is **not stably ordered**, so `Limit` truncates an
arbitrary subset.

That means a caller whose own `Limit` is **below** its own id count cannot be
reproduced from a union at all — not because we would truncate differently, but
because there is no correct answer to reproduce. Such a caller **opts out entirely**.
Every request in the census has `Limit == its id count` or no `Limit`, so this costs
nothing.

The same finding is why the slice preserves the merged response's **relative order**
rather than re-ordering to the waiter's `Ids` order: any order is as faithful as the
server's own, and re-ordering would be a gratuitous behaviour change.

### 3.3 Absence is not `false` — the rule the ticket did not state

The ticket said `EnableUserData` / `EnableImages` union to `true` and `Fields` unions.
Union direction alone is not sufficient. `EnableUserData`, `EnableImages`,
`EnableImageTypes` and `ImageTypeLimit` are **restrictive**, and their **absence means
the permissive server default**. If caller A sends `EnableUserData=false` and caller B
omits it, unioning the values present yields `false` — and B, which expected user data,
is handed a **subset** of what it asked for.

So a restrictive param survives into the merged URL **only when every member of the
batch supplied one**; otherwise it is dropped and the server default applies. `Fields`
is the opposite — **additive**, absence asks for fewer fields — so it unions normally
and a member that omits it simply receives a superset.

Concretely, for the `{8, 9, 10}` batch: `EnableImages` unions to `true` (all three set
it), `EnableUserData` to `true`, `Fields` to `RunTimeTicks`, and `EnableImageTypes` /
`ImageTypeLimit` are **dropped** because only request 10 supplied them.

## 4. Result

Replaying the JELA-829 `ATTR-b1` capture at its recorded inter-arrival times through
the **shipped** `instantHomeBody()`:

| window | boot `Ids=` GETs |
| ------ | ---------------- |
| 0 ms   | 11 (inert)       |
| 150 ms | 8                |
| 250 ms | **6**            |
| 800 ms | 6                |

Matching JELA-829's field-union prediction (8 / 6). Default window is 250 ms.

Bytes, re-fetching both arms against the live server — the 11 original URLs against
the 6 merged ones:

|                       |  before |   after |                   delta |
| --------------------- | ------: | ------: | ----------------------: |
| uncompressed          | 298 051 | 270 028 |               −28 023 B |
| **gzipped, the wire** |  71 863 |  57 160 | **−14 703 B (−20.5 %)** |

Quoted compressed on purpose. JELA-785's lesson is that an uncompressed byte lever can
die under compression; this one survives it, and the fleet has JELA-727 response
compression on.

The `{8,9,10}` merge is the one worth checking rather than assuming, because it unions
`EnableImages` to `true` and drops `ImageTypeLimit`, so its body could have grown.
Measured: 37 530 B → 33 660 B uncompressed. It shrinks.

## 5. Safety

Every failure mode degrades to baseline, never to a wrong body. A non-2xx, an
unparseable body, a body with no `Items` array, or a rejected merged fetch **replays
every waiter on the real network** with its original URL (counters `bad` / `rep`).

- Never across base paths. `/Items?Ids=` and `/Users/{u}/Items?Ids=` are different
  routes and one ignores user data. The path matcher is **anchored whole-path**,
  deliberately not `fetchCoalesce`'s suffix test — a suffix test for `/Items` also
  matches `/Users/{u}/Items`. The batch key carries origin+path too, so this is
  guarded twice.
- `StartIndex` opts out unless 0: the offset would apply to the union.
- A `Request` object, a body, an `AbortSignal`, a non-GET, or a `Range`/conditional
  header opts out, exactly as `fetchCoalesce` already requires. Other headers go into
  the batch key and the leader's own init is reused verbatim for the merged fetch, so
  a merged request can never lose a caller's auth header.
- A mutation over fetch **or over XHR** dispatches pending batches at once, so a
  queued read cannot be overtaken by the write it preceded. Nothing cached is ever
  served here, so JELA-752's staleness argument does not apply — this is purely about
  read-before-write order.
- The merged URL is capped by **length**, not id count, because length is the actual
  constraint. Probed good to 5 214 chars / 144 ids on the live server; the default cap
  is 3 800, leaving room under the usual 8 KB proxy request-line limit. Exceeding it
  **splits** the batch; it never drops a waiter.

## 6. Flag surface

| key                              | default | meaning                                            |
| -------------------------------- | ------- | -------------------------------------------------- |
| `jellyfin.shell.idUnion`         | absent  | `'1'` installs the shim. Absent ⇒ never installs.  |
| `jellyfin.shell.idUnionWindowMs` | 250     | 0..2000. `'0'` stands the batcher down.            |
| `jellyfin.shell.idUnionMaxUrl`   | 3800    | 512..7000, merged-URL length cap.                  |
| `jellyfin.shell.idUnionPaths`    | —       | appends routes (each must start with `/`, 16 max). |

Counters: `window.__shellIU` `{on,w,m,seen,net,join,pass,cap,fl,rep,bad,err,ids,uids}`.
`ids`/`uids` are the requested-vs-distinct id counts — JELA-829's 339/144, measured
live.

**Its own flag on purpose.** It deliberately does not share
`fetchCoalesceDisabled`: the JELA-820 lesson is that a patch sharing a flag with
something flippable independently is not a dark deploy, it is a deploy timed by
someone else's ticket. A static guard in the test pins this.

**A flip cannot be a plain seeder.** The read site is in `instantHomeBody()`, which
runs at document-start, and the JSI channel only runs after the lite→SPA handoff — so
a channel-seeded opt-in flag arms **one boot late** (JELA-821 / JELA-827). When the
board flips this, it has to follow the JELA-827 shape: ship the read site default-ON
with an opt-**OUT** kill key, not seed an opt-in one.

## 7. Verification

`packages/shell-tizen/scripts/id-union.test.cjs` — 31 checks, extracting and driving
the **shipped** `instantHomeBody()` against a fake item pool that answers `Ids=`
queries the way §3's probes showed the live server does. Wired into
`packages/shell-tizen/package.json`'s `test` script.

The last check replays the real capture:
`packages/shell-tizen/scripts/fixtures/jela829-ids-burst.json` is the `ATTR-b1`
boot census with **host, `api_key` and item ids redacted** per the evidence policy —
the timings, the id counts, and the id **overlap** between requests are verbatim, which
is the part the result depends on. It asserts 339 ids / 144 distinct, that 11 GETs
collapse to ≤ 8, and that every one of the 11 waiters gets back exactly the ids it
asked for.

### What is proven, and what is not

| AC                                          | status                                                                                                                |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 1 — 11 → ≤ 8 at 250 ms                      | **simulated 11 → 6** against the shipped body + real capture. The AC asks for a **live same-shell A/B**: not yet run. |
| 2 — every waiter gets exactly its items     | **done** — unit tests with a fake pool, incl. all 11 capture waiters. The live assertion is still owed.               |
| 3 — card/section count unchanged at settle  | **not yet run** — needs a live boot pair.                                                                             |
| 4 — kill switch as a same-boot differential | **unit-proven** (key absent ⇒ not installed, all requests on the wire); the live differential is not yet run.         |

The live half needs a rig boot pair against a deployed shell and is tracked separately.
Nothing in the table above is a timing claim, so per JELA-805 the count claims survive
a dirty box — but they still have to be taken on a real boot before this closes.
