# JELA-820 — reserve-then-fill for the mid-home rows (`jp820`)

**Date:** 2026-08-31 · **Parent finding:** JELA-815 · **Status: deployed DARK on
the live JSI channel (`jellyplug.rows.reservefill`, seeded nowhere).
AC2 PASSES at 0 px (§5d) and AC4 PASSES as a same-boot differential (§5f).
AC1 is NOT settled and its old 61 → 26 pair is stale — the production shell moved
mid-ticket (§5e). AC3 not measured.** §6 is what is left.

Measured on the JELA-112 virtual Tizen 5.0 rig against the LIVE JSI channel.
**The endpoint is a request COUNT, never a timing** (JELA-805). §5 was measured
on production shell `d41a3d7a`; §5d–§5f on `b358bd10` after JELA-823/824/826 and
JELA-817 landed — **the shell sha is quoted per section on purpose, because the
two are not comparable**.

---

## 1. Why this was a different problem from jp815

jp815 gated the genre block and took 28 of the 76 boot home-row requests off
the boot path. Genre rows are safe to defer because they are **always last** —
rank 51+ plus `style.order`, so a late arrival appends below everything.

The other producers render into ranks that put them **mid-home**. Defer one of
those fetches and the row materialises _above_ the user's scroll position and
shifts everything under it; on a D-pad TV that moves the focused card out from
under their thumb.

So: **reserve the slot, then fill it.** Each producer mounts a placeholder
section at its own rank at boot (zero network) and holds only the _fetch_. The
document height is final from boot and hydration is an in-place card swap.

## 2. Where the remaining 48 requests actually live

Before writing anything, the JELA-815 control capture was re-read and every
boot home-row request attributed to a producer. That changes the ticket's
framing, so it is recorded here:

| bucket                  | reqs at boot | owner                | reachable by reserve-then-fill? |
| ----------------------- | -----------: | -------------------- | ------------------------------- |
| genre fan-out           |           28 | `genre-rows`         | already gone (jp815)            |
| card hydration (`Ids=`) |           16 | downstream of a row  | only by deferring the parent    |
| `/HomeScreen/Section/*` |            8 | Home Screen Sections | **no** — no JSI entry           |
| taste profile           |            8 | `match-score`        | **no** — renders no row         |
| `watch-it-again`        |            6 | JSI                  | yes                             |
| `top-picks`             |            2 | JSI                  | yes                             |
| `my-list`               |            2 | JSI                  | yes                             |
| `/Items/Latest`, other  |            8 | stock web client     | **no**                          |

**The three JSI producers this ticket can reach are only 10 requests directly.**
The prize is larger than 10 because deferring a row also defers its card
hydration — measured below at −35 home-row requests, not −10.

## 3. What ships

Four anchored textual patches
(`packages/server-shell-drop/scripts/jsi-jp820-patch.mjs`, fail-closed on any
anchor that does not match exactly once):

| entry            | edit                                                | delta    |
| ---------------- | --------------------------------------------------- | -------- |
| `tizen-compat`   | extend jp815's gate with `holdEl`/`reserve`/`stubs` | +2,672 B |
| `top-picks`      | reserve the slot, hold the pool fetch               | +457 B   |
| `watch-it-again` | same                                                | +451 B   |
| `my-list`        | same                                                | +435 B   |

### The placeholder is built by the producer's own code

Each producer already owns a `build` / `fill` / `insert` trio. The patch calls
those same three with neutral stub items, so the placeholder is structurally
identical to the hydrated row **by construction** rather than by a hardcoded
height. Hydration then takes the shipped "swap in place" branch — the one that
already exists for revalidating a cached row — because `find()` returns our
placeholder.

Stub items carry no `imageTag`, and every card builder guards its poster on
exactly that, so a placeholder issues **zero requests**. Stub anchors lose their
`href` and gain `tabindex="-1"` so D-pad focus cannot land on a blank card; that
sanitation is self-cleaning, because the fill replaces the whole
`.itemsContainer`. Nothing is left on the _section_ that could survive hydration
and make a live row unclickable.

### The gate is per-element, and still needs the scroll term

jp815 could not observe its target, so it watched the built home's bottom edge
as a proxy. Reserving the slot removes that limitation, so `holdEl` measures the
real element — **a far row stays held while a near one hydrates**, which jp815
could not do.

