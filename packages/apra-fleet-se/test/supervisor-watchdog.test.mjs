import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    createWatchdog,
    makeChildPidProbe,
    probeChildHttp,
    probeChildPauseStatus,
    defaultRecordTerminalError,
    formatExitDetail,
    WATCHDOG_STATUS,
    WATCHDOG_DEFAULT_INTERVAL_MS,
} from '../src/supervisor/watchdog.mjs';
import { getRunningRunStatePath } from '@apralabs/apra-fleet-workflow/viewer/run-state-paths';

// apra-fleet-eft.4.3 -- PID-liveness watchdog + four-status classifier.
// running-healthy / running-unresponsive / crashed / finished.

/**
 * Minimal fake ledger exposing just list() -- the only method the watchdog
 * consumes. Each entry is { sprintId, childPid }.
 */
function fakeLedger(entries) {
    return { list: () => entries.map((e) => ({ ...e })) };
}

/** Build a watchdog whose signals are fully injected/deterministic. */
function makeWatchdog(entries, signals = {}) {
    return createWatchdog({
        ledger: fakeLedger(entries),
        resolvePort: signals.resolvePort ?? ((id) => (signals.ports ?? {})[id]),
        isChildAlive: signals.isChildAlive
            ?? ((pid) => (signals.alivePids ?? new Set()).has(pid)),
        probeHttp: signals.probeHttp
            ?? ((port) => (signals.httpOkPorts ?? new Set()).has(port)),
        // (apra-fleet-p2to.3.1) Deterministic no-op default ('never paused')
        // so every PRE-EXISTING test in this file (none of which injects a
        // pause signal) keeps classifying purely on PID+HTTP, exactly as
        // before this probe existed -- without this, the real default
        // (probeChildPauseStatus) would fire an actual network request
        // against every fake httpOk port in the suite.
        probePauseState: signals.probePauseState ?? (() => null),
        hasTerminalState: signals.hasTerminalState
            ?? ((id) => (signals.terminalSprints ?? new Set()).has(id)),
        // Default to a no-op recorder so tests that are not specifically
        // exercising apra-fleet-eft.20.3's CRASHED-recording behavior never
        // incidentally touch the real filesystem/logger just by classifying
        // a sprint as crashed.
        recordTerminalError: signals.recordTerminalError ?? (() => {}),
        env: signals.env,
        logger: signals.logger,
        intervalMs: signals.intervalMs,
        setIntervalFn: signals.setIntervalFn,
        clearIntervalFn: signals.clearIntervalFn,
    });
}

