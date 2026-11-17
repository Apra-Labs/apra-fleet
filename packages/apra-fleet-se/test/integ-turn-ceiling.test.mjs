import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCmd, runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

// =============================================================================
// apra-fleet-63x.4 (verification for apra-fleet-63x.3): pins the
// integ-test-runner dispatch's max_turns to the documented, defensible value
// runner.js's INTEG_TEST_MAX_TURNS was raised to (500, from a pre-fix 200,
// via an intermediate 300) -- see the apra-fleet-63x.3 commit's rationale
// comment just above that constant in runSprintCycle(). Across 4 historical runs, max_turns
// exhaustion during Integ Test was the norm rather than the exception
// (apra-fleet-63x), burning 15-85 minutes per occurrence in resume/repair; a
// ceiling that silently regresses back toward the pre-fix value would
// reintroduce that waste with no other signal (the dispatch would just look
// like a normal, slightly-shorter-lived call). This test dispatches through
// the real runner.js Integ Test phase code path (via the mock-sprint harness'
// integHandler seam) and fails if max_turns drifts from the intended value.
// =============================================================================

const closeAssignedDoer = async ({ opts, tempDir: td }) => {
    const match = opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
    const ids = match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
    const closedIds = [];
    for (const id of ids) {
        await runCmd(`bd close ${id}`, td);
        closedIds.push(id);
    }
    return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds, notes: 'Closed assigned beads.' }) }] };
};

const approveReviewer = async () => ({
    content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] }) }],
});

test('mock sprint: the integ-test-runner dispatch pins max_turns to the documented ceiling (500), not the pre-fix 200', async () => {
    await withScenarioMarkers('integturns', async () => {
        let capturedMaxTurns = null;
        let capturedLabel = null;
        const result = await runDevelopLoopScenario('integturns', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: integ turn-ceiling scenario work' }],
            maxCycles: 1,
            withRunbooks: true,
            doerHandler: closeAssignedDoer,
            reviewerHandler: approveReviewer,
            integHandler: async ({ opts }) => {
                capturedMaxTurns = opts.max_turns;
                capturedLabel = opts.label;
                return {
                    content: [{
                        text: JSON.stringify({
                            featuresClosed: 1,
                            issuesCreated: 0,
                            passed: true,
                            bugsFiled: [],
                            summary: 'All suites passed.',
                        }),
                    }],
                };
            },
        });

        assert.ok(!result.error, `Scenario should not throw: ${result.error ? result.error.message : ''}`);
        assert.ok(capturedMaxTurns !== null, `Expected the integ-test-runner dispatch to actually run, captured label: ${capturedLabel}`);
        // Pins the exact documented value (INTEG_TEST_MAX_TURNS = 500). This
        // assertion fails against the pre-fix value of 200, which is exactly
        // the regression this test guards.
        assert.strictEqual(
            capturedMaxTurns,
            500,
            `Expected the integ-test-runner dispatch max_turns to be pinned to 500 (the documented ceiling), got ${capturedMaxTurns}. ` +
            `A lower ceiling (e.g. the pre-fix 200) reintroduces the routine max_turns exhaustion apra-fleet-63x tracked.`
        );
    });
});

test('mock sprint: a resumed integ-test-runner dispatch (after max_turns exhaustion) doubles the ceiling from the documented base, not an arbitrary value', async () => {
    await withScenarioMarkers('integturnsresume', async () => {
        let integCalls = 0;
        const capturedMaxTurnsByCall = [];
        const result = await runDevelopLoopScenario('integturnsresume', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: integ turn-ceiling resume scenario work' }],
            maxCycles: 1,
            withRunbooks: true,
            doerHandler: closeAssignedDoer,
            reviewerHandler: approveReviewer,
            integHandler: async ({ opts }) => {
                integCalls++;
                capturedMaxTurnsByCall.push(opts.max_turns);
                if (integCalls === 1) {
                    // First dispatch exhausts its turn budget -- the routine
                    // apra-fleet-63x fault this ceiling exists to make rare.
                    return {
                        content: [{ text: 'stopped after max turns' }],
                        structuredContent: { isError: true, reason: 'max_turns_exhausted' },
                    };
                }
                return {
                    content: [{
                        text: JSON.stringify({
                            featuresClosed: 1,
                            issuesCreated: 0,
                            passed: true,
                            bugsFiled: [],
                            summary: 'All suites passed on resume.',
                        }),
                    }],
                };
            },
        });

        assert.ok(!result.error, `Scenario should not throw on a max_turns-exhausted integ dispatch: ${result.error ? result.error.message : ''}`);
        assert.ok(integCalls >= 2, `Expected the integ dispatch to be resumed after max_turns exhaustion (>=2 calls), got ${integCalls}`);
        assert.strictEqual(capturedMaxTurnsByCall[0], 500, `First integ dispatch should use the documented base ceiling of 500, got ${capturedMaxTurnsByCall[0]}`);
        assert.strictEqual(capturedMaxTurnsByCall[1], 1000, `Resumed integ dispatch should double the documented base ceiling (500 * 2 = 1000), got ${capturedMaxTurnsByCall[1]}`);
    });
});
