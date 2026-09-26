import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    renameWithRetry,
    RENAME_RETRY_DEFAULT_MAX_ATTEMPTS,
    RENAME_RETRY_DEFAULT_BASE_DELAY_MS,
} from '../src/supervisor/rename-with-retry.mjs';

// apra-fleet-ed4.1 -- bounded EPERM/EBUSY retry around the atomic
// tmp-write-then-rename replace both history.mjs's and ledger.mjs's
// persist() use. This file unit-tests the shared helper directly, with an
// injected fake fs.rename() and an injected fake sleep -- no real timers, no
// real filesystem, no wall-clock delay.

/** A fake fs.rename() that throws `errors[callIndex]` (or resolves once exhausted). */
function scriptedRename(errors) {
    const calls = [];
    return {
        calls,
        rename: async (src, dst) => {
            const i = calls.length;
            calls.push({ src, dst });
            if (i < errors.length && errors[i]) {
                const err = errors[i];
                throw err;
            }
        },
    };
}

/** A fake sleep() that never waits for real -- just records the requested delay. */
function fakeSleep() {
    const delays = [];
    return { delays, sleep: async (ms) => { delays.push(ms); } };
}

describe('renameWithRetry (apra-fleet-ed4.1)', () => {
    test('EPERM retry: fails on the first N-1 attempts then succeeds -- resolves, and rename is called exactly N times', async () => {
        const err = Object.assign(new Error('locked'), { code: 'EPERM' });
        const { rename, calls } = scriptedRename([err, err, null]); // fails twice, succeeds on the 3rd call
        const { sleep, delays } = fakeSleep();

        await renameWithRetry({ rename }, '/tmp/x.tmp', '/tmp/x', { sleep });

        assert.equal(calls.length, 3);
        assert.deepEqual(calls[0], { src: '/tmp/x.tmp', dst: '/tmp/x' });
        // Exactly 2 backoff sleeps between the 3 attempts.
        assert.equal(delays.length, 2);
    });

    test('EBUSY retry: fails on the first N-1 attempts then succeeds -- resolves, and rename is called exactly N times', async () => {
        const err = Object.assign(new Error('busy'), { code: 'EBUSY' });
        const { rename, calls } = scriptedRename([err, null]); // fails once, succeeds on the 2nd call
        const { sleep, delays } = fakeSleep();

        await renameWithRetry({ rename }, '/tmp/x.tmp', '/tmp/x', { sleep });

        assert.equal(calls.length, 2);
        assert.equal(delays.length, 1);
    });

    test('a mix of EPERM then EBUSY across attempts both count as retryable and eventually succeed', async () => {
        const eperm = Object.assign(new Error('locked'), { code: 'EPERM' });
        const ebusy = Object.assign(new Error('busy'), { code: 'EBUSY' });
        const { rename, calls } = scriptedRename([eperm, ebusy, null]);
        const { sleep } = fakeSleep();

        await renameWithRetry({ rename }, '/tmp/x.tmp', '/tmp/x', { sleep });

        assert.equal(calls.length, 3);
    });

    test('a non-EPERM/EBUSY error (e.g. ENOENT) propagates unretried on the very first attempt', async () => {
        const err = Object.assign(new Error('missing'), { code: 'ENOENT' });
        const { rename, calls } = scriptedRename([err]);
        const { sleep, delays } = fakeSleep();

        await assert.rejects(
            () => renameWithRetry({ rename }, '/tmp/x.tmp', '/tmp/x', { sleep }),
            (thrown) => thrown === err,
        );
        assert.equal(calls.length, 1);
        assert.equal(delays.length, 0, 'no backoff sleep for a non-retryable error');
    });

    test('a non-EPERM/EBUSY error (e.g. EACCES) propagates unretried on the very first attempt', async () => {
        const err = Object.assign(new Error('denied'), { code: 'EACCES' });
        const { rename, calls } = scriptedRename([err]);
        const { sleep } = fakeSleep();

        await assert.rejects(
            () => renameWithRetry({ rename }, '/tmp/x.tmp', '/tmp/x', { sleep }),
            (thrown) => thrown === err,
        );
        assert.equal(calls.length, 1);
    });

    test('bounded exhaustion: EPERM on every attempt re-throws the LAST error after exactly maxAttempts calls', async () => {
        const errs = [1, 2, 3, 4, 5].map((n) => Object.assign(new Error(`locked ${n}`), { code: 'EPERM' }));
        const { rename, calls } = scriptedRename(errs);
        const { sleep } = fakeSleep();

        await assert.rejects(
            () => renameWithRetry({ rename }, '/tmp/x.tmp', '/tmp/x', { maxAttempts: 5, sleep }),
            (thrown) => thrown === errs[4] && thrown.message === 'locked 5',
        );
        assert.equal(calls.length, 5);
    });

    test('exhaustion respects a custom (smaller) maxAttempts, not just the default', async () => {
        const errs = [1, 2].map((n) => Object.assign(new Error(`locked ${n}`), { code: 'EPERM' }));
        const { rename, calls } = scriptedRename(errs);
        const { sleep } = fakeSleep();

        await assert.rejects(
            () => renameWithRetry({ rename }, '/tmp/x.tmp', '/tmp/x', { maxAttempts: 2, sleep }),
            (thrown) => thrown === errs[1],
        );
        assert.equal(calls.length, 2);
    });

    test('happy path: rename() succeeds on the first try -> exactly ONE rename call, no delay (no behavioural change on POSIX)', async () => {
        const { rename, calls } = scriptedRename([]); // resolves immediately
        const { sleep, delays } = fakeSleep();

        await renameWithRetry({ rename }, '/tmp/x.tmp', '/tmp/x', { sleep });

        assert.equal(calls.length, 1);
        assert.equal(delays.length, 0);
    });

    test('defaults (no opts.sleep injected) still resolve on first-try success without invoking any real timer path', async () => {
        const { rename, calls } = scriptedRename([]);
        await renameWithRetry({ rename }, '/tmp/x.tmp', '/tmp/x');
        assert.equal(calls.length, 1);
    });

    test('default maxAttempts/baseDelayMs match the exported constants', () => {
        assert.equal(RENAME_RETRY_DEFAULT_MAX_ATTEMPTS, 5);
        assert.equal(RENAME_RETRY_DEFAULT_BASE_DELAY_MS, 10);
    });

    test('backoff escalates linearly per attempt (attempt * baseDelayMs), using the injected sleep', async () => {
        const err = Object.assign(new Error('locked'), { code: 'EPERM' });
        const { rename } = scriptedRename([err, err, err, null]);
        const { sleep, delays } = fakeSleep();

        await renameWithRetry({ rename }, '/tmp/x.tmp', '/tmp/x', { baseDelayMs: 10, sleep });

        // 3 failed attempts (1,2,3) before the 4th succeeds -> delays after
        // attempt 1, 2, 3 are 10*1, 10*2, 10*3.
        assert.deepEqual(delays, [10, 20, 30]);
    });

    test('an invalid (non-positive) maxAttempts falls back to the default', async () => {
        const errs = [1, 2, 3, 4, 5].map((n) => Object.assign(new Error(`locked ${n}`), { code: 'EPERM' }));
        const { rename, calls } = scriptedRename(errs);
        const { sleep } = fakeSleep();

        await assert.rejects(
            () => renameWithRetry({ rename }, '/tmp/x.tmp', '/tmp/x', { maxAttempts: 0, sleep }),
        );
        assert.equal(calls.length, RENAME_RETRY_DEFAULT_MAX_ATTEMPTS);
    });
});
