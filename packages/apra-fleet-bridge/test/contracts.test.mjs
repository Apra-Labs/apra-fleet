// Tests for src/contracts.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { assertThrows } from './helpers.mjs';
import {
  ISSUE_ID_PATTERN,
  BRANCH_NAME_PATTERN,
  GOAL_PATTERN,
  TRACKER_REF_PATTERN,
  assertValidTrackerRef,
  AWAIT_UNTIL_SPECS,
  parseAwaitUntil,
  KNOWN_REQUEST_KEYS,
  validateSprintRequest,
  assertNoSecrets,
  makeSprintHandle,
  validateProgressSnapshot,
  makeProgressSnapshot,
} from '../src/contracts.mjs';
import { BridgeError, BRIDGE_ERROR_CODES } from '../src/errors.mjs';

describe('Pattern validation', () => {
  describe('ISSUE_ID_PATTERN', () => {
    test('accepts valid issue ids', () => {
      assert.ok(ISSUE_ID_PATTERN.test('ID123'));
      assert.ok(ISSUE_ID_PATTERN.test('a.b-c_d'));
      assert.ok(ISSUE_ID_PATTERN.test('T1'));
      assert.ok(ISSUE_ID_PATTERN.test('M1.3'));
    });

    test('rejects invalid issue ids', () => {
      assert.ok(!ISSUE_ID_PATTERN.test('ID 123')); // space
      assert.ok(!ISSUE_ID_PATTERN.test('ID/123')); // slash
      assert.ok(!ISSUE_ID_PATTERN.test('')); // empty
      assert.ok(!ISSUE_ID_PATTERN.test('ID@123')); // special char
    });
  });

  describe('BRANCH_NAME_PATTERN', () => {
    test('accepts valid branch names', () => {
      assert.ok(BRANCH_NAME_PATTERN.test('main'));
      assert.ok(BRANCH_NAME_PATTERN.test('feature/my-feature'));
      assert.ok(BRANCH_NAME_PATTERN.test('fix_bug.123'));
      assert.ok(BRANCH_NAME_PATTERN.test('a/b/c'));
    });

    test('rejects invalid branch names', () => {
      assert.ok(!BRANCH_NAME_PATTERN.test('feature branch')); // space
      assert.ok(!BRANCH_NAME_PATTERN.test('feature@branch')); // special char
      assert.ok(!BRANCH_NAME_PATTERN.test('')); // empty
    });
  });

  describe('TRACKER_REF_PATTERN / assertValidTrackerRef', () => {
    test('pattern accepts external tracker refs including owner/repo#123', () => {
      assert.ok(TRACKER_REF_PATTERN.test('12345'));
      assert.ok(TRACKER_REF_PATTERN.test('WI-123'));
      assert.ok(TRACKER_REF_PATTERN.test('owner/repo#123'));
      assert.ok(TRACKER_REF_PATTERN.test('mem-1i4'));
    });

    test('pattern rejects a space and a leading dash', () => {
      assert.ok(!TRACKER_REF_PATTERN.test('WI 123'));
      assert.ok(!TRACKER_REF_PATTERN.test(''));
    });

    test('assertValidTrackerRef accepts 12345, WI-123, owner/repo#123', () => {
      assert.doesNotThrow(() => assertValidTrackerRef('12345', 'work item'));
      assert.doesNotThrow(() => assertValidTrackerRef('WI-123', 'work item'));
      assert.doesNotThrow(() => assertValidTrackerRef('owner/repo#123', 'work item'));
    });

    test('assertValidTrackerRef rejects a value with a space', () => {
      const err = assertThrows(() => assertValidTrackerRef('WI 123', 'work item'));
      assert.ok(err instanceof BridgeError);
      assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
    });

    test('assertValidTrackerRef rejects --all (flag injection)', () => {
      const err = assertThrows(() => assertValidTrackerRef('--all', 'work item'));
      assert.ok(err instanceof BridgeError);
      assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
      assert.match(err.message, /may not begin with a dash/);
    });
  });

  describe('GOAL_PATTERN', () => {
    test('accepts valid goal values', () => {
      assert.ok(GOAL_PATTERN.test('P1'));
      assert.ok(GOAL_PATTERN.test('P2'));
      assert.ok(GOAL_PATTERN.test('P3'));
      assert.ok(GOAL_PATTERN.test('P1/P2'));
      assert.ok(GOAL_PATTERN.test('P1/P2/P3'));
      assert.ok(GOAL_PATTERN.test('P2/P3'));
    });

    test('rejects invalid goal values', () => {
      assert.ok(!GOAL_PATTERN.test('P0'));
      assert.ok(!GOAL_PATTERN.test('P4'));
      assert.ok(!GOAL_PATTERN.test('P1/P2/P3/P4'));
      assert.ok(!GOAL_PATTERN.test('P1/')); // trailing slash
      assert.ok(!GOAL_PATTERN.test('/P1')); // leading slash
      assert.ok(!GOAL_PATTERN.test('P1//P2')); // double slash
      assert.ok(!GOAL_PATTERN.test('')); // empty
    });
  });
});

