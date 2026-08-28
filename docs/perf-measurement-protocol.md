# Boot-perf measurement protocol (JELA-690)

Rules for any load-time A/B on this project. They are not style preferences:
each one exists because it was violated and produced a published number that
was wrong.

Companion to `docs/boot-baselines.md`, which holds the baselines themselves.
The harness that enforces this protocol lives outside git (JEL-141 guard) —
see the JELA-690 issue thread.

## Why

JELA-690 re-ran an **identical** baseline arm about 50 minutes after the
first one — same rig, same server, nothing changed — and measured **+89% on
firstCard**. Every experimental arm in that sweep landed inside the drift
band, including one that blocked 5.77 MB and one that blocked nothing.

Separately, JELA-680 ran arms in blocks (`A×5`, `B×5`, `C×5`). Arm C was
later proved to be a **no-op** — the coalescer it enabled only shares requests
already in flight, its TTL defaulted to 0, and the two request waves it
targeted are sequential, so it recorded zero hits. It measured **+54% to
+117%**.

Four investigations in a row (JELA-432, JELA-433, JELA-435, JELA-41) produced
a large, correctly-measured number that turned out not to be on the exclusive
critical path. That is not four unlucky hypotheses. It is an instrument whose
noise floor sits above the effects being hunted, so every hypothesis returns
"inconclusive" and gets written up as a kill. An instrument that cannot see a
500 ms win cannot see a 500 ms regression either.

## The rules

### 1. Interleave the arms. Never run them in blocks.

Round-robin one boot per arm per cycle, and shuffle the order within the
cycle. Block ordering confounds arm identity with arm order, which converts
slow machine drift into a fake effect.

This has to be a property of the runner, not something each investigation
remembers. In the JELA-690 harness, block ordering is not expressible.

### 2. Analyse within-cycle pairs, not pooled medians.

Interleaving only helps if the statistics use it. Comparing the median of all
A boots against the median of all B boots throws the pairing away and lets
between-cycle drift back into the estimate.

Take the difference **inside each cycle**, then summarise those differences.
Both arms of a cycle saw the same box load, the same server state and the same
moment in the session, so everything shared cancels.

Report two scales, because the two dominant noise sources differ in kind:

- **paired difference (ms)** for additive effects — a stall, an extra request;
- **paired log-ratio (%)** for multiplicative ones. Box CPU contention scales
  the whole boot (4.8× measured at load 24), so it largely cancels in the
  ratio even when it swamps the difference.

### 3. Publish the detection floor, and state power before the run.

The floor is the half-width of the 95% CI on a **null (A/A) comparison** at
the n you are actually going to run. An effect smaller than the floor cannot
be called in either direction.

State it before the run, not after. If n=5 can only resolve 10 s, either raise
n hard or change the metric — do not run it and then describe the result as a
kill.

**A null result below the floor is "not measurable at this n", never
"killed".**

### 4. Every arm must prove its intervention fired.

An arm declares a counter; the in-page code increments it each time the
intervention actually applies. A boot whose counter reads 0 is discarded, not
plotted.

This is the check JELA-680 arm C and the JELA-682 coalescer both needed and
did not have. Both silently did nothing and both were written up as
regressions.

### 5. Gate on load, and record it per boot.

The workspace container is 6 cores and shared with other agent runs. Measured
on an unmodified build: **15,274–16,073 ms on a quiet box, 74,566 ms at load
24**. Load does not merely add noise — it reorders the race, so it changes
_what_ is measured, not just the magnitude.

Refuse to start above load 6. Sample `/proc/loadavg` before **and after**
every boot and store it with the sample, so a contaminated run can be
identified afterwards instead of being silently averaged in.

### 6. One ring at a time.

Two concurrent boot rings on 6 cores invalidate both runs. The runner takes a
pid lock and refuses to start while another ring holds it. (Liveness is a
`/proc` lookup — this container has no `pgrep`, so "is it still running?"
silently returns true.)

### 7. Pre-flight the server, and record it as a covariate.

The server is shared and uncontrolled. `GET /ScheduledTasks` first and refuse
to measure while anything is non-Idle — two investigations have already
published "server idle" numbers taken under a runaway library scan. Record a
`/System/Info` latency probe per boot alongside the sample.

