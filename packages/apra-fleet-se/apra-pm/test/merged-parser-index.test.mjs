import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../.claude/workflows/auto-sprint.js'),
  'utf-8'
);

// ---- extract pure functions from PURE_FUNCTIONS block ------------------------
const match = src.match(/\/\/ PURE_FUNCTIONS_BEGIN[^\n]*\n([\s\S]*?)\/\/ PURE_FUNCTIONS_END/);
if (!match) throw new Error('PURE_FUNCTIONS_BEGIN/END markers not found in auto-sprint.js');
const {
  TIER_STANDARD,
  parseBlockers, parseReadyStreaks,
  // eslint-disable-next-line no-new-func
} = new Function(`${match[1]}; return { TIER_STANDARD, parseBlockers, parseReadyStreaks };`)();

// ---- merged-output layout (exit-check contract) ------------------------------
// The merged exit-check dispatch produces an outputs[] array with this layout:
//   [0..rootCount-1]  bd graph --json <root> | ID-extract  (one per sprint root)
//   [rootCount]       bd list --status=open --json | open-extract
//   [rootCount+1]     bd list --ready --type=task --json | task-extract
//
// parseBlockers is called with openListIdx=rootCount.
// parseReadyStreaks is called with readyListIdx=rootCount+1.

// Helper: build a synthetic merged-outputs array for N roots.
function mergedOutputs(rootIds, openList, readyList) {
  return [
    ...rootIds.map(ids => ids.join(' ')),
    JSON.stringify(openList),
    JSON.stringify(readyList),
  ];
}

// ---- parseBlockers index mapping (openListIdx = rootCount) -------------------

test('parseBlockers reads open list from outputs[rootCount] (single root)', () => {
  // rootCount = 1, so openListIdx = 1, readyListIdx = 2
  const outputs = mergedOutputs(
    [['BD-1', 'BD-2']],              // 1 root graph
    [{ id: 'BD-1', p: 1 }, { id: 'BD-2', p: 2 }],   // open list at [1]
    [],                               // ready list at [2] (not used by parseBlockers)
  );
  assert.equal(outputs.length, 3);
  const r = parseBlockers(outputs, 1, 1, 2);
  assert.equal(r.count, 2);
  assert.deepEqual(r.ids.sort(), ['BD-1', 'BD-2']);
});

test('parseBlockers reads open list from outputs[rootCount] (two roots)', () => {
  // rootCount = 2, so openListIdx = 2, readyListIdx = 3
  const outputs = mergedOutputs(
    [['BD-1'], ['BD-2', 'BD-3']],    // 2 root graphs
    [{ id: 'BD-1', p: 1 }, { id: 'BD-3', p: 2 }, { id: 'BD-9', p: 1 }],  // open at [2]
    [],                               // ready at [3]
  );
  assert.equal(outputs.length, 4);
  // BD-9 is not in the subtree (roots cover BD-1, BD-2, BD-3)
  const r = parseBlockers(outputs, 2, 2, 2);
  assert.equal(r.count, 2);
  assert.deepEqual(r.ids.sort(), ['BD-1', 'BD-3']);
});

test('parseBlockers filters by priority threshold against subtree', () => {
  const outputs = mergedOutputs(
    [['BD-1', 'BD-2', 'BD-3']],
    [
      { id: 'BD-1', p: 1 },  // p<=2: blocker
      { id: 'BD-2', p: 3 },  // p>2: ignored
      { id: 'BD-3', p: 2 },  // p<=2: blocker
    ],
    [],
  );
  const r = parseBlockers(outputs, 1, 1, 2);
  assert.equal(r.count, 2);
  assert.deepEqual(r.ids.sort(), ['BD-1', 'BD-3']);
});

// ---- parseReadyStreaks index mapping (readyListIdx = rootCount+1) -------------

test('parseReadyStreaks reads ready list from outputs[rootCount+1] (single root)', () => {
  // rootCount = 1, readyListIdx = 2
  const outputs = mergedOutputs(
    [['BD-1', 'BD-2']],
    [],                               // open at [1] (not used by parseReadyStreaks)
    [
      { id: 'BD-1', p: 2, m: TIER_STANDARD },
      { id: 'BD-2', p: 1, m: TIER_STANDARD },
    ],
  );
  const r = parseReadyStreaks(outputs, 1, 2, TIER_STANDARD);
  assert.equal(r.totalCount, 2);
  // Ordered by priority: BD-2 (p1) before BD-1 (p2)
  assert.equal(r.streaks.length, 1);
  assert.deepEqual(r.streaks[0].ids, ['BD-2', 'BD-1']);
});

