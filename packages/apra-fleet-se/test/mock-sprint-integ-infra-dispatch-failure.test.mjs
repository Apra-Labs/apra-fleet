import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCmd, runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-04g.6: harden the integ-test-runner dispatch against
// INFRASTRUCTURE dispatch failures (empty_response, inactivity timeout /
// dispatch_failed, orphan_recovery_timeout) -- the exact faults that silently
// sank cycles C4 (empty_response) and C5 (3600000ms inactivity timeout).
//
// Before this fix, ANY AgentDispatchError from the integ dispatch (other than
// max_turns_exhausted) was recorded as a genuine passed:false test FAIL, so an
// infra fault -- where the member CLI never produced a test verdict at all --
// was indistinguishable from a real test failure and blocked the sprint's
// confidence check on nothing. The fix:
//   1. retries ONCE via a session resume (the run may have made real progress
//      and merely lost its result envelope), then
//   2. failing that, records the cycle as INCONCLUSIVE (never a false FAIL) so
//      the final reviewer/harvester can tell an infra fault apart from real
//      test evidence -- exactly as the part-2 stale-evidence path already does.
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

test('mock sprint: an integ dispatch empty_response is retried via resume and recovered -- never recorded as a FAIL', async () => {
    await withScenarioMarkers('integrecover', async () => {
        let integCalls = 0;
        const result = await runDevelopLoopScenario('integrecover', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: integ infra recover scenario work' }],
            maxCycles: 1,
            withRunbooks: true,
            doerHandler: closeAssignedDoer,
            reviewerHandler: approveReviewer,
            integHandler: async () => {
                integCalls++;
                if (integCalls === 1) {
                    // First dispatch: the member CLI exits 0 but never prints a
                    // result envelope -- the C4 empty_response fault.
                    return {
                        content: [{ text: 'exited 0 but produced no parseable output (empty result)' }],
                        structuredContent: { isError: true, reason: 'empty_response' },
                    };
                }
                // The resume recovers the real verdict.
                return {
                    content: [{ text: JSON.stringify({ featuresClosed: 1, issuesCreated: 0, passed: true, bugsFiled: [], summary: 'All suites passed on resume.' }) }],
                };
            },
        });

        check(!result.error, `Scenario should not throw on an integ infra dispatch failure: ${result.error ? result.error.message : ''}`);
        check(integCalls >= 2, `Expected the integ dispatch to be retried via resume (>=2 calls), got ${integCalls}`);
        check(
            result.logs.some((m) => m.includes('infrastructure dispatch failure (empty_response)') && m.includes('resuming the same session once to recover')),
            `Expected the infra-failure resume-retry log line, logs: ${JSON.stringify(result.logs)}`
        );
        check(
            !result.logs.some((m) => m.includes('Integration tests FAILED this cycle')),
            `An infra dispatch failure that recovers on resume must NOT be logged as a test FAILURE, logs: ${JSON.stringify(result.logs)}`
        );
        check(
            !result.logs.some((m) => m.includes('Integration tests INCONCLUSIVE this cycle')),
            `A recovered infra dispatch failure must NOT be recorded as INCONCLUSIVE, logs: ${JSON.stringify(result.logs)}`
        );
        check(
            !result.logs.some((m) => m.includes('treating as passed:false')),
            `An infra dispatch failure must never fall through to the generic passed:false handling, logs: ${JSON.stringify(result.logs)}`
        );
    });
});

test('mock sprint: an integ dispatch inactivity timeout that persists after resume is recorded INCONCLUSIVE, never a test FAIL', async () => {
    await withScenarioMarkers('integinconc', async () => {
        let integCalls = 0;
        const result = await runDevelopLoopScenario('integinconc', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: integ infra inconclusive scenario work' }],
            maxCycles: 1,
            withRunbooks: true,
            doerHandler: closeAssignedDoer,
            reviewerHandler: approveReviewer,
            integHandler: async () => {
                integCalls++;
                // Both the original dispatch AND the resume die on an inactivity
                // timeout -- the C5 fault. The member CLI never delivered a
                // test verdict on either attempt.
                return {
                    content: [{ text: 'command killed after inactivity timeout (no output)' }],
                    structuredContent: { isError: true, reason: 'dispatch_failed' },
                };
            },
        });

        check(!result.error, `Scenario should not throw when an infra dispatch failure persists: ${result.error ? result.error.message : ''}`);
        check(integCalls >= 2, `Expected the integ dispatch to be retried via resume before giving up (>=2 calls), got ${integCalls}`);
        check(
            result.logs.some((m) => m.includes('Integration tests INCONCLUSIVE this cycle') && m.includes('infra dispatch failure (dispatch_failed)')),
            `Expected the persisted infra failure to be recorded as INCONCLUSIVE, logs: ${JSON.stringify(result.logs)}`
        );
        check(
            result.logs.some((m) => m.includes('recording INCONCLUSIVE, NOT a test FAIL')),
            `Expected the outer-catch log distinguishing an infra fault from a test FAIL, logs: ${JSON.stringify(result.logs)}`
        );
        check(
            !result.logs.some((m) => m.includes('Integration tests FAILED this cycle')),
            `A persisted infra dispatch failure must NEVER be recorded as a genuine test FAILURE, logs: ${JSON.stringify(result.logs)}`
        );
        check(
            !result.logs.some((m) => m.includes('treating as passed:false')),
            `An infra dispatch failure must never fall through to the generic passed:false handling, logs: ${JSON.stringify(result.logs)}`
        );
    });
});

test('mock sprint: a genuine integ test FAIL (passed:false verdict) is still recorded as a real FAILURE, not INCONCLUSIVE', async () => {
    await withScenarioMarkers('integfail', async () => {
        const result = await runDevelopLoopScenario('integfail', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: integ real-fail scenario work' }],
            maxCycles: 1,
            withRunbooks: true,
            doerHandler: closeAssignedDoer,
            reviewerHandler: approveReviewer,
            integHandler: async () => ({
                // A real, well-formed pass/fail verdict of FAIL -- NOT an infra
                // failure. This must remain a genuine FAIL, proving the fix
                // narrowed only the infra-fault family.
                content: [{ text: JSON.stringify({ featuresClosed: 0, issuesCreated: 1, passed: false, bugsFiled: ['bug-x'], summary: 'e2e spec X failed.' }) }],
            }),
        });

        check(!result.error, `Scenario should not throw on a genuine integ FAIL: ${result.error ? result.error.message : ''}`);
        check(
            result.logs.some((m) => m.includes('Integration tests FAILED this cycle')),
            `A genuine passed:false verdict must still be recorded as a real test FAILURE, logs: ${JSON.stringify(result.logs)}`
        );
        check(
            !result.logs.some((m) => m.includes('Integration tests INCONCLUSIVE this cycle')),
            `A genuine test FAIL must NOT be misrecorded as INCONCLUSIVE, logs: ${JSON.stringify(result.logs)}`
        );
    });
});
