#!/usr/bin/env bash
# Run the fleet E2E test suite locally on the runner machine.
# Usage: bash .github/e2e/run-e2e.sh <suite>
# Run from the apra-fleet repo root.
set -euo pipefail

SUITE=${1:-s1}
REPO_DIR=$(cd "$(dirname "$0")/../.." && pwd)
OUT_DIR="$REPO_DIR/e2e-out"
cd "$REPO_DIR"

mkdir -p "$OUT_DIR/logs"

# ── Load suite + member config ─────────────────────────────────────────────
CONFIG=$(cat .github/e2e/suites.json)
MEMBERS=$(cat .github/e2e/members.json)

PM_PROVIDER=$(echo "$CONFIG" | jq -r ".suites.$SUITE.pm.provider")
PM_OS=$(echo "$CONFIG"       | jq -r ".suites.$SUITE.pm.os")
DOER_OS=$(echo "$CONFIG"     | jq -r ".suites.$SUITE.doer.os")
DOER_PROV=$(echo "$CONFIG"   | jq -r ".suites.$SUITE.doer.provider")
REV_OS=$(echo "$CONFIG"      | jq -r ".suites.$SUITE.reviewer.os")
REV_PROV=$(echo "$CONFIG"    | jq -r ".suites.$SUITE.reviewer.provider")
VCS=$(echo "$CONFIG"         | jq -r ".suites.$SUITE.vcs")

DOER_HOST=$(echo "$MEMBERS"   | jq -r ".$DOER_OS.host")
DOER_USER=$(echo "$MEMBERS"   | jq -r ".$DOER_OS.username")
DOER_FOLDER=$(echo "$MEMBERS" | jq -r ".$DOER_OS.work_folder")
REV_HOST=$(echo "$MEMBERS"    | jq -r ".$REV_OS.host")
REV_USER=$(echo "$MEMBERS"    | jq -r ".$REV_OS.username")
REV_FOLDER=$(echo "$MEMBERS"  | jq -r ".$REV_OS.work_folder")
TOY_URL=$(echo "$MEMBERS"     | jq -r ".toy_projects.$VCS")

RUN_ID=$(date +%Y%m%d-%H%M%S)
BRANCH_PREFIX="e2e-$SUITE-$RUN_ID"

echo "Suite: $SUITE | PM: $PM_OS/$PM_PROVIDER | Run: $RUN_ID"

# ── Build + install fleet binary ──────────────────────────────────────────
echo "--- Building fleet binary ---"
npm ci --silent
npm run build:binary --silent
if [ "$(uname -s)" = "MINGW"* ] || [ "${OS:-}" = "Windows_NT" ]; then
  BIN=$(ls dist/apra-fleet-installer-*.exe | head -1)
else
  BIN=$(ls dist/apra-fleet-installer-* | grep -v -E '\.(blob|cjs|json|exe)$' | head -1)
fi
chmod +x "$BIN" 2>/dev/null || true
"$BIN" install --force

if [ "${OS:-}" = "Windows_NT" ]; then
  FLEET_BIN="$HOME/.apra-fleet/bin/apra-fleet.exe"
else
  FLEET_BIN="$HOME/.apra-fleet/bin/apra-fleet"
fi
echo "Fleet: $("$FLEET_BIN" --version)"

# ── Smoke-test PM LLM auth ────────────────────────────────────────────────
echo "--- Verifying PM LLM auth ---"
if [ "$PM_PROVIDER" = "claude" ]; then
  output=$(claude -p "Reply with the single word: ready" --max-turns 1 2>&1)
  echo "$output"
  if ! echo "$output" | grep -qi "ready"; then
    echo "ERROR: PM claude auth failed — run provision_llm_auth on fleet-e2e-win first."
    exit 1
  fi
fi
echo "PM auth OK"

# ── Set up MCP config ─────────────────────────────────────────────────────
bash .github/e2e/setup-mcp.sh

