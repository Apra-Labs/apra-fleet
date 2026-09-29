import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    createWatchdog,
    defaultHasTerminalState,
    formatFinishedDetail,
    defaultRecordFinished,
    WATCHDOG_STATUS,
} from '../src/supervisor/watchdog.mjs';
import { withTimestamps } from '../src/supervisor/log-timestamp.mjs';
import { HISTORY_EVENTS } from '../src/supervisor/history.mjs';
import { getOldRunsDir, getTerminalRunStatePath } from '@apralabs/apra-fleet-workflow/viewer/run-state-paths';

// apra-fleet-k7b.2 -- hasTerminalState() resolves by run-id (plus legacy
// branch-key fallback for pre-k7b.1 reservations), copying the engine's own
// terminalReason/extensions.terminal.verdict verbatim into the watchdog log
// line and sprint-history.json event instead of a generic message; every
// supervisor log line gains an ISO timestamp.

function fakeLedger(entries) {
    return { list: () => entries.map((e) => ({ ...e })) };
}

describe('apra-fleet-k7b.2: defaultHasTerminalState -- run-id first, legacy branch fallback', () => {
    let tmpDataDir;
    let env;
    beforeEach(() => {
        tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-k7b2-terminal-state-'));
        env = { APRA_FLEET_DATA_DIR: tmpDataDir };
    });
    afterEach(() => {
        fs.rmSync(tmpDataDir, { recursive: true, force: true });
    });

    test('resolves by run-id when old_runs/<runId>.json exists', () => {
        const runId = 'run-abc-123';
        const statePath = getTerminalRunStatePath(runId, env);
        fs.mkdirSync(path.dirname(statePath), { recursive: true });
        fs.writeFileSync(statePath, JSON.stringify({ terminalReason: 'SPRINT_STALLED' }));

        const state = defaultHasTerminalState(runId, 'feat/some-branch', env);
        assert.ok(state);
        assert.equal(state.terminalReason, 'SPRINT_STALLED');
    });

    test('falls back to the branch key when no terminal state exists under the run-id', () => {
        const runId = 'run-xyz-789'; // never written -- simulates a pre-k7b.1 mismatch
        const branch = 'feat/legacy-branch';
        const statePath = getTerminalRunStatePath(branch, env);
        fs.mkdirSync(path.dirname(statePath), { recursive: true });
        fs.writeFileSync(statePath, JSON.stringify({ terminalReason: 'DONE', extensions: { terminal: { verdict: 'approved' } } }));

        const state = defaultHasTerminalState(runId, branch, env);
        assert.ok(state);
        assert.equal(state.terminalReason, 'DONE');
        assert.equal(state.extensions.terminal.verdict, 'approved');
    });

    test('returns null when neither the run-id nor the branch has a terminal state', () => {
        const state = defaultHasTerminalState('run-missing', 'feat/also-missing', env);
        assert.equal(state, null);
    });

    test('returns null (never throws) when branch is null (no fallback key available)', () => {
        const state = defaultHasTerminalState('run-missing-2', null, env);
        assert.equal(state, null);
    });

    test('a run-id hit is preferred over a branch fallback, even when both exist', () => {
        const runId = 'run-both-exist';
        const branch = 'feat-both-exist'; // no '/' -- getOldRunsDir()/<key>.json is a flat file, not a subdir
        fs.mkdirSync(getOldRunsDir(env), { recursive: true });
        fs.writeFileSync(getTerminalRunStatePath(runId, env), JSON.stringify({ terminalReason: 'BY_RUN_ID' }));
        fs.writeFileSync(getTerminalRunStatePath(branch, env), JSON.stringify({ terminalReason: 'BY_BRANCH' }));

        const state = defaultHasTerminalState(runId, branch, env);
        assert.equal(state.terminalReason, 'BY_RUN_ID');
    });
});

describe('apra-fleet-k7b.2: formatFinishedDetail -- copies terminalReason/verdict verbatim', () => {
    test('both terminalReason and verdict present', () => {
        const detail = formatFinishedDetail({ terminalReason: 'SPRINT_STALLED', extensions: { terminal: { verdict: 'needs-changes' } } });
        assert.equal(detail, 'terminalReason=SPRINT_STALLED verdict=needs-changes');
    });

    test('only terminalReason present', () => {
        assert.equal(formatFinishedDetail({ terminalReason: 'DONE' }), 'terminalReason=DONE');
    });

    test('neither field present falls back to a bare "finished"', () => {
        assert.equal(formatFinishedDetail({}), 'finished');
        assert.equal(formatFinishedDetail(null), 'finished');
        assert.equal(formatFinishedDetail(true), 'finished'); // an injected boolean test double
    });
});

