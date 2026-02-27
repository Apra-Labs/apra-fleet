#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="$HOME/.claude-fleet-mcp"
SETTINGS_FILE="$HOME/.claude/settings.json"
REPO_URL="https://github.com/Apra-Labs/claude-code-fleet-mcp.git"

echo "Installing Claude Code Fleet MCP..."

if [ -d "$INSTALL_DIR" ]; then
  echo "Updating existing installation at $INSTALL_DIR"
  git -C "$INSTALL_DIR" pull --ff-only
else
  echo "Cloning to $INSTALL_DIR"
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"
npm install --no-fund --no-audit
npm run build

echo ""
echo "Build complete."
echo ""

MCP_ENTRY=$(cat <<EOF
{
  "mcpServers": {
    "fleet": {
      "command": "node",
      "args": ["$INSTALL_DIR/dist/index.js"]
    }
  }
}
EOF
)

if [ "${1:-}" = "--auto" ]; then
  mkdir -p "$(dirname "$SETTINGS_FILE")"
  if [ -f "$SETTINGS_FILE" ]; then
    # Merge fleet entry into existing mcpServers
    MERGED=$(node -e "
      const fs = require('fs');
      const settings = JSON.parse(fs.readFileSync('$SETTINGS_FILE', 'utf8'));
      settings.mcpServers = settings.mcpServers || {};
      settings.mcpServers.fleet = { command: 'node', args: ['$INSTALL_DIR/dist/index.js'] };
      console.log(JSON.stringify(settings, null, 2));
    ")
    echo "$MERGED" > "$SETTINGS_FILE"
    echo "Updated $SETTINGS_FILE with fleet MCP server entry."
  else
    echo "$MCP_ENTRY" > "$SETTINGS_FILE"
    echo "Created $SETTINGS_FILE with fleet MCP server entry."
  fi
else
  echo "Add this to $SETTINGS_FILE:"
  echo ""
  echo "$MCP_ENTRY"
  echo ""
  echo "Or re-run with --auto to do it automatically:"
  echo "  bash $INSTALL_DIR/install.sh --auto"
fi

echo ""
echo "Then run /mcp in Claude Code to load the server."
