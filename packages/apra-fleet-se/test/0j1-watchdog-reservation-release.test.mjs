import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { createWatchdog, WATCHDOG_STATUS } from '../src/supervisor/watchdog.mjs';
import { createHistory, HISTORY_FILENAME, HISTORY_EVENTS } from '../src/supervisor/history.mjs';
import { createLedger, LEDGER_FILENAME } from '../src/supervisor/ledger.mjs';
import { getTerminalRunStatePath } from '@apralabs/apra-fleet-workflow/viewer/run-state-paths';

// =============================================================================
// apra-fleet-0j1 / apra-fleet-cvb.1 / apra-fleet-cvb.2 -- regression coverage
// for releaseTerminalReservation() (watchdog.mjs ~lines 514-582) and its call
// site inside classifySprint() (~line 669): a still-reserved sprint classified
// CRASHED or FINISHED must have its ledger reservation released within ONE
// watchdog poll, exactly once (idempotent -- no duplicate log line / history
// event / re-release on a repeat tick), while a still-RUNNING-HEALTHY sprint
// keeps its reservation.
//
// Live recurrence this guards against (2026-07-31): dead pid 29180 held
// apra-fleet-xuo's reservation with no watchdog action to clear it.
//
// apra-fleet-7h6n.4: merged from 0j1-watchdog-auto-release.test.mjs (a FAKE
// ledger double + a REAL dead OS pid + a real history.mjs instance, verifying
// release via the audit log line and the persisted AUTO_RELEASED history
// event) and 0j1-watchdog-reservation-release.test.mjs (a REAL ledger.mjs
// instance + injected isChildAlive/probeHttp fakes, verifying release via
// ledger.size/ledger.get()) -- both asserted the SAME core invariant
// (auto-release on CRASHED/FINISHED, idempotent across ticks) once per
// backend, with the idempotency assertion duplicated in both. The three
// shared-invariant tests below are now parameterized over BOTH ledger
// backends (LEDGER_VARIANTS); each variant's own `assertReleased()`
// verification stays backend-appropriate (log line + history event for
// fakeLedger, ledger.size/get() for realLedger), so the fakeLedger variant's
// runs still carry the original's log/history richness rather than losing
// it to a generic check. Backend-specific assertions that do not apply to
// the OTHER backend at all (the fakeLedger collaborator-shape edge cases;
// the realLedger running-vs-crashed distinction test) are kept explicit,
// unparameterized, below the shared loop.
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