test('parseReadyStreaks reads ready list from outputs[rootCount+1] (two roots)', () => {
  // rootCount = 2, readyListIdx = 3
  const outputs = mergedOutputs(
    [['BD-1'], ['BD-2']],
    [],                               // open at [2]
    [
      { id: 'BD-1', p: 1, m: TIER_STANDARD },
      { id: 'BD-X', p: 1, m: TIER_STANDARD },  // not in subtree -> dropped
    ],
  );
  const r = parseReadyStreaks(outputs, 2, 3, TIER_STANDARD);
  assert.equal(r.totalCount, 1);
  assert.deepEqual(r.streaks[0].ids, ['BD-1']);
});

test('parseReadyStreaks does not read from the open-list slot (rootCount)', () => {
  // Ensure readyListIdx = rootCount+1 is used, not rootCount.
  // Put garbage at rootCount (open-list slot) and valid JSON at rootCount+1.
  const outputs = [
    'BD-1',                           // [0] graph for root 1
    'not-valid-ready-json',           // [1] open-list slot (rootCount=1) -- should NOT be read
    JSON.stringify([{ id: 'BD-1', p: 1, m: TIER_STANDARD }]),  // [2] ready slot (rootCount+1)
  ];
  // readyListIdx=2, rootCount=1 => reads from [2] not [1]
  const r = parseReadyStreaks(outputs, 1, 2, TIER_STANDARD);
  assert.equal(r.totalCount, 1);
});

// ---- fallback on short outputs (outputs.length < rootCount + 2) --------------

test('fallback triggers when outputs.length < rootCount+2 (blockers sentinel)', () => {
  // With rootCount=2 we need length >= 4; if length=3 the exit-check code falls back.
  // parseBlockers with openListIdx=2 on a 3-element array is fine (length >= 3),
  // but the exit-check guard checks outputs.length >= rootCount+2 == 4.
  // Verify the fail-safe sentinel when directly calling parseBlockers with short array:
  const shortOutputs = ['BD-1', 'BD-2'];  // length=2, openListIdx=2 -> too short
  const r = parseBlockers(shortOutputs, 2, 2, 2);
  assert.deepEqual(r, { count: 999, ids: [] }, 'should return sentinel on short outputs');
});

test('fallback triggers when outputs.length < rootCount+2 (ready streaks empty)', () => {
  // parseReadyStreaks with readyListIdx=3 on a 3-element array -> too short
  const shortOutputs = ['BD-1', 'BD-2', '[]'];  // length=3, readyListIdx=3 -> missing
  const r = parseReadyStreaks(shortOutputs, 2, 3, TIER_STANDARD);
  assert.deepEqual(r, { totalCount: 0, streaks: [], extractFailed: true }, 'should return empty + extractFailed on short outputs');
});

test('fallback check in source: exit-check outputs.length < rootCount+2', () => {
  // Verify the source has the outputs.length >= rootCount+2 guard for the merged exit-check.
  assert.match(
    src,
    /outputs\.length\s*>=\s*rootIds\.length\s*\+\s*2/,
    'source must check outputs.length >= rootIds.length + 2 before using merged parsers'
  );
});

test('exit-check source uses parseBlockers with openListIdx=rootIds.length', () => {
  // Confirm the exact call site uses rootIds.length as both rootCount and openListIdx.
  assert.match(
    src,
    /parseBlockers\(\s*exitResult\.outputs\s*,\s*rootIds\.length\s*,\s*rootIds\.length\s*,/,
    'exit-check must call parseBlockers(outputs, rootIds.length, rootIds.length, threshold)'
  );
});

test('exit-check source uses parseReadyStreaks with readyListIdx=rootIds.length+1', () => {
  // Confirm readyListIdx is rootIds.length + 1 in the merged exit-check call.
  assert.match(
    src,
    /parseReadyStreaks\(\s*exitResult\.outputs\s*,\s*rootIds\.length\s*,\s*rootIds\.length\s*\+\s*1\s*,/,
    'exit-check must call parseReadyStreaks(outputs, rootIds.length, rootIds.length + 1, ...)'
  );
});
