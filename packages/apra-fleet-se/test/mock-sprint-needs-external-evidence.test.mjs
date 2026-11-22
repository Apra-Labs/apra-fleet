// =============================================================================
// End-to-end mock sprints for three shapes that used to loop until
// StalledSprintError, skipping Final Review, Regression, Harvest and Publish
// PR for the work the run had closed:
//
//   (a) needs-external-evidence: a verify-routed parent whose children close,
//       which Integration Test leaves open every cycle (passed:true, listed in
//       verifySetLeftOpen, no gap bug filed) -- its acceptance needs an
//       environment the sprint members lack. After the consecutive-cycle
//       limit (NEEDS_EXTERNAL_EVIDENCE_CYCLE_LIMIT, 2) the run goes on to
//       Final Review, Regression, Harvest and Publish PR; integ is handed the
//       bead no more than the limit; the verdict is FAIL and the verdict notes
//       and PR body name the bead as needs-external-evidence with the
//       runner's reason; the bead stays open.
//   (b) deferred verify bead: Integration Test files a gap bug under the
//       verify-routed parent on three passes, so the verify bounce cap defers
//       it. The deferred parent no longer holds the exit and is named as a
//       deferred-bounce-cap carry-over, and the verdict is forced to FAIL
//       (Final Review's PASS is overridden): the bead's acceptance was proven
//       failing on every pass.
//   (c) below-goal-only re-review: the work closes; the reviewer returns
//       CHANGES_NEEDED whose only reopen id is a P3 bead below the P1/P2 goal
//       (no in-goal newTask, buildFailing not true). The run exits to Final
//       Review on the cycle of that verdict, not after STALL_CYCLE_LIMIT stale
//       cycles, and the P3 id is logged as skipped.
//   (d) needs-external-evidence reset with the integ runner on a DIFFERENT
//       member from the backlog member: a gap bug it files (visible to the
//       backlog clone only after that clone D-pulls) still resets the
//       parent's inconclusive count, so the carry-over trips two passes later
//       than it would without the reset. Fails when the gap accounting runs
//       inside the Integ Test phase, before Cycle Evaluation's backlog D-pull.
//
// Reverting this lane's runner.js / phases/integ-test.mjs changes (the
// needs-external-evidence count, the excluded/deferred verify ids and the
// exit gate's stillOpenVerifyIdsForExit) makes (a) and (b) fail with
// StalledSprintError: the open verify-routed parent stays in the exit gate's
// still-open list forever. Reverting the phases/review.mjs / re-review.mjs /
// runner.js below-goal-only change makes (c) fail with StalledSprintError.
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers, withStagedBodies } from './helpers/mock-sprint-harness.mjs';
import { StalledSprintError } from '../fleet-sprint/errors.mjs';
import { NEEDS_EXTERNAL_EVIDENCE_CYCLE_LIMIT } from '../fleet-sprint/verify-carry-over.mjs';
import { crossMemberGapTopology, INTEG_MEMBER } from './helpers/cross-member-gap-topology.mjs';
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
const verifyIdsOf = (prompt) => {
    const match = prompt.match(/verification-closure:\s*([^.]+)\./);
    return match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
};
const report = (obj) => ({ content: [{ text: JSON.stringify(obj) }] });
const approve = async () => report({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] });
const rubberStampPass = async () => report({ verdict: 'PASS', notes: 'Rubber-stamp PASS from the final reviewer.' });
const passingRegression = () => report({ passed: true, suitePassed: true, smokePassed: true, bugsFiled: [], summary: 'Mock regression pass.' });
const closingDoer = async ({ opts, runCmd: rc, tempDir: td }) => {
    const ids = assignedIds(opts.prompt);
    for (const id of ids) await rc(`bd close ${id} --reason "Done"`, td);
    return report({ status: 'VERIFY', closedIds: ids, notes: 'Closed.' });
};
const publishedPrBody = (run) => withStagedBodies(run.commandLog).find((c) => c.includes('## Sprint verdict:'));
const errText = (run) => (run.error ? `${run.error.constructor.name}: ${run.error.message}` : 'none');

const EXTERNAL_REASON = 'acceptance needs a live run on a host OS the sprint members do not have';