The gate is scripted as `preflight.sh` — see the appendix at the end of this
document for the canonical copy (JEL-141 keeps QA harnesses out of the tracked
tree, so it is not a repo file; run it from your local workspace).

### 8. Cross-check the instrument against the DOM.

The v1 card ring gated on `.card[data-id]` while the writeups cross-checked
`.card`, and returned 0 on 4 of 21 boots with 160–345 cards on screen. Silent
sample loss, biased toward whichever arm loses more.

Count both selectors, re-query the DOM at the end of the boot, and report a
ring/DOM mismatch as an instrument failure rather than dropping the sample.

### 9. Prefer a metric with a lower noise floor than `firstCard`.

`firstCard` is a race between several row producers, so it is intrinsically
high-variance and is not a clean function of any single request (JELA-433).

`settle` is **not** a usable alternative — it ranged over 88–280 cards per run
(JELA-435).

Better candidates, in order: request **counts** (immune to every timing
confound above — this is how JELA-682 was sized without a usable firstCard),
server-side `x-response-time-ms` sums, a deterministic completion mark such as
"all rows rendered", and the tighter early phases `dcl` / `api`.

## Published floors

Measured with the JELA-690 harness on the local M63 rig. Raw rings are in the
JELA-690 issue thread.

### Instrument floor — deterministic workload, quiet box, n=12

Two byte-identical null arms, interleaved, 12 cycles, loadavg 2.75–5.71
throughout:

| metric      | paired median Δ | 95% CI    | detection floor (±) |
| ----------- | --------------: | --------- | ------------------: |
| `firstCard` |           −1 ms | [−1, 0]   |                1 ms |
| `allRows`   |           −3 ms | [−13, 11] |               12 ms |
| `api`       |           +2 ms | [−11, 5]  |                8 ms |
| `dcl`       |           −1 ms | [−10, 6]  |                8 ms |

Plan with the conservative reading, not the tight one. The per-cycle
differences are **heavy-tailed**: 10 of 12 cycles land inside ±20 ms, two are
−100 ms and −300 ms (a single slow boot). The median estimator shrugs those
off; a mean does not. sd of the paired difference is 89 ms, so a mean-based
test needs an MDE of about **79 ms at n=10**.

### Known-delay recovery

A main-thread busy-wait of exactly the stated size, on the critical path:

| injected | `firstCard`      | `allRows`       | `api`           | `dcl`          |
| -------: | ---------------- | --------------- | --------------- | -------------- |
|   250 ms | +300 [299,300]   | +252 [244,257]  | +248 [240,253]  | +248 [239,250] |
|  1000 ms | +1000 [999,1001] | +994 [983,1000] | +998 [989,1000] | +997 [990,999] |

Both recovered; all p = 0.0005 (exact Wilcoxon, n=12).

Note what `firstCard` did with the 250 ms arm. **It is quantised by the
recorder's poll interval**, so a true 250 ms reads as +300 while the
deterministic marks read 248–252. `firstCard` cannot resolve better than one
tick — one more reason for rule 9.

### No-op detection

A fifth arm declared an intervention but set a misspelled key, so it never
applied: **12 of 12 boots discarded, 0 plotted.** That is the JELA-680 arm-C
failure, caught by the tool instead of by hindsight.

### Real-app floor — this is the number to size against

Two byte-identical null arms on the **real JellyPlug boot**, interleaved, 8
cycles, loadavg 3.02–5.64, server pre-flighted (all 55 scheduled tasks Idle):

| metric      | paired median Δ | 95% CI      | detection floor (±) | Wilcoxon p |
| ----------- | --------------: | ----------- | ------------------: | ---------: |
| `firstCard` |          +13 ms | [−489, 906] |              698 ms |      0.742 |
| `handoff`   |         +142 ms | [−266, 354] |              310 ms |      0.547 |
| `domReady`  |          −24 ms | [−49, 8]    |               29 ms |      0.078 |
| `resN`      |     +5 requests | [−27, 31]   |         29 requests |      0.844 |

Sizing table, from the sd of the paired difference:

