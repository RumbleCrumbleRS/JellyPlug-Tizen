#!/usr/bin/env bash
# JEL-139 guard — no personal / dynamic-DNS server endpoints in tracked files.
#
# The repo is private but its QA evidence captures (tooling/tv-validate/**)
# once embedded the operator's personal Jellyfin server behind a free
# dynamic-DNS hostname, which resolves straight to a home IP. That hostname
# leaked into 13 tracked files and the whole git history before it was
# scrubbed + the history rewritten (see JEL-139).
#
# This guard stops a future on-device capture from re-introducing the same
# class of leak. It fails CI if any tracked file references a free dynamic-DNS
# provider hostname (the kind used to expose a home server) or the specific
# historical hostname. Use a `*.example` placeholder in fixtures instead
# (e.g. REDACTED-SERVER.example) — those are reserved and never resolve.
#
# Scope note: RFC1918 LAN IPs (192.168.x / 10.x / 172.16-31.x) are NOT flagged.
# They are non-routable and reveal nothing reachable from outside the LAN.
# This guard targets publicly-resolvable personal endpoints only.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# Free dynamic-DNS providers commonly used to expose a self-hosted server,
# plus the specific historical hostname. `.example` is deliberately excluded
# (reserved TLD, never resolves) so redacted fixtures pass.
PATTERN='examplehost|[a-z0-9][a-z0-9.-]*\.(ddns\.net|duckdns\.org|hopto\.org|zapto\.org|sytes\.net|myftp\.(org|biz)|serveo\.net|dyndns\.(org|tv|info)|no-ip\.(org|biz|info|com)|ddnsfree\.com|loginto\.me)'

# git grep over tracked files only; -I skips binary blobs.
if matches=$(git grep -nIiE "$PATTERN" -- . ':(exclude)tooling/ci/check-no-personal-endpoints.sh' 2>/dev/null); then
  echo "ERROR: personal / dynamic-DNS server endpoint found in tracked files:" >&2
  echo "$matches" >&2
  echo >&2
  echo "Replace it with a reserved *.example placeholder (e.g. REDACTED-SERVER.example)." >&2
  echo "Raw on-device capture evidence should go to the Paperclip issue as an" >&2
  echo "attachment, not into git — see tooling/tv-validate/EVIDENCE-POLICY.md." >&2
  exit 1
fi

echo "OK: no personal / dynamic-DNS endpoints in tracked files."
