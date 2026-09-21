// Tests for src/verbs/launch.mjs -- fake supervisorClient/spool throughout;
// no real timers (sleep/now are injected fakes), no real network.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { assertThrows } from './helpers.mjs';

import {
  runLaunch,
  validateLaunchOpts,
  buildPostSprintBody,
  colorForAwaitOutcome,
} from '../src/verbs/launch.mjs';
import { BridgeError, BRIDGE_ERROR_CODES } from '../src/errors.mjs';

// ---------------------------------------------------------------------------
// Fixtures and fakes
// ---------------------------------------------------------------------------

function makeRequest(overrides = {}) {
  return {
    platform: 'azure-devops',
    workItems: ['WI-100'],
    member: 'm1',
    ...overrides,
  };
}

// The issue root buildPostSprintBody()/validateLaunchOpts() now require --
// stands in for ingest's syntheticRootId output (e.g. "ado_toy-e3z").
const ROOT_ID = 'ado_toy-e3z';

function makeLaunchResponse(overrides = {}) {
  return {
    sprintId: 'spr-1',
    pid: 4242,
    port: 9001,
    logPath: '/tmp/spr-1.log',
    issueRoots: ['epic-1'],
    ...overrides,
  };
}

/** A fake supervisor client recording postSprint()/getSprint() calls.
 * `getSprintSequence`, when given, is walked one entry per getSprint() call
 * (the last entry repeats once exhausted) -- either a sprint object or a
 * thunk returning one. */
function makeFakeSupervisorClient({ postSprintResult, postSprintError, getSprintSequence } = {}) {
  const postSprintCalls = [];
  const getSprintCalls = [];
  let seq = 0;
  return {
    postSprintCalls,
    getSprintCalls,
    async postSprint(body) {
      postSprintCalls.push(body);
      if (postSprintError) throw postSprintError;
      return postSprintResult !== undefined ? postSprintResult : makeLaunchResponse();
    },
    async getSprint(sprintId) {
      getSprintCalls.push(sprintId);
      if (!getSprintSequence || getSprintSequence.length === 0) return null;
      const entry = getSprintSequence[Math.min(seq, getSprintSequence.length - 1)];
      seq += 1;
      return typeof entry === 'function' ? entry() : entry;
    },
    async getLog() {
      return null;
    },
    // Never wired into runLaunch's deps at all -- present only so a test can
    // prove it is never called (see "timeout issues no stop" below).
    async stopSprint() {
      throw new Error('stopSprint must never be called by runLaunch');
    },
  };
}

/** A fake spool recording write() calls. */
function makeFakeSpool() {
  const writeCalls = [];
  return {
    writeCalls,
    async write(handle) {
      writeCalls.push(handle);
      return handle;
    },
  };
}

function makeDeps(overrides = {}) {
  let clock = overrides.startClock ?? 1_700_000_000_000;
  return {
    supervisorClient: overrides.supervisorClient ?? makeFakeSupervisorClient(),
    spool: overrides.spool ?? makeFakeSpool(),
    sleep: overrides.sleep ?? (async () => {}),
    now: overrides.now ?? (() => clock++),
    log: overrides.log ?? (() => {}),
  };
}

// ---------------------------------------------------------------------------
// validateLaunchOpts
// ---------------------------------------------------------------------------

