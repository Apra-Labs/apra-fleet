// Tests for src/verbs/status.mjs -- fake supervisorClient throughout; no
// real network, no real clock (deps.now is an injected fake).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { assertThrows } from './helpers.mjs';

import { runStatus, validateStatusOpts } from '../src/verbs/status.mjs';
import { buildFallbackSnapshot, classifyTerminalLog, buildTerminalFromEvidence } from '../src/snapshot.mjs';
import { BridgeError, BRIDGE_ERROR_CODES } from '../src/errors.mjs';

// A trimmed but faithful reproduction of the real failed sprint's log tail
// this task's brief points at (C:\Users\runner\.apra-fleet-se\logs\
// ado_toy-e3z-1fbb61f0-5d7c-493a-b8a9-f5dfa86a0367.log) -- the two lines
// that matter (the "Sprint failed:" marker and the stack-trace boundary
// right after it) reproduced verbatim, everything else trimmed.
const REAL_FAILURE_LOG_TAIL = [
  'Plan C1 R1',
  "Sprint failed: GitSyncError: [Sync] G-pull fetch failed for member 'aztoy': [Command Failed] Exit code 128: Exit code: 128",
  '[stderr]',
  "fatal: Authentication failed for 'https://dev.azure.com/apralabs/e2e-fleet-testing/_git/fleet-e2e-toy/'",
  '',
  '    at syncMemberBefore (file:///C:/Users/runner/.apra-fleet/workflows/fleet-sprint/fleet-sprint/member-sync.mjs:143:15) {',
  "  code: 'GIT_SYNC_FAILED',",
  '}',
  'Sprint FAILED. Dashboard remains live at http://localhost:8081 for 300s so you can inspect the final state -- press Ctrl-C to exit sooner.',
].join('\n');

const REAL_SUCCESS_LOG_TAIL = [
  'Plan C1 R1',
  'Sprint finished: { verdict: \'DONE\' }',
].join('\n');

// ---------------------------------------------------------------------------
// Fixtures and fakes
// ---------------------------------------------------------------------------

function liveSprint(overrides = {}) {
  return {
    sprintId: 'spr-1',
    live: true,
    terminal: false,
    state: {
      tree: [{
        title: 'group',
        phases: [{ title: 'Develop C1 R1', phaseStartedAt: '2026-09-01T00:00:00.000Z', phaseEndedAt: null }],
      }],
      updatedAt: '2026-09-01T00:05:00.000Z',
    },
    history: null,
    latest: null,
    ...overrides,
  };
}

/** A fake supervisor client. `getSprintResult` is returned as-is by
 * getSprint(); `getLogResult` is returned by getLog() unless it is an
 * Error, in which case getLog() throws it. */
function makeFakeSupervisorClient({ getSprintResult = null, getLogResult = null } = {}) {
  const getSprintCalls = [];
  const getLogCalls = [];
  return {
    getSprintCalls,
    getLogCalls,
    async getSprint(sprintId) {
      getSprintCalls.push(sprintId);
      return getSprintResult;
    },
    async getLog(sprintId, opts) {
      getLogCalls.push({ sprintId, opts });
      if (getLogResult instanceof Error) throw getLogResult;
      return getLogResult;
    },
  };
}

function makeDeps(overrides = {}) {
  let clock = overrides.startClock ?? 1_700_000_000_000;
  const deps = {
    supervisorClient: overrides.supervisorClient ?? makeFakeSupervisorClient(),
    now: overrides.now ?? (() => clock++),
    log: overrides.log ?? (() => {}),
  };
  if (overrides.spool !== undefined) deps.spool = overrides.spool;
  if (overrides.fs !== undefined) deps.fs = overrides.fs;
  return deps;
}

/** A fake spool exposing only `.read()` -- the one method status.mjs is
 * ever allowed to call on it (module header: "spool is read-only here"). */
function makeFakeSpool({ doc = undefined } = {}) {
  const readCalls = [];
  return {
    readCalls,
    async read(sprintId) {
      readCalls.push(sprintId);
      return doc;
    },
  };
}

/** A fake `fs` exposing only `.readFile()`. `fileText` may be a string, an
 * Error (thrown), or undefined (ENOENT-shaped rejection). */
function makeFakeFs({ fileText } = {}) {
  const readFileCalls = [];
  return {
    readFileCalls,
    async readFile(path, encoding) {
      readFileCalls.push({ path, encoding });
      if (fileText instanceof Error) throw fileText;
      if (fileText === undefined) {
        const err = new Error(`ENOENT: no such file, open '${path}'`);
        err.code = 'ENOENT';
        throw err;
      }
      return fileText;
    },
  };
}

