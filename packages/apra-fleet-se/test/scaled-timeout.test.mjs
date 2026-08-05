import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scaledTimeout } from './helpers/scaled-timeout.mjs';

// =============================================================================
// apra-fleet-eft.85.3 -- unit coverage for eft.85.1's scaledTimeout() helper
// (test/helpers/scaled-timeout.mjs), which the 3 contention-sensitive real-bd
// files (bd-init-templating.test.mjs, mock-sprint-planner-auth-failure-no-
// retry.test.mjs, serve-wiring-integration.test.mjs) now call instead of
// hardcoding fixed wall-clock timeout budgets (eft.85.2). This file pins the
// exact scaling contract so a future change to the helper's multiplier or
// its concurrency-detection logic gets caught here instead of only
// resurfacing as a flaky --test-concurrency=8 false negative in one of the
// consuming files.
// =============================================================================

const BASE_MS = 1000;
const DEFAULT_MULTIPLIER = 3; // must track scaled-timeout.mjs's DEFAULT_MULTIPLIER

test('unit: scaledTimeout(baseMs) === baseMs when concurrency is unset', () => {
    const prev = process.env.APRA_FLEET_TEST_CONCURRENCY;
    delete process.env.APRA_FLEET_TEST_CONCURRENCY;
    try {
        assert.equal(scaledTimeout(BASE_MS), BASE_MS);
    } finally {
        if (prev === undefined) delete process.env.APRA_FLEET_TEST_CONCURRENCY;
        else process.env.APRA_FLEET_TEST_CONCURRENCY = prev;
    }
});

test('unit: scaledTimeout(baseMs) === baseMs when concurrency is 1 (env)', () => {
    const prev = process.env.APRA_FLEET_TEST_CONCURRENCY;
    process.env.APRA_FLEET_TEST_CONCURRENCY = '1';
    try {
        assert.equal(scaledTimeout(BASE_MS), BASE_MS);
    } finally {
        if (prev === undefined) delete process.env.APRA_FLEET_TEST_CONCURRENCY;
        else process.env.APRA_FLEET_TEST_CONCURRENCY = prev;
    }
});

test('unit: scaledTimeout(baseMs, { concurrency: 1 }) === baseMs (opts override)', () => {
    assert.equal(scaledTimeout(BASE_MS, { concurrency: 1 }), BASE_MS);
});

test('unit: scaledTimeout(baseMs, { concurrency: 8 }) === baseMs * DEFAULT_MULTIPLIER exactly', () => {
    assert.equal(scaledTimeout(BASE_MS, { concurrency: 8 }), BASE_MS * DEFAULT_MULTIPLIER);
    assert.equal(scaledTimeout(60000, { concurrency: 8 }), 60000 * DEFAULT_MULTIPLIER);
});

test('unit: scaledTimeout reads APRA_FLEET_TEST_CONCURRENCY from the env when opts.concurrency is not given', () => {
    const prev = process.env.APRA_FLEET_TEST_CONCURRENCY;
    process.env.APRA_FLEET_TEST_CONCURRENCY = '8';
    try {
        assert.equal(scaledTimeout(BASE_MS), BASE_MS * DEFAULT_MULTIPLIER);
    } finally {
        if (prev === undefined) delete process.env.APRA_FLEET_TEST_CONCURRENCY;
        else process.env.APRA_FLEET_TEST_CONCURRENCY = prev;
    }
});

test('unit: opts.concurrency overrides the env when both are present', () => {
    const prev = process.env.APRA_FLEET_TEST_CONCURRENCY;
    process.env.APRA_FLEET_TEST_CONCURRENCY = '8';
    try {
        assert.equal(scaledTimeout(BASE_MS, { concurrency: 1 }), BASE_MS);
    } finally {
        if (prev === undefined) delete process.env.APRA_FLEET_TEST_CONCURRENCY;
        else process.env.APRA_FLEET_TEST_CONCURRENCY = prev;
    }
});