test('(a) a verify bead left open with no gap bug on consecutive cycles is carried over as needs-external-evidence: Final Review, Regression, Harvest, Publish PR; FAIL; bead stays open', async () => {
    resetSyncMemo();
    await withScenarioMarkers('needs-external-evidence carry-over', async () => {
        let epicVerifyDispatches = 0;
        const run = await runDevelopLoopScenario('nee-carry', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: closes normally', priority: 'P1' }],
            maxCycles: 6,
            withRunbooks: true,
            withRegressionPlaybook: true,
            doerHandler: closingDoer,
            reviewerHandler: approve,
            finalReviewHandler: rubberStampPass,
            regressionHandler: passingRegression,
            integHandler: async ({ opts, epicBead }) => {
                const inVerify = verifyIdsOf(opts.prompt).includes(epicBead.id);
                if (inVerify) epicVerifyDispatches++;
                return report({
                    featuresClosed: 0, issuesCreated: 0, passed: true, bugsFiled: [],
                    ...(inVerify ? { verifySetClosed: [], verifySetLeftOpen: [{ id: epicBead.id, reason: EXTERNAL_REASON }] } : {}),
                    summary: inVerify ? `Could not verify ${epicBead.id} on these members.` : 'Nothing to verify.',
                });
            },
        });
        const epic = run.epicBeadId;

        assert.ok(!(run.error instanceof StalledSprintError), `no StalledSprintError: ${errText(run)}`);
        assert.ok(!run.error, `the run finishes: ${errText(run)}`);
        assert.ok(epicVerifyDispatches >= 1 && epicVerifyDispatches <= NEEDS_EXTERNAL_EVIDENCE_CYCLE_LIMIT,
            `integ handed the bead at most the limit (${NEEDS_EXTERNAL_EVIDENCE_CYCLE_LIMIT}) times, got ${epicVerifyDispatches}`);
        assert.equal(epicVerifyDispatches, NEEDS_EXTERNAL_EVIDENCE_CYCLE_LIMIT, 'carried over exactly at the limit');
        assert.ok(run.logs.some((l) => l.includes(epic) && /carried over as needs-external-evidence/.test(l)), 'the carry-over is logged');

        // Finalization ran.
        assert.ok(run.dispatched.some((d) => d.label === 'Final Review'), 'Final Review must be dispatched');
        assert.ok(run.dispatched.some((d) => d.agent === 'regression-test-runner'), 'Regression must be dispatched');
        assert.ok(run.dispatched.some((d) => d.agent === 'harvester'), 'Harvest must be dispatched');
        const body = publishedPrBody(run);
        assert.ok(body, 'Publish PR must run');

        // Verdict forced FAIL; notes and PR body name the bead and the reason.
        assert.equal(run.result.verdict, 'FAIL', JSON.stringify(run.result));
        assert.ok(run.result.notes.includes('needs-external-evidence') && run.result.notes.includes(epic) && run.result.notes.includes(EXTERNAL_REASON), run.result.notes);
        assert.ok(body.includes('## Sprint verdict: FAIL'), body);
        assert.ok(body.includes('needs-external-evidence') && body.includes(epic) && body.includes(EXTERNAL_REASON), 'the PR body names the carry-over with the reason');
        assert.deepEqual(run.result.verifyCarryOver.map((e) => [e.id, e.kind]), [[epic, 'needs-external-evidence']]);

        // Not closed.
        assert.notEqual(run.finalBeadsById.get(epic).status, 'closed', 'the carried-over bead stays open');
    });
});