// ---------------------------------------------------------------------------
// validateStatusOpts
// ---------------------------------------------------------------------------

describe('validateStatusOpts', () => {
  test('throws CONFIG_MISSING when sprintId is missing', () => {
    const err = assertThrows(() => validateStatusOpts({}));
    assert.ok(err instanceof BridgeError);
    assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
  });

  test('throws CONFIG_INVALID for a non-positive logTailLines', () => {
    const err = assertThrows(() => validateStatusOpts({ sprintId: 'spr-1', logTailLines: 0 }));
    assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
  });

  test('throws CONFIG_INVALID for a non-integer logTailLines', () => {
    const err = assertThrows(() => validateStatusOpts({ sprintId: 'spr-1', logTailLines: 1.5 }));
    assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
  });

  test('defaults logTailLines when absent', () => {
    const validated = validateStatusOpts({ sprintId: 'spr-1' });
    assert.strictEqual(validated.sprintId, 'spr-1');
    assert.ok(Number.isInteger(validated.logTailLines) && validated.logTailLines > 0);
  });
});

// ---------------------------------------------------------------------------
// buildFallbackSnapshot
// ---------------------------------------------------------------------------

describe('buildFallbackSnapshot', () => {
  test('carries health: unknown and the raw logTail', () => {
    const snapshot = buildFallbackSnapshot('spr-1', 'line one\nline two', 12345);
    assert.strictEqual(snapshot.sprintId, 'spr-1');
    assert.strictEqual(snapshot.health, 'unknown');
    assert.strictEqual(snapshot.logTail, 'line one\nline two');
    assert.strictEqual(snapshot.updatedAt, 12345);
  });

  test('a null logTail is preserved as null, not coerced away', () => {
    const snapshot = buildFallbackSnapshot('spr-1', null, 1);
    assert.strictEqual(snapshot.logTail, null);
  });

  test('is frozen', () => {
    const snapshot = buildFallbackSnapshot('spr-1', 'text', 1);
    assert.ok(Object.isFrozen(snapshot));
  });
});

// ---------------------------------------------------------------------------
// runStatus
// ---------------------------------------------------------------------------

