import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../.claude/workflows/auto-sprint.js'),
  'utf-8'
);

// ---- Harvest phase: calibration-update + close-sprint-goals parallel --------

test('parallel() call groups calibration-update and close-sprint-goals dispatches', () => {
  // Find the harvest section by looking for the "CALIBRATION UPDATE + CLOSE GOALS (parallel)" comment
  const harvestCommentIdx = src.indexOf('// ------------------------------------------------------------------ CALIBRATION UPDATE + CLOSE GOALS (parallel)');
  assert.ok(harvestCommentIdx >= 0, 'CALIBRATION UPDATE + CLOSE GOALS (parallel) section must exist');

  // Extract the parallel() call content starting from the comment
  const harvestSection = src.slice(harvestCommentIdx);
  const parallelStart = harvestSection.indexOf('await parallel([');
  assert.ok(parallelStart >= 0, 'parallel() call must exist in the Harvest section');

  // Find the closing bracket of the parallel() call (]);)
  const closingBracketIdx = harvestSection.indexOf('\n]);', parallelStart);
  assert.ok(closingBracketIdx >= 0, 'parallel() call must have a proper closing with ]);');

  const parallelContent = harvestSection.slice(parallelStart, closingBracketIdx + 4);

  // Verify both labels are within the parallel() call
  assert.match(parallelContent, /label: 'calibration-update'/,
    'calibration-update dispatch must be inside the parallel() call');
  assert.match(parallelContent, /label: 'close-sprint-goals'/,
    'close-sprint-goals dispatch must be inside the parallel() call');

  // Verify calibration-update comes before close-sprint-goals
  const calibIdx = parallelContent.indexOf("label: 'calibration-update'");
  const closeIdx = parallelContent.indexOf("label: 'close-sprint-goals'");
  assert.ok(calibIdx >= 0 && closeIdx >= 0 && calibIdx < closeIdx,
    'calibration-update must come before close-sprint-goals in parallel array');
});

test('beads-export-cleanup dispatch is sequenced AFTER parallel() resolves', () => {
  // Find the Harvest section with the parallel() call
  const harvestCommentIdx = src.indexOf('// ------------------------------------------------------------------ CALIBRATION UPDATE + CLOSE GOALS (parallel)');
  assert.ok(harvestCommentIdx >= 0, 'CALIBRATION UPDATE + CLOSE GOALS (parallel) section must exist');

  // Extract text starting from the harvest comment
  const harvestSection = src.slice(harvestCommentIdx);

  // Find the closing of the parallel() call
  const parallelIdx = harvestSection.indexOf('await parallel([');
  assert.ok(parallelIdx >= 0, 'parallel() call must exist');

  // Find the closing bracket
  const closeParallelIdx = harvestSection.indexOf('\n]);', parallelIdx);
  assert.ok(closeParallelIdx >= 0, 'parallel() call must have a proper closing');

  // Extract text after parallel() closes
  const afterParallel = harvestSection.slice(closeParallelIdx);

  // Verify beads-export-cleanup appears after the closing
  const cleanupLabelIdx = afterParallel.indexOf("label: 'beads-export-cleanup'");
  assert.ok(cleanupLabelIdx >= 0, 'beads-export-cleanup dispatch must appear after parallel()');

  // Verify it's the next significant dispatch (after BEADS EXPORT comment)
  const exportCommentIdx = afterParallel.indexOf('// ------------------------------------------------------------------ BEADS EXPORT');
  assert.ok(exportCommentIdx >= 0 && exportCommentIdx < cleanupLabelIdx,
    'BEADS EXPORT comment must appear before beads-export-cleanup dispatch');

  // Verify beads-export-cleanup is awaited
  const cleanupDispatchStart = afterParallel.lastIndexOf('await dispatch(', cleanupLabelIdx);
  assert.ok(cleanupDispatchStart >= 0,
    'beads-export-cleanup must be awaited (start with "await dispatch")');
});

test('parallel() call contains exactly two dispatch() calls', () => {
  const harvestCommentIdx = src.indexOf('// ------------------------------------------------------------------ CALIBRATION UPDATE + CLOSE GOALS (parallel)');
  const harvestSection = src.slice(harvestCommentIdx);

  const parallelStart = harvestSection.indexOf('await parallel([');
  const parallelEnd = harvestSection.indexOf('\n]);', parallelStart);
  const parallelContent = harvestSection.slice(parallelStart, parallelEnd + 4);

  // Count dispatch( calls inside the parallel array
  const dispatchCount = (parallelContent.match(/dispatch\(/g) || []).length;
  assert.equal(dispatchCount, 2,
    'parallel() must contain exactly two dispatch() calls');
});

test('beads-export-cleanup stages sprint-logs before bd export', () => {
  const cleanupIdx = src.indexOf("label: 'beads-export-cleanup'");
  assert.ok(cleanupIdx >= 0, 'beads-export-cleanup dispatch must exist');

  // The prompt should mention staging sprint-logs before export
  // Look backward from the label to find the dispatch call and its prompt
  const dispatchStart = src.lastIndexOf('await dispatch(', cleanupIdx);
  const region = src.slice(dispatchStart, cleanupIdx + 200);

  assert.match(region, /git.*add sprint-logs/,
    'beads-export-cleanup prompt must instruct staging sprint-logs');
  assert.match(region, /bd export/,
    'beads-export-cleanup prompt must instruct beads export');

  // Verify order: "git add sprint-logs" comes before "bd export"
  const addSprintLogsIdx = region.indexOf('git');
  const exportIdx = region.indexOf('bd export');
  assert.ok(addSprintLogsIdx >= 0 && exportIdx > addSprintLogsIdx,
    'staging sprint-logs (git add sprint-logs) must appear before bd export in cleanup prompt');
});
