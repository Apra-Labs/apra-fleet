#!/usr/bin/env bash
# demo/setup-env.sh
#
# Linux port of demo/setup-env.ps1 -- stages one isolated environment
# for the KB value A/B test using apra-fleet's own codebase as the target.
#
# Usage:
#   ./demo/setup-env.sh A          # Env A: no KB (control)
#   ./demo/setup-env.sh B          # Env B: KB enabled (treatment)
#   ./demo/setup-env.sh A --force  # wipe + recreate existing sandbox
#   ./demo/setup-env.sh A --skip-install  # stage only, no install
#
# Each environment gets:
#   - A full git clone of this repo at the same base commit
#   - Its own .beads/ database (automatic -- per-clone)
#   - Its own APRA_FLEET_DATA_DIR (KB isolation)
#   - A source-able env snippet that sets the data dir
#
# The sprint target is c6o.2 (per-member provider routing) -- real
# development work on this codebase, not a toy repo.
#
# IMPORTANT: apra-fleet install is MACHINE-GLOBAL (skills, MCP server,
# CLAUDE.md are all written to ~/.claude). Running setup for Env A then
# Env B will overwrite the global registration. This is expected -- the
# env snippet isolates only the KB/data layer via APRA_FLEET_DATA_DIR.
# Back up your own ~/.claude/skills/pm if you have a real setup.

set -euo pipefail

# ---------------------------------------------------------------------------
# Args
# ---------------------------------------------------------------------------
ENV="${1:-}"
FORCE=false
SKIP_INSTALL=false

for arg in "${@:2}"; do
  case "$arg" in
    --force) FORCE=true ;;
    --skip-install) SKIP_INSTALL=true ;;
    *) echo "Unknown option: $arg"; exit 1 ;;
  esac
done

if [[ "$ENV" != "A" && "$ENV" != "B" ]]; then
  echo "Usage: $0 <A|B> [--force] [--skip-install]"
  exit 1
fi

ENV_LOWER=$(echo "$ENV" | tr '[:upper:]' '[:lower:]')

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE_COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD)"
DEMO_ROOT="/tmp/sprint-test"
SANDBOX_DIR="$DEMO_ROOT/sandbox-$ENV_LOWER"
DATA_DIR="$DEMO_ROOT/data-$ENV_LOWER"
ENV_SNIPPET="$DEMO_ROOT/env-$ENV_LOWER.sh"
DIST_INDEX="$REPO_ROOT/dist/index.js"

# ---------------------------------------------------------------------------
# Safety checks
# ---------------------------------------------------------------------------
RESOLVED_SANDBOX="$(readlink -f "$SANDBOX_DIR" 2>/dev/null || echo "$SANDBOX_DIR")"
RESOLVED_REPO="$(readlink -f "$REPO_ROOT")"

if [[ "$RESOLVED_SANDBOX" == "$RESOLVED_REPO" ]]; then
  echo "ERROR: refusing to use this repo as a sandbox."
  exit 1
fi

for DIR in "$SANDBOX_DIR" "$DATA_DIR"; do
  if [[ -d "$DIR" ]]; then
    if ! $FORCE; then
      echo ""
      echo "REFUSING TO CONTINUE: $DIR already exists."
      echo "Re-run with --force to wipe and recreate:"
      echo "  $0 $ENV --force"
      echo ""
      exit 1
    fi
    echo "Force: removing $DIR ..."
    rm -rf "$DIR"
  fi
done

mkdir -p "$DEMO_ROOT" "$SANDBOX_DIR" "$DATA_DIR"

# ---------------------------------------------------------------------------
# Clone the repo (full clone at the current branch/commit)
# ---------------------------------------------------------------------------
echo ""
echo "[1/5] Cloning $REPO_ROOT -> $SANDBOX_DIR ..."

CURRENT_BRANCH="$(git -C "$REPO_ROOT" branch --show-current)"
git clone --branch "$CURRENT_BRANCH" "$REPO_ROOT" "$SANDBOX_DIR" 2>&1 | tail -1
cd "$SANDBOX_DIR"

# Point origin at the real remote so the project slug resolves correctly
REAL_REMOTE="$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null || true)"
if [[ -n "$REAL_REMOTE" ]]; then
  git remote set-url origin "$REAL_REMOTE"
fi

echo "  Branch: $CURRENT_BRANCH at $(git log --oneline -1)"

# ---------------------------------------------------------------------------
# Initialize beads in the sandbox (copy from source repo)
# ---------------------------------------------------------------------------
echo "[2/5] Copying beads database to sandbox ..."

# Direct copy preserves the database name (apra_fleet), issue prefix
# (apra-fleet-), and all issue state including c6o.2 sprint targets.
# bd init + bd import fails due to schema mismatch on the events table.
rm -rf "$SANDBOX_DIR/.beads"
cp -r "$REPO_ROOT/.beads" "$SANDBOX_DIR/.beads"

# Strip sync.remote so the sandbox never pushes to the shared Dolt remote
if [[ -f "$SANDBOX_DIR/.beads/config.yaml" ]]; then
  sed -i '/^sync\.remote:/d' "$SANDBOX_DIR/.beads/config.yaml"
fi

ISSUE_COUNT="$(cd "$SANDBOX_DIR" && bd list --flat --all 2>/dev/null | wc -l || echo 0)"
C6O_CHECK="$(cd "$SANDBOX_DIR" && bd show apra-fleet-c6o.2 2>/dev/null | head -1)" || C6O_CHECK="NOT FOUND"
echo "  $ISSUE_COUNT issues copied. c6o.2: $C6O_CHECK"