describe('validateLaunchOpts', () => {
  test('throws CONFIG_MISSING when opts.request is missing', () => {
    const err = assertThrows(() => validateLaunchOpts({}));
    assert.ok(err instanceof BridgeError);
    assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
  });

  test('opts.request is validated through contracts.mjs validateSprintRequest', () => {
    const err = assertThrows(() => validateLaunchOpts({ request: { platform: 'azure-devops' } }));
    assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
  });

  test('throws CONFIG_INVALID for an empty syntheticRootId', () => {
    const err = assertThrows(() => validateLaunchOpts({ request: makeRequest(), syntheticRootId: '' }));
    assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
  });

  test('throws CONFIG_MISSING when opts.syntheticRootId is absent -- naming --synthetic-root-id, not the supervisor\'s opaque 400', () => {
    const err = assertThrows(() => validateLaunchOpts({ request: makeRequest() }));
    assert.ok(err instanceof BridgeError);
    assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
    assert.match(err.message, /--synthetic-root-id/);
    assert.match(err.message, /syntheticRootId/);
  });

  test('throws CONFIG_INVALID for a negative timeoutMs', () => {
    const err = assertThrows(() => validateLaunchOpts({ request: makeRequest(), syntheticRootId: ROOT_ID, timeoutMs: -1 }));
    assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
  });

  test('overrideRelaunchGate defaults to false when absent', () => {
    const validated = validateLaunchOpts({ request: makeRequest(), syntheticRootId: ROOT_ID });
    assert.strictEqual(validated.overrideRelaunchGate, false);
  });

  test('overrideRelaunchGate normalizes to false unless exactly true', () => {
    const validated = validateLaunchOpts({ request: makeRequest(), syntheticRootId: ROOT_ID, overrideRelaunchGate: 'yes' });
    assert.strictEqual(validated.overrideRelaunchGate, false);

    const validatedTrue = validateLaunchOpts({ request: makeRequest(), syntheticRootId: ROOT_ID, overrideRelaunchGate: true });
    assert.strictEqual(validatedTrue.overrideRelaunchGate, true);
  });

  test('awaitUntil is preserved raw (not defaulted) so runLaunch can compare it to "launch"', () => {
    const validated = validateLaunchOpts({ request: makeRequest(), syntheticRootId: ROOT_ID });
    assert.strictEqual(validated.awaitUntil, undefined);
  });

  test('opts.request.patSecretName is validated through contracts.mjs (CONFIG_INVALID on a malformed name)', () => {
    const err = assertThrows(() => validateLaunchOpts({ request: makeRequest({ patSecretName: 'bad name!' }), syntheticRootId: ROOT_ID }));
    assert.ok(err instanceof BridgeError);
    assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
  });
});

// ---------------------------------------------------------------------------
// buildPostSprintBody
// ---------------------------------------------------------------------------

