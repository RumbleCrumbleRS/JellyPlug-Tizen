#!/usr/bin/env bash
# JEL-141 guard — no debug / QA capture evidence in tracked files.
#
# tooling/tv-validate/ holds on-device validation HARNESSES (the verify-*.mjs /
# *.py / *.cjs drivers and their READMEs). Those are source and belong in git.
#
# Everything those harnesses PRODUCE — results-JEL-*.md writeups, ntfy/relay
# logs, localStorage trail dumps, beacon payloads, screenshots, device-probe
# output, bundle checksums — is debug information, not code. Per JEL-141 the
# repo should "only hold relevant code", so that output never gets committed;
# it goes to the Paperclip issue as a comment / attachment instead. (This also
# closes the JEL-139 leak class at the source: capture evidence is what once
# embedded the operator's personal dynamic-DNS hostname.)
#
# This guard enforces an allowlist: under tooling/tv-validate/ only harness
# source and docs may be tracked. Any other file (a re-introduced results file,
# screenshot, log, payload dump, …) fails CI.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# Allowed tracked paths under tooling/tv-validate/: harness code + docs only.
#   *.mjs *.cjs *.py *.sh  — harness drivers / helpers
#   README.md              — how to run a harness
#   EVIDENCE-POLICY.md     — this policy
#   .gitignore             — keeps local capture output untracked
allow_re='\.(mjs|cjs|py|sh)$|/README\.md$|/EVIDENCE-POLICY\.md$|/\.gitignore$'

offenders=$(git ls-files -- tooling/tv-validate | grep -vE "$allow_re" || true)

if [[ -n "$offenders" ]]; then
  echo "ERROR: debug / QA capture evidence found under tooling/tv-validate/:" >&2
  echo "$offenders" | sed 's/^/  /' >&2
  echo >&2
  echo "Only harness source (*.mjs/*.cjs/*.py/*.sh), README.md, EVIDENCE-POLICY.md," >&2
  echo "and .gitignore may live there. Harness OUTPUT (results-*.md writeups, logs," >&2
  echo "payload dumps, screenshots, checksums) is debug information — attach it to" >&2
  echo "the Paperclip issue instead of committing it. See" >&2
  echo "tooling/tv-validate/EVIDENCE-POLICY.md (JEL-141)." >&2
  exit 1
fi

echo "OK: tooling/tv-validate/ holds only harness source + docs (no debug evidence)."
