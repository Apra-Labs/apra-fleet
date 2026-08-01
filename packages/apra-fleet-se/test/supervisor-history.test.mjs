import { test, describe } from 'node:test';
import assert from 'node:assert';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
    createHistory,
    HISTORY_FILENAME,
    HISTORY_EVENTS,
    isDeterministicTerminalReason,
} from '../src/supervisor/history.mjs';

// apra-fleet-eft.5.4 -- append-only sprint terminal-event history log.
// apra-fleet-k7b.3 adds the CHILD_EXITED event (exitCode/signal), tested here.

async function tmpDir() {
    return fsp.mkdtemp(path.join(os.tmpdir(), 'eft-history-'));
}

describe('history -- record()/list()/latestFor() basics', () => {
    test('record() persists an event and reloads exactly', async () => {
        const dir = await tmpDir();
        const filePath = path.join(dir, HISTORY_FILENAME);
        const history = createHistory({ filePath, now: () => '2026-07-18T00:00:00.000Z' });
        await history.start();

        const stored = await history.record({ sprintId: 's1', event: HISTORY_EVENTS.FORCE_RELEASED, reason: 'stuck' });
        assert.equal(stored.sprintId, 's1');
        assert.equal(stored.event, HISTORY_EVENTS.FORCE_RELEASED);
        assert.equal(stored.at, '2026-07-18T00:00:00.000Z');
        // Pre-existing events default exitCode/signal to null.
        assert.equal(stored.exitCode, null);
        assert.equal(stored.signal, null);

        const reloaded = createHistory({ filePath });
        await reloaded.start();
        assert.equal(reloaded.list().length, 1);
        assert.equal(reloaded.latestFor('s1').event, HISTORY_EVENTS.FORCE_RELEASED);

        await fsp.rm(dir, { recursive: true, force: true });
    });
});

// apra-fleet-k7b.3: the spawner's own SAME-INSTANCE 'exit' observation,
// recorded via bin/serve.mjs's onChildExit -> history.record() wiring.
describe('history -- CHILD_EXITED event (apra-fleet-k7b.3)', () => {
    test('records exitCode/signal/at for a nonzero exit', async () => {
        const dir = await tmpDir();
        const filePath = path.join(dir, HISTORY_FILENAME);
        const history = createHistory({ filePath });
        await history.start();

        const stored = await history.record({
            sprintId: 's1',
            event: HISTORY_EVENTS.CHILD_EXITED,
            exitCode: 1,
            signal: null,
            at: '2026-07-30T21:25:50.000Z',
            // apra-fleet-ou7.1: the sprint's per-sprint raw log file path.
            logPath: '/home/x/.apra-fleet-se/logs/s1.log',
        });
        assert.equal(stored.event, 'child-exited');
        assert.equal(stored.exitCode, 1);
        assert.equal(stored.signal, null);
        assert.equal(stored.at, '2026-07-30T21:25:50.000Z');
        assert.equal(stored.logPath, '/home/x/.apra-fleet-se/logs/s1.log');

        // Round-trips through list()/latestFor() and survives a reload.
        assert.equal(history.latestFor('s1').exitCode, 1);
        const reloaded = createHistory({ filePath });
        await reloaded.start();
        const ev = reloaded.latestFor('s1');
        assert.equal(ev.event, HISTORY_EVENTS.CHILD_EXITED);
        assert.equal(ev.exitCode, 1);
        assert.equal(ev.signal, null);
        assert.equal(ev.at, '2026-07-30T21:25:50.000Z');
        assert.equal(ev.logPath, '/home/x/.apra-fleet-se/logs/s1.log');

        await fsp.rm(dir, { recursive: true, force: true });
    });

    test('records a null exitCode with a killing signal', async () => {
        const dir = await tmpDir();
        const filePath = path.join(dir, HISTORY_FILENAME);
        const history = createHistory({ filePath });
        await history.start();

        const stored = await history.record({
            sprintId: 's1',
            event: HISTORY_EVENTS.CHILD_EXITED,
            exitCode: null,
            signal: 'SIGKILL',
            at: '2026-07-30T21:30:00.000Z',
        });
        assert.equal(stored.exitCode, null);
        assert.equal(stored.signal, 'SIGKILL');

        await fsp.rm(dir, { recursive: true, force: true });
    });

    test('HISTORY_EVENTS.CHILD_EXITED is the stable string "child-exited"', () => {
        assert.equal(HISTORY_EVENTS.CHILD_EXITED, 'child-exited');
    });
});