test('(b) a verify bead deferred by the bounce cap does not hold the exit, is named as a deferred-bounce-cap carry-over, and forces FAIL', async () => {
    resetSyncMemo();
    await withScenarioMarkers('deferred verify carry-over', async () => {
        let gaps = 0;
        const run = await runDevelopLoopScenario('nee-deferred', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: closes normally', priority: 'P1' }],
            maxCycles: 8,
            withRunbooks: true,
            doerHandler: closingDoer,
            reviewerHandler: approve,
            finalReviewHandler: rubberStampPass,
            integHandler: async ({ opts, epicBead, runCmd: rc, tempDir: td }) => {
                if (!verifyIdsOf(opts.prompt).includes(epicBead.id)) {
                    return report({ featuresClosed: 0, issuesCreated: 0, passed: true, bugsFiled: [], summary: 'Nothing to verify.' });
                }
                gaps++;
                // The first two gaps are in-goal (doers fix them); the third
                // is below goal, so nothing in-goal is left once the bounce
                // cap defers the parent.
                const priority = gaps < 3 ? 'P1' : 'P3';
                const out = await rc(`bd create -t task "Gap ${gaps}: verification still fails" -d "Gap found by integration test pass ${gaps}." -p ${priority} --parent ${epicBead.id} --silent`, td);
                const bugId = String(out.stdout || '').trim();
                return report({
                    featuresClosed: 0, issuesCreated: 1, passed: false, bugsFiled: [bugId],
                    verifySetClosed: [], verifySetLeftOpen: [{ id: epicBead.id, reason: `gap bug ${bugId} filed` }],
                    summary: `Verification of ${epicBead.id} failed; filed ${bugId}.`,
                });
            },
        });
        const epic = run.epicBeadId;

        assert.ok(!(run.error instanceof StalledSprintError), `no StalledSprintError: ${errText(run)}`);
        assert.ok(!run.error, `the run finishes: ${errText(run)}`);
        assert.equal(gaps, 3, 'the bounce cap needs three gap passes');
        assert.ok(run.logs.some((l) => /^Verify-route bounce cap: /.test(l) && l.includes(epic)), 'the bounce cap deferred the parent');
        assert.equal(run.finalBeadsById.get(epic).status, 'deferred');

        // Did not hold the exit: the goal-priority exit fired.
        assert.ok(run.logs.some((l) => /^Goal priority .* satisfied/.test(l)), JSON.stringify(run.logs.filter((l) => /evaluation|satisfied/.test(l))));
        assert.ok(run.dispatched.some((d) => d.label === 'Final Review'), 'Final Review must be dispatched');
        assert.deepEqual(run.result.verifyCarryOver.map((e) => [e.id, e.kind]), [[epic, 'deferred-bounce-cap']]);
        assert.ok(run.result.notes.includes('Carried over as deferred-bounce-cap') && run.result.notes.includes(epic), run.result.notes);

        // Three proven verification failures: the verdict is FAIL even though
        // Final Review rubber-stamped PASS, and the PR body says so.
        assert.equal(run.result.verdict, 'FAIL', JSON.stringify(run.result));
        const body = publishedPrBody(run);
        assert.ok(body, 'Publish PR must run');
        assert.ok(body.includes('## Sprint verdict: FAIL') && !body.includes('## Sprint verdict: PASS'), body);
        assert.ok(body.includes('deferred-bounce-cap') && body.includes(epic), 'the PR body names the bounce-cap carry-over');
    });
});

test('(c) a CHANGES_NEEDED whose only reopen id is a P3 bead below goal exits to Final Review on the cycle of that verdict', async () => {
    resetSyncMemo();
    await withScenarioMarkers('below-goal-only reopen exit', async () => {
        const P3 = 'Task: P3 polish nobody scheduled';
        let p3Id = null;
        let reviews = 0;
        const run = await runDevelopLoopScenario('nee-belowgoal', {
            members: ['local'],
            goal: 'P1/P2',
            taskSpecs: [{ title: 'Task: in-goal work', priority: 'P1' }, { title: P3, priority: 'P3' }],
            maxCycles: 6,
            beforeSprint: async ({ tasks }) => { p3Id = tasks.find((t) => t.title === P3).id; },
            doerHandler: closingDoer,
            reviewerHandler: async () => {
                reviews++;
                return report({ verdict: 'CHANGES_NEEDED', notes: 'The P3 polish item should be redone.', reopenIds: [p3Id], newTasks: [], buildFailing: false });
            },
            finalReviewHandler: rubberStampPass,
        });

        assert.ok(!(run.error instanceof StalledSprintError), `no StalledSprintError: ${errText(run)}`);
        assert.ok(!run.error, `the run finishes: ${errText(run)}`);
        assert.equal(reviews, 1, 'one review, in cycle 1; no Re-Review cycles');
        assert.ok(run.logs.some((l) => /SKIPPED/.test(l) && l.includes(p3Id)), 'the P3 id is logged as skipped');
        assert.ok(run.logs.some((l) => /treated as APPROVED for the exit decision/.test(l) && l.includes(p3Id)), 'the effective approval is logged');
        const exitIdx = run.logs.findIndex((l) => /^Goal priority P1\/P2 .* satisfied/.test(l));
        assert.ok(exitIdx >= 0, JSON.stringify(run.logs.filter((l) => /evaluation|satisfied/.test(l))));
        assert.ok(!run.logs.some((l) => /\bCycle 2\b|C2 R\d|Re-Review C/.test(l)), 'exits in cycle 1');
        assert.ok(run.dispatched.some((d) => d.label === 'Final Review'), 'Final Review must be dispatched');
        assert.deepEqual(run.result.belowGoalCarryOver, [p3Id]);
        assert.notEqual(run.finalBeadsById.get(p3Id).status, 'closed', 'the P3 bead is not reopened or worked');
    });
});

