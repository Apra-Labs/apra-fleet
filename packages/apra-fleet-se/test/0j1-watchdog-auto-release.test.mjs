import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { createWatchdog, WATCHDOG_STATUS } from '../src/supervisor/watchdog.mjs';
import { createHistory, HISTORY_FILENAME, HISTORY_EVENTS } from '../src/supervisor/history.mjs';

// =============================================================================
// apra-fleet-0j1 / apra-fleet-cvb.1 -- regression coverage for
// releaseTerminalReservation() (watchdog.mjs ~lines 514-582) and its call site
// inside classifySprint() (~line 669): a still-reserved sprint classified
// CRASHED or FINISHED must have its ledger reservation released within ONE
// watchdog poll, exactly once (idempotent -- no duplicate log line / history
// event on a repeat tick), with the AUTO_RELEASED history event carrying the
// members/issueRoots captured at release time, and two collaborator-shaped
// edge cases handled without ever taking classification down: a ledger with
// no release() method (silently skipped) and a ledger whose release() throws
// (caught + logged).
//
// Live recurrence this guards against (2026-07-31): dead pid 29180 held
// apra-fleet-xuo's reservation with no watchdog action to clear it.
// =============================================================================

async function tmpDataDir(prefix) {
    return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** A REAL dead OS pid: spawn a trivial child and let it exit+get reaped, then
 * reuse its now-free pid number -- same idiom as k7b6's integration suite. */
function realDeadPid() {
    const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    assert.ok(Number.isInteger(child.pid) && child.pid > 0, 'expected spawnSync to report a pid');
    return child.pid;
}

function capturingLogger() {
    const lines = [];
    return {
        lines,
        log: (...a) => lines.push(a.join(' ')),
        error: (...a) => lines.push(a.join(' ')),
        warn: (...a) => lines.push(a.join(' ')),
    };
}

/** A minimal stateful ledger fake: release() behaves like the real
 * ledger.release() -- returns true exactly once (the tick that actually
 * clears the reservation), then false on every subsequent call for the same
 * sprintId, modeling "already released" idempotency. get() returns the
 * reservation's members/issueRoots until released, undefined after. */
function makeFakeLedger(entries) {
    const held = new Map(entries.map((e) => [e.sprintId, { members: e.members ?? [], issueRoots: e.issueRoots ?? [] }]));
    return {
        list: () => entries,
        get: (sprintId) => held.get(sprintId),
        release: async (sprintId) => {
            if (!held.has(sprintId)) return false;
            held.delete(sprintId);
            return true;
        },
    };
}

describe('apra-fleet-0j1 / apra-fleet-cvb.1: watchdog auto-releases a still-held reservation on CRASHED/FINISHED classification', () => {
    test('CRASHED sprint: release() called within one poll, AUTO_RELEASED history event carries members/issueRoots, audit log line emitted; repeat tick is a no-op', async () => {
        const dataDir = await tmpDataDir('0j1-crashed-');
        const seDataDir = await tmpDataDir('0j1-crashed-se-');
        try {
            const env = { ...process.env, APRA_FLEET_DATA_DIR: dataDir };
            const sprintId = `0j1-crashed-${process.pid}-${Date.now()}`;
            const deadPid = realDeadPid();

            const ledger = makeFakeLedger([{
                sprintId,
                childPid: deadPid,
                branch: null,
                members: ['alice', 'bob'],
                issueRoots: ['apra-fleet-xuo'],
            }]);

            const history = createHistory({ filePath: path.join(seDataDir, HISTORY_FILENAME) });
            await history.start();
            const recordPromises = [];
            const trackingHistory = { record: (entry) => { const p = history.record(entry); recordPromises.push(p); return p; } };
            const logger = capturingLogger();

            const watchdog = createWatchdog({ ledger, env, history: trackingHistory, logger });

            const [classification] = await watchdog.classifyAll();
            await Promise.all(recordPromises);

            assert.equal(classification.status, WATCHDOG_STATUS.CRASHED, 'no persisted terminal state => CRASHED');

            // Reservation released within this ONE poll.
            assert.equal(await ledger.release(sprintId), false, 'ledger must already show the reservation released after one watchdog tick');

            // Audit log line, same "[watchdog] ..." shape as reconcile()'s own line.
            const releaseLines = logger.lines.filter((l) => l.includes('[watchdog] auto-released reservation'));
            assert.equal(releaseLines.length, 1, `expected exactly one auto-release log line, got: ${JSON.stringify(logger.lines)}`);
            assert.ok(releaseLines[0].includes(`'${sprintId}'`));
            assert.ok(releaseLines[0].includes('status=crashed'));

            // AUTO_RELEASED history event, members/issueRoots captured at release time.
            const persisted = JSON.parse(await fsp.readFile(path.join(seDataDir, HISTORY_FILENAME), 'utf-8'));
            const autoReleasedEvents = persisted.events.filter((e) => e.sprintId === sprintId && e.event === HISTORY_EVENTS.AUTO_RELEASED);
            assert.equal(autoReleasedEvents.length, 1);
            assert.deepEqual(autoReleasedEvents[0].members, ['alice', 'bob']);
            assert.deepEqual(autoReleasedEvents[0].issueRoots, ['apra-fleet-xuo']);
            assert.ok(autoReleasedEvents[0].reason.includes('crashed'));

            // Idempotent: a repeat tick for the SAME still-listed ledger entry
            // (simulating a ledger fake that has not actually dropped the
            // sprint from list() yet) must not log or record a second time --
            // release() itself now returns false, which must suppress both.
            const logLinesBefore = logger.lines.length;
            const eventCountBefore = autoReleasedEvents.length;
            await watchdog.classifyAll();
            await Promise.all(recordPromises);
            assert.equal(logger.lines.filter((l) => l.includes('[watchdog] auto-released reservation')).length, 1, 'no duplicate auto-release log line on a repeat tick');
            const persistedAfter = JSON.parse(await fsp.readFile(path.join(seDataDir, HISTORY_FILENAME), 'utf-8'));
            assert.equal(persistedAfter.events.filter((e) => e.sprintId === sprintId && e.event === HISTORY_EVENTS.AUTO_RELEASED).length, eventCountBefore, 'no duplicate AUTO_RELEASED history event on a repeat tick');
            assert.ok(logger.lines.length >= logLinesBefore, 'sanity: log did not shrink');
        } finally {
            await fsp.rm(dataDir, { recursive: true, force: true });
            await fsp.rm(seDataDir, { recursive: true, force: true });
        }
    });

    test('FINISHED sprint: release() called within one poll and AUTO_RELEASED history event is emitted', async () => {
        const dataDir = await tmpDataDir('0j1-finished-');
        const seDataDir = await tmpDataDir('0j1-finished-se-');
        try {
            const env = { ...process.env, APRA_FLEET_DATA_DIR: dataDir };
            const sprintId = `0j1-finished-${process.pid}-${Date.now()}`;
            const deadPid = realDeadPid();

            const { getTerminalRunStatePath } = await import('@apralabs/apra-fleet-workflow/viewer/run-state-paths');
            const statePath = getTerminalRunStatePath(sprintId, env);
            fs.mkdirSync(path.dirname(statePath), { recursive: true });
            fs.writeFileSync(statePath, JSON.stringify({ terminalReason: 'DONE' }));

            const ledger = makeFakeLedger([{ sprintId, childPid: deadPid, branch: null, members: ['carol'], issueRoots: ['apra-fleet-abc'] }]);
            const history = createHistory({ filePath: path.join(seDataDir, HISTORY_FILENAME) });
            await history.start();
            const recordPromises = [];
            const trackingHistory = { record: (entry) => { const p = history.record(entry); recordPromises.push(p); return p; } };
            const logger = capturingLogger();

            const watchdog = createWatchdog({ ledger, env, history: trackingHistory, logger });
            const [classification] = await watchdog.classifyAll();
            await Promise.all(recordPromises);

            assert.equal(classification.status, WATCHDOG_STATUS.FINISHED);
            assert.equal(await ledger.release(sprintId), false, 'reservation must already be released after one poll');

            const releaseLines = logger.lines.filter((l) => l.includes('[watchdog] auto-released reservation'));
            assert.equal(releaseLines.length, 1);
            assert.ok(releaseLines[0].includes('status=finished'));

            const persisted = JSON.parse(await fsp.readFile(path.join(seDataDir, HISTORY_FILENAME), 'utf-8'));
            const autoReleasedEvents = persisted.events.filter((e) => e.sprintId === sprintId && e.event === HISTORY_EVENTS.AUTO_RELEASED);
            assert.equal(autoReleasedEvents.length, 1);
            assert.deepEqual(autoReleasedEvents[0].members, ['carol']);
            assert.deepEqual(autoReleasedEvents[0].issueRoots, ['apra-fleet-abc']);
        } finally {
            await fsp.rm(dataDir, { recursive: true, force: true });
            await fsp.rm(seDataDir, { recursive: true, force: true });
        }
    });

    test('a ledger collaborator with no release() method is silently skipped -- classification proceeds, no auto-release log/history', async () => {
        const dataDir = await tmpDataDir('0j1-norelease-');
        try {
            const env = { ...process.env, APRA_FLEET_DATA_DIR: dataDir };
            const sprintId = `0j1-norelease-${process.pid}-${Date.now()}`;
            const deadPid = realDeadPid();

            // Minimal ledger double exposing only list() -- the shape most of
            // this module's existing tests inject, and createWatchdog()'s own
            // required interface.
            const ledger = { list: () => [{ sprintId, childPid: deadPid, branch: null }] };
            const logger = capturingLogger();

            const watchdog = createWatchdog({ ledger, env, logger });
            const [classification] = await watchdog.classifyAll();

            assert.equal(classification.status, WATCHDOG_STATUS.CRASHED);
            assert.equal(logger.lines.filter((l) => l.includes('[watchdog] auto-released reservation')).length, 0, 'no release() method means no release attempt and no release log line');
        } finally {
            await fsp.rm(dataDir, { recursive: true, force: true });
        }
    });

    test('ledger.release() throwing is caught and logged, not propagated -- classification still returns/completes', async () => {
        const dataDir = await tmpDataDir('0j1-throws-');
        try {
            const env = { ...process.env, APRA_FLEET_DATA_DIR: dataDir };
            const sprintId = `0j1-throws-${process.pid}-${Date.now()}`;
            const deadPid = realDeadPid();

            const ledger = {
                list: () => [{ sprintId, childPid: deadPid, branch: null }],
                get: () => ({ members: [], issueRoots: [] }),
                release: async () => { throw new Error('boom: release backend unreachable'); },
            };
            const logger = capturingLogger();

            const watchdog = createWatchdog({ ledger, env, logger });

            // classifyAll() itself must not reject even though release() threw.
            const classifications = await watchdog.classifyAll();
            assert.equal(classifications.length, 1);
            assert.equal(classifications[0].status, WATCHDOG_STATUS.CRASHED, 'classification result is unaffected by a release() failure');

            const errorLines = logger.lines.filter((l) => l.includes('ledger.release failed'));
            assert.equal(errorLines.length, 1, `expected the release failure to be logged once, got: ${JSON.stringify(logger.lines)}`);
            assert.ok(errorLines[0].includes(sprintId));
            // No success line, since the release never actually happened.
            assert.equal(logger.lines.filter((l) => l.includes('[watchdog] auto-released reservation')).length, 0);
        } finally {
            await fsp.rm(dataDir, { recursive: true, force: true });
        }
    });
});
