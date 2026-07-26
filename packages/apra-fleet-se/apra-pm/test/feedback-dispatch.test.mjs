import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../.claude/workflows/auto-sprint.js'),
  'utf-8'
);

// ---- dev-path commitFeedback: write-only, fire-and-forget -------------------

test('dev-path feedback dispatch is NOT awaited (fire-and-forget)', () => {
  // The dev-path feedback write uses a bare dispatch() without await.
  const fwLabel = "label: `feedback-write-${reviewerLabel}`";
  const labelIdx = src.indexOf(fwLabel);
  assert.ok(labelIdx >= 0, '"feedback-write-${reviewerLabel}" label must exist');

  // Look backward for the dispatch call -- it must NOT be preceded by "await".
  const region = src.slice(Math.max(0, labelIdx - 400), labelIdx);
  // The dispatch call should appear without an await keyword.
  assert.doesNotMatch(region, /await\s+dispatch\s*\([^)]*feedback/s,
    'dev-path feedback dispatch must NOT be awaited');
  assert.match(region, /dispatch\s*\(/,
    'dev-path feedback must call dispatch()');
});

test('dev-path feedback prompt says "Do not commit, push" (write-only)', () => {
  const fwLabel = "label: `feedback-write-${reviewerLabel}`";
  const labelIdx = src.indexOf(fwLabel);
  const region = src.slice(Math.max(0, labelIdx - 500), labelIdx);
  assert.match(region, /[Dd]o not commit.*push|[Dd]o not.*commit.*push/s,
    'dev-path feedback prompt must forbid commit and push');
});

test('dev-path feedback prompt instructs writing to feedback.md only', () => {
  const fwLabel = "label: `feedback-write-${reviewerLabel}`";
  const labelIdx = src.indexOf(fwLabel);
  const region = src.slice(Math.max(0, labelIdx - 500), labelIdx);
  assert.match(region, /feedback\.md/,
    'dev-path feedback prompt must reference feedback.md');
  assert.match(region, /[Ww]rite.*file to disk|Write.*disk|file to disk/,
    'dev-path feedback prompt must say to write the file to disk');
});

// ---- plan-reviewer path: still commits + pushes (awaited commitFeedback) ----

test('plan-reviewer path uses awaited commitFeedback (commits and pushes)', () => {
  // The plan-reviewer calls the full commitFeedback() function which commits+pushes.
  const planReviewerFeedback = src.indexOf('await commitFeedback(repo, branch, planFeedback');
  assert.ok(planReviewerFeedback >= 0,
    'plan-reviewer must use awaited commitFeedback() with commit+push');
});

test('commitFeedback() function body includes "commit and push" instructions', () => {
  const fnIdx = src.indexOf('async function commitFeedback(');
  assert.ok(fnIdx >= 0, 'commitFeedback function must exist');

  const fnEnd = src.indexOf('\nasync function ', fnIdx + 1);
  const fnBody = fnEnd > 0 ? src.slice(fnIdx, fnEnd) : src.slice(fnIdx, fnIdx + 600);

  assert.match(fnBody, /commit and push/i,
    'commitFeedback() must instruct agent to commit and push');
  assert.match(fnBody, /git.*push/,
    'commitFeedback() must include a git push instruction');
  assert.match(fnBody, /await\s+dispatch/,
    'commitFeedback() must await the dispatch (blocking)');
});

test('dev-path feedback label differs from plan-reviewer feedback label', () => {
  // Dev path: feedback-write-${reviewerLabel}
  // Plan-reviewer path: feedback-commit-${label} (via commitFeedback)
  assert.match(src, /feedback-write-/,  'dev-path label must use feedback-write- prefix');
  assert.match(src, /feedback-commit-/, 'plan-reviewer label must use feedback-commit- prefix');
});

// ---- beads-export-cleanup: removes feedback.md/requirements.md from tree -----

test('beads-export-cleanup removes feedback.md from the working tree', () => {
  const cleanupIdx = src.indexOf("label: 'beads-export-cleanup'");
  assert.ok(cleanupIdx >= 0, 'beads-export-cleanup label must exist');

  const region = src.slice(Math.max(0, cleanupIdx - 3000), cleanupIdx);
  assert.match(region, /rm.*feedback\.md|git.*rm.*feedback\.md/,
    'beads-export-cleanup must remove feedback.md from the working tree');
});

test('beads-export-cleanup removes requirements.md from the working tree', () => {
  const cleanupIdx = src.indexOf("label: 'beads-export-cleanup'");
  const region = src.slice(Math.max(0, cleanupIdx - 3000), cleanupIdx);
  assert.match(region, /rm.*requirements\.md|git.*rm.*requirements\.md/,
    'beads-export-cleanup must remove requirements.md from the working tree');
});

test('beads-export-cleanup removes scaffold files BEFORE the beads export+push', () => {
  const cleanupIdx = src.indexOf("label: 'beads-export-cleanup'");
  const region = src.slice(Math.max(0, cleanupIdx - 3000), cleanupIdx);

  // scaffold removal must appear before bd export and git push.
  const rmFeedbackIdx = region.indexOf('feedback.md');
  const exportIdx = region.indexOf('bd export');
  const pushIdx = region.indexOf('git -C "${repo}" push');

  assert.ok(rmFeedbackIdx >= 0, 'feedback.md removal must appear in cleanup prompt');
  assert.ok(exportIdx >= 0,     'bd export must appear in cleanup prompt');
  assert.ok(pushIdx >= 0,       'git push must appear in cleanup prompt');
  assert.ok(rmFeedbackIdx < exportIdx,
    'feedback.md removal must appear before bd export in cleanup prompt');
  assert.ok(rmFeedbackIdx < pushIdx,
    'feedback.md removal must appear before git push in cleanup prompt');
});
