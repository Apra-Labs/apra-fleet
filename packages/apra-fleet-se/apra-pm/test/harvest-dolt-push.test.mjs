import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../.claude/workflows/auto-sprint.js'),
  'utf-8'
);

// ---- dolt push step exists in Harvest ----------------------------------------

test('Harvest section contains a step that invokes bd dolt push', () => {
  assert.match(src, /bd dolt push/,
    'source must contain "bd dolt push"');
});

test('dolt push step is wired with phase Harvest', () => {
  const doltPushIdx = src.indexOf("label: 'dolt-push'");
  assert.ok(doltPushIdx >= 0, 'dispatch with label: \'dolt-push\' must exist in source');

  // Look backward for the phase setting (within 300 chars of the label).
  const region = src.slice(Math.max(0, doltPushIdx - 300), doltPushIdx + 200);
  assert.match(region, /phase:\s*['"]Harvest['"]/,
    'dolt-push dispatch must have phase: \'Harvest\'');
});

test('dolt push step has label dolt-push', () => {
  assert.match(src, /label:\s*['"]dolt-push['"]/,
    'source must contain a dispatch with label: \'dolt-push\'');
});

// ---- non-fatal handling -------------------------------------------------------

test('dolt push prompt includes a warning log for failure (non-fatal keyword)', () => {
  const doltPushIdx = src.indexOf("label: 'dolt-push'");
  // Look backward in the prompt text (up to 1200 chars before the label).
  const region = src.slice(Math.max(0, doltPushIdx - 1200), doltPushIdx);

  assert.match(region, /non-fatal/i,
    'dolt push prompt must use the word "non-fatal" near the warning');
});

test('dolt push prompt instructs agent NOT to throw or abort on failure', () => {
  const doltPushIdx = src.indexOf("label: 'dolt-push'");
  const region = src.slice(Math.max(0, doltPushIdx - 1200), doltPushIdx);

  assert.match(region, /do NOT throw|do not throw/i,
    'dolt push prompt must instruct agent not to throw on failure');
});

test('dolt push returns OK regardless of push success or failure', () => {
  const doltPushIdx = src.indexOf("label: 'dolt-push'");
  const region = src.slice(Math.max(0, doltPushIdx - 1200), doltPushIdx);

  assert.match(region, /regardless of whether the push succeeded or failed|Return.*OK.*regardless/is,
    'dolt push prompt must say to return OK regardless of success or failure');
});

test('no early return guards on the dolt push result the way harvestResult does', () => {
  const doltPushIdx = src.indexOf("label: 'dolt-push'");
  // Look forward past the dolt push step (up to 300 chars).
  const region = src.slice(doltPushIdx, doltPushIdx + 300);

  // There must not be a guard like "if (!doltPushResult" or similar that would abort harvest.
  assert.doesNotMatch(region, /if\s*\(\s*!\s*dolt|doltPush.*return\b/,
    'harvest must not abort on dolt push result (no early-return guard on its result)');
});

// ---- ordering -----------------------------------------------------------------

test('dolt push step appears AFTER beads-export-cleanup in the source', () => {
  const beadsExportIdx = src.indexOf("label: 'beads-export-cleanup'");
  const doltPushIdx = src.indexOf("label: 'dolt-push'");

  assert.ok(beadsExportIdx >= 0, '"beads-export-cleanup" dispatch must exist in source');
  assert.ok(doltPushIdx >= 0, '"dolt-push" dispatch must exist in source');
  assert.ok(doltPushIdx > beadsExportIdx,
    '"dolt-push" label must appear after "beads-export-cleanup" label in the source');
});

// ---- skip_dolt_push arg gates the dolt push ----------------------------------

test('dolt push dispatch is gated by !opts.skip_dolt_push', () => {
  const doltPushIdx = src.indexOf("label: 'dolt-push'");
  assert.ok(doltPushIdx >= 0, '"dolt-push" dispatch must exist');
  // The guard opens before the dispatch; the (long) prompt sits between it and the label.
  const region = src.slice(Math.max(0, doltPushIdx - 1000), doltPushIdx);
  assert.match(region, /if\s*\(\s*!\s*opts\.skip_dolt_push\s*\)/,
    'the dolt-push dispatch must be wrapped in `if (!opts.skip_dolt_push)` so it can be skipped');
});

test('skip_dolt_push logs a skip message instead of pushing', () => {
  assert.match(src, /Skipping dolt push as requested by opts\.skip_dolt_push/,
    'the else branch must log that dolt push was skipped');
});
