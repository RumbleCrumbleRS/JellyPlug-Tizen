#!/usr/bin/env bash
# JEL-141 guard — the repo holds only relevant code, no debug tooling.
#
# tooling/ used to carry on-device QA/debug harnesses (tv-validate verify-*.mjs
# drivers, the tv-inspect CDP debugger, the wgt-emulate browser harness) plus
# the capture evidence they produced. None of that is shipping code, so JEL-141
# removed it: the only thing left under tooling/ is the build/release CI glue
# in tooling/ci/.
#
# This guard keeps it that way. It fails CI if any tracked file appears under
# tooling/ outside tooling/ci/ — i.e. if a debug/QA harness (or its capture
# output) is re-introduced. Put validation harnesses in a developer's own
# workspace and attach run results to the Paperclip issue, not to git.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

offenders=$(git ls-files -- tooling ':(exclude)tooling/ci/**' || true)

if [[ -n "$offenders" ]]; then
  echo "ERROR: non-CI tooling found under tooling/ (debug/QA harness or evidence):" >&2
  echo "$offenders" | sed 's/^/  /' >&2
  echo >&2
  echo "Only tooling/ci/ (build + release glue) belongs in tooling/. Debug/QA" >&2
  echo "validation harnesses and their capture output are not shipping code —" >&2
  echo "keep them in a local workspace and attach run results to the Paperclip" >&2
  echo "issue instead of committing them (JEL-141)." >&2
  exit 1
fi

echo "OK: tooling/ holds only the tooling/ci build glue (no debug/QA tooling)."
