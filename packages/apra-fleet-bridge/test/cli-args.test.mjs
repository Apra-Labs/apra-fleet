// Tests for src/cli/args.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { assertThrows } from './helpers.mjs';
import {
  USAGE_TEXT,
  parseArgs,
  requireFlag,
} from '../src/cli/args.mjs';
import { BridgeError, BRIDGE_ERROR_CODES } from '../src/errors.mjs';

describe('USAGE_TEXT', () => {
  test('is a non-empty string', () => {
    assert.ok(typeof USAGE_TEXT === 'string');
    assert.ok(USAGE_TEXT.length > 0);
  });

  test('lists expected verbs', () => {
    const verbs = [
      'preflight',
      'ingest',
      'launch',
      'watch',
      'finalize',
      'status',
      'daemon',
      'viewer',
    ];
    for (const verb of verbs) {
      assert.ok(
        USAGE_TEXT.includes(verb),
        `Expected USAGE_TEXT to mention verb "${verb}"`
      );
    }
  });
});

describe('parseArgs', () => {
  test('parses verb and positionals', () => {
    const result = parseArgs(['launch', 'item1', 'item2']);
    assert.strictEqual(result.verb, 'launch');
    assert.deepStrictEqual(result.positionals, ['item1', 'item2']);
    assert.strictEqual(result.flags.size, 0);
  });

  test('parses --flag=value form', () => {
    const result = parseArgs(['launch', '--platform=azure-devops', '--member=alice']);
    assert.strictEqual(result.verb, 'launch');
    assert.strictEqual(result.flags.get('platform'), 'azure-devops');
    assert.strictEqual(result.flags.get('member'), 'alice');
  });

  test('parses --flag value form (value as next arg)', () => {
    const result = parseArgs(['launch', '--platform', 'azure-devops', '--member', 'alice']);
    assert.strictEqual(result.verb, 'launch');
    assert.strictEqual(result.flags.get('platform'), 'azure-devops');
    assert.strictEqual(result.flags.get('member'), 'alice');
  });

  test('parses boolean --flag form', () => {
    const result = parseArgs(['launch', '--debug']);
    assert.strictEqual(result.verb, 'launch');
    assert.strictEqual(result.flags.get('debug'), true);
  });

  test('parses --no-flag form as negation', () => {
    const result = parseArgs(['launch', '--no-debug']);
    assert.strictEqual(result.verb, 'launch');
    assert.strictEqual(result.flags.get('debug'), false);
  });

  test('parses -- passthrough correctly', () => {
    const result = parseArgs(['launch', 'item1', '--', '--unknown-flag', 'value']);
    assert.strictEqual(result.verb, 'launch');
    assert.deepStrictEqual(result.positionals, ['item1', '--unknown-flag', 'value']);
  });

  test('does not reject unknown flags', () => {
    const result = parseArgs(['launch', '--unknown-flag', 'value']);
    assert.strictEqual(result.verb, 'launch');
    assert.strictEqual(result.flags.get('unknown-flag'), 'value');
  });

  test('handles multiple flags', () => {
    const result = parseArgs(['launch', '--platform', 'azure', '--member', 'bob', '--debug']);
    assert.strictEqual(result.flags.get('platform'), 'azure');
    assert.strictEqual(result.flags.get('member'), 'bob');
    assert.strictEqual(result.flags.get('debug'), true);
  });

  test('returns empty verb when no args provided', () => {
    const result = parseArgs([]);
    assert.strictEqual(result.verb, undefined);
    assert.deepStrictEqual(result.positionals, []);
  });

  test('prefers --flag=value over next arg when both would apply', () => {
    const result = parseArgs(['launch', '--platform=azure', 'positional']);
    assert.strictEqual(result.flags.get('platform'), 'azure');
    assert.deepStrictEqual(result.positionals, ['positional']);
  });

  test('treats arg starting with -- as flag, not value', () => {
    const result = parseArgs(['launch', '--platform', '--member', 'alice']);
    assert.strictEqual(result.flags.get('platform'), true);
    assert.strictEqual(result.flags.get('member'), 'alice');
  });

  test('handles --flag= (empty value)', () => {
    const result = parseArgs(['launch', '--platform=']);
    assert.strictEqual(result.flags.get('platform'), true);
  });

  test('allows multiple = in --flag=value form', () => {
    const result = parseArgs(['launch', '--url=https://example.com?a=b']);
    assert.strictEqual(result.flags.get('url'), 'https://example.com?a=b');
  });

  test('distinguishes positionals from flags with next-arg heuristic', () => {
    const result = parseArgs(['launch', 'positional1', '--flag', 'value', 'positional2']);
    assert.strictEqual(result.verb, 'launch');
    assert.strictEqual(result.flags.get('flag'), 'value');
    assert.deepStrictEqual(result.positionals, ['positional1', 'positional2']);
  });
});

