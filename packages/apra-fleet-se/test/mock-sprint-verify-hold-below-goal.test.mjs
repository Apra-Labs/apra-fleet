// =============================================================================
// A parent held out of verify only by a below-goal open child is named, not
// left silently open.
//
// classifyVerifySet rule 4 is kept: a parent with any open child is never
// verify-routed (a gap bug filed under a verify target has no priority floor,
// so relaxing the rule would re-verify a parent with an open gap). Such a
// parent is a decomposed parent, so it never counts in open-at-goal and never
// blocks the exit gate -- without a report the run would end with it open and
// unverified and nobody would know why.
//
// DAG, under the sprint epic: task T (at goal, the only doer work) and feature
// E. E has one closed implementation child E1 and one unrelated open hygiene
// child E2 at P3, below the P1/P2 goal.
//
//   - The Route log names E and its holding child E2.
//   - The run ends without SPRINT_STALLED.
//   - The end-of-run summary (the Final Review log line and the verdict notes
//     the final report carries) names E as left open and unverified, with E2.
//
// Reverting the beads-scope.mjs / runner.js / phases/final-review.mjs change
// makes the Route and end-of-run assertions fail: nothing names E or E2.
// =============================================================================

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { runCmd, runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';
import {
    invalidateSyncRemoteCache, clearLastSyncedTip, clearTipProbeFailures,
} from '../fleet-sprint/dolt-sync.mjs';

beforeEach(() => {
    invalidateSyncRemoteCache();
    clearLastSyncedTip();
    clearTipProbeFailures();
});

const report = (obj) => ({ content: [{ text: JSON.stringify(obj) }] });

const closeAssignedDoer = async ({ opts, tempDir }) => {
    const match = opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
    const assigned = match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
    for (const id of assigned) await runCmd(`bd close ${id}`, tempDir);
    return report({ status: 'VERIFY', closedIds: assigned, notes: 'Closed all assigned beads.' });
};
const approvingReviewer = async () => report({ verdict: 'APPROVED', notes: 'Looks good.', reopenIds: [], newTasks: [] });
const passingFinalReview = async () => report({ verdict: 'PASS', notes: 'Final review PASS.' });

const buildShape = (ids) => async ({ tempDir, tasks }) => {
    ids.t = tasks[0].id;
    ids.e = tasks[1].id;
    const mk = async (title, extra = '') => {
        const created = await runCmd(`bd create "${title}" -d "Child of E."${extra} --silent`, tempDir);
        const id = String(created.stdout || '').trim();
        assert.ok(id, `child create must return an id: ${JSON.stringify(created)}`);
        await runCmd(`bd update ${id} --parent ${ids.e}`, tempDir);
        return id;
    };
    ids.e1 = await mk('Task: E1 implementation');
    await runCmd(`bd close ${ids.e1}`, tempDir);
    ids.e2 = await mk('Task: E2 unrelated hygiene', ' -p P3');
};

test('verify hold: a parent held only by a below-goal open child is named in the Route log and the end-of-run summary', async () => {
    await withScenarioMarkers('verifyholdbelowgoal', async () => {
        const ids = {};
        const run = await runDevelopLoopScenario('verifyholdbelowgoal', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: T in-goal work' }, { title: 'Feature: E implementation-complete' }],
            goal: 'P1/P2',
            maxCycles: 3,
            beforeSprint: buildShape(ids),
            doerHandler: closeAssignedDoer,
            reviewerHandler: approvingReviewer,
            finalReviewHandler: passingFinalReview,
        });
        const relevant = JSON.stringify(run.logs.filter((l) => /Route|Final Review|stall|STALLED/i.test(l)));
        assert.ok(!run.error, `the sprint finishes, it does not throw: ${run.error && run.error.message}`);
        assert.ok(!run.logs.some((l) => /SPRINT_STALLED|Sprint stalled/.test(l)), `no stall: ${relevant}`);

        const routeLine = run.logs.find((l) => /^Route C\d+: .*held out of verify only by open child\(ren\) below goal/.test(l));
        assert.ok(routeLine, `expected the Route hold line, logs: ${relevant}`);
        assert.ok(routeLine.includes(`${ids.e} (held by ${ids.e2} (P3))`), `Route line names E and E2: ${routeLine}`);
        assert.ok(!routeLine.includes(`${ids.e1} (`), `the closed child is not a holder: ${routeLine}`);

        const finalLine = run.logs.find((l) => /^Final Review: Left open and unverified/.test(l));
        assert.ok(finalLine, `expected the end-of-run hold line, logs: ${relevant}`);
        assert.ok(finalLine.includes(`${ids.e} (held by ${ids.e2} (P3))`), `end-of-run line names E and E2: ${finalLine}`);
        assert.ok(run.result && typeof run.result.notes === 'string', JSON.stringify(run.result));
        assert.match(run.result.notes, /Left open and unverified/);
        assert.ok(run.result.notes.includes(`${ids.e} (held by ${ids.e2} (P3))`), `final report notes name E and E2: ${run.result.notes}`);

        assert.equal(run.finalBeadsById.get(ids.t).status, 'closed', 'the in-goal work is done');
        assert.notEqual(run.finalBeadsById.get(ids.e).status, 'closed', 'E is left open (never verified)');
        assert.notEqual(run.finalBeadsById.get(ids.e2).status, 'closed', 'the below-goal child is never dispatched');
    });
});
