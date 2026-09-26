// Tests for src/errors.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { assertThrows } from './helpers.mjs';
import {
  BridgeError,
  BRIDGE_ERROR_CODES,
  exitCodeFor,
} from '../src/errors.mjs';

describe('BridgeError', () => {
  test('constructs with code, message, and optional details', () => {
    const err = new BridgeError('TEST_CODE', 'test message', { field: 'x' });
    assert.strictEqual(err.name, 'BridgeError');
    assert.strictEqual(err.code, 'TEST_CODE');
    assert.strictEqual(err.message, 'test message');
    assert.deepStrictEqual(err.details, { field: 'x' });
  });

  test('defaults details to empty object', () => {
    const err = new BridgeError('TEST_CODE', 'test message');
    assert.deepStrictEqual(err.details, {});
  });

  test('is an instance of Error', () => {
    const err = new BridgeError('TEST_CODE', 'test message');
    assert.ok(err instanceof Error);
  });
});

describe('BRIDGE_ERROR_CODES', () => {
  test('is frozen', () => {
    assertThrows(() => {
      BRIDGE_ERROR_CODES.NEW_CODE = 'NEW_CODE';
    });
  });

  test('contains all required error codes', () => {
    const required = [
      'PREFLIGHT_FAILED',
      'PREFLIGHT_UNAVAILABLE',
      'INGEST_NO_CHILDREN',
      'INGEST_MISSING_CRITERIA',
      'INGEST_PULL_FAILED',
      'LAUNCH_INVALID',
      'LAUNCH_CONFLICT',
      'LAUNCH_RELAUNCH_GATE',
      'LAUNCH_FAILED',
      'WATCH_LOST',
      'FINALIZE_NOT_TERMINAL',
      'CARRYOVER_LIMIT',
      'CARRYOVER_PUBLISH_FAILED',
      'SUPERVISOR_UNAVAILABLE',
      'SUPERVISOR_UNAUTHORIZED',
      'BEADS_FAILED',
      'BEADS_BARE_SYNC_REFUSED',
      'CONFIG_MISSING',
      'CONFIG_INVALID',
      'ADAPTER_UNKNOWN',
      'ADAPTER_INVALID',
      'USAGE',
    ];
    for (const code of required) {
      assert.strictEqual(
        BRIDGE_ERROR_CODES[code],
        code,
        `Expected BRIDGE_ERROR_CODES.${code} to equal "${code}"`
      );
    }
  });
});

