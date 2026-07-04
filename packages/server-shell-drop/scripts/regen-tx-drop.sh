#!/usr/bin/env bash
# regen-tx-drop.sh — JEL-653: unattended regeneration of the pre-lowered
# transpile drop (JEL-621).
#
# The drop is content-addressed: ANY server content change (jellyfin-web
# update, plugin config edit, JSI snippet edit) changes source hashes, so a
# manually-built drop silently decays to 100% miss and every legacy-TV cold
# boot regresses to the 21-42 s on-TV Babel path. This wrapper is the single
# entrypoint both automation legs share:
#
#   server-side schedule   cron/systemd-timer runs it every N minutes with
#                          --merge semantics against the live server.
#   release cut (JEL-213)  a shell release can change BABEL_OPTS_KEY /
#                          babel.min.js / the lockstep regexes, which stales
#                          the WHOLE drop at once (opts-key mismatch). Set
#                          TX_DROP_GIT_SYNC=1 so every scheduled run fast-
#                          forwards the repo checkout first: a release is
#                          picked up within one cron interval with no extra
#                          human step. (Or run this script once, manually or
#                          via ssh, as the post-release step.)
#
# usage: regen-tx-drop.sh <drop_dir> <server_url> [extra build-tx-drop.mjs args...]
#
#   <drop_dir>     the live /shell/ web root (e.g. /var/www/jellyfin/shell)
#   <server_url>   the Jellyfin origin TVs use (passed as --web-index; the
#                  JSI snippet channel URL is derived from it)
#
# env knobs:
#   TX_DROP_JSI_PATH    snippet-channel path appended to <server_url>
#                       (default /JavaScriptInjector/public.js — the shell's
#                       jsiChannelPath() default, JEL-204). Set to "" to skip.
#   TX_DROP_URL_LIST    file of extra source URLs (--url-list) if it exists
#                       (e.g. the TV-recorded jellyfin.shell.pluginUrls set).
#   TX_DROP_PRUNE_DAYS  delete tx/*.js older than N days before the run. The
#                       builder rewrites every still-served source's body on
#                       every run (mtime refreshes), so only entries whose
#                       source stopped being served keep aging; pruning them
#                       bounds drop-dir growth under a long-lived cron. A
#                       pruned-too-early entry is safe: hash miss -> on-TV
#                       Babel fallback, never a wrong body.
#   TX_DROP_GIT_SYNC=1  git pull --ff-only the repo checkout first so the
#                       builder tooling (opts key, oracle regexes, vendored
#                       babel.min.js) tracks the latest release.
#   TX_DROP_LOCK        lock file path (default <drop_dir>/.regen.lock).
#
# Exit codes: 0 = published (or another regen holds the lock — skipped),
# non-zero = build/publish failed. Cron MAILTO / systemd OnFailure on a
# non-zero exit is the operator-side alert; the TV-side signal is the QA
# beacon's probe.txDrop.stale flag (qa-beacon.js).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
BUILDER="$HERE/build-tx-drop.mjs"

log() { echo "[regen-tx-drop $(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

if [ $# -lt 2 ]; then
  echo "usage: regen-tx-drop.sh <drop_dir> <server_url> [extra build-tx-drop.mjs args...]" >&2
  exit 1
fi
DROP_DIR="$1"
SERVER_URL="${2%/}"
shift 2

JSI_PATH="${TX_DROP_JSI_PATH-/JavaScriptInjector/public.js}"
LOCK="${TX_DROP_LOCK:-$DROP_DIR/.regen.lock}"

mkdir -p "$DROP_DIR"

# Single-flight: overlapping cron ticks must not interleave tx/ writes.
# Skipping (exit 0) is correct — the in-flight run publishes the same state.
exec 9>"$LOCK"
if command -v flock >/dev/null 2>&1; then
  if ! flock -n 9; then
    log "another regen holds $LOCK; skipping"
    exit 0
  fi
fi

if [ "${TX_DROP_GIT_SYNC:-0}" = "1" ]; then
  log "git sync: $REPO"
  git -C "$REPO" pull --ff-only
fi

if [ -n "${TX_DROP_PRUNE_DAYS:-}" ] && [ -d "$DROP_DIR/tx" ]; then
  PRUNED=$(find "$DROP_DIR/tx" -name '*.js' -mtime +"$TX_DROP_PRUNE_DAYS" -print -delete | wc -l)
  log "pruned $PRUNED stale tx bodies (>${TX_DROP_PRUNE_DAYS}d)"
fi

ARGS=("$DROP_DIR" --merge --web-index "$SERVER_URL")
if [ -n "$JSI_PATH" ]; then
  ARGS+=(--url "$SERVER_URL$JSI_PATH")
fi
if [ -n "${TX_DROP_URL_LIST:-}" ] && [ -f "$TX_DROP_URL_LIST" ]; then
  ARGS+=(--url-list "$TX_DROP_URL_LIST")
fi
ARGS+=("$@")

log "build: node $BUILDER ${ARGS[*]}"
node "$BUILDER" "${ARGS[@]}"
log "published $DROP_DIR/tx-manifest.json"