describe('apra-fleet-k7b.2: watchdog classifies FINISHED with engine terminalReason via classifySprint()', () => {
    let tmpDataDir;
    let env;
    beforeEach(() => {
        tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-k7b2-classify-'));
        env = { APRA_FLEET_DATA_DIR: tmpDataDir };
    });
    afterEach(() => {
        fs.rmSync(tmpDataDir, { recursive: true, force: true });
    });

    test('PID gone + terminal state found by branch fallback => FINISHED, with terminalState on the result', async () => {
        const sprintId = 'run-id-mismatch';
        const branch = 'feat/pre-runid-launch';
        const statePath = getTerminalRunStatePath(branch, env);
        fs.mkdirSync(path.dirname(statePath), { recursive: true });
        fs.writeFileSync(statePath, JSON.stringify({ terminalReason: 'SPRINT_STALLED' }));

        const wd = createWatchdog({
            ledger: fakeLedger([{ sprintId, childPid: 555, branch }]),
            isChildAlive: () => false,
            env,
            logger: { log() {}, error() {} },
        });
        const [r] = await wd.classifyAll();
        assert.equal(r.status, WATCHDOG_STATUS.FINISHED);
        assert.equal(r.terminalState.terminalReason, 'SPRINT_STALLED');
    });

    test('recordFinished fires exactly once for a sprint that stays FINISHED across repeated ticks', async () => {
        const sprintId = 's-finished';
        const calls = [];
        const wd = createWatchdog({
            ledger: fakeLedger([{ sprintId, childPid: 100 }]),
            isChildAlive: () => false,
            hasTerminalState: () => ({ terminalReason: 'DONE' }),
            recordFinished: (info) => calls.push(info),
            logger: { log() {}, error() {} },
        });

        await wd.classifyAll();
        await wd.classifyAll();
        await wd.classifyAll();

        assert.equal(calls.length, 1, 'a sprint that stays FINISHED across ticks must only be recorded once');
        assert.equal(calls[0].sprintId, sprintId);
        assert.equal(calls[0].state.terminalReason, 'DONE');
    });

    test('a recordFinished that throws is caught -- classification still completes and reports FINISHED', async () => {
        const wd = createWatchdog({
            ledger: fakeLedger([{ sprintId: 's1', childPid: 100 }]),
            isChildAlive: () => false,
            hasTerminalState: () => ({ terminalReason: 'DONE' }),
            recordFinished: () => { throw new Error('boom'); },
            logger: { log() {}, error() {} },
        });
        const [r] = await wd.classifyAll();
        assert.equal(r.status, WATCHDOG_STATUS.FINISHED);
    });
});

describe('apra-fleet-k7b.2: defaultRecordFinished -- real logger + optional history collaborator', () => {
    test('logs a FINISHED line copying terminalReason/verdict verbatim (not the generic CRASHED language)', () => {
        const logLines = [];
        defaultRecordFinished({
            sprintId: 'sprint-k7b2',
            state: { terminalReason: 'SPRINT_STALLED', extensions: { terminal: { verdict: 'needs-changes' } } },
            logger: { log: (...a) => logLines.push(a.join(' ')), error: (...a) => logLines.push(a.join(' ')) },
            history: null,
        });
        assert.equal(logLines.length, 1);
        assert.ok(logLines[0].includes('FINISHED'));
        assert.ok(logLines[0].includes('sprint-k7b2'));
        assert.ok(logLines[0].includes('terminalReason=SPRINT_STALLED'));
        assert.ok(logLines[0].includes('verdict=needs-changes'));
        assert.ok(!logLines[0].includes('classified CRASHED by the PID-liveness watchdog'));
    });

    test('appends a FINISHED event to the injected history collaborator with terminalReason/verdict', async () => {
        const recorded = [];
        const history = { record: async (entry) => { recorded.push(entry); return entry; } };
        defaultRecordFinished({
            sprintId: 'sprint-hist',
            state: { terminalReason: 'DONE', extensions: { terminal: { verdict: 'approved' } } },
            logger: { log() {}, error() {} },
            history,
        });
        // history.record() is fire-and-forget from defaultRecordFinished's
        // perspective; give its microtask a tick to run.
        await Promise.resolve();
        assert.equal(recorded.length, 1);
        assert.equal(recorded[0].sprintId, 'sprint-hist');
        assert.equal(recorded[0].event, HISTORY_EVENTS.FINISHED);
        assert.equal(recorded[0].terminalReason, 'DONE');
        assert.equal(recorded[0].verdict, 'approved');
    });

    test('missing history collaborator: still logs, never throws', () => {
        assert.doesNotThrow(() => {
            defaultRecordFinished({
                sprintId: 'sprint-no-history',
                state: { terminalReason: 'DONE' },
                logger: { log() {}, error() {} },
                history: undefined,
            });
        });
    });
});