describe('watchdog -- four-status classifier', () => {
    test('PID alive + HTTP answering => running-healthy', async () => {
        const wd = makeWatchdog(
            [{ sprintId: 's1', childPid: 100 }],
            { ports: { s1: 9000 }, alivePids: new Set([100]), httpOkPorts: new Set([9000]) },
        );
        const [r] = await wd.classifyAll();
        assert.equal(r.status, WATCHDOG_STATUS.RUNNING_HEALTHY);
        assert.equal(r.pidAlive, true);
        assert.equal(r.httpOk, true);
    });

    test('PID alive + HTTP silent => running-unresponsive (never crashed, never killed)', async () => {
        const wd = makeWatchdog(
            [{ sprintId: 's1', childPid: 100 }],
            { ports: { s1: 9000 }, alivePids: new Set([100]), httpOkPorts: new Set() },
        );
        const [r] = await wd.classifyAll();
        assert.equal(r.status, WATCHDOG_STATUS.RUNNING_UNRESPONSIVE);
        assert.equal(r.pidAlive, true);
        assert.equal(r.httpOk, false);
        // Must NOT be classified crashed.
        assert.notEqual(r.status, WATCHDOG_STATUS.CRASHED);
    });

    test('PID gone + terminal state in old_sprints/ => finished', async () => {
        const wd = makeWatchdog(
            [{ sprintId: 's1', childPid: 100 }],
            { ports: { s1: 9000 }, alivePids: new Set(), terminalSprints: new Set(['s1']) },
        );
        const [r] = await wd.classifyAll();
        assert.equal(r.status, WATCHDOG_STATUS.FINISHED);
        assert.equal(r.pidAlive, false);
    });

    test('PID gone + NO terminal state => crashed', async () => {
        const wd = makeWatchdog(
            [{ sprintId: 's1', childPid: 100 }],
            { ports: { s1: 9000 }, alivePids: new Set(), terminalSprints: new Set() },
        );
        const [r] = await wd.classifyAll();
        assert.equal(r.status, WATCHDOG_STATUS.CRASHED);
        assert.equal(r.pidAlive, false);
    });

    // apra-fleet-k7b.3: classifySprint()'s returned `detail` reports the
    // exit info the ledger recorded (spawner.mjs's onChildExit -> bin/
    // serve.mjs's ledger.recordExit() wiring), not just a bare "pid gone".
    describe('apra-fleet-k7b.3: PID-gone detail reports the ledger-recorded exit code/signal/time', () => {
        test('classifySprint() reports "pid gone" when the ledger entry carries no exit info', async () => {
            const wd = makeWatchdog(
                [{ sprintId: 's1', childPid: 100 }],
                { ports: { s1: 9000 }, alivePids: new Set(), terminalSprints: new Set() },
            );
            const [r] = await wd.classifyAll();
            assert.equal(r.detail, 'pid gone');
        });

        test('classifySprint() reports "exited <code> at <time>" when the ledger entry carries a recorded exit', async () => {
            const wd = makeWatchdog(
                [{ sprintId: 's1', childPid: 100, exitCode: 1, signal: null, exitedAt: '2026-07-30T21:25:50.000Z' }],
                { ports: { s1: 9000 }, alivePids: new Set(), terminalSprints: new Set() },
            );
            const [r] = await wd.classifyAll();
            assert.equal(r.detail, 'exited 1 at 2026-07-30T21:25:50.000Z');
        });

        test('classifySprint() reports "killed by signal <signal> at <time>" for a null exitCode with a signal', async () => {
            const wd = makeWatchdog(
                [{ sprintId: 's1', childPid: 100, exitCode: null, signal: 'SIGKILL', exitedAt: '2026-07-30T21:30:00.000Z' }],
                { ports: { s1: 9000 }, alivePids: new Set(), terminalSprints: new Set() },
            );
            const [r] = await wd.classifyAll();
            assert.equal(r.detail, 'killed by signal SIGKILL at 2026-07-30T21:30:00.000Z');
        });

        test('a recorded exit is also reported for a FINISHED (not just CRASHED) sprint', async () => {
            const wd = makeWatchdog(
                [{ sprintId: 's1', childPid: 100, exitCode: 0, signal: null, exitedAt: '2026-07-30T21:40:00.000Z' }],
                { ports: { s1: 9000 }, alivePids: new Set(), terminalSprints: new Set(['s1']) },
            );
            const [r] = await wd.classifyAll();
            assert.equal(r.status, WATCHDOG_STATUS.FINISHED);
            assert.equal(r.detail, 'exited 0 at 2026-07-30T21:40:00.000Z');
        });

        test('the CRASHED terminal-error recorder receives the same detail string', async () => {
            const calls = [];
            const wd = makeWatchdog(
                [{ sprintId: 's1', childPid: 100, exitCode: 137, signal: null, exitedAt: '2026-07-30T21:50:00.000Z' }],
                {
                    ports: { s1: 9000 }, alivePids: new Set(), terminalSprints: new Set(),
                    recordTerminalError: (info) => calls.push(info),
                },
            );
            await wd.classifyAll();
            assert.equal(calls.length, 1);
            assert.equal(calls[0].detail, 'exited 137 at 2026-07-30T21:50:00.000Z');
        });
    });

    test('every classification is exactly one of the four documented statuses', async () => {
        const four = new Set(Object.values(WATCHDOG_STATUS));
        const wd = makeWatchdog(
            [
                { sprintId: 'healthy', childPid: 1 },
                { sprintId: 'hung', childPid: 2 },
                { sprintId: 'gone-finished', childPid: 3 },
                { sprintId: 'gone-crashed', childPid: 4 },
                { sprintId: 'null-pid', childPid: null },
            ],
            {
                ports: { healthy: 9001, hung: 9002, 'gone-finished': 9003, 'gone-crashed': 9004 },
                alivePids: new Set([1, 2]),
                httpOkPorts: new Set([9001]),
                terminalSprints: new Set(['gone-finished']),
            },
        );
        const results = await wd.classifyAll();
        assert.equal(results.length, 5);
        for (const r of results) {
            assert.ok(four.has(r.status), `status ${r.status} must be one of the four`);
        }
        const byId = Object.fromEntries(results.map((r) => [r.sprintId, r.status]));
        assert.equal(byId.healthy, WATCHDOG_STATUS.RUNNING_HEALTHY);
        assert.equal(byId.hung, WATCHDOG_STATUS.RUNNING_UNRESPONSIVE);
        assert.equal(byId['gone-finished'], WATCHDOG_STATUS.FINISHED);
        assert.equal(byId['gone-crashed'], WATCHDOG_STATUS.CRASHED);
        // A null childPid is not probeable -> PID-gone; no terminal state -> crashed.
        assert.equal(byId['null-pid'], WATCHDOG_STATUS.CRASHED);
    });

    test('unknown port: PID alive but not reachable => running-unresponsive (not crashed)', async () => {
        const wd = makeWatchdog(
            [{ sprintId: 's1', childPid: 100 }],
            { ports: {}, alivePids: new Set([100]) },
        );
        const [r] = await wd.classifyAll();
        assert.equal(r.status, WATCHDOG_STATUS.RUNNING_UNRESPONSIVE);
        assert.equal(r.port, undefined);
    });
});

