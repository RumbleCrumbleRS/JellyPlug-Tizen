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

## Checklist before you publish a perf claim

- [ ] Arms interleaved, order shuffled, seed recorded.
- [ ] Effect estimated from within-cycle pairs.
- [ ] Detection floor at this n stated, and the claimed effect is above it.
- [ ] Every arm's intervention counter is non-zero on every plotted boot.
- [ ] loadavg recorded per boot and under the gate.
- [ ] No other ring ran concurrently.
- [ ] Server scheduled tasks all Idle at boot time.
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
#   B. Server-side CPU cost     Median `x-response-time-ms` on /System/Info.
#                               This is the SERVER's own cost for a trivial
#                               request, so it excludes WAN RTT entirely: ~1 ms
#                               on a quiet box, tens-to-hundreds under load.
#                               It catches load this script cannot enumerate —
#                               transcodes, a neighbouring container, the host.
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
#   --samples N         /System/Info probes for gate B (default 9, min 3)
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
    -h|--help) sed -n '2,60p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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
# `x-response-time-ms` is the server's own handling cost, so this measures the
# SERVER and not the link. Median, not mean: a single GC pause or a retried TLS
# handshake produces a 10x outlier on an otherwise quiet box, and one outlier
# must not block a measurement session.
samples=()
for _ in $(seq "$SAMPLES"); do
  ms="$(curl -sS -D- -o /dev/null -m 30 -H "$AUTH" "$BASE/System/Info" 2>/dev/null \
        | tr -d '\r' | awk 'tolower($1)=="x-response-time-ms:"{print $2}')"
  [[ -n "$ms" ]] && samples+=("$ms")
done

if (( ${#samples[@]} < 3 )); then
  UNKNOWN=1
  NOTES+=("B: only ${#samples[@]}/$SAMPLES probes returned x-response-time-ms")
  say "B. server CPU cost .... UNKNOWN (${#samples[@]}/$SAMPLES probes usable)"
else
  read -r median p95 <<< "$(printf '%s\n' "${samples[@]}" | python3 -c '
import sys
v = sorted(float(x) for x in sys.stdin if x.strip())
n = len(v)
med = v[n//2] if n % 2 else (v[n//2 - 1] + v[n//2]) / 2
print("%.2f %.2f" % (med, v[min(n - 1, int(round(0.95 * (n - 1)))) ]))
')"
  if awk -v m="$median" -v c="$MAX_SERVER_MS" 'BEGIN{exit !(m > c)}'; then
    FAILS+=("/System/Info median ${median} ms > ${MAX_SERVER_MS} ms ceiling")
    say "B. server CPU cost .... BLOCKED — median ${median} ms (p95 ${p95}) > ${MAX_SERVER_MS} ms"
  else
    say "B. server CPU cost .... clear (median ${median} ms, p95 ${p95}, n=${#samples[@]})"
  fi
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
  VERDICT="$VERDICT" python3 -c '
import json, os, sys
print(json.dumps({
    "verdict": os.environ["VERDICT"],
    "blockers": [l for l in sys.argv[1].splitlines() if l],
    "notes":    [l for l in sys.argv[2].splitlines() if l],
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
