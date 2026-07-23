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

// ---- leaf/subtree done-condition (F5) ----------------------------------------
// The exit-check counts SUBTREE LEAF work, NOT roots:
//   - open type=task at priority<=threshold, EXCLUDING roots -> counted
//   - open type=feature at priority<=threshold, EXCLUDING roots -> counted ONLY when
//     includeFeatures=true (integ tests run and close features in-loop; otherwise counting
//     them would make goalMet unreachable since nothing closes features in-loop)
//   - roots are NEVER counted (they close only at Harvest, after the loop)
// parseBlockers is invoked in LEAF mode via opts { rootIds, leaf:true, includeFeatures }.

const ROOT_A = 'apra-pm-A';
const ROOT_B = 'apra-pm-B';
const TASK_C = 'apra-pm-C';    // non-root task, descendant of root B
const FEAT_D = 'apra-pm-D';    // non-root feature, descendant of root B
// Root A subtree = [A]; root B subtree = [B, C, D].
const rootSubtrees = [
  [ROOT_A],
  [ROOT_B, TASK_C, FEAT_D],
];
const rootIds = [ROOT_A, ROOT_B];
const threshold = 1; // P1 threshold

test('leaf-scoped: roots are EXCLUDED even when open; open non-root task IS counted', () => {
  const openList = [
    { id: ROOT_A, p: 1, t: 'feature' },  // root -> excluded
    { id: ROOT_B, p: 1, t: 'feature' },  // root -> excluded
    { id: TASK_C, p: 1, t: 'task' },     // non-root leaf task -> counted
  ];
  const outputs = mergedOutputs(rootSubtrees, openList);
  const result = parseBlockers(outputs, 2, 2, threshold, { rootIds, leaf: true, includeFeatures: false });
  assert.equal(result.count, 1, 'only the non-root task counts; both roots are excluded');
  assert.ok(result.ids.includes(TASK_C), 'the non-root task must appear in blocker ids');
  assert.ok(!result.ids.includes(ROOT_A), 'root A must NOT appear in blocker ids');
  assert.ok(!result.ids.includes(ROOT_B), 'root B must NOT appear in blocker ids');
});

test('leaf-scoped: a root is excluded even when it is typed as a task', () => {
  const openList = [{ id: ROOT_A, p: 1, t: 'task' }];
  const outputs = mergedOutputs(rootSubtrees, openList);
  const result = parseBlockers(outputs, 2, 2, threshold, { rootIds, leaf: true, includeFeatures: true });
  assert.equal(result.count, 0, 'a root is never counted, regardless of its issue_type');
});

test('leaf-scoped: open feature counts ONLY when includeFeatures=true', () => {
  const openList = [{ id: FEAT_D, p: 1, t: 'feature' }];
  const outputs = mergedOutputs(rootSubtrees, openList);

  const off = parseBlockers(outputs, 2, 2, threshold, { rootIds, leaf: true, includeFeatures: false });
  assert.equal(off.count, 0, 'a non-root feature is NOT counted when includeFeatures=false');
  assert.ok(!off.ids.includes(FEAT_D), 'feature must not appear when includeFeatures=false');

  const on = parseBlockers(outputs, 2, 2, threshold, { rootIds, leaf: true, includeFeatures: true });
  assert.equal(on.count, 1, 'a non-root feature IS counted when includeFeatures=true');
  assert.ok(on.ids.includes(FEAT_D), 'feature must appear when includeFeatures=true');
});

test('leaf-scoped: with includeFeatures=true, both open task and feature count', () => {
  const openList = [
    { id: TASK_C, p: 1, t: 'task' },
    { id: FEAT_D, p: 1, t: 'feature' },
  ];
  const outputs = mergedOutputs(rootSubtrees, openList);
  const result = parseBlockers(outputs, 2, 2, threshold, { rootIds, leaf: true, includeFeatures: true });
  assert.equal(result.count, 2, 'both the non-root task and the non-root feature count');
  assert.deepEqual(result.ids.sort(), [TASK_C, FEAT_D].sort());
});

test('leaf-scoped: priority filter -- a task above the threshold is ignored', () => {
  const openList = [{ id: TASK_C, p: 2, t: 'task' }];  // p=2 > threshold=1
  const outputs = mergedOutputs(rootSubtrees, openList);
  const result = parseBlockers(outputs, 2, 2, threshold, { rootIds, leaf: true, includeFeatures: true });
  assert.equal(result.count, 0, 'a leaf task above the priority threshold is not counted');
});

test('leaf-scoped: missing issue_type is treated as neither task nor feature (not counted)', () => {
  const openList = [{ id: TASK_C, p: 1 }];  // no `t` field
  const outputs = mergedOutputs(rootSubtrees, openList);
  const result = parseBlockers(outputs, 2, 2, threshold, { rootIds, leaf: true, includeFeatures: true });
  assert.equal(result.count, 0, 'an open issue with no issue_type is not counted (safe)');
});

test('leaf-scoped: an issue outside the subtree is not counted', () => {
  const openList = [{ id: 'apra-pm-OUTSIDE', p: 1, t: 'task' }];
  const outputs = mergedOutputs(rootSubtrees, openList);
  const result = parseBlockers(outputs, 2, 2, threshold, { rootIds, leaf: true, includeFeatures: true });
  assert.equal(result.count, 0, 'a task outside the sprint subtree is not counted');
});

test('leaf-scoped: goalMet reachable -- all leaves closed while roots still open', () => {
  // Only the roots remain open (they close at Harvest, after the loop). No leaf work left.
  const openList = [
    { id: ROOT_A, p: 1, t: 'feature' },
    { id: ROOT_B, p: 1, t: 'feature' },
  ];
  const outputs = mergedOutputs(rootSubtrees, openList);
  const result = parseBlockers(outputs, 2, 2, threshold, { rootIds, leaf: true, includeFeatures: true });
  assert.equal(result.count, 0, 'goalMet is reachable in-loop once all leaves close, even with roots open');
});

// ---- fail-safe: missing or short outputs return sentinel {count:999} ----------

test('fail-safe: null outputs returns sentinel {count:999}', () => {
  const result = parseBlockers(null, 2, 2, threshold, { rootIds, leaf: true, includeFeatures: true });
  assert.equal(result.count, 999, 'null outputs must return sentinel count=999');
});

test('fail-safe: outputs array too short returns sentinel {count:999}', () => {
  // Need at least openListIdx+1 = 3 entries; provide only 1.
  const result = parseBlockers(['apra-pm-A'], 2, 2, threshold, { rootIds, leaf: true, includeFeatures: true });
  assert.equal(result.count, 999, 'too-short outputs must return sentinel count=999');
});

test('fail-safe: missing outputs returns sentinel {count:999}', () => {
  const result = parseBlockers(undefined, 2, 2, threshold, { rootIds, leaf: true, includeFeatures: true });
  assert.equal(result.count, 999, 'undefined outputs must return sentinel count=999');
});