# ---------------------------------------------------------------------------
# npm install in sandbox
# ---------------------------------------------------------------------------
if [[ -f "$SANDBOX_DIR/package.json" ]]; then
  echo "[3/5] Running npm ci + build in sandbox ..."
  cd "$SANDBOX_DIR"
  npm ci --silent 2>&1 | tail -3
  npm run build --silent 2>&1 | tail -3
  if [[ ! -f "$SANDBOX_DIR/dist/index.js" ]]; then
    echo "  ERROR: dist/index.js missing after build -- MCP server will not start."
    exit 1
  fi
else
  echo "[3/5] No package.json -- skipping npm ci."
fi

# ---------------------------------------------------------------------------
# Per-env data dir snippet (KB isolation)
# ---------------------------------------------------------------------------
echo "[4/5] Writing $ENV_SNIPPET ..."
cat > "$ENV_SNIPPET" << ENVEOF
# Source this in the shell BEFORE starting Claude Code for Env $ENV:
#   source $ENV_SNIPPET
export APRA_FLEET_DATA_DIR="$DATA_DIR"
echo "APRA_FLEET_DATA_DIR set to \$APRA_FLEET_DATA_DIR (Env $ENV)"
ENVEOF

# ---------------------------------------------------------------------------
# Install (builds the MCP server registration + skills)
# ---------------------------------------------------------------------------
echo "[5/5] Install step for Env $ENV ..."

if $SKIP_INSTALL; then
  echo "  --skip-install: NOT running the installer."
elif [[ ! -f "$DIST_INDEX" ]]; then
  echo "  ERROR: $DIST_INDEX not found. Run 'npm run build' in $REPO_ROOT first."
  exit 1
else
  echo "  Running: node $DIST_INDEX install (from $SANDBOX_DIR) ..."
  cd "$SANDBOX_DIR"
  node "$DIST_INDEX" install 2>&1 | tail -5
fi

# ---------------------------------------------------------------------------
# KB state
# ---------------------------------------------------------------------------
if [[ "$ENV" == "A" ]]; then
  # Remove the bible so kb_import has nothing to seed -- Env A is the no-KB control.
  rm -f "$SANDBOX_DIR/.fleet/kb-canonical.json"
  echo ""
  echo "[KB] Env A (control): APRA_FLEET_DATA_DIR=$DATA_DIR"
  echo "     Bible removed from sandbox. kb_import/kb_session_prime will return nothing."
  echo "     Any captures during sprint go to $DATA_DIR (isolated, ignored)."
elif [[ "$ENV" == "B" ]]; then
  # Copy the bible to the data dir so it survives branch switches.
  # auto-sprint creates the sprint branch from origin/main, which does NOT
  # have .fleet/kb-canonical.json -- the file only exists on
  # feat/code-intelligence-abstraction. Stashing it in DATA_DIR means
  # primeKB() can pass an explicit --path to kb_import.
  BIBLE_SRC="$SANDBOX_DIR/.fleet/kb-canonical.json"
  BIBLE_DST="$DATA_DIR/kb-canonical.json"
  if [[ -f "$BIBLE_SRC" ]]; then
    cp "$BIBLE_SRC" "$BIBLE_DST"
    BIBLE_ENTRIES="$(python3 -c "import json; print(len(json.load(open('$BIBLE_DST'))))" 2>/dev/null || echo '?')"
    echo ""
    echo "[KB] Env B (treatment): APRA_FLEET_DATA_DIR=$DATA_DIR"
    echo "     Bible copied to $BIBLE_DST ($BIBLE_ENTRIES entries)."
    echo "     primeKB() will pass this path to kb_import so it survives branch switches."
  else
    echo ""
    echo "[KB] WARNING: Bible not found at $BIBLE_SRC"
    echo "     Env B will run without KB (same as control). Check the branch."
  fi
fi

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
echo ""
echo "Env $ENV staged."
echo "  Sandbox:     $SANDBOX_DIR"
echo "  Data dir:    $DATA_DIR"
echo "  Env snippet: $ENV_SNIPPET"
echo "  Base commit: $BASE_COMMIT"
echo ""
echo "Next steps:"
echo "  1. In a NEW terminal:"
echo "       source $ENV_SNIPPET"
echo "       cd $SANDBOX_DIR"
echo "       claude"
echo ""
echo "  2. In the Claude session, run the sprint:"
echo "       /auto-sprint"
echo "       issues: [\"apra-fleet-c6o.2\"]"
echo "       branch: \"test/kb-eval-$ENV_LOWER\""
echo ""
if [[ "$ENV" == "A" ]]; then
  echo "  3. After sprint completes, collect metrics:"
  echo "       DEMO_SANDBOX_DIR=$SANDBOX_DIR DEMO_DATA_DIR=$DATA_DIR node $REPO_ROOT/demo/collect-metrics.mjs A sprint1"
  echo ""
  echo "  When ready for Env B:"
  echo "       $0 B"
  echo "  (This will overwrite the global ~/.claude skills/MCP registration.)"
fi
if [[ "$ENV" == "B" ]]; then
  echo "  3. After sprint completes, collect metrics:"
  echo "       DEMO_SANDBOX_DIR=$SANDBOX_DIR DEMO_DATA_DIR=$DATA_DIR node $REPO_ROOT/demo/collect-metrics.mjs B sprint1"
  echo ""
  echo "  4. Generate the comparison report:"
  echo "       node $REPO_ROOT/demo/gain-report.mjs"
fi
echo ""