# ── Render test script ────────────────────────────────────────────────────
echo "--- Rendering test script ---"
sed \
  -e "s|{{SUITE_ID}}|$SUITE|g" \
  -e "s|{{PM_OS}}|$PM_OS|g" \
  -e "s|{{PM_PROVIDER}}|$PM_PROVIDER|g" \
  -e "s|{{DOER_HOST}}|$DOER_HOST|g" \
  -e "s|{{DOER_OS}}|$DOER_OS|g" \
  -e "s|{{DOER_PROVIDER}}|$DOER_PROV|g" \
  -e "s|{{REVIEWER_HOST}}|$REV_HOST|g" \
  -e "s|{{REVIEWER_OS}}|$REV_OS|g" \
  -e "s|{{REVIEWER_PROVIDER}}|$REV_PROV|g" \
  -e "s|{{TOY_PROJECT_URL}}|$TOY_URL|g" \
  -e "s|{{VCS}}|$VCS|g" \
  -e "s|{{BRANCH_PREFIX}}|$BRANCH_PREFIX|g" \
  -e "s|{{DOER_FOLDER}}|$DOER_FOLDER|g" \
  -e "s|{{REVIEWER_FOLDER}}|$REV_FOLDER|g" \
  .github/e2e/test-script.md > "$OUT_DIR/rendered-test-script.md"

# ── Run LLM test (T1–T5) ─────────────────────────────────────────────────
echo "--- Running E2E (T1–T5) ---"
if [ "$PM_PROVIDER" = "claude" ]; then
  claude \
    -p "$(cat "$OUT_DIR/rendered-test-script.md")" \
    --mcp-config mcp-runtime.json \
    --output-format stream-json \
    --verbose \
    --max-turns 80 \
    > "$OUT_DIR/raw-output.txt" 2>&1 || true
else
  gemini \
    --output-format stream-json \
    --mcp-config mcp-runtime.json \
    -p "$(cat "$OUT_DIR/rendered-test-script.md")" \
    > "$OUT_DIR/raw-output.txt" 2>&1 || true
fi

# ── Collect fleet log ─────────────────────────────────────────────────────
if python3 -c "import sys" > /dev/null 2>&1; then PYTHON=python3
elif python -c "import sys" > /dev/null 2>&1; then PYTHON=python
else echo "WARNING: no Python found, skipping log extraction"; PYTHON=""; fi

FLEET_LOG=""
if [ -n "$PYTHON" ]; then
  FLEET_LOG=$("$PYTHON" .github/e2e/extract-fleet-log-path.py "$OUT_DIR/raw-output.txt" || true)
fi
if [ -n "$FLEET_LOG" ] && [ -f "$FLEET_LOG" ]; then
  cp "$FLEET_LOG" "$OUT_DIR/logs/fleet-pm.log"
  echo "Fleet log: $(wc -l < "$OUT_DIR/logs/fleet-pm.log") lines"
else
  echo "WARNING: fleet log not found at '$FLEET_LOG'"
fi

# ── Extract results ───────────────────────────────────────────────────────
if [ -n "$PYTHON" ]; then
  "$PYTHON" .github/e2e/extract-results.py "$OUT_DIR/raw-output.txt" "$SUITE" "$PM_OS" "$PM_PROVIDER" \
    > "$OUT_DIR/results.json" \
    || echo '{"overall":"FAIL","error":"extract-results.py failed"}' > "$OUT_DIR/results.json"
fi

# ── Telemetry ─────────────────────────────────────────────────────────────
(cd "$OUT_DIR" && node "$REPO_DIR/.github/e2e/extract-telemetry.js") || true

# ── T6 teardown ───────────────────────────────────────────────────────────
echo "--- T6 teardown ---"
if [ "$PM_PROVIDER" = "claude" ]; then
  claude \
    -p "$(cat .github/e2e/t6-teardown.md)" \
    --mcp-config mcp-runtime.json \
    --max-turns 15 \
    > "$OUT_DIR/t6-output.txt" 2>&1 || true
else
  gemini \
    --mcp-config mcp-runtime.json \
    -p "$(cat .github/e2e/t6-teardown.md)" \
    > "$OUT_DIR/t6-output.txt" 2>&1 || true
fi
tail -3 "$OUT_DIR/t6-output.txt" || true

# ── Summary ───────────────────────────────────────────────────────────────
echo ""
echo "=== Results ==="
if [ -f "$OUT_DIR/results.json" ]; then
  cat "$OUT_DIR/results.json" | jq '{overall, results: [.results[]? | {test, status, notes}]}' 2>/dev/null \
    || cat "$OUT_DIR/results.json"
fi
echo ""
echo "Artifacts: $OUT_DIR"