describe('runStatus', () => {
  test('renders a ProgressSnapshot from a live sprint via toProgressSnapshot', async () => {
    const supervisorClient = makeFakeSupervisorClient({ getSprintResult: liveSprint() });
    const deps = makeDeps({ supervisorClient });

    const snapshot = await runStatus({ sprintId: 'spr-1' }, deps);

    assert.strictEqual(snapshot.sprintId, 'spr-1');
    assert.strictEqual(snapshot.phase, 'Develop C1 R1');
    assert.strictEqual(snapshot.health, 'running');
    assert.strictEqual(supervisorClient.getLogCalls.length, 0);
  });

  test('falls back to the log tail with health: unknown when getSprint finds nothing but getLog answers', async () => {
    const supervisorClient = makeFakeSupervisorClient({ getSprintResult: null, getLogResult: 'raw log text' });
    const deps = makeDeps({ supervisorClient });

    const snapshot = await runStatus({ sprintId: 'spr-1', logTailLines: 50 }, deps);

    assert.strictEqual(snapshot.health, 'unknown');
    assert.strictEqual(snapshot.logTail, 'raw log text');
    assert.strictEqual(supervisorClient.getLogCalls.length, 1);
    assert.strictEqual(supervisorClient.getLogCalls[0].sprintId, 'spr-1');
    assert.strictEqual(supervisorClient.getLogCalls[0].opts.tail, 50);
  });

  test('a 404 (getSprint null, getLog also null) returns null, not a throw', async () => {
    const supervisorClient = makeFakeSupervisorClient({ getSprintResult: null, getLogResult: null });
    const deps = makeDeps({ supervisorClient });

    const result = await runStatus({ sprintId: 'spr-1' }, deps);
    assert.strictEqual(result, null);
  });

  test('a genuine getLog failure propagates rather than collapsing to null', async () => {
    const failure = new BridgeError(BRIDGE_ERROR_CODES.SUPERVISOR_UNAVAILABLE, 'could not reach supervisor');
    const supervisorClient = makeFakeSupervisorClient({ getSprintResult: null, getLogResult: failure });
    const deps = makeDeps({ supervisorClient });

    await assert.rejects(
      () => runStatus({ sprintId: 'spr-1' }, deps),
      (err) => {
        assert.ok(err instanceof BridgeError);
        assert.strictEqual(err.code, BRIDGE_ERROR_CODES.SUPERVISOR_UNAVAILABLE);
        assert.strictEqual(err, failure);
        return true;
      }
    );
  });

  // The actual live incident this task's brief points at: getSprint()
  // answers 200 (never null) with the third normalised shape -- no `state`,
  // just `history`/`latest` -- once the supervisor's ledger has released the
  // sprint but its durable history log still remembers it. This must be
  // handled on the FIRST read, via toProgressSnapshot() below, and must
  // never fall through to the getLog()/spool fallback chain at all (that
  // chain only ever runs when getSprint() itself returns null).
  test('a released-but-remembered sprint (getSprint 200, history-only shape) reports terminal via toProgressSnapshot, not the fallback chain', async () => {
    const finishedEvent = {
      event: 'finished', terminalReason: "[Sync] G-pull fetch failed for member 'aztoy': fatal: Authentication failed", verdict: 'ABORTED', at: '2026-09-21T03:24:50.020Z',
    };
    const childExitedEvent = {
      event: 'child-exited', exitCode: 1, logPath: 'C:\\Users\\runner\\.apra-fleet-se\\logs\\spr-1.log', at: '2026-09-21T03:24:49.597Z',
    };
    const autoReleasedEvent = { event: 'auto-released', reason: 'watchdog: classified finished', at: '2026-09-21T03:24:50.022Z' };
    const supervisorClient = makeFakeSupervisorClient({
      getSprintResult: {
        sprintId: 'spr-1', live: false, terminal: false, state: null,
        history: [childExitedEvent, finishedEvent, autoReleasedEvent],
        latest: autoReleasedEvent,
      },
    });
    const deps = makeDeps({ supervisorClient });

    const snapshot = await runStatus({ sprintId: 'spr-1' }, deps);

    assert.strictEqual(snapshot.health, 'terminal');
    assert.strictEqual(snapshot.verdict, 'ABORTED');
    assert.strictEqual(snapshot.reason, finishedEvent.terminalReason);
    assert.strictEqual(snapshot.exitCode, 1);
    assert.strictEqual(snapshot.logPath, childExitedEvent.logPath);
    // The fallback chain must never have been consulted -- getSprint()
    // already answered with everything needed.
    assert.strictEqual(supervisorClient.getLogCalls.length, 0);
  });

  test('makes no writes -- works with no spool/fs capability wired in at all', async () => {
    const supervisorClient = makeFakeSupervisorClient({ getSprintResult: liveSprint() });
    const deps = makeDeps({ supervisorClient });

    await runStatus({ sprintId: 'spr-1' }, deps);

    // spool/fs are OPTIONAL collaborators (module header) -- this caller
    // never supplied either, and runStatus must not mutate the caller's own
    // deps object to add them (or anything else) as a side effect.
    assert.deepStrictEqual(Object.keys(deps).sort(), ['log', 'now', 'supervisorClient'].sort());
  });
});

// ---------------------------------------------------------------------------
// classifyTerminalLog
// ---------------------------------------------------------------------------

describe('classifyTerminalLog', () => {
  test('recognizes the real failed-sprint fixture and quotes the reason verbatim, stopping before the stack trace', () => {
    const result = classifyTerminalLog(REAL_FAILURE_LOG_TAIL);
    assert.strictEqual(result.outcome, 'failed');
    assert.strictEqual(
      result.reason,
      "GitSyncError: [Sync] G-pull fetch failed for member 'aztoy': [Command Failed] Exit code 128: Exit code: 128\n"
      + '[stderr]\n'
      + "fatal: Authentication failed for 'https://dev.azure.com/apralabs/e2e-fleet-testing/_git/fleet-e2e-toy/'"
    );
    // Never reworded: the reason is a literal substring of the input.
    assert.ok(REAL_FAILURE_LOG_TAIL.includes(result.reason));
    // The stack trace itself must not leak into the "verbatim reason".
    assert.ok(!result.reason.includes('syncMemberBefore'));
  });

  test('recognizes a clean completion, with no reason to report', () => {
    const result = classifyTerminalLog(REAL_SUCCESS_LOG_TAIL);
    assert.deepStrictEqual(result, { outcome: 'completed', reason: null });
  });

  test('neither marker present -> null (log is not decisive)', () => {
    assert.strictEqual(classifyTerminalLog('Plan C1 R1\nDevelop C1 R1\n'), null);
  });

  test('null/undefined/empty input -> null, never throws', () => {
    assert.strictEqual(classifyTerminalLog(null), null);
    assert.strictEqual(classifyTerminalLog(undefined), null);
    assert.strictEqual(classifyTerminalLog(''), null);
  });

  test('a failure with no text after the marker still reports outcome:failed with reason:null, never a blank string', () => {
    const result = classifyTerminalLog('Sprint failed:');
    assert.strictEqual(result.outcome, 'failed');
    assert.strictEqual(result.reason, null);
  });
});

