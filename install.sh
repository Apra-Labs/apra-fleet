#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="$HOME/.claude-fleet-mcp"
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
rm -rf node_modules
npm install --omit=dev --no-fund --no-audit

echo ""
claude mcp add --scope user fleet -- node "$INSTALL_DIR/dist/index.js"
echo ""
echo "Done. Run /mcp in Claude Code to load the server."
