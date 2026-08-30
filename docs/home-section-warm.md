# The cold-box penalty on the home rows, and the warmer (JELA-793)

Split out of JELA-731's acceptance run, where it was the one part of that
ticket's story a user still feels and the one lever left on its own list.

## What is actually cold

A server that has been idle answers its first `/HomeScreen/Section/*` request
**10–25x slower than its own warm median**. That much was in the ticket. What
the ticket could not say — and what decides the shape of the fix — is _where_
the cost lives.

It is not the section, and it is not ASP.NET. Measured on production with the
JELA-692 pre-flight CLEAR, every section probe carrying `Cache-Control:
no-store` (mandatory: `/HomeScreen/Section/*` sits behind the JELA-732 cache
with a 30 s TTL, and a repeat without `no-store` times a memo rather than a
build). Server-side `x-response-time-ms`, one cold burst against the warm
medians from the next four cycles in the same window:

| probe                                   | first call after idle | warm median |    ratio |
| --------------------------------------- | --------------------: | ----------: | -------: |
| `/System/Info`                          |               1.52 ms |      1.4 ms | **1.0x** |
| `/Items?Limit=1&IncludeItemTypes=Movie` |                442 ms |       63 ms | **7.0x** |
| `Section/BecauseYouWatched`             |                208 ms |      7.6 ms |  **27x** |
| `Section/LatestShows`                   |              1,761 ms |       84 ms |  **21x** |
| `Section/LatestMovies`                  |                200 ms |       71 ms |     2.8x |
| `Section/ContinueWatchingNextUp`        |                943 ms |      105 ms |     9.0x |

Two readings do the work here.

`/System/Info` **does not move**. It is authenticated, it goes through the same
Kestrel, the same middleware stack and the same auth pipeline, and it sits at
its 1.5 ms floor whether the box has been idle for two minutes or twenty. So
none of the cold cost is JIT of the request pipeline, TLS, auth, or routing.

The **trivial one-row item query pays 7x**. It touches no section, no
Home Screen Sections code, and nothing any recent change went near. So the
cost is in the shared library-query path, and every home row pays it at once
because they all sit on top of that path. This is why "warm LatestShows"
is the wrong fix and why the JELA-732 cache cannot help: its TTL is 30 s, so
the first boot of the day is always a miss.

Note also that `LatestMovies` reads only 2.8x here while `BecauseYouWatched`,
served _after_ it, still reads 27x. The warm state is **not one shared switch
that any query flips** — serving four sections did not warm the fifth. The
warmer therefore reads both of the item types the "Latest" rows scan, rather
than one token query.

## And it decays in about a minute

The ticket was written from a "quiet for hours" sample, which made this look
like a once-a-morning problem to be solved with a nightly or hourly job. It is
not. Walking the quiet interval up, each checkpoint carrying its own in-window
warm reference so no ratio depends on a baseline taken half an hour earlier:

| idle before the probe | first call | same window, second call |    ratio |
| --------------------: | ---------: | -----------------------: | -------: |
|                  30 s |    65.2 ms |                  63.3 ms | **1.0x** |
|                  60 s |     164 ms |                  62.6 ms | **2.6x** |
|                 120 s |     117 ms |                  86.2 ms |     1.4x |
|                 300 s |     751 ms |                  98.2 ms | **7.6x** |

(The 120 s point sits below the 60 s one; single samples at this noise level
are not monotonic. The onset and the saturation are the readable parts.)

**This is the number that sets the cadence, and getting it wrong is the one way
to ship this that still looks enabled from the settings page.** A warmer on an
hourly trigger — the obvious design, and the one the ticket's "scheduled
warm-up" wording suggests — would leave the box cold for 59 of every 60
minutes and miss essentially every real boot.

## What a warm pass has to do — measured, after the cheap version failed

The first version of this warmed the cheapest thing that plausibly shared the
substrate: two user-less ordered item scans, same rows, same indexes, no user,
no DTOs, no images. **It was a clean null**, and it is worth recording exactly
how convincing it looked, because the argument for it is still a good argument.

Holding the quiet window at 300 s and varying only the treatment applied
immediately before a **concurrent** home fan-out (server-side
`x-response-time-ms`, ms):

| treatment before the fan-out               | LatestShows | LatestMovies |    CWNU |    BYW |
| ------------------------------------------ | ----------: | -----------: | ------: | -----: |
| nothing (control)                          |       2,199 |        1,528 |   2,317 |    635 |
| nothing (control, repeat)                  |       1,823 |        1,526 |   1,839 |    560 |
| 2 ordered item scans, **no user**          |       2,058 |        1,587 |   2,109 |    581 |
| the same 2 scans, **with a user**          |       1,362 |        1,103 |   1,336 | **13** |
| **build the LatestShows row for one user** |     **140** |      **141** | **172** | **21** |
| in-window warm reference                   |        ~150 |         ~140 |    ~180 |    ~15 |

The user-less scans moved nothing. Adding a user is a real lever — it fixes
`BecauseYouWatched` outright, which is almost entirely user-data work — but it
only takes ~40% off the three big rows. Building the row gets all of it.

Two further results are what make that affordable, and changing either
invalidates the cost model:

- **One section carries the other three.** Warming only `LatestShows` left the
  whole fan-out at 140/141/172/21 ms. So the warmer does not need to reach the
  other three sections, which matters because they belong to a third-party
  plugin and reaching them would mean loopback HTTP with a stored credential.
- **One user carries the household.** Warming as user _Test_ and then firing
  the fan-out as user _Matt_ read 148/124/135/15 ms. The expensive cold state
  is the shared item, DTO and image work; the per-user part is small.

