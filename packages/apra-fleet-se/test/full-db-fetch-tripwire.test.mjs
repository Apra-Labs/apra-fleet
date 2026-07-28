import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkFullDbFetchLog, countFullDbFetches, FULL_DB_FETCH_CMD } from '../fleet-sprint/full-db-fetch-guard.mjs';
import { runOnce, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

// =============================================================================
// apra-fleet-eft.70.2 -- dispatch-safety-guard-style tripwire: a mock-sprint
// run's phase-tagged command log must show no duplicate full-DB
// (`bd list --all --limit 0 --json`) fetch within a single phase step, and
// no unscoped `--all`/`--limit 0`-shaped `bd list` command anywhere on the
// hot path other than that single documented, cache-backed call site (see
// fleet-sprint/full-db-fetch-guard.mjs and runner.js's fetchAllBeadsShared()/
// allBeadsSnapshot for the implementation apra-fleet-eft.70.1 added).
//
// Mirrors dispatch-safety-guard.test.mjs's structure: the checker itself
// (checkFullDbFetchLog) is factored out into fleet-sprint/full-db-fetch-
// guard.mjs so it can be exercised against BOTH synthetic fixtures (proving
// it actually detects a regression, not just passing vacuously) and the real
// phase-tagged activity log a mock-sprint run produces.
// =============================================================================

test('checker: flags a duplicate full-DB fetch within the same phase step', () => {
    const log = [
        { phase: 'Develop', command: FULL_DB_FETCH_CMD },
        { phase: 'Develop', command: 'bd list --parent EPIC-1 --status=open --json' },
        // Regression: a second identical full fetch issued within the SAME
        // 'Develop' phase step -- exactly the coalescing failure
        // apra-fleet-eft.70.1 fixed (see runner.js's allBeadsSnapshot).
        { phase: 'Develop', command: FULL_DB_FETCH_CMD },
    ];
    const violations = checkFullDbFetchLog(log);
    assert.equal(violations.length, 1, `expected exactly 1 violation, got: ${JSON.stringify(violations)}`);
    assert.match(violations[0], /duplicate full-DB fetch at entry 2 \(phase "Develop"/);
});

test('checker: flags an unscoped full-list-shaped command whose text differs from the documented call site', () => {
    const log = [
        { phase: 'Plan', command: FULL_DB_FETCH_CMD },
        // Regression: a NEW, differently-shaped full-list call site (missing
        // --json, reordered flags) that bypasses the shared cache entirely.
        // Deliberately in a DIFFERENT phase than the entry above, so this
        // test isolates the "unexpected shape" violation from the separate
        // "duplicate within phase" rule exercised by the previous test.
        { phase: 'Review', command: 'bd list --limit 0 --all' },
    ];
    const violations = checkFullDbFetchLog(log);
    assert.equal(violations.length, 1, `expected exactly 1 violation, got: ${JSON.stringify(violations)}`);
    assert.match(violations[0], /unexpected text "bd list --limit 0 --all"/);
});

test('checker: a re-fetch within the SAME phase is allowed when an intervening bd mutation invalidated the cache (not a violation)', () => {
    // Mirrors a real sequence observed in a mock-sprint run's Review phase:
    // a full fetch, then a reviewer-driven `bd update --status=open` reopen
    // (a genuine beads mutation), then a second full fetch -- legitimate,
    // because the mutation invalidated the cached snapshot in between. A
    // naive "no repeat within the same phase LABEL" rule would misflag this.
    const log = [
        { phase: 'Review C1 R1', command: FULL_DB_FETCH_CMD },
        { phase: 'Review C1 R1', command: 'bd update BEAD-1 --status=open' },
        { phase: 'Review C1 R1', command: FULL_DB_FETCH_CMD },
    ];
    assert.deepEqual(checkFullDbFetchLog(log), []);
});

test('checker: a fresh full-DB fetch is allowed once per DISTINCT phase step (not a violation)', () => {
    const log = [
        { phase: 'Plan', command: FULL_DB_FETCH_CMD },
        { phase: 'Plan', command: 'bd list --status=open --json' },
        { phase: 'Develop', command: FULL_DB_FETCH_CMD },
        { phase: 'Develop', command: 'bd show EPIC-1 --json' },
        { phase: 'Review', command: FULL_DB_FETCH_CMD },
    ];
    assert.deepEqual(checkFullDbFetchLog(log), []);
    assert.equal(countFullDbFetches(log), 3);
});

test('checker: passes on an empty or fetch-free log (vacuous, but must not throw or false-positive)', () => {
    assert.deepEqual(checkFullDbFetchLog([]), []);
    assert.deepEqual(checkFullDbFetchLog([{ phase: 'Plan', command: 'git status' }]), []);
});

// =============================================================================
// Real regression tripwire: run an actual mock sprint end to end (the same
// runOnce() harness run1/run2 use in mock-sprint-happy-path.test.mjs) and
// assert its real, phase-tagged activityLog is fully compliant. This is what
// fails CI on a genuine reintroduction of full-DB polling in runner.js.
// =============================================================================

test('mock sprint: command log has no duplicate full-DB fetch per phase and no unscoped --all --limit 0 off the documented hot path', async () => {
    await withScenarioMarkers('full-db-fetch-tripwire', async () => {
        const run = await runOnce('fulldbfetchtripwire');

        assert.ok(run.result && run.result.status === 'success', `Mock sprint did not succeed: ${JSON.stringify(run.result)}`);
        assert.ok(Array.isArray(run.activityLog), 'runOnce() did not return an activityLog');

        // Sanity: the full-DB fetch call site genuinely fires (proves this
        // assertion isn't vacuously passing because nothing matched the
        // shape at all -- a real sprint run touches beads via bdListScoped()
        // many times across Plan/Develop/Review/Deploy/Integ/Harvest).
        const fetchCount = countFullDbFetches(run.activityLog);
        assert.ok(fetchCount > 0, `Expected at least one full-DB fetch in a real mock-sprint run, got activityLog: ${JSON.stringify(run.activityLog)}`);

        const violations = checkFullDbFetchLog(run.activityLog);
        assert.deepEqual(
            violations,
            [],
            `Found ${violations.length} full-DB-fetch tripwire violation(s) in a real mock-sprint run:\n${violations.join('\n')}\n` +
            `Full activityLog: ${JSON.stringify(run.activityLog, null, 2)}`
        );
    });
});
