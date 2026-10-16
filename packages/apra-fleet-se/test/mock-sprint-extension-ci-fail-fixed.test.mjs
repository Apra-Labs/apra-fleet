import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCiGateMockSprint } from './helpers/ci-gate-mock-sprint.mjs';

// =============================================================================
// Sprint extension, full runner, CI FAIL then fixed: the first Finalization's
// CI run fails, so the barrier creates a P1 Fix-CI bead naming the run and
// the failing job, the sprint goes back through the cycle loop once, and the
// second Finalization's fresh CI run passes. Regression, Harvest and Publish
// run once, after the last barrier. Own bd recording ('extcifixed'): the
// extension issues bd commands of its own. ASCII only.
// =============================================================================

test('mock sprint: CI FAIL -> Fix-CI bead + one extension -> CI PASS on the second Finalization', { timeout: 300000 }, async () => {
    const { run, ciCalls, events, prBody } = await runCiGateMockSprint({
        tag: 'extcifixed',
        label: 'extcifixed',
        runs: ['fail', 'pass'],
        maxExtensions: 1,
    });
    assert.ok(!run.error, `sprint must not throw: ${run.error && run.error.stack}`);
    assert.deepEqual(ciCalls.filter((c) => c.startsWith('find-runs')), ['find-runs#0:fail', 'find-runs#1:pass'], ciCalls.join('\n'));
    assert.equal(run.dispatched.filter((d) => d.label === 'Final Review').length, 2, 'Final Review re-runs on the extended head');
    assert.ok(run.logs.some((l) => l.includes('Fix-CI bead')), run.logs.filter((l) => l.includes('Extension')).join('\n'));
    const regressions = events.filter((e) => e.startsWith('regression('));
    assert.equal(regressions.length, 1, 'Regression runs once, after the last barrier');
    assert.ok(events.indexOf('ci-settled#1') < events.indexOf(regressions[0]), 'the last barrier awaited the second CI run before Regression');
    assert.equal(events.filter((e) => e === 'pr-post').length <= 1, true);
    assert.ok(prBody && prBody.includes('Extension 1'), prBody);
    assert.ok(prBody.includes('build (os-b)'), prBody);
});
