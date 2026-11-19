import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';
import {
    invalidateSyncRemoteCache, clearLastSyncedTip, clearTipProbeFailures,
} from '../fleet-sprint/dolt-sync.mjs';
import { PAUSED_AWAITING_DECISION, activeDecisionWaits } from '../fleet-sprint/decision-wait.mjs';

// =============================================================================
// End-to-end guard for the planner decision channel: the planner returns a
// valid plan plus a `decision` (planner-output.json) naming one open gap bug.
// The engine files a SEPARATE decision bead, sets the gap bug aside (never
// labelling it human, since answering a bead with bd human respond closes
// it), tells the plan-reviewer the bead is non-blocking and does not let a
// finding on it hold the plan back, and pauses awaiting the answer once only
// the set-aside bead remains. Answering the decision bead resumes the run and
// leaves the work bead OPEN. With no answer path, the bead is carried over
// with its full question in the verdict notes, as for a doer decision.
// =============================================================================

const check = (cond, msg) => assert.ok(cond, msg);

const QUESTION = 'The gap bug can only be closed by upgrading the vendored parser to its next major or by carrying a ' +
    'local patch; nothing in the bead, its parent or the code says which is acceptable. Which should the plan take?';
const OPTIONS = [
    { id: 'a', text: 'Upgrade the parser to the next major and adapt every caller.' },
    { id: 'b', text: 'Keep the current major and carry a local patch file.' },
];
const RECOMMENDATION = 'a, because the patch would have to be carried forever.';
const decisionFor = (beadId) => ({ beadId, question: QUESTION, options: OPTIONS, recommendation: RECOMMENDATION });

const GAP = 'Bug: parser gap needs an operator decision';
const OTHER = 'Task: independent work';
const HELD_CLAUSE = 'SET ASIDE FOR AN OPERATOR DECISION';

const resetSyncMemo = () => {
    invalidateSyncRemoteCache();
    clearLastSyncedTip();
    clearTipProbeFailures();
};
const assignedIds = (opts) => {
    const match = opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
    return match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
};
const approveReview = async () => ({
    content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] }) }],
});
const showBead = async (rc, td, id) => {
    const shown = JSON.parse((await rc(`bd show ${id} --json`, td)).stdout || '[]');
    return Array.isArray(shown) ? shown[0] : shown;
};

