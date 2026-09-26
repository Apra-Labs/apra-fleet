// =============================================================================
// Auto-sprint supervisor -- bounded EPERM/EBUSY retry around an atomic
// tmp-write-then-rename replace (apra-fleet-ed4.1)
// =============================================================================
//
// history.mjs's and ledger.mjs's persist() both write to a `.tmp` file then
// fs.rename() it over the real file -- the same atomic-replace primitive, so
// a torn/partial write is never visible to a concurrent reader. On Windows,
// that fs.rename() step can fail with EPERM/EBUSY when the destination file
// is momentarily locked/open by another process (e.g. an AV scanner, a
// concurrent reader mid-open) -- a TRANSIENT, self-clearing condition, not a
// real failure. Without a retry this silently drops whatever persist() was
// writing (observed live 2026-08-01 on a watchdog history.record(
// AUTO_RELEASED) -- a durable audit event vanished with no error surfaced
// anywhere).
//
// This module is the single shared retry loop both persist() call sites use,
// so the bounded-retry discipline (and its "what counts as retryable" rule)
// lives in exactly one place instead of being duplicated.
// =============================================================================

/** Default max attempts (the first try, plus up to this many-1 retries). */
export const RENAME_RETRY_DEFAULT_MAX_ATTEMPTS = 5;

/** Default base backoff (ms) -- escalates linearly per attempt (attempt * base). */
export const RENAME_RETRY_DEFAULT_BASE_DELAY_MS = 10;

function defaultSleep(ms) {
    return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Bounded EPERM/EBUSY retry around `fs.rename(tmpPath, destPath)`.
 *
 * Retries ONLY when `err.code === 'EPERM' || err.code === 'EBUSY'` (the
 * transient Windows-locking symptom) -- any other error (e.g. ENOENT, a
 * permanent EACCES) re-throws immediately on the FIRST attempt, since a
 * bounded retry loop must never mask a genuinely different failure as "just
 * needs another try".
 *
 * Bounded: after `maxAttempts` total attempts (default 5, escalating ~10ms
 * backoff per attempt) a still-failing rename re-throws the LAST error it
 * saw, so a genuinely stuck rename still surfaces -- this never retries
 * forever.
 *
 * On POSIX, or on any platform where the very first `fs.rename()` call
 * succeeds, this makes EXACTLY ONE rename call -- byte-identical behavior to
 * a bare `await fs.rename(tmpPath, destPath)`, so callers that never hit
 * EPERM/EBUSY see no change at all.
 *
 * @param {{ rename: (src: string, dst: string) => Promise<void> }} fs an
 *   injectable fs-like collaborator (matching history.mjs's/ledger.mjs's own
 *   injected `deps.fs` convention) exposing an async `rename()`.
 * @param {string} tmpPath
 * @param {string} destPath
 * @param {{
 *   maxAttempts?: number,
 *   baseDelayMs?: number,
 *   sleep?: (ms: number) => Promise<void>,
 * }} [opts] Injectable so a test can drive a fake clock/sleep with no real
 *   timers -- `sleep` defaults to a real `setTimeout`-backed delay.
 * @returns {Promise<void>}
 */
export async function renameWithRetry(fs, tmpPath, destPath, opts = {}) {
    const maxAttempts = Number.isInteger(opts.maxAttempts) && opts.maxAttempts > 0
        ? opts.maxAttempts
        : RENAME_RETRY_DEFAULT_MAX_ATTEMPTS;
    const baseDelayMs = Number.isInteger(opts.baseDelayMs) && opts.baseDelayMs >= 0
        ? opts.baseDelayMs
        : RENAME_RETRY_DEFAULT_BASE_DELAY_MS;
    const sleep = typeof opts.sleep === 'function' ? opts.sleep : defaultSleep;

    let attempt = 0;
    for (;;) {
        attempt += 1;
        try {
            // eslint-disable-next-line no-await-in-loop
            await fs.rename(tmpPath, destPath);
            return;
        } catch (err) {
            const retryable = Boolean(err) && (err.code === 'EPERM' || err.code === 'EBUSY');
            if (!retryable || attempt >= maxAttempts) throw err;
            // eslint-disable-next-line no-await-in-loop
            await sleep(baseDelayMs * attempt);
        }
    }
}
