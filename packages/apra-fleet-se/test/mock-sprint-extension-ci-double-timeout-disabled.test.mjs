import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCiGateMockSprint } from './helpers/ci-gate-mock-sprint.mjs';

// =============================================================================
// Sprint extension, full runner: a CI TIMEOUT that times out again on its one
// retry is treated like a CI FAIL -- an extension trigger. With
// max_extensions 0 (extensions disabled) the sprint must reproduce the
// pre-extension behaviour: no Fix-CI bead, no extra cycle, the verdict
// unchanged -- and say loudly, in the log and the PR body, that the trigger
// was left open and why. (With extensions enabled the same trigger writes the
// Fix-CI bead and re-enters the cycle loop; that path needs a new bd stream
// and is covered at unit level by sprint-extension.test.mjs.) Reuses the
// 'regressiongreen' bd recording. ASCII only.
// =============================================================================

test('mock sprint: CI TIMEOUT twice with max_extensions 0 -> treated like FAIL, but no extension, stated loudly', { timeout: 300000 }, async () => {
    const { run, ciCalls, prBody } = await runCiGateMockSprint({
        label: 'regressiongreen-ci-double-timeout-disabled',
        runs: ['timeout', 'timeout'],
        ciGate: { workflow: 'ci.yml', timeout_s: 1 },
        maxExtensions: 0,
    });
    assert.ok(!run.error, `sprint must not throw: ${run.error && run.error.message}`);
    assert.equal(run.result.verdict, 'PASS', 'CI never changes the verdict');
    assert.equal(ciCalls.filter((c) => c.startsWith('branch-head')).length, 2, `one retry only: ${ciCalls.join(', ')}`);
    assert.ok(run.logs.some((l) => l.includes('CI TIMEOUT again on the retry; treating it like a CI FAIL')));
    assert.ok(run.logs.some((l) => l.includes('NOT extending the sprint (sprint extensions are disabled (max_extensions 0))')), run.logs.filter((l) => l.includes('Sprint Extension')).join('\n'));
    assert.ok(!run.logs.some((l) => l.includes('Fix-CI bead')), 'no Fix-CI bead was written');
    assert.equal(run.dispatched.filter((d) => d.label === 'Final Review').length, 1, 'one Final Review: no second Finalization');
    assert.ok(prBody && prBody.includes('### Sprint extensions'), prBody);
    assert.ok(prBody.includes('No further extension: sprint extensions are disabled (max_extensions 0)'), prBody);
    assert.ok(prBody.includes('Extensions used: 0 of at most 0.'), prBody);
    assert.ok(prBody.includes("CI gate: TIMEOUT -- workflow 'ci.yml' did NOT pass"), prBody);
});
