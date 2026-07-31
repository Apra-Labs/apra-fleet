import { test, describe } from 'node:test';
import assert from 'node:assert';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { createHistory, HISTORY_FILENAME, HISTORY_EVENTS } from '../src/supervisor/history.mjs';

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