// apra-fleet-p2to.3.1 -- the sixth classifier status, PAUSED: a live-pid,
// HTTP-reachable child whose own /state pause.status reads 'paused'. Added
// per review feedback on apra-fleet-p2to.3.1 (the PAUSED branch, and
// probeChildPauseStatus's injectable dep, shipped with zero coverage).
describe('watchdog -- apra-fleet-p2to.3.1: PAUSED classification', () => {
    test('PID alive + HTTP answering + pause.status "paused" => PAUSED, not running-healthy', async () => {
        const wd = makeWatchdog(
            [{ sprintId: 's1', childPid: 100 }],
            {
                ports: { s1: 9000 }, alivePids: new Set([100]), httpOkPorts: new Set([9000]),
                probePauseState: () => 'paused',
            },
        );
        const [r] = await wd.classifyAll();
        assert.equal(r.status, WATCHDOG_STATUS.PAUSED);
        assert.equal(r.pidAlive, true);
        assert.equal(r.httpOk, true);
        assert.equal(r.pauseStatus, 'paused');
    });

    test('pause.status "pausing" (deferred, not yet engaged) stays running-healthy, never PAUSED', async () => {
        const wd = makeWatchdog(
            [{ sprintId: 's1', childPid: 100 }],
            {
                ports: { s1: 9000 }, alivePids: new Set([100]), httpOkPorts: new Set([9000]),
                probePauseState: () => 'pausing',
            },
        );
        const [r] = await wd.classifyAll();
        assert.equal(r.status, WATCHDOG_STATUS.RUNNING_HEALTHY);
    });

    test('pause.status "none" (or null) stays running-healthy', async () => {
        const wd = makeWatchdog(
            [{ sprintId: 's1', childPid: 100 }],
            {
                ports: { s1: 9000 }, alivePids: new Set([100]), httpOkPorts: new Set([9000]),
                probePauseState: () => 'none',
            },
        );
        const [r] = await wd.classifyAll();
        assert.equal(r.status, WATCHDOG_STATUS.RUNNING_HEALTHY);
    });

    test('the pause probe is never consulted when HTTP is not already known reachable (running-unresponsive stays running-unresponsive)', async () => {
        let calls = 0;
        const wd = makeWatchdog(
            [{ sprintId: 's1', childPid: 100 }],
            {
                ports: { s1: 9000 }, alivePids: new Set([100]), httpOkPorts: new Set(), // HTTP silent
                probePauseState: () => { calls += 1; return 'paused'; },
            },
        );
        const [r] = await wd.classifyAll();
        assert.equal(r.status, WATCHDOG_STATUS.RUNNING_UNRESPONSIVE);
        assert.equal(calls, 0, 'an unresponsive child cannot be asked anything -- the pause probe must not fire');
    });

    test('a throwing probePauseState is caught -- classification still completes as running-healthy, never crashes', async () => {
        const wd = makeWatchdog(
            [{ sprintId: 's1', childPid: 100 }],
            {
                ports: { s1: 9000 }, alivePids: new Set([100]), httpOkPorts: new Set([9000]),
                probePauseState: () => { throw new Error('boom'); },
            },
        );
        const [r] = await wd.classifyAll();
        assert.equal(r.status, WATCHDOG_STATUS.RUNNING_HEALTHY);
    });

    test('a probePauseState that resolves null (probe failure/timeout) is never conflated with paused', async () => {
        const wd = makeWatchdog(
            [{ sprintId: 's1', childPid: 100 }],
            {
                ports: { s1: 9000 }, alivePids: new Set([100]), httpOkPorts: new Set([9000]),
                probePauseState: () => null,
            },
        );
        const [r] = await wd.classifyAll();
        assert.equal(r.status, WATCHDOG_STATUS.RUNNING_HEALTHY);
        assert.equal(r.pauseStatus, undefined, 'a null/unknown probe result must not be stamped onto the result');
    });

    test('a PAUSED sprint is never routed through the terminal-error recorder / force-release path, even across repeated ticks', async () => {
        const calls = [];
        const wd = makeWatchdog(
            [{ sprintId: 's1', childPid: 100 }],
            {
                ports: { s1: 9000 }, alivePids: new Set([100]), httpOkPorts: new Set([9000]),
                probePauseState: () => 'paused',
                recordTerminalError: (info) => calls.push(info),
            },
        );
        await wd.classifyAll();
        await wd.classifyAll();
        assert.equal(calls.length, 0, 'PAUSED is a live, non-terminal status -- the reservation must never be force-released for it');
    });

    test('every classification is exactly one of the six documented statuses, and PAUSED is one of them', async () => {
        const six = new Set(Object.values(WATCHDOG_STATUS));
        assert.equal(six.size, 6);
        assert.ok(six.has(WATCHDOG_STATUS.PAUSED));
        const wd = makeWatchdog(
            [{ sprintId: 's1', childPid: 100 }],
            {
                ports: { s1: 9000 }, alivePids: new Set([100]), httpOkPorts: new Set([9000]),
                probePauseState: () => 'paused',
            },
        );
        const [r] = await wd.classifyAll();
        assert.ok(six.has(r.status));
        assert.equal(r.status, WATCHDOG_STATUS.PAUSED);
    });
});