| metric      | MDE @ n=5 | MDE @ n=10 | MDE @ n=20 | MDE @ n=40 |
| ----------- | --------: | ---------: | ---------: | ---------: |
| `firstCard` |    850 ms |     601 ms |     425 ms |     301 ms |
| `handoff`   |    473 ms |     334 ms |     236 ms |     167 ms |
| `domReady`  |     32 ms |      23 ms |      16 ms |      11 ms |

**An effect under about 600 ms on `firstCard` is not measurable at n=10 on this
rig.** Read that against the history: JELA-435 deleted every skin image and
reported `p=0.83` at n=8 — at that n the test could not have resolved anything
under roughly 850 ms either way, so it was never evidence of a kill.

Note also what pairing is worth on the real workload. The same 16 boots give a
paired median Δ of **+13 ms** and an unpaired difference-of-medians of
**+264 ms** — a twentyfold difference on arms that are byte-identical. The
unpaired estimator is the one that produced +89%.

## When gate B blocks: how to read it (JELA-712)

Gate A and gate C name their own cause — a task, a loadavg. Gate B does not. It
reports one number, and a raised number has at least four unrelated causes. On
2026-08-25 gate B blocked for an entire measurement session at a **median of
13.60 then 14.04 ms against a 5 ms ceiling and a ~1 ms documented floor**, with
every scheduled task Idle and the harness quiet, and it took a full session of
log archaeology to say anything about why.

Read the **shape** first, because it discriminates before any digging does:

- **Skewed** (median well under p95) — intermittent contention. Something on
  the box competes for CPU some of the time. This is what gate A and gate C are
  for; if they are clear, look for a transcode or a neighbouring container.
- **Tight** (median ≈ p95) — a _raised floor_, not contention. Every request
  pays the same extra cost. JELA-712 was 14.04 median against 15.35 p95.

For a tight floor, the gate now prints the unauthenticated reference probe
alongside the gated one, which splits the remaining causes in two:

- **reference also raised** → box-wide: the reverse proxy, the host, a
  neighbouring container, or Jellyfin's own process state.
- **reference normal** → the authenticated pipeline, or `/System/Info` itself.

What JELA-712 eliminated, so nobody re-runs it:

| candidate                       | how it was excluded                                                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| busy scheduled task             | gate A clear; task history empty across the window                                                                                          |
| .NET thread-pool starvation     | zero `thread pool starvation` warnings in the day's log                                                                                     |
| websocket keepalive fan-out     | `ForceKeepAlive message to 1 inactive WebSockets` — one socket                                                                              |
| a failing plugin poller         | JellyfinEnhanced's Seerr timeout pre-dates the ~1 ms baseline                                                                               |
| a new plugin since the baseline | `/Plugins` diff clean                                                                                                                       |
| host or harness load            | the blocked window was the **quietest** stretch in the log, and the floor read ~1 ms later under loadavg 13 — load correlated the wrong way |