## The fix

`SectionWarmService`: a background timer that, every
`SectionWarmIntervalSeconds`, builds the `LatestShows` row for **one** user via
`LatestShowsFastPath.TryBuild` — the same call the JELA-731 middleware makes to
answer a real request — and discards the result. Users are walked round-robin,
one per pass, so whatever per-user state is left over is covered within a lap
without paying 11x per pass to redo the shared work.

Off by default (`0`); the field is both the enable and the kill switch, is
re-read on a 10 s tick, and so takes effect without a restart.

When `TryBuild` steps aside — `HideWatchedItems` on or unreadable, or a user
with no TV library — the pass falls back to the user-scoped ordered scans,
which the table above puts at roughly 40% of the win rather than 0%.

**Why a timer and not an `IScheduledTask`.** This plugin already owns two
scheduled tasks, so a third was the obvious home for this, and it is the wrong
one. The JELA-692 pre-flight gate blocks every production measurement in this
programme while any scheduled task is non-Idle. A warmer on a 30 s cadence
registered as a task would hold the gate in BLOCKED for a large fraction of
every hour — taking down the instrument that every performance conclusion here
is quoted against — and would write a task-history row per pass. A timer is
invisible to both. `scripts/section-warm.test.cjs` pins this, because the next
person to find a bare timer in a plugin with two scheduled tasks will
reasonably want to tidy it into a third.

**Cost.** One row build is ~150 ms; at a 30 s interval that is ~2,880 passes a
day and about **0.5% of one core**. Overlapping passes are skipped rather than
queued, so a box that is already struggling cannot have the warmer pile onto
it.

## What it actually bought — production acceptance, 2026-08-28

Measured after the flip with the kill switch as the only variable, arms
interleaved, every arm carrying its **own** in-window warm reference (median of
three immediate repeats) so no ratio leans on a baseline from another window.
Quiet windows gated on `/Sessions` (gate D) rather than on a `sleep`, all probes
`Cache-Control: no-store`, `userId` as a GUID, all rows HTTP 200, the three
sections fired concurrently:

| arm                          | quiet |          LatestShows |         LatestMovies | ContinueWatchingNextUp |
| ---------------------------- | ----: | -------------------: | -------------------: | ---------------------: |
| OFF (control), cold-position | 488 s | 2,652 ms / **9.07x** | 2,497 ms / **7.94x** |       3,697 ms / 8.75x |
| ON, cold-position            | 458 s |   339 ms / **1.48x** | 1,223 ms / **5.34x** |       2,412 ms / 6.89x |
| ON, cold-position            | 304 s |   189 ms / **0.81x** |   673 ms / **2.75x** |       1,589 ms / 4.10x |

The first `LatestShows` of a quiet morning goes from **2,652 ms to 189–339 ms**.
Idle cost is unmeasurable: the JELA-692 gate B median read 1.33/1.36 ms with the
warmer running against 1.33–1.50 ms with it disabled, and gate A stayed
all-tasks-Idle throughout, which is the timer-not-`IScheduledTask` decision
holding at a 30 s cadence.

**Two things this measurement corrected, both worth knowing before changing the
warmer.**

_One section does not carry the other three._ The A/B that chose this design
concluded it did. It does not replicate: `LatestShows` is the row that goes
properly warm, while `LatestMovies` sits at 2.75–5.34x and
`ContinueWatchingNextUp` at 4.10–6.89x. Partial carry is real — those rows are
well under the control's 8–9x — but the shared substrate is not the whole story.

_The spread between the two ON arms is the user rotation, not noise._
`NextUser` warms one user per pass, so at 30 s over 11 users any given user is
warmed once every 5.5 minutes and a boot lands somewhere in 0–330 s of that
user's staleness. The 673 ms arm landed early in the cycle; the 1,223 ms arm
landed late. Anyone tempted to add work per pass should first measure whether
shortening the rotation is what closes the gap.

## Running the measurement again

Everything above is reproducible with the harnesses in the JELA-793 issue
thread (`preflight.sh`, `probe.sh`, `burst.sh`, `decay.sh`, `ab.sh` — JEL-141
keeps them out of the tracked tree). Two rules that are not optional:

1. **`Cache-Control: no-store` on every section probe**, or you are timing the
   JELA-732 cache. A hit reads 0.01–0.14 ms and carries no `fastpath` marker.
2. **Fire the sections concurrently, not in sequence.** Only the first URL in a
   sequence is genuinely "the first request after quiet"; the ones behind it
   measure a box the first one already warmed. A booting TV fires them
   together, so the probe must too.
3. **`userId` must be the GUID from `/Users`.** A username model-binds to a
   `Guid` and returns HTTP 400 — and the 400 still returns a cold-vs-warm
   `x-response-time-ms` (610 ms cold, 1.3 ms warm), so a probe pointed at a
   name produces a whole timing table that measures ASP.NET's validation path.
   Print the status and the body size on every row; a real `LatestShows` row is
   ~18.6 KB and the 400 body is 247 B.
4. **Hold a gate-D-clean quiet window** — no other client on the box, _and_ no
   requests from your own harness — for at least 450 s. A concurrent boot rig
   fanning out the home rows keeps the substrate warm and turns the control arm
   into a null; JELA-692's gate B cannot see it. See
   `docs/perf-measurement-protocol.md`.

Related: `docs/latest-shows-row-cost.md` (JELA-731),
`docs/homescreen-section-cache.md` (JELA-732),
`docs/perf-measurement-protocol.md` (the JELA-692 gate).