// ---------------------------------------------------------------------------
// buildTerminalFromEvidence
// ---------------------------------------------------------------------------

describe('buildTerminalFromEvidence', () => {
  test('a failed outcome carries health:terminal, cycle:null, and the verbatim reason', () => {
    const snapshot = buildTerminalFromEvidence('spr-1', { outcome: 'failed', reason: 'GitSyncError: boom', updatedAt: 999 });
    assert.strictEqual(snapshot.sprintId, 'spr-1');
    assert.strictEqual(snapshot.health, 'terminal');
    assert.strictEqual(snapshot.cycle, null);
    assert.strictEqual(snapshot.verdict, 'failed');
    assert.strictEqual(snapshot.reason, 'GitSyncError: boom');
    assert.strictEqual(snapshot.updatedAt, 999);
    assert.ok(Object.isFrozen(snapshot));
  });

  test('a completed outcome carries reason:null -- there is nothing to explain', () => {
    const snapshot = buildTerminalFromEvidence('spr-1', { outcome: 'completed', updatedAt: 1 });
    assert.strictEqual(snapshot.health, 'terminal');
    assert.strictEqual(snapshot.verdict, 'completed');
    assert.strictEqual(snapshot.reason, null);
  });

  test('never invents numeric progress: cycle is null, spendUsd is absent, not 0/undefined-as-string', () => {
    const snapshot = buildTerminalFromEvidence('spr-1', { outcome: 'failed', reason: 'x', updatedAt: 1 });
    assert.strictEqual(snapshot.cycle, null);
    assert.strictEqual(snapshot.spendUsd, undefined);
    // No field anywhere renders the literal string "undefined".
    for (const value of Object.values(snapshot)) {
      assert.notStrictEqual(value, 'undefined');
    }
  });
});

// ---------------------------------------------------------------------------
// runStatus -- the spool/log-file fallback chain (the incident fix)
// ---------------------------------------------------------------------------