What was left, and what cleared it: **Jellyfin restarted at 05:00:33** (every
`* Startup` task's `LastExecutionResult.StartTimeUtc`, and `Kestrel is
listening` in the log), and the floor was back to ~1 ms within minutes. The
floor had been 14 ms at ~2 h uptime on the previous process. So: if gate B
shows a tight box-wide floor and everything above is excluded, check the
server's uptime, and treat a restart as the remedy of last resort rather than
a mystery.

Two things that are **not** the remedy:

- Raising `JELA692_MAX_SERVER_MS`. Every JELA-679..706 conclusion was taken
  against the ~1 ms floor that the 5 ms ceiling was chosen for.
- `--allow-task`. It exempts gate A and does nothing to gate B.

One thing gate B's name got wrong: `x-response-time-ms` is **wall-clock
handling time, not CPU**. A request that blocks on a lock or on a slow
downstream call is charged in full, and that is the right thing to gate on —
but do not read the number as CPU saturation.

Nothing in this repo emits the header. It is added inside the application, not
by the reverse proxy: when Jellyfin failed on 2026-08-25 and returned bare
`HTTP 500`s with `server: Kestrel` through the same Caddy hop, the header was
**absent from every response**, including on paths that route nowhere. A proxy
header directive would still have been applied. So it is Jellyfin or one of its
plugins, it runs after routing, and it is measured on the server side of the
connection — which is all gate B actually needs from it.

Every gate B run now appends to `$JELA692_LOG` (default
`~/.cache/jela692/gate-b.tsv`), pass or fail. The question you ask when the
gate blocks is "when did this start, and did it ramp or step?", and that file
is the only thing that can answer it.

## Gate D — is anybody else driving the box? (JELA-793)

Gates A–C answer "is the server busy with work it started itself, and is the
harness busy". Neither answers **"is another agent's boot rig hammering the
exact subsystem I am about to time"** — and on 2026-08-28 that difference
invalidated a full acceptance run.

Gate B read a clean median **1.50 ms** while a concurrent Tizen boot rig was
booting the shell against the same production server every ~60 s. Every boot
fans out the home rows, so the library-query substrate — the whole thing under
test — was being held warm by somebody else. `/System/Info` never touches that
path, so the pre-flight is blind to it by construction, not by accident.

The check is `GET /Sessions`: block if any session's `LastActivityDate` falls
inside the quiet window. Probes issued with an API key and no device open no
session, so a harness cannot trip its own gate. The rig shows up as
`Test | Jellyfin for Tizen` and `Test | JellyPlug`.

**Gate D on its own is not enough.** An arm that finds gate D clear at t=0 is
still measuring a box _your own previous arm_ warmed seconds earlier — a control
that cannot go cold, which is how a 1.05x null got produced at 17:56Z that day.
The wait must require both: gate D clear **and** at least one full quiet window
elapsed since this arm's own last request.

And the reason any of it was caught: **the arms were interleaved and the control
was read.** A treatment-only capture read 1.0x in the contaminated window and
would have been published as a pass. The control reading 1.0x _too_ is the
signal that the window was worthless.

```bash
#!/usr/bin/env bash
# Gate D -- no other client has touched this server inside the quiet window.
#   ./quietgate.sh [seconds]     0 = clear, 1 = someone else is driving the box
set -uo pipefail
WINDOW="${1:-300}"
AUTH="MediaBrowser Token=\"$JELLYFIN_API_KEY\""
curl -sf -H "Authorization: $AUTH" "$JELLYFIN_URL/Sessions" | WINDOW="$WINDOW" python3 -c '
import sys, json, os, datetime
win = int(os.environ["WINDOW"])
now = datetime.datetime.now(datetime.timezone.utc)
busy = []
for s in json.load(sys.stdin):
    raw = (s.get("LastActivityDate") or "").rstrip("Z")
    if not raw:
        continue
    raw = raw[:26]                      # trim .NET 7-digit fractional seconds
    try:
        t = datetime.datetime.fromisoformat(raw).replace(tzinfo=datetime.timezone.utc)
    except ValueError:
        continue
    age = (now - t).total_seconds()
    if age <= win:
        busy.append((age, s.get("UserName"), s.get("Client"), bool(s.get("NowPlayingItem"))))
if busy:
    print("D. other clients ..... BLOCKED - %d session(s) active in the last %ds" % (len(busy), win))
    for age, user, client, playing in sorted(busy):
        print("     %-14s %-22s %5.0fs ago%s" % (user, client, age, "  PLAYING" if playing else ""))
    sys.exit(1)
print("D. other clients ..... clear (no session activity in the last %ds)" % win)
' || exit 1
```

## A timing without an HTTP status beside it is not evidence (JELA-793)

`GET /HomeScreen/Section/{name}?userId=<username>` returns **HTTP 400** —
`userId` model-binds to a `Guid`, so a username never reaches a section handler.
What makes that a measurement hazard rather than an obvious mistake is that the
400 **still carries `x-response-time-ms`, and it still varies cold-vs-warm**:
610 ms on a cold box, 1.3 ms warm. A probe script pointed at a username produces
a complete, plausible, internally-consistent timing table in which every number
is ASP.NET's validation path.

Two habits close it, and they are cheap:

- Print **HTTP status and body size on every probe row**, and flag any non-200.
  A real `LatestShows` row is ~18.6 KB; the 400 body is 247 B.
- Take user ids from `GET /Users`, never from a display name.

## Checklist before you publish a perf claim

- [ ] Arms interleaved, order shuffled, seed recorded.
- [ ] Effect estimated from within-cycle pairs.
- [ ] Detection floor at this n stated, and the claimed effect is above it.
- [ ] Every arm's intervention counter is non-zero on every plotted boot.
- [ ] loadavg recorded per boot and under the gate.
- [ ] No other ring ran concurrently.
- [ ] Server scheduled tasks all Idle at boot time.
- [ ] Gate D clear: no other client active on the server inside the quiet
      window, and the arm held its own quiet window too.
- [ ] Every probe row carries an HTTP status and a body size, and they are 200s.
- [ ] Ring-vs-DOM card counts agree.
- [ ] A known-size injected delay has been recovered by this harness since the
      last change to it.

## Appendix — `preflight.sh` (the JELA-692 gate)

JEL-141 forbids tracked QA/measurement harnesses under `tooling/`, so the
gate script is not shipped in the repo. Its canonical copy lives below —
copy it into your local workspace, `chmod +x`, and run it before every
measurement session. Keep this appendix in sync if the gate changes.

```bash
#!/usr/bin/env bash
# JELA-692 — hard pre-flight gate for any production perf measurement.
#
# WHY THIS EXISTS
# ---------------
# Twice in the JELA-679 programme a set of production timings was published as
# "server idle" when it was not. On 2026-08-23 the Intro Skipper task
# "Detect and Analyze Media Segments" ran a 3 h 15 m full-library backfill
# across the exact window in which `/HomeScreen/Sections` was measured at
# 11,577 / 14,457 / 16,097 ms. The same endpoint measured 2,024 ms once the box
# was quiet. Nobody had checked, because checking was a note in a doc rather
# than a command that fails.
#
# This is that command. Run it, and let it decide — do not eyeball the server.
#
#   tooling/perf/preflight.sh          # -> exit 0 only if it is safe to measure
#
# It gates on three independent things, because they fail independently:
#
#   A. Server scheduled tasks   Any non-Idle task on the Jellyfin box. A single
#                               CPU/IO-heavy task inflates every endpoint on it.
#   B. Server-side handling     Median `x-response-time-ms` on /System/Info.
#                               The header is added server-side, so it excludes
#                               WAN RTT entirely: ~1 ms on a quiet box,
#                               tens-to-hundreds under load. It is WALL-CLOCK
#                               handling, not CPU — a request blocked on a lock
#                               is charged in full. It catches load this script
#                               cannot enumerate — transcodes, a neighbouring
#                               container, the host.
#
#                               Gate B also probes an UNAUTHENTICATED trivial
#                               endpoint as a reference, and reports both. The
#                               verdict still keys off /System/Info alone — the
#                               reference exists to say WHERE a raised floor
#                               lives, which is the one thing JELA-712 needed
#                               and could not get. Observed quiet-box layer
#                               costs, 2026-08-25, 9 probes each:
#
#                                 /Branding/Configuration  0.22 ms  (reference)
#                                 /System/Info/Public      0.28 ms
#                                 /System/Endpoint         0.88 ms  (auth)
#                                 /System/Info             1.04 ms  (gate B)
#                                 /web/index.html          4.34 ms  (static)
#
#                               So the authenticated pipeline is worth ~0.7 ms
#                               and /System/Info's body ~0.1 ms. A floor well
#                               above that on BOTH probes is box-wide; on the
#                               authenticated probe only, it is the auth
#                               pipeline or the endpoint itself.
#   C. Harness container load   /proc/loadavg 1-min against the core count.
#                               A DIFFERENT box from A and B. The boot harness
#                               inflates firstCard 4.8x under shared-box load
#                               (JELA-682), so a quiet server is not sufficient.
#
# Exit codes are the contract:
#   0  CLEAR    — every gate passed; measurements taken now are quotable.
#   1  BLOCKED  — at least one gate failed; do not measure, do not publish.
#   2  UNKNOWN  — the gate could not be evaluated (no credentials, server
#                 unreachable, malformed response). Deliberately NOT 0: an
#                 un-evaluated gate must never read as a clear one.
#
# Usage:
#   tooling/perf/preflight.sh [--json] [--samples N] [--allow-task NAME]...
#
#   --json              machine-readable verdict on stdout, nothing else
#   --samples N         gate B probe pairs — N on /System/Info and N on the
#                       unauthenticated reference, interleaved (default 9,
#                       min 3)
#   --allow-task NAME   exempt one task by exact name; repeatable. For tasks
#                       known to be free (a 0-second no-op poller). Every use
#                       is printed in the verdict so an exemption cannot hide
#                       in a script and silently widen over time.
#
# Environment:
#   JELLYFIN_URL           required, e.g. https://host/ (no trailing path)
#   JELLYFIN_API_KEY       required
#   JELA692_MAX_SERVER_MS  gate B ceiling, median ms (default 5)
#   JELA692_MAX_LOADAVG    gate C ceiling, 1-min load (default: core count)
#   JELA692_LOG            gate B history file, TSV, appended on every run
#                          (default ~/.cache/jela692/gate-b.tsv; set to
#                          /dev/null to disable). Every gate B evaluation is
#                          recorded whether it passes or fails, because the
#                          question you actually ask when the gate blocks is
#                          "when did this start, and did it ramp or step?" —
#                          and in JELA-712 nobody could answer it.
#
# DO NOT raise JELA692_MAX_SERVER_MS to clear a block. Every JELA-679..706
# conclusion was taken against the ~1 ms floor the 5 ms ceiling was chosen
# for; moving it reopens all of them. If the floor is genuinely the box's new
# normal, that is a deliberate documented re-baseline, not an env var.
#
# The URL and key come from the environment and are never echoed — see
# tooling/ci/check-no-personal-endpoints.sh for why this repo holds no
# production hostnames.
set -uo pipefail

JSON=0
SAMPLES=9
ALLOW=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --json) JSON=1; shift ;;
    --samples) SAMPLES="${2:-}"; shift 2 ;;
    --allow-task) ALLOW+=("${2:-}"); shift 2 ;;
    # Print the whole header comment, however long it grows — a fixed line
    # range silently swallowed Usage and Environment when the header expanded.
    -h|--help) awk 'NR > 1 { if (/^set -uo pipefail/) exit; print }' "$0" \
                 | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "preflight: unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ "$SAMPLES" =~ ^[0-9]+$ ]] || { echo "preflight: --samples must be an integer" >&2; exit 2; }
