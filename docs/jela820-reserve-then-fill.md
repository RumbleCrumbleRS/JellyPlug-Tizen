# JELA-820 — reserve-then-fill for the mid-home rows (`jp820`)

**Date:** 2026-08-31 · **Parent finding:** JELA-815 · **Status: deployed DARK on
the live JSI channel (`jellyplug.rows.reservefill`, seeded nowhere). AC1 and AC4
PASS. AC2 failed at 21 px on the first cut; §5b diagnoses it and §5c is the
fix.** §6 is what is left.

Measured on the JELA-112 virtual Tizen 5.0 rig against the LIVE production
shell `d41a3d7a` and the LIVE JSI channel. **The endpoint is a request COUNT,
never a timing** (JELA-805).

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

## 6. What is left, precisely

1. **Measure AC3** with `boot`-phase arms (`run820.mjs <tag> 1 1 boot`), which is
   the only phase where a cold-boot total is meaningful — a scroll-phase total is
   necessarily a wash (527 vs 528) because the deferred work lands inside the
   same capture.
2. Then request the fleet flip for `jellyplug.rows.reservefill`.

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
