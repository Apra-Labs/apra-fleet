import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createDoltMutex } from '../src/supervisor/dolt-mutex.mjs';
import { createIdAllocator } from '../src/supervisor/id-allocator.mjs';
import { createDashboard } from '../src/supervisor/dashboard.mjs';

// Shutdown contract: every setInterval a supervisor seam owns is cleared by
// that seam's stop(), so a leaked timer can never keep the process alive.
// Timer functions are injected; the handle passed to clearInterval must be the
// exact one setInterval returned.

function fakeTimers() {
    const t = { set: [], cleared: [] };
    t.setInterval = (fn, ms) => { const h = { id: t.set.length + 1, fn, ms }; t.set.push(h); return h; };
    t.clearInterval = (h) => { t.cleared.push(h); };
    return t;
}

describe('seam stop() clears its interval timer', () => {
    test('dolt-mutex', async () => {
        const t = fakeTimers();
        const mutex = createDoltMutex({ setInterval: t.setInterval, clearInterval: t.clearInterval });
        await mutex.start();
        assert.equal(t.set.length, 1);
        await mutex.stop();
        assert.deepEqual(t.cleared, [t.set[0]]);
        await mutex.stop();
        assert.equal(t.cleared.length, 1, 'a second stop() must not clear again');
    });

    test('id-allocator', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'seam-stop-'));
        try {
            const t = fakeTimers();
            const alloc = createIdAllocator({ dataDir: dir, setInterval: t.setInterval, clearInterval: t.clearInterval });
            await alloc.start();
            assert.equal(t.set.length, 1);
            await alloc.stop();
            assert.deepEqual(t.cleared, [t.set[0]]);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test('dashboard events timer', async () => {
        const t = fakeTimers();
        const dashboard = createDashboard({
            ledger: { list: () => [] },
            watchdog: { classifySprint: async () => ({}) },
            setInterval: t.setInterval,
            clearInterval: t.clearInterval,
        });
        await dashboard.start();
        await dashboard.start();
        assert.equal(t.set.length, 1, 'start() is idempotent');
        await dashboard.stop();
        assert.deepEqual(t.cleared, [t.set[0]]);
    });
});
