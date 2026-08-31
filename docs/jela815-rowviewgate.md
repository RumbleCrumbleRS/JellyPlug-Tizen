# JELA-815 — viewport-gated genre-row fetch (`jp815`)

**Date:** 2026-08-31 · **Parent finding:** JELA-813 (eleventh full Tizen 5.0
perf census) · **Status: merged DARK, fleet flip not yet requested.**

Measured on the JELA-112 virtual Tizen 5.0 rig against the LIVE production
shell `d41a3d7a` and the LIVE JSI channel. Four interleaved arms, fresh profile
per boot. **The endpoint is a request COUNT, never a timing** (JELA-805).

---

## 1. What JELA-813 found, and why it makes this safe

Ten prior perf runs measured boot, navigation, play, search, drill-down and
idle. None measured **scrolling the home**. Walking it top to bottom is 33
requests, 17 real — and every one of the 17 is the JELA-762 media-bar rotation
firing on its ~15 s timer whether you scroll or not.

**Zero requests are attributable to row hydration.** The entire home is built at
boot: 17 sections, 258 cards, **0 of them on screen** when the boot finishes,
16 of 17 sections below the fold, and the single section inside the 540 px
viewport rendering 0 cards. 76 requests / 263,586 B of home-row traffic, each
cross-origin and therefore each buying a preflight too.

That free destination is the whole argument. Moving a fetch into scroll time is
only a win if scroll time is idle, and JELA-813 is the measurement that says it
is. This ticket is not JELA-682 (which moved the genre burst *post-paint*, and
is confirmed still working), not JELA-745 (which decoupled row FETCH from the
debounced MOUNT), and not JELA-681 (which found "stream the rows" is a measured
null against firstCard). The lever here is **request count**, which is the
established cost model for this boot — latency is queueing, not per-request
slowness.

## 2. What ships

Two anchored textual patches against the live channel entries
(`packages/server-shell-drop/scripts/jsi-jp815-patch.mjs`, fail-closed on any
anchor that does not match exactly once):

| entry          | edit                                              | delta    |
| -------------- | ------------------------------------------------- | -------- |
| `tizen-compat` | install `JellyPlug.rowViewGate`                   | +1,921 B |
| `genre-rows`   | the 14-candidate fetch burst holds on that gate   | +206 B   |

### It is not an IntersectionObserver

The ticket suggested one. It cannot work: a genre row's DOM node does not exist
until its items have arrived, so there is nothing to observe. The observable
proxy is the **bottom edge of the home content that has been built**, which is
exactly where the deferred rows get appended — genre rows carry rank 51+ and
`style.order`, so they are always last.

### Release needs BOTH terms

1. **the user has scrolled at all.** Without this the gate false-opens during
   boot: at t+5 s the home is two sections tall, so its bottom edge is
   trivially within a lookahead of the viewport and the burst fires anyway.
   Scroll is detected three ways — `pageYOffset`, the scrolling element's
   `scrollTop`, and a drop in the first section's viewport-relative top —
   because JELA-813 proved `.page.homePage` reports `scrollHeight` 6450 >
   `clientHeight` 540 while `overflow-y: visible` makes it ignore `scrollTop`
   writes entirely. A probe keyed to any ONE mechanism gives a **FALSE NULL**.
   `getBoundingClientRect()` moves under all three, including a CSS transform.
2. **the built home's bottom edge is within `max(2 x innerHeight, 1080)` px of
   the viewport bottom.** Floored at 1080 so a 1080p panel — which shows ~2
   sections, not 1 — gets the same relative lookahead the 854x540 rig does.

`jsi-jp815-patch.test.cjs` asserts each term blocks release **on its own**
(cases 4c and 4d). A gate that released on scroll alone, or on geometry alone,
would pass a naive test.

**Fail-open belt:** after ~10 minutes of a home that is never scrolled the gate
releases anyway. A geometry probe that silently breaks on some future layout
must cost a late fetch, never a permanently missing row.

**Dark by default.** Nothing changes until `jellyplug.rows.viewgate` is `"1"`.
With the flag off (or `"0"`, the per-TV kill switch) `hold()` invokes its
callback synchronously and the shipped path runs verbatim — which is also the
AC4 differential.