// One scenario shape. The planner names GAP in a decision on its FIRST
// dispatch only (later cycles return a plain plan). The plan-reviewer
// approves unless `rejectHeld` -- then it rejects with a finding naming only
// GAP every round, which the engine must treat as non-blocking. OTHER closes
// at once. `onDecisionPause(workflow, ctx, data, seen)` runs when the run
// parks awaiting the decision.
async function plannerDecisionScenario(tag, { onDecisionPause, rejectHeld = false, rejectOtherOnce = false, heldNotes = null, maxCycles = 1, onCommand } = {}) {
    const seen = {
        states: [], pauses: [], resumed: 0, plannerCalls: 0, planReviewPrompts: [],
        gapStatusAtFirstDispatchAfterAnswer: null, answerError: null,
    };
    const scenario = await runDevelopLoopScenario(tag, {
        members: ['local'],
        taskSpecs: [GAP, OTHER].map((title) => ({ title })),
        maxCycles,
        ...(onCommand ? { onCommand } : {}),
        beforeSprint: async ({ runCmd: rc, tempDir: td, tasks }) => {
            const id = (title) => tasks.find((x) => x.title === title).id;
            await rc(`bd update ${id(GAP)} --type bug`, td);
            await rc(`bd update ${id(OTHER)} --set-metadata streak=lane-o --set-metadata streakOrder=1`, td);
        },
        onWorkflow: async (workflow, ctx) => {
            workflow.on('state', (e) => { if (e.namespace === 'decisions') seen.states.push(e.data); });
            workflow.on('resumed', () => { seen.resumed += 1; });
            workflow.on('pause:requested', (e) => {
                seen.pauses.push(e);
                if (e.source !== 'needs_decision' || seen.pauses.filter((p) => p.source === 'needs_decision').length > 1) return;
                const data = seen.states.filter((d) => d.state === PAUSED_AWAITING_DECISION).pop();
                onDecisionPause(workflow, ctx, data, seen).catch((err) => { seen.answerError = err; });
            });
        },
        plannerHandler: async ({ runCmd: rc, tempDir: td }) => {
            seen.plannerCalls += 1;
            const list = JSON.parse((await rc('bd list --json', td)).stdout || '[]');
            const gap = list.find((b) => b.title === GAP);
            const other = list.find((b) => b.title === OTHER);
            const report = { status: 'OK', notes: 'Plan ready.', featureIds: [], taskIds: other ? [other.id] : [] };
            if (seen.plannerCalls === 1 && gap) {
                report.notes = 'Plan ready; the gap bug needs an operator decision.';
                report.decision = decisionFor(gap.id);
            }
            return { content: [{ text: `Reviewed the scope.\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n` }] };
        },
        planReviewerHandler: async ({ opts, runCmd: rc, tempDir: td }) => {
            seen.planReviewPrompts.push(opts.prompt);
            const list = JSON.parse((await rc('bd list --json', td)).stdout || '[]');
            const gap = list.find((b) => b.title === GAP);
            const other = list.find((b) => b.title === OTHER);
            const rejectOther = rejectOtherOnce && other && seen.planReviewPrompts.length === 1;
            const reject = gap && (rejectHeld || rejectOther || !opts.prompt.includes(HELD_CLAUSE));
            const findings = [{ id: gap.id, kind: 'coverage', detail: `${gap.id} is an open bug with no task children.` }];
            if (rejectOther) findings.push({ id: other.id, kind: 'acceptance_criteria', detail: `${other.id} has no testable acceptance criteria.` });
            return { content: [{ text: JSON.stringify(reject ? {
                verdict: 'CHANGES_NEEDED',
                notes: heldNotes ? heldNotes(gap.id) : `${gap.id} has no task children: decompose it.`,
                findings,
                taskAssignments: [],
            } : { verdict: 'APPROVED', notes: 'Approved.', taskAssignments: [] }) }] };
        },
        doerHandler: async ({ opts, runCmd: rc, tempDir: td }) => {
            const ids = assignedIds(opts);
            for (const x of ids) await rc(`bd close ${x}`, td);
            return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds: ids, notes: 'Done.' }) }] };
        },
        reviewerHandler: approveReview,
    });
    return { scenario, seen };
}

const decisionRecord = (logs) => {
    const line = logs.find((m) => m.includes('NEEDS-DECISION set-aside'));
    return line ? JSON.parse(line.slice(line.indexOf('Request: ') + 'Request: '.length)) : null;
};

