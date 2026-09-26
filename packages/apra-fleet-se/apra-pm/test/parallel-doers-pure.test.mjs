import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../.claude/workflows/auto-sprint.js'),
  'utf-8'
);

// Extract the pure-functions block and materialize computeDoerBatch + worktreeNamesFor.
function loadPure(...names) {
  const start = src.indexOf('// PURE_FUNCTIONS_BEGIN');
  const end = src.indexOf('// PURE_FUNCTIONS_END');
  assert.ok(start >= 0 && end > start, 'pure-functions block must exist');
  const block = src.slice(start, end);
  // eslint-disable-next-line no-new-func
  return new Function(`${block}\n return { ${names.join(', ')} };`)();
}

const { computeDoerBatch, worktreeNamesFor, buildPhaseTiming } =
  loadPure('computeDoerBatch', 'worktreeNamesFor', 'buildPhaseTiming');

test('computeDoerBatch flattens streaks, dedupes, and caps at maxDoers', () => {
  const streaks = [
    { model: 'A', ids: ['t-3', 't-1'] },
    { model: 'B', ids: ['t-2', 't-1'] }, // t-1 duplicate -> dropped
  ];
  const r = computeDoerBatch(streaks, 2);
  assert.equal(r.readyCount, 3, 'three unique tasks');
  assert.equal(r.width, 2, 'capped at maxDoers=2');
  assert.deepEqual(r.batch.map(t => t.id), ['t-1', 't-2'], 'batch sorted by id, size=width');
  assert.deepEqual(r.deferred.map(t => t.id), ['t-3'], 'remainder deferred');
});

test('computeDoerBatch carries each task model from its streak', () => {
  const r = computeDoerBatch([{ model: 'sonnet', ids: ['b'] }, { model: 'opus', ids: ['a'] }], 4);
  const byId = Object.fromEntries(r.batch.map(t => [t.id, t.model]));
  assert.equal(byId['a'], 'opus');
  assert.equal(byId['b'], 'sonnet');
});

test('computeDoerBatch width is min(maxDoers, readyCount) and >=1', () => {
  assert.equal(computeDoerBatch([{ model: 'A', ids: ['x'] }], 4).width, 1, 'one ready task -> width 1');
  assert.equal(computeDoerBatch([], 4).width, 1, 'no tasks -> width 1 (never 0)');
  assert.equal(computeDoerBatch([{ model: 'A', ids: ['a', 'b', 'c'] }], 1).width, 1, 'max_doers=1 forces serial width');
});

test('computeDoerBatch ordering is deterministic (sorted by id) for reproducible merges', () => {
  const a = computeDoerBatch([{ model: 'A', ids: ['z', 'm', 'a'] }], 3);
  const b = computeDoerBatch([{ model: 'A', ids: ['a', 'z', 'm'] }], 3);
  assert.deepEqual(a.batch.map(t => t.id), b.batch.map(t => t.id), 'same set -> same order regardless of input order');
  assert.deepEqual(a.batch.map(t => t.id), ['a', 'm', 'z']);
});

test('computeDoerBatch tolerates null/undefined streaks and ids', () => {
  const r = computeDoerBatch([null, { model: 'A' }, { model: 'B', ids: [null, 't-1'] }], 4);
  assert.deepEqual(r.batch.map(t => t.id), ['t-1']);
});

test('worktreeNamesFor sanitizes id and branch into safe path + ref', () => {
  const n = worktreeNamesFor('feat/auth-x', 'gh-toy-mi2', '.auto-sprint/wt');
  assert.equal(n.path, '.auto-sprint/wt/gh-toy-mi2');
  assert.equal(n.branch, 'auto-sprint/wt/feat-auth-x/gh-toy-mi2');
});

test('worktreeNamesFor strips unsafe characters from arbitrary ids/branches', () => {
  const n = worktreeNamesFor('a/b\\c*d', 'x y:z', 'root/');
  assert.match(n.path, /^root\/[a-zA-Z0-9._-]+$/, 'path component is filesystem-safe');
  assert.match(n.branch, /^auto-sprint\/wt\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/, 'branch is ref-safe');
  assert.ok(!n.path.endsWith('/x y:z'), 'spaces/colons removed from id');
});

test('worktreeNamesFor defaults the worktree root when omitted', () => {
  const n = worktreeNamesFor('main', 't1');
  assert.equal(n.path, '.auto-sprint/wt/t1');
});

test('buildPhaseTiming diffs consecutive epoch stamps into per-phase seconds', () => {
  const t = buildPhaseTiming([
    { name: 'setup', epoch: 1000 },
    { name: 'plan-c1', epoch: 1030 },   // setup took 30s
    { name: 'develop-c1', epoch: 1090 }, // plan took 60s
    { name: 'end', epoch: 1100 },        // develop took 10s
  ]);
  assert.deepEqual(t.rows, [
    { phase: 'setup', seconds: 30 },
    { phase: 'plan-c1', seconds: 60 },
    { phase: 'develop-c1', seconds: 10 },
  ]);
  assert.equal(t.totalSeconds, 100);
  assert.match(t.text, /develop-c1: 10s \(10%\)/);
  assert.match(t.text, /plan-c1: 1m00s \(60%\)/);
  assert.match(t.text, /TOTAL: 1m40s/);
});

test('buildPhaseTiming ignores malformed/non-finite stamps and never goes negative', () => {
  const t = buildPhaseTiming([
    { name: 'a', epoch: 100 },
    { name: null, epoch: 200 },      // dropped (no name)
    { name: 'b', epoch: NaN },       // dropped (non-finite)
    { name: 'c', epoch: 90 },        // earlier than 'a' -> clamped to 0
  ]);
  // clean = [a@100, c@90] -> one row a->c = max(0, -10) = 0
  assert.deepEqual(t.rows, [{ phase: 'a', seconds: 0 }]);
  assert.equal(t.totalSeconds, 0);
});

test('buildPhaseTiming handles empty/too-short input gracefully', () => {
  assert.deepEqual(buildPhaseTiming([]).rows, []);
  assert.deepEqual(buildPhaseTiming([{ name: 'only', epoch: 5 }]).rows, []);
  assert.match(buildPhaseTiming(undefined).text, /no phase timing captured/);
});
