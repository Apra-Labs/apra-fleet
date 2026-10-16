import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCiGateMockSprint } from './helpers/ci-gate-mock-sprint.mjs';

// =============================================================================
// Sprint extension, full runner, in-goal Final Review finding: the first
// Final Review FAILs with a P1 newTask (inside the P1/P2 goal), CI passes.
// The finding becomes a bead, the sprint extends once to work it, and the
// second Finalization's fresh Final Review PASSes. Own bd recording
// ('extfrgoal'). ASCII only.
// =============================================================================

test('mock sprint: in-goal Final Review finding -> one extension -> Final Review PASS', { timeout: 300000 }, async () => {
    const { run, ciCalls, events, prBody } = await runCiGateMockSprint({
        tag: 'extfrgoal',
        label: 'extfrgoal',
        runs: ['pass'],
        maxExtensions: 1,
        finalReviews: [
            { verdict: 'FAIL', notes: 'One in-goal gap found.', newTasks: [{ title: 'Handle the empty-input case in the widget parser', description: 'The parser throws on empty input; it must return an empty result.', priority: 'P1', dedupCheck: { query: 'widget parser empty input', candidateIds: [], verdict: 'no-overlap' } }] },
            { verdict: 'PASS', notes: 'All goal-priority beads closed, last review APPROVED.' },
        ],
    });
    assert.ok(!run.error, `sprint must not throw: ${run.error && run.error.stack}`);
    assert.equal(run.dispatched.filter((d) => d.label === 'Final Review').length, 2, 'Final Review re-runs on the extended head');
    assert.equal(ciCalls.filter((c) => c.startsWith('find-runs')).length, 2, 'each Finalization starts its own CI run');
    assert.ok(!run.logs.some((l) => l.includes('Fix-CI bead')), 'a passing CI creates no Fix-CI bead');
    assert.equal(events.filter((e) => e.startsWith('regression(')).length, 1, 'Regression runs once, after the last barrier');
    assert.equal(run.result.verdict, 'PASS', run.logs.filter((l) => l.includes('Extension')).join('\n'));
    assert.ok(prBody && prBody.includes('Extension 1'), prBody);
});