(( SAMPLES >= 3 )) || SAMPLES=3

MAX_SERVER_MS="${JELA692_MAX_SERVER_MS:-5}"
DEFAULT_LOAD="$(nproc 2>/dev/null || echo 4)"
MAX_LOADAVG="${JELA692_MAX_LOADAVG:-$DEFAULT_LOAD}"

FAILS=()
NOTES=()
UNKNOWN=0

say() { (( JSON )) || echo "$@"; }

if [[ -z "${JELLYFIN_URL:-}" || -z "${JELLYFIN_API_KEY:-}" ]]; then
  say "UNKNOWN: JELLYFIN_URL / JELLYFIN_API_KEY not set — cannot evaluate the gate."
  (( JSON )) && echo '{"verdict":"UNKNOWN","reason":"missing JELLYFIN_URL or JELLYFIN_API_KEY"}'
  exit 2
fi

BASE="${JELLYFIN_URL%/}"
AUTH="Authorization: MediaBrowser Token=\"$JELLYFIN_API_KEY\""

say "JELA-692 perf pre-flight"
say "========================"

# ---------------------------------------------------------------- gate A
tasks_json="$(curl -sS -m 30 -H "$AUTH" "$BASE/ScheduledTasks" 2>/dev/null)"
busy="$(printf '%s' "$tasks_json" | ALLOW_LIST="$(printf '%s\n' "${ALLOW[@]:-}")" python3 -c '
import json, os, sys
try:
    tasks = json.load(sys.stdin)
    if not isinstance(tasks, list):
        raise ValueError("not a task list")
