import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCiGateMockSprint, CI_SHA } from './helpers/ci-gate-mock-sprint.mjs';

// =============================================================================
// Sprint extension, full runner: a CI TIMEOUT at the Finalization barrier is
// retried ONCE on the same commit; the retry PASSes, so there is no extension
// (no Fix-CI bead, no extra cycle) and the PR body reports the retry's PASS.
// Reuses the 'regressiongreen' bd recording (see the helper's header): no bd
// command beyond that stream is issued. ASCII only.
// =============================================================================

test('mock sprint: CI TIMEOUT -> one retry on the same commit -> PASS: no extension', { timeout: 300000 }, async () => {
    const { run, ciCalls, events, prBody } = await runCiGateMockSprint({
        label: 'regressiongreen-ci-timeout-retry',
        runs: ['timeout', 'pass'],
        ciGate: { workflow: 'ci.yml', timeout_s: 1 },
    });
    assert.ok(!run.error, `sprint must not throw: ${run.error && run.error.message}`);
    assert.equal(run.result.verdict, 'PASS');
    assert.deepEqual(ciCalls.filter((c) => c.startsWith('branch-head')), ['branch-head#0', 'branch-head#1'], `exactly one retry: ${ciCalls.join(', ')}`);
    assert.ok(run.logs.some((l) => l.includes('[CI Gate] ERROR: TIMEOUT')), 'the first run timed out loudly');
    assert.ok(run.logs.some((l) => l.includes('retrying the CI gate once on the same commit')));
    assert.ok(run.logs.some((l) => l.includes('[CI Gate] PASS')), 'the retry passed');
    assert.ok(events.indexOf('ci-settled#1') < events.findIndex((e) => e.startsWith('regression(')), 'the barrier waited for the retry before Regression');
    assert.ok(!run.logs.some((l) => /Extension \d+ of at most/.test(l)), 'no extension ran');
    assert.ok(prBody && prBody.includes("CI gate: PASS -- workflow 'ci.yml'."), prBody);
    assert.ok(prBody.includes(`CI ran on commit: ${CI_SHA}`), 'the retry ran on the same commit');
    assert.ok(!prBody.includes('### Sprint extensions'), prBody);
});
