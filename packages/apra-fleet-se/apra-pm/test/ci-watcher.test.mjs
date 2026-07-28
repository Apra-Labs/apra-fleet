import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dir, '../.claude/workflows/auto-sprint.js'), 'utf-8');
const ciWatcherMd = readFileSync(join(__dir, '../agents/ci-watcher.md'), 'utf-8');

// ---- helpers -----------------------------------------------------------------

/** Return the character index of the first occurrence of a string (throws if missing). */
function indexOf(haystack, needle, label) {
  const i = haystack.indexOf(needle);
  assert.ok(i >= 0, `Expected to find ${label || JSON.stringify(needle)} in source`);
  return i;
}

// ---- (a) post-PR dispatch: ci-watcher runs only after PR number is available ----

test('ci-watcher dispatch is conditioned on prNumber (post-PR ordering)', () => {
  // The prNumber assignment must appear before the ci-watcher dispatch block.
  const prNumberAssign = indexOf(src, 'const prNumber = harvestPr', 'prNumber assignment');
  const ciWatcherDispatch = indexOf(src, "label: 'ci-watcher'", 'ci-watcher dispatch');
  assert.ok(
    prNumberAssign < ciWatcherDispatch,
    'prNumber assignment must appear before ci-watcher dispatch in source'
  );
});

test('ci-watcher dispatch is inside an "if (prNumber)" guard', () => {
  // Find the CI CHECK section which begins the post-PR guard and confirm ci-watcher
  // label appears after it.
  const ciCheckSection = indexOf(src, 'CI CHECK (post-PR)', 'CI CHECK section header');
  const ciWatcherIdx = indexOf(src, "label: 'ci-watcher'", 'ci-watcher label');
  assert.ok(ciCheckSection < ciWatcherIdx, 'ci-watcher must appear after the CI CHECK (post-PR) section header');

  // Also confirm that an "if (prNumber)" guard appears between the section header and label.
  const region = src.slice(ciCheckSection, ciWatcherIdx);
  assert.match(region, /if\s*\(\s*prNumber\s*\)/, 'ci-watcher must be inside if(prNumber) block');
});

test('ci-watcher prompt uses "gh run list --pr" to scope runs to the PR', () => {
  // Locate the ci-watcher dispatch prompt string and verify it contains the --pr flag.
  const ciIdx = indexOf(src, "label: 'ci-watcher'", 'ci-watcher label');
  // Look backward up to 600 chars for the prompt string.
  const region = src.slice(Math.max(0, ciIdx - 600), ciIdx);
  assert.match(region, /gh run list --pr/, 'ci-watcher prompt must use "gh run list --pr <N>"');
});

// ---- (b) PR body built without CI note; CI appended afterward ----------------

test('harvest-pr prompt does not include CI status at creation time', () => {
  // Locate the harvest-pr dispatch and check its prompt has no CI reference.
  const harvestPrIdx = indexOf(src, "label: 'harvest-pr'", 'harvest-pr label');
  // Grab the 800-char region before the label (the prompt string).
  const region = src.slice(Math.max(0, harvestPrIdx - 800), harvestPrIdx);
  assert.doesNotMatch(
    region,
    /CI status/i,
    'PR body prompt must not mention CI status at creation time'
  );
  assert.doesNotMatch(
    region,
    /ci-watcher/i,
    'PR body prompt must not mention ci-watcher at creation time'
  );
});

test('CI annotation uses gh pr comment (appended after PR creation)', () => {
  // The ci-pr-annotate dispatch must use "gh pr comment", not a PR body edit.
  const annotateIdx = indexOf(src, "label: 'ci-pr-annotate'", 'ci-pr-annotate label');
  const region = src.slice(Math.max(0, annotateIdx - 600), annotateIdx);
  assert.match(region, /gh pr comment/, 'CI annotation must use "gh pr comment"');
});

test('ci-pr-annotate dispatch appears after ci-watcher dispatch in source', () => {
  const ciWatcherIdx = indexOf(src, "label: 'ci-watcher'", 'ci-watcher label');
  const annotateIdx = indexOf(src, "label: 'ci-pr-annotate'", 'ci-pr-annotate label');
  assert.ok(
    ciWatcherIdx < annotateIdx,
    'ci-pr-annotate must appear after ci-watcher in source (post-PR annotation ordering)'
  );
});

