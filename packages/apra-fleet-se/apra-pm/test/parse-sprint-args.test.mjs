import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSprintArgs, resolveSprintOpts } from '../lib/parse-sprint-args.mjs';

// -- parseSprintArgs ----------------------------------------------------------

test('null/undefined/empty returns {}', () => {
  assert.deepEqual(parseSprintArgs(null), {});
  assert.deepEqual(parseSprintArgs(undefined), {});
  assert.deepEqual(parseSprintArgs(''), {});
});

test('bare single issue ID', () => {
  assert.deepEqual(parseSprintArgs('BD-1'), { issues: ['BD-1'] });
});

test('space-separated issue IDs', () => {
  assert.deepEqual(parseSprintArgs('BD-1 BD-2'), { issues: ['BD-1', 'BD-2'] });
});

test('comma-separated issue IDs', () => {
  assert.deepEqual(parseSprintArgs('BD-1,BD-2'), { issues: ['BD-1', 'BD-2'] });
});

test('comma-and-space-separated issue IDs', () => {
  assert.deepEqual(parseSprintArgs('BD-1, BD-2, BD-3'), { issues: ['BD-1', 'BD-2', 'BD-3'] });
});

test('JSON array of issue IDs', () => {
  assert.deepEqual(parseSprintArgs('["BD-1","BD-2"]'), { issues: ['BD-1', 'BD-2'] });
});

test('JSON object with issues only', () => {
  assert.deepEqual(parseSprintArgs('{"issues":["BD-1"]}'), { issues: ['BD-1'] });
});

test('JSON object with issues and goal', () => {
  assert.deepEqual(
    parseSprintArgs('{"issues":["BD-1"],"goal":"P1"}'),
    { issues: ['BD-1'], goal: 'P1' }
  );
});

test('JSON object with branch override', () => {
  assert.deepEqual(
    parseSprintArgs('{"branch":"feat/x","issues":["BD-1"]}'),
    { branch: 'feat/x', issues: ['BD-1'] }
  );
});

test('branch-like string treated as issue ID, not branch', () => {
  // regression: old parser set branch="gh-toy-mi2" and left issues empty
  const result = parseSprintArgs('gh-toy-mi2');
  assert.deepEqual(result, { issues: ['gh-toy-mi2'] });
  assert.equal(result.branch, undefined);
});

test('invalid JSON treated as bare string', () => {
  assert.deepEqual(parseSprintArgs('{bad json}'), { issues: ['{bad', 'json}'] });
});

// -- resolveSprintOpts --------------------------------------------------------

test('defaults applied when nothing set', () => {
  const r = resolveSprintOpts(null);
  assert.equal(r.branch, '');
  assert.deepEqual(r.rootIds, []);
  assert.equal(r.goal, 'P1/P2');
  assert.equal(r.maxCycles, 5);
  assert.equal(r.requirementsFile, '');
  assert.equal(r.base_branch, 'main');
});

test('bare issue ID resolves correctly', () => {
  const r = resolveSprintOpts('BD-1');
  assert.deepEqual(r.rootIds, ['BD-1']);
  assert.equal(r.branch, '');
  assert.equal(r.goal, 'P1/P2');
});

test('two bare IDs resolve to rootIds array', () => {
  const r = resolveSprintOpts('BD-1 BD-2');
  assert.deepEqual(r.rootIds, ['BD-1', 'BD-2']);
});

test('JSON array resolves to rootIds', () => {
  const r = resolveSprintOpts('["BD-1","BD-2"]');
  assert.deepEqual(r.rootIds, ['BD-1', 'BD-2']);
});

test('JSON object branch/goal/max_cycles respected', () => {
  const r = resolveSprintOpts('{"issues":["BD-1"],"branch":"feat/x","goal":"P1","max_cycles":3}');
  assert.equal(r.branch, 'feat/x');
  assert.equal(r.goal, 'P1');
  assert.equal(r.maxCycles, 3);
  assert.deepEqual(r.rootIds, ['BD-1']);
});

test('scalar issues string wrapped in array', () => {
  const r = resolveSprintOpts('{"issues":"BD-1"}');
  assert.deepEqual(r.rootIds, ['BD-1']);
});