// apra-fleet-gey.2: the relaunch gate (api.mjs's launch()) reads
// latestForIssueRoot()'s two-shape correlation -- an issueRoots-carrying
// anchor event (AUTO_RELEASED/FORCE_RELEASED/ABORTED_BY_RESTART/CHILD_EXITED)
// identifies WHICH sprintId was an issueRoot's last incarnation, then the
// actual terminal detail (FINISHED > LAUNCH_FAILED > the anchor itself) is
// pulled from that same sprintId's own events -- see history.mjs's
// file-level "gey.2" doc comment for the full rationale.
describe('history -- latestForIssueRoot() (apra-fleet-gey.2)', () => {
    test('correlates a LAUNCH_FAILED detail event (no issueRoots of its own) with its issueRoots-carrying anchor by shared sprintId', async () => {
        const dir = await tmpDir();
        const filePath = path.join(dir, HISTORY_FILENAME);
        const history = createHistory({ filePath, now: () => '2026-08-01T00:00:00.000Z' });
        await history.start();

        // The watchdog auto-releases the reservation (issueRoots-carrying),
        // then separately records the LAUNCH_FAILED detail under the SAME
        // sprintId -- LAUNCH_FAILED itself never carries issueRoots.
        await history.record({
            sprintId: 's1', event: HISTORY_EVENTS.AUTO_RELEASED, reason: 'watchdog: classified LAUNCH_FAILED',
            members: ['alice'], issueRoots: ['PROJ-1'],
        });
        await history.record({
            sprintId: 's1', event: HISTORY_EVENTS.LAUNCH_FAILED, reason: 'watchdog: child exited within launch window',
        });

        const record = history.latestForIssueRoot('PROJ-1');
        assert.ok(record);
        assert.equal(record.sprintId, 's1');
        assert.equal(record.event, HISTORY_EVENTS.LAUNCH_FAILED);
        assert.equal(record.reason, 'watchdog: child exited within launch window');

        await fsp.rm(dir, { recursive: true, force: true });
    });

    test('correlates a FINISHED detail event (terminalReason/verdict) with its anchor', async () => {
        const dir = await tmpDir();
        const filePath = path.join(dir, HISTORY_FILENAME);
        const history = createHistory({ filePath, now: () => '2026-08-01T00:00:00.000Z' });
        await history.start();

        await history.record({
            sprintId: 's2', event: HISTORY_EVENTS.AUTO_RELEASED, reason: 'watchdog: classified FINISHED',
            members: ['alice'], issueRoots: ['PROJ-2'],
        });
        await history.record({
            sprintId: 's2', event: HISTORY_EVENTS.FINISHED,
            terminalReason: 'BEADS_SYNC_CONFLICT', verdict: 'needs-changes',
        });

        const record = history.latestForIssueRoot('PROJ-2');
        assert.ok(record);
        assert.equal(record.sprintId, 's2');
        assert.equal(record.event, HISTORY_EVENTS.FINISHED);
        assert.equal(record.terminalReason, 'BEADS_SYNC_CONFLICT');
        assert.equal(record.verdict, 'needs-changes');

        await fsp.rm(dir, { recursive: true, force: true });
    });

    test('a FINISHED detail wins over a LAUNCH_FAILED detail for the same sprintId (TERMINAL_DETAIL_EVENTS priority order)', async () => {
        const dir = await tmpDir();
        const filePath = path.join(dir, HISTORY_FILENAME);
        const history = createHistory({ filePath, now: () => '2026-08-01T00:00:00.000Z' });
        await history.start();

        await history.record({
            sprintId: 's3', event: HISTORY_EVENTS.FORCE_RELEASED, reason: 'stuck',
            members: ['alice'], issueRoots: ['PROJ-3'],
        });
        // Both a LAUNCH_FAILED and a later FINISHED detail exist for 's3';
        // FINISHED must win regardless of recency.
        await history.record({ sprintId: 's3', event: HISTORY_EVENTS.LAUNCH_FAILED, reason: 'child exited fast' });
        await history.record({ sprintId: 's3', event: HISTORY_EVENTS.FINISHED, terminalReason: 'SPRINT_STALLED', verdict: 'needs-changes' });

        const record = history.latestForIssueRoot('PROJ-3');
        assert.equal(record.event, HISTORY_EVENTS.FINISHED);
        assert.equal(record.terminalReason, 'SPRINT_STALLED');

        await fsp.rm(dir, { recursive: true, force: true });
    });

    test('no detail event: the anchor itself supplies the terminal record', async () => {
        const dir = await tmpDir();
        const filePath = path.join(dir, HISTORY_FILENAME);
        const history = createHistory({ filePath, now: () => '2026-08-01T00:00:00.000Z' });
        await history.start();

        await history.record({
            sprintId: 's4', event: HISTORY_EVENTS.FORCE_RELEASED, reason: 'operator torn down a wedged reservation',
            members: ['alice'], issueRoots: ['PROJ-4'],
        });

        const record = history.latestForIssueRoot('PROJ-4');
        assert.equal(record.sprintId, 's4');
        assert.equal(record.event, HISTORY_EVENTS.FORCE_RELEASED);
        assert.equal(record.reason, 'operator torn down a wedged reservation');
        assert.equal(record.terminalReason, null);

        await fsp.rm(dir, { recursive: true, force: true });
    });

    test('an issueRoot with no issueRoots-carrying event at all (true first launch) returns undefined', async () => {
        const dir = await tmpDir();
        const filePath = path.join(dir, HISTORY_FILENAME);
        const history = createHistory({ filePath, now: () => '2026-08-01T00:00:00.000Z' });
        await history.start();

        await history.record({
            sprintId: 's5', event: HISTORY_EVENTS.AUTO_RELEASED, reason: 'watchdog',
            members: ['alice'], issueRoots: ['SOME-OTHER-ROOT'],
        });

        assert.equal(history.latestForIssueRoot('PROJ-5'), undefined);
        assert.equal(history.latestForIssueRoot(''), undefined);
        assert.equal(history.latestForIssueRoot(undefined), undefined);

        await fsp.rm(dir, { recursive: true, force: true });
    });
});