test('(d) a gap bug filed by an integ runner on another member resets the parent needs-external-evidence count', async () => {
    resetSyncMemo();
    await withScenarioMarkers('needs-external-evidence reset cross-member', async () => {
        const topology = crossMemberGapTopology();
        let epicVerifyDispatches = 0;
        let gapId = null;
        const run = await runDevelopLoopScenario('nee-xreset', {
            members: topology.members,
            roleMap: topology.roleMap,
            onCommand: topology.onCommand,
            onWorkflow: topology.onWorkflow,
            taskSpecs: [{ title: 'Task: closes normally', priority: 'P1' }],
            maxCycles: 8,
            withRunbooks: true,
            withRegressionPlaybook: true,
            doerHandler: closingDoer,
            reviewerHandler: approve,
            finalReviewHandler: rubberStampPass,
            regressionHandler: passingRegression,
            integHandler: async ({ opts, epicBead, runCmd: rc, tempDir: td }) => {
                assert.equal(opts.member_name, INTEG_MEMBER, 'the integ runner must run on its own member');
                if (!verifyIdsOf(opts.prompt).includes(epicBead.id)) {
                    return report({ featuresClosed: 0, issuesCreated: 0, passed: true, bugsFiled: [], summary: 'Nothing to verify.' });
                }
                epicVerifyDispatches++;
                // Pass 2 files a real gap; every other pass leaves the bead
                // open with no gap bug (inconclusive).
                if (epicVerifyDispatches === 2) {
                    const out = await rc(`bd create -t task "Gap: verification fails" -d "Gap found by integration test pass 2." -p P1 --parent ${epicBead.id} --silent`, td);
                    gapId = String(out.stdout || '').trim();
                    topology.fileGap(gapId);
                    return report({
                        featuresClosed: 0, issuesCreated: 1, passed: false, bugsFiled: [gapId],
                        verifySetClosed: [], verifySetLeftOpen: [{ id: epicBead.id, reason: `gap bug ${gapId} filed` }],
                        summary: `Verification of ${epicBead.id} failed; filed ${gapId}.`,
                    });
                }
                return report({
                    featuresClosed: 0, issuesCreated: 0, passed: true, bugsFiled: [],
                    verifySetClosed: [], verifySetLeftOpen: [{ id: epicBead.id, reason: EXTERNAL_REASON }],
                    summary: `Could not verify ${epicBead.id} on these members.`,
                });
            },
        });
        const epic = run.epicBeadId;

        assert.ok(!run.error, `the run finishes: ${errText(run)}`);
        assert.ok(gapId, 'the gap was filed');
        assert.ok(!run.logs.some((l) => /gap-bug lookup MISSED/.test(l)), 'the gap lookup resolves after the backlog D-pull');
        // Inconclusive, gap (reset), inconclusive, inconclusive: carried over
        // on the fourth pass. Without the reset the gap pass would count as a
        // second inconclusive cycle and trip the limit on pass 2.
        assert.equal(epicVerifyDispatches, 2 + NEEDS_EXTERNAL_EVIDENCE_CYCLE_LIMIT, `integ handed the bead ${epicVerifyDispatches} times`);
        assert.ok(run.logs.some((l) => l.includes(epic) && /carried over as needs-external-evidence/.test(l)), 'the carry-over is logged');
        assert.deepEqual(run.result.verifyCarryOver.map((e) => [e.id, e.kind]), [[epic, 'needs-external-evidence']]);
    });
});