test('mock sprint: a planner decision files a separate decision bead, sets the gap bug aside without a human label, keeps the plan-reviewer from rejecting it, and pauses awaiting the answer', async () => {
    resetSyncMemo();
    await withScenarioMarkers('planner needs-decision pauses', async () => {
        const { scenario, seen } = await plannerDecisionScenario('pndec-pause', {
            onDecisionPause: async (workflow, { runCmd: rc, tempDir: td }, data, s) => {
                // Snapshot the beads at the pause, then stop: an unanswered
                // decision keeps the run parked until an operator acts.
                s.gapAtPause = await showBead(rc, td, data.pending[0].beadId);
                s.decisionAtPause = await showBead(rc, td, data.pending[0].decisionBeadId);
                workflow.requestStop('test: stop at the decision pause');
            },
        });
        const gap = scenario.tasks.find((t) => t.title === GAP).id;
        const other = scenario.tasks.find((t) => t.title === OTHER).id;
        check(!seen.answerError, `pause handler failed: ${seen.answerError && seen.answerError.message}`);

        // A separate decision bead, labelled human, holding the request.
        const rec = decisionRecord(scenario.logs);
        check(rec, 'the planner decision is recorded');
        assert.equal(rec.beadId, gap);
        check(rec.raisedBy.startsWith('planner (Plan C1 R1)'), `raised by the planner: ${rec.raisedBy}`);
        check(rec.decisionBeadId && rec.decisionBeadId !== gap, 'a separate decision bead');
        const decisionBead = scenario.finalBeadsById.get(rec.decisionBeadId);
        check(decisionBead && (decisionBead.labels || []).includes('human'), 'decision bead labelled human');
        check(decisionBead.description.includes(QUESTION), 'decision bead holds the whole question');
        for (const o of OPTIONS) check(decisionBead.description.includes(o.text), `decision bead holds option ${o.id}`);
        assert.equal(decisionBead.status, 'deferred', 'the unanswered decision stays pending for the operator');

        // The work bead is set aside, OPEN, never labelled human, and its
        // notes carry the request.
        const work = scenario.finalBeadsById.get(gap);
        assert.notEqual(work.status, 'closed', 'the gap bug stays open');
        check(!(work.labels || []).includes('human'), 'the work bead is never labelled human');
        check(!(seen.gapAtPause.labels || []).includes('human'), 'not labelled human at the pause either');
        check(typeof work.notes === 'string' && work.notes.includes(QUESTION), 'its notes carry the request');

        // The plan-reviewer was told the bead is non-blocking and approved in
        // ONE round: it was never asked to reject it round after round.
        assert.equal(seen.planReviewPrompts.length, 1, `one plan-review round: ${seen.planReviewPrompts.length}`);
        check(seen.planReviewPrompts[0].includes(HELD_CLAUSE) && seen.planReviewPrompts[0].includes(gap),
            'the plan-reviewer prompt names the held bead as non-blocking');
        check(!scenario.logs.some((m) => m.includes('plan-cap deferral')), 'no plan-cap deferral');

        // The other bead was worked; then the run parked awaiting the decision
        // with the gap bug listed as needs-decision.
        assert.equal(scenario.finalBeadsById.get(other).status, 'closed');
        check(!scenario.dispatched.some((d) => d.agent === 'doer' && assignedIds(d).includes(gap)), 'the gap bug is never dispatched');
        const paused = seen.states.find((d) => d.state === PAUSED_AWAITING_DECISION);
        check(paused, 'the run entered decision-wait (paused-awaiting-decision)');
        const entry = paused.setAside.find((e) => e.id === gap);
        assert.equal(entry.kind, 'needs-decision');
        check(entry.reason.includes(QUESTION), 'the set-aside entry carries the untruncated question');
        assert.equal(seen.pauses.filter((p) => p.source === 'needs_decision').length, 1, 'parked once');
        check(scenario.error && scenario.error.name === 'CancelledError', `stopped at the pause, never stalled: ${scenario.error && scenario.error.name}`);
        assert.equal(activeDecisionWaits().length, 0, 'no live wait left registered');
    });
});

test('mock sprint: a plan-reviewer finding naming only the decision-held bead does not block the plan', async () => {
    resetSyncMemo();
    await withScenarioMarkers('planner needs-decision held finding non-blocking', async () => {
        const { scenario, seen } = await plannerDecisionScenario('pndec-held', {
            rejectHeld: true,
            // Several sentences of narration around the held bead: prose is
            // never an objection, only the structured findings are.
            heldNotes: (id) => `${id} has no task children; non-blocking per the decision hold. Otherwise the plan looks good.`,
            onDecisionPause: async (workflow) => { workflow.requestStop('test: stop at the decision pause'); },
        });
        const gap = scenario.tasks.find((t) => t.title === GAP).id;
        assert.equal(seen.planReviewPrompts.length, 1, 'the finding on the held bead did not cost a second plan round');
        check(scenario.logs.some((m) => m.includes('treated as non-blocking') && m.includes(gap)), 'the gate logged the non-blocking finding');
        check(!scenario.logs.some((m) => m.includes('plan-cap deferral')), 'the held bead is not deferred');
        assert.notEqual(scenario.finalBeadsById.get(gap).status, 'deferred', 'the gap bug keeps its status');
        check(seen.states.some((d) => d.state === PAUSED_AWAITING_DECISION), 'the run still reached decision-wait');
    });
});

test('mock sprint: a plan-reviewer finding on a bead that is not decision-held still blocks the plan', async () => {
    resetSyncMemo();
    await withScenarioMarkers('planner needs-decision non-held finding blocks', async () => {
        const { scenario, seen } = await plannerDecisionScenario('pndec-nonheld', {
            rejectOtherOnce: true,
            onDecisionPause: async (workflow) => { workflow.requestStop('test: stop at the decision pause'); },
        });
        assert.equal(seen.planReviewPrompts.length, 2, 'the finding on the non-held bead cost a second plan round');
        check(!scenario.logs.some((m) => m.includes('treated as non-blocking')), 'the gate did not waive it');
        check(seen.states.some((d) => d.state === PAUSED_AWAITING_DECISION), 'the run still reached decision-wait');
    });
});

