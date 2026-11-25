import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCmd, runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-eft.78.4 -- end-to-end mock-sprint (runSprintCycle()) coverage
// for the per-role round-resume wiring apra-fleet-eft.78.3 added to runner.js
// (createRoundSessionRegistry + the planner dispatch site; reviewers always
// start a fresh session each round). The unit-level guard logic is pinned by
// test/round-session-registry.test.mjs; this scenario exercises the REAL
// dispatch call sites through the full engine: warm within-cycle planner
// resume, a reviewer that is fresh every round, and a cross-cycle reset (a
// later cycle's first dispatch is fresh -- `resume: false`).
// =============================================================================

test('mock sprint: round-resume -- planner warm within-cycle resume, reviewer always fresh, reset fresh across cycles', async () => {
    await withScenarioMarkers('round-resume (warm within-cycle, fresh across cycles)', async () => {
        console.log('Running mock sprint scenario (round-resume: warm within-cycle, fresh across cycles)...');

        let plannerCalls = 0;
        let deployCalls = 0;

        const sc = await runDevelopLoopScenario('roundresumewarm', {
            members: ['local'],
            taskSpecs: [
                { title: 'Task: RR target A (reopened for warm resume)' },
                { title: 'Task: RR target B (blocked to force cycle 2)' },
            ],
            maxCycles: 2,
            withRunbooks: true,
            // Every planner dispatch (fresh cycle-1 plan AND the cycle-2
            // re-plan) returns a distinct session id, so the cross-cycle
            // assertion below is meaningful: cycle 2's planner dispatch must
            // NOT carry cycle 1's id forward.
            plannerHandler: async () => {
                plannerCalls++;
                return {
                    content: [{ text: `Planned round-resume scenario (planner call ${plannerCalls}).` }],
                    structuredContent: { sessionId: `sess-plan-c${plannerCalls}` },
                };
            },
            // Closes A; leaves B `blocked` (deferred, out of `--ready`) so
            // cycle 1 cannot complete (B still counts as open at goal
            // priority) and the sprint continues into a genuine cycle 2.
            doerHandler: async ({ opts, tempDir: td }) => {
                const match = opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
                const ids = match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
                const list = JSON.parse((await runCmd('bd list --json', td)).stdout || '[]');
                const bTask = list.find((b) => b.title.startsWith('Task: RR target B'));
                const closedIds = [];
                for (const id of ids) {
                    if (bTask && id === bTask.id) {
                        await runCmd(`bd update ${id} --status=blocked`, td);
                    } else {
                        await runCmd(`bd close ${id}`, td);
                        closedIds.push(id);
                    }
                }
                return {
                    content: [{
                        // Claims B closed too (the read-back disproves it), so B keeps the
                        // ordinary left-open retry instead of the VERIFY-no-change set-aside.
                        text: JSON.stringify({ status: 'VERIFY', closedIds: ids, notes: 'Closed A; blocked B to force a second cycle.' }),
                    }],
                };
            },
            // Round 1 (cycle 1): CHANGES_NEEDED on A, carrying a session id
            // the SAME cycle's round 2 must resume explicitly. Round 2
            // (cycle 1): approves -- this is the warm-resume round. Round 3+
            // (cycle 2's cross-cycle fresh re-review, once B closes via the
            // deploy side effect below): approves fresh.
            reviewerHandler: async ({ opts, tempDir: td, epicBead, reviewRound: rRound }) => {
                if (rRound === 1) {
                    const list = JSON.parse((await runCmd(`bd list --parent ${epicBead.id} --all --json`, td)).stdout || '[]');
                    const a = list.find((b) => b.title.startsWith('Task: RR target A'));
                    return {
                        content: [{
                            text: JSON.stringify({
                                verdict: 'CHANGES_NEEDED',
                                notes: `${a.id} needs a small fix, please address.`,
                                reopenIds: [a.id],
                                newTasks: [],
                            }),
                        }],
                        structuredContent: { sessionId: 'sess-rev-c1r1' },
                    };
                }
                if (rRound === 2) {
                    return {
                        content: [{
                            text: JSON.stringify({ verdict: 'APPROVED', notes: 'A looks good now.', reopenIds: [], newTasks: [] }),
                        }],
                        structuredContent: { sessionId: 'sess-rev-c1r2' },
                    };
                }
                return {
                    content: [{
                        text: JSON.stringify({ verdict: 'APPROVED', notes: 'Everything closed. Approved.', reopenIds: [], newTasks: [] }),
                    }],
                };
            },
            // Cycle 1's deploy call is a no-op; cycle 2's deploy call closes
            // B out-of-band (mirrors mock-sprint-exit-stale-approval.test.mjs),
            // which is what makes cycle 2's Develop/Review loop skip (no
            // ready beads) and fall into the "fresh re-review" path -- the
            // cross-cycle reviewer dispatch this scenario asserts on.
            deployHandler: async ({ tempDir: td }) => {
                deployCalls++;
                if (deployCalls === 2) {
                    const list = JSON.parse((await runCmd('bd list --all --json', td)).stdout || '[]');
                    const bTask = list.find((b) => b.title.startsWith('Task: RR target B'));
                    if (bTask) await runCmd(`bd close ${bTask.id}`, td);
                }
                return { content: [{ text: JSON.stringify({ deployed: true, notes: `Deploy call #${deployCalls}` }) }] };
            },
        });

        check(!sc.error, `Round-resume scenario should not error: ${sc.error ? sc.error.constructor.name + ': ' + sc.error.message : ''}`);
        check(
            sc.result && sc.result.status === 'success',
            `Expected the round-resume scenario to eventually succeed, got: ${JSON.stringify(sc.result)}`
        );

        const taskA = sc.tasks.find((t) => t.title.startsWith('Task: RR target A'));
        const taskB = sc.tasks.find((t) => t.title.startsWith('Task: RR target B'));
        check(sc.finalBeadsById.get(taskA.id)?.status === 'closed', `Expected A closed, got: ${JSON.stringify(sc.finalBeadsById.get(taskA.id))}`);
        check(sc.finalBeadsById.get(taskB.id)?.status === 'closed', `Expected B closed, got: ${JSON.stringify(sc.finalBeadsById.get(taskB.id))}`);

        // --- Reviewer: warm within-cycle resume, then fresh across cycles ---
        const reviewerDispatches = sc.dispatched.filter((d) => d.agent === 'reviewer' && d.label !== 'Final Review');
        // The fourth is the catch-up review of B before Final Review: B was
        // dispatched in cycle 1 and closed later outside any review round.
        check(
            reviewerDispatches.length === 4,
            `Expected exactly 4 non-final reviewer dispatches (cycle 1 R1+R2, cycle 2 fresh re-review, catch-up of B), got ${reviewerDispatches.length}: ` +
            `${JSON.stringify(reviewerDispatches.map((d) => ({ resume: d.resume })))}`
        );
        check(
            reviewerDispatches[3].prompt.includes(taskB.id) && !reviewerDispatches[3].prompt.includes(`${taskA.id},`),
            'Expected the fourth non-final reviewer dispatch to be the catch-up review of B',
        );
        check(
            reviewerDispatches[0].resume === false,
            `Expected reviewer round 1 (no prior round) to be fresh (resume=false), got resume=${JSON.stringify(reviewerDispatches[0].resume)}`
        );
        check(
            reviewerDispatches[1].resume === false,
            `Expected reviewer round 2 (SAME cycle as round 1) to be FRESH (resume=false) -- reviewers never resume across rounds, got resume=${JSON.stringify(reviewerDispatches[1].resume)}`
        );
        check(
            reviewerDispatches[2].resume === false,
            `Expected the cycle-2 cross-cycle re-review dispatch to be FRESH (resume=false), NOT cycle 1's 'sess-rev-c1r2', got resume=${JSON.stringify(reviewerDispatches[2].resume)}`
        );

        // --- Planner: fresh cycle-1 plan, fresh cycle-2 re-plan (NEVER
        //     resumes cycle 1's recorded session across the cycle boundary) ---
        const plannerDispatches = sc.dispatched.filter((d) => d.agent === 'planner' && !d.prompt.includes('Ready bead ids:'));
        check(
            plannerDispatches.length === 2,
            `Expected exactly 2 non-streak-assignment planner dispatches (cycle 1 + cycle 2 re-plan), got ${plannerDispatches.length}`
        );
        check(
            plannerDispatches[0].resume === false,
            `Expected the cycle-1 planner dispatch (no prior round) to be fresh (resume=false), got resume=${JSON.stringify(plannerDispatches[0].resume)}`
        );
        check(
            plannerDispatches[1].resume === false,
            `Expected the cycle-2 re-plan dispatch to be FRESH (resume=false), NOT cycle 1's recorded 'sess-plan-c1', got resume=${JSON.stringify(plannerDispatches[1].resume)}`
        );
    });
});