The scroll term survives for a _relocated_ reason: a placeholder mounted while
the home is still building sits temporarily high, so geometry alone false-opens.
Unlike jp815 the wait is free, because the slot is already reserved.

Lookahead is **one screenful**, relative to `innerHeight`, so a 1080p panel gets
1080 px against a correspondingly taller layout — no floor needed.

## 4. jp820 needed its OWN flag, and finding that out was the day's real lesson

The first cut shared `jellyplug.rows.viewgate` with jp815, on the theory that
the two are halves of one behaviour.

**That was wrong, and it went live before it was caught.** Between the first
config fetch (105 entries) and the deploy (106 entries), a sibling run landed
JELA-815's fleet flip: a `/*jp815seed*/` channel entry that writes
`viewgate="1"` on every TV unless it is `"0"`. Sharing the flag therefore put
jp820 **live on the fleet the instant it reached the channel** — no dark period,
no board flip, and the 21 px shift in §5 riding along with it.

It was caught by the OFF arm: the control reported `flag=true`, `reserved=3`,
`held=3` — identical to the ON arm. The VOID gate refused the capture rather
than reporting a differential that did not exist. jp820 was stripped from the
channel (`jp820 x0` in the served bundle, verified) before anything else.

> **A patch is only dark if its OWN key is absent.** Sharing a flag with a patch
> that can be flipped independently is not a dark deploy — it is a deploy timed
> by somebody else's ticket.

jp820 now carries `jellyplug.rows.reservefill`, seeded nowhere. Arming needs
**both** keys; jp815's `"0"` still kills both halves, because a slot reserved
behind a gate that is off would never be filled.

The same discovery breaks the inherited OFF-arm recipe: removing
`viewgate` pre-nav no longer produces a control, because the page writes it
straight back. The harness now strips and asserts **both** keys.

## 5. Results

One matched pair, same rig, same shell `d41a3d7a`, fresh profile per boot, flag
stripped pre-nav in **both** arms and re-seeded only for ON (JELA-809 idiom).

|                                    | **OFF** (control) | **ON**                  |
| ---------------------------------- | ----------------- | ----------------------- |
| `viewgate` / `reservefill` at boot | `"1"` / absent    | `"1"` / `"1"`           |
| gate820 `flag` / `gate815`         | `false` / `true`  | `true` / `true`         |
| slots reserved                     | **0**             | **3**                   |
| held @boot → fired @scroll         | 0 → 0             | **3 → 3**, `why="near"` |
| **producer requests at boot**      | **10**            | **0**                   |
| producer requests, whole session   | 10                | 10                      |
| **home-row requests at boot**      | **61**            | **26**                  |
| home-row bytes at boot             | 260,592 B         | **149,282 B**           |
| total requests (boot + scroll)     | 527               | 528                     |
| final sections / cards             | 17 / 258          | **19 / 290**            |

- **AC1 — home-row requests at boot ≤ 30: PASS at 26** (from 61). All three
  producers contribute **0** at boot and all 10 of their requests still happen,
  moved into scroll time. The drop is −35, not −10, because deferring a row also
  defers its card hydration (26 → 6 in that bucket). Note the control is 61, not
  the ticket's 76: jp815 is now fleet-live, so its 28 are already gone from
  _both_ arms.
- **AC2 — no section moves more than 8 px: FAIL at 21 px.** See below.
- **AC3 — total cold-boot request count: NOT MEASURED.** Both arms here are
  _scroll_-phase runs, so the deferred work happens inside the same capture and
  the totals are necessarily a wash (527 vs 528). AC3 needs `boot`-phase arms,
  which were not run.
- **AC4 — kill switch as a DIFFERENTIAL: PASS.** The control reports the gate
  **present and disarmed** (`gate820.flag=false` while `gate815=true`), reserves
  nothing, and fetches all 10 producer requests at boot exactly as today.

### The intervention proved it fired

```
ON  @boot   flag=true gate815=true reserved=3 held=3 fired=0 polls=22 scrolled=0 why=null
ON  @scroll flag=true gate815=true reserved=3 held=0 fired=3 polls=33 scrolled=1 why="near"
OFF @boot   flag=false gate815=true reserved=0 held=0 fired=0 polls=0  scrolled=0 why=null
```

