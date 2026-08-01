import { test, describe } from 'node:test';
import assert from 'node:assert';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { createHistory, HISTORY_FILENAME, HISTORY_EVENTS } from '../src/supervisor/history.mjs';
import { createLedger, LEDGER_FILENAME } from '../src/supervisor/ledger.mjs';
import { RENAME_RETRY_DEFAULT_MAX_ATTEMPTS } from '../src/supervisor/rename-with-retry.mjs';

// =============================================================================
// apra-fleet-ed4.2 -- deterministic verification for apra-fleet-ed4 (bug:
// history.mjs's/ledger.mjs's atomic-rename persist can EPERM on Windows,
// silently dropping an audit event), depends on apra-fleet-ed4.1's bounded
// EPERM/EBUSY retry (rename-with-retry.mjs, shared by both persist() call
// sites).
//
// This exercises the retry via dependency injection ONLY: a fake `deps.fs`
// whose `rename()` is a stub (all other fs calls delegate to the real
// `fs/promises` against a real temp dir -- the same hybrid-fake convention
// already established in this suite, e.g. supervisor-history.test.mjs's own
// apra-fleet-ed4.1 coverage), plus an injected `renameRetry.sleep` so no real
// backoff wall-clock delay ever occurs. Fully deterministic and poll-free:
// every assertion is on an injected rename call count / a directly-awaited
// persist() promise, never a timer or a filesystem race.
//
// This test fails against pre-ed4.1 code (persist() called a bare
// `fs.rename()` with no retry at all -- a single injected EPERM/EBUSY would
// have rejected the very first attempt) and passes once apra-fleet-ed4.1's
// renameWithRetry() wiring is in place.
// =============================================================================