// -----------------------------------------------------------------------------
// Ledger backend variants: each `setupSprint({ terminal })` builds a sprint
// reservation classifiable as FINISHED (terminal: true) or CRASHED
// (terminal: false), returns a ready-to-poll `watchdog`, and an
// `assertReleased()` verifying release the way that backend is naturally
// observed. Every variant's own cleanup() tears down its tmp state.
// -----------------------------------------------------------------------------
const LEDGER_VARIANTS = [
    {
        name: 'fakeLedger',
        async setupSprint({ terminal }) {
            const dataDir = await tmpDataDir('0j1-fake-');
            const seDataDir = await tmpDataDir('0j1-fake-se-');
            const env = { ...process.env, APRA_FLEET_DATA_DIR: dataDir };
            const sprintId = `0j1-fake-${terminal ? 'finished' : 'crashed'}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            const deadPid = realDeadPid();
            const members = ['alice', 'bob'];
            const issueRoots = ['apra-fleet-xuo'];

            if (terminal) {
                const statePath = getTerminalRunStatePath(sprintId, env);
                fs.mkdirSync(path.dirname(statePath), { recursive: true });
                fs.writeFileSync(statePath, JSON.stringify({ terminalReason: 'DONE' }));
            }

            const ledger = makeFakeLedger([{ sprintId, childPid: deadPid, branch: null, members, issueRoots }]);
            const history = createHistory({ filePath: path.join(seDataDir, HISTORY_FILENAME) });
            await history.start();
            const recordPromises = [];
            const trackingHistory = { record: (entry) => { const p = history.record(entry); recordPromises.push(p); return p; } };
            const logger = capturingLogger();
            const watchdog = createWatchdog({ ledger, env, history: trackingHistory, logger });

            return {
                sprintId, members, issueRoots, watchdog,
                async classifyAndSettle() {
                    const results = await watchdog.classifyAll();
                    await Promise.all(recordPromises);
                    return results;
                },
                async assertReleased() {
                    // Ledger-level: release() now reports "already released".
                    assert.equal(await ledger.release(sprintId), false, 'ledger must already show the reservation released after the watchdog tick');

                    // Audit log line, same "[watchdog] ..." shape as reconcile()'s own line --
                    // EXACTLY ONE regardless of how many ticks have run so far (idempotency).
                    const releaseLines = logger.lines.filter((l) => l.includes('[watchdog] auto-released reservation'));
                    assert.equal(releaseLines.length, 1, `expected exactly one auto-release log line, got: ${JSON.stringify(logger.lines)}`);
                    assert.ok(releaseLines[0].includes(`'${sprintId}'`));
                    assert.ok(releaseLines[0].includes(`status=${terminal ? 'finished' : 'crashed'}`));

                    // AUTO_RELEASED history event -- EXACTLY ONE, members/issueRoots
                    // captured at release time (also idempotency: no duplicate on repeat ticks).
                    const persisted = JSON.parse(await fsp.readFile(path.join(seDataDir, HISTORY_FILENAME), 'utf-8'));
                    const autoReleasedEvents = persisted.events.filter((e) => e.sprintId === sprintId && e.event === HISTORY_EVENTS.AUTO_RELEASED);
                    assert.equal(autoReleasedEvents.length, 1, `expected exactly one AUTO_RELEASED history event, got: ${JSON.stringify(autoReleasedEvents)}`);
                    assert.deepEqual(autoReleasedEvents[0].members, members);
                    assert.deepEqual(autoReleasedEvents[0].issueRoots, issueRoots);
                    assert.ok(autoReleasedEvents[0].reason.includes(terminal ? 'finished' : 'crashed'));
                },
                async cleanup() {
                    await fsp.rm(dataDir, { recursive: true, force: true });
                    await fsp.rm(seDataDir, { recursive: true, force: true });
                },
            };
        },
    },
    {
        name: 'realLedger',
        async setupSprint({ terminal }) {
            const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-watchdog-release-'));
            const env = { APRA_FLEET_DATA_DIR: dataDir };
            const ledger = createLedger({ filePath: path.join(dataDir, LEDGER_FILENAME) });
            await ledger.start();
            const sprintId = `0j1-real-${terminal ? 'finished' : 'crashed'}-${Math.random().toString(36).slice(2)}`;
            const members = ['alice', 'bob'];
            const issueRoots = ['apra-fleet-x', 'apra-fleet-y'];

            await ledger.claim(sprintId, { members, issueRoots, childPid: 9999, branch: 'feat/test' });
            assert.equal(ledger.size, 1, 'precondition: the reservation must exist before classification');
            assert.ok(ledger.get(sprintId));

            if (terminal) {
                const terminalStatePath = getTerminalRunStatePath(sprintId, env);
                fs.mkdirSync(path.dirname(terminalStatePath), { recursive: true });
                fs.writeFileSync(terminalStatePath, JSON.stringify({
                    sprintId, status: 'closed', terminalReason: 'SPRINT_SUCCEEDED',
                }));
            }

            const watchdog = createWatchdog({
                ledger,
                isChildAlive: () => false, // PID is gone
                probeHttp: () => false,    // HTTP is unreachable
                env,
                logger: { error() {}, log() {} },
            });

            return {
                sprintId, members, issueRoots, watchdog,
                async classifyAndSettle() {
                    return watchdog.classifyAll();
                },
                async assertReleased() {
                    assert.equal(ledger.size, 0, 'reservation must be auto-released after classification');
                    assert.equal(ledger.get(sprintId), undefined, 'released reservation must not be found in ledger');
                },
                async cleanup() {
                    if (ledger && typeof ledger.stop === 'function') await ledger.stop();
                    fs.rmSync(dataDir, { recursive: true, force: true });
                },
            };
        },
    },
];

for (const variant of LEDGER_VARIANTS) {
    describe(`watchdog -- apra-fleet-0j1/cvb.1/cvb.2: auto-release on CRASHED/FINISHED classification (${variant.name})`, () => {
        test('CRASHED sprint: reservation is released within one watchdog poll', async () => {
            const ctx = await variant.setupSprint({ terminal: false });
            try {
                const [classification] = await ctx.classifyAndSettle();
                assert.equal(classification.status, WATCHDOG_STATUS.CRASHED, 'no persisted terminal state => CRASHED');
                await ctx.assertReleased();
            } finally {
                await ctx.cleanup();
            }
        });

        test('FINISHED sprint: reservation is released within one watchdog poll', async () => {
            const ctx = await variant.setupSprint({ terminal: true });
            try {
                const [classification] = await ctx.classifyAndSettle();
                assert.equal(classification.status, WATCHDOG_STATUS.FINISHED);
                await ctx.assertReleased();
            } finally {
                await ctx.cleanup();
            }
        });

        test('mid-run release is idempotent: repeated watchdog ticks do not double-release', async () => {
            const ctx = await variant.setupSprint({ terminal: true });
            try {
                await ctx.classifyAndSettle();
                await ctx.assertReleased();
                // Second and third ticks are no-ops: each variant's assertReleased()
                // checks an ABSOLUTE count/state (ledger.size===0, or exactly one log
                // line / history event), so a duplicate release or duplicate audit
                // trail on a repeat tick would fail these same assertions again.
                await ctx.classifyAndSettle();
                await ctx.assertReleased();
                await ctx.classifyAndSettle();
                await ctx.assertReleased();
            } finally {
                await ctx.cleanup();
            }
        });
    });
}

// -----------------------------------------------------------------------------
// fakeLedger-only: collaborator-shape edge cases that only make sense against
// a minimal/faulty ledger double -- the real ledger.mjs always implements
// release() and does not throw under test conditions, so these have no
// realLedger counterpart.
// -----------------------------------------------------------------------------
describe('apra-fleet-0j1 / apra-fleet-cvb.1: ledger collaborator-shape edge cases (fakeLedger only)', () => {
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

// -----------------------------------------------------------------------------
// realLedger-only: the running-vs-terminal distinction, exercised via TWO
// concurrent reservations and per-sprint isChildAlive/probeHttp routing --
// this shape does not have a fakeLedger counterpart (the fakeLedger variant
// above only ever holds one sprint).
// -----------------------------------------------------------------------------
describe('watchdog -- apra-fleet-cvb.2: distinction between running and terminal sprints (realLedger only)', () => {
    test('running-healthy sprint is NOT released, only CRASHED/FINISHED sprints are', async () => {
        const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-watchdog-release-'));
        const env = { APRA_FLEET_DATA_DIR: dataDir };
        const ledger = createLedger({ filePath: path.join(dataDir, LEDGER_FILENAME) });
        await ledger.start();
        try {
            const runningId = 'sprint-cvb-2-running';
            const crashedId = 'sprint-cvb-2-crashed-release';

            await ledger.claim(runningId, {
                members: ['alice'], issueRoots: ['apra-fleet-x'], childPid: 6666, branch: 'feat/test',
            });
            await ledger.claim(crashedId, {
                members: ['bob'], issueRoots: ['apra-fleet-y'], childPid: 5555, branch: 'feat/test',
            });
            assert.equal(ledger.size, 2);

            const wd = createWatchdog({
                ledger,
                // Only the crashed sprint's PID is gone; the running one is alive.
                isChildAlive: (pid) => pid === 6666,
                probeHttp: (port) => port === 9001, // Only the running sprint's HTTP is OK.
                resolvePort: (id) => (id === runningId ? 9001 : 9002),
                env,
                logger: { error() {}, log() {} },
            });

            await wd.classifyAll();

            assert.ok(ledger.get(runningId), 'running-healthy sprint should retain its reservation');
            assert.equal(ledger.get(crashedId), undefined, 'crashed sprint should have its reservation released');
            assert.equal(ledger.size, 1, 'only one reservation should remain');
        } finally {
            if (ledger && typeof ledger.stop === 'function') await ledger.stop();
            fs.rmSync(dataDir, { recursive: true, force: true });
        }
    });
});
