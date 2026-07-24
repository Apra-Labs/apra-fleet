#!/usr/bin/env node
// Guard for apra-fleet-eft.17.2: assert the real-bd suite single-file
// performance budget documented in
// packages/apra-fleet-se/test/INTEG-SUITE.md step 7 -- no single real-bd
// test file should exceed ~5 minutes (300000ms) -- so a future regression in
// the shared-fixture dolt caching (apra-fleet-eft.17.1, test/helpers/
// bd-replay.mjs) is caught instead of silently reappearing.
//
// Reads results{}.durationMs from integ-suite-status.json (produced by
// `node scripts/run-integ-suites.mjs --start`, see that script's header and
// INTEG-SUITE.md) and reports/exits non-zero if any file exceeds the
// budget, naming the offending file(s).
//
// Usage (from the repo root, after a completed real-bd suite pass):
//   node scripts/check-integ-suite-budget.mjs [status-file-path]
//
// Exit codes:
//   0 = no file over budget
//   1 = one or more files over budget (offenders printed)
//   2 = fail-loud: no status file / no recorded results (run the suite via
//       scripts/run-integ-suites.mjs first)
//
// This is a point-in-time check against whatever pass most recently
// completed -- it does not itself run the suite. See INTEG-SUITE.md for the
// full procedure (start/poll/wait for completion) before running this.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Matches the "~5 minutes" single-file budget from INTEG-SUITE.md step 7.
export const BUDGET_MS = 300000;

/**
 * Load a run-integ-suites.mjs status file's `results` map from disk.
 *
 * Returns null (not a throw) when the file is missing, so callers can
 * distinguish "no run recorded yet" from a genuinely empty results map.
 * Throws if the file exists but is not parseable JSON, or lacks a
 * `results` object -- that is a corrupt/foreign file, not "no run yet".
 */
export function loadResults(statusFilePath) {
  if (!existsSync(statusFilePath)) return null;
  const parsed = JSON.parse(readFileSync(statusFilePath, 'utf8'));
  if (!parsed || typeof parsed.results !== 'object' || parsed.results === null) {
    throw new Error(`status file ${statusFilePath} has no "results" object`);
  }
  return parsed.results;
}

/**
 * Check every file's recorded durationMs against the budget.
 *
 * @param {Record<string, {durationMs?: number}>} results
 * @param {number} budgetMs
 * @returns {{ ok: boolean, offenders: {file: string, durationMs: number}[], message: string }}
 */
export function checkBudget(results, budgetMs = BUDGET_MS) {
  const offenders = Object.entries(results)
    .filter(([, rec]) => typeof rec?.durationMs === 'number' && rec.durationMs > budgetMs)
    .map(([file, rec]) => ({ file, durationMs: rec.durationMs }))
    .sort((a, b) => b.durationMs - a.durationMs);

  if (offenders.length === 0) {
    const budgetSeconds = Math.round(budgetMs / 1000);
    return {
      ok: true,
      offenders,
      message: `OK: all ${Object.keys(results).length} file(s) are within the ${budgetSeconds}s single-file budget.`,
    };
  }

  const budgetSeconds = Math.round(budgetMs / 1000);
  const detail = offenders
    .map((o) => `${o.file} (${Math.round(o.durationMs / 1000)}s)`)
    .join(', ');
  return {
    ok: false,
    offenders,
    message:
      `FAIL: ${offenders.length} file(s) exceed the ${budgetSeconds}s single-file budget: ${detail}`,
  };
}

function main() {
  const statusFile = process.argv[2] ?? path.join(repoRoot, 'integ-suite-status.json');

  let results;
  try {
    results = loadResults(statusFile);
  } catch (e) {
    console.error(`[check-integ-suite-budget] ERROR: ${e.message}`);
    process.exit(2);
  }

  if (results === null) {
    console.error(
      `[check-integ-suite-budget] ERROR: no status file at ${statusFile} -- ` +
      'run the suite first (see packages/apra-fleet-se/test/INTEG-SUITE.md).'
    );
    process.exit(2);
  }
  if (Object.keys(results).length === 0) {
    console.error(
      `[check-integ-suite-budget] ERROR: ${statusFile} has zero recorded results -- ` +
      'run/finish the suite first (see packages/apra-fleet-se/test/INTEG-SUITE.md).'
    );
    process.exit(2);
  }

  const result = checkBudget(results);
  console.log(`[check-integ-suite-budget] ${result.message}`);
  process.exit(result.ok ? 0 : 1);
}

// Only run when invoked directly (not when imported for tests).
// Windows-safe self-execution guard (same defect class as stabilization
// Issue 36 / apra-fleet-eft.41): a raw `file://${argv[1]}` comparison can
// never match on Windows (backslashes, drive-letter URL encoding), so main()
// silently never ran there -- the script exited 0 with no output regardless
// of budget state (windows-latest CI run 29866815136). Compare canonical
// file URLs on both sides instead.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