describe('history -- isDeterministicTerminalReason() (apra-fleet-gey.2)', () => {
    test('true for a LAUNCH_FAILED terminal record regardless of its reason text', () => {
        assert.equal(isDeterministicTerminalReason({ sprintId: 's1', event: HISTORY_EVENTS.LAUNCH_FAILED, reason: 'anything' }), true);
    });

    test('true for a FINISHED record whose terminalReason is in DETERMINISTIC_TERMINAL_REASONS (BEADS_SYNC_CONFLICT)', () => {
        assert.equal(
            isDeterministicTerminalReason({ sprintId: 's1', event: HISTORY_EVENTS.FINISHED, terminalReason: 'BEADS_SYNC_CONFLICT' }),
            true,
        );
    });

    test('false for a FINISHED record with an unlisted terminalReason (e.g. SPRINT_STALLED) -- a false negative only skips the warning, never blocks', () => {
        assert.equal(
            isDeterministicTerminalReason({ sprintId: 's1', event: HISTORY_EVENTS.FINISHED, terminalReason: 'SPRINT_STALLED' }),
            false,
        );
    });

    test('false for a FINISHED record with no terminalReason at all', () => {
        assert.equal(isDeterministicTerminalReason({ sprintId: 's1', event: HISTORY_EVENTS.FINISHED, terminalReason: null }), false);
    });

    test('false for null/undefined records', () => {
        assert.equal(isDeterministicTerminalReason(null), false);
        assert.equal(isDeterministicTerminalReason(undefined), false);
    });
});