describe('AWAIT_UNTIL_SPECS', () => {
  test('is a frozen array', () => {
    assert.ok(Array.isArray(AWAIT_UNTIL_SPECS));
    assertThrows(() => {
      AWAIT_UNTIL_SPECS[0] = 'mutated';
    }, TypeError);
  });

  test('contains expected specs', () => {
    assert.ok(AWAIT_UNTIL_SPECS.includes('launch'));
    assert.ok(AWAIT_UNTIL_SPECS.includes('plan-round'));
    assert.ok(AWAIT_UNTIL_SPECS.includes('plan-approved'));
    assert.ok(AWAIT_UNTIL_SPECS.includes('plan-settled'));
  });
});

describe('parseAwaitUntil', () => {
  test('accepts known specs', () => {
    const result1 = parseAwaitUntil('launch');
    assert.deepStrictEqual(result1, { kind: 'launch' });

    const result2 = parseAwaitUntil('plan-approved');
    assert.deepStrictEqual(result2, { kind: 'plan-approved' });
  });

  test('accepts phase:regex form', () => {
    const result = parseAwaitUntil('phase:test.*');
    assert.strictEqual(result.kind, 'phase');
    assert.ok(result.pattern instanceof RegExp);
    assert.ok(result.pattern.test('test-phase'));
    assert.ok(!result.pattern.test('other-phase'));
  });

  test('rejects invalid regex in phase form', () => {
    const err = assertThrows(() => parseAwaitUntil('phase:('));
    assert.ok(err instanceof BridgeError);
    assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
    assert.match(err.message, /regex/i);
  });

  test('rejects phase with empty pattern', () => {
    const err = assertThrows(() => parseAwaitUntil('phase:'));
    assert.ok(err instanceof BridgeError);
    assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
  });

  test('accepts cycle:N form', () => {
    const result = parseAwaitUntil('cycle:5');
    assert.strictEqual(result.kind, 'cycle');
    assert.strictEqual(result.cycle, 5);
  });

  test('rejects cycle with non-integer', () => {
    const err = assertThrows(() => parseAwaitUntil('cycle:abc'));
    assert.ok(err instanceof BridgeError);
    assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
  });

  test('rejects cycle with negative number', () => {
    const err = assertThrows(() => parseAwaitUntil('cycle:-1'));
    assert.ok(err instanceof BridgeError);
    assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
  });

  test('rejects unknown spec', () => {
    const err = assertThrows(() => parseAwaitUntil('unknown-spec'));
    assert.ok(err instanceof BridgeError);
    assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
  });

  test('rejects non-string input', () => {
    const err = assertThrows(() => parseAwaitUntil(123));
    assert.ok(err instanceof BridgeError);
    assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
  });

  test('rejects empty string', () => {
    const err = assertThrows(() => parseAwaitUntil(''));
    assert.ok(err instanceof BridgeError);
    assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
  });
});

