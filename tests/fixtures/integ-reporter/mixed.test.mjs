// Fixture for tests/integ-file-results-reporter.test.ts -- run by node --test
// with scripts/integ-file-results-reporter.mjs; failures here are deliberate.
import { test, describe } from 'node:test';
import assert from 'node:assert';

describe('grp', () => {
  test('ok1', () => {});
  test('bad1', () => { assert.strictEqual(1, 2, 'one is not two'); });
  test('skipme', { skip: true }, () => {});
  test('todo-failing', { todo: true }, () => { throw new Error('todo not done'); });
});
test('top-ok', () => {});
test('throws', () => { throw new Error('boom\nline2\nline3'); });
describe('hookfail', () => {
  test.before(() => { throw new Error('before hook died'); });
  test('never', () => {});
});
