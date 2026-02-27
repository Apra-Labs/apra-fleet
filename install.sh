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

echo ""
echo "Build complete."
echo ""

if [ "${1:-}" = "--auto" ]; then
  claude mcp add --scope user fleet -- node "$INSTALL_DIR/dist/index.js"
  echo "Registered fleet MCP server for your user."
else
  echo "Run this to register the MCP server:"
  echo ""
  echo "  claude mcp add --scope user fleet -- node $INSTALL_DIR/dist/index.js"
  echo ""
  echo "Or re-run with --auto to do it automatically:"
  echo "  bash $INSTALL_DIR/install.sh --auto"
fi

echo ""
echo "Then run /mcp in Claude Code to load the server."
