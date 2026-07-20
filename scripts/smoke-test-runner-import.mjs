#!/usr/bin/env node
// smoke-test-runner-import.mjs (apra-fleet-7pm.12)
//
// Proves that dist/auto-sprint-runner.mjs's full import graph
// (its own relative './contracts.mjs' / './errors.mjs' siblings,
// '@apralabs/apra-fleet-workflow' [+ its '/viewer/html-utils' subpath] and
// '@apralabs/apra-fleet-client', and the bare 'ajv' specifier those pull in)
// resolves and runs via `engine.executeFile()` from a package directory that
// was installed with `npm install -g` into a clean prefix -- no monorepo
// ancestor, no vendor/ checkout, nothing pre-existing except what npm itself
// installed for the published package.
//
// This is NOT exercised by `auto-sprint --help` (see docs/workflow-
// subsystem-plan.md Section 0.1): --help exits before executeFile() ever
// runs, and dist/auto-sprint.mjs's own imports were already esbuild-inlined
// at bundle time, so a broken runner.js import graph was invisible to CI
// until this script.
//
// Usage: node scripts/smoke-test-runner-import.mjs <installed-package-dir>
//   <installed-package-dir> is the root of the installed @apralabs/apra-fleet
//   package (the directory containing its dist/, package.json, etc).

import { pathToFileURL } from 'node:url';
import path from 'node:path';

const pkgDir = process.argv[2];
if (!pkgDir) {
  console.error('Usage: node scripts/smoke-test-runner-import.mjs <installed-package-dir>');
  process.exit(1);
}

const engineUrl = pathToFileURL(
  path.join(pkgDir, 'dist', 'node_modules', '@apralabs', 'apra-fleet-workflow', 'src', 'workflow', 'engine.mjs'),
).href;
const runnerPath = path.join(pkgDir, 'dist', 'auto-sprint-runner.mjs');

function isModuleResolutionError(err) {
  return err && (err.code === 'ERR_MODULE_NOT_FOUND' || err.code === 'MODULE_NOT_FOUND');
}

let WorkflowEngine;
try {
  ({ WorkflowEngine } = await import(engineUrl));
} catch (err) {
  console.error(`::error::Failed to import @apralabs/apra-fleet-workflow's engine.mjs from ${engineUrl}`);
  console.error(err);
  process.exit(1);
}

// A minimal, non-null fleetApi stand-in: executeFile() imports and invokes
// the runner's main(context) before touching most fleetApi surface, so
// validateArgs() (runner.js) rejecting an intentionally-empty args object is
// expected here -- what this script checks is that the rejection is a
// *validation* error, not a module-resolution error.
const engine = new WorkflowEngine({
  args: {},
  currentPhase: null,
  budget: { total: null, remaining: () => Infinity },
  on() {},
  emit() {},
  runWithContext: async (args, entry) => entry({ args }),
});

try {
  await engine.executeFile(runnerPath, {});
  console.log('engine.executeFile() ran the runner script to completion with no module-resolution errors.');
} catch (err) {
  if (isModuleResolutionError(err)) {
    console.error(`::error::engine.executeFile() failed to resolve the runner's import graph: ${err.message}`);
    console.error(err);
    process.exit(1);
  }
  console.log(
    `engine.executeFile() loaded and ran the runner script; it threw a non-resolution error as expected ` +
      `for an intentionally-empty args object: ${err.message}`,
  );
}

console.log('Runner-load smoke test passed: full import graph resolves from a clean global-install-style prefix.');
