import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';
import { invalidateSyncRemoteCache, clearLastSyncedTip, clearTipProbeFailures } from '../fleet-sprint/dolt-sync.mjs';
import { SprintBlockedOnOperatorError, SprintPlanRejectedError } from '../fleet-sprint/errors.mjs';
import { PAUSED_AWAITING_DECISION } from '../fleet-sprint/decision-wait.mjs';

// =============================================================================
// Mock-sprint coverage for operator-blocked planning:
//   1/2. a BLOCKED planner (operator-ask notes, no decision object) stops the
//        plan loop: one planner dispatch, one decision bead, the run pauses;
//        once answered, Plan runs again with the answer in the planner
//        feedback. SPRINT_PLAN_REJECTED is never raised.
//   3.   all open work held by an open decision bead: zero planner dispatches
//        and a skip log line (typed outcome: this run has nothing to wait on).
//   4.   control: planner OK + reviewer CHANGES_NEEDED on unheld beads for 3
//        rounds still ends SPRINT_PLAN_REJECTED.
// =============================================================================

const check = (cond, msg) => assert.ok(cond, msg);
const resetSyncMemo = () => { invalidateSyncRemoteCache(); clearLastSyncedTip(); clearTipProbeFailures(); };
const reply = (obj) => ({ content: [{ text: JSON.stringify(obj) }] });
const NOTES = 'Planning needs the target environment chosen by an operator before the task DAG can be built.';
const ANSWER = 'Use the staging environment.';

const doerCloses = async ({ opts, runCmd, tempDir }) => {
    const m = opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
    const ids = m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
    for (const id of ids) await runCmd(`bd close ${id}`, tempDir);
    return reply({ status: 'VERIFY', closedIds: ids, notes: 'Done.' });
};
const approve = async () => reply({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] });

test('mock sprint: a BLOCKED planner files one decision, pauses (no re-plan, no plan rejection), and plans again with the answer', async () => {
    resetSyncMemo();
    await withScenarioMarkers('plan blocked on operator (pause + answer)', async () => {
        const seen = { states: [], pauses: [], plannerPrompts: [], reviewerCalls: 0, decisionBeadId: null, answerError: null };
        const scenario = await runDevelopLoopScenario('planblocked', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: build the thing' }],
            maxCycles: 1,
            plannerHandler: async ({ opts }) => {
                seen.plannerPrompts.push(opts.prompt);
                if (seen.plannerPrompts.length === 1) return reply({ status: 'BLOCKED', notes: NOTES });
                return reply({ status: 'OK', notes: 'Planned.' });
            },
            planReviewerHandler: async () => {
                seen.reviewerCalls += 1;
                return reply({ verdict: 'APPROVED', notes: 'ok', taskAssignments: [] });
            },
            onWorkflow: async (workflow, { runCmd, tempDir }) => {
                workflow.on('state', (e) => { if (e.namespace === 'decisions') seen.states.push(e.data); });
                workflow.on('pause:requested', (e) => {
                    seen.pauses.push(e);
                    if (e.source !== 'needs_decision' || seen.pauses.length > 1) return;
                    const data = seen.states.filter((d) => d.state === PAUSED_AWAITING_DECISION).pop();
                    seen.decisionBeadId = data.pending[0].decisionBeadId;
                    seen.question = data.pending[0].question;
                    (async () => {
                        await runCmd(`bd human respond ${seen.decisionBeadId} -r "${ANSWER}"`, tempDir);
                        await workflow.requestResume('operator Resume after bd human respond');
                    })().catch((err) => { seen.answerError = err; });
                });
            },
            doerHandler: doerCloses,
            reviewerHandler: approve,
        });
        check(!seen.answerError, `answering failed: ${seen.answerError && seen.answerError.message}`);
        const errName = scenario.error ? `${scenario.error.constructor.name}: ${scenario.error.message}` : 'none';
        check(!(scenario.error instanceof SprintPlanRejectedError), `never a plan rejection: ${errName}`);
        check(!scenario.error || scenario.error.code !== 'SPRINT_PLAN_REJECTED', errName);

        // One decision bead (decision type, deferred, the planner notes as the question).
        assert.equal(seen.pauses.filter((p) => p.source === 'needs_decision').length, 1, 'paused once');
        check(seen.decisionBeadId, 'a decision bead was filed');
        assert.equal(seen.question, NOTES);
        const decisionBeads = [...scenario.finalBeadsById.values()].filter((b) => b.issue_type === 'decision');
        assert.equal(decisionBeads.length, 1, 'exactly one decision bead');
        assert.equal(decisionBeads[0].id, seen.decisionBeadId);
        check(String(decisionBeads[0].description || '').includes(NOTES), 'the bead carries the planner notes as the question');

        // Planner: first dispatch blocked, no reviewer before the answer, second carries the answer.
        const planners = scenario.dispatched.filter((d) => d.agent === 'planner');
        assert.equal(planners.length, 2, 'one blocked dispatch, one after the answer');
        check(!planners[0].prompt.includes(ANSWER));
        check(planners[1].prompt.includes(ANSWER), 'the answer is in the planner feedback');
        const firstReviewer = scenario.dispatched.findIndex((d) => d.agent === 'plan-reviewer');
        const secondPlanner = scenario.dispatched.indexOf(planners[1]);
        check(firstReviewer === -1 || firstReviewer > secondPlanner, 'no plan-review before the answer');
    });
});

