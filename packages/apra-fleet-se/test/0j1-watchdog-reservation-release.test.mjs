import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createWatchdog, WATCHDOG_STATUS } from '../src/supervisor/watchdog.mjs';
import { createLedger, LEDGER_FILENAME } from '../src/supervisor/ledger.mjs';
import { getTerminalRunStatePath } from '@apralabs/apra-fleet-workflow/viewer/run-state-paths';

/**
 * apra-fleet-cvb.2: watchdog auto-releases a sprint's reservation once the
 * watchdog classifies it as CRASHED or FINISHED mid-run.
 *
 * This test complements reconcile.mjs's startup-time reservation sweep by
 * exercising the mid-run case: inject a dead/terminal sprint while the
 * supervisor is running, advance one watchdog tick, and assert the
 * reservation is gone and the member is dispatchable again.
 */

describe('watchdog -- apra-fleet-cvb.2: auto-release reservation on mid-run CRASHED/FINISHED classification', () => {
    let tmpDataDir;
    let env;
    let ledger;

    beforeEach(async () => {
        tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-watchdog-release-'));
        env = { APRA_FLEET_DATA_DIR: tmpDataDir };

        // Create a real ledger for these tests
        ledger = createLedger({ filePath: path.join(tmpDataDir, LEDGER_FILENAME) });
        await ledger.start();
    });

    afterEach(async () => {
        if (ledger && typeof ledger.stop === 'function') {
            await ledger.stop();
        }
        fs.rmSync(tmpDataDir, { recursive: true, force: true });
    });

    test('reservation is auto-released when watchdog classifies a mid-run sprint as FINISHED (terminal state exists)', async () => {
        const sprintId = 'sprint-cvb-2-finished';
        const members = ['alice', 'bob'];
        const issueRoots = ['apra-fleet-x', 'apra-fleet-y'];

        // Claim the reservation (sprint is running)
        await ledger.claim(sprintId, {
            members,
            issueRoots,
            childPid: 9999,
            branch: 'feat/test',
        });

        // Verify the reservation was created
        assert.equal(ledger.size, 1);
        assert.ok(ledger.get(sprintId));

        // Inject a terminal state file to mark the sprint as FINISHED
        const terminalStatePath = getTerminalRunStatePath(sprintId, env);
        fs.mkdirSync(path.dirname(terminalStatePath), { recursive: true });
        fs.writeFileSync(terminalStatePath, JSON.stringify({
            sprintId,
            status: 'closed',
            terminalReason: 'SPRINT_SUCCEEDED',
            extensions: {
                terminal: {
                    verdict: 'approved',
                },
            },
        }));

        // Create watchdog with the real ledger (no injected terminal-state check;
        // use the real defaultHasTerminalState)
        const wd = createWatchdog({
            ledger,
            isChildAlive: () => false, // PID is gone
            probeHttp: () => false,    // HTTP is unreachable
            env,
            logger: { error() {}, log() {} },
        });

        // Run one tick of classification
        const results = await wd.classifyAll();

        // Verify the sprint was classified as FINISHED
        assert.equal(results.length, 1);
        assert.equal(results[0].sprintId, sprintId);
        assert.equal(results[0].status, WATCHDOG_STATUS.FINISHED);

        // Verify the reservation was auto-released
        assert.equal(ledger.size, 0, 'reservation must be auto-released after FINISHED classification');
        assert.equal(ledger.get(sprintId), undefined, 'released reservation must not be found in ledger');
    });

    test('reservation is auto-released when watchdog classifies a mid-run sprint as CRASHED (no terminal state)', async () => {
        const sprintId = 'sprint-cvb-2-crashed';
        const members = ['alice'];
        const issueRoots = ['apra-fleet-x'];

        // Claim the reservation (sprint is running)
        await ledger.claim(sprintId, {
            members,
            issueRoots,
            childPid: 8888,
            branch: 'feat/test',
        });

        // Verify the reservation was created
        assert.equal(ledger.size, 1);
        assert.ok(ledger.get(sprintId));

        // Do NOT create a terminal state file -- sprint is CRASHED (unexpected death)

        const wd = createWatchdog({
            ledger,
            isChildAlive: () => false, // PID is gone
            probeHttp: () => false,    // HTTP is unreachable
            env,
            logger: { error() {}, log() {} },
        });

        // Run one tick of classification
        const results = await wd.classifyAll();

        // Verify the sprint was classified as CRASHED
        assert.equal(results.length, 1);
        assert.equal(results[0].sprintId, sprintId);
        assert.equal(results[0].status, WATCHDOG_STATUS.CRASHED);

        // Verify the reservation was auto-released
        assert.equal(ledger.size, 0, 'reservation must be auto-released after CRASHED classification');
        assert.equal(ledger.get(sprintId), undefined, 'released reservation must not be found in ledger');
    });

    test('mid-run release is idempotent: repeated watchdog ticks do not double-release', async () => {
        const sprintId = 'sprint-cvb-2-idempotent';
        const members = ['charlie'];
        const issueRoots = ['apra-fleet-x'];

        // Claim the reservation
        await ledger.claim(sprintId, {
            members,
            issueRoots,
            childPid: 7777,
            branch: 'feat/test',
        });

        // Create terminal state to mark as FINISHED
        const terminalStatePath = getTerminalRunStatePath(sprintId, env);
        fs.mkdirSync(path.dirname(terminalStatePath), { recursive: true });
        fs.writeFileSync(terminalStatePath, JSON.stringify({
            sprintId,
            status: 'closed',
            terminalReason: 'SPRINT_SUCCEEDED',
        }));

        const wd = createWatchdog({
            ledger,
            isChildAlive: () => false,
            probeHttp: () => false,
            env,
            logger: { error() {}, log() {} },
        });

        // Run multiple watchdog ticks
        await wd.classifyAll();
        assert.equal(ledger.size, 0, 'first tick should release the reservation');

        // Second tick should be a no-op (idempotent)
        await wd.classifyAll();
        assert.equal(ledger.size, 0, 'second tick must not re-release (no-op after first release)');

        // Third tick to be sure
        await wd.classifyAll();
        assert.equal(ledger.size, 0, 'third tick must also be a no-op');
    });

    test('distinction: running-healthy sprint is NOT released, only CRASHED/FINISHED sprints are', async () => {
        const runningId = 'sprint-cvb-2-running';
        const crashedId = 'sprint-cvb-2-crashed-release';

        // Claim two reservations
        await ledger.claim(runningId, {
            members: ['alice'],
            issueRoots: ['apra-fleet-x'],
            childPid: 6666,
            branch: 'feat/test',
        });
        await ledger.claim(crashedId, {
            members: ['bob'],
            issueRoots: ['apra-fleet-y'],
            childPid: 5555,
            branch: 'feat/test',
        });

        assert.equal(ledger.size, 2);

        const wd = createWatchdog({
            ledger,
            // Only the crashed sprint's PID is gone; the running one is alive
            isChildAlive: (pid) => pid === 6666,
            probeHttp: (port) => port === 9001, // Only the running sprint's HTTP is OK
            resolvePort: (id) => (id === runningId ? 9001 : 9002),
            env,
            logger: { error() {}, log() {} },
        });

        await wd.classifyAll();

        // The running sprint should NOT be released
        assert.ok(
            ledger.get(runningId),
            'running-healthy sprint should retain its reservation'
        );

        // The crashed sprint should be released
        assert.equal(
            ledger.get(crashedId),
            undefined,
            'crashed sprint should have its reservation released'
        );

        // Only one reservation should remain
        assert.equal(ledger.size, 1);
    });
});