describe('validateSprintRequest', () => {
  const validRequest = {
    platform: 'azure-devops',
    member: 'alice',
    workItems: ['T1', 'T2'],
  };

  test('accepts valid minimal request', () => {
    const result = validateSprintRequest(validRequest);
    assert.strictEqual(result.platform, 'azure-devops');
    assert.strictEqual(result.member, 'alice');
    assert.deepStrictEqual(result.workItems, ['T1', 'T2']);
    assert.strictEqual(result.goal, 'P1/P2'); // default
    assert.strictEqual(result.mode, 'detached'); // default
  });

  test('rejects request with unknown keys', () => {
    const err = assertThrows(() => validateSprintRequest({ ...validRequest, unknownKey: 'value' })
    );
    assert.ok(err instanceof BridgeError);
    assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
    assert.match(err.message, /unknown|unknownKey/i);
    assert.ok(err.details.unknownKeys.includes('unknownKey'));
  });

  test('rejects missing platform', () => {
    const err = assertThrows(() => validateSprintRequest({ member: 'alice', workItems: ['T1'] })
    );
    assert.ok(err instanceof BridgeError);
    assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
    assert.match(err.message, /platform/i);
  });

  test('rejects empty platform', () => {
    const err = assertThrows(() => validateSprintRequest({ platform: '', member: 'alice', workItems: ['T1'] })
    );
    assert.ok(err instanceof BridgeError);
    assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
  });

  test('rejects missing member', () => {
    const err = assertThrows(() => validateSprintRequest({ platform: 'azure-devops', workItems: ['T1'] })
    );
    assert.ok(err instanceof BridgeError);
    assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
    assert.match(err.message, /member/i);
  });

  test('rejects empty workItems', () => {
    const err = assertThrows(() => validateSprintRequest({ platform: 'azure-devops', member: 'alice', workItems: [] })
    );
    assert.ok(err instanceof BridgeError);
    assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
    assert.match(err.message, /workItems/i);
  });

  test('rejects a workItem containing a space', () => {
    const err = assertThrows(() => validateSprintRequest({ ...validRequest, workItems: ['WI 123'] })
    );
    assert.ok(err instanceof BridgeError);
    assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
  });

  test('rejects a workItem of "--all" (flag injection)', () => {
    const err = assertThrows(() => validateSprintRequest({ ...validRequest, workItems: ['--all'] })
    );
    assert.ok(err instanceof BridgeError);
    assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
    assert.match(err.message, /may not begin with a dash/);
  });

  test('accepts workItems 12345, WI-123, owner/repo#123 (external tracker refs, not bead ids)', () => {
    const result = validateSprintRequest({ ...validRequest, workItems: ['12345', 'WI-123', 'owner/repo#123'] });
    assert.deepStrictEqual(result.workItems, ['12345', 'WI-123', 'owner/repo#123']);
  });

  test('rejects invalid goal', () => {
    const err = assertThrows(() => validateSprintRequest({ ...validRequest, goal: 'P0' })
    );
    assert.ok(err instanceof BridgeError);
    assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
    assert.match(err.message, /goal/i);
  });

  test('applies default goal', () => {
    const result = validateSprintRequest(validRequest);
    assert.strictEqual(result.goal, 'P1/P2');
  });

  test('accepts valid custom goal', () => {
    const result = validateSprintRequest({ ...validRequest, goal: 'P1/P2/P3' });
    assert.strictEqual(result.goal, 'P1/P2/P3');
  });

  test('rejects attached mode', () => {
    const err = assertThrows(() => validateSprintRequest({ ...validRequest, mode: 'attached' })
    );
    assert.ok(err instanceof BridgeError);
    assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
    assert.match(err.message, /attached|not supported/i);
  });

  test('applies default mode', () => {
    const result = validateSprintRequest(validRequest);
    assert.strictEqual(result.mode, 'detached');
  });

  test('rejects invalid targetBranch', () => {
    const err = assertThrows(() => validateSprintRequest({ ...validRequest, targetBranch: 'target branch' })
    );
    assert.ok(err instanceof BridgeError);
    assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
  });

  test('rejects invalid baseBranch', () => {
    const err = assertThrows(() => validateSprintRequest({ ...validRequest, baseBranch: 'base@branch' })
    );
    assert.ok(err instanceof BridgeError);
    assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
  });

  describe('targetBranch === baseBranch (the launch-contract mistake)', () => {
    test('rejects identical targetBranch and baseBranch', () => {
      const err = assertThrows(() => validateSprintRequest({ ...validRequest, targetBranch: 'main', baseBranch: 'main' })
      );
      assert.ok(err instanceof BridgeError);
      assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
      assert.match(err.message, /targetBranch/);
      assert.match(err.message, /baseBranch/);
    });

    test('rejects values differing only by surrounding whitespace', () => {
      const err = assertThrows(() => validateSprintRequest({ ...validRequest, targetBranch: 'main', baseBranch: ' main ' })
      );
      assert.ok(err instanceof BridgeError);
      assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
    });

    // Deliberately NOT case-folded: git branch names are case-sensitive, so
    // "Main" and "main" are two genuinely different refs. Folding case here
    // would make this check reject a legitimate distinct pair -- do not
    // "fix" this to use a case-insensitive comparison.
    test('accepts values differing only by case', () => {
      const result = validateSprintRequest({ ...validRequest, targetBranch: 'Main', baseBranch: 'main' });
      assert.strictEqual(result.targetBranch, 'Main');
      assert.strictEqual(result.baseBranch, 'main');
    });

    test('does not fire when only targetBranch is present', () => {
      const result = validateSprintRequest({ ...validRequest, targetBranch: 'feature/x' });
      assert.strictEqual(result.targetBranch, 'feature/x');
      assert.strictEqual(result.baseBranch, undefined);
    });

    test('does not fire when only baseBranch is present', () => {
      const result = validateSprintRequest({ ...validRequest, baseBranch: 'main' });
      assert.strictEqual(result.targetBranch, undefined);
      assert.strictEqual(result.baseBranch, 'main');
    });

    test('does not fire when both are absent', () => {
      const result = validateSprintRequest(validRequest);
      assert.strictEqual(result.targetBranch, undefined);
      assert.strictEqual(result.baseBranch, undefined);
    });

    test('accepts a genuinely different pair', () => {
      const result = validateSprintRequest({ ...validRequest, targetBranch: 'feature/x', baseBranch: 'main' });
      assert.strictEqual(result.targetBranch, 'feature/x');
      assert.strictEqual(result.baseBranch, 'main');
    });

    test('a malformed targetBranch still reports its own pattern error, not the equality error', () => {
      const err = assertThrows(() => validateSprintRequest({ ...validRequest, targetBranch: 'target branch', baseBranch: 'target branch' })
      );
      assert.ok(err instanceof BridgeError);
      assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
      assert.match(err.message, /targetBranch/);
      assert.ok(!/must name different/.test(err.message));
    });
  });

  test('rejects negative maxCycles', () => {
    const err = assertThrows(() => validateSprintRequest({ ...validRequest, maxCycles: -1 })
    );
    assert.ok(err instanceof BridgeError);
    assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
  });

  test('rejects non-integer maxCycles', () => {
    const err = assertThrows(() => validateSprintRequest({ ...validRequest, maxCycles: 1.5 })
    );
    assert.ok(err instanceof BridgeError);
    assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
  });

  test('rejects negative budget', () => {
    const err = assertThrows(() => validateSprintRequest({ ...validRequest, budget: -1 })
    );
    assert.ok(err instanceof BridgeError);
    assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
  });

  test('rejects non-finite budget', () => {
    const err = assertThrows(() => validateSprintRequest({ ...validRequest, budget: Infinity })
    );
    assert.ok(err instanceof BridgeError);
    assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
  });

  test('accepts valid optional fields', () => {
    const result = validateSprintRequest({
      ...validRequest,
      targetBranch: 'feature/x',
      baseBranch: 'main',
      maxCycles: 10,
      budget: 100.50,
      requirementsFile: 'requirements.md',
      triggeredBy: 'webhook',
      runUrl: 'https://example.com/run/123',
    });
    assert.strictEqual(result.targetBranch, 'feature/x');
    assert.strictEqual(result.baseBranch, 'main');
    assert.strictEqual(result.maxCycles, 10);
    assert.strictEqual(result.budget, 100.50);
    assert.strictEqual(result.requirementsFile, 'requirements.md');
    assert.strictEqual(result.triggeredBy, 'webhook');
    assert.strictEqual(result.runUrl, 'https://example.com/run/123');
  });

  test('returns frozen object', () => {
    const result = validateSprintRequest(validRequest);
    assertThrows(() => {
      result.newProp = 'value';
    });
  });

  describe('patSecretName', () => {
    test('is undefined when not provided', () => {
      const result = validateSprintRequest(validRequest);
      assert.strictEqual(result.patSecretName, undefined);
    });

    test('accepts a valid credential name', () => {
      const result = validateSprintRequest({ ...validRequest, patSecretName: 'fleet_bridge_azdevops_pat' });
      assert.strictEqual(result.patSecretName, 'fleet_bridge_azdevops_pat');
    });

    test('rejects a malformed name with CONFIG_INVALID', () => {
      const err = assertThrows(() => validateSprintRequest({ ...validRequest, patSecretName: 'bad name!' }));
      assert.ok(err instanceof BridgeError);
      assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
    });

    test('rejects a name beginning with a dash', () => {
      const err = assertThrows(() => validateSprintRequest({ ...validRequest, patSecretName: '-x' }));
      assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
    });

    test('rejects a name containing "}" so it can never close a {{secret.NAME}} placeholder', () => {
      const err = assertThrows(() => validateSprintRequest({ ...validRequest, patSecretName: 'x}}malicious' }));
      assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
    });

    test('rejects an empty string', () => {
      const err = assertThrows(() => validateSprintRequest({ ...validRequest, patSecretName: '' }));
      assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
    });
  });

  test('rejects non-object input', () => {
    const err = assertThrows(() => validateSprintRequest('not an object')
    );
    assert.ok(err instanceof BridgeError);
    assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
  });

  test('rejects array input', () => {
    const err = assertThrows(() => validateSprintRequest([])
    );
    assert.ok(err instanceof BridgeError);
    assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
  });
});