test('mock sprint: answering the planner decision bead resumes the run and leaves the work bead OPEN', async () => {
    resetSyncMemo();
    await withScenarioMarkers('planner needs-decision answered', async () => {
        const ANSWER = 'a: upgrade the parser';
        const { scenario, seen } = await plannerDecisionScenario('pndec-answer', {
            maxCycles: 2,
            onDecisionPause: async (workflow, { runCmd: rc, tempDir: td }, data, s) => {
                s.decisionBeadId = data.pending[0].decisionBeadId;
                await rc(`bd human respond ${s.decisionBeadId} -r "${ANSWER}"`, td);
                s.gapAfterAnswer = await showBead(rc, td, data.pending[0].beadId);
                s.decisionAfterAnswer = await showBead(rc, td, s.decisionBeadId);
                await workflow.requestResume('operator Resume after bd human respond');
            },
        });
        const gap = scenario.tasks.find((t) => t.title === GAP).id;
        check(!seen.answerError, `answering failed: ${seen.answerError && seen.answerError.message}`);
        assert.equal(seen.pauses.filter((p) => p.source === 'needs_decision').length, 1, 'parked once, answered on the first resume');
        check(seen.resumed >= 1, 'the run resumed');
        check(!scenario.error || scenario.error.name !== 'CancelledError', 'not stopped');
        check(!scenario.error || scenario.error.code !== 'SPRINT_STALLED', `never stalled on the answered decision: ${scenario.error && scenario.error.message}`);
        check(seen.states.some((d) => d.state === 'running' && d.pending.length === 0), 'the decisions state returns to running');
        check(scenario.logs.some((m) => m.includes('Plan C2')), 'the resumed run went on to its next cycle');

        // The answer closed the DECISION bead only; the work bead stays open.
        assert.equal(seen.decisionAfterAnswer.status, 'closed');
        assert.equal(seen.decisionAfterAnswer.close_reason, 'Responded');
        assert.notEqual(seen.gapAfterAnswer.status, 'closed', 'the answer did not close the work bead');
        const work = scenario.finalBeadsById.get(gap);
        assert.notEqual(work.status, 'closed', 'the work bead is still OPEN at the end of the run');
        check(!(work.labels || []).includes('human'), 'the work bead is never labelled human');
        check(work.notes.includes(ANSWER), `the answer reached the work bead notes: ${work.notes}`);
    });
});

test('mock sprint: with no answer path for the planner decision, the gap bug is carried over with its full question in the verdict notes', { timeout: 180_000 }, async () => {
    resetSyncMemo();
    await withScenarioMarkers('planner needs-decision carried over', async () => {
        const { scenario, seen } = await plannerDecisionScenario('pndec-carry', {
            onDecisionPause: async (workflow) => {
                // Reaching this is the regression: an unanswerable decision
                // must not park the run.
                workflow.requestStop('test: paused on an unanswerable decision');
            },
            onCommand: async ({ command }) => {
                if (command.includes('bd create') && command.includes('-t decision')) throw new Error('simulated bd create failure');
                return undefined;
            },
        });
        const gap = scenario.tasks.find((t) => t.title === GAP).id;
        assert.equal(seen.pauses.filter((p) => p.source === 'needs_decision').length, 0, 'never paused on it');
        check(!scenario.error, `finishes (work closed this run): ${scenario.error && scenario.error.message}`);
        check(scenario.result.exitReason === 'set-aside-carry-over', `carry-over exit: ${JSON.stringify(scenario.result && scenario.result.exitReason)}`);
        const carried = (scenario.result.carryOver || []).find((e) => e.id === gap);
        check(carried && carried.reason.includes(QUESTION), `the carry-over names the gap bug with the full question: ${JSON.stringify(scenario.result.carryOver)}`);
        check(scenario.result.notes.includes(QUESTION), 'the verdict notes carry the full question');
        const work = scenario.finalBeadsById.get(gap);
        assert.notEqual(work.status, 'closed', 'the gap bug stays open for a later run');
        check(!(work.labels || []).includes('human'), 'the work bead is never labelled human');
    });
});