test('mock sprint: all open work held by an open decision bead -- zero planner dispatches and a skip log line', async () => {
    resetSyncMemo();
    await withScenarioMarkers('plan skipped: all work operator-gated', async () => {
        const scenario = await runDevelopLoopScenario('planskipgated', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: held work' }],
            maxCycles: 1,
            beforeSprint: async ({ runCmd, tempDir, tasks }) => {
                const held = tasks[0].id;
                await runCmd(`bd create "Decision needed" -t decision -l human -s deferred --deps "discovered-from:${held}"`, tempDir);
            },
            doerHandler: doerCloses,
            reviewerHandler: approve,
        });
        assert.equal(scenario.dispatched.filter((d) => d.agent === 'planner').length, 0, 'no planner dispatched');
        assert.equal(scenario.dispatched.filter((d) => d.agent === 'doer').length, 0, 'no doer either');
        check(scenario.logs.some((l) => l.includes('skipped: all remaining work waits on operator decisions')), 'skip line logged');
        check(scenario.error instanceof SprintBlockedOnOperatorError, `typed blocked-on-operator outcome: ${scenario.error && scenario.error.message}`);
        assert.equal(scenario.error.code, 'SPRINT_BLOCKED_ON_OPERATOR');
    });
});

test('mock sprint (control): planner OK + reviewer CHANGES_NEEDED on unheld beads for 3 rounds still ends SPRINT_PLAN_REJECTED', async () => {
    resetSyncMemo();
    await withScenarioMarkers('plan rejection control', async () => {
        const scenario = await runDevelopLoopScenario('planrejectctl', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: alpha' }, { title: 'Task: beta' }],
            maxCycles: 1,
            plannerHandler: async () => reply({ status: 'OK', notes: 'Planned.' }),
            planReviewerHandler: async ({ tempDir, runCmd, epicBead }) => {
                const list = JSON.parse((await runCmd(`bd list --parent ${epicBead.id} --json`, tempDir)).stdout || '[]');
                return reply({
                    verdict: 'CHANGES_NEEDED',
                    notes: `${list.map((b) => b.id).join(' ')} are not decomposed enough.`,
                    taskAssignments: list.map((b) => ({ id: b.id, bucket: 'S', model: 'standard' })),
                });
            },
            doerHandler: doerCloses,
            reviewerHandler: approve,
        });
        check(scenario.error instanceof SprintPlanRejectedError, `plan rejection: ${scenario.error && scenario.error.message}`);
        assert.equal(scenario.error.code, 'SPRINT_PLAN_REJECTED');
        assert.equal(scenario.dispatched.filter((d) => d.agent === 'planner').length, 3);
    });
});
