// =============================================================================
// End-to-end mock sprints for the set-aside carry-over exit: a set-aside stall
// (nothing ready, every open in-scope bead set aside for this run) after the
// run already closed work no longer aborts SPRINT_STALLED with only an abort
// note on the PR. The run goes on to Finalization -- Final Review, Regression,
// Harvest, Publish PR -- with every set-aside bead named as a carry-over, and
// the verdict is forced FAIL while an at/above-goal bead is carried over.
//
// Seen live: 4 beads closed, the 5th reported BLOCKED by its doer and set
// aside, and the run ended with an abort only -- no Final Review, Regression,
// Harvest or PR update for the closed work.
//
// Scenarios:
//   (a) goal P1/P2: three P1 tasks the doers close and the reviewers approve,
//       one P2 task whose doer reports BLOCKED (set aside): no
//       StalledSprintError; Final Review, Regression and Harvest are
//       dispatched and Publish PR runs; the verdict is FAIL (the final
//       reviewer's PASS is overridden) and both the verdict notes and the PR
//       body name the P2 bead with its BLOCKED reason;
//   (b) start of Develop: work closes in round 1, the stall fires at the
//       start of round 2 -- that only ends the Develop loop, so Deploy and
//       Integration Test still dispatch in that cycle and the run is not
//       finished there (Cycle Evaluation owns the exit);
//   (c) zero closed: the one in-scope bead is set aside BLOCKED -- the run
//       still ends SPRINT_STALLED naming the blocker.
//
// Reverting the runner.js carry-over change (throwIfSetAsideStall returning
// { carryOver } and its two call sites) makes (a) and (b) fail with
// StalledSprintError: the stall then throws at the start of Develop C1 R2.
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers, withStagedBodies } from './helpers/mock-sprint-harness.mjs';
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
const passingRegression = () => report({
    passed: true, suitePassed: true, smokePassed: true, bugsFiled: [],
    summary: 'Mock regression pass.',
});
const CARRY_OVER_EXIT = 'set-aside-carry-over';
const BLOCKED_NOTES = 'Needs a host capability doers do not have: a hardware security key.';

// A doer that reports BLOCKED for every assigned bead whose title is in
// `blockedTitles` and closes the rest.
const doerBlocking = (blockedTitles) => async ({ opts, runCmd: rc, tempDir: td }) => {
    const ids = assignedIds(opts.prompt);
    const list = JSON.parse((await rc('bd list --json', td)).stdout || '[]');
    const blocked = ids.filter((x) => blockedTitles.has((list.find((b) => b.id === x) || {}).title));
    if (blocked.length > 0) {
        return report({ status: 'BLOCKED', closedIds: [], blockedIds: blocked, notes: BLOCKED_NOTES });
    }
    for (const x of ids) await rc(`bd close ${x}`, td);
    return report({ status: 'VERIFY', closedIds: ids, notes: 'Done.' });
};
const setLanes = async (rc, td, tasks, titles) => {
    for (const [i, title] of titles.entries()) {
        const id = tasks.find((x) => x.title === title).id;
        await rc(`bd update ${id} --set-metadata streak=lane-${i} --set-metadata streakOrder=1`, td);
    }
};
const publishedPrBody = (run) => withStagedBodies(run.commandLog).find((c) => c.includes('## Sprint verdict:'));

test('(a) three P1 closed plus one BLOCKED P2: Final Review, Regression, Harvest and Publish PR run; FAIL with the P2 bead carried over', async () => {
    resetSyncMemo();
    await withScenarioMarkers('set-aside finalize carry-over', async () => {
        const P1 = ['Task: P1 first', 'Task: P1 second', 'Task: P1 third'];
        const P2 = 'Task: P2 needs a hardware key';
        const run = await runDevelopLoopScenario('saf-carry', {
            members: ['local'],
            goal: 'P1/P2',
            taskSpecs: [...P1.map((title) => ({ title, priority: 'P1' })), { title: P2, priority: 'P2' }],
            maxCycles: 3,
            withRegressionPlaybook: true,
            beforeSprint: async ({ runCmd: rc, tempDir: td, tasks }) => setLanes(rc, td, tasks, [...P1, P2]),
            doerHandler: doerBlocking(new Set([P2])),
            reviewerHandler: approve,
            finalReviewHandler: rubberStampPass,
            regressionHandler: passingRegression,
        });
        const id = (title) => run.tasks.find((t) => t.title === title).id;
        const p2 = id(P2);

        // No abort: the run returned a result through the carry-over exit.
        assert.ok(!run.error, `no StalledSprintError with work closed this run: ${run.error && run.error.message}`);
        assert.equal(run.result.exitReason, CARRY_OVER_EXIT, JSON.stringify(run.result));
        for (const t of P1) assert.equal(run.finalBeadsById.get(id(t)).status, 'closed', `${t} must close`);
        assert.notEqual(run.finalBeadsById.get(p2).status, 'closed', 'the BLOCKED P2 bead stays open');

        // Finalization ran: Final Review, Regression, Harvest, Publish PR.
        assert.ok(run.dispatched.some((d) => d.label === 'Final Review'), 'Final Review must be dispatched');
        assert.ok(run.dispatched.some((d) => d.agent === 'regression-test-runner'), 'Regression must be dispatched');
        assert.ok(run.dispatched.some((d) => d.agent === 'harvester'), 'Harvest must be dispatched');
        const body = publishedPrBody(run);
        assert.ok(body, 'Publish PR must run');

        // Verdict forced FAIL over the final reviewer's PASS; the notes and
        // the PR body name the P2 bead with its BLOCKED reason.
        assert.equal(run.result.verdict, 'FAIL', JSON.stringify(run.result));
        assert.ok(run.logs.some((l) => /^Final Review: sprint verdict forced to FAIL \(Final Review returned PASS\) -- 1 at\/above-goal bead\(s\) carried over/.test(l)),
            JSON.stringify(run.logs.filter((l) => /Final Review:/.test(l))));
        assert.deepEqual(run.result.carryOver.map((e) => e.id), [p2]);
        assert.ok(run.result.carryOver[0].reason.includes(BLOCKED_NOTES), run.result.carryOver[0].reason);
        assert.ok(run.result.notes.includes(`${p2} -- `) && run.result.notes.includes(BLOCKED_NOTES), run.result.notes);
        assert.ok(body.includes('## Sprint verdict: FAIL'), body);
        assert.ok(body.includes('Carried over (') && body.includes(p2), 'the PR body notes carry the carry-over');
        const section = body.slice(body.indexOf('### Set aside this run'));
        assert.ok(body.includes('### Set aside this run') && section.includes(`- ${p2}: `) && section.includes(BLOCKED_NOTES), section);
    });
});

