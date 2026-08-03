#!/usr/bin/env bash
# apra-fleet-fyc.2.3: replays the npm-publish CI job's gating sequence
# (.github/workflows/ci.yml, `npm-publish` job) locally, on a clean checkout,
# so the post-kuh.5 packaging model (fleet-sprint engine shipped as source
# under packages/apra-fleet-se/ rather than an esbuild bundle) can be
# verified end-to-end before a real release tag triggers the real job.
#
# Usage: bash tests/integration/npm-publish-gate.sh
# Run from a clean checkout / clean dist/ (the script itself does
# `git clean -xdf dist` up front) so stale local build:binary artifacts do
# not pollute the pack.
#
# NOTE: the "Pack + install into a clean temp prefix" step below calls the
# real `apra-fleet install` command, which refuses to run if ANY apra-fleet
# process is already running anywhere on the host (src/cli/install.ts
# isApraFleetRunning() -- a machine-wide `pgrep -x apra-fleet`, not scoped to
# the install target directory). On a real CI runner this is never true. On
# a shared dev machine that already has a persistent apra-fleet service
# running (e.g. a FleetView/orchestrator server), this step will legitimately
# refuse and exit non-zero rather than silently killing that unrelated
# process -- do not add --force to "fix" that from within this script; that
# would kill a live process this script has no way to know is safe to stop.
# See apra-fleet-fyc.2.3 verification notes / follow-up bead for the guard's
# scope.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

echo "== Step 0: clean dist/ =="
git clean -xdf dist

echo "== Step 1: npm ci + prepublishOnly =="
npm ci
npm run prepublishOnly

echo "== Step 2: Verify shebang =="
head -1 dist/index.js | grep -q '^#!/usr/bin/env node'
head -1 packages/apra-fleet-se/bin/cli.mjs | grep -q '^#!/usr/bin/env node'
echo "Shebang checks passed"

echo "== Step 3: Dry-run pack verification =="
npm pack --dry-run 2>&1 | tee pack-output.txt
grep -q 'dist/index.js' pack-output.txt
grep -q 'version.json' pack-output.txt
grep -q 'hooks/hooks-config.json' pack-output.txt
grep -q 'skills/pm/' pack-output.txt || grep -q 'skills/fleet/' pack-output.txt
grep -q 'packages/apra-fleet-se/bin/cli.mjs' pack-output.txt
grep -q 'packages/apra-fleet-se/fleet-sprint/runner.js' pack-output.txt
grep -q 'packages/apra-fleet-se/workflow.json' pack-output.txt
grep -q 'dist/agents/schemas/' pack-output.txt
echo "Pack verification passed"

echo "== Step 4: Clean-pack guard -- reject stale SEA build artifacts =="
npm pack --dry-run 2>&1 | tee pack-check.txt
if grep -qE '\.(exe)$|sea-prep\.blob|sea-bundle\.cjs' pack-check.txt; then
  echo "::error::Pack contains stale SEA build artifacts (exe/sea-prep.blob/sea-bundle.cjs). Clean dist/ and retry."
  grep -E '\.(exe)$|sea-prep\.blob|sea-bundle\.cjs' pack-check.txt
  exit 1
fi
PACK_SIZE=$(grep 'unpacked size' pack-check.txt | grep -oE '[0-9]+(\.[0-9]+)? [kMG]B' | head -1)
echo "Unpacked size: $PACK_SIZE"
PACK_BYTES=$(grep 'unpacked size' pack-check.txt | grep -oE '[0-9]+' | head -1)
if [ -n "$PACK_BYTES" ] && [ "$PACK_BYTES" -gt 10000000 ]; then
  echo "::error::Pack unpacked size exceeds 10MB ($PACK_SIZE). Check for stale SEA artifacts in dist/."
  exit 1
fi
echo "Clean-pack guard passed"

echo "== Step 5: Pack + install into a clean temp prefix (fleet-sprint smoke test) =="
TMP_INSTALL=$(mktemp -d)
npm pack --pack-destination "$TMP_INSTALL"
TARBALL=$(ls "$TMP_INSTALL"/apralabs-apra-fleet-*.tgz)

INSTALL_PREFIX=$(mktemp -d)
npm install --prefix "$INSTALL_PREFIX" "$TARBALL" --no-save --no-audit --no-fund
PKG_DIR="$INSTALL_PREFIX/node_modules/@apralabs/apra-fleet"
BIN="$INSTALL_PREFIX/node_modules/.bin/apra-fleet"

test -d "$PKG_DIR/dist/agents/schemas" || { echo "::error::dist/agents/schemas/ missing from the packed tarball."; exit 1; }
SCHEMA_COUNT=$(ls "$PKG_DIR/dist/agents/schemas/"*.json 2>/dev/null | wc -l)
if [ "$SCHEMA_COUNT" -eq 0 ]; then
  echo "::error::dist/agents/schemas/ is present but contains no *.json files."
  exit 1
fi

FAKEHOME=$(mktemp -d)
export HOME="$FAKEHOME"
export USERPROFILE="$FAKEHOME"
export APRA_FLEET_DATA_DIR="$FAKEHOME/data"

"$BIN" install --skill none --workflows all --transport stdio

"$BIN" workflow fleet-sprint --help > "$TMP_INSTALL/se-help-stdout.txt" 2> "$TMP_INSTALL/se-help-stderr.txt"
grep -q 'Usage: fleet-se sprint' "$TMP_INSTALL/se-help-stdout.txt" || {
  echo "::error::fleet-sprint --help did not produce the expected usage text."
  cat "$TMP_INSTALL/se-help-stdout.txt"
  exit 1
}
if grep -q 'Using the local apra-pm copy' "$TMP_INSTALL/se-help-stderr.txt"; then
  echo "::error::apra-fleet workflow fleet-sprint fell back to the local apra-pm dev path instead of resolving the packaged dist/agents/schemas/ -- the tarball's schema bundling is broken."
  cat "$TMP_INSTALL/se-help-stderr.txt"
  exit 1
fi
echo "Clean install smoke test passed: apra-fleet workflow fleet-sprint --help works via a real npm install + apra-fleet install, schemas resolved from dist/agents/schemas (no dev-fallback warning)"

echo "== Step 6: Static drift check =="
if grep -rn "dist/fleet-sprint" .github/workflows/ci.yml scripts/ docs/npm-packaging.md; then
  echo "::error::Found a stale dist/fleet-sprint reference (see matches above)."
  exit 1
fi
echo "Static drift check passed: no dist/fleet-sprint references remain"

echo "== All npm-publish gating steps passed =="