async function tmpDir(prefix) {
    return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** A fake fs.rename() that fails `failCount` times with `code`, then delegates to the real rename. */
function flakyRenameFs(realFs, code, failCount) {
    let calls = 0;
    return {
        mkdir: realFs.mkdir.bind(realFs),
        readFile: realFs.readFile.bind(realFs),
        writeFile: realFs.writeFile.bind(realFs),
        async rename(src, dst) {
            calls += 1;
            if (calls <= failCount) {
                const err = new Error(`simulated ${code}`);
                err.code = code;
                throw err;
            }
            return realFs.rename(src, dst);
        },
        get renameCalls() { return calls; },
    };
}

/** A fake fs.rename() that ALWAYS fails with `code` -- for the exhaustion case. */
function alwaysFailRenameFs(realFs, code) {
    let calls = 0;
    return {
        mkdir: realFs.mkdir.bind(realFs),
        readFile: realFs.readFile.bind(realFs),
        writeFile: realFs.writeFile.bind(realFs),
        async rename() {
            calls += 1;
            const err = new Error(`simulated ${code} (attempt ${calls})`);
            err.code = code;
            throw err;
        },
        get renameCalls() { return calls; },
    };
}

describe('apra-fleet-ed4.2: history.mjs createHistory() persist() rename retry', () => {
    test('1) transient recovery: EPERM on the first N-1 attempts then succeeds -- record() succeeds, the on-disk document is fully written, the audit event is not lost, rename called N times', async () => {
        const dir = await tmpDir('ed4-2-history-eperm-');
        try {
            const filePath = path.join(dir, HISTORY_FILENAME);
            const fakeFs = flakyRenameFs(fsp, 'EPERM', 3);
            const sleeps = [];
            const history = createHistory({
                filePath, fs: fakeFs, renameRetry: { sleep: async (ms) => { sleeps.push(ms); } },
            });
            await history.start();

            const stored = await history.record({ sprintId: 'ed4-2-s1', event: HISTORY_EVENTS.AUTO_RELEASED, reason: 'watchdog' });
            assert.equal(stored.sprintId, 'ed4-2-s1', 'record() must resolve with the stored event, not reject');
            assert.equal(fakeFs.renameCalls, 4, 'rename must be called exactly N times (1 initial + 3 retries)');
            assert.equal(sleeps.length, 3, 'a bounded backoff sleep is injected between retries, never a real wall-clock wait');

            const onDisk = JSON.parse(await fsp.readFile(filePath, 'utf-8'));
            assert.equal(onDisk.events.length, 1, 'the audit event must not be lost');
            assert.equal(onDisk.events[0].sprintId, 'ed4-2-s1');
            assert.equal(onDisk.events[0].event, HISTORY_EVENTS.AUTO_RELEASED);
        } finally {
            await fsp.rm(dir, { recursive: true, force: true });
        }
    });

    test('2) transient recovery: EBUSY on the first N-1 attempts then succeeds -- same durability guarantee, rename called N times', async () => {
        const dir = await tmpDir('ed4-2-history-ebusy-');
        try {
            const filePath = path.join(dir, HISTORY_FILENAME);
            const fakeFs = flakyRenameFs(fsp, 'EBUSY', 2);
            const history = createHistory({ filePath, fs: fakeFs, renameRetry: { sleep: async () => {} } });
            await history.start();

            const stored = await history.record({ sprintId: 'ed4-2-s2', event: HISTORY_EVENTS.AUTO_RELEASED, reason: 'watchdog' });
            assert.equal(stored.sprintId, 'ed4-2-s2');
            assert.equal(fakeFs.renameCalls, 3, 'rename must be called exactly N times (1 initial + 2 retries)');

            const onDisk = JSON.parse(await fsp.readFile(filePath, 'utf-8'));
            assert.equal(onDisk.events.length, 1);
            assert.equal(onDisk.events[0].sprintId, 'ed4-2-s2');
        } finally {
            await fsp.rm(dir, { recursive: true, force: true });
        }
    });

    test('3) non-transient error passthrough: ENOSPC rejects record() immediately, rename called exactly once, no retry', async () => {
        const dir = await tmpDir('ed4-2-history-enospc-');
        try {
            const filePath = path.join(dir, HISTORY_FILENAME);
            const fakeFs = flakyRenameFs(fsp, 'ENOSPC', 5);
            const history = createHistory({
                filePath, fs: fakeFs,
                renameRetry: { sleep: async () => { throw new Error('must not sleep/retry for a non-transient error'); } },
            });
            await history.start();

            await assert.rejects(
                () => history.record({ sprintId: 'ed4-2-s3', event: HISTORY_EVENTS.AUTO_RELEASED, reason: 'watchdog' }),
                (err) => err.code === 'ENOSPC',
            );
            assert.equal(fakeFs.renameCalls, 1, 'a non-transient error must not be retried');

            await assert.rejects(() => fsp.readFile(filePath, 'utf-8'), { code: 'ENOENT' });
        } finally {
            await fsp.rm(dir, { recursive: true, force: true });
        }
    });

    test('4) exhaustion: rename() always throws EPERM -- record() rejects after the bounded number of attempts (last error re-thrown), rename call count equals the configured bound', async () => {
        const dir = await tmpDir('ed4-2-history-exhaust-');
        try {
            const filePath = path.join(dir, HISTORY_FILENAME);
            const fakeFs = alwaysFailRenameFs(fsp, 'EPERM');
            const sleeps = [];
            const history = createHistory({
                filePath, fs: fakeFs, renameRetry: { sleep: async (ms) => { sleeps.push(ms); } },
            });
            await history.start();

            await assert.rejects(
                () => history.record({ sprintId: 'ed4-2-s4', event: HISTORY_EVENTS.AUTO_RELEASED, reason: 'watchdog' }),
                (err) => err.code === 'EPERM' && err.message.includes(`attempt ${RENAME_RETRY_DEFAULT_MAX_ATTEMPTS}`),
            );
            assert.equal(fakeFs.renameCalls, RENAME_RETRY_DEFAULT_MAX_ATTEMPTS, 'rename call count must equal the configured bound, never more');
            assert.equal(sleeps.length, RENAME_RETRY_DEFAULT_MAX_ATTEMPTS - 1, 'exactly one backoff sleep between each of the bounded attempts');

            await assert.rejects(() => fsp.readFile(filePath, 'utf-8'), { code: 'ENOENT' }, 'an exhausted persist must never leave a partial/torn file behind');
        } finally {
            await fsp.rm(dir, { recursive: true, force: true });
        }
    });

    test('5) happy path unchanged: rename() succeeds on the first try -- exactly 1 rename call, no delay', async () => {
        const dir = await tmpDir('ed4-2-history-happy-');
        try {
            const filePath = path.join(dir, HISTORY_FILENAME);
            const fakeFs = flakyRenameFs(fsp, 'EPERM', 0);
            const sleeps = [];
            const history = createHistory({
                filePath, fs: fakeFs, renameRetry: { sleep: async (ms) => { sleeps.push(ms); } },
            });
            await history.start();

            const stored = await history.record({ sprintId: 'ed4-2-s5', event: HISTORY_EVENTS.AUTO_RELEASED, reason: 'watchdog' });
            assert.equal(stored.sprintId, 'ed4-2-s5');
            assert.equal(fakeFs.renameCalls, 1, 'a first-try success must make exactly one rename call, matching pre-ed4.1 behavior byte-for-byte');
            assert.equal(sleeps.length, 0, 'no backoff delay when rename never fails');
        } finally {
            await fsp.rm(dir, { recursive: true, force: true });
        }
    });
});

describe('apra-fleet-ed4.2: ledger.mjs createLedger() persist() rename retry', () => {
    test('1) transient recovery: EPERM on the first N-1 attempts then succeeds -- claim() succeeds, the on-disk document is fully written, the reservation is not lost, rename called N times', async () => {
        const dir = await tmpDir('ed4-2-ledger-eperm-');
        try {
            const filePath = path.join(dir, LEDGER_FILENAME);
            const fakeFs = flakyRenameFs(fsp, 'EPERM', 3);
            const sleeps = [];
            const ledger = createLedger({
                filePath, fs: fakeFs, renameRetry: { sleep: async (ms) => { sleeps.push(ms); } },
            });
            await ledger.start();

            const r = await ledger.claim('ed4-2-sprint-1', { members: ['alice'], issueRoots: ['apra-fleet-ed4'] });
            assert.deepEqual(r.members, ['alice'], 'claim() must resolve with the stored reservation, not reject');
            assert.equal(fakeFs.renameCalls, 4, 'rename must be called exactly N times (1 initial + 3 retries)');
            assert.equal(sleeps.length, 3, 'a bounded backoff sleep is injected between retries, never a real wall-clock wait');

            const onDisk = JSON.parse(await fsp.readFile(filePath, 'utf-8'));
            assert.deepEqual(onDisk.reservations['ed4-2-sprint-1'].members, ['alice'], 'the reservation must not be lost');
        } finally {
            await fsp.rm(dir, { recursive: true, force: true });
        }
    });

    test('2) transient recovery: EBUSY on the first N-1 attempts then succeeds -- same durability guarantee, rename called N times', async () => {
        const dir = await tmpDir('ed4-2-ledger-ebusy-');
        try {
            const filePath = path.join(dir, LEDGER_FILENAME);
            const fakeFs = flakyRenameFs(fsp, 'EBUSY', 2);
            const ledger = createLedger({ filePath, fs: fakeFs, renameRetry: { sleep: async () => {} } });
            await ledger.start();

            const r = await ledger.claim('ed4-2-sprint-2', { members: ['bob'], issueRoots: ['apra-fleet-ed4'] });
            assert.deepEqual(r.members, ['bob']);
            assert.equal(fakeFs.renameCalls, 3, 'rename must be called exactly N times (1 initial + 2 retries)');

            const onDisk = JSON.parse(await fsp.readFile(filePath, 'utf-8'));
            assert.deepEqual(onDisk.reservations['ed4-2-sprint-2'].members, ['bob']);
        } finally {
            await fsp.rm(dir, { recursive: true, force: true });
        }
    });

    test('3) non-transient error passthrough: ENOSPC rejects claim() immediately, rename called exactly once, no retry', async () => {
        const dir = await tmpDir('ed4-2-ledger-enospc-');
        try {
            const filePath = path.join(dir, LEDGER_FILENAME);
            const fakeFs = flakyRenameFs(fsp, 'ENOSPC', 5);
            const ledger = createLedger({
                filePath, fs: fakeFs,
                renameRetry: { sleep: async () => { throw new Error('must not sleep/retry for a non-transient error'); } },
            });
            await ledger.start();

            await assert.rejects(
                () => ledger.claim('ed4-2-sprint-3', { members: ['carol'], issueRoots: ['apra-fleet-ed4'] }),
                (err) => err.code === 'ENOSPC',
            );
            assert.equal(fakeFs.renameCalls, 1, 'a non-transient error must not be retried');

            await assert.rejects(() => fsp.readFile(filePath, 'utf-8'), { code: 'ENOENT' });
        } finally {
            await fsp.rm(dir, { recursive: true, force: true });
        }
    });

    test('4) exhaustion: rename() always throws EPERM -- claim() rejects after the bounded number of attempts (last error re-thrown), rename call count equals the configured bound', async () => {
        const dir = await tmpDir('ed4-2-ledger-exhaust-');
        try {
            const filePath = path.join(dir, LEDGER_FILENAME);
            const fakeFs = alwaysFailRenameFs(fsp, 'EPERM');
            const sleeps = [];
            const ledger = createLedger({
                filePath, fs: fakeFs, renameRetry: { sleep: async (ms) => { sleeps.push(ms); } },
            });
            await ledger.start();

            await assert.rejects(
                () => ledger.claim('ed4-2-sprint-4', { members: ['dave'], issueRoots: ['apra-fleet-ed4'] }),
                (err) => err.code === 'EPERM' && err.message.includes(`attempt ${RENAME_RETRY_DEFAULT_MAX_ATTEMPTS}`),
            );
            assert.equal(fakeFs.renameCalls, RENAME_RETRY_DEFAULT_MAX_ATTEMPTS, 'rename call count must equal the configured bound, never more');
            assert.equal(sleeps.length, RENAME_RETRY_DEFAULT_MAX_ATTEMPTS - 1, 'exactly one backoff sleep between each of the bounded attempts');

            await assert.rejects(() => fsp.readFile(filePath, 'utf-8'), { code: 'ENOENT' }, 'an exhausted persist must never leave a partial/torn file behind');
        } finally {
            await fsp.rm(dir, { recursive: true, force: true });
        }
    });

    test('5) happy path unchanged: rename() succeeds on the first try -- exactly 1 rename call, no delay', async () => {
        const dir = await tmpDir('ed4-2-ledger-happy-');
        try {
            const filePath = path.join(dir, LEDGER_FILENAME);
            const fakeFs = flakyRenameFs(fsp, 'EPERM', 0);
            const sleeps = [];
            const ledger = createLedger({
                filePath, fs: fakeFs, renameRetry: { sleep: async (ms) => { sleeps.push(ms); } },
            });
            await ledger.start();

            const r = await ledger.claim('ed4-2-sprint-5', { members: ['erin'], issueRoots: ['apra-fleet-ed4'] });
            assert.deepEqual(r.members, ['erin']);
            assert.equal(fakeFs.renameCalls, 1, 'a first-try success must make exactly one rename call, matching pre-ed4.1 behavior byte-for-byte');
            assert.equal(sleeps.length, 0, 'no backoff delay when rename never fails');
        } finally {
            await fsp.rm(dir, { recursive: true, force: true });
        }
    });
});
