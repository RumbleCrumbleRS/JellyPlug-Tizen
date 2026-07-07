#!/usr/bin/env bash
# Post-publish deploy-propagation probe (JELA-31 / WS-E, C4).
#
# Confirms a server-plugin release actually reached a live server: fetches
# `<base>/shell/manifest.json` and asserts its `sha256` equals the sha256 of
# the shell.min.js this repo intends to ship. This closes the "did it actually
# propagate?" gap that made JELA-26 un-verifiable in a single heartbeat — the
# plugin publish only takes effect after the Jellyfin server *auto-pulls the new
# plugin zip AND restarts*, a delay the release step does not control. So this
# probe can POLL: it retries until the live sha flips to the intended value or a
# deadline passes, turning "eventually consistent, timing unknown" into a
# deterministic pass/fail.
#
# The live server URL is a personal endpoint and MUST NOT be committed
# (JEL-139 guard) — it is always supplied at run time via arg or env, never
# baked in here.
#
# Usage:
#   tooling/ci/verify-shell-deploy.sh <base-url> [expected-sha256] [options]
#   JELLYFIN_URL=https://server.example tooling/ci/verify-shell-deploy.sh
#
#   base-url         Jellyfin base URL (or $JELLYFIN_URL). "/shell/manifest.json"
#                    is appended; a trailing slash is fine.
#   expected-sha256  64-hex intended shell sha. Default: sha256 of the tracked
#                    packages/shell-tizen/src/shell.min.js (the bytes the plugin
#                    embeds — single source of truth). Pass explicitly to verify
#                    against a *past* release from a different checkout.
#
# Options:
#   --poll             Retry until match or --timeout elapses (default: one shot).
#   --timeout <secs>   Poll deadline (default 900 = 15 min).
#   --interval <secs>  Delay between polls (default 20).
#   --expect-version <v>  Also assert manifest `version` equals <v>.
#   -h | --help        This help.
#
# Exit: 0 = live sha matches intended (propagated); 1 = mismatch / timeout /
# unreachable; 2 = usage error.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEFAULT_SHELL_MIN="$REPO_ROOT/packages/shell-tizen/src/shell.min.js"

usage() { sed -n '2,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//; s/^#$//' | sed '$d'; }

BASE="${1-}"
if [[ "${BASE:-}" == "-h" || "${BASE:-}" == "--help" ]]; then usage; exit 0; fi
if [[ -z "${BASE:-}" ]]; then BASE="${JELLYFIN_URL-}"; else shift; fi

EXPECTED=""
# A bare 64-hex first positional (after base) is the expected sha.
if [[ "${1-}" =~ ^[0-9a-fA-F]{64}$ ]]; then EXPECTED="${1,,}"; shift; fi

POLL=0
TIMEOUT=900
INTERVAL=20
EXPECT_VERSION=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --poll) POLL=1 ;;
    --timeout) TIMEOUT="${2:?}"; shift ;;
    --interval) INTERVAL="${2:?}"; shift ;;
    --expect-version) EXPECT_VERSION="${2:?}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if [[ -z "${BASE:-}" ]]; then
  echo "ERROR: no base URL. Pass it as arg 1 or set \$JELLYFIN_URL." >&2
  usage >&2
  exit 2
fi

if [[ -z "$EXPECTED" ]]; then
  [[ -f "$DEFAULT_SHELL_MIN" ]] || { echo "ERROR: $DEFAULT_SHELL_MIN missing and no explicit sha given." >&2; exit 2; }
  EXPECTED="$(sha256sum "$DEFAULT_SHELL_MIN" | cut -d' ' -f1)"
  echo "intended sha256 = $EXPECTED  (from packages/shell-tizen/src/shell.min.js)"
else
  echo "intended sha256 = $EXPECTED  (explicit)"
fi

URL="${BASE%/}/shell/manifest.json"
echo "probe target    = $URL"
[[ -n "$EXPECT_VERSION" ]] && echo "expected version = $EXPECT_VERSION"

# One probe: echoes the live values and returns 0 match / 1 mismatch / 2 unreachable.
probe_once() {
  local body live_sha live_ver
  if ! body="$(curl -fsS --max-time 15 "$URL" 2>/dev/null)"; then
    echo "  unreachable: $URL"
    return 2
  fi
  live_sha="$(printf '%s' "$body" | jq -r '.sha256 // empty' 2>/dev/null || true)"
  live_ver="$(printf '%s' "$body" | jq -r '.version // empty' 2>/dev/null || true)"
  if [[ -z "$live_sha" ]]; then
    echo "  no .sha256 field in manifest (got: $(printf '%s' "$body" | head -c 200))"
    return 2
  fi
  echo "  live version=${live_ver:-?} sha256=$live_sha"
  if [[ "${live_sha,,}" != "$EXPECTED" ]]; then
    return 1
  fi
  if [[ -n "$EXPECT_VERSION" && "$live_ver" != "$EXPECT_VERSION" ]]; then
    echo "  sha matched but version '$live_ver' != expected '$EXPECT_VERSION'"
    return 1
  fi
  return 0
}

if [[ "$POLL" -eq 0 ]]; then
  if probe_once; then
    echo "PASS: live shell sha matches intended — deploy propagated."
    exit 0
  fi
  echo "FAIL: live shell sha does not (yet) match intended. Re-run with --poll" >&2
  echo "      to wait for the server to auto-pull + restart." >&2
  exit 1
fi

# --poll: SECONDS is the bash builtin elapsed-seconds counter (no wall-clock dep).
SECONDS=0
attempt=0
while :; do
  attempt=$((attempt + 1))
  echo "[poll #$attempt, ${SECONDS}s/${TIMEOUT}s]"
  if probe_once; then
    echo "PASS: live shell sha matches intended after ${SECONDS}s — deploy propagated."
    exit 0
  fi
  if (( SECONDS + INTERVAL >= TIMEOUT )); then
    echo "FAIL: intended sha did not appear within ${TIMEOUT}s (${attempt} polls)." >&2
    echo "      The server may not have auto-pulled/restarted yet, or the release" >&2
    echo "      did not carry the intended shell. See docs/deploy-runbook.md." >&2
    exit 1
  fi
  sleep "$INTERVAL"
done
