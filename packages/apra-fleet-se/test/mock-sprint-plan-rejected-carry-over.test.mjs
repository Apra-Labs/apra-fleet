// =============================================================================
// End-to-end mock sprints for the plan-rejected carry-over exit: a plan the
// plan-reviewer never approves (every round CHANGES_NEEDED) after the run
// already closed work no longer aborts with SprintPlanRejectedError and only
// an abort note on the PR. The run goes on to Finalization -- Final Review,
// Regression, Harvest, Publish PR -- with each contested bead named with the
// plan-reviewer finding, and the verdict is forced FAIL while an
// at/above-goal bead is carried over.
//
// Seen live: cycle 1 closed a task, Integration Test filed a new P1 bug, and
// in cycle 2 the plan-reviewer rejected all three rounds on that bug (a plan
// with no task in it). The run ended "SprintPlanRejectedError: Plan phase for
// cycle 2 was not approved after 3 round(s)" with no Final Review,
// Regression, Harvest or Publish for the closed work.
//
// Scenarios:
//   (1) whole plan contested (no task in the plan) in cycle 2 after cycle 1
//       closed work: Finalization runs, FAIL, the PR body names the open bead
//       with the plan-reviewer finding;
//   (2) the post-deferral site: in cycle 2 the reviewer contests one of two
//       tasks, it is deferred, and its lane-mate is blocked behind it so the
//       ready set is empty -- same carry-over exit naming the deferred bead;
//   (3) zero closed this run: the post-deferral site still throws
//       SprintPlanRejectedError in cycle 1 (the whole-plan site's cycle-1
//       control lives unchanged in mock-sprint-plan-cap-deferral.test.mjs);
//   (4) a dispatch-failed last plan-review verdict after closed work still
//       throws PlanReviewDispatchFailedError.
//
// Reverting the runner.js carry-over change (planRejectedCarryOver and its
// two call sites) makes (1) and (2) fail with SprintPlanRejectedError.
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers, withStagedBodies } from './helpers/mock-sprint-harness.mjs';
import { SprintPlanRejectedError, PlanReviewDispatchFailedError } from '../fleet-sprint/errors.mjs';
import {
    invalidateSyncRemoteCache, clearLastSyncedTip, clearTipProbeFailures,
} from '../fleet-sprint/dolt-sync.mjs';

const resetSyncMemo = () => {
    invalidateSyncRemoteCache();
    clearLastSyncedTip();
    clearTipProbeFailures();
};
const assignedIds = (prompt) => {
    const match = prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
    return match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
};
const report = (obj) => ({ content: [{ text: JSON.stringify(obj) }] });
const approve = async () => report({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] });
const rubberStampPass = async () => report({ verdict: 'PASS', notes: 'Rubber-stamp PASS from the final reviewer.' });
const passingRegression = async () => report({
    passed: true, suitePassed: true, smokePassed: true, bugsFiled: [],
    summary: 'Mock regression pass.',
});
const closingDoer = async ({ opts, runCmd: rc, tempDir: td }) => {
    const ids = assignedIds(opts.prompt);
    for (const id of ids) await rc(`bd close ${id} --reason "Done"`, td);
    return report({ status: 'VERIFY', closedIds: ids, notes: 'Closed.' });
};
const errText = (run) => (run.error ? `${run.error.constructor.name}: ${run.error.message}` : 'none');
const publishedPrBody = (run) => withStagedBodies(run.commandLog).find((c) => c.includes('## Sprint verdict:'));
const PLAN_CARRY_OVER_EXIT = 'plan-rejected-carry-over';
const createdId = (out) => String(out.stdout || '').trim();

/**
 * An integ handler that, on its first dispatch only, files new P1 work under
 * the epic via `file(rc, td, epicBead)` (returning the new ids) and reports a
 * failed pass; every later dispatch reports nothing to verify.
 */
function filingInteg(file) {
    const filed = [];
    const handler = async ({ epicBead, runCmd: rc, tempDir: td }) => {
        if (filed.length > 0) {
            return report({ featuresClosed: 0, issuesCreated: 0, passed: true, bugsFiled: [], summary: 'Nothing to verify.' });
        }
        filed.push(...await file(rc, td, epicBead));
        return report({
            featuresClosed: 0, issuesCreated: filed.length, passed: false, bugsFiled: [...filed],
            summary: `Integration test filed ${filed.join(', ')}.`,
        });
    };
    return { handler, filed };
}

/**
 * A plan-reviewer handler that approves its first dispatch (cycle 1) and
 * answers every later one with `later(ctx)`.
 */
function approveFirstThen(later) {
    let calls = 0;
    return async (ctx) => {
        calls++;
        if (calls === 1) {
            return report({ verdict: 'APPROVED', notes: 'Plan approved.', taskAssignments: [] });
        }
        return later(ctx);
    };
}

