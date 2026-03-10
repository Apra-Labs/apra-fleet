#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="$HOME/.apra-fleet"
SKILLS_DIR="$HOME/.claude/skills"
SETTINGS_FILE="$HOME/.claude/settings.json"

echo "Installing Apra Fleet..."

# --- Step 1: Detect mode (tarball extract vs in-place) ---
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# If dist/ exists alongside this script, we're running from an extracted tarball
if [ -d "$SCRIPT_DIR/dist" ]; then
  echo "Installing from tarball to $INSTALL_DIR"
  mkdir -p "$INSTALL_DIR"
  # Copy all required files (idempotent — overwrites previous install)
  cp -r "$SCRIPT_DIR/dist" "$INSTALL_DIR/"
  cp -r "$SCRIPT_DIR/skills" "$INSTALL_DIR/"
  cp -r "$SCRIPT_DIR/hooks" "$INSTALL_DIR/"
  cp "$SCRIPT_DIR/package.json" "$INSTALL_DIR/"
  cp "$SCRIPT_DIR/package-lock.json" "$INSTALL_DIR/"
  cp "$SCRIPT_DIR/version.json" "$INSTALL_DIR/"
else
  echo "Error: dist/ not found. Run install.sh from an extracted tarball."
  echo "Download the tarball from: https://github.com/Apra-Labs/apra-fleet/releases"
  exit 1
fi

# --- Step 2: Install production dependencies ---
echo "Installing dependencies..."
cd "$INSTALL_DIR"
npm ci --omit=dev --no-fund --no-audit

# --- Step 3: Copy skills ---
echo "Installing PMO skill..."
mkdir -p "$SKILLS_DIR"
cp -r "$INSTALL_DIR/skills/pmo" "$SKILLS_DIR/"

# --- Step 4: Install PostToolUse hook ---
echo "Installing hooks..."
mkdir -p "$(dirname "$SETTINGS_FILE")"

if [ -f "$SETTINGS_FILE" ]; then
  # Merge hook config into existing settings using Node.js (available since we just installed deps)
  node -e "
    const fs = require('fs');
    const settings = JSON.parse(fs.readFileSync('$SETTINGS_FILE', 'utf-8'));
    const hookConfig = JSON.parse(fs.readFileSync('$INSTALL_DIR/hooks/hooks-config.json', 'utf-8'));

    // Initialize hooks structure if missing
    settings.hooks = settings.hooks || {};
    settings.hooks.PostToolUse = settings.hooks.PostToolUse || [];

    // Check if our hook already exists (by matcher)
    const matcher = hookConfig.hooks.PostToolUse[0].matcher;
    const existing = settings.hooks.PostToolUse.findIndex(h => h.matcher === matcher);

    if (existing >= 0) {
      settings.hooks.PostToolUse[existing] = hookConfig.hooks.PostToolUse[0];
    } else {
      settings.hooks.PostToolUse.push(hookConfig.hooks.PostToolUse[0]);
    }

    fs.writeFileSync('$SETTINGS_FILE', JSON.stringify(settings, null, 2) + '\n');
  "
else
  # Create settings.json from hook config
  cp "$INSTALL_DIR/hooks/hooks-config.json" "$SETTINGS_FILE"
fi

# --- Step 5: Register MCP server ---
echo "Registering MCP server..."
claude mcp remove fleet 2>/dev/null || true
claude mcp add --scope user fleet -- node "$INSTALL_DIR/dist/index.js"

# --- Step 6: Print version ---
VERSION=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$INSTALL_DIR/version.json','utf-8')).version)")
echo ""
echo "Apra Fleet v${VERSION} installed successfully."
echo "  Install dir: $INSTALL_DIR"
echo "  PMO skill:   $SKILLS_DIR/pmo/"
echo ""
echo "Run /mcp in Claude Code to load the server."