describe('assertNoSecrets', () => {
  test('accepts object with no secret keys', () => {
    const obj = { name: 'alice', role: 'engineer' };
    assert.doesNotThrow(() => assertNoSecrets(obj, 'test-object'));
  });

  test('rejects object with token key', () => {
    const err = assertThrows(() => assertNoSecrets({ token: 'secret123' }, 'test-object')
    );
    assert.ok(err instanceof BridgeError);
    assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
    assert.match(err.message, /token/i);
  });

  test('rejects nested secret (case-insensitive)', () => {
    const err = assertThrows(() => assertNoSecrets({ auth: { PASSWORD: 'secret' } }, 'test-object')
    );
    assert.ok(err instanceof BridgeError);
    assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
    assert.match(err.message, /password/i);
  });

  test('rejects arrays with secrets', () => {
    const err = assertThrows(() => assertNoSecrets([{ secret: 'value' }], 'test-array')
    );
    assert.ok(err instanceof BridgeError);
    assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
  });

  test('rejects PAT and SAS keys', () => {
    const errPat = assertThrows(() => assertNoSecrets({ pat: 'token' }, 'test')
    );
    assert.ok(errPat instanceof BridgeError);
    assert.strictEqual(errPat.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);

    const errSas = assertThrows(() => assertNoSecrets({ sas: 'token' }, 'test')
    );
    assert.ok(errSas instanceof BridgeError);
    assert.strictEqual(errSas.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
  });

  test('rejects compound token keys (substring match)', () => {
    const testCases = [
      { accessToken: 'value' },
      { bearerToken: 'value' },
      { apiToken: 'value' },
    ];

    for (const obj of testCases) {
      const err = assertThrows(() => assertNoSecrets(obj, 'test'));
      assert.ok(err instanceof BridgeError);
      assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
      assert.match(err.message, /token/i);
    }
  });

  test('rejects compound secret keys (substring match)', () => {
    const testCases = [
      { clientSecret: 'value' },
      { apiSecret: 'value' },
    ];

    for (const obj of testCases) {
      const err = assertThrows(() => assertNoSecrets(obj, 'test'));
      assert.ok(err instanceof BridgeError);
      assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
      assert.match(err.message, /secret/i);
    }
  });

  test('rejects compound SAS keys (substring match)', () => {
    const err = assertThrows(() => assertNoSecrets({ sasUrl: 'value' }, 'test')
    );
    assert.ok(err instanceof BridgeError);
    assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
    assert.match(err.message, /sas/i);
  });

  test('rejects compound password keys (substring match)', () => {
    const testCases = [
      { adminPassword: 'value' },
      { dbPassword: 'value' },
    ];

    for (const obj of testCases) {
      const err = assertThrows(() => assertNoSecrets(obj, 'test'));
      assert.ok(err instanceof BridgeError);
      assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
      assert.match(err.message, /password/i);
    }
  });

  test('rejects nested secret keys', () => {
    const err = assertThrows(() => assertNoSecrets({ a: [{ clientSecret: 'x' }] }, 'test')
    );
    assert.ok(err instanceof BridgeError);
    assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
  });

  test('accepts innocent keys that contain "pat" substring (path, patch, compatible, pattern)', () => {
    // These should NOT throw
    assert.doesNotThrow(() => assertNoSecrets({ path: 'value' }, 'test'));
    assert.doesNotThrow(() => assertNoSecrets({ patch: 'value' }, 'test'));
    assert.doesNotThrow(() => assertNoSecrets({ compatible: 'value' }, 'test'));
    assert.doesNotThrow(() => assertNoSecrets({ pattern: 'value' }, 'test'));
    assert.doesNotThrow(() => assertNoSecrets({ PATH: 'value' }, 'test'));
    assert.doesNotThrow(() => assertNoSecrets({ PatchVersion: 'value' }, 'test'));
  });

  test('accepts case variations of innocent pat-substring keys', () => {
    assert.doesNotThrow(() => assertNoSecrets({ Path: 'value' }, 'test'));
    assert.doesNotThrow(() => assertNoSecrets({ Patch: 'value' }, 'test'));
    assert.doesNotThrow(() => assertNoSecrets({ Compatible: 'value' }, 'test'));
    assert.doesNotThrow(() => assertNoSecrets({ Pattern: 'value' }, 'test'));
  });

  test('rejects PAT exactly, case-insensitive', () => {
    const testCases = ['pat', 'PAT', 'Pat', 'pAt'];
    for (const key of testCases) {
      const obj = { [key]: 'value' };
      const err = assertThrows(() => assertNoSecrets(obj, 'test'));
      assert.ok(err instanceof BridgeError);
      assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
    }
  });

  test('rejects a credential-bearing URL value regardless of key name', () => {
    const err = assertThrows(() => assertNoSecrets({ repo: { remoteUrl: 'https://u:p@host/x' } }, 'test')
    );
    assert.ok(err instanceof BridgeError);
    assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
    assert.match(err.message, /credential/i);
  });

  test('accepts a clean URL with no embedded credentials', () => {
    assert.doesNotThrow(() => assertNoSecrets({ repo: { remoteUrl: 'https://host/x' } }, 'test'));
  });

  test('accepts a URL with a username but no password', () => {
    assert.doesNotThrow(() => assertNoSecrets({ repo: { remoteUrl: 'https://user@host/x' } }, 'test'));
  });
});

describe('makeSprintHandle', () => {
  test('creates a handle from valid inputs', () => {
    const handle = makeSprintHandle({
      launchResponse: { sprintId: 'sprint-1', pid: 1234, port: 8080, logPath: '/logs/sprint.log', issueRoots: ['T1', 'T2'] },
      request: { platform: 'azure-devops' },
      startedAt: 1234567890,
      syntheticRootId: 'M1.0',
    });

    assert.strictEqual(handle.version, 1);
    assert.strictEqual(handle.sprintId, 'sprint-1');
    assert.strictEqual(handle.pid, 1234);
    assert.strictEqual(handle.port, 8080);
    assert.strictEqual(handle.syntheticRootId, 'M1.0');
  });

  test('returns frozen object', () => {
    const handle = makeSprintHandle({
      launchResponse: { sprintId: 'sprint-1' },
      request: {},
      startedAt: Date.now(),
      syntheticRootId: 'M1.0',
    });

    assertThrows(() => {
      handle.newProp = 'value';
    });
  });

  test('rejects handle with nested secrets', () => {
    const err = assertThrows(() => makeSprintHandle({
        launchResponse: { sprintId: 'sprint-1', pid: 1234 },
        request: { auth: { token: 'secret' } },
        startedAt: Date.now(),
        syntheticRootId: 'M1.0',
      })
    );
    assert.ok(err instanceof BridgeError);
    assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
  });

  test('rejects handle with secret in request', () => {
    const err = assertThrows(() => makeSprintHandle({
        launchResponse: { sprintId: 'sprint-1' },
        request: { token: 'secret' },
        startedAt: Date.now(),
        syntheticRootId: 'M1.0',
      })
    );
    assert.ok(err instanceof BridgeError);
    assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
  });
});

describe('validateProgressSnapshot / makeProgressSnapshot', () => {
  test('validateProgressSnapshot accepts valid snapshot', () => {
    assert.doesNotThrow(() => validateProgressSnapshot({
      sprintId: 'sprint-1',
      phase: 'plan',
      cycle: 1,
      health: 'green',
      closed: 5,
      required: 10,
      fraction: 0.5,
      spendUsd: 50.00,
      verdict: 'progress',
      updatedAt: Date.now(),
    }));
  });

  test('validateProgressSnapshot rejects missing sprintId', () => {
    const err = assertThrows(() => validateProgressSnapshot({
        phase: 'plan',
        cycle: 1,
        updatedAt: Date.now(),
      })
    );
    assert.ok(err instanceof BridgeError);
    assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
  });

  test('validateProgressSnapshot accepts cycle: null -- "cannot be determined", distinct from a missing field', () => {
    assert.doesNotThrow(() => validateProgressSnapshot({
      sprintId: 'sprint-1',
      phase: 'unknown',
      cycle: null,
      health: 'terminal',
      updatedAt: Date.now(),
    }));
  });

  test('validateProgressSnapshot still rejects a non-integer, non-null cycle', () => {
    const err = assertThrows(() => validateProgressSnapshot({
        sprintId: 'sprint-1',
        phase: 'plan',
        cycle: 'null', // the STRING, not the value -- must not be treated as the sentinel
        updatedAt: Date.now(),
      })
    );
    assert.ok(err instanceof BridgeError);
    assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
  });

  test('validateProgressSnapshot rejects invalid cycle (negative)', () => {
    const err = assertThrows(() => validateProgressSnapshot({
        sprintId: 'sprint-1',
        phase: 'plan',
        cycle: -1,
        updatedAt: Date.now(),
      })
    );
    assert.ok(err instanceof BridgeError);
    assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
  });

  test('validateProgressSnapshot rejects invalid fraction (> 1)', () => {
    const err = assertThrows(() => validateProgressSnapshot({
        sprintId: 'sprint-1',
        phase: 'plan',
        cycle: 1,
        fraction: 1.5,
        updatedAt: Date.now(),
      })
    );
    assert.ok(err instanceof BridgeError);
    assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
  });

  test('makeProgressSnapshot returns frozen object', () => {
    const snapshot = makeProgressSnapshot({
      sprintId: 'sprint-1',
      phase: 'plan',
      cycle: 1,
      updatedAt: Date.now(),
    });

    assertThrows(() => {
      snapshot.newProp = 'value';
    });
  });

  test('makeProgressSnapshot validates before freezing', () => {
    const err = assertThrows(() => makeProgressSnapshot({
        sprintId: 'sprint-1',
        phase: 'plan',
        cycle: 'not-an-int',
        updatedAt: Date.now(),
      })
    );
    assert.ok(err instanceof BridgeError);
    assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
  });
});

describe('KNOWN_REQUEST_KEYS', () => {
  test('is a frozen Set', () => {
    assert.ok(KNOWN_REQUEST_KEYS instanceof Set);
    assertThrows(() => {
      KNOWN_REQUEST_KEYS.add('newKey');
    });
  });

  test('contains expected keys', () => {
    const expected = [
      'platform',
      'repo',
      'workItems',
      'targetBranch',
      'baseBranch',
      'goal',
      'member',
      'maxCycles',
      'budget',
      'requirementsFile',
      'mode',
      'triggeredBy',
      'runUrl',
      'patSecretName',
    ];
    for (const key of expected) {
      assert.ok(
        KNOWN_REQUEST_KEYS.has(key),
        `Expected KNOWN_REQUEST_KEYS to contain "${key}"`
      );
    }
  });
});
