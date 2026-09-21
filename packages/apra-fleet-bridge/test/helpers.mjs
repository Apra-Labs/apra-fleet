// Shared test helpers

import assert from 'node:assert/strict';

/**
 * Helper to catch errors since assert.throws() returns undefined in Node 22+.
 * Calls fn(), catches the error, and returns it; if no error is thrown, fails the test.
 *
 * @param {Function} fn - function to call
 * @returns {Error} the caught error
 */
export function assertThrows(fn) {
  let err;
  try {
    fn();
    assert.fail('Expected an error to be thrown');
  } catch (e) {
    err = e;
  }
  return err;
}