// ---- (c) pending vs not_configured classification in ci-watcher.md -----------

test('ci-watcher.md: zero runs => not_configured', () => {
  // The agent instructions must return not_configured when NO runs exist.
  assert.match(
    ciWatcherMd,
    /[Nn]o runs? (returned|found)[^\n]*[\s\S]{0,200}not_configured/,
    'ci-watcher.md must map "no runs" to not_configured'
  );
});

test('ci-watcher.md: runs exist but SHA unmatched => pending, not not_configured', () => {
  // The agent instructions must return pending (not not_configured) when runs exist
  // but none match the expected HEAD SHA.
  assert.match(
    ciWatcherMd,
    /[Nn]o run found for the expected HEAD SHA but older runs exist[\s\S]{0,300}pending/,
    'ci-watcher.md must map "runs exist but SHA unmatched" to pending'
  );
  // Also assert there is no rule mapping SHA-mismatch scenario to not_configured.
  const shaBlock = ciWatcherMd.slice(
    ciWatcherMd.indexOf('No run found for the expected HEAD SHA')
  );
  assert.doesNotMatch(
    shaBlock.slice(0, 200),
    /not_configured/,
    'SHA-unmatched scenario must NOT return not_configured'
  );
});

// ---- (d) not_configured branch: dedup guard before CI task creation -----------

test('not_configured branch: bd search appears before bd create for CI pipeline task', () => {
  // The bd search (dedup check) must appear before the bd create dispatch.
  const searchIdx = indexOf(src, 'bd search "Add CI pipeline"', 'bd search dedup call');
  const createIdx = indexOf(src, 'bd create --title="Add CI pipeline to project"', 'bd create CI pipeline');
  assert.ok(
    searchIdx < createIdx,
    'bd search dedup check must appear before bd create in the not_configured branch'
  );
});

test('not_configured branch: bd search is scoped to open status only', () => {
  // The search must use --status=open so closed CI issues do not suppress creation.
  const searchIdx = indexOf(src, 'bd search "Add CI pipeline"', 'bd search dedup call');
  // Look forward up to 200 chars for the --status flag.
  const region = src.slice(searchIdx, searchIdx + 200);
  assert.match(region, /--status=open/, 'bd search dedup must include --status=open to ignore closed issues');
});

test('not_configured branch: already-exists log and guarded create are present', () => {
  // A conditional log must exist for the already-exists case so creation is skipped.
  indexOf(src, 'already exists', 'already exists log/skip message');
  // The bd create dispatch must be inside an else branch (guarded), not unconditional.
  // Confirm there is a conditional block (} else {) between the search result check and create.
  const searchIdx = indexOf(src, 'bd search "Add CI pipeline"', 'bd search dedup call');
  const createIdx = indexOf(src, 'bd create --title="Add CI pipeline to project"', 'bd create CI pipeline');
  const region = src.slice(searchIdx, createIdx);
  assert.match(region, /\}\s*else\s*\{/, 'bd create must be inside an else block (guarded by dedup check)');
});

test('ci-watcher.md: at least one run (any status) must NOT yield not_configured', () => {
  // Confirm that the not_configured return is restricted to the zero-runs case only.
  // Scan for "not_configured" occurrences and confirm they appear only near "no runs" text.
  const occurrences = [];
  let searchFrom = 0;
  while (true) {
    const idx = ciWatcherMd.indexOf('not_configured', searchFrom);
    if (idx < 0) break;
    occurrences.push(idx);
    searchFrom = idx + 1;
  }
  // Every occurrence of not_configured should be in a context that mentions "no runs" or
  // "never been triggered" -- not in a context about "runs exist".
  for (const idx of occurrences) {
    const context = ciWatcherMd.slice(Math.max(0, idx - 300), idx + 50);
    assert.doesNotMatch(
      context,
      /runs? exist/i,
      `not_configured must not appear alongside "runs exist" (context around char ${idx})`
    );
  }
});