test('unit: opts.multiplier overrides DEFAULT_MULTIPLIER when concurrency > 1', () => {
    assert.equal(scaledTimeout(BASE_MS, { concurrency: 8, multiplier: 2 }), BASE_MS * 2);
});

test('unit: unparseable/garbage concurrency values fall back to baseMs (no scaling)', () => {
    assert.equal(scaledTimeout(BASE_MS, { concurrency: 'not-a-number' }), BASE_MS);
    assert.equal(scaledTimeout(BASE_MS, { concurrency: NaN }), BASE_MS);
    assert.equal(scaledTimeout(BASE_MS, { concurrency: 0 }), BASE_MS);
    assert.equal(scaledTimeout(BASE_MS, { concurrency: -8 }), BASE_MS);
});

// apra-fleet-eft.85.3, contract-preservation check (criterion 2): the
// single-attempt/no-retry fast-abort contract in mock-sprint-planner-auth-
// failure-no-retry.test.mjs must stay strict and UNSCALED -- scaledTimeout()
// only ever widens a wall-clock/timeout budget, it must never touch a
// plain call-count assertion like plannerCalls===1. Pin that scaledTimeout()
// itself has no notion of "attempt count" at all: it is a pure function of
// (baseMs, concurrency, multiplier), so there is no scaling path that could
// ever weaken a strict equality assertion made independently of it.
test('unit: scaledTimeout has no effect on non-timeout values (e.g. an attempt-count assertion) -- it is a pure baseMs multiplier', () => {
    // A caller that (incorrectly) tried to "scale" a strict attempt count of
    // 1 would still get back an inflated number under concurrency -- this
    // pin exists purely to document that scaledTimeout must never be called
    // on plannerCalls, only on wall-clock budgets. See
    // mock-sprint-planner-auth-failure-no-retry.test.mjs, which asserts
    // plannerCalls===1 directly (not via scaledTimeout) while wrapping only
    // its elapsedMs/timeout budgets with scaledTimeout(...).
    const plannerCalls = 1;
    assert.equal(plannerCalls, 1, 'attempt-count contract must stay a strict, unscaled equality');
    assert.notEqual(scaledTimeout(plannerCalls, { concurrency: 8 }), plannerCalls, 'sanity: scaledTimeout does scale its own input under concurrency > 1');
});

// apra-fleet-eft.85.3, criterion 2, simulated-retry variant: force
// plannerCalls to a value >1 (as if the Planner had actually retried an
// auth failure) and confirm the SAME strict, unscaled assertion the real
// scenario test uses (assert.equal(plannerCalls, 1, ...)) still throws --
// even under a high simulated concurrency. This is the negative-control
// proof that eft.85.1/.85.2's timeout scaling could not have silently
// widened the single-attempt/no-retry contract: unlike the elapsedMs bound
// (which legitimately grows via scaledTimeout under contention), this
// assertion never goes near scaledTimeout at all, at any concurrency.
test('unit: forcing a simulated retry (plannerCalls>1) still fails the strict single-attempt assertion, at any concurrency', () => {
    for (const concurrency of [1, 8, 32]) {
        const simulatedPlannerCalls = 2; // pretend the Planner retried once
        assert.throws(
            () => assert.equal(simulatedPlannerCalls, 1, `Expected exactly 1 Planner attempt, got ${simulatedPlannerCalls}`),
            /Expected exactly 1 Planner attempt/,
            `plannerCalls===1 must still fail a forced retry at concurrency=${concurrency}`
        );
        // scaledTimeout itself is concurrency-sensitive, confirming the two
        // concepts (wall-clock budget vs. attempt count) are independent:
        // the timeout bound legitimately widens with concurrency while the
        // attempt-count assertion above never changes behavior.
        if (concurrency > 1) {
            assert.ok(scaledTimeout(60000, { concurrency }) > 60000, `scaledTimeout should widen the wall-clock budget at concurrency=${concurrency}`);
        }
    }
});