describe('runStatus: detached-sprint fallback chain', () => {
  test('log tail reachable via the supervisor and shows a failure -> terminal/failed with the verbatim reason, not unknown', async () => {
    const supervisorClient = makeFakeSupervisorClient({ getSprintResult: null, getLogResult: REAL_FAILURE_LOG_TAIL });
    const deps = makeDeps({ supervisorClient });

    const snapshot = await runStatus({ sprintId: 'spr-1' }, deps);

    assert.strictEqual(snapshot.health, 'terminal');
    assert.strictEqual(snapshot.verdict, 'failed');
    assert.ok(snapshot.reason.startsWith('GitSyncError:'));
    assert.strictEqual(snapshot.cycle, null);
  });

  test('log tail reachable via the supervisor and shows a clean completion -> terminal/completed, not failed', async () => {
    const supervisorClient = makeFakeSupervisorClient({ getSprintResult: null, getLogResult: REAL_SUCCESS_LOG_TAIL });
    const deps = makeDeps({ supervisorClient });

    const snapshot = await runStatus({ sprintId: 'spr-1' }, deps);

    assert.strictEqual(snapshot.health, 'terminal');
    assert.strictEqual(snapshot.verdict, 'completed');
    assert.strictEqual(snapshot.reason, null);
  });

  test('supervisor forgot the sprint entirely (getSprint AND getLog both null), no spool injected -> null, unchanged', async () => {
    const supervisorClient = makeFakeSupervisorClient({ getSprintResult: null, getLogResult: null });
    const deps = makeDeps({ supervisorClient });

    const result = await runStatus({ sprintId: 'spr-1' }, deps);
    assert.strictEqual(result, null);
  });

  test('supervisor forgot the sprint, spool has no handle either -> still null (genuinely unknown, never a guess)', async () => {
    const supervisorClient = makeFakeSupervisorClient({ getSprintResult: null, getLogResult: null });
    const spool = makeFakeSpool({ doc: undefined });
    const deps = makeDeps({ supervisorClient, spool });

    const result = await runStatus({ sprintId: 'spr-1' }, deps);
    assert.strictEqual(result, null);
    assert.deepStrictEqual(spool.readCalls, ['spr-1']);
  });

  test('supervisor forgot the sprint, but the spool already recorded a failed finalize -> terminal/failed with the recorded reason verbatim', async () => {
    const supervisorClient = makeFakeSupervisorClient({ getSprintResult: null, getLogResult: null });
    const spool = makeFakeSpool({
      doc: {
        handle: { sprintId: 'spr-1', logPath: 'C:\\logs\\spr-1.log' },
        finalize: { outcome: 'failed', error: { message: 'watch: supervisor has been unreachable for sprint "spr-1"', code: 'WATCH_LOST' } },
      },
    });
    const deps = makeDeps({ supervisorClient, spool });

    const snapshot = await runStatus({ sprintId: 'spr-1' }, deps);

    assert.strictEqual(snapshot.health, 'terminal');
    assert.strictEqual(snapshot.verdict, 'failed');
    assert.strictEqual(snapshot.reason, 'watch: supervisor has been unreachable for sprint "spr-1"');
  });

  test('supervisor forgot the sprint, spool recorded a completed finalize -> terminal/completed', async () => {
    const supervisorClient = makeFakeSupervisorClient({ getSprintResult: null, getLogResult: null });
    const spool = makeFakeSpool({
      doc: { handle: { sprintId: 'spr-1' }, finalize: { outcome: 'completed', result: { verdict: 'DONE' } } },
    });
    const deps = makeDeps({ supervisorClient, spool });

    const snapshot = await runStatus({ sprintId: 'spr-1' }, deps);

    assert.strictEqual(snapshot.health, 'terminal');
    assert.strictEqual(snapshot.verdict, 'completed');
    assert.strictEqual(snapshot.reason, null);
  });

  test('supervisor forgot the sprint, spool has a handle but no recorded finalize -- reads the log FILE at handle.logPath directly and finds a failure', async () => {
    const supervisorClient = makeFakeSupervisorClient({ getSprintResult: null, getLogResult: null });
    const spool = makeFakeSpool({
      doc: { handle: { sprintId: 'spr-1', logPath: 'C:\\logs\\spr-1.log' }, finalize: null },
    });
    const fs = makeFakeFs({ fileText: REAL_FAILURE_LOG_TAIL });
    const deps = makeDeps({ supervisorClient, spool, fs });

    const snapshot = await runStatus({ sprintId: 'spr-1' }, deps);

    assert.strictEqual(snapshot.health, 'terminal');
    assert.strictEqual(snapshot.verdict, 'failed');
    assert.ok(snapshot.reason.startsWith('GitSyncError:'));
    assert.deepStrictEqual(fs.readFileCalls, [{ path: 'C:\\logs\\spr-1.log', encoding: 'utf-8' }]);
  });

  test('handle identified via the spool, but the log file no longer exists (ENOENT) -- degrades to identified-only, health:unknown, never blank null', async () => {
    const supervisorClient = makeFakeSupervisorClient({ getSprintResult: null, getLogResult: null });
    const spool = makeFakeSpool({
      doc: { handle: { sprintId: 'spr-1', logPath: 'C:\\logs\\gone.log' }, finalize: null },
    });
    const fs = makeFakeFs({ fileText: undefined }); // ENOENT
    const deps = makeDeps({ supervisorClient, spool, fs });

    const snapshot = await runStatus({ sprintId: 'spr-1' }, deps);

    assert.notStrictEqual(snapshot, null);
    assert.strictEqual(snapshot.sprintId, 'spr-1');
    assert.strictEqual(snapshot.health, 'unknown');
  });

  test('handle identified via the spool, no logPath and no fs injected -- still identified, health:unknown, never blank null', async () => {
    const supervisorClient = makeFakeSupervisorClient({ getSprintResult: null, getLogResult: null });
    const spool = makeFakeSpool({
      doc: { handle: { sprintId: 'spr-1' }, finalize: null },
    });
    const deps = makeDeps({ supervisorClient, spool });

    const snapshot = await runStatus({ sprintId: 'spr-1' }, deps);

    assert.notStrictEqual(snapshot, null);
    assert.strictEqual(snapshot.sprintId, 'spr-1');
    assert.strictEqual(snapshot.health, 'unknown');
  });

  test('no field anywhere renders the literal string "undefined", across every fallback branch', async () => {
    const scenarios = [
      makeDeps({ supervisorClient: makeFakeSupervisorClient({ getSprintResult: null, getLogResult: REAL_FAILURE_LOG_TAIL }) }),
      makeDeps({
        supervisorClient: makeFakeSupervisorClient({ getSprintResult: null, getLogResult: null }),
        spool: makeFakeSpool({ doc: { handle: { sprintId: 'spr-1' }, finalize: null } }),
      }),
    ];
    for (const deps of scenarios) {
      // eslint-disable-next-line no-await-in-loop
      const snapshot = await runStatus({ sprintId: 'spr-1' }, deps);
      if (!snapshot) continue;
      for (const value of Object.values(snapshot)) {
        assert.notStrictEqual(value, 'undefined');
      }
    }
  });
});
