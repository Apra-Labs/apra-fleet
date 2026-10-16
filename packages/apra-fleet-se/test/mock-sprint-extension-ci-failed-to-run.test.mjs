import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCiGateMockSprint } from './helpers/ci-gate-mock-sprint.mjs';

// =============================================================================
// Sprint extension, full runner: CI FAILED-TO-RUN (here: the credential lacks
// the permission to read workflow runs) is not something a code change can
// fix, so it NEVER triggers an extension -- even with extensions enabled
// (default max_extensions 1). It is logged loudly and stated in the PR body.
// Reuses the 'regressiongreen' bd recording. ASCII only.
// =============================================================================

test('mock sprint: CI FAILED-TO-RUN -> no extension (default max_extensions), loud log and PR body line', { timeout: 300000 }, async () => {
    const { run, ciCalls, prBody } = await runCiGateMockSprint({
        label: 'regressiongreen-ci-failed-to-run',
        runs: ['forbidden'],
    });
    assert.ok(!run.error, `sprint must not throw: ${run.error && run.error.message}`);
    assert.equal(run.result.verdict, 'PASS');
    assert.deepEqual(ciCalls, ['branch-head#0', 'find-runs#0:forbidden'], 'no retry for FAILED-TO-RUN');
    assert.ok(run.logs.some((l) => l.includes('[Sprint Extension] ERROR: CI FAILED-TO-RUN') && l.includes('does NOT trigger a sprint extension')), run.logs.filter((l) => l.includes('Extension')).join('\n'));
    assert.ok(!run.logs.some((l) => /Extension \d+ of at most/.test(l)), 'no extension ran');
    assert.equal(run.dispatched.filter((d) => d.label === 'Final Review').length, 1);
    assert.ok(prBody && prBody.includes('CI FAILED-TO-RUN cannot be fixed by a code change, so it did not trigger a sprint extension.'), prBody);
    assert.ok(prBody.includes("CI gate: FAILED-TO-RUN -- workflow 'ci.yml' did NOT pass"), prBody);
});
