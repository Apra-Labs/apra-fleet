import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCiGateMockSprint } from './helpers/ci-gate-mock-sprint.mjs';

// =============================================================================
// Sprint extension, full runner, max_extensions 0: a CI FAIL is an extension
// trigger, but with extensions disabled the sprint reproduces today's
// behaviour (apart from the barrier/regression reordering): no Fix-CI bead,
// no second cycle, no second Final Review, the verdict unchanged, and the PR
// body names the failing job and why no extension ran. Reuses the
// 'regressiongreen' bd recording. ASCII only.
// =============================================================================

test('mock sprint: CI FAIL with max_extensions 0 -> no extension, failing jobs and the reason stated', { timeout: 300000 }, async () => {
    const { run, ciCalls, events, prBody } = await runCiGateMockSprint({
        label: 'regressiongreen-ci-fail-disabled',
        runs: ['fail'],
        maxExtensions: 0,
    });
    assert.ok(!run.error, `sprint must not throw: ${run.error && run.error.message}`);
    assert.equal(run.result.verdict, 'PASS', 'CI never changes the verdict');
    assert.deepEqual(ciCalls, ['branch-head#0', 'find-runs#0:fail', 'list-jobs#0'], 'FAIL is not retried');
    assert.ok(events.indexOf('ci-settled#0') < events.findIndex((e) => e.startsWith('regression(')), 'the barrier awaited CI before Regression');
    assert.ok(run.logs.some((l) => l.includes('NOT extending the sprint (sprint extensions are disabled (max_extensions 0))') && l.includes('failing jobs: build (os-b)')),
        run.logs.filter((l) => l.includes('Sprint Extension')).join('\n'));
    assert.equal(run.dispatched.filter((d) => d.label === 'Final Review').length, 1);
    assert.ok(!run.logs.some((l) => l.includes('Fix-CI bead')));
    assert.ok(prBody && prBody.includes('No further extension: sprint extensions are disabled (max_extensions 0)'), prBody);
    assert.ok(prBody.includes("CI gate: FAIL -- workflow 'ci.yml' did NOT pass"), prBody);
    assert.ok(prBody.includes('build (os-b)=failure'), prBody);
});