## 3. Deploy state

Dark on the live JSI channel, verified at the wire (not from the config):

| artifact                        | evidence                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------- |
| config round-trip               | 105 entries, zero mismatches vs the POSTed body                                  |
| no foreign writer raced us      | live config re-GET byte-identical to our patched config across all 105 entries   |
| pre-image reconstruction        | stripping `/*jp815*/…/*jp815*/` reproduces the fetched base byte-for-byte        |
| `/JavaScriptInjector/public.js` | `jp815` x6, both patched entry bodies byte-present, 912,803 B                    |
| ES5                             | the whole served bundle parses at acorn `ecmaVersion: 5`                         |

**The off-by-one needed a THIRD save, not two.** [`jsi-config-save-off-by-one`]
says POST twice then verify the served bundle. Two POSTs left the bundle with
**zero** `jp815` occurrences even though the config round-tripped clean and the
bundle had visibly rebuilt (+158 B of somebody else's pending change). A third
POST landed it within 5 s. The rule that actually holds is **"POST until the
SERVED artifact carries your bytes"** — the count is not fixed at two.

## 4. Results

Fresh profile per boot, arms interleaved, all against `d41a3d7a`. `genre@boot`
counts GET **and** its CORS preflight, so the headline number cannot be quietly
halved.

| arm            | phase  | genre@boot | genre total | home-row@boot  | cold-boot reqs | cold-boot bytes | final sections | final cards |
| -------------- | ------ | ---------- | ----------- | -------------- | -------------- | --------------- | -------------- | ----------- |
| **OFF** (ctrl) | boot   | **28**     | 14 GET      | 80 / 313,911 B | 500            | –               | –              | –           |
| **OFF** (ctrl) | scroll | **28**     | 14 GET      | 87 / 343,933 B | 511            | 11,285,330      | 18             | 274         |
| **ON**         | boot   | **0**      | **0**       | 63 / 273,608 B | 479            | 11,205,097      | 10             | 114         |
| **ON**         | scroll | **0**      | 14 GET      | 58 / 276,953 B | 473            | 11,202,248      | **19**         | **290**     |
| **ON** (rep)   | scroll | **0**      | 14 GET      | 60 / 251,276 B | 478            | 11,178,498      | **19**         | **290**     |

- **AC1 — genre rows off the boot path: PASS, 28 → 0**, deterministic in every
  ON boot. Home-row requests at boot 87 → 58 and 80 → 63 on the matched pairs.
  **AC1 as literally written (76 → ≤30) is NOT met** — see §5.
- **AC2 — scrolling still renders everything: PASS.** The ON scroll arm ends at
  **19 sections / 290 cards**, identical to the JELA-813 baseline, with all 8
  genre rows populated. The gate released one D-pad step (~7 s) into the walk
  and the rows were present at the next step — no placeholder anywhere near one
  screenful of dwell.
- **AC3 — cold-boot request count drops: PASS.** OFF 500 / 511, ON 479 / 473 /
  478 — mean 505.5 → 476.7, **Δ ≈ −29**, against JELA-813's 498–512 baseline.
  The size of the drop is what the mechanism predicts (28 gated requests), which
  is the check that matters more than the n here. Cold-boot bytes 11,285,330 →
  11,178,498–11,205,097.
- **AC4 — kill switch as a DIFFERENTIAL: PASS.** The flag is `removeItem`-ed
  **pre-nav in every arm** and re-seeded only for ON (JELA-809 idiom), so the
  control is an explicit removal rather than an assumption about the channel.
  The OFF arm reports `gate flag=false held=0` — the gate is *present* and
  *disarmed*, and fetches all 14 candidates at boot exactly as today.

### The intervention proved it fired (protocol rule 4)

Every ON boot carries the gate's own counters, and the harness voids a capture
that does not:

```
ON  @boot end:    flag=true  held=1 fired=0 polls=48 scrolled=0 opened=0 why=null   geo.b= 4144
ON  @scroll end:  flag=true  held=0 fired=1 polls=61 scrolled=1 opened=1 why="near" geo.b=-2497
OFF @boot end:    flag=false held=0 fired=0 polls=0  scrolled=0 opened=0 why=null
```

`held=1 fired=0 scrolled=0` after 48 polls (~36 s) is the hold stated as a
counter: the burst was queued, the gate was armed, and it never opened because
nothing scrolled. The scroll-end read is the release stated as a counter, and
`why="near"` at **poll 61 of a 800-poll belt** is the load-bearing part — the
gate opened on the *geometric* term, not because the fail-open belt timed out.
An ON boot reporting `gatePresent=false`, `flag!==true`, or neither held nor
fired is discarded as VOID, not recorded as a null. The OFF arm has the
symmetric gate: fewer than 10 genre queries means the capture was truncated by
box load and is discarded.

Timing, for AC2: the burst fires at boot-end **+10.6 s**, i.e. inside the
second D-pad step's dwell, and step 2 already reads 19 sections / 290 cards.

## 5. What AC1's "76 → ≤30" would take, and why it is not here

Gating genre-rows removes 28 of the 76. Reaching ≤30 means deferring almost
every other below-the-fold section too — Top Picks (y=1,230), Watch It Again
(1,607), Latest Movies (1,964), Latest Shows (2,330), Because You Watched
(2,695), My List (3,060).

Those are a different problem, not more of the same one. Genre rows are safe to
defer because they are **always last**; the others render into ranks that place
them in the **middle** of the home, so a deferred fetch makes a row appear
*above* the user's current scroll position and shifts everything under them. On
a D-pad TV that moves the focused card out from under the user. Solving
mid-list insertion (reserve the slot, then fill it) is real work and belongs in
its own ticket.

## 6. Interaction with JELA-816

`genre-rows` fires **14 candidate queries to render 8 rows** — `F()` selects the
first `O`=8 candidates with at least `M`=6 items not already covered, so the
last 6 are fetched and discarded on a healthy library. That was found
independently while reading this entry and is **already fixed by JELA-816
(`jp816`, merged flag-dark `db0910a`)**; it is a win whether or not the user
scrolls, and it composes with this one — jp816 shrinks the burst, jp815 moves
what is left off the boot path.

**The two patchers are order-dependent, and jp815 must go first.** jp816's
`rows:fanout-open` anchor is a substring of jp815's `rows:hold` anchor; jp815
re-emits the fan-out verbatim so jp816 still matches afterwards, but jp816
rewrites the tail of jp815's anchor so the reverse cannot. Both directions fail
CLOSED with a named anchor error, so the hazard is a confusing message rather
than a corrupt entry, and the composition test pins the supported order.
Verified against the live channel: **jp816 applies cleanly on top of the
jp815-carrying config**, so the JELA-816 deploy is unblocked.

At the time of writing jp816 is merged but **not yet on the channel** (`jp816`
x0 in the served bundle), so none of the arms above are confounded by it.

## 7. Rollback

Re-POST the config with `/*jp815*/…/*jp815*/` stripped from both entries — the
test proves that reproduces the pre-image byte-for-byte. Because the flag is
dark, removing the entries is a true no-op for every TV; there is no latched
state to unwind (contrast JELA-789, where rollback had to be an active
*remover* because the seeder had already written a key).

Once the flag is flipped ON for the fleet, rollback becomes a seeder that
writes `"0"`, not a deletion.

## 8. Harness notes (`/tmp/jela815-rig/run815.mjs`, forked from `run813.mjs`)

Three things that cost a boot each, worth carrying forward:

- **A 60 s CDP `Runtime.evaluate` timeout is a quiet-box number.** At load ~20
  the M63 main thread starves (JELA-141) and an eval sits for minutes. The
  first control boot threw one away whose network census was already complete.
  Raise it, and analyse the captured `reqs` offline rather than re-running.
- **Chromium can take >24 s just to bind the CDP port** at load ~27. The
  inherited 120 x 200 ms startup wait is not enough on a contended box.
- **`shell.min.js` is cache-busted with `?t=<ms>` on some paths, not only
  `?v=<sha>`.** Keying provenance on `?v=` alone reported "provenance unproven"
  for a boot that had plainly fetched the prod shell over the prod origin with
  status 200. JELA-749 wants the ORIGIN and STATUS asserted; treat the sha as a
  bonus, not the only accepted proof.