except Exception:
    print("PARSE_ERROR"); sys.exit(0)
allow = {n for n in os.environ.get("ALLOW_LIST", "").splitlines() if n}
for t in tasks:
    if t.get("State") != "Idle" and t.get("Name") not in allow:
        pct = t.get("CurrentProgressPercentage")
        pct = "?" if pct is None else format(pct, ".2f")
        print("%s|%s|%s" % (t.get("Name"), t.get("State"), pct))
' 2>/dev/null)"

if [[ "$busy" == "PARSE_ERROR" || ( -z "$busy" && -z "$tasks_json" ) ]]; then
  UNKNOWN=1
  NOTES+=("A: could not read /ScheduledTasks")
  say "A. scheduled tasks .... UNKNOWN (no readable response from /ScheduledTasks)"
elif [[ -n "$busy" ]]; then
  while IFS='|' read -r name state pct; do
    [[ -z "$name" ]] && continue
    FAILS+=("task '$name' is $state at $pct%")
    say "A. scheduled tasks .... BLOCKED — '$name' $state ${pct}%"
  done <<< "$busy"
else
  say "A. scheduled tasks .... clear (all Idle)"
fi
(( ${#ALLOW[@]} )) && say "   exempted by --allow-task: ${ALLOW[*]}"

# ---------------------------------------------------------------- gate B
# `x-response-time-ms` is added server-side, so this measures handling and not
# the link — wall-clock handling, not CPU. Median, not mean: a single GC pause
# or a retried TLS handshake produces a 10x outlier on an otherwise quiet box,
# and one outlier must not block a measurement session.
#
# Two endpoints, probed INTERLEAVED so a transient hits both arms equally:
#   ref   /Branding/Configuration  unauthenticated, trivial body — the cheapest
#                                  real handler on the box
#   gate  /System/Info             the gated probe, unchanged
# Only `gate` decides the verdict. `ref` is there so that a raised floor is
# attributable at the moment it blocks instead of reconstructed from logs a day
# later (JELA-712 spent a session on exactly that reconstruction).
REF_PATH="/Branding/Configuration"
samples=()
refs=()
for _ in $(seq "$SAMPLES"); do
  ms="$(curl -sS -D- -o /dev/null -m 30 -H "$AUTH" "$BASE/System/Info" 2>/dev/null \
        | tr -d '\r' | awk 'tolower($1)=="x-response-time-ms:"{print $2}')"
  [[ -n "$ms" ]] && samples+=("$ms")
  rms="$(curl -sS -D- -o /dev/null -m 30 "$BASE$REF_PATH" 2>/dev/null \
        | tr -d '\r' | awk 'tolower($1)=="x-response-time-ms:"{print $2}')"
  [[ -n "$rms" ]] && refs+=("$rms")
done

stats() {  # median p95 over the numbers on stdin
  python3 -c '
import sys
v = sorted(float(x) for x in sys.stdin if x.strip())
if not v:
    print("NA NA"); raise SystemExit
n = len(v)
med = v[n//2] if n % 2 else (v[n//2 - 1] + v[n//2]) / 2
print("%.2f %.2f" % (med, v[min(n - 1, int(round(0.95 * (n - 1))))]))
'
}

ref_median=NA
(( ${#refs[@]} >= 3 )) && read -r ref_median _ <<< "$(printf '%s\n' "${refs[@]}" | stats)"

median=NA; p95=NA
if (( ${#samples[@]} < 3 )); then
  UNKNOWN=1
  NOTES+=("B: only ${#samples[@]}/$SAMPLES probes returned x-response-time-ms")
  say "B. server handling .... UNKNOWN (${#samples[@]}/$SAMPLES probes usable)"
else
  read -r median p95 <<< "$(printf '%s\n' "${samples[@]}" | stats)"
  if awk -v m="$median" -v c="$MAX_SERVER_MS" 'BEGIN{exit !(m > c)}'; then
    FAILS+=("/System/Info median ${median} ms > ${MAX_SERVER_MS} ms ceiling")
    say "B. server handling .... BLOCKED — median ${median} ms (p95 ${p95}) > ${MAX_SERVER_MS} ms"
    # Attribution, not a second gate: name the layer while the evidence is live.
    if [[ "$ref_median" == NA ]]; then
      say "   reference $REF_PATH unreadable — cannot attribute the floor"
    elif awk -v r="$ref_median" -v c="$MAX_SERVER_MS" 'BEGIN{exit !(r > c)}'; then
      say "   reference $REF_PATH is ALSO ${ref_median} ms — the floor is box-wide"
      say "   (proxy, host, neighbouring container, or Jellyfin process state),"
      say "   not the authenticated pipeline. Restarting Jellyfin has cleared a"
      say "   box-wide floor before (JELA-712, 2026-08-25)."
    else
      say "   reference $REF_PATH is ${ref_median} ms — the floor is NOT box-wide;"
      say "   it is the authenticated pipeline or /System/Info itself."
    fi
  else
    say "B. server handling .... clear (median ${median} ms, p95 ${p95}, n=${#samples[@]}, ref ${ref_median} ms)"
  fi
fi

# Append every evaluation, pass or fail. The gate's blind spot in JELA-712 was
# not the measurement, it was having no history to say when the floor moved.
GATE_LOG="${JELA692_LOG:-$HOME/.cache/jela692/gate-b.tsv}"
if [[ "$GATE_LOG" != /dev/null ]]; then
  mkdir -p "$(dirname "$GATE_LOG")" 2>/dev/null \
    && { [[ -s "$GATE_LOG" ]] || printf 'utc\tgate_median_ms\tgate_p95_ms\tref_median_ms\tn\tceiling_ms\n' >> "$GATE_LOG"; } \
    && printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
         "$median" "$p95" "$ref_median" "${#samples[@]}" "$MAX_SERVER_MS" >> "$GATE_LOG"
fi

# ---------------------------------------------------------------- gate C
load1="$(awk '{print $1}' /proc/loadavg 2>/dev/null)"
if [[ -z "$load1" ]]; then
  UNKNOWN=1
  NOTES+=("C: /proc/loadavg unreadable")
  say "C. harness load ....... UNKNOWN (/proc/loadavg unreadable)"
elif awk -v l="$load1" -v c="$MAX_LOADAVG" 'BEGIN{exit !(l > c)}'; then
  FAILS+=("harness container loadavg ${load1} > ${MAX_LOADAVG}")
  say "C. harness load ....... BLOCKED — loadavg ${load1} > ${MAX_LOADAVG} (${DEFAULT_LOAD} cores)"
else
  say "C. harness load ....... clear (loadavg ${load1} / ceiling ${MAX_LOADAVG})"
fi

# ---------------------------------------------------------------- verdict
if (( ${#FAILS[@]} )); then
  VERDICT=BLOCKED; CODE=1
elif (( UNKNOWN )); then
  VERDICT=UNKNOWN; CODE=2
else
  VERDICT=CLEAR; CODE=0
fi

if (( JSON )); then
  VERDICT="$VERDICT" GATE_MED="$median" GATE_P95="$p95" REF_MED="$ref_median" \
  GATE_N="${#samples[@]}" CEIL="$MAX_SERVER_MS" python3 -c '
import json, os, sys
def num(k):
    v = os.environ.get(k, "NA")
    try: return float(v)
    except ValueError: return None
print(json.dumps({
    "verdict": os.environ["VERDICT"],
    "blockers": [l for l in sys.argv[1].splitlines() if l],
    "notes":    [l for l in sys.argv[2].splitlines() if l],
    "gateB": {
        "median_ms":     num("GATE_MED"),
        "p95_ms":        num("GATE_P95"),
        "ref_median_ms": num("REF_MED"),
        "samples":       int(os.environ["GATE_N"]),
        "ceiling_ms":    num("CEIL"),
    },
}))
' "$(printf '%s\n' "${FAILS[@]:-}")" "$(printf '%s\n' "${NOTES[@]:-}")"
else
  echo
  case "$VERDICT" in
    CLEAR)
      echo "VERDICT: CLEAR — measurements taken now are quotable." ;;
    BLOCKED)
      echo "VERDICT: BLOCKED — do not measure, do not publish."
      for f in "${FAILS[@]}"; do echo "  - $f"; done
      echo
      echo "Wait for the box to go quiet and re-run. Do NOT cancel a running"
      echo "scheduled task to clear this gate: stopping one is a deliberate"
      echo "configuration decision, and a task cancelled mid-run re-runs from"
      echo "the start of its queue on the next trigger (JELA-692)." ;;
    UNKNOWN)
      echo "VERDICT: UNKNOWN — the gate could not be evaluated. Treat as BLOCKED."
      for n in "${NOTES[@]}"; do echo "  - $n"; done ;;
  esac
fi

exit "$CODE"
```
