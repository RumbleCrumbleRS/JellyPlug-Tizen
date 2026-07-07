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

# --staged mode (JELA-18): scan the STAGED diff instead of the committed tree,
# so the pre-commit hook (tooling/githooks/pre-commit) can block the leak
# BEFORE it ever enters a commit. JELA-9 slipped a dynamic-DNS hostname past
# the push-time CI guard because CI only fails after the commit already exists
# (and then lives in history forever, requiring a rewrite to remove). This mode
# closes that window. It inspects only added ('+') lines in the staged changeset
# and reuses the exact same PATTERN as the tree scan below — single source of
# truth, no drift.
if [[ "${1:-}" == "--staged" ]]; then
  added=$(git diff --cached --no-color -U0 \
            -- . ':(exclude)tooling/ci/check-no-personal-endpoints.sh' \
          | grep -E '^\+' | grep -Ev '^\+\+\+' || true)
  if [[ -n "$added" ]] && echo "$added" | grep -qiE "$PATTERN"; then
    echo "ERROR: personal / dynamic-DNS server endpoint in STAGED changes (JEL-139 guard):" >&2
    echo "$added" | grep -niE "$PATTERN" >&2
    echo >&2
    echo "This would enter git history if committed. Unstage it and replace with a" >&2
    echo "reserved *.example placeholder (e.g. REDACTED-SERVER.example)." >&2
    echo "Raw on-device capture evidence goes to the Paperclip issue, not git" >&2
    echo "(see tooling/tv-validate/EVIDENCE-POLICY.md). To bypass in a genuine" >&2
    echo "false-positive: git commit --no-verify (and fix the pattern in a PR)." >&2
    exit 1
  fi
  echo "OK: no personal / dynamic-DNS endpoints in staged changes."
  exit 0
fi

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

# JEL-628 second check — no hardcoded RFC1918 endpoint URLs in SHIPPING source
# (packages/*/src/**, which includes the deployed min blobs). The JEL-139 scope
# note above still holds for the repo at large (LAN IPs in test fixtures and
# docs reveal nothing routable), but a `http://192.168.x.x` DEFAULT baked into
# shipping code is operator-environment residue in a public repo AND a footgun:
# a fleet TV would silently POST telemetry at some stranger's LAN address.
# Endpoints in shipping code must come from localStorage/config at runtime
# (e.g. `jellyfin.qa.beaconUrl`, see qa-beacon.js). Test fixtures under
# scripts/ stay exempt.
LAN_URL_PATTERN='https?://(192\.168\.|10\.[0-9]+\.|172\.(1[6-9]|2[0-9]|3[01])\.)'

if matches=$(git grep -nIiE "$LAN_URL_PATTERN" -- ':(glob)packages/*/src/**' 2>/dev/null); then
  echo "ERROR: hardcoded LAN (RFC1918) endpoint URL found in shipping source:" >&2
  echo "$matches" >&2
  echo >&2
  echo "Shipping code must read endpoints from localStorage/config at runtime" >&2
  echo "(see qa-beacon.js + jellyfin.qa.beaconUrl, JEL-628). Test fixtures" >&2
  echo "belong under a package's scripts/ dir, which this check exempts." >&2
  exit 1
fi

echo "OK: no personal / dynamic-DNS endpoints in tracked files."
echo "OK: no hardcoded LAN endpoint URLs in shipping source (packages/*/src)."
