import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../.claude/workflows/auto-sprint.js'),
  'utf-8'
);

// Locate the null-branch region: from '!doerResult' to the closing brace.
// We look for the if(!doerResult) block and extract the region.
const nullBranchStart = src.indexOf('if (!doerResult)');
assert.ok(nullBranchStart >= 0, '"if (!doerResult)" must exist in auto-sprint.js');

// The null branch ends with the doerNullReset = true and break before the closing brace.
const doerNullResetIdx = src.indexOf('doerNullReset = true;', nullBranchStart);
assert.ok(doerNullResetIdx >= 0, '"doerNullReset = true" must follow the null check');

const nullBranchRegion = src.slice(nullBranchStart, doerNullResetIdx + 50);

// ---- assertion 1: no abortReason = 'doer null' in the null branch ---------------

test('null branch does NOT assign abortReason of "doer null" (no sprint abort)', () => {
  // Scan the null branch region for any abortReason assignment.
  const hasAbortAssignment = /abortReason\s*=/.test(nullBranchRegion);
  assert.ok(!hasAbortAssignment,
    'null branch must NOT assign abortReason -- it should recover, not abort the sprint');
});

test('source has no abortReason set to "doer null" anywhere', () => {
  assert.doesNotMatch(src, /abortReason\s*=\s*['"]doer null['"]/,
    'abortReason must never be set to "doer null" -- that abort path was removed');
});

// ---- assertion 2: null branch resets in_progress with bd update --status=open ---

test('null branch resets in_progress tasks using "bd update ${id} --status=open" template', () => {
  assert.match(nullBranchRegion, /bd update \$\{id\} --status=open/,
    'null branch must use "bd update ${id} --status=open" to reset in_progress tasks');
});

// ---- assertion 3: uses dispatchShell (single dispatch for reset, not per-task) --

test('null branch uses dispatchShell for the in_progress query', () => {
  // There must be a dispatchShell call for the reset-orphans operation.
  assert.match(nullBranchRegion, /dispatchShell\s*\(/,
    'null branch must use dispatchShell (not individual dispatch calls per task)');
});

test('null branch uses a single reset dispatchShell call (resetCmds array)', () => {
  // The reset is done with an array of commands in one dispatchShell call.
  assert.match(nullBranchRegion, /dispatchShell\s*\(\s*resetCmds/,
    'null branch must call dispatchShell(resetCmds, ...) -- one dispatch for all resets');
});

// ---- assertion 4: loop continues (doerNullReset = true + continue, not break) ---

test('doerNullReset flag is set to true in the null branch', () => {
  assert.match(nullBranchRegion, /doerNullReset\s*=\s*true/,
    'doerNullReset must be set to true inside the null branch');
});

test('develop loop uses "if (doerNullReset) continue" to skip abort path', () => {
  // After the streak loop, the doerNullReset flag must trigger continue (not break).
  const afterStreakLoop = src.slice(doerNullResetIdx);
  assert.match(afterStreakLoop, /if\s*\(\s*doerNullReset\s*\)\s*continue/,
    '"if (doerNullReset) continue" must appear after the streak loop to keep the while loop running');
});

test('null branch does NOT set streakAbort = true (does not trigger break)', () => {
  const hasStreakAbort = /streakAbort\s*=\s*true/.test(nullBranchRegion);
  assert.ok(!hasStreakAbort,
    'null branch must NOT set streakAbort = true -- that would break the while loop');
});
