import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../.claude/workflows/auto-sprint.js'),
  'utf-8'
);
const match = src.match(/\/\/ PURE_FUNCTIONS_BEGIN[^\n]*\n([\s\S]*?)\/\/ PURE_FUNCTIONS_END/);
if (!match) throw new Error('PURE_FUNCTIONS_BEGIN/END markers not found in auto-sprint.js');
// eslint-disable-next-line no-new-func
const { DEFAULT_CALIBRATION, truncateStreakToCeiling } = new Function(
  `${match[1]}; return { DEFAULT_CALIBRATION, truncateStreakToCeiling };`
)();

// Helper: return a calibration derived from DEFAULT_CALIBRATION but with a custom
// standard-tier ceiling to keep token arithmetic small and readable.
function calWithCeiling(ceiling) {
  return {
    ...DEFAULT_CALIBRATION,
    doer_token_ceiling: { ...DEFAULT_CALIBRATION.doer_token_ceiling, standard: ceiling },
  };
}

// -- truncateStreakToCeiling ---------------------------------------------------

// Scenario 1: all-L streak whose total estimate exceeds the ceiling is truncated
// to a prefix whose summed estimate stays at or under the ceiling.
test('truncateStreakToCeiling: all-L streak over ceiling is truncated to prefix with sum <= ceiling', () => {
  // L default = 2800 tokens; ceiling = 5000.
  // A(2800) fits -> kept.  B would make 5600 > 5000 -> stop.
  const cal = calWithCeiling(5000);
  const bucketById = { A: 'L', B: 'L', C: 'L' };
  const result = truncateStreakToCeiling(['A', 'B', 'C'], bucketById, cal, 'standard');
  assert.deepEqual(result, ['A'], 'only the first L task should survive under a 5000-token ceiling');

  // Verify invariant: summed estimate of the returned prefix <= ceiling.
  // (L default = 2800; 2800 <= 5000)
  const lTokens = DEFAULT_CALIBRATION.complexity_buckets.L.doer_tokens; // 2800
  const prefixSum = result.length * lTokens;
  assert.ok(prefixSum <= 5000, `prefix sum ${prefixSum} must be <= ceiling 5000`);
});

// Scenario 2: a streak that fits entirely under the ceiling is returned unchanged.
test('truncateStreakToCeiling: streak that fits under ceiling is returned unchanged', () => {
  // Three S tasks at 600 each = 1800 tokens total; ceiling = 10000.
  const cal = calWithCeiling(10000);
  const bucketById = { T1: 'S', T2: 'S', T3: 'S' };
  const ids = ['T1', 'T2', 'T3'];
  const result = truncateStreakToCeiling(ids, bucketById, cal, 'standard');
  assert.deepEqual(result, ids, 'all tasks must be returned when they fit under the ceiling');
});

// Scenario 3: a single task whose estimate exceeds the ceiling is still returned
// (the function never returns an empty array -- a lone oversized task is dispatched alone).
test('truncateStreakToCeiling: single task over ceiling still returns that one task (never empty)', () => {
  // S default = 600 tokens; ceiling = 500 (S task is over).
  const cal = calWithCeiling(500);
  const bucketById = { X: 'S' };
  const result = truncateStreakToCeiling(['X'], bucketById, cal, 'standard');
  assert.deepEqual(result, ['X'], 'a single oversized task must still be returned');
});

// Scenario 4: truncation preserves task order -- the result is always a prefix of
// the input array, not a reordered or non-contiguous subset.
test('truncateStreakToCeiling: returns an in-order prefix, not a reordered subset', () => {
  // ceiling = 4000; L(A)=2800, S(B)=600 -> sum=3400 fits; M(C)=1400 -> 4800 > 4000 -> stop.
  const cal = calWithCeiling(4000);
  const bucketById = { A: 'L', B: 'S', C: 'M' };
  const result = truncateStreakToCeiling(['A', 'B', 'C'], bucketById, cal, 'standard');
  assert.deepEqual(result, ['A', 'B'], 'result must be the in-order prefix [A, B]');
  // Verify order is preserved (not a subset that skipped A or reordered B before A).
  assert.equal(result[0], 'A');
  assert.equal(result[1], 'B');
});