`why="near"` at **poll 33 of an 800-poll belt** is the load-bearing part: the
gate opened on the _geometric_ term, not because the fail-open belt timed out.
An ON boot that reserves nothing is discarded as VOID, not recorded as a null.

### AC2, measured — and the 20 px that fails it

Section tops relative to the **first** section (which removes container padding
drift), placeholder state vs hydrated state, from the ON arm:

|     # | section                       | boot | after |           Δ | h boot → after |
| ----: | ----------------------------- | ---: | ----: | ----------: | -------------- |
|     0 | Top 10 Today                  |    0 |     0 |      **+0** | 335 → 335      |
|    10 | Continue Watching / Next Up   |  359 |   359 |      **+0** | 349 → 349      |
|     1 | **Top Picks** (reserved)      |  732 |   732 |      **+0** | **333 → 353**  |
|     2 | **Watch It Again** (reserved) | 1089 |  1109 |         +20 | 333 → 333      |
|     9 | Latest Movies                 | 1446 |  1466 |         +20 | 341 → 341      |
|     7 | Latest Shows                  | 1811 |  1832 |         +21 | 341 → 341      |
| 8/6/5 | Because You Watched × 3       |    … |     … | +20/+20/+21 | 341 → 341      |
|     3 | **My List** (reserved)        | 3273 |  3293 |         +20 | **333 → 353**  |

**Worst |Δ| = 21 px, against an 8 px budget — AC2 FAILS.** Reproduced
identically on a second independent boot (`ONS`: same +20/+21, same heights).

Read the table carefully, because the failure is narrower than the headline:

- **Nothing above a reserved slot moves at all** (Δ+0). The property that
  actually protects a D-pad user's focus holds.
- The entire shift is one cause: the **top-picks placeholder is 20 px shorter
  than its hydrated form** (333 → 353), and that 20 px propagates to every
  section below it. My List has the same 333 → 353 growth, but sits above only
  the genre rows, which append last anyway.
- Without jp820 the same deferral would shift content by a **whole row**
  (333–353 px). 21 px is a 94% reduction. It is still not ≤ 8 px, and the AC is
  the AC.

A zero-height node (index 4, the genre-rows anchor) reports a 5,464 px "move".
It has `h=0` in both states, cannot shift anything, and is excluded — a future
AC2 probe must skip zero-height sections or it reports a spurious failure.

### 5b. The 20 px, diagnosed — it is a CSS clamp, not the stub markup

The first reading of the table above was wrong in a way worth recording:
`watch-it-again` hydrating at exactly 333 → 333 was taken as evidence that "the
stub is wrong for one card kind, not in general", and the proposed fix was to
convert the stubs to the card builders' poster branch.

Both halves of that are refuted by the shipped CSS.

**The poster branch cannot be the cause.** `.jp-picks-card .cardImageContainer`
(and the `again` / `my-list` twins) take their height entirely from
`padding-top:150%`, and BOTH the poster `<img>` and the `--noart` fallback
`<div>` are `position:absolute`. The two branches are byte-identical geometry, so
swapping the stub onto the poster branch would have moved nothing — one rig boot
spent to learn that. (`--wide` drops to `56.25%`, i.e. shorter, so a non-wide
stub is the tall case there too.)

**The actual cause is one line-clamp rule:**

```css
.layout-tv .jp-genre-row  .jp-genre-card   .cardText,
.layout-tv .jp-picks-row  .jp-picks-card   .cardText,
.layout-tv .jp-again-row  .jp-again-card   .cardText,
.layout-tv .jp-my-list    .jp-my-list-card .cardText
  { white-space:normal; display:-webkit-box; -webkit-box-orient:vertical;
    -webkit-line-clamp:2; overflow:hidden }
```

A card title is **clamped** at two lines but free to occupy **one**. A row is
therefore one line (20 px) taller as soon as ANY card in it has a title that
wraps. Stub names are `U+00A0` and never wrap, so a placeholder is always the
one-line form — and every number in the table follows:

| row            | placeholder | hydrated | why                                       |
| -------------- | ----------: | -------: | ----------------------------------------- |
| top-picks      |         333 |      353 | some title wraps                          |
| my-list        |         333 |      353 | primary is `sub`, secondary is `name`     |
| watch-it-again |         333 |      333 | no title happened to wrap — **data luck** |