describe('buildPostSprintBody', () => {
  test('throws CONFIG_MISSING naming --synthetic-root-id when the issue root is missing', () => {
    const err = assertThrows(() => buildPostSprintBody(makeRequest(), undefined, false));
    assert.ok(err instanceof BridgeError);
    assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
    assert.match(err.message, /--synthetic-root-id/);
    assert.match(err.message, /syntheticRootId/);
  });

  test('throws CONFIG_MISSING when the issue root is an empty string', () => {
    const err = assertThrows(() => buildPostSprintBody(makeRequest(), '', false));
    assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
  });

  test('maps issue <- syntheticRootId (never request.workItems)', () => {
    const body = buildPostSprintBody(makeRequest({ workItems: ['2', '3', '4'] }), 'ado_toy-e3z', false);
    assert.strictEqual(body.issue, 'ado_toy-e3z');
  });

  test('maps branch <- targetBranch and base <- baseBranch', () => {
    const body = buildPostSprintBody(
      makeRequest({ targetBranch: 'feat/x', baseBranch: 'main' }),
      'ado_toy-e3z',
      false
    );
    assert.strictEqual(body.branch, 'feat/x');
    assert.strictEqual(body.base, 'main');
  });

  test('maps members <- [member] -- a one-element list, not the bare string', () => {
    const body = buildPostSprintBody(makeRequest({ member: 'aztoy' }), 'ado_toy-e3z', false);
    assert.deepStrictEqual(body.members, ['aztoy']);
  });

  test('passes goal, maxCycles, budget, requirementsFile through unchanged when present', () => {
    const body = buildPostSprintBody(
      makeRequest({ goal: 'P1/P2', maxCycles: 2, budget: 25, requirementsFile: 'reqs.md' }),
      'ado_toy-e3z',
      false
    );
    assert.strictEqual(body.goal, 'P1/P2');
    assert.strictEqual(body.maxCycles, 2);
    assert.strictEqual(body.budget, 25);
    assert.strictEqual(body.requirementsFile, 'reqs.md');
  });

  test('omits goal, maxCycles, budget, requirementsFile entirely when absent -- never forwards undefined', () => {
    const body = buildPostSprintBody(makeRequest(), 'ado_toy-e3z', false);
    for (const key of ['goal', 'maxCycles', 'budget', 'requirementsFile']) {
      assert.strictEqual(Object.prototype.hasOwnProperty.call(body, key), false, key);
    }
  });

  test('drops the six bridge-only SprintRequest fields entirely', () => {
    const body = buildPostSprintBody(
      makeRequest({
        repo: { remoteUrl: 'https://example.com/r.git', localPath: '/tmp/r' },
        targetBranch: 'feat/x',
        baseBranch: 'main',
        triggeredBy: 'ci',
        runUrl: 'https://ci.example.com/run/1',
      }),
      'ado_toy-e3z',
      false
    );
    for (const key of ['platform', 'repo', 'workItems', 'mode', 'triggeredBy', 'runUrl']) {
      assert.strictEqual(Object.prototype.hasOwnProperty.call(body, key), false, key);
    }
  });

  test('omits overrideRelaunchGate entirely when not flagged', () => {
    const body = buildPostSprintBody(makeRequest(), 'ado_toy-e3z', false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(body, 'overrideRelaunchGate'), false);
  });

  test('includes overrideRelaunchGate: true only when flagged', () => {
    const body = buildPostSprintBody(makeRequest(), 'ado_toy-e3z', true);
    assert.strictEqual(body.overrideRelaunchGate, true);
  });

  test('maps patSecretName onto the engine\'s vcs_pat_secret_name arg when present', () => {
    const body = buildPostSprintBody(makeRequest({ patSecretName: 'fleet_bridge_azdevops_pat' }), 'ado_toy-e3z', false);
    assert.strictEqual(body.vcs_pat_secret_name, 'fleet_bridge_azdevops_pat');
  });

  test('omits vcs_pat_secret_name entirely when patSecretName is not configured -- never forwards undefined', () => {
    const body = buildPostSprintBody(makeRequest(), 'ado_toy-e3z', false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(body, 'vcs_pat_secret_name'), false);
  });

  test('never forwards patSecretName under its own name', () => {
    const body = buildPostSprintBody(makeRequest({ patSecretName: 'fleet_bridge_azdevops_pat' }), 'ado_toy-e3z', false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(body, 'patSecretName'), false);
  });

  test('pins the body\'s key set for a fully-populated request, so a future SprintRequest field cannot silently leak into the engine body', () => {
    const body = buildPostSprintBody(
      makeRequest({
        repo: { remoteUrl: 'https://example.com/r.git', localPath: '/tmp/r' },
        targetBranch: 'feat/x',
        baseBranch: 'main',
        goal: 'P1/P2',
        maxCycles: 2,
        budget: 25,
        requirementsFile: 'reqs.md',
        triggeredBy: 'ci',
        runUrl: 'https://ci.example.com/run/1',
        patSecretName: 'fleet_bridge_azdevops_pat',
      }),
      'ado_toy-e3z',
      true
    );
    assert.deepStrictEqual(
      Object.keys(body).sort(),
      [
        'vcs_pat_secret_name',
        'base',
        'branch',
        'budget',
        'goal',
        'issue',
        'maxCycles',
        'members',
        'overrideRelaunchGate',
        'requirementsFile',
      ].sort()
    );
  });
});

// ---------------------------------------------------------------------------
// colorForAwaitOutcome
// ---------------------------------------------------------------------------

describe('colorForAwaitOutcome', () => {
  test('reached -> green', () => {
    assert.strictEqual(colorForAwaitOutcome({ outcome: 'reached' }), 'green');
  });

  test('timeout -> green (never a stop)', () => {
    assert.strictEqual(colorForAwaitOutcome({ outcome: 'timeout' }), 'green');
  });

  test('terminal -> red', () => {
    assert.strictEqual(colorForAwaitOutcome({ outcome: 'terminal', reason: 'engine reason' }), 'red');
  });
});

// ---------------------------------------------------------------------------
// runLaunch
// ---------------------------------------------------------------------------

