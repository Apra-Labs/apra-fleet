import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCmd, sleep, runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-eft.8.3 -- doer streak dispatch is GLOBALLY sequential across
// members, not just serialized per-member.
//
// Prior to this bead, `memberLocks` only chained streaks assigned to the
// SAME member; two streaks assigned to DIFFERENT members (e.g. an x86 +
// ARM64 hand-off) were dispatched concurrently by `parallel()`. That breaks
// the fast-forward-by-construction invariant the git/beads sync brackets
// (apra-fleet-eft.8.1/8.2/9.1) depend on: a second member G-pulling and
// beginning its own dispatch before the first member's G-push has landed can
// diverge the shared branch.
//
// `globalDoerTurn` in runner.js replaces the per-member lock chain with a
// single process-wide FIFO queue every doer streak -- regardless of which
// member it targets -- chains onto in dispatch order, so at most one doer
// streak is ever "in flight" (from acquiring its turn to the `finally`
// releasing it) at a time.
// =============================================================================

test('doer streaks assigned to DIFFERENT members execute strictly one-after-another (no overlapping dispatch windows)', async () => {
    await withScenarioMarkers('global sequencing (different members)', async () => {
        let active = 0;
        let maxActive = 0;
        const dispatchMembers = [];

        const doerHandler = async ({ opts, tempDir: td }) => {
            const match = opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
            const ids = match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];

            active += 1;
            maxActive = Math.max(maxActive, active);
            dispatchMembers.push(opts.member_name);
            try {
                // Artificial delay so that, absent the global gate, a second
                // streak dispatched concurrently would overlap this window
                // and be observed by the `active` counter above.
                await sleep(30);
                for (const id of ids) {
                    await runCmd(`bd close ${id}`, td);
                }
                return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds: ids, notes: 'Closed successfully.' }) }] };
            } finally {
                active -= 1;
            }
        };

        const result = await runDevelopLoopScenario('globalseqdiff', {
            members: ['member-x86', 'member-arm64'],
            taskSpecs: [
                { title: 'Task: Streak on member A' },
                { title: 'Task: Streak on member B' },
            ],
            doerHandler,
            reviewerHandler: async () => ({
                content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] }) }]
            }),
        });

        check(!result.error, `Scenario should not abort: ${result.error ? result.error.message : ''}`);
        check(maxActive <= 1, `Expected at most one doer streak in flight at a time (global gate), observed max concurrency of ${maxActive}`);

        const doerMembersUsed = new Set(
            result.dispatched.filter((d) => d.agent === 'doer').map((d) => d.member)
        );
        check(
            doerMembersUsed.size === 2,
            `Expected the two streaks to have actually been assigned to two DIFFERENT members (proving this test exercises the cross-member case, not a same-member fallback), got: ${JSON.stringify([...doerMembersUsed])}`
        );

        for (const task of result.tasks) {
            const bead = result.finalBeadsById.get(task.id);
            check(bead && bead.status === 'closed', `Expected task '${task.id}' to be closed, got: ${JSON.stringify(bead)}`);
        }
    });
});

test('doer streaks assigned to the SAME member still serialize (global gate is strictly stronger than per-member)', async () => {
    await withScenarioMarkers('global sequencing (same member)', async () => {
        let active = 0;
        let maxActive = 0;

        const doerHandler = async ({ opts, tempDir: td }) => {
            const match = opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
            const ids = match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];

            active += 1;
            maxActive = Math.max(maxActive, active);
            try {
                await sleep(30);
                for (const id of ids) {
                    await runCmd(`bd close ${id}`, td);
                }
                return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds: ids, notes: 'Closed successfully.' }) }] };
            } finally {
                active -= 1;
            }
        };

        const result = await runDevelopLoopScenario('globalseqsame', {
            members: ['solo-member'],
            taskSpecs: [
                { title: 'Task: Streak one' },
                { title: 'Task: Streak two' },
            ],
            doerHandler,
            reviewerHandler: async () => ({
                content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] }) }]
            }),
        });

        check(!result.error, `Scenario should not abort: ${result.error ? result.error.message : ''}`);
        check(maxActive <= 1, `Expected same-member streaks to still serialize, observed max concurrency of ${maxActive}`);
    });
});

test('the global doer gate is released on a thrown/failed streak (no deadlock on failure)', async () => {
    await withScenarioMarkers('global sequencing (no deadlock on failure)', async () => {
        const doerHandler = async ({ opts, tempDir: td }) => {
            const match = opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
            const ids = match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
            const listRes = JSON.parse((await runCmd('bd list --json', td)).stdout || '[]');
            const throwsTask = listRes.find((b) => b.title === 'Task: Always throws (global gate)');
            if (throwsTask && ids.includes(throwsTask.id)) {
                throw new Error(`mock doer failure for bead ${throwsTask.id}`);
            }
            for (const id of ids) {
                await runCmd(`bd close ${id}`, td);
            }
            return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds: ids, notes: 'Closed successfully.' }) }] };
        };

        // If the global gate were never released in the `finally` on the
        // failing streak's thrown-error path, the sibling streak (assigned
        // to a DIFFERENT member) would wait on `priorTurn` forever and this
        // `await engine.executeFile()` inside runDevelopLoopScenario would
        // hang -- this test resolving at all is itself part of the evidence
        // for "no deadlock", in addition to the explicit assertions below.
        const result = await runDevelopLoopScenario('globalseqfail', {
            members: ['member-x86', 'member-arm64'],
            taskSpecs: [
                { title: 'Task: Always throws (global gate)' },
                { title: 'Task: Always succeeds (global gate)' },
            ],
            doerHandler,
            reviewerHandler: async () => ({
                content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved whatever closed.', reopenIds: [], newTasks: [] }) }]
            }),
        });

        check(!result.error, `Scenario should not abort/hang: ${result.error ? result.error.message : ''}`);

        const throwsTaskId = result.tasks.find((t) => t.title === 'Task: Always throws (global gate)').id;
        const succeedsTaskId = result.tasks.find((t) => t.title === 'Task: Always succeeds (global gate)').id;

        // The sibling streak (on the other member) must have actually been
        // dispatched -- proof the gate was released, not leaked, by the
        // failing streak's thrown-error terminal path.
        const succeedsDispatchCount = result.dispatched.filter((d) => d.agent === 'doer' && d.prompt.includes(succeedsTaskId)).length;
        check(succeedsDispatchCount >= 1, `Expected the sibling streak to have been dispatched despite the other streak throwing, got ${succeedsDispatchCount} dispatch(es)`);

        check(
            result.finalBeadsById.get(succeedsTaskId) && result.finalBeadsById.get(succeedsTaskId).status === 'closed',
            `Expected the sibling bead '${succeedsTaskId}' to be closed, got: ${JSON.stringify(result.finalBeadsById.get(succeedsTaskId))}`
        );
        check(
            result.finalBeadsById.get(throwsTaskId) && result.finalBeadsById.get(throwsTaskId).status !== 'closed',
            `Expected the always-throwing bead '${throwsTaskId}' to remain open, got: ${JSON.stringify(result.finalBeadsById.get(throwsTaskId))}`
        );
    });
});
