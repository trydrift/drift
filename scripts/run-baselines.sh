#!/usr/bin/env bash
# Re-measure the three external baselines, politely.
#
# Written to run while someone is using the machine: low CPU priority, a
# conservative concurrency, one dataset at a time, and a disk guard that stops
# before filling the volume rather than after. Nothing here changes what is
# measured — the per-case budget stays at its default, so findings are
# comparable with the baselines already committed.
#
# Resumable: each dataset uses a fixed run id and `--resume`, so re-running
# this script picks up wherever it stopped instead of starting over.
set -uo pipefail

cd "$(dirname "$0")/.."
LOG_DIR="${LOG_DIR:-$(pwd)/.baseline-logs}"
mkdir -p "$LOG_DIR"

# Leave the machine usable: 3 of 12 cores' worth of cases in flight, and every
# child at the lowest priority the scheduler offers, so an interactive process
# always wins.
CONCURRENCY="${CONCURRENCY:-3}"
NICENESS="${NICENESS:-15}"
# Stop while there is still room to work, not once the disk is full. The
# previous run of this corpus filled the volume mid-flight.
MIN_FREE_GB="${MIN_FREE_GB:-12}"

free_gb() { df -g / | awk 'NR==2 {print $4}'; }

log() { printf '%s  %s\n' "$(date '+%H:%M:%S')" "$*" | tee -a "$LOG_DIR/progress.log"; }

log "starting: concurrency=$CONCURRENCY niceness=$NICENESS min-free=${MIN_FREE_GB}G free=$(free_gb)G"

# Smallest first, so there are numbers to look at early rather than after the
# Java corpus has run all day.
for spec in "swe-bump:p3-swe-bump" "timemachine:p3-timemachine" "bump:p3-bump"; do
  dataset="${spec%%:*}"
  run_id="${spec##*:}"

  free="$(free_gb)"
  if [ "$free" -lt "$MIN_FREE_GB" ]; then
    log "STOPPING before $dataset: only ${free}G free, need ${MIN_FREE_GB}G"
    exit 1
  fi

  log "=== $dataset -> $run_id (free ${free}G) ==="
  nice -n "$NICENESS" node --experimental-strip-types eval/src/external/cli.ts \
    "$dataset" --run-id "$run_id" --resume --concurrency "$CONCURRENCY" \
    >>"$LOG_DIR/$dataset.log" 2>&1
  status=$?

  if [ $status -eq 0 ]; then
    log "=== $dataset finished (free $(free_gb)G) ==="
  else
    log "=== $dataset exited $status — rerun this script to resume (free $(free_gb)G) ==="
  fi
done

log "all datasets attempted"