So `watch-it-again` passing was never evidence of correctness. The row height is
a **function of the items**, and a placeholder cannot know them. No stub content
fixes that.

### 5c. Fix: reserve the row's TALLEST state, not the placeholder's

`pin820` measures the placeholder's natural height plus `TEXT_LINE_SLACK` (2)
times the height of one rendered `.cardText` — read off the placeholder's own
first `.cardText`, whose content is a single `U+00A0` and is therefore exactly
one line — and writes the sum as an inline `min-height` on the **section**.

- Two lines is the exact worst case, not a guess: every producer builds at most
  two `.cardText` rows per card, and each is clamped at 2.
- The **section** is the right node because `fill` replaces the whole
  `.itemsContainer`; a reservation on the container would be discarded by the
  swap it is supposed to survive. This is the one thing jp820 deliberately
  leaves behind on a surviving node (contrast `pointer-events:none`, which must
  never be left there).
- Measuring the live node beats any constant: it tracks font-size, the panel's
  vw-derived card width, and whatever the theme does to line-height.
- The value is a running **maximum** kept on the node as `data-jp820h`, refreshed
  at mount and on every poll, with the existing `min-height` cleared first so the
  reservation can never feed back into its own input. The theme CSS is injected
  by another channel entry, so a measurement taken before it lands
  **under**-reserves — degrading to today's behaviour — rather than compounding.

Hydrated content is `<=` the reservation by construction, so the section's height
is unchanged across the swap and nothing below it moves.

**The test fixture was why this shipped.** `jsi-jp820-patch.test.cjs` set
`a.h=300` on every card; a fixture that *declares* card height cannot see a
height that *depends on the items*, so it passed while the rig measured 21 px.
Card height is now derived from the card's `.cardText` children with the two-line
clamp modelled, and the fake pool returns one wrapping title. With `pin820`
neutered the suite fails with `AC2: section 4 moved 20 px` — the production
number.

### 5d. AC2 re-measured: **0 px**

Matched pair `ON3` / `OFF3`, shell **`b358bd10`** (not the `d41a3d7a` the numbers
in §5 were taken on — see §5e).

```
 #  section (hydrated)                boot  after  delta   hB   hA  ph     reserved
 0  Top 10 Today                         0      0     +0  335  335 -      -
 1  Top Picks for Test                 732    732     +0  401  401 near   401px
 2  Watch It Again                    1157   1157     +0  401  401 near   401px
 3  My List                           3409   3409     +0  401  401 near   401px
 5  Latest Shows                      1948   1948     +0  341  341 -      -
 6  Because You Watched Cars          2313   2313     +0  341  341 -      -
 7  Latest Movies                     1582   1582     +0  341  341 -      -
 8  Because You Watched The Proposal  2679   2679     +0  341  341 -      -
 9  Because You Watched World War Z   3044   3044     +0  341  341 -      -
10  Continue Watching / Next Up        359    359     +0  349  349 -      -
```

**Worst |Δ| = 0 px against an 8 px budget — AC2 PASSES.** The reserved rows report
the same height in both states (401 → 401) where they previously grew 333 → 353.

Two things make this readable as a real pass rather than a quiet one:

- All three rows released on the **geometric** term (`why="near"`), not the
  fail-open belt, with `reserved=3 pinned=3 fired=3`.
- **Zero** sections were still marked `ph` in the after-state. A truncated settle
  leaves the placeholders in place and every Δ trivially 0 — `ac2.mjs` now VOIDs a
  capture with that signature rather than printing PASS.

AC2 is a **within-capture** comparison, so unlike §5e it is unaffected by the
shell moving between runs.

**Known slack.** The reservation is 401 px where the hydrated row is 353 px: about
48 px of reserved space per gated row. `pin820` adds two whole `.cardText` boxes
(34 px each), but a box is one 20 px line **plus 14 px of padding**, so true
worst-case growth is 2 × 20 = 40 px and the reservation over-shoots by 28 px. A
tighter version would read `getComputedStyle(cardText).lineHeight`. Deliberately
NOT shipped: the conservative version is measured at 0 px, the tighter one is not,
and under-reserving reintroduces exactly the shift this ticket removes. It belongs
in flip review, not in an unmeasured commit.

### 5e. AC1 is NOT settled, and the old 61 → 26 pair is stale