test('(b) a stall at the start of Develop with work closed earlier in the cycle ends only the Develop loop: Deploy and Integration Test still dispatch', async () => {
    resetSyncMemo();
    await withScenarioMarkers('set-aside finalize start of develop', async () => {
        const DONE = 'Task: closes in round one';
        const STUCK = 'Task: blocked in round one';
        const run = await runDevelopLoopScenario('saf-develop', {
            members: ['local'],
            taskSpecs: [{ title: DONE }, { title: STUCK }],
            maxCycles: 3,
            withRunbooks: true,
            beforeSprint: async ({ runCmd: rc, tempDir: td, tasks }) => setLanes(rc, td, tasks, [DONE, STUCK]),
            doerHandler: doerBlocking(new Set([STUCK])),
            reviewerHandler: approve,
        });
        const stuck = run.tasks.find((t) => t.title === STUCK).id;
        const done = run.tasks.find((t) => t.title === DONE).id;
        assert.equal(run.finalBeadsById.get(done).status, 'closed');

        // The start-of-Develop site fired and only ended the Develop loop.
        const developEnd = run.logs.findIndex((l) => /^Develop C1 R2: every open in-scope bead is set aside for this run, but this run already closed work .*ending the Develop loop/.test(l));
        assert.ok(developEnd >= 0, JSON.stringify(run.logs.filter((l) => /set aside/i.test(l))));
        assert.ok(run.logs[developEnd].includes(done), run.logs[developEnd]);
        assert.ok(!run.logs.some((l) => /^Sprint stalled \(start of Develop/.test(l)), 'the run must not be finished at the start of Develop');

        // Deploy and Integration Test still dispatched in that cycle, after
        // the last doer dispatch.
        const lastDoer = run.dispatched.map((d) => d.agent).lastIndexOf('doer');
        const deployer = run.dispatched.findIndex((d) => d.agent === 'deployer');
        const integ = run.dispatched.findIndex((d) => d.agent === 'integ-test-runner');
        assert.ok(deployer > lastDoer, `Deploy must dispatch after Develop: ${JSON.stringify(run.dispatched.map((d) => d.agent))}`);
        assert.ok(integ > deployer, `Integration Test must dispatch after Deploy: ${JSON.stringify(run.dispatched.map((d) => d.agent))}`);
        assert.ok(!run.logs.some((l) => /\bC2 R\d|Cycle 2\b|Deploy Phase C2/.test(l)), 'all of it happens in cycle 1');

        // Cycle Evaluation then owns the exit to Finalization.
        assert.ok(!run.error, `no StalledSprintError: ${run.error && run.error.message}`);
        assert.ok(run.logs.some((l) => /^Cycle 1: Carried over \(Cycle 1 evaluation\)/.test(l)), 'Cycle 1 evaluation must take the carry-over exit');
        assert.equal(run.result.exitReason, CARRY_OVER_EXIT);
        assert.deepEqual(run.result.carryOver.map((e) => e.id), [stuck]);
        assert.equal(run.result.verdict, 'FAIL');
    });
});

test('(c) zero beads closed this run: the one set-aside bead still ends the run SPRINT_STALLED naming it', async () => {
    resetSyncMemo();
    await withScenarioMarkers('set-aside finalize zero closed', async () => {
        const ONLY = 'Task: the only bead, blocked';
        const run = await runDevelopLoopScenario('saf-zero', {
            members: ['local'],
            taskSpecs: [{ title: ONLY }],
            maxCycles: 3,
            doerHandler: doerBlocking(new Set([ONLY])),
            reviewerHandler: approve,
        });
        const only = run.tasks.find((t) => t.title === ONLY).id;
        assert.ok(run.error, 'the run must end in a stall');
        assert.equal(run.error.code, 'SPRINT_STALLED', run.error.message);
        assert.deepEqual(run.error.blockerIds, [only]);
        assert.ok(run.error.blockerReasons[only].includes(BLOCKED_NOTES), run.error.blockerReasons[only]);
        assert.ok(!run.dispatched.some((d) => d.agent === 'harvester'), 'no Finalization for a run that closed nothing');
    });
});
