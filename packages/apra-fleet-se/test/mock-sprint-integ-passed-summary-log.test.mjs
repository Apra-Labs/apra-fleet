import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCmd, runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-4bg.1: verify the apra-fleet-4bg fix landed in commit 64dc5953 --
// the IntegTest phase (runner.js, ~line 7982) now logs a one-line PASSED
// summary on EVERY passed:true cycle (successful or no-op), not only on
// FAILED/infra-inconclusive cycles. Before the fix, a passed:true integResult
// produced ZERO Integ Test log output, making a silent contract violation
// (an agent that never touched its scope but still reported passed:true)
// indistinguishable from a genuinely clean cycle.
//
// This suite drives all three integResult branches through the same mock-
// sprint harness used by mock-sprint-integ-infra-dispatch-failure.test.mjs so
// the PASSED-branch assertion sits next to (and never regresses) the
// pre-existing FAILED/INCONCLUSIVE branches.
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

test('mock sprint: a passed:true integ cycle emits exactly one PASSED summary log line naming cycle, features closed, and bugs filed', async () => {
    await withScenarioMarkers('integpass', async () => {
        const result = await runDevelopLoopScenario('integpass', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: integ passed-summary scenario work' }],
            maxCycles: 1,
            withRunbooks: true,
            doerHandler: closeAssignedDoer,
            reviewerHandler: approveReviewer,
            integHandler: async () => ({
                // A well-formed, successful (no-op is equally valid) verdict --
                // NOT an infra failure -- exercising the `passed === true` else
                // branch at runner.js ~line 7986.
                content: [{ text: JSON.stringify({ featuresClosed: 2, issuesCreated: 1, passed: true, bugsFiled: [], summary: 'All suites passed; 2 features verified.' }) }],
            }),
        });

        check(!result.error, `Scenario should not throw on a passed:true integ cycle: ${result.error ? result.error.message : ''}`);

        const passedLines = result.logs.filter((m) => m.includes('Integration tests PASSED this cycle'));
        check(
            passedLines.length === 1,
            `Expected exactly one PASSED summary log line for the cycle, got ${passedLines.length}: ${JSON.stringify(result.logs)}`
        );
        const [passedLine] = passedLines;
        check(passedLine.includes('(C1)'), `Expected the PASSED summary to name the cycle tag (C1), got: ${passedLine}`);
        check(passedLine.includes('2 feature(s) closed'), `Expected the PASSED summary to report the feature-closed count, got: ${passedLine}`);
        check(passedLine.includes('1 bug(s) filed'), `Expected the PASSED summary to report the bug-filed count, got: ${passedLine}`);
        check(passedLine.includes('All suites passed; 2 features verified.'), `Expected the PASSED summary to include integResult.summary, got: ${passedLine}`);

        check(
            !result.logs.some((m) => m.includes('Integration tests FAILED this cycle')),
            `A passed:true cycle must never also log a FAILED line, logs: ${JSON.stringify(result.logs)}`
        );
        check(
            !result.logs.some((m) => m.includes('Integration tests INCONCLUSIVE this cycle')),
            `A passed:true cycle must never also log an INCONCLUSIVE line, logs: ${JSON.stringify(result.logs)}`
        );
    });
});

test('mock sprint: a passed:false integ verdict still logs the pre-existing FAILED line (no regression)', async () => {
    await withScenarioMarkers('integpassfail', async () => {
        const result = await runDevelopLoopScenario('integpassfail', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: integ passed-regression FAIL scenario work' }],
            maxCycles: 1,
            withRunbooks: true,
            doerHandler: closeAssignedDoer,
            reviewerHandler: approveReviewer,
            integHandler: async () => ({
                content: [{ text: JSON.stringify({ featuresClosed: 0, issuesCreated: 1, passed: false, bugsFiled: ['bug-y'], summary: 'e2e spec Y failed.' }) }],
            }),
        });

        check(!result.error, `Scenario should not throw on a genuine integ FAIL: ${result.error ? result.error.message : ''}`);
        check(
            result.logs.some((m) => m.includes('Integration tests FAILED this cycle')),
            `A genuine passed:false verdict must still be recorded as a real test FAILURE, logs: ${JSON.stringify(result.logs)}`
        );
        check(
            !result.logs.some((m) => m.includes('Integration tests PASSED this cycle')),
            `A passed:false cycle must never also log a PASSED summary line, logs: ${JSON.stringify(result.logs)}`
        );
    });
});

test('mock sprint: a persisted infra dispatch failure still logs the pre-existing INCONCLUSIVE line (no regression)', async () => {
    await withScenarioMarkers('integpassinconc', async () => {
        const result = await runDevelopLoopScenario('integpassinconc', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: integ passed-regression INCONCLUSIVE scenario work' }],
            maxCycles: 1,
            withRunbooks: true,
            doerHandler: closeAssignedDoer,
            reviewerHandler: approveReviewer,
            integHandler: async () => ({
                // Both the original dispatch AND the resume die on an
                // infrastructure fault -- the member CLI never delivers a test
                // verdict on either attempt, so this must land in the
                // integInfraInconclusive branch, not the passed:true branch.
                content: [{ text: 'command killed after inactivity timeout (no output)' }],
                structuredContent: { isError: true, reason: 'dispatch_failed' },
            }),
        });

        check(!result.error, `Scenario should not throw when an infra dispatch failure persists: ${result.error ? result.error.message : ''}`);
        check(
            result.logs.some((m) => m.includes('Integration tests INCONCLUSIVE this cycle') && m.includes('infra dispatch failure (dispatch_failed)')),
            `Expected the persisted infra failure to still be recorded as INCONCLUSIVE, logs: ${JSON.stringify(result.logs)}`
        );
        check(
            !result.logs.some((m) => m.includes('Integration tests PASSED this cycle')),
            `An INCONCLUSIVE cycle must never also log a PASSED summary line, logs: ${JSON.stringify(result.logs)}`
        );
    });
});