`ON3` ran on shell **`b358bd10`**; §5's 61 → 26 was measured on **`d41a3d7a`**.
JELA-823/824/826 and JELA-817's `bitrateCache` seeder have landed since. A delta
against the old arm would be a fabrication, so here is the fresh pair only:

| bucket, at boot | OFF3 | ON3 |
| --------------- | ---: | --: |
| top-picks + watch-it-again + my-list | **10** | **0** |
| hss-native | 12 | 14 |
| card-hydration | 22 | 26 |
| match-score | 8 | 8 |
| other-row | 6 | 6 |
| **home-row total** | **58** | **54** |

The producers come off the boot path completely (**10 → 0**, and the three buckets
are absent from `ON3`'s boot census entirely) — that is AC4, below. But the
home-row total moves only **58 → 54**, because in the ON arm `card-hydration`
(+4) and `hss-native` (+2) are HIGHER.

The likely mechanism is that deferring the producers frees boot concurrency, which
the rest of the fan-out immediately consumes, so more of it lands inside the fixed
45 s settle. That is a redistribution, not a regression — but it also means
**"home-row requests at boot" is not a clean endpoint at n=1 per arm**, because the
settle window truncates a variable amount of work and the two boots ran at
different load (5.77 vs 10.55). AC1 needs `boot`-phase arms with repeats, and the
hypothesis above is what they should be designed to separate.

`OFF3`'s scroll leg additionally stalled (10 sections at boot, still 10 at the
end; `lastPos` frozen at −1298 after two steps) because without the reserved slots
and with the genre rows never arriving the home is barely taller than the
viewport. That costs nothing here — every number above is a **boot**-phase
measurement, taken before the first key — but it is why `OFF3` must not be read as
a scroll-phase result.

### 5f. AC4, as a same-boot differential

`OFF3` had `jellyplug.rows.reservefill` **removed pre-nav and not re-seeded**
(`fl820=null`), with jp815's flag left on so only jp820's half changed:

```
OFF3  gate820: flag=false reserved=0 pinned=0 fired=0 polls=0   producers @boot 10
ON3   gate820: flag=true  reserved=3 pinned=3 fired=3 why=near  producers @boot  0
```

jp820 is completely inert with its key absent, and all ten producer requests are
back on the boot path exactly as they are today. **AC4 PASSES.**

## 6. What is left, precisely

1. **Settle AC1 and measure AC3** with `boot`-phase arms
   (`run820.mjs <tag> 1 1 boot`), repeated, and designed to separate the
   redistribution effect in §5e — the question is whether the 10 producer requests
   actually leave the boot or are simply replaced by fan-out that would otherwise
   have landed later. A scroll-phase total is necessarily a wash because the
   deferred work lands inside the same capture.
2. Decide the `getComputedStyle().lineHeight` tightening in §5d.
3. Then request the fleet flip for `jellyplug.rows.reservefill`.

## 7. Rollback

Re-POST the config with `/*jp820*/…/*jp820*/` stripped from all four entries —
`patchConfig` asserts that reproduces the pre-image byte-for-byte, and it was
exercised for real during this run (§4). Because `reservefill` is seeded
nowhere, removal is a true no-op for every TV; there is no latched state to
unwind. Once the flag is flipped for the fleet, rollback becomes a seeder that
writes `"0"`, not a deletion.

## 8. Harness notes (`/tmp/jela820-rig-f1f7aaf3/run820.mjs`, forked from `run815.mjs`)

- **Namespace the rig dir and ports per RUN_ID.** The fork inherited
  `RIG = "/tmp/jela815-rig"`; two heartbeats sharing one rig dir corrupted each
  other's profiles in JELA-813.
- **The static server is not started by the harness.** A missing one surfaces as
  `POISONED: attached to chrome-error://chromewebdata/`, which reads like a
  navigation bug rather than a missing dependency.
- **`lsPost` is a list of `[key, length]` pairs, not a dict.** A `'x' in dict`
  style filter over it silently returns nothing, which very nearly turned "the
  flag is present" into "the flag is absent" and sent the §4 investigation after
  a phantom. Check the shape before believing an empty result.
- Measure AC2 against the **first section**, not the container: the container's
  own top drifts by ~12–32 px between the two captures, which shows up as a
  uniform phantom shift on every row.
