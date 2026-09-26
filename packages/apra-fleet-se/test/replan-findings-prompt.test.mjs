import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { runReplanPhase } from '../fleet-sprint/phases/replan.mjs';
import { REPLAN_FINDINGS_MAX_LENGTH } from '../fleet-sprint/prompts.mjs';
import { createRecordingCtx } from './helpers/dispatch-role-harness.mjs';

// apra-fleet-i4ku.2 -- verification for apra-fleet-i4ku.1's fix: the scoped
// in-cycle replan dispatch told the planner to "read the reviewer feedback
// below" while actually threading `feedback: null` into buildPlannerPrompt
// (fleet-sprint/phases/replan.mjs line 132, pre-fix). This test drives the
// REAL code path -- runReplanPhase, with a real dispatchRole engine wired to
// a recording ctx (dispatch-role-harness.mjs), NOT buildPlannerPrompt called
// directly with hand-made arguments -- so it exercises the actual threading
// from runner state (perBeadFeedback) through phases/replan.mjs into the
// composed planner prompt.
//
// Fixture note (see the [impl] task's verified invariant, restated on this
// task): every id in eligibleReplan is guaranteed to already have a
// perBeadFeedback entry, because foldReplanIds (beads-transitions.mjs) only
// admits a replanIds id that was ALSO actually reopened, and review.mjs sets
// perBeadFeedback for every id it reopens. The "no findings" fixture below is
// therefore the genuinely-blank-notes case (an empty verdict.notes string),
// not a missing map entry.

const FLAGGED_ID = 'apra-fleet-test1';

/** Builds the state object runReplanPhase expects, with per-test overrides. */
function buildState({ perBeadFeedback, dispatchCtx, replanIds, replannedThisCycle }) {
    return {
        phase: () => {},
        log: () => {},
        dispatchCtx,
        cycle: 1,
        validated: { goal: 'ship the fix', requirementsFile: undefined },
        targetIssues: ['epic-1'],
        requirementsContent: null,
        orchestratorMember: 'member:orchestrator',
        gitSync: { syncBeadsAfter: async () => {} },
        updateDashboard: async () => {},
        verifySetThisCycle: [],
        pendingRejectedNewTasks: [],
        devRounds: 1,
        eligibleReplan: [{ id: FLAGGED_ID, title: 'Task: flagged bead' }],
        replanIds: replanIds ?? new Set([FLAGGED_ID]),
        replannedThisCycle: replannedThisCycle ?? new Set(),
        perBeadFeedback,
    };
}

/** Standard responses: the scoped planner (schema: null) then an APPROVED scoped review. */
function approvingResponses() {
    return ['scoped plan dispatched ok', { verdict: 'APPROVED', notes: 'ok', taskAssignments: [] }];
}

