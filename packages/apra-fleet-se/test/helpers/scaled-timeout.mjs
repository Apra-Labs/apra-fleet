// Contention-aware timeout budget helper for the real-bd suite.
//
// Context: scripts/run-tests.mjs runs `node --test` with
// --test-concurrency=8. Under that load, tests that shell out to spawn
// child processes (e.g. real `bd` CLI invocations) compete for CPU/IO with
// up to 7 sibling test files, so a fixed wall-clock timeout budget that is
// safe when a file runs standalone can blow up purely from scheduling
// contention -- not a real regression. scaledTimeout() lets a test derive a
// headroom-adjusted budget from the actual concurrency level the run was
// launched with, instead of hardcoding a generous-but-arbitrary constant.
//
// Concurrency is read from the APRA_FLEET_TEST_CONCURRENCY env var, which
// run-tests.mjs exports into the env it hands to `node --test` (kept in
// sync with the --test-concurrency=8 flag it also passes -- see
// scripts/run-tests.mjs). Callers may override the concurrency via
// opts.concurrency (mainly for unit-testing this helper itself).
//
// DEFAULT_MULTIPLIER: when concurrency > 1, the base timeout is multiplied
// by this factor to build in headroom for up to (concurrency - 1) sibling
// tests contending for the same CPU/IO at once. 3x is a deliberately
// generous, cheap-to-afford margin -- these are upper-bound safety timeouts,
// not perf assertions, so overshooting costs nothing but a slower failure
// path while undershooting reintroduces the false-negative flakiness this
// helper exists to remove.
import { TEST_CONCURRENCY } from './test-concurrency.mjs';

const DEFAULT_MULTIPLIER = 3;

/**
 * Resolve the concurrency level from the env var. Undefined, empty and
 * unparseable values alike fall back to TEST_CONCURRENCY (the single source of
 * truth run-tests.mjs also uses): Number('') is 0, which is finite and <= 1, so
 * without this guard an empty export would silently disable all scaling.
 */
function envConcurrency(raw) {
    if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
        const n = Number(raw);
        if (Number.isFinite(n)) return n;
    }
    return TEST_CONCURRENCY;
}

/**
 * Derive a scaled timeout budget from the active test concurrency.
 *
 * @param {number} baseMs - the timeout budget appropriate for a single test
 *   running with no contention (i.e. standalone).
 * @param {object} [opts]
 * @param {number} [opts.concurrency] - overrides the concurrency level
 *   instead of reading APRA_FLEET_TEST_CONCURRENCY from the environment.
 * @param {object} [opts.env] - env object to read instead of process.env
 *   (lets a caller drive the real env-read path with a synthetic object).
 * @param {number} [opts.multiplier] - overrides DEFAULT_MULTIPLIER.
 * @returns {number} baseMs when concurrency <= 1 (or an explicit
 *   opts.concurrency is unparseable), otherwise baseMs * multiplier.
 */
export function scaledTimeout(baseMs, opts = {}) {
    // An explicit opts.concurrency wins verbatim; only the env path falls back.
    const concurrency = opts.concurrency !== undefined
        ? Number(opts.concurrency)
        : envConcurrency((opts.env ?? process.env).APRA_FLEET_TEST_CONCURRENCY);
    const multiplier = opts.multiplier ?? DEFAULT_MULTIPLIER;

    if (!Number.isFinite(concurrency) || concurrency <= 1) {
        return baseMs;
    }

    return Math.round(baseMs * multiplier);
}
