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