describe('apra-fleet-k7b.2: withTimestamps -- ISO-timestamp-prefixed log lines', () => {
    test('prefixes an ISO-8601 timestamp ahead of the caller\'s own message, preserving the existing tag', () => {
        const calls = [];
        const wrapped = withTimestamps({ log: (...a) => calls.push(a) }, () => '2026-07-30T12:00:00.000Z');
        wrapped.log('[watchdog] hello', 'world');
        assert.equal(calls.length, 1);
        assert.equal(calls[0][0], '2026-07-30T12:00:00.000Z [watchdog] hello');
        assert.equal(calls[0][1], 'world');
    });

    test('a method absent on the source logger stays absent on the wrapped logger, matching every existing call site\'s own (logger.error ?? logger.log) fallback', () => {
        const wrapped = withTimestamps({ log: () => {} }, () => '2026-07-30T12:00:00.000Z');
        assert.equal(wrapped.warn, undefined);
        assert.equal(wrapped.error, undefined);
        // The existing call-site pattern (e.g. proxy.mjs's
        // `(logger.error ?? logger.log)?.(...)`) still resolves to the
        // TIMESTAMPED log function, since it falls back on the wrapped
        // object, not the raw one.
        assert.equal(typeof (wrapped.error ?? wrapped.log), 'function');
    });

    test('error and warn are timestamped exactly like log when present on the source logger', () => {
        const calls = [];
        const wrapped = withTimestamps(
            { log: (...a) => calls.push(['log', ...a]), error: (...a) => calls.push(['error', ...a]), warn: (...a) => calls.push(['warn', ...a]) },
            () => '2026-07-30T12:00:00.000Z',
        );
        wrapped.error('[proxy] oops');
        wrapped.warn('[readopt] heads up');
        assert.equal(calls.length, 2);
        assert.deepEqual(calls[0], ['error', '2026-07-30T12:00:00.000Z [proxy] oops']);
        assert.deepEqual(calls[1], ['warn', '2026-07-30T12:00:00.000Z [readopt] heads up']);
    });
});

