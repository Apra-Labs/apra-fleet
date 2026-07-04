#!/usr/bin/env node
// Guard: vendor/apra-pm MUST remain a git submodule (gitlink, mode 160000).
// It must never be flattened/inlined as a plain directory of tracked files.
// Run as part of any pre-PR check: `node scripts/check-vendor-submodule.mjs`.

import { execFileSync } from 'node:child_process';

const SUBMODULE_PATH = 'vendor/apra-pm';
const EXPECTED_MODE = '160000';

function run(args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

function main() {
  let output;
  try {
    output = run(['ls-files', '-s', SUBMODULE_PATH]);
  } catch (err) {
    console.error(`[check-vendor-submodule] Failed to run 'git ls-files -s ${SUBMODULE_PATH}': ${err.message}`);
    process.exit(1);
  }

  const line = output.trim();
  if (!line) {
    console.error(
      `[check-vendor-submodule] No git index entry found for '${SUBMODULE_PATH}'. ` +
        `Expected a gitlink entry (mode ${EXPECTED_MODE}). Has it been removed or renamed?`
    );
    process.exit(1);
  }

  // Format: "<mode> <sha> <stage>\t<path>"
  const mode = line.split(/\s+/)[0];

  if (mode !== EXPECTED_MODE) {
    console.error(
      `[check-vendor-submodule] INVARIANT VIOLATION: '${SUBMODULE_PATH}' has git mode '${mode}', ` +
        `expected '${EXPECTED_MODE}' (gitlink/submodule). It appears to have been flattened/inlined ` +
        `as regular files. vendor/apra-pm MUST remain a submodule -- see .gitmodules.`
    );
    process.exit(1);
  }

  // Also verify .gitmodules still references it.
  let gitmodules;
  try {
    gitmodules = run(['config', '--file', '.gitmodules', '--get-regexp', `submodule\\.${SUBMODULE_PATH.replace('/', '\\/')}\\.path`]);
  } catch {
    gitmodules = '';
  }
  if (!gitmodules.trim()) {
    console.error(
      `[check-vendor-submodule] .gitmodules has no entry for '${SUBMODULE_PATH}'. Submodule metadata may be missing.`
    );
    process.exit(1);
  }

  console.log(`[check-vendor-submodule] OK: '${SUBMODULE_PATH}' is a gitlink (mode ${EXPECTED_MODE}) and registered in .gitmodules.`);
}

main();
