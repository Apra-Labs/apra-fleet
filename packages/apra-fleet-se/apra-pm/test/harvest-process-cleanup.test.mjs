import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../.claude/workflows/auto-sprint.js'),
  'utf-8',
);

// Regression guard for the s10 harvest failure: a stray feedback.md (a review scaffold artifact
// swept in by a doer's `git add -A`) survived into the harvest diff, so the final reviewer
// rejected the sprint -> no PR, no bd export -> pr-exists / final-changeset-clean /
// beads-sprint-closed all failed even though the goal was met. Process files must be stripped
// BEFORE the final review, not only in the post-approval export-cleanup step.

test('a harvest process-file cleanup dispatch exists and removes feedback.md/requirements.md', () => {
  assert.match(src, /label:\s*[`'"]harvest-clean-process-files/,
    'a harvest pre-review process-file cleanup dispatch must exist');
  const idx = src.indexOf('harvest-clean-process-files');
  const region = src.slice(Math.max(0, idx - 900), idx);
  assert.match(region, /rm -f --ignore-unmatch feedback\.md requirements\.md/,
    'the cleanup must git rm --ignore-unmatch feedback.md and requirements.md (atomic-abort safe)');
});

test('process-file cleanup runs BEFORE the final-reviewer dispatch', () => {
  const cleanupIdx = src.indexOf('harvest-clean-process-files');
  const finalReviewIdx = src.indexOf("finalReviewLabel = 'final-reviewer'");
  const harvestIdx = src.indexOf("phase('Harvest')");
  assert.ok(cleanupIdx >= 0, 'cleanup dispatch must exist');
  assert.ok(finalReviewIdx >= 0, 'final-reviewer dispatch must exist');
  assert.ok(harvestIdx >= 0 && harvestIdx < cleanupIdx,
    'cleanup must be inside the Harvest phase');
  assert.ok(cleanupIdx < finalReviewIdx,
    'process-file cleanup must run before the final review so the reviewer sees a clean diff');
});
