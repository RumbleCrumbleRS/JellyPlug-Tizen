#!/usr/bin/env bash
# jsi-backup-cron.sh — JELA-898: unattended snapshotting of the JavaScript
# Injector config.
#
# The committed snapshot under packages/server-shell-drop/snapshots/ is the
# disaster floor — it is refreshed deliberately, through a PR, so it always has
# a human attached. This wrapper is the other half: a scheduled capture that
# bounds how much work sits between that floor and live.
#
# It is the same shape as regen-tx-drop.sh (JEL-653) — single-flight lock,
# unattended entrypoint, non-zero exit is the operator alert — because it runs
# in the same place under the same cron.
#
# usage: jsi-backup-cron.sh <snapshot_dir> [extra jsi-backup.mjs args...]
#
# env knobs:
#   JELLYFIN_URL       required, the Jellyfin origin
#   JELLYFIN_API_KEY   required, an admin API key
#   JSI_BACKUP_KEEP    retain only the newest N snapshots (default 60; at the
#                      4-hourly cadence below that is ~10 days of history).
#                      Snapshots are ~950 KB each, so 60 is ~55 MB.
#   JSI_BACKUP_LOCK    lock file path (default <snapshot_dir>/.jsi-backup.lock)
#
# Exit codes: 0 = a snapshot was written, or the config was unchanged, or
# another run holds the lock. Non-zero = the fetch failed OR a safety floor
# tripped.
#
# THAT SECOND CASE IS THE WHOLE POINT. `jsi-backup.mjs` exits 1 rather than
# snapshot a config that lost most of its entries, so a non-zero exit here is
# not merely "the backup did not run" — it is very likely "the live config just
# got wiped and the last good snapshot was NOT overwritten". Wire cron MAILTO /
# systemd OnFailure to a channel someone actually reads, then go compare live
# against the newest snapshot before doing anything else.
#
# Suggested crontab (every 4 hours):
#
#   MAILTO=ops@example.com
#   0 */4 * * * JELLYFIN_URL=https://your-server JELLYFIN_API_KEY=... \
#     /opt/JellyPlug-Tizen/packages/server-shell-drop/scripts/jsi-backup-cron.sh \
#     /var/backups/jsi
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP="$HERE/jsi-backup.mjs"

log() { echo "[jsi-backup $(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

if [ $# -lt 1 ]; then
  echo "usage: jsi-backup-cron.sh <snapshot_dir> [extra jsi-backup.mjs args...]" >&2
  exit 1
fi
SNAP_DIR="$1"
shift

KEEP="${JSI_BACKUP_KEEP:-60}"
LOCK="${JSI_BACKUP_LOCK:-$SNAP_DIR/.jsi-backup.lock}"

mkdir -p "$SNAP_DIR"

# Single-flight: two overlapping ticks would race on the same --prune-keep
# window and could delete a snapshot the other just wrote. Skipping is correct —
# the in-flight run captures the same state.
exec 9>"$LOCK"
if command -v flock >/dev/null 2>&1; then
  if ! flock -n 9; then
    log "another backup holds $LOCK; skipping"
    exit 0
  fi
fi

# --if-changed keeps the directory from filling with identical copies: the
# config moves a few times a week, not every four hours. Exit 3 means "no
# change", which is a success for our purposes.
set +e
node "$BACKUP" --dir "$SNAP_DIR" --if-changed --prune-keep "$KEEP" "$@"
rc=$?
set -e

case "$rc" in
  0) log "snapshot written to $SNAP_DIR" ;;
  3) log "config unchanged; nothing written" ;;
  *)
    log "FAILED (exit $rc) — if a safety floor tripped, the live config may have"
    log "been wiped. Compare live against the newest snapshot in $SNAP_DIR"
    log "BEFORE re-running with --force."
    exit "$rc"
    ;;
esac

exit 0
