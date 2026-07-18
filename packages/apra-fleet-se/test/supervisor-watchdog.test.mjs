import { test, describe } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';

import {
    createWatchdog,
    makeChildPidProbe,
    probeChildHttp,
    WATCHDOG_STATUS,
    WATCHDOG_DEFAULT_INTERVAL_MS,
} from '../src/supervisor/watchdog.mjs';

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
        hasTerminalState: signals.hasTerminalState
            ?? ((id) => (signals.terminalSprints ?? new Set()).has(id)),
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
        assert.equal(isChildAlive(123, '--viewer-port 9000'), true);
    });

    test('a dead PID number is never alive regardless of marker', async () => {
        const isChildAlive = makeChildPidProbe({
            isAlive: () => false,
            readCmdline: () => 'anything --viewer-port 9000',
        });
        assert.equal(isChildAlive(123, '--viewer-port 9000'), false);
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