describe('requireFlag', () => {
  test('returns value when flag is present', () => {
    const flags = new Map([['platform', 'azure-devops']]);
    const value = requireFlag(flags, 'platform');
    assert.strictEqual(value, 'azure-devops');
  });

  test('throws CONFIG_MISSING when flag is absent', () => {
    const flags = new Map();
    const err = assertThrows(() => requireFlag(flags, 'platform'));
    assert.ok(err instanceof BridgeError);
    assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
  });

  test('error message names both flag and pipeline parameter', () => {
    const flags = new Map();
    const err = assertThrows(
      () => requireFlag(flags, 'platform', { pipelineParam: 'platform_param' })
    );
    assert.ok(err instanceof BridgeError);
    assert.match(err.message, /--platform/);
    assert.match(err.message, /platform_param/);
    assert.strictEqual(err.details.flag, 'platform');
    assert.strictEqual(err.details.pipelineParam, 'platform_param');
  });

  test('defaults pipelineParam to flag name', () => {
    const flags = new Map();
    const err = assertThrows(() => requireFlag(flags, 'myFlag'));
    assert.ok(err instanceof BridgeError);
    assert.match(err.message, /myFlag/);
  });

  test('throws when flag value is empty string', () => {
    const flags = new Map([['platform', '']]);
    const err = assertThrows(() => requireFlag(flags, 'platform'));
    assert.ok(err instanceof BridgeError);
    assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
  });

  test('throws when flag value is null', () => {
    const flags = new Map([['platform', null]]);
    const err = assertThrows(() => requireFlag(flags, 'platform'));
    assert.ok(err instanceof BridgeError);
    assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
  });

  test('coerces to string by default', () => {
    const flags = new Map([['platform', 'azure-devops']]);
    const value = requireFlag(flags, 'platform', { as: 'string' });
    assert.strictEqual(typeof value, 'string');
    assert.strictEqual(value, 'azure-devops');
  });

  test('coerces to integer', () => {
    const flags = new Map([['cycles', '10']]);
    const value = requireFlag(flags, 'cycles', { as: 'int' });
    assert.strictEqual(typeof value, 'number');
    assert.strictEqual(value, 10);
  });

  test('throws CONFIG_INVALID when integer coercion fails', () => {
    const flags = new Map([['cycles', 'not-an-int']]);
    const err = assertThrows(() => requireFlag(flags, 'cycles', { as: 'int' }));
    assert.ok(err instanceof BridgeError);
    assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
  });

  test('coerces to number (float)', () => {
    const flags = new Map([['budget', '99.99']]);
    const value = requireFlag(flags, 'budget', { as: 'number' });
    assert.strictEqual(typeof value, 'number');
    assert.strictEqual(value, 99.99);
  });

  test('throws CONFIG_INVALID when number coercion fails', () => {
    const flags = new Map([['budget', 'not-a-number']]);
    const err = assertThrows(() => requireFlag(flags, 'budget', { as: 'number' }));
    assert.ok(err instanceof BridgeError);
    assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
  });

  test('coerces string "true" to boolean', () => {
    const flags = new Map([['debug', 'true']]);
    const value = requireFlag(flags, 'debug', { as: 'bool' });
    assert.strictEqual(value, true);
  });

  test('coerces string "false" to boolean', () => {
    const flags = new Map([['debug', 'false']]);
    const value = requireFlag(flags, 'debug', { as: 'bool' });
    assert.strictEqual(value, false);
  });

  test('coerces boolean value directly', () => {
    const flags = new Map([['debug', true]]);
    const value = requireFlag(flags, 'debug', { as: 'bool' });
    assert.strictEqual(value, true);
  });

  test('throws CONFIG_INVALID for invalid boolean string', () => {
    const flags = new Map([['debug', 'yes']]);
    const err = assertThrows(() => requireFlag(flags, 'debug', { as: 'bool' }));
    assert.ok(err instanceof BridgeError);
    assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
  });

  test('uses default coercer (string) when as is omitted', () => {
    const flags = new Map([['platform', 'azure-devops']]);
    const value = requireFlag(flags, 'platform');
    assert.strictEqual(typeof value, 'string');
    assert.strictEqual(value, 'azure-devops');
  });

  test('error message includes flag in details', () => {
    const flags = new Map();
    const err = assertThrows(() => requireFlag(flags, 'myFlag'));
    assert.strictEqual(err.details.flag, 'myFlag');
  });
});
