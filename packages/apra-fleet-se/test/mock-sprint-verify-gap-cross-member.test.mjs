// =============================================================================
// Verify gap-bug accounting when the integ-test-runner is a DIFFERENT member
// from the backlog member.
//
// The integ runner files a gap bug under a verify-routed parent on its own
// member and D-pushes it; the backlog clone sees it only after it D-pulls,
// which happens at Cycle Evaluation. The engine resolves each gap bug's parent
// with `bd show <gap> --json` on the backlog member to count verify bounces
// (VERIFY_GAP_LIMIT), defer a parent that keeps failing, and reset the
// needs-external-evidence count. Run inside the Integ Test phase, before that
// pull, the lookup missed and was logged non-fatal, so none of that happened.
//
// The topology (helpers/cross-member-gap-topology.mjs) fails `bd show <gap>`
// on the backlog member until the backlog member has issued a `bd dolt pull`
// after the gap was filed.
//
//   (1) a gap filed once is counted: the bounce is logged as attempt 1 for the
//       parent, with no lookup miss.
//   (2) the same parent gapped VERIFY_GAP_LIMIT+1 times is deferred by the
//       bounce cap and the run exits via the deferred carry-over.
//   (4) a lookup that still misses after the pull logs a WARN naming the bug
//       and the skipped cap tracking, and the miss is in the Final Review
//       input.
//   (5) the backlog D-pull count in a cycle's Integ Test / Cycle Evaluation
//       window is the same on a cycle that files a gap as on one that does
//       not: the fix adds no D-pull.
// Case (3), the needs-external-evidence reset in this topology, is in
// mock-sprint-needs-external-evidence.test.mjs.
//
// Reverting the runner.js / phases/integ-test.mjs change (gap accounting back
// inside the Integ Test phase) makes (1) and (2) fail: every lookup misses.
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';
import { crossMemberGapTopology, INTEG_MEMBER } from './helpers/cross-member-gap-topology.mjs';
import { StalledSprintError } from '../fleet-sprint/errors.mjs';
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
const closingDoer = async ({ opts, runCmd: rc, tempDir: td }) => {
    const ids = assignedIds(opts.prompt);
    for (const id of ids) await rc(`bd close ${id} --reason "Done"`, td);
    return report({ status: 'VERIFY', closedIds: ids, notes: 'Closed.' });
};
const errText = (run) => (run.error ? `${run.error.constructor.name}: ${run.error.message}` : 'none');
const MISS_RE = /^WARN: Verify-route gap-bug lookup MISSED for /;

/**
 * An integ handler that files one gap bug under the verify-routed parent on
 * each of its first `gapPasses` verify passes (priority from `gapPriority`),
 * then closes the parent on the next one. Returns the handler plus the gap
 * ids it filed and the cycles they were filed in.
 */
function gapFilingInteg(topology, { gapPasses, gapPriority = () => 'P1' }) {
    const filed = [];
    let verifyPasses = 0;
    const handler = async ({ opts, epicBead, runCmd: rc, tempDir: td }) => {
        assert.equal(opts.member_name, INTEG_MEMBER, 'the integ runner must run on its own member');
        if (!verifyIdsOf(opts.prompt).includes(epicBead.id)) {
            return report({ featuresClosed: 0, issuesCreated: 0, passed: true, bugsFiled: [], summary: 'Nothing to verify.' });
        }
        verifyPasses++;
        if (verifyPasses > gapPasses) {
            await rc(`bd close ${epicBead.id} --reason "Verified against the deployed build"`, td);
            return report({
                featuresClosed: 0, issuesCreated: 0, passed: true, bugsFiled: [],
                verifySetClosed: [epicBead.id], verifySetLeftOpen: [],
                summary: `Verified ${epicBead.id}.`,
            });
        }
        const n = filed.length + 1;
        const out = await rc(`bd create -t task "Gap ${n}: verification still fails" -d "Gap found by integration test pass ${n}." -p ${gapPriority(n)} --parent ${epicBead.id} --silent`, td);
        const bugId = String(out.stdout || '').trim();
        filed.push(bugId);
        topology.fileGap(bugId);
        return report({
            featuresClosed: 0, issuesCreated: 1, passed: false, bugsFiled: [bugId],
            verifySetClosed: [], verifySetLeftOpen: [{ id: epicBead.id, reason: `gap bug ${bugId} filed` }],
            summary: `Verification of ${epicBead.id} failed; filed ${bugId}.`,
        });
    };
    return { handler, filed, verifyPasses: () => verifyPasses };
}

async function runCrossMember(tag, topology, integHandler, extra = {}) {
    return runDevelopLoopScenario(tag, {
        members: topology.members,
        roleMap: topology.roleMap,
        onCommand: topology.onCommand,
        onWorkflow: topology.onWorkflow,
        taskSpecs: [{ title: 'Task: closes normally', priority: 'P1' }],
        withRunbooks: true,
        doerHandler: closingDoer,
        reviewerHandler: approve,
        finalReviewHandler: rubberStampPass,
        integHandler,
        ...extra,
    });
}