// =============================================================================
// apra-fleet-i9ag.16.8 -- the post-launch-window failure regression
// =============================================================================
//
// Guards apra-fleet-i9ag.16.6's detection change. The final M1 acceptance run
// (Windows Sandbox, v0.5 binary 546286ca) launched a sprint that failed in its
// Plan phase and watched the supervisor present it as running-unresponsive for
// ~5 MINUTES: a fleet-sprint child keeps its per-sprint dashboard process alive
// 300s after the run ends, and the classifier only read the child's terminal
// state on its PID-gone path, so "the run is over" was inferred from process
// exit rather than from the child's own recorded ending.
//
// These tests drive the classifier with the two signals DELIBERATELY IN
// CONFLICT -- pid alive, terminal state present -- which is precisely the
// dashboard-linger window and a combination no pre-existing test in this
// package ever set up.
describe('apra-fleet-i9ag.16.8: a terminal state is observed while the child pid is still alive (300s dashboard linger)', () => {
    let tmpDataDir;
    let env;
    beforeEach(() => {
        tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-i9ag168-linger-'));
        env = { APRA_FLEET_DATA_DIR: tmpDataDir };
    });
    afterEach(() => {
        fs.rmSync(tmpDataDir, { recursive: true, force: true });
    });

    test('PID ALIVE + a real on-disk terminal state => FINISHED, not running-unresponsive -- without waiting for the child to exit', async () => {
        // The exact terminal state fleet-sprint's fatal-diagnostics guard
        // leaves behind for a Plan-phase failure (fleet-sprint/
        // fatal-diagnostics.mjs's publishState('terminal', ...)).
        const sprintId = 'i9ag168-linger-run';
        const statePath = getTerminalRunStatePath(sprintId, env);
        fs.mkdirSync(path.dirname(statePath), { recursive: true });
        fs.writeFileSync(statePath, JSON.stringify({
            terminalReason: 'uncaughtException',
            extensions: {
                terminal: {
                    verdict: 'ABORTED',
                    failed: true,
                    lastError: { message: 'claude: command not found', phase: 'Plan' },
                },
            },
        }));

        const wd = createWatchdog({
            ledger: fakeLedger([{ sprintId, childPid: 4242, branch: 'feat/i9ag168' }]),
            // The child process is STILL RUNNING -- it is serving its
            // post-terminal dashboard. This is the whole point of the case.
            isChildAlive: () => true,
            resolvePort: () => 9100,
            // ...and its HTTP is silent, which is what used to make this
            // running-unresponsive for the rest of the linger window.
            probeHttp: () => false,
            env,
            logger: { log() {}, error() {} },
        });

        const [r] = await wd.classifyAll();
        assert.equal(r.status, WATCHDOG_STATUS.FINISHED, 'a run whose own terminal state is on disk must never still be presented as running');
        assert.notEqual(r.status, WATCHDOG_STATUS.RUNNING_UNRESPONSIVE);
        // Reported as observed, not assumed: the pid really is alive.
        assert.equal(r.pidAlive, true, 'the classification must report the pid truthfully, not pretend the process is gone');
        assert.equal(r.terminalState.extensions.terminal.verdict, 'ABORTED');
        // The detail must not claim an exit that has not happened.
        assert.ok(!/pid gone/.test(r.detail), r.detail);
        assert.match(r.detail, /still alive/);
    });

    test('INVARIANT INTACT: PID alive + HTTP silent + NO terminal state is STILL running-unresponsive and never auto-declared crashed, across repeated ticks', async () => {
        // apra-fleet-i9ag.16.6 acceptance criterion 2 -- pinned so the
        // detection fix above can never be re-implemented by weakening the
        // liveness classifier into calling a wedged child dead.
        const crashRecords = [];
        const wd = createWatchdog({
            ledger: fakeLedger([{ sprintId: 'i9ag168-wedged', childPid: 4243, branch: 'feat/wedged' }]),
            isChildAlive: () => true,
            resolvePort: () => 9101,
            probeHttp: () => false,
            hasTerminalState: () => null,
            recordTerminalError: (info) => crashRecords.push(info),
            env,
            logger: { log() {}, error() {} },
        });

        for (let i = 0; i < 3; i += 1) {
            const [r] = await wd.classifyAll();
            assert.equal(r.status, WATCHDOG_STATUS.RUNNING_UNRESPONSIVE, 'a wedged-but-live child with no terminal state of its own stays an operator-attention signal');
            assert.notEqual(r.status, WATCHDOG_STATUS.CRASHED);
            assert.notEqual(r.status, WATCHDOG_STATUS.FINISHED);
        }
        assert.equal(crashRecords.length, 0, 'an unresponsive child must never be routed through the CRASHED terminal-error recorder');
    });

    test('a still-alive FINISHED run records its ending exactly once and releases its reservation, same as a PID-gone one', async () => {
        const released = [];
        const finishes = [];
        const wd = createWatchdog({
            ledger: {
                list: () => [{ sprintId: 'i9ag168-release', childPid: 4244, branch: 'feat/release' }],
                release: async (id) => { released.push(id); return true; },
            },
            isChildAlive: () => true,
            resolvePort: () => 9102,
            probeHttp: () => true, // even a still-ANSWERING lingering dashboard
            hasTerminalState: () => ({ terminalReason: 'DONE' }),
            recordFinished: (info) => finishes.push(info),
            env,
            logger: { log() {}, error() {} },
        });

        await wd.classifyAll();
        await wd.classifyAll();

        assert.equal(finishes.length, 1, 'the FINISHED recorder fires once per sprint, not once per tick');
        assert.ok(released.includes('i9ag168-release'), 'a finished run must not keep holding its member/scope reservation for the whole linger window');
    });

    test('a healthy run is unaffected: pid alive, HTTP answering, no terminal state => running-healthy', async () => {
        const wd = createWatchdog({
            ledger: fakeLedger([{ sprintId: 'i9ag168-healthy', childPid: 4245, branch: 'feat/healthy' }]),
            isChildAlive: () => true,
            resolvePort: () => 9103,
            probeHttp: () => true,
            probePauseState: () => null,
            hasTerminalState: () => null,
            env,
            logger: { log() {}, error() {} },
        });
        const [r] = await wd.classifyAll();
        assert.equal(r.status, WATCHDOG_STATUS.RUNNING_HEALTHY);
    });
});