describe('exitCodeFor', () => {
  test('returns 2 for USAGE, CONFIG_MISSING, CONFIG_INVALID', () => {
    assert.strictEqual(exitCodeFor(BRIDGE_ERROR_CODES.USAGE), 2);
    assert.strictEqual(exitCodeFor(BRIDGE_ERROR_CODES.CONFIG_MISSING), 2);
    assert.strictEqual(exitCodeFor(BRIDGE_ERROR_CODES.CONFIG_INVALID), 2);

    assert.strictEqual(exitCodeFor(new BridgeError('USAGE', 'msg')), 2);
    assert.strictEqual(exitCodeFor(new BridgeError('CONFIG_MISSING', 'msg')), 2);
    assert.strictEqual(exitCodeFor(new BridgeError('CONFIG_INVALID', 'msg')), 2);
  });

  test('returns 3 for PREFLIGHT_FAILED, PREFLIGHT_UNAVAILABLE', () => {
    assert.strictEqual(exitCodeFor(BRIDGE_ERROR_CODES.PREFLIGHT_FAILED), 3);
    assert.strictEqual(exitCodeFor(BRIDGE_ERROR_CODES.PREFLIGHT_UNAVAILABLE), 3);

    assert.strictEqual(exitCodeFor(new BridgeError('PREFLIGHT_FAILED', 'msg')), 3);
    assert.strictEqual(exitCodeFor(new BridgeError('PREFLIGHT_UNAVAILABLE', 'msg')), 3);
  });

  test('returns 4 for INGEST_* codes', () => {
    assert.strictEqual(exitCodeFor(BRIDGE_ERROR_CODES.INGEST_NO_CHILDREN), 4);
    assert.strictEqual(exitCodeFor(BRIDGE_ERROR_CODES.INGEST_MISSING_CRITERIA), 4);
    assert.strictEqual(exitCodeFor(BRIDGE_ERROR_CODES.INGEST_PULL_FAILED), 4);

    assert.strictEqual(exitCodeFor(new BridgeError('INGEST_NO_CHILDREN', 'msg')), 4);
    assert.strictEqual(exitCodeFor(new BridgeError('INGEST_MISSING_CRITERIA', 'msg')), 4);
    assert.strictEqual(exitCodeFor(new BridgeError('INGEST_PULL_FAILED', 'msg')), 4);
  });

  test('returns 5 for LAUNCH_INVALID, LAUNCH_FAILED, LAUNCH_RELAUNCH_GATE', () => {
    assert.strictEqual(exitCodeFor(BRIDGE_ERROR_CODES.LAUNCH_INVALID), 5);
    assert.strictEqual(exitCodeFor(BRIDGE_ERROR_CODES.LAUNCH_FAILED), 5);
    assert.strictEqual(exitCodeFor(BRIDGE_ERROR_CODES.LAUNCH_RELAUNCH_GATE), 5);

    assert.strictEqual(exitCodeFor(new BridgeError('LAUNCH_INVALID', 'msg')), 5);
    assert.strictEqual(exitCodeFor(new BridgeError('LAUNCH_FAILED', 'msg')), 5);
    assert.strictEqual(exitCodeFor(new BridgeError('LAUNCH_RELAUNCH_GATE', 'msg')), 5);
  });

  test('returns 6 for FINALIZE_NOT_TERMINAL, CARRYOVER_LIMIT, CARRYOVER_PUBLISH_FAILED', () => {
    assert.strictEqual(exitCodeFor(BRIDGE_ERROR_CODES.FINALIZE_NOT_TERMINAL), 6);
    assert.strictEqual(exitCodeFor(BRIDGE_ERROR_CODES.CARRYOVER_LIMIT), 6);
    assert.strictEqual(exitCodeFor(BRIDGE_ERROR_CODES.CARRYOVER_PUBLISH_FAILED), 6);

    assert.strictEqual(exitCodeFor(new BridgeError('FINALIZE_NOT_TERMINAL', 'msg')), 6);
    assert.strictEqual(exitCodeFor(new BridgeError('CARRYOVER_LIMIT', 'msg')), 6);
    assert.strictEqual(exitCodeFor(new BridgeError('CARRYOVER_PUBLISH_FAILED', 'msg')), 6);
  });

  test('returns 7 for LAUNCH_CONFLICT', () => {
    assert.strictEqual(exitCodeFor(BRIDGE_ERROR_CODES.LAUNCH_CONFLICT), 7);
    assert.strictEqual(exitCodeFor(new BridgeError('LAUNCH_CONFLICT', 'msg')), 7);
  });

  test('returns 1 for unrecognized code', () => {
    assert.strictEqual(exitCodeFor('UNKNOWN_CODE'), 1);
    assert.strictEqual(exitCodeFor(''), 1);
  });

  test('returns 1 for plain Error', () => {
    assert.strictEqual(exitCodeFor(new Error('plain error')), 1);
  });

  test('returns 1 for null, undefined, non-string/error inputs', () => {
    assert.strictEqual(exitCodeFor(null), 1);
    assert.strictEqual(exitCodeFor(undefined), 1);
    assert.strictEqual(exitCodeFor(123), 1);
    assert.strictEqual(exitCodeFor({}), 1);
  });

  test('returns 2 for ADAPTER_UNKNOWN (config class)', () => {
    assert.strictEqual(exitCodeFor(BRIDGE_ERROR_CODES.ADAPTER_UNKNOWN), 2);
    assert.strictEqual(exitCodeFor(new BridgeError('ADAPTER_UNKNOWN', 'msg')), 2);
  });

  test('returns 8 for WATCH_LOST, SUPERVISOR_UNAVAILABLE, SUPERVISOR_UNAUTHORIZED', () => {
    assert.strictEqual(exitCodeFor(BRIDGE_ERROR_CODES.WATCH_LOST), 8);
    assert.strictEqual(exitCodeFor(BRIDGE_ERROR_CODES.SUPERVISOR_UNAVAILABLE), 8);
    assert.strictEqual(exitCodeFor(BRIDGE_ERROR_CODES.SUPERVISOR_UNAUTHORIZED), 8);

    assert.strictEqual(exitCodeFor(new BridgeError('WATCH_LOST', 'msg')), 8);
    assert.strictEqual(exitCodeFor(new BridgeError('SUPERVISOR_UNAVAILABLE', 'msg')), 8);
    assert.strictEqual(exitCodeFor(new BridgeError('SUPERVISOR_UNAUTHORIZED', 'msg')), 8);
  });

  test('returns 9 for BEADS_FAILED, BEADS_BARE_SYNC_REFUSED, ADAPTER_INVALID', () => {
    assert.strictEqual(exitCodeFor(BRIDGE_ERROR_CODES.BEADS_FAILED), 9);
    assert.strictEqual(exitCodeFor(BRIDGE_ERROR_CODES.BEADS_BARE_SYNC_REFUSED), 9);
    assert.strictEqual(exitCodeFor(BRIDGE_ERROR_CODES.ADAPTER_INVALID), 9);

    assert.strictEqual(exitCodeFor(new BridgeError('BEADS_FAILED', 'msg')), 9);
    assert.strictEqual(exitCodeFor(new BridgeError('BEADS_BARE_SYNC_REFUSED', 'msg')), 9);
    assert.strictEqual(exitCodeFor(new BridgeError('ADAPTER_INVALID', 'msg')), 9);
  });

  test('completeness: every BRIDGE_ERROR_CODE maps to a non-1 exit code (except via default)', () => {
    for (const [key, code] of Object.entries(BRIDGE_ERROR_CODES)) {
      const exitCode = exitCodeFor(code);
      assert.notStrictEqual(
        exitCode, 1,
        `BRIDGE_ERROR_CODES.${key} ("${code}") must map to an explicit exit code, not default (1)`
      );
    }
  });

  test('unrecognized string and plain Error still return 1', () => {
    assert.strictEqual(exitCodeFor('FAKE_CODE_THAT_DOES_NOT_EXIST'), 1);
    assert.strictEqual(exitCodeFor(new Error('plain error')), 1);
  });
});
