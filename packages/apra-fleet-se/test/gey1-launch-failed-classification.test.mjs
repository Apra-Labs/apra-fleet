import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    createWatchdog,
    WATCHDOG_STATUS,
    WATCHDOG_DEFAULT_LAUNCH_FAILED_WINDOW_MS,
} from '../src/supervisor/watchdog.mjs';
import { createLedger, LEDGER_FILENAME } from '../src/supervisor/ledger.mjs';
import { createHistory, HISTORY_FILENAME, HISTORY_EVENTS } from '../src/supervisor/history.mjs';

/**
 * apra-fleet-gey.1: test launch-failed classification and auto-release.
 *
 * A sprint that exits very quickly (within the configurable launch window,
 * default 60s) with no terminal state is classified as launch-failed,
 * distinct from crashed. This diagnostic signal helps operators distinguish
 * "child failed immediately" from "child was running but died unexpectedly".
 */

describe('watchdog -- apra-fleet-gey.1: launch-failed classification and auto-release', () => {
    let tmpDataDir;
    let env;
    let ledger;
    let history;

    beforeEach(async () => {
        tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-launch-failed-'));
        env = { APRA_FLEET_DATA_DIR: tmpDataDir };

        ledger = createLedger({ filePath: path.join(tmpDataDir, LEDGER_FILENAME) });
        await ledger.start();

        history = createHistory({ filePath: path.join(tmpDataDir, HISTORY_FILENAME) });
        await history.start();
    });

    afterEach(async () => {
        if (ledger && typeof ledger.stop === 'function') {
            await ledger.stop();
        }
        if (history && typeof history.stop === 'function') {
            await history.stop();
        }
        fs.rmSync(tmpDataDir, { recursive: true, force: true });
    });

    test('sprint exiting within launch window is classified LAUNCH_FAILED', async () => {
        const sprintId = 'gey1-launch-fail-within-window';
        const reservedAt = new Date().toISOString();
        const exitedAt = new Date(new Date().getTime() + 30000).toISOString(); // 30s after reservation
        const windowMs = WATCHDOG_DEFAULT_LAUNCH_FAILED_WINDOW_MS; // 60s default

        // Verify the exit is within the window
        const exitedMs = new Date(exitedAt).getTime();
        const reservedMs = new Date(reservedAt).getTime();
        assert.ok(
            exitedMs - reservedMs < windowMs,
            `exit should be within window: ${exitedMs - reservedMs}ms < ${windowMs}ms`
        );

        // Claim the reservation with the reserved timestamp
        await ledger.claim(sprintId, {
            members: ['alice'],
            issueRoots: ['apra-fleet-x'],
            childPid: 9999,
            reservedAt,
        });

        // Record the child exit (same-instance exit listener)
        await ledger.recordExit(sprintId, {
            exitCode: 1,
            signal: null,
            at: exitedAt,
        });

        // Create watchdog (no terminal state exists)
        const wd = createWatchdog({
            ledger,
            isChildAlive: () => false,
            env,
            launchFailedWindowMs: windowMs,
            logger: { error() {}, log() {} },
            history,
        });

        // Classify
        const results = await wd.classifyAll();
        assert.equal(results.length, 1);
        assert.equal(results[0].status, WATCHDOG_STATUS.LAUNCH_FAILED);
        assert.ok(
            results[0].detail.includes('1'),
            'detail should include exit code'
        );
    });

    test('sprint exiting after launch window is classified CRASHED', async () => {
        const sprintId = 'gey1-crashed-after-window';
        const reservedAt = new Date().toISOString();
        const windowMs = WATCHDOG_DEFAULT_LAUNCH_FAILED_WINDOW_MS;
        // Exit AFTER the window (e.g., 90s after reservation, window is 60s)
        const exitedAt = new Date(new Date().getTime() + 90000).toISOString();

        // Verify the exit is AFTER the window
        const exitedMs = new Date(exitedAt).getTime();
        const reservedMs = new Date(reservedAt).getTime();
        assert.ok(
            exitedMs - reservedMs >= windowMs,
            `exit should be after window: ${exitedMs - reservedMs}ms >= ${windowMs}ms`
        );

        await ledger.claim(sprintId, {
            members: ['bob'],
            issueRoots: ['apra-fleet-y'],
            childPid: 8888,
            reservedAt,
        });

        await ledger.recordExit(sprintId, {
            exitCode: 0,
            signal: null,
            at: exitedAt,
        });

        const wd = createWatchdog({
            ledger,
            isChildAlive: () => false,
            env,
            launchFailedWindowMs: windowMs,
            logger: { error() {}, log() {} },
            history,
        });

        const results = await wd.classifyAll();
        assert.equal(results.length, 1);
        assert.equal(
            results[0].status,
            WATCHDOG_STATUS.CRASHED,
            'sprint exiting after window should be CRASHED, not LAUNCH_FAILED'
        );
    });

    test('launch-failed sprint has its reservation auto-released', async () => {
        const sprintId = 'gey1-launch-fail-release';
        const reservedAt = new Date().toISOString();
        const exitedAt = new Date(new Date().getTime() + 30000).toISOString(); // 30s

        await ledger.claim(sprintId, {
            members: ['charlie'],
            issueRoots: ['apra-fleet-z'],
            childPid: 7777,
            reservedAt,
        });

        await ledger.recordExit(sprintId, {
            exitCode: 127,
            signal: null,
            at: exitedAt,
        });

        assert.equal(ledger.size, 1);

        const wd = createWatchdog({
            ledger,
            isChildAlive: () => false,
            env,
            logger: { error() {}, log() {} },
            history,
        });

        await wd.classifyAll();

        // Reservation should be auto-released
        assert.equal(
            ledger.size,
            0,
            'launch-failed sprint should have its reservation auto-released'
        );
        assert.equal(
            ledger.get(sprintId),
            undefined,
            'released sprint must not be findable in ledger'
        );
    });

    test('launch-failed history event is recorded once per sprint', async () => {
        const sprintId = 'gey1-history-once';
        const reservedAt = new Date().toISOString();
        const exitedAt = new Date(new Date().getTime() + 20000).toISOString(); // 20s

        await ledger.claim(sprintId, {
            members: ['alice'],
            issueRoots: ['apra-fleet-x'],
            childPid: 6666,
            reservedAt,
        });

        await ledger.recordExit(sprintId, {
            exitCode: 1,
            signal: null,
            at: exitedAt,
        });

        const wd = createWatchdog({
            ledger,
            isChildAlive: () => false,
            env,
            logger: { error() {}, log() {} },
            history,
        });

        // Run classification multiple times
        await wd.classifyAll();
        await wd.classifyAll();
        await wd.classifyAll();

        // Read the persisted history
        const historyDoc = JSON.parse(fs.readFileSync(path.join(tmpDataDir, HISTORY_FILENAME), 'utf-8'));

        // Find all LAUNCH_FAILED events for this sprint
        const launchFailedEvents = historyDoc.events.filter(
            (e) => e.sprintId === sprintId && e.event === HISTORY_EVENTS.LAUNCH_FAILED
        );

        assert.equal(
            launchFailedEvents.length,
            1,
            'LAUNCH_FAILED event should be recorded exactly once, not once per tick'
        );
        assert.ok(
            launchFailedEvents[0].reason.includes('launch window'),
            'LAUNCH_FAILED event reason should mention the window'
        );
    });

    test('distinction: running-healthy sprint is not launch-failed', async () => {
        const runningId = 'gey1-running-alive';
        const failedId = 'gey1-running-failed';

        // Claim two reservations
        await ledger.claim(runningId, {
            members: ['alice'],
            issueRoots: ['apra-fleet-x'],
            childPid: 5555,
            reservedAt: new Date().toISOString(),
        });

        const failureTime = new Date().toISOString();
        await ledger.claim(failedId, {
            members: ['bob'],
            issueRoots: ['apra-fleet-y'],
            childPid: 4444,
            reservedAt: failureTime,
        });

        // Record exit for the failed one within the window
        await ledger.recordExit(failedId, {
            exitCode: 1,
            signal: null,
            at: new Date(new Date(failureTime).getTime() + 10000).toISOString(), // 10s later
        });

        const wd = createWatchdog({
            ledger,
            // Only the failed sprint's PID is gone
            isChildAlive: (pid) => pid === 5555,
            probeHttp: () => false, // Neither responds to HTTP for this test
            env,
            logger: { error() {}, log() {} },
            history,
        });

        const results = await wd.classifyAll();
        const byId = Object.fromEntries(results.map((r) => [r.sprintId, r]));

        assert.equal(
            byId[runningId].status,
            WATCHDOG_STATUS.RUNNING_UNRESPONSIVE,
            'running sprint should not be classified launch-failed'
        );

        assert.equal(
            byId[failedId].status,
            WATCHDOG_STATUS.LAUNCH_FAILED,
            'failed sprint should be launch-failed'
        );
    });

    test('custom launch-failed window is respected', async () => {
        const sprintId = 'gey1-custom-window';
        const customWindowMs = 10000; // 10 seconds (shorter than default 60s)
        const reservedAt = new Date().toISOString();
        // Exit at 15 seconds, which is > 10s window but < 60s default window
        const exitedAt = new Date(new Date().getTime() + 15000).toISOString();

        await ledger.claim(sprintId, {
            members: ['test'],
            issueRoots: ['issue'],
            childPid: 3333,
            reservedAt,
        });

        await ledger.recordExit(sprintId, {
            exitCode: 1,
            signal: null,
            at: exitedAt,
        });

        // Create watchdog with custom window (10s)
        const wd = createWatchdog({
            ledger,
            isChildAlive: () => false,
            env,
            launchFailedWindowMs: customWindowMs,
            logger: { error() {}, log() {} },
            history,
        });

        const results = await wd.classifyAll();
        const [classification] = results;

        // With 10s window, a 15s exit is NOT launch-failed, it's crashed
        assert.equal(
            classification.status,
            WATCHDOG_STATUS.CRASHED,
            '15s exit should be crashed when window is 10s (not launch-failed)'
        );
    });
});