describe('runLaunch', () => {
  test('happy path: posts the request, writes a handle to the spool, reaches the default milestone', async () => {
    const supervisorClient = makeFakeSupervisorClient({
      getSprintSequence: [{
        sprintId: 'spr-1',
        live: true,
        terminal: false,
        state: { extensions: { plan: { approved: true, status: 'approved', planningRounds: 1 } } },
      }],
    });
    const spool = makeFakeSpool();
    const deps = makeDeps({ supervisorClient, spool });

    const result = await runLaunch({ request: makeRequest(), syntheticRootId: ROOT_ID }, deps);

    assert.strictEqual(supervisorClient.postSprintCalls.length, 1);
    assert.strictEqual(result.handle.sprintId, 'spr-1');
    assert.strictEqual(spool.writeCalls.length, 1);
    assert.strictEqual(spool.writeCalls[0].sprintId, 'spr-1');
    assert.strictEqual(result.awaited.outcome, 'reached');
    assert.strictEqual(result.color, 'green');
    // The posted body speaks the supervisor's own vocabulary, not SprintRequest's.
    assert.strictEqual(supervisorClient.postSprintCalls[0].issue, ROOT_ID);
    assert.deepStrictEqual(supervisorClient.postSprintCalls[0].members, ['m1']);
  });

  test('a missing issue root is caught at validation time -- CONFIG_MISSING, zero supervisor calls, exit-2 territory', async () => {
    const supervisorClient = makeFakeSupervisorClient();
    const deps = makeDeps({ supervisorClient });

    await assert.rejects(
      () => runLaunch({ request: makeRequest() }, deps),
      (err) => {
        assert.ok(err instanceof BridgeError);
        assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
        assert.match(err.message, /--synthetic-root-id/);
        return true;
      }
    );
    // Caught by validateLaunchOpts before anything is posted -- never the
    // supervisor's own opaque `Invalid issue id "undefined"` 400.
    assert.strictEqual(supervisorClient.postSprintCalls.length, 0);
  });

  test('patSecretName is forwarded to the engine key in the posted body, and never trips makeSprintHandle\'s assertNoSecrets guard', async () => {
    // Regression: contracts.mjs's assertNoSecrets rejects a key purely by
    // NAME (isSecretKey's substring rule matches "...Secret..." regardless
    // of value) -- patSecretName trips that rule by name alone, so runLaunch
    // must strip it from the persisted handle's request after
    // buildPostSprintBody has already read it. This proves the whole path
    // stays green end to end, not just the two halves in isolation.
    const supervisorClient = makeFakeSupervisorClient();
    const deps = makeDeps({ supervisorClient });

    const result = await runLaunch(
      { request: makeRequest({ patSecretName: 'fleet_bridge_azdevops_pat' }), syntheticRootId: ROOT_ID, awaitUntil: 'launch' },
      deps
    );

    assert.strictEqual(supervisorClient.postSprintCalls[0].vcs_pat_secret_name, 'fleet_bridge_azdevops_pat');
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(supervisorClient.postSprintCalls[0], 'patSecretName'),
      false
    );
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(result.handle.request, 'patSecretName'),
      false
    );
  });

  test('overrideRelaunchGate is forwarded only when the operator flagged it', async () => {
    const supervisorClient = makeFakeSupervisorClient();
    const deps = makeDeps({ supervisorClient });

    await runLaunch({ request: makeRequest(), syntheticRootId: ROOT_ID, awaitUntil: 'launch' }, deps);
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(supervisorClient.postSprintCalls[0], 'overrideRelaunchGate'),
      false
    );

    await runLaunch({ request: makeRequest(), syntheticRootId: ROOT_ID, awaitUntil: 'launch', overrideRelaunchGate: true }, deps);
    assert.strictEqual(supervisorClient.postSprintCalls[1].overrideRelaunchGate, true);
  });

  test('a 409 relaunch-gate conflict propagates with its message intact, never rewrapped', async () => {
    const conflictErr = new BridgeError(
      BRIDGE_ERROR_CODES.LAUNCH_RELAUNCH_GATE,
      'a sprint for this issue already failed recently'
    );
    const supervisorClient = makeFakeSupervisorClient({ postSprintError: conflictErr });
    const deps = makeDeps({ supervisorClient });

    await assert.rejects(
      () => runLaunch({ request: makeRequest(), syntheticRootId: ROOT_ID }, deps),
      (err) => {
        assert.ok(err instanceof BridgeError);
        assert.strictEqual(err.code, BRIDGE_ERROR_CODES.LAUNCH_RELAUNCH_GATE);
        assert.strictEqual(err.message, 'a sprint for this issue already failed recently');
        assert.strictEqual(err, conflictErr);
        return true;
      }
    );
  });

  test('a plain 409 conflict propagates with its message intact', async () => {
    const conflictErr = new BridgeError(
      BRIDGE_ERROR_CODES.LAUNCH_CONFLICT,
      'launch conflicted with an existing sprint (409)'
    );
    const supervisorClient = makeFakeSupervisorClient({ postSprintError: conflictErr });
    const deps = makeDeps({ supervisorClient });

    await assert.rejects(
      () => runLaunch({ request: makeRequest(), syntheticRootId: ROOT_ID }, deps),
      (err) => {
        assert.strictEqual(err.code, BRIDGE_ERROR_CODES.LAUNCH_CONFLICT);
        assert.strictEqual(err.message, 'launch conflicted with an existing sprint (409)');
        return true;
      }
    );
  });

  test('a 400 invalid-request error propagates unchanged', async () => {
    const invalidErr = new BridgeError(BRIDGE_ERROR_CODES.LAUNCH_INVALID, 'launch request rejected as invalid (400): bad field');
    const supervisorClient = makeFakeSupervisorClient({ postSprintError: invalidErr });
    const deps = makeDeps({ supervisorClient });

    await assert.rejects(
      () => runLaunch({ request: makeRequest(), syntheticRootId: ROOT_ID }, deps),
      (err) => {
        assert.strictEqual(err.code, BRIDGE_ERROR_CODES.LAUNCH_INVALID);
        assert.strictEqual(err.message, 'launch request rejected as invalid (400): bad field');
        return true;
      }
    );
  });

  test("awaitUntil: 'launch' skips the gate entirely -- zero getSprint calls", async () => {
    const supervisorClient = makeFakeSupervisorClient();
    const deps = makeDeps({ supervisorClient });

    const result = await runLaunch({ request: makeRequest(), syntheticRootId: ROOT_ID, awaitUntil: 'launch' }, deps);

    assert.strictEqual(supervisorClient.getSprintCalls.length, 0);
    assert.strictEqual(result.awaited.outcome, 'reached');
    assert.strictEqual(result.awaited.milestone, 'launch');
    assert.strictEqual(result.color, 'green');
  });

  test('reached outcome -> green', async () => {
    const supervisorClient = makeFakeSupervisorClient({
      getSprintSequence: [{
        sprintId: 'spr-1',
        live: true,
        terminal: false,
        state: { extensions: { plan: { approved: true, status: 'approved', planningRounds: 1 } } },
      }],
    });
    const deps = makeDeps({ supervisorClient });

    const result = await runLaunch({ request: makeRequest(), syntheticRootId: ROOT_ID, awaitUntil: 'plan-approved' }, deps);

    assert.strictEqual(result.awaited.outcome, 'reached');
    assert.strictEqual(result.color, 'green');
  });

  test('terminal-before-milestone outcome -> red, reason carried verbatim', async () => {
    const supervisorClient = makeFakeSupervisorClient({
      getSprintSequence: [{
        sprintId: 'spr-1',
        live: false,
        terminal: true,
        state: { terminalReason: 'engine crashed during plan' },
      }],
    });
    const deps = makeDeps({ supervisorClient });

    const result = await runLaunch({ request: makeRequest(), syntheticRootId: ROOT_ID, awaitUntil: 'plan-approved' }, deps);

    assert.strictEqual(result.awaited.outcome, 'terminal');
    assert.strictEqual(result.awaited.reason, 'engine crashed during plan');
    assert.strictEqual(result.color, 'red');
  });

  test('timeout outcome -> green, "now detached", and issues no stop', async () => {
    const supervisorClient = makeFakeSupervisorClient({
      getSprintSequence: [{ sprintId: 'spr-1', live: true, terminal: false, state: {} }],
    });
    const deps = makeDeps({ supervisorClient });

    const result = await runLaunch(
      { request: makeRequest(), syntheticRootId: ROOT_ID, awaitUntil: 'plan-approved', timeoutMs: 1 },
      deps
    );

    assert.strictEqual(result.awaited.outcome, 'timeout');
    assert.match(result.awaited.reason, /not reached, now detached/);
    assert.strictEqual(result.color, 'green');
    // deps carries no stop/cancel capability at all -- the fake supervisor
    // client's stopSprint() would throw if ever invoked, and nothing in
    // runLaunch ever calls it (there is no such call site to begin with).
  });
});
