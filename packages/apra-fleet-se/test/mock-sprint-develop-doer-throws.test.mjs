import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCmd, runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-unw.16 acceptance criterion 2: doer failure isolation + retry
// =============================================================================
// One task's doer ALWAYS throws (both the original dispatch and the
// one retry); a sibling, independent task's doer succeeds normally.
// Expect: (a) engine.executeFile() still resolves (parallel()'s
// continueOnError:true isolates the failing streak instead of aborting
// the whole cycle), (b) the sibling bead closes normally, (c) the
// failing bead's doer was dispatched exactly twice (original + one
// retry, no more), (d) the failing bead never closes.
test('mock sprint: a doer that always throws is isolated; sibling streak still completes', async () => {
    await withScenarioMarkers('isolation (doer streak throws)', async () => {
        console.log('Running mock sprint scenario (doer streak throws, sibling completes)...');
        const isolation = await runDevelopLoopScenario('isolation', {
            members: ['local'],
            taskSpecs: [
                { title: 'Task: Always throws' },
                { title: 'Task: Always succeeds' },
            ],
            doerHandler: async ({ opts, tempDir: td, epicBead: epic }) => {
                const match = opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
                const ids = match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
                const listRes = JSON.parse((await runCmd('bd list --json', td)).stdout || '[]');
                const throwsTask = listRes.find((b) => b.title === 'Task: Always throws');
                if (throwsTask && ids.includes(throwsTask.id)) {
                    throw new Error(`mock doer failure for bead ${throwsTask.id}`);
                }
                for (const id of ids) {
                    await runCmd(`bd close ${id}`, td);
                }
                return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds: ids, notes: 'Closed successfully.' }) }] };
            },
            reviewerHandler: async () => ({
                content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved whatever closed.', reopenIds: [], newTasks: [] }) }]
            }),
        });
        check(!isolation.error, `Doer-failure-isolation scenario should not abort the whole sprint: ${isolation.error ? isolation.error.message : ''}`);
        // apra-fleet-unw.17 (A5/A6): the always-throwing bead never closes, so
        // it remains an open goal-priority bead at Finalization -- the
        // evidence-based final verdict now correctly reports FAIL (status:
        // 'failed') for this scenario instead of the old blanket 'success'.
        // The important property under test here is isolation (the sprint
        // resolves at all, rather than rejecting/throwing), not that an
        // unclosed bead is rubber-stamped as a pass.
        check(isolation.result && isolation.result.status === 'failed', `Doer-failure-isolation scenario should resolve with a FAIL verdict (one bead never closed): ${JSON.stringify(isolation.result)}`);
        const throwsTaskId = isolation.tasks.find((t) => t.title === 'Task: Always throws').id;
        const succeedsTaskId = isolation.tasks.find((t) => t.title === 'Task: Always succeeds').id;
        // The always-throwing bead is never closed, so it stays `ready` and is
        // re-picked up every subsequent dev round (the loop's own 3-round cap,
        // untouched by apra-fleet-unw.16 -- out of scope, see unw.17): 1
        // original + 1 retry per round, for 3 rounds = 6 total dispatches. The
        // key property under test isn't the absolute count but that it's an
        // exact multiple of 2 (every dispatch was retried exactly once, never
        // more, never left un-retried) and that the sibling only ever needed
        // one attempt.
        const throwsDispatchCount = isolation.dispatched.filter((d) => d.agent === 'doer' && d.prompt.includes(throwsTaskId)).length;
        check(throwsDispatchCount === 6, `Expected the always-throwing streak to be dispatched exactly 6 times (1 original + 1 retry, across 3 dev rounds), got ${throwsDispatchCount}`);
        const succeedsDispatchCount = isolation.dispatched.filter((d) => d.agent === 'doer' && d.prompt.includes(succeedsTaskId)).length;
        check(succeedsDispatchCount === 1, `Expected the sibling streak to be dispatched exactly once (no throw, no retry needed), got ${succeedsDispatchCount}`);
        check(
            isolation.finalBeadsById.get(succeedsTaskId) && isolation.finalBeadsById.get(succeedsTaskId).status === 'closed',
            `Expected sibling bead '${succeedsTaskId}' to be closed despite the sibling streak throwing, got: ${JSON.stringify(isolation.finalBeadsById.get(succeedsTaskId))}`
        );
        check(
            isolation.finalBeadsById.get(throwsTaskId) && isolation.finalBeadsById.get(throwsTaskId).status !== 'closed',
            `Expected the always-throwing bead '${throwsTaskId}' to remain open (never closed), got: ${JSON.stringify(isolation.finalBeadsById.get(throwsTaskId))}`
        );
        check(
            isolation.logs.some((m) => m.includes('Retrying once')),
            `Expected a "Retrying once" log line for the failed streak, logs: ${JSON.stringify(isolation.logs)}`
        );
    });
});
