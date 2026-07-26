#!/usr/bin/env node
// Guard for apra-fleet-eft.46: assert that the two dolt-heavy planner
// dispatch-watchdog tests (mock-sprint-planner-dispatch-dead-pid.test.mjs
// and mock-sprint-planner-dispatch-stalled-session.test.mjs) pass within
// their declared timeout budgets (180000ms and 650000ms respectively) when
// run under the full concurrent suite (concurrency=8 for the main lane).
//
// These tests are isolated into their own low-concurrency lane (see
// ISOLATED_LANE_* in scripts/run-integ-suites.mjs) to prevent their
// per-retry dolt overhead from contending with the other 7 files in the
// run and pushing them past their own hang-detection timeout budgets.
// This guard verifies the isolation fix is effective: the watchdog tests
// pass promptly within their declared budgets, even in a full suite run.
//
// Reads results{}.durationMs from integ-suite-status.json (produced by
// `node scripts/run-integ-suites.mjs --start`, see that script's header and
// INTEG-SUITE.md) and reports/exits non-zero if either test fails, exceeds
// its budget, or is not recorded.
//
// Usage (from the repo root, after a completed real-bd suite pass):
//   node scripts/check-watchdog-isolation.mjs [status-file-path]
//
// Exit codes:
//   0 = both tests pass within budget
//   1 = one or both tests fail, exceed budget, or are not recorded
//   2 = fail-loud: no status file / no recorded results (run the suite via
//       scripts/run-integ-suites.mjs first)

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Watchdog test budgets (declared in the test files' { timeout: ... }).
const DEAD_PID_BUDGET_MS = 180000;  // mock-sprint-planner-dispatch-dead-pid.test.mjs
const STALLED_SESSION_BUDGET_MS = 650000;  // mock-sprint-planner-dispatch-stalled-session.test.mjs

const DEAD_PID_FILE = 'mock-sprint-planner-dispatch-dead-pid.test.mjs';
const STALLED_SESSION_FILE = 'mock-sprint-planner-dispatch-stalled-session.test.mjs';

/**
 * Load a run-integ-suites.mjs status file's `results` map from disk.
 *
 * Returns null (not a throw) when the file is missing, so callers can
 * distinguish "no run recorded yet" from a genuinely empty results map.
 * Throws if the file exists but is not parseable JSON, or lacks a
 * `results` object -- that is a corrupt/foreign file, not "no run yet".
 */
function loadResults(statusFilePath) {
  if (!existsSync(statusFilePath)) return null;
  const parsed = JSON.parse(readFileSync(statusFilePath, 'utf8'));
  if (!parsed || typeof parsed.results !== 'object' || parsed.results === null) {
    throw new Error(`status file ${statusFilePath} has no "results" object`);
  }
  return parsed.results;
}

/**
 * Check a single watchdog test against its budget.
 *
 * @param {string} testFile - filename of the test
 * @param {number} budgetMs - budget in milliseconds
 * @param {Record<string, {passed?: boolean, durationMs?: number}>} results - results map
 * @returns {{ ok: boolean, file: string, durationMs: number|null, message: string }}
 */
function checkWatchdog(testFile, budgetMs, results) {
  const rec = results[testFile];
  const budgetSeconds = Math.round(budgetMs / 1000);

  if (!rec) {
    return {
      ok: false,
      file: testFile,
      durationMs: null,
      message: `FAIL: ${testFile} not found in results (run the suite first)`,
    };
  }

  if (!rec.passed) {
    return {
      ok: false,
      file: testFile,
      durationMs: rec.durationMs || null,
      message: `FAIL: ${testFile} did not pass`,
    };
  }

  if (typeof rec.durationMs !== 'number') {
    return {
      ok: false,
      file: testFile,
      durationMs: null,
      message: `FAIL: ${testFile} has no recorded durationMs`,
    };
  }

  if (rec.durationMs > budgetMs) {
    const actualSeconds = Math.round(rec.durationMs / 1000);
    return {
      ok: false,
      file: testFile,
      durationMs: rec.durationMs,
      message: `FAIL: ${testFile} (${actualSeconds}s) exceeds budget (${budgetSeconds}s)`,
    };
  }

  const actualSeconds = Math.round(rec.durationMs / 1000);
  return {
    ok: true,
    file: testFile,
    durationMs: rec.durationMs,
    message: `OK: ${testFile} passed (${actualSeconds}s, budget ${budgetSeconds}s)`,
  };
}

function main() {
  const statusFile = process.argv[2] ?? path.join(repoRoot, 'integ-suite-status.json');

  let results;
  try {
    results = loadResults(statusFile);
  } catch (e) {
    console.error(`[check-watchdog-isolation] ERROR: ${e.message}`);
    process.exit(2);
  }

  if (results === null) {
    console.error(
      `[check-watchdog-isolation] ERROR: no status file at ${statusFile} -- ` +
      'run the suite first (see packages/apra-fleet-se/test/INTEG-SUITE.md).'
    );
    process.exit(2);
  }

  if (Object.keys(results).length === 0) {
    console.error(
      `[check-watchdog-isolation] ERROR: ${statusFile} has zero recorded results -- ` +
      'run/finish the suite first (see packages/apra-fleet-se/test/INTEG-SUITE.md).'
    );
    process.exit(2);
  }

  // Check both watchdog tests.
  const deadPidCheck = checkWatchdog(DEAD_PID_FILE, DEAD_PID_BUDGET_MS, results);
  const stalledSessionCheck = checkWatchdog(STALLED_SESSION_FILE, STALLED_SESSION_BUDGET_MS, results);

  console.log(`[check-watchdog-isolation] ${deadPidCheck.message}`);
  console.log(`[check-watchdog-isolation] ${stalledSessionCheck.message}`);

  if (!deadPidCheck.ok || !stalledSessionCheck.ok) {
    console.error('[check-watchdog-isolation] FAIL: watchdog isolation check failed (one or both tests did not pass within budget)');
    process.exit(1);
  }

  console.log('[check-watchdog-isolation] PASS: both watchdog tests passed within budget under full suite concurrency');
  process.exit(0);
}

// Only run when invoked directly (not when imported for tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
