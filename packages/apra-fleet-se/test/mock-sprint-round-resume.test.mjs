import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCmd, runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-eft.78.4 -- end-to-end mock-sprint (runSprintCycle()) coverage
// for the per-role round-resume wiring apra-fleet-eft.78.3 added to runner.js
// (createRoundSessionRegistry + the planner/reviewer dispatch sites). The
// unit-level guard logic itself is pinned cheaply by
// test/round-session-registry.test.mjs; these two scenarios exercise the
// REAL dispatch call sites through the full engine so a regression in the
// WIRING (not just the registry's own logic) is caught:
//   1. warm within-cycle resume (round 2 of a cycle carries round 1's
//      explicit session id) + cross-cycle reset (a later cycle's first
//      dispatch is fresh -- `resume: false` -- even though the prior cycle
//      recorded a session id for that same role).
//   2. on a session_not_found dispatch failure, the engine never re-sends
//      the short "continue where you left off" delta/continuation prompt --
//      every dispatch (including the same-round retry and the next round)
//      stays the full, self-contained buildReviewerPrompt() text, and the
//      NEXT round is a fresh session (not the poisoned explicit id),
//      asserted via the actual dispatched prompt content.
// =============================================================================

const REVIEWER_CONTINUATION_TEXT = 'Continue your review exactly where you left off';
// apra-fleet-s6d: buildReviewerPrompt has TWO full-prompt framings -- the
// per-bead one, and the scope-wide one used by the Cycle Evaluation re-review
// (which legitimately has no bead ids to name). Either satisfies this test's
// actual invariant: "self-contained prompt, not the continuation delta".
const FULL_REVIEWER_PROMPT_MARKERS = [
    'Full task detail (including acceptance criteria), from `bd show --json`:',
    'The full sprint scope, from `bd list --json`:',
];