// apra-fleet-p2to.3.1 -- probeChildPauseStatus() against a REAL HTTP server:
// the injectable default createWatchdog() falls back to when the caller
// supplies no deps.probePauseState. "cannot verify" (network error, timeout,
// non-JSON body) must resolve null, never be conflated with "not paused" in
// a way that masks a genuine probe failure, and must never throw.
describe('probeChildPauseStatus (apra-fleet-p2to.3.1) -- real HTTP server', () => {
    test('reads pause.status from a live child /state response', async () => {
        const server = http.createServer((req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ pause: { status: 'paused', reason: 'manual' } }));
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = server.address().port;
        try {
            assert.equal(await probeChildPauseStatus(port), 'paused');
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    test('returns "none" verbatim (not coerced to null) when the child reports it', async () => {
        const server = http.createServer((req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ pause: { status: 'none' } }));
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = server.address().port;
        try {
            assert.equal(await probeChildPauseStatus(port), 'none');
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    test('returns null when the response body is not valid JSON', async () => {
        const server = http.createServer((req, res) => {
            res.writeHead(200, { 'content-type': 'text/plain' });
            res.end('not json');
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = server.address().port;
        try {
            assert.equal(await probeChildPauseStatus(port), null);
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    test('returns null when the child response carries no pause field at all', async () => {
        const server = http.createServer((req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ status: 'running' }));
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = server.address().port;
        try {
            assert.equal(await probeChildPauseStatus(port), null);
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    test('returns null (never throws) for a dead port', async () => {
        const server = http.createServer((req, res) => { res.writeHead(200); res.end('{}'); });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = server.address().port;
        await new Promise((resolve) => server.close(resolve));
        // Port is now closed -- connection refused.
        assert.equal(await probeChildPauseStatus(port, { timeoutMs: 300 }), null);
    });

    test('returns null on a genuine timeout (server accepts but never responds)', async () => {
        const server = http.createServer(() => { /* never respond */ });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = server.address().port;
        try {
            assert.equal(await probeChildPauseStatus(port, { timeoutMs: 100 }), null);
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    test('returns null (never throws) for an invalid/non-positive port, without touching the network', async () => {
        assert.equal(await probeChildPauseStatus(0), null);
        assert.equal(await probeChildPauseStatus(-1), null);
        assert.equal(await probeChildPauseStatus(null), null);
        assert.equal(await probeChildPauseStatus(undefined), null);
    });
});

describe('watchdog -- PID-reuse guard', () => {
    test('a reused PID whose command line lacks our --viewer-port marker is NOT our child', async () => {
        const isChildAlive = makeChildPidProbe({
            isAlive: () => true, // the PID number exists...
            readCmdline: () => '/usr/bin/some-unrelated-process --flag', // ...but it is not our child
        });
        const wd = makeWatchdog(
            [{ sprintId: 's1', childPid: 4242 }],
            { ports: { s1: 9000 }, isChildAlive, terminalSprints: new Set() },
        );
        const [r] = await wd.classifyAll();
        // Guard rejects the reused PID -> treated as PID-gone -> crashed.
        assert.equal(r.pidAlive, false);
        assert.equal(r.status, WATCHDOG_STATUS.CRASHED);
    });

    test('a PID whose command line still carries our --viewer-port marker IS our child', async () => {
        const isChildAlive = makeChildPidProbe({
            isAlive: () => true,
            readCmdline: () => 'node /path/bin/cli.mjs --issue x --viewer-port 9000',
        });
        const wd = makeWatchdog(
            [{ sprintId: 's1', childPid: 4242 }],
            { ports: { s1: 9000 }, isChildAlive, httpOkPorts: new Set([9000]) },
        );
        const [r] = await wd.classifyAll();
        assert.equal(r.pidAlive, true);
        assert.equal(r.status, WATCHDOG_STATUS.RUNNING_HEALTHY);
    });

    test('unreadable command line falls back to existence-only (best effort, never a false crash)', async () => {
        const isChildAlive = makeChildPidProbe({
            isAlive: () => true,
            readCmdline: () => null, // e.g. no /proc on this platform
        });
        assert.equal(await isChildAlive(123, '--viewer-port 9000'), true);
    });

    test('a dead PID number is never alive regardless of marker', async () => {
        const isChildAlive = makeChildPidProbe({
            isAlive: () => false,
            readCmdline: () => 'anything --viewer-port 9000',
        });
        assert.equal(await isChildAlive(123, '--viewer-port 9000'), false);
    });
});

describe('watchdog -- interval + lifecycle', () => {
    test('interval is configurable and defaults when unset', () => {
        const custom = createWatchdog({ ledger: fakeLedger([]), intervalMs: 250 });
        assert.equal(custom.intervalMs, 250);
        const def = createWatchdog({ ledger: fakeLedger([]) });
        assert.equal(def.intervalMs, WATCHDOG_DEFAULT_INTERVAL_MS);
    });

    test('start() primes a snapshot and schedules the interval; stop() clears it', async () => {
        let scheduled = null;
        let cleared = false;
        const wd = makeWatchdog(
            [{ sprintId: 's1', childPid: 1 }],
            {
                ports: { s1: 9000 },
                alivePids: new Set([1]),
                httpOkPorts: new Set([9000]),
                intervalMs: 123,
                setIntervalFn: (fn, ms) => { scheduled = { fn, ms }; return { unref() {} }; },
                clearIntervalFn: () => { cleared = true; },
            },
        );
        await wd.start();
        // start() primed an initial snapshot synchronously.
        const snap = wd.getSnapshot();
        assert.equal(snap.length, 1);
        assert.equal(snap[0].status, WATCHDOG_STATUS.RUNNING_HEALTHY);
        assert.equal(scheduled.ms, 123);
        await wd.stop();
        assert.equal(cleared, true);
    });

    test('createWatchdog requires a ledger with list()', () => {
        assert.throws(() => createWatchdog({}), /ledger with a list\(\) method/);
    });
});

describe('watchdog -- default HTTP probe against a real server', () => {
    test('a live server answering /state is reachable; a dead port is not', async () => {
        const server = http.createServer((req, res) => { res.writeHead(200); res.end('{}'); });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = server.address().port;
        try {
            assert.equal(await probeChildHttp(port), true);
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
        // After close, the port is no longer answering.
        assert.equal(await probeChildHttp(port, { timeoutMs: 300 }), false);
    });
});

// apra-fleet-eft.20.3 -- a doer sub-session or orchestrator child that dies
// (or stalls) after the Develop checkpoint with zero diagnostic signal
// anywhere is exactly the CRASHED case (PID gone, no old_sprints/ terminal
// state): the watchdog must surface that death instead of silently letting
// classification move on. These tests cover (a) the CRASHED-transition
// recorder hook is actually invoked (and de-duplicated across ticks), and
// (b) the REAL default recorder both logs a terminal-error line AND
// persists failed/lastError into the sprint's own running/ state file,
// simulating a doer child that exited/stopped responding right after the
// Develop checkpoint.
describe('watchdog -- apra-fleet-eft.20.3: CRASHED sprints get a recorded terminal error', () => {
    test('classifySprint() invokes recordTerminalError exactly once for a sprint that stays CRASHED across repeated ticks', async () => {
        const calls = [];
        const wd = makeWatchdog(
            [{ sprintId: 's1', childPid: 4242 }],
            {
                ports: { s1: 9000 },
                alivePids: new Set(),
                terminalSprints: new Set(),
                recordTerminalError: (info) => calls.push(info),
            },
        );

        await wd.classifyAll();
        await wd.classifyAll();
        await wd.classifyAll();

        assert.equal(calls.length, 1, 'a sprint that stays CRASHED across ticks must only be recorded once');
        assert.equal(calls[0].sprintId, 's1');
        assert.equal(calls[0].childPid, 4242);
    });

    test('recordTerminalError is NOT invoked for running-healthy, running-unresponsive, or finished sprints', async () => {
        const calls = [];
        const wd = makeWatchdog(
            [
                { sprintId: 'healthy', childPid: 1 },
                { sprintId: 'hung', childPid: 2 },
                { sprintId: 'gone-finished', childPid: 3 },
            ],
            {
                ports: { healthy: 9001, hung: 9002, 'gone-finished': 9003 },
                alivePids: new Set([1, 2]),
                httpOkPorts: new Set([9001]),
                terminalSprints: new Set(['gone-finished']),
                recordTerminalError: (info) => calls.push(info),
            },
        );

        const results = await wd.classifyAll();
        assert.deepEqual(
            results.map((r) => r.status).sort(),
            [WATCHDOG_STATUS.FINISHED, WATCHDOG_STATUS.RUNNING_HEALTHY, WATCHDOG_STATUS.RUNNING_UNRESPONSIVE].sort(),
        );
        assert.equal(calls.length, 0, 'only a CRASHED classification may trigger the terminal-error recorder');
    });

    test('a recordTerminalError that throws is caught -- classification still completes and reports CRASHED', async () => {
        const wd = makeWatchdog(
            [{ sprintId: 's1', childPid: 100 }],
            {
                alivePids: new Set(),
                terminalSprints: new Set(),
                recordTerminalError: () => { throw new Error('boom'); },
                logger: { error() {}, log() {} },
            },
        );
        const [r] = await wd.classifyAll();
        assert.equal(r.status, WATCHDOG_STATUS.CRASHED);
    });

    describe('defaultRecordTerminalError -- real logger + real sprint-state file', () => {
        let tmpDataDir;
        let env;
        beforeEach(() => {
            tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-watchdog-terminal-error-'));
            env = { APRA_FLEET_DATA_DIR: tmpDataDir };
        });
        afterEach(() => {
            fs.rmSync(tmpDataDir, { recursive: true, force: true });
        });

        test('simulated doer death after the Develop checkpoint: logs a TERMINAL ERROR line AND persists failed/lastError, preserving prior state fields', async () => {
            const sprintId = 'sprint-eft-20-3-develop-death';
            const statePath = getRunningRunStatePath(sprintId, env);
            // The last thing the (now-dead) doer wrote before going silent --
            // mid-Develop, exactly the apra-fleet-eft.20 smoke-test symptom.
            fs.mkdirSync(path.dirname(statePath), { recursive: true });
            fs.writeFileSync(statePath, JSON.stringify({
                sprintId,
                status: 'running',
                phase: 'Develop',
                cycle: 1,
            }));

            const logLines = [];
            // makeWatchdog's helper defaults recordTerminalError to a no-op
            // (see above) so other tests never touch the real filesystem;
            // this test deliberately bypasses that helper and calls
            // createWatchdog() directly, leaving deps.recordTerminalError
            // unset, so the REAL defaultRecordTerminalError runs end to end.
            const realWd = createWatchdog({
                ledger: fakeLedger([{ sprintId, childPid: 9999 }]),
                isChildAlive: () => false,
                hasTerminalState: () => false,
                env,
                logger: { error: (...a) => logLines.push(a.join(' ')), log: (...a) => logLines.push(a.join(' ')) },
            });

            const [r] = await realWd.classifyAll();
            assert.equal(r.status, WATCHDOG_STATUS.CRASHED);

            // (a) an explicit terminal-error line was logged.
            assert.ok(
                logLines.some((line) => line.includes('TERMINAL ERROR') && line.includes(sprintId)),
                `expected a TERMINAL ERROR log line mentioning '${sprintId}', got: ${JSON.stringify(logLines)}`
            );

            // (b) the sprint state file now records failed/lastError, without
            // losing the phase it died in or its other prior fields.
            const persisted = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
            assert.equal(persisted.status, 'failed');
            assert.equal(persisted.phase, 'Develop', 'prior state (the phase the doer died in) must be preserved, not clobbered');
            assert.equal(persisted.cycle, 1);
            assert.ok(persisted.lastError, 'lastError must be persisted');
            assert.equal(persisted.lastError.sprintId, sprintId);
            assert.equal(persisted.lastError.childPid, 9999);
            assert.ok(persisted.lastError.message, 'lastError.message must describe what the watchdog observed');
            assert.ok(persisted.lastError.detectedAt, 'lastError.detectedAt must be set');
        });

        test('defaultRecordTerminalError tolerates a missing/never-written prior state file', () => {
            const sprintId = 'sprint-eft-20-3-no-prior-state';
            const statePath = getRunningRunStatePath(sprintId, env);
            assert.equal(fs.existsSync(statePath), false);

            const logLines = [];
            defaultRecordTerminalError({
                sprintId,
                childPid: null,
                env,
                logger: { error: (...a) => logLines.push(a.join(' ')) },
            });

            assert.ok(logLines.some((line) => line.includes('TERMINAL ERROR')));
            const persisted = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
            assert.equal(persisted.status, 'failed');
            assert.equal(persisted.lastError.childPid, null);
        });

        // apra-fleet-k7b.3: the bead's literal acceptance line -- "the
        // watchdog can report 'exited 1 at 14:25:50' instead of just 'pid
        // gone'". Asserts the ACTUAL emitted log line and persisted
        // terminalReason, not just the `detail` value handed to a spy.
        test('a supplied `detail` (e.g. "exited 1 at ...") appears verbatim in the logged TERMINAL ERROR line and the persisted terminalReason', () => {
            const sprintId = 'sprint-k7b-3-exit-detail';
            const statePath = getRunningRunStatePath(sprintId, env);
            assert.equal(fs.existsSync(statePath), false);

            const logLines = [];
            defaultRecordTerminalError({
                sprintId,
                childPid: 4321,
                env,
                logger: { error: (...a) => logLines.push(a.join(' ')) },
                detail: 'exited 1 at 2026-07-30T21:25:50.000Z',
            });

            assert.ok(
                logLines.some((line) => line.includes('TERMINAL ERROR') && line.includes('exited 1 at 2026-07-30T21:25:50.000Z')),
                `expected the logged line to include the exit detail verbatim, got: ${JSON.stringify(logLines)}`,
            );
            const persisted = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
            assert.ok(
                persisted.terminalReason.includes('exited 1 at 2026-07-30T21:25:50.000Z'),
                `expected terminalReason to include the exit detail verbatim, got: '${persisted.terminalReason}'`,
            );
        });
    });
});

// apra-fleet-k7b.3: proves the FULL same-instance pipeline end to end with a
// REAL ledger (not fakeLedger) -- ledger.recordExit() -> ledger.list() ->
// createWatchdog's classifySprint(entry) -> formatExitDetail(entry) -- so a
// future change that stops cloneReservation() from forwarding
// exitCode/signal/exitedAt would fail HERE even though the watchdog's own
// unit tests (which hand-write those fields directly onto a fakeLedger
// entry) and the ledger's own unit tests (which never call the watchdog)
// would both stay green.
describe('watchdog + REAL ledger integration (apra-fleet-k7b.3)', () => {
    test('a real ledger.recordExit() is visible in classifySprint()\'s detail via ledger.list()', async () => {
        const { createLedger, LEDGER_FILENAME } = await import('../src/supervisor/ledger.mjs');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-watchdog-real-ledger-'));
        try {
            const ledger = createLedger({ filePath: path.join(dir, LEDGER_FILENAME) });
            await ledger.start();
            // apra-fleet-gey.1: set reservedAt to the same time as the exit
            // to avoid triggering launch-failed detection (which requires the
            // exit to be WITHIN the launch window, not before the reservation).
            const exitTime = '2026-07-30T21:25:50.000Z';
            await ledger.claim('sprint-real', { members: ['alice'], issueRoots: ['apra-fleet-x'], childPid: 4321, reservedAt: exitTime });
            await ledger.recordExit('sprint-real', { exitCode: 1, signal: null, at: exitTime });

            const wd = createWatchdog({
                ledger,
                isChildAlive: () => false,
                hasTerminalState: () => false,
                recordTerminalError: () => {},
            });
            const [r] = await wd.classifyAll();
            assert.equal(r.sprintId, 'sprint-real');
            assert.equal(r.status, WATCHDOG_STATUS.CRASHED);
            assert.equal(r.detail, 'exited 1 at 2026-07-30T21:25:50.000Z');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

// apra-fleet-k7b.3: formatExitDetail() is the pure formatter behind
// classifySprint()'s `detail` field and defaultRecordTerminalError()'s
// message -- unit-tested standalone here for every input combination.
describe('formatExitDetail (apra-fleet-k7b.3)', () => {
    test('returns "pid gone" when nothing is recorded', () => {
        assert.equal(formatExitDetail({}), 'pid gone');
        assert.equal(formatExitDetail(), 'pid gone');
        assert.equal(formatExitDetail({ exitCode: null, signal: null, exitedAt: null }), 'pid gone');
    });

    test('formats "exited <code>" without a timestamp when exitedAt is absent', () => {
        assert.equal(formatExitDetail({ exitCode: 1 }), 'exited 1');
    });

    test('formats "exited <code> at <time>" when both are present', () => {
        assert.equal(formatExitDetail({ exitCode: 0, exitedAt: '2026-07-30T21:25:50.000Z' }), 'exited 0 at 2026-07-30T21:25:50.000Z');
    });

    test('formats "exited <code> (signal <signal>) at <time>" when both exitCode and signal are present', () => {
        assert.equal(
            formatExitDetail({ exitCode: 1, signal: 'SIGTERM', exitedAt: '2026-07-30T21:25:50.000Z' }),
            'exited 1 (signal SIGTERM) at 2026-07-30T21:25:50.000Z',
        );
    });

    test('formats "killed by signal <signal> at <time>" for a null exitCode with a signal', () => {
        assert.equal(
            formatExitDetail({ exitCode: null, signal: 'SIGKILL', exitedAt: '2026-07-30T21:30:00.000Z' }),
            'killed by signal SIGKILL at 2026-07-30T21:30:00.000Z',
        );
    });

    test('exitCode 0 (falsy but recorded) is still reported, not treated as absent', () => {
        assert.equal(formatExitDetail({ exitCode: 0, exitedAt: '2026-07-30T21:25:50.000Z' }), 'exited 0 at 2026-07-30T21:25:50.000Z');
    });
});
