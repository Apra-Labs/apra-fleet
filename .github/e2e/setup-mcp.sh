#!/usr/bin/env bash
# Write mcp-runtime.json pointing at the locally installed fleet binary.
# Run from the checkout root — mcp-runtime.json lands in the working directory.
set -euo pipefail

if [ "${RUNNER_OS:-}" = "Windows" ]; then
  FLEET_BIN="$HOME/.apra-fleet/bin/apra-fleet.exe"
  FLEET_BIN_JSON=$(cygpath -w "$FLEET_BIN" | sed 's/\\/\\\\/g')
else
  FLEET_BIN="$HOME/.apra-fleet/bin/apra-fleet"
  FLEET_BIN_JSON="$FLEET_BIN"
fi

printf '{"mcpServers":{"apra-fleet":{"type":"stdio","command":"%s","args":[]}}}\n' \
  "$FLEET_BIN_JSON" > mcp-runtime.json

echo "mcp-runtime.json → $FLEET_BIN_JSON"
