import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../.claude/workflows/auto-sprint.js'),
  'utf-8'
);

// ---- extract parseBlockers from PURE_FUNCTIONS block -------------------------
const match = src.match(/\/\/ PURE_FUNCTIONS_BEGIN[^\n]*\n([\s\S]*?)\/\/ PURE_FUNCTIONS_END/);
if (!match) throw new Error('PURE_FUNCTIONS_BEGIN/END markers not found in auto-sprint.js');
// eslint-disable-next-line no-new-func
const { parseBlockers } = new Function(`${match[1]}; return { parseBlockers };`)();

// ---- helper: build synthetic merged outputs ----------------------------------
// Layout: [0..rootCount-1] = subtree IDs per root, [rootCount] = open issues JSON.
function mergedOutputs(rootSubtrees, openList) {
  return [
    ...rootSubtrees.map(ids => ids.join(' ')),
    JSON.stringify(openList),
  ];
}

// ---- acceptance scenario from apra-pm-jf9 ------------------------------------
// roots=[A,B], open list=[A(P1),B(P1),C(P1)] where C is NOT a root.
// parseBlockers with rootIds=[A,B] should:
//   - return count>0 while A or B are still in the open list
//   - return count===0 once A and B are closed (even if C remains open)

const ROOT_A = 'apra-pm-A';
const ROOT_B = 'apra-pm-B';
const NON_ROOT_C = 'apra-pm-C';
// Both roots appear in their own subtrees; C appears in the subtree of root B.
const rootSubtrees = [
  [ROOT_A],        // subtree of root A
  [ROOT_B, NON_ROOT_C],  // subtree of root B (C is a descendant, not a root)
];
const rootIds = [ROOT_A, ROOT_B];
const threshold = 1; // P1 threshold

test('roots-scoped: when A and B are open, count > 0 (sprint not done)', () => {
  const openList = [
    { id: ROOT_A, p: 1 },
    { id: ROOT_B, p: 1 },
    { id: NON_ROOT_C, p: 1 },
  ];
  const outputs = mergedOutputs(rootSubtrees, openList);
  const result = parseBlockers(outputs, 2, 2, threshold, rootIds);
  assert.ok(result.count > 0,
    'count must be > 0 when sprint roots A and B are still open');
  assert.ok(result.ids.includes(ROOT_A), 'A must appear in blocker ids');
  assert.ok(result.ids.includes(ROOT_B), 'B must appear in blocker ids');
});

test('roots-scoped: goalMet when A and B are closed even if C (non-root) stays open', () => {
  // A and B are closed (not in open list); C is still open but is NOT a root.
  const openList = [
    { id: NON_ROOT_C, p: 1 },
  ];
  const outputs = mergedOutputs(rootSubtrees, openList);
  const result = parseBlockers(outputs, 2, 2, threshold, rootIds);
  assert.equal(result.count, 0,
    'count must be 0 once sprint roots A and B are closed (C is not a root)');
});

test('roots-scoped: C alone in open list does not block goalMet', () => {
  const openList = [{ id: NON_ROOT_C, p: 1 }];
  const outputs = mergedOutputs(rootSubtrees, openList);
  const result = parseBlockers(outputs, 2, 2, threshold, rootIds);
  assert.equal(result.count, 0, 'non-root open issue must not increment the blocker count');
  assert.ok(!result.ids.includes(NON_ROOT_C),
    'non-root C must not appear in blocker ids when rootIds filter is active');
});

// ---- unchanged behaviour: when all open P1s ARE roots, they still block -------

test('non-roots-scoped fallback: all open P1s are roots -> they still block', () => {
  const openList = [
    { id: ROOT_A, p: 1 },
    { id: ROOT_B, p: 1 },
  ];
  const outputs = mergedOutputs(rootSubtrees, openList);
  const result = parseBlockers(outputs, 2, 2, threshold, rootIds);
  assert.equal(result.count, 2, 'both root issues still block when they are open');
  assert.deepEqual(result.ids.sort(), [ROOT_A, ROOT_B].sort());
});

// ---- fail-safe: missing or short outputs return sentinel {count:999} ----------

test('fail-safe: null outputs returns sentinel {count:999}', () => {
  const result = parseBlockers(null, 2, 2, threshold, rootIds);
  assert.equal(result.count, 999, 'null outputs must return sentinel count=999');
});

test('fail-safe: outputs array too short returns sentinel {count:999}', () => {
  // Need at least openListIdx+1 = 3 entries; provide only 1.
  const result = parseBlockers(['apra-pm-A'], 2, 2, threshold, rootIds);
  assert.equal(result.count, 999, 'too-short outputs must return sentinel count=999');
});

test('fail-safe: missing outputs returns sentinel {count:999}', () => {
  const result = parseBlockers(undefined, 2, 2, threshold, rootIds);
  assert.equal(result.count, 999, 'undefined outputs must return sentinel count=999');
});
