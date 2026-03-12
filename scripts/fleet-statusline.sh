#!/usr/bin/env bash
# Fleet statusline script for Claude Code.
# Reads pre-rendered statusline.txt and appends a freshness indicator
# based on file mtime — gradient from green to red:
#
# Claude Code pipes JSON session data to stdin — we consume it to avoid
# broken-pipe but don't need it; the fleet server writes the real state.

cat > /dev/null  # drain stdin

STATUSLINE_FILE="${APRA_FLEET_DATA_DIR:-$HOME/.apra-fleet/data}/statusline.txt"

if [ ! -f "$STATUSLINE_FILE" ]; then
  echo "Fleet: no status"
  exit 0
fi

# Read the pre-rendered line
LINE=$(cat "$STATUSLINE_FILE")

# Compute age in seconds (portable: works on macOS + Linux + Git Bash)
if stat --version >/dev/null 2>&1; then
  # GNU stat (Linux, Git Bash on Windows)
  MTIME=$(stat -c %Y "$STATUSLINE_FILE" 2>/dev/null)
else
  # BSD stat (macOS)
  MTIME=$(stat -f %m "$STATUSLINE_FILE" 2>/dev/null)
fi

NOW=$(date +%s)
AGE=$(( NOW - ${MTIME:-0} ))

if   [ "$AGE" -lt 10 ];   then FRESH="✅"    # <10s  fresh
elif [ "$AGE" -lt 60 ];   then FRESH="☑️"    # <1m   recent
elif [ "$AGE" -lt 300 ];  then FRESH="✔️"    # <5m   ok
elif [ "$AGE" -lt 900 ];  then FRESH="⏳"    # <15m  getting stale
elif [ "$AGE" -lt 1800 ]; then FRESH="⚠️"    # <30m  stale warning
elif [ "$AGE" -lt 3600 ]; then FRESH="🟡"    # <1h   attention
elif [ "$AGE" -lt 7200 ]; then FRESH="🟠"    # <2h   concern
else                            FRESH="🔴"    # >2h   stale, possibly down
fi

echo "${LINE}  ${FRESH}"