function assertFinalizedWithCarryOver(run, { carriedIds, finding }) {
    assert.ok(!run.error, `no SprintPlanRejectedError with work closed this run: ${errText(run)}`);
    assert.equal(run.result.exitReason, PLAN_CARRY_OVER_EXIT, JSON.stringify(run.result));

    // Finalization ran: Final Review, Regression, Harvest, Publish PR.
    assert.ok(run.dispatched.some((d) => d.label === 'Final Review'), 'Final Review must be dispatched');
    assert.ok(run.dispatched.some((d) => d.agent === 'regression-test-runner'), 'Regression must be dispatched');
    assert.ok(run.dispatched.some((d) => d.agent === 'harvester'), 'Harvest must be dispatched');
    const body = publishedPrBody(run);
    assert.ok(body, 'Publish PR must run');

    // Verdict forced FAIL over the final reviewer's PASS.
    assert.equal(run.result.verdict, 'FAIL', JSON.stringify(run.result));
    assert.ok(body.includes('## Sprint verdict: FAIL'), body);
    assert.deepEqual(run.result.carryOver.map((e) => e.id), carriedIds);
    for (const e of run.result.carryOver) assert.ok(e.reason.includes(finding), e.reason);

    // The PR body names each contested bead with the plan-reviewer finding.
    assert.ok(body.includes('Carried over (') && body.includes('the plan-reviewer did not approve the plan'), body);
    for (const id of carriedIds) {
        assert.ok(body.includes(`${id} -- plan-reviewer finding: ${finding}`), `PR body must name ${id} with the finding:\n${body}`);
    }
}

test('(1) whole plan contested in cycle 2 after cycle 1 closed work: Finalization runs, FAIL, the open bead carried over with the finding', async () => {
    resetSyncMemo();
    await withScenarioMarkers('plan rejected carry-over (whole plan)', async () => {
        const FINDING = 'The open P1 bug has no task-type children and no in-repo change can meet it; a human must decide.';
        const integ = filingInteg(async (rc, td, epic) => [
            createdId(await rc(`bd create -t bug "Bug: budget cannot be met" -d "Filed by integration test." -p P1 --parent ${epic.id} --silent`, td)),
        ]);
        const run = await runDevelopLoopScenario('plrej-whole', {
            members: ['local'],
            goal: 'P1/P2',
            taskSpecs: [{ title: 'Task: closes in cycle one', priority: 'P1' }],
            maxCycles: 3,
            withRunbooks: true,
            withRegressionPlaybook: true,
            doerHandler: closingDoer,
            reviewerHandler: approve,
            finalReviewHandler: rubberStampPass,
            regressionHandler: passingRegression,
            integHandler: integ.handler,
            planReviewerHandler: approveFirstThen(async () => report({
                verdict: 'CHANGES_NEEDED',
                notes: FINDING,
                taskAssignments: [],
                findings: integ.filed.map((id) => ({ id, kind: 'feasibility', detail: FINDING })),
            })),
        });
        assert.equal(integ.filed.length, 1, `integ filed the bug: ${errText(run)}`);
        const [bug] = integ.filed;
        const task = run.tasks[0].id;
        assert.equal(run.finalBeadsById.get(task).status, 'closed', 'cycle 1 closed its task');
        assert.equal(run.dispatched.filter((d) => d.agent === 'plan-reviewer').length, 4, 'one approved C1 round plus three rejected C2 rounds');
        assertFinalizedWithCarryOver(run, { carriedIds: [bug], finding: FINDING });
    });
});

