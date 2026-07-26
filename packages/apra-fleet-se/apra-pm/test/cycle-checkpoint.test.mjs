import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../.claude/workflows/auto-sprint.js'),
  'utf-8'
);

// ---- one-time type:meta entry before the sprint loop -------------------------

test('type:meta JSONL entry is written before the sprint loop', () => {
  // The sprint-meta dispatch (type:meta) must appear before the "while (cycleCount" loop.
  const metaLabelIdx = src.indexOf("label: 'sprint-meta'");
  assert.ok(metaLabelIdx >= 0, "sprint-meta dispatch must exist in source");

  const sprintLoopIdx = src.indexOf('while (cycleCount < maxCycles)');
  assert.ok(sprintLoopIdx >= 0, 'sprint loop must exist');

  assert.ok(
    metaLabelIdx < sprintLoopIdx,
    'sprint-meta (type:meta) dispatch must appear before the sprint loop'
  );
});

test('sprint-meta dispatch embeds type:"meta" in the JSONL line', () => {
  const metaLabelIdx = src.indexOf("label: 'sprint-meta'");
  // The metaLine variable is constructed ~1000 chars before the label; use a wider lookback.
  const region = src.slice(Math.max(0, metaLabelIdx - 1000), metaLabelIdx);
  assert.match(region, /type:\s*['"]meta['"]/,
    'sprint-meta dispatch must embed type:"meta" in the JSONL line (via metaLine variable)');
});

// ---- per-cycle type:cycle-start entry (distinct from type:meta) --------------

test('per-cycle checkpoint uses type "cycle-start" (not "meta")', () => {
  // Find the cycleCheckpointLine construction inside the sprint loop.
  const loopIdx = src.indexOf('while (cycleCount < maxCycles)');
  const afterLoop = src.slice(loopIdx);

  // The cycle checkpoint JSON must use type:'cycle-start'.
  assert.match(afterLoop, /type:\s*['"]cycle-start['"]/,
    'per-cycle checkpoint must use type:"cycle-start"');
  // And it must NOT use type:'meta' for the per-cycle entry.
  const checkpointBlockEnd = afterLoop.indexOf('Promise.all(') + 200;
  const checkpointBlock = afterLoop.slice(0, checkpointBlockEnd);
  // Find the first occurrence of type: in the cycle-start block.
  const typeMatch = checkpointBlock.match(/type:\s*['"]([^'"]+)['"]/);
  if (typeMatch) {
    assert.equal(typeMatch[1], 'cycle-start',
      'first type in per-cycle checkpoint must be "cycle-start", not "meta"');
  }
});

test('cycle-checkpoint JSON includes "cycle" field (per-cycle counter)', () => {
  const loopIdx = src.indexOf('while (cycleCount < maxCycles)');
  const afterLoop = src.slice(loopIdx, loopIdx + 600);
  assert.match(afterLoop, /cycle:\s*cycleCount/,
    'per-cycle checkpoint JSON must include cycle: cycleCount field');
});

// ---- parallel grouping of cycle-checkpoint write and checkCycleState ---------

test('cycle-checkpoint dispatch and checkCycleState run in parallel (Promise.all or parallel())', () => {
  const loopIdx = src.indexOf('while (cycleCount < maxCycles)');
  const afterLoop = src.slice(loopIdx, loopIdx + 1000);

  // Either Promise.all or the parallel() helper must be used to group the two operations.
  const hasPromiseAll = /Promise\.all\s*\(/.test(afterLoop);
  const hasParallel = /\bparallel\s*\(/.test(afterLoop);
  assert.ok(
    hasPromiseAll || hasParallel,
    'cycle-checkpoint and checkCycleState must run in Promise.all or parallel()'
  );
});

test('checkCycleState is called inside the same parallel block as cycle-checkpoint dispatch', () => {
  const loopIdx = src.indexOf('while (cycleCount < maxCycles)');
  // Use a generous 1600-char slice to capture the full Promise.all block inside the loop.
  const afterLoop = src.slice(loopIdx, loopIdx + 1600);

  // Both the cycle-meta dispatch (label contains 'cycle-meta') and checkCycleState must
  // appear before the closing of the parallel/Promise.all block.
  const parallelStart = afterLoop.search(/Promise\.all\s*\(|\bparallel\s*\(/);
  assert.ok(parallelStart >= 0, 'parallel block must exist inside the sprint loop');

  // The full region from Promise.all( onwards (within afterLoop) should contain both items.
  const parallelRegion = afterLoop.slice(parallelStart);
  assert.match(parallelRegion, /cycle-meta/, 'cycle-meta dispatch must be inside the parallel block');
  assert.match(parallelRegion, /checkCycleState/, 'checkCycleState must be inside the parallel block');
});

// ---- exactly one type:meta dispatch in the whole source ----------------------

test('type:"meta" entry is written exactly once in source (one-time before loop)', () => {
  // Count occurrences of type: 'meta' in JSONL construction contexts.
  const matches = [...src.matchAll(/type:\s*['"]meta['"]/g)];
  // Only the sprint-meta block (before the loop) should have this.
  assert.equal(matches.length, 1,
    'type:"meta" must appear exactly once (one-time sprint-meta entry, not repeated in cycle loop)');
});
