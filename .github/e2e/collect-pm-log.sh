#!/usr/bin/env bash
# Collect the fleet MCP subprocess log — the one with the most content.
#
# install --force creates a short daemon stub and the T6 safety cleanup also
# starts a brief subprocess; both are smaller than the main test log.
# Selecting by max byte count reliably picks the right file.
set -euo pipefail

if [ -z "${RUN_DIR:-}" ]; then
  echo "ERROR: RUN_DIR is not set" >&2
  exit 1
fi

mkdir -p "$RUN_DIR/logs"

if [ "${RUNNER_OS:-}" = "Windows" ]; then
  LOG_DIR="$(cygpath "$USERPROFILE")/.apra-fleet/data/logs"
else
  LOG_DIR="$HOME/.apra-fleet/data/logs"
fi

FLEET_LOG=$(
  ls "$LOG_DIR"/fleet-*.log 2>/dev/null \
    | xargs -I{} sh -c 'echo "$(wc -c < {}) {}"' 2>/dev/null \
    | sort -rn \
    | awk 'NR==1{print $2}'
)

if [ -n "$FLEET_LOG" ]; then
  cp "$FLEET_LOG" "$RUN_DIR/logs/fleet-pm.log"
  echo "Collected: $(basename "$FLEET_LOG") ($(wc -c < "$RUN_DIR/logs/fleet-pm.log") bytes, $(wc -l < "$RUN_DIR/logs/fleet-pm.log") lines)"
else
  echo "No fleet log found in $LOG_DIR"
fi