test('(2) contested bead deferred in cycle 2 leaving nothing ready, after cycle 1 closed work: Finalization runs, FAIL, the deferred bead carried over', async () => {
    resetSyncMemo();
    await withScenarioMarkers('plan rejected carry-over (post-deferral)', async () => {
        const FINDING = 'The first follow-up task has unmeasurable acceptance criteria.';
        const integ = filingInteg(async (rc, td, epic) => {
            const first = createdId(await rc(`bd create -t task "Task: follow-up first" -d "Filed by integration test." -p P1 --parent ${epic.id} --silent`, td));
            const second = createdId(await rc(`bd create -t task "Task: follow-up second" -d "Filed by integration test." -p P1 --parent ${epic.id} --silent`, td));
            await rc(`bd dep add ${second} ${first}`, td);
            return [first, second];
        });
        const run = await runDevelopLoopScenario('plrej-defer', {
            members: ['local'],
            goal: 'P1/P2',
            taskSpecs: [{ title: 'Task: closes in cycle one', priority: 'P1' }],
            maxCycles: 3,
            withRunbooks: true,
            withRegressionPlaybook: true,
            doerHandler: closingDoer,
            reviewerHandler: approve,
            finalReviewHandler: rubberStampPass,
            regressionHandler: passingRegression,
            integHandler: integ.handler,
            planReviewerHandler: approveFirstThen(async () => {
                const [first, second] = integ.filed;
                return report({
                    verdict: 'CHANGES_NEEDED',
                    notes: `${first}: ${FINDING}`,
                    taskAssignments: [
                        { id: first, bucket: 'S', model: 'standard' },
                        { id: second, bucket: 'S', model: 'standard' },
                    ],
                    findings: [{ id: first, kind: 'acceptance_criteria', detail: FINDING }],
                });
            }),
        });
        assert.equal(integ.filed.length, 2, `integ filed the follow-ups: ${errText(run)}`);
        const [first, second] = integ.filed;
        assert.equal(run.finalBeadsById.get(run.tasks[0].id).status, 'closed', 'cycle 1 closed its task');
        assert.equal(run.finalBeadsById.get(first).status, 'deferred', 'the contested bead was deferred');
        assert.ok(!run.dispatched.some((d) => d.agent === 'doer' && (d.prompt.includes(first) || d.prompt.includes(second))),
            'neither follow-up reaches a doer');
        assertFinalizedWithCarryOver(run, { carriedIds: [first], finding: FINDING });
    });
});

test('(3) zero work closed this run: the post-deferral site still throws SprintPlanRejectedError in cycle 1', async () => {
    resetSyncMemo();
    await withScenarioMarkers('plan rejected carry-over (zero closed control)', async () => {
        const run = await runDevelopLoopScenario('plrej-zero', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: Contested first' }, { title: 'Task: Blocked second' }],
            beforeSprint: async ({ runCmd: rc, tempDir: td, tasks }) => {
                const first = tasks.find((t) => t.title.includes('Contested')).id;
                const second = tasks.find((t) => t.title.includes('Blocked')).id;
                await rc(`bd dep add ${second} ${first}`, td);
            },
            doerHandler: closingDoer,
            reviewerHandler: approve,
            planReviewerHandler: async ({ tempDir, runCmd, epicBead }) => {
                const list = JSON.parse((await runCmd(`bd list --parent ${epicBead.id} --json`, tempDir)).stdout || '[]');
                const first = list.find((b) => b.title.includes('Contested')).id;
                const second = list.find((b) => b.title.includes('Blocked')).id;
                return report({
                    verdict: 'CHANGES_NEEDED',
                    notes: `${first} needs rework.`,
                    taskAssignments: [
                        { id: first, bucket: 'S', model: 'standard' },
                        { id: second, bucket: 'S', model: 'standard' },
                    ],
                    findings: [{ id: first, kind: 'acceptance_criteria', detail: 'needs rework' }],
                });
            },
        });
        assert.ok(run.error instanceof SprintPlanRejectedError, `expected SprintPlanRejectedError, got ${errText(run)}`);
        assert.match(run.error.message, /after deferring contested bead\(s\)/);
        assert.ok(!run.dispatched.some((d) => d.agent === 'doer'), 'no doer dispatch');
    });
});

test('(4) a dispatch-failed last plan-review verdict after closed work still throws PlanReviewDispatchFailedError', async () => {
    resetSyncMemo();
    await withScenarioMarkers('plan rejected carry-over (dispatch failed)', async () => {
        const integ = filingInteg(async (rc, td, epic) => [
            createdId(await rc(`bd create -t bug "Bug: found by integration" -d "Filed by integration test." -p P1 --parent ${epic.id} --silent`, td)),
        ]);
        const run = await runDevelopLoopScenario('plrej-dispfail', {
            members: ['local'],
            goal: 'P1/P2',
            taskSpecs: [{ title: 'Task: closes in cycle one', priority: 'P1' }],
            maxCycles: 3,
            withRunbooks: true,
            doerHandler: closingDoer,
            reviewerHandler: approve,
            finalReviewHandler: rubberStampPass,
            integHandler: integ.handler,
            // Never schema-valid after cycle 1: every C2 round exhausts the
            // schema-repair loop and the engine synthesizes a dispatch-failed verdict.
            planReviewerHandler: approveFirstThen(async () => ({ content: [{ text: 'This can NOT be APPROVED: free text only.' }] })),
        });
        assert.equal(integ.filed.length, 1, `integ filed the bug: ${errText(run)}`);
        assert.equal(run.finalBeadsById.get(run.tasks[0].id).status, 'closed', 'cycle 1 closed its task');
        assert.ok(run.error instanceof PlanReviewDispatchFailedError, `expected PlanReviewDispatchFailedError, got ${errText(run)}`);
    });
});
