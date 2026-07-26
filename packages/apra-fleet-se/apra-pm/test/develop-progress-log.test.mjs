import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../.claude/workflows/auto-sprint.js'),
  'utf-8'
);

// ---- Extract labelTaskIds from PURE_FUNCTIONS block --------------------------

const pureFnMatch = src.match(/\/\/ PURE_FUNCTIONS_BEGIN[^\n]*\n([\s\S]*?)\/\/ PURE_FUNCTIONS_END/);
if (!pureFnMatch) throw new Error('PURE_FUNCTIONS_BEGIN/END markers not found in auto-sprint.js');

// eslint-disable-next-line no-new-func
const { labelTaskIds } = new Function(
  `${pureFnMatch[1]}; return { labelTaskIds };`
)();

// ---- labelTaskIds functional tests ------------------------------------------

test('labelTaskIds: single id returns that id', () => {
  assert.equal(labelTaskIds(['a']), 'a');
});

test('labelTaskIds: two ids returns both joined by space', () => {
  assert.equal(labelTaskIds(['a', 'b']), 'a b');
});

test('labelTaskIds: three ids returns all three joined by space', () => {
  assert.equal(labelTaskIds(['a', 'b', 'c']), 'a b c');
});

test('labelTaskIds: four ids shows first 3 plus +1more', () => {
  const result = labelTaskIds(['a', 'b', 'c', 'd']);
  assert.equal(result, 'a b c +1more');
});

test('labelTaskIds: five ids shows first 3 plus +2more', () => {
  const result = labelTaskIds(['a', 'b', 'c', 'd', 'e']);
  assert.equal(result, 'a b c +2more');
  assert.match(result, /\+2more/, 'result must include "+2more" suffix');
});

test('labelTaskIds: empty array returns empty string', () => {
  assert.equal(labelTaskIds([]), '');
});

// ---- source-level log() assertions ------------------------------------------

test('source has a log() before doer dispatch referencing streak ids and an estimate', () => {
  // The pre-dispatch log includes labelTaskIds(fittedIds) -- the ceiling-truncated
  // prefix actually dispatched -- and est= for the estimate.
  assert.match(src, /log\(`Doer.*labelTaskIds\(fittedIds\).*est=/,
    'source must have a log() before doer dispatch with dispatched ids and estimate reference');
});

test('source has a per-iteration log() with remaining/ready counts', () => {
  // The per-iteration log reports totalCount and number of streaks.
  assert.match(src, /log\(`Dev iter.*totalCount.*ready task/,
    'source must have per-iteration log() with ready task count');
});

test('source has a post-verdict log() with reviewer verdict and ids', () => {
  // The post-reviewer log includes verdict and labelTaskIds(workedIds).
  assert.match(src, /log\(`Reviewer.*verdict.*labelTaskIds\(workedIds\)/,
    'source must have post-verdict log() with reviewer verdict and worked ids');
});

// ---- label template string assertions ---------------------------------------

test('doer label template string uses labelTaskIds(fittedIds)', () => {
  // The doer label reflects the ceiling-truncated prefix actually dispatched.
  assert.match(src, /doerLabel\s*=\s*`doer-c.*labelTaskIds\(fittedIds\)/,
    'doerLabel must be built using labelTaskIds(fittedIds)');
});

test('reviewer label template string uses labelTaskIds(workedIds)', () => {
  assert.match(src, /reviewerLabel\s*=\s*`reviewer-c.*labelTaskIds\(workedIds\)/,
    'reviewerLabel must be built using labelTaskIds(workedIds)');
});