test('(1)+(5) a gap bug filed by an integ runner on another member is counted after the backlog D-pull, with no extra D-pull', async () => {
    resetSyncMemo();
    await withScenarioMarkers('verify gap cross-member count', async () => {
        const topology = crossMemberGapTopology();
        const integ = gapFilingInteg(topology, { gapPasses: 1 });
        const run = await runCrossMember('vgapxcount', topology, integ.handler, { maxCycles: 4 });
        const epic = run.epicBeadId;

        assert.ok(!run.error, `the run finishes: ${errText(run)}`);
        assert.equal(integ.filed.length, 1, 'one gap filed');
        const [gap] = integ.filed;
        // The seam is live: the gap was invisible on the backlog before a pull.
        // (On the fixed engine no lookup ever reaches it before the pull.)
        assert.ok(!run.logs.some((l) => MISS_RE.test(l)), `no lookup miss: ${run.logs.filter((l) => /MISSED|lookup/.test(l)).join('\n')}`);
        assert.ok(
            run.logs.some((l) => l.startsWith(`Verify-route bounce: ${epic} failed verification (gap bug ${gap} filed), attempt 1/`)),
            `the gap is counted for its parent: ${run.logs.filter((l) => /Verify-route|lookup/.test(l)).join('\n')}`,
        );
        assert.equal(run.finalBeadsById.get(epic).status, 'closed', 'the parent is verified on the next pass');
        assert.equal(integ.verifyPasses(), 2);

        // (5) Backlog D-pulls in the Integ Test C1 window (files the gap) equal
        // those in the Integ Test C<n> window of the cycle that verifies.
        const integPhases = [...new Set(topology.state.pulls.map((p) => p.phase))].filter((t) => /^Integ Test C\d+$/.test(t || ''));
        assert.ok(integPhases.includes('Integ Test C1'), `pulls seen under: ${JSON.stringify(integPhases)}`);
        const gapCycle = topology.backlogPullsInPhase('Integ Test C1');
        const verifyCycle = topology.backlogPullsInPhase(integPhases[integPhases.length - 1]);
        assert.ok(integPhases.length >= 2, `need a gap cycle and a no-gap cycle: ${JSON.stringify(integPhases)}`);
        assert.ok(gapCycle >= 1, 'Cycle Evaluation D-pulls the backlog');
        assert.equal(gapCycle, verifyCycle, `backlog D-pulls: gap cycle ${gapCycle}, no-gap cycle ${verifyCycle}`);
    });
});

test('(2) the same parent gapped VERIFY_GAP_LIMIT+1 times by an integ runner on another member is deferred by the bounce cap; the run exits via the deferred carry-over', async () => {
    resetSyncMemo();
    await withScenarioMarkers('verify gap cross-member bounce cap', async () => {
        const topology = crossMemberGapTopology();
        // The first two gaps are in-goal (doers fix them); the third is below
        // goal, so nothing in-goal is left once the bounce cap defers the parent.
        const integ = gapFilingInteg(topology, { gapPasses: 99, gapPriority: (n) => (n < 3 ? 'P1' : 'P3') });
        const run = await runCrossMember('vgapxcap', topology, integ.handler, { maxCycles: 8 });
        const epic = run.epicBeadId;

        assert.ok(!(run.error instanceof StalledSprintError), `no StalledSprintError: ${errText(run)}`);
        assert.ok(!run.error, `the run finishes: ${errText(run)}`);
        assert.equal(integ.filed.length, 3, 'the bounce cap needs three gap passes');
        assert.ok(!run.logs.some((l) => MISS_RE.test(l)), 'no lookup miss');
        assert.ok(run.logs.some((l) => /^Verify-route bounce cap: /.test(l) && l.includes(epic)), 'the bounce cap deferred the parent');
        assert.equal(run.finalBeadsById.get(epic).status, 'deferred');
        assert.ok(run.logs.some((l) => /^Goal priority .* satisfied/.test(l)), 'the deferred parent does not hold the exit');
        assert.deepEqual(run.result.verifyCarryOver.map((e) => [e.id, e.kind]), [[epic, 'deferred-bounce-cap']]);
        assert.equal(run.result.verdict, 'FAIL', JSON.stringify(run.result));
    });
});

test('(4) a gap-bug lookup that still misses after the backlog D-pull is a WARN naming the bug and is in the Final Review input', async () => {
    resetSyncMemo();
    await withScenarioMarkers('verify gap cross-member miss', async () => {
        const topology = crossMemberGapTopology({ missAfterPull: true });
        const integ = gapFilingInteg(topology, { gapPasses: 1 });
        const run = await runCrossMember('vgapxmiss', topology, integ.handler, { maxCycles: 4 });

        assert.ok(!run.error, `the run finishes: ${errText(run)}`);
        assert.equal(integ.filed.length, 1);
        const [gap] = integ.filed;
        assert.ok(topology.state.showMisses.includes(gap), 'the lookup really missed');
        const warn = run.logs.find((l) => MISS_RE.test(l));
        assert.ok(warn, `a WARN is logged: ${run.logs.filter((l) => /Verify-route|lookup/.test(l)).join('\n')}`);
        assert.ok(warn.includes(gap), `the WARN names the bug: ${warn}`);
        assert.match(warn, /bounce-cap tracking/, 'the WARN says cap tracking was skipped');
        assert.ok(!run.logs.some((l) => l.startsWith('Verify-route bounce: ')), 'nothing was counted for the missed gap');

        const finalReview = run.dispatched.find((d) => d.label === 'Final Review');
        assert.ok(finalReview, 'Final Review must be dispatched');
        assert.ok(finalReview.prompt.includes(gap) && /gap-bug lookup MISSED/.test(finalReview.prompt),
            'the miss is in the Final Review input');
    });
});