describe('scoped in-cycle replan prompt: threads the reviewer findings that triggered it', () => {
    test('with known findings: the captured planner prompt contains them verbatim, attributed to the code reviewer', async () => {
        const findingsText = `${FLAGGED_ID}'s acceptance criteria are ambiguous and cannot be satisfied as written -- needs replanning.`;
        const perBeadFeedback = new Map([[FLAGGED_ID, findingsText]]);
        const { ctx, rec } = createRecordingCtx({ responses: approvingResponses() });

        await runReplanPhase(buildState({ perBeadFeedback, dispatchCtx: ctx }));

        assert.strictEqual(rec.dispatches.length, 2, `expected exactly 2 dispatches (scoped planner + scoped review), got ${rec.dispatches.length}`);
        const plannerPrompt = rec.dispatches[0].prompt;

        // The findings text itself appears verbatim.
        assert.ok(
            plannerPrompt.includes(findingsText),
            `expected the scoped planner prompt to contain the reviewer findings verbatim, got: ${plannerPrompt}`
        );

        // Attributed to the CODE reviewer, not to plan-reviewer.notes / "the
        // previous plan-review round" (that heading/label is reserved for the
        // unrelated `feedback` re-planning-loop block).
        assert.ok(
            /code reviewer/i.test(plannerPrompt),
            `expected the findings block to be attributed to the code reviewer, got: ${plannerPrompt}`
        );
        assert.ok(
            !plannerPrompt.includes('plan-reviewer.notes'),
            "the scoped-replan findings block must not reuse the 'plan-reviewer.notes' source label"
        );
        assert.ok(
            !plannerPrompt.includes('the previous plan-review round'),
            "the scoped-replan findings block must not reuse the 'previous plan-review round' heading"
        );

        // The "read the findings below" instruction is present, since
        // findings ARE present this time.
        assert.ok(
            /findings below/i.test(plannerPrompt) || /findings from the code reviewer/i.test(plannerPrompt),
            `expected an explicit instruction to read the findings, got: ${plannerPrompt}`
        );
    });

    test('with no findings (blank verdict.notes): no read-feedback instruction, no heading, no empty fenced block', async () => {
        // The genuinely-findings-free case per the verified invariant: a
        // perBeadFeedback entry exists for the flagged id, but its notes are
        // blank (not a missing map entry).
        const perBeadFeedback = new Map([[FLAGGED_ID, '   ']]);
        const { ctx, rec } = createRecordingCtx({ responses: approvingResponses() });

        await runReplanPhase(buildState({ perBeadFeedback, dispatchCtx: ctx }));

        const plannerPrompt = rec.dispatches[0].prompt;

        assert.ok(
            !/reviewer feedback below/i.test(plannerPrompt),
            `did not expect a 'reviewer feedback below' instruction with no findings, got: ${plannerPrompt}`
        );
        assert.ok(
            !/findings below/i.test(plannerPrompt) && !/findings from the code reviewer/i.test(plannerPrompt),
            `did not expect a findings heading with no findings, got: ${plannerPrompt}`
        );
        // No empty fenced block: wrapUntrustedBlock always renders an
        // "UNTRUSTED CONTENT" preamble, so its total absence proves no block
        // (empty or otherwise) was rendered for the findings.
        assert.ok(
            !plannerPrompt.includes('code-reviewer.findings'),
            `did not expect a code-reviewer.findings source block with no findings, got: ${plannerPrompt}`
        );
    });

    test('findings longer than the cap are truncated to REPLAN_FINDINGS_MAX_LENGTH, and the prompt carries a truncation marker naming the original length and the cap', async () => {
        const longFindings = 'x'.repeat(REPLAN_FINDINGS_MAX_LENGTH + 777);
        const perBeadFeedback = new Map([[FLAGGED_ID, longFindings]]);
        const { ctx, rec } = createRecordingCtx({ responses: approvingResponses() });

        await runReplanPhase(buildState({ perBeadFeedback, dispatchCtx: ctx }));

        const plannerPrompt = rec.dispatches[0].prompt;

        // replan.mjs prefixes each bead's findings with its id (`${id}:\n...`)
        // before handing the combined text to buildPlannerPrompt, so the
        // ORIGINAL length the cap is measured against is that combined
        // string's length, not the raw fixture text's length alone.
        const combinedFindings = `${FLAGGED_ID}:\n${longFindings}`;
        const originalLength = combinedFindings.length;

        // The full untruncated text must NOT appear (only the truncated
        // prefix followed by the marker does).
        assert.ok(
            !plannerPrompt.includes(combinedFindings),
            'expected the full over-cap findings text to be truncated, not carried verbatim'
        );
        // The prompt carries exactly the first REPLAN_FINDINGS_MAX_LENGTH
        // characters of the combined findings text.
        assert.ok(
            plannerPrompt.includes(combinedFindings.slice(0, REPLAN_FINDINGS_MAX_LENGTH)),
            'expected the prompt to carry exactly the first REPLAN_FINDINGS_MAX_LENGTH characters of the findings'
        );
        assert.ok(
            plannerPrompt.includes('TRUNCATED') && plannerPrompt.includes(String(originalLength)) && plannerPrompt.includes(String(REPLAN_FINDINGS_MAX_LENGTH)),
            `expected a visible truncation marker naming the original length (${originalLength}) and the cap (${REPLAN_FINDINGS_MAX_LENGTH}), got: ${plannerPrompt}`
        );
    });
});
