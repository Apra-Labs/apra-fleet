#!/usr/bin/env bash
# Write the GitHub step summary from results.json (T1–T5) + telemetry.
# Expects SUITE and GITHUB_STEP_SUMMARY to be set in the environment.
set -euo pipefail

# Results table
echo "## Fleet E2E – Suite ${SUITE}" >> "$GITHUB_STEP_SUMMARY"
echo ""                              >> "$GITHUB_STEP_SUMMARY"
echo "| Test | Status | Notes |"    >> "$GITHUB_STEP_SUMMARY"
echo "|------|--------|-------|"    >> "$GITHUB_STEP_SUMMARY"
jq -r '.results[] | "| \(.test) | \(.status) | \(.notes) |"' \
  results.json >> "$GITHUB_STEP_SUMMARY" 2>/dev/null \
  || echo "| error | FAIL | could not parse results |" >> "$GITHUB_STEP_SUMMARY"
echo ""                              >> "$GITHUB_STEP_SUMMARY"
OVERALL=$(jq -r '.overall' results.json 2>/dev/null || echo "FAIL")
echo "**Overall: $OVERALL**"        >> "$GITHUB_STEP_SUMMARY"
echo ""                              >> "$GITHUB_STEP_SUMMARY"

# Telemetry table (only if present)
if jq -e '.telemetry' results.json > /dev/null 2>&1; then
  echo "### Telemetry"                                                        >> "$GITHUB_STEP_SUMMARY"
  echo ""                                                                     >> "$GITHUB_STEP_SUMMARY"
  echo "| Role | Wall (s) | Active (s) | Tokens In | Tokens Out | Total |"  >> "$GITHUB_STEP_SUMMARY"
  echo "|------|----------|------------|-----------|------------|-------|"   >> "$GITHUB_STEP_SUMMARY"
  jq -r '.telemetry[] | "| \(.role) | \(.wall_time_s) | \(.active_time_s) | \(.tokens_in) | \(.tokens_out) | \(.tokens_total) |"' \
    results.json >> "$GITHUB_STEP_SUMMARY" 2>/dev/null
fi