test('mock sprint: round-resume -- reviewer/planner warm within-cycle resume, reset fresh across cycles', async () => {
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
                        text: JSON.stringify({ status: 'VERIFY', closedIds, notes: 'Closed A; blocked B to force a second cycle.' }),
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
        check(
            reviewerDispatches.length === 3,
            `Expected exactly 3 non-final reviewer dispatches (cycle 1 R1+R2, cycle 2 fresh re-review), got ${reviewerDispatches.length}: ` +
            `${JSON.stringify(reviewerDispatches.map((d) => ({ resume: d.resume })))}`
        );
        check(
            reviewerDispatches[0].resume === false,
            `Expected reviewer round 1 (no prior round) to be fresh (resume=false), got resume=${JSON.stringify(reviewerDispatches[0].resume)}`
        );
        check(
            reviewerDispatches[1].resume === 'sess-rev-c1r1',
            `Expected reviewer round 2 (SAME cycle as round 1) to resume round 1's explicit session id 'sess-rev-c1r1', got resume=${JSON.stringify(reviewerDispatches[1].resume)}`
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

test('mock sprint: round-resume -- on session_not_found the engine never re-sends the delta prompt and the next round is fresh', async () => {
    await withScenarioMarkers('round-resume (session_not_found -> full prompt, fresh next round)', async () => {
        console.log('Running mock sprint scenario (round-resume: session_not_found handling)...');

        const sc = await runDevelopLoopScenario('roundresumesnf', {
            members: ['local'],
            taskSpecs: [
                { title: 'Task: RR-SNF target X' },
            ],
            // maxCycles=2: cycle 1's review round fails via session_not_found
            // (never reopens X, since a dispatch failure is not a reviewer
            // verdict), so cycle 1 cannot exit; cycle 2 has no ready beads
            // (X already closed) and dispatches a fresh re-review that
            // finally approves and lets the sprint complete.
            maxCycles: 2,
            reviewerHandler: async ({ opts, tempDir: td, epicBead, reviewRound: rRound }) => {
                if (rRound === 1) {
                    const list = JSON.parse((await runCmd(`bd list --parent ${epicBead.id} --all --json`, td)).stdout || '[]');
                    const x = list.find((b) => b.title.startsWith('Task: RR-SNF target X'));
                    return {
                        content: [{
                            text: JSON.stringify({
                                verdict: 'CHANGES_NEEDED',
                                notes: `${x.id} needs a small fix, please address.`,
                                reopenIds: [x.id],
                                newTasks: [],
                            }),
                        }],
                        structuredContent: { sessionId: 'sess-r1' },
                    };
                }
                // Rounds 2+ within cycle 1: the ONLY session ever recorded is
                // 'sess-r1' (round 1's), so ANY dispatch that carries it
                // explicitly (round 2's first attempt AND its same-round
                // retry -- runner.js recomputes `resume` once per ROUND, not
                // per attempt) is answered with a TERMINAL session_not_found,
                // exactly like execute_prompt's real semantics for an
                // explicit id that cannot be resumed (apra-fleet-eft.78.1).
                if (opts.resume === 'sess-r1') {
                    return {
                        content: [{ text: 'session not found' }],
                        structuredContent: { isError: true, reason: 'session_not_found', sessionId: 'sess-r1' },
                    };
                }
                // The cycle-2 fresh re-review (resume must be false by now):
                // approves and lets the sprint finish.
                return {
                    content: [{
                        text: JSON.stringify({ verdict: 'APPROVED', notes: 'X looks good.', reopenIds: [], newTasks: [] }),
                    }],
                };
            },
        });

        check(!sc.error, `session_not_found scenario should not error: ${sc.error ? sc.error.constructor.name + ': ' + sc.error.message : ''}`);
        check(
            sc.result && sc.result.status === 'success',
            `Expected the sprint to still complete successfully after a session_not_found round degrades to CHANGES_NEEDED, got: ${JSON.stringify(sc.result)}`
        );

        const taskX = sc.tasks.find((t) => t.title.startsWith('Task: RR-SNF target X'));
        check(sc.finalBeadsById.get(taskX.id)?.status === 'closed', `Expected X closed, got: ${JSON.stringify(sc.finalBeadsById.get(taskX.id))}`);

        const reviewerDispatches = sc.dispatched.filter((d) => d.agent === 'reviewer' && d.label !== 'Final Review');
        check(
            reviewerDispatches.length === 4,
            `Expected exactly 4 non-final reviewer dispatches (R1, R2 attempt 1, R2 attempt 2 (same-round retry), cycle-2 fresh re-review), got ${reviewerDispatches.length}: ` +
            `${JSON.stringify(reviewerDispatches.map((d) => ({ resume: d.resume })))}`
        );
        check(reviewerDispatches[0].resume === false, `Expected round 1 to be fresh, got resume=${JSON.stringify(reviewerDispatches[0].resume)}`);
        check(
            reviewerDispatches[1].resume === 'sess-r1' && reviewerDispatches[2].resume === 'sess-r1',
            `Expected BOTH the failing dispatch and its same-round retry to carry round 1's explicit session id 'sess-r1' (never silently dropped), got resume=${JSON.stringify([reviewerDispatches[1].resume, reviewerDispatches[2].resume])}`
        );
        check(
            reviewerDispatches[3].resume === false,
            `Expected the round AFTER the session_not_found failure to be a FRESH session (resume=false), not a resume of the now-dead 'sess-r1', got resume=${JSON.stringify(reviewerDispatches[3].resume)}`
        );

        // The core engine-level assertion: NOT ONE of these dispatches --
        // including the two that failed with session_not_found and the
        // fresh round that followed -- is ever the short "continue where you
        // left off" delta/continuation prompt (dispatchReviewerResume's text,
        // reserved for the max_turns_exhaustion in-dispatch-continuation
        // case, orthogonal to round-resume). Every one of them is the full,
        // self-contained buildReviewerPrompt() text.
        for (const d of reviewerDispatches) {
            check(
                !d.prompt.includes(REVIEWER_CONTINUATION_TEXT),
                `Reviewer dispatch (resume=${JSON.stringify(d.resume)}) must never be the delta/continuation prompt: ${d.prompt.slice(0, 120)}`
            );
            check(
                FULL_REVIEWER_PROMPT_MARKERS.some((m) => d.prompt.includes(m)),
                `Reviewer dispatch (resume=${JSON.stringify(d.resume)}) must be the full self-contained prompt: ${d.prompt.slice(0, 120)}`
            );
        }

        // The dispatch-failure path logged the round as a degraded
        // CHANGES_NEEDED rather than silently swallowing or crashing on it.
        check(
            sc.logs.some((l) => l.includes('Reviewer: agent dispatch failed') && l.includes('session_not_found')),
            `Expected a logged 'Reviewer: agent dispatch failed' line naming session_not_found, logs: ${JSON.stringify(sc.logs.filter((l) => l.includes('Reviewer')))}`
        );
    });
});
