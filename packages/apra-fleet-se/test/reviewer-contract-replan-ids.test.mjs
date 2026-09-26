import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isReviewerContractViolation, buildReviewerPrompt } from '../fleet-sprint/runner.js';
import { runCmd, runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-9ta.5 -- a CHANGES_NEEDED verdict carrying ONLY `replanIds`
// (empty reopenIds AND empty newTasks) is NOT a reviewer contract violation:
// the scoped-replan machinery consumes exactly that shape. Previously
// isReviewerContractViolation() ignored replanIds entirely, so a reviewer
// that flagged a still-ready bead for replan WITHOUT also reopening anything
// (nothing to reopen -- the bead may never have been dispatched at all) was
// misclassified as self-contradictory and aborted the sprint via
// ReviewerContractViolationError, making that shape of scoped-replan
// unreachable. Also: buildReviewerPrompt() never mentioned `replanIds` at
// all, so reviewers never knew to populate it in the first place.
// =============================================================================

test('isReviewerContractViolation: CHANGES_NEEDED with only replanIds is NOT a contract violation', () => {
    check(
        !isReviewerContractViolation({
            verdict: 'CHANGES_NEEDED',
            notes: 'X needs replanning.',
            reopenIds: [],
            newTasks: [],
            replanIds: ['apra-fleet-x.1'],
        }),
        'Expected a non-empty replanIds to exempt the verdict from the contract-violation predicate'
    );
});

test('isReviewerContractViolation: CHANGES_NEEDED with empty reopenIds/newTasks/replanIds is still a contract violation', () => {
    check(
        isReviewerContractViolation({
            verdict: 'CHANGES_NEEDED',
            notes: 'Contradictory.',
            reopenIds: [],
            newTasks: [],
            replanIds: [],
        }),
        'Expected the all-empty verdict to remain a contract violation'
    );
    check(
        isReviewerContractViolation({
            verdict: 'CHANGES_NEEDED',
            notes: 'Contradictory, replanIds omitted entirely.',
            reopenIds: [],
            newTasks: [],
        }),
        'Expected the all-empty verdict (replanIds omitted) to remain a contract violation'
    );
});

test('isReviewerContractViolation: APPROVED verdicts are never contract violations regardless of replanIds', () => {
    check(
        !isReviewerContractViolation({
            verdict: 'APPROVED',
            notes: 'Looks good.',
            reopenIds: [],
            newTasks: [],
        }),
        'Expected an APPROVED verdict to never be a contract violation'
    );
});

test('buildReviewerPrompt: output mentions replanIds and states its semantics', () => {
    const prompt = buildReviewerPrompt({
        beadIds: ['apra-fleet-x.1'],
        acceptanceCriteriaJson: '{}',
        baseBranch: 'main',
        branch: 'feat/x',
    });
    check(prompt.includes('replanIds'), `Expected buildReviewerPrompt output to mention replanIds, got: ${prompt}`);
    check(
        /replanIds`?:.*replan/i.test(prompt) || /replan.*replanIds/i.test(prompt),
        `Expected buildReviewerPrompt output to describe replanIds' semantics (replan), got: ${prompt}`
    );
});

// End-to-end: a CHANGES_NEEDED verdict carrying replanIds for a bead that was
// never dispatched/reopened this round at all (so reopenIds AND newTasks are
// both empty) must NOT abort the sprint as ReviewerContractViolationError --
// isReviewerContractViolation() exempts this shape by design (see its doc
// comment). But per buildReviewerPrompt's instruction, replanIds is only
// ACTED ON (fed into the scoped-replan machinery) for ids ALSO named in
// reopenIds this round; an id named in replanIds alone is dropped -- logged,
// not silently discarded -- rather than treated as a "not yet worked" replan
// target, since the consuming loop (runner.js ~7163) has no reopened bead to
// gate a scoped replan against.
//
// Setup: task W blocks task V (bd dep add V W), so only W is ready in round
// 1. The doer closes W, which unblocks V. Round 1's review (scoped to W)
// flags newly-ready V for replan via `replanIds`, with EMPTY `reopenIds`
// (V was never dispatched, so there is nothing on it to reopen) and EMPTY
// `newTasks` -- before this fix, isReviewerContractViolation() ignored
// replanIds entirely and this shape was retried once then thrown as a
// self-contradictory ReviewerContractViolationError, aborting the sprint.
// After the fix the round is treated as ordinary CHANGES_NEEDED (not a
// contract violation): V is NOT scoped-replanned (it was never reopened, so
// the drop is logged), and the sprint proceeds to dispatch V normally in the
// next round instead of aborting.
test('mock sprint: replanIds alone (no reopenIds, no newTasks) does not abort the sprint as a contract violation', async () => {
    await withScenarioMarkers('replanIds-only (no reopenIds) does not abort', async () => {
        console.log('Running mock sprint scenario (replanIds-only reviewer verdict)...');

        const sc = await runDevelopLoopScenario('replanonly', {
            members: ['local'],
            taskSpecs: [
                { title: 'Task: Replan-only target W' },
                { title: 'Task: Second still-ready task V' },
            ],
            maxCycles: 1,
            beforeSprint: async ({ tempDir, tasks }) => {
                const w = tasks.find((t) => t.title === 'Task: Replan-only target W');
                const v = tasks.find((t) => t.title === 'Task: Second still-ready task V');
                // V is blocked by W: V only becomes ready once W closes.
                await runCmd(`bd dep add ${v.id} ${w.id}`, tempDir);
            },
            reviewerHandler: async ({ tempDir, runCmd: rc, epicBead, reviewRound: rRound }) => {
                if (rRound === 1) {
                    const list = JSON.parse((await rc(`bd list --parent ${epicBead.id} --all --json`, tempDir)).stdout || '[]');
                    const v = list.find((b) => b.title.includes('Second still-ready task V'));
                    return {
                        content: [{
                            text: JSON.stringify({
                                verdict: 'CHANGES_NEEDED',
                                notes: `${v.id} just became ready and its acceptance criteria are ambiguous -- needs replanning before any doer touches it; nothing to reopen.`,
                                reopenIds: [],
                                replanIds: [v.id],
                                newTasks: [],
                            }),
                        }],
                    };
                }
                return {
                    content: [{
                        text: JSON.stringify({
                            verdict: 'APPROVED',
                            notes: 'Looks good.',
                            reopenIds: [],
                            newTasks: [],
                        }),
                    }],
                };
            },
        });

        check(
            !sc.error,
            `Expected engine.executeFile() to resolve without aborting as a contract violation, got error: ${sc.error ? sc.error.constructor.name + ': ' + sc.error.message : 'none'}`
        );
        check(
            !sc.logs.some((l) => l.includes('contract violation')),
            `Did NOT expect a reviewer contract-violation log line, logs: ${JSON.stringify(sc.logs.filter((l) => l.includes('contract')))}`
        );

        const wId = sc.tasks.find((t) => t.title === 'Task: Replan-only target W').id;
        const vId = sc.tasks.find((t) => t.title === 'Task: Second still-ready task V').id;

        // buildReviewerPrompt now tells reviewers replanIds must be a subset
        // of reopenIds; this scenario deliberately violates that (replanIds
        // names V, reopenIds is empty) to prove the drop is LOGGED rather than
        // silent -- the gap the previous round of this bead left unaddressed.
        check(
            sc.logs.some((l) => l.includes('replanIds: DROPPED') && l.includes(vId)),
            `Expected a 'replanIds: DROPPED' log line naming ${vId} (replanIds without a matching reopenIds entry ` +
            `must be visibly dropped, not silently ignored), logs: ${JSON.stringify(sc.logs.filter((l) => l.includes('replanIds')))}`
        );

        const wFinal = sc.finalBeadsById.get(wId);
        const vFinal = sc.finalBeadsById.get(vId);
        check(
            wFinal && wFinal.status === 'closed',
            `Expected ${wId} to end up closed normally, got: ${wFinal ? wFinal.status : '(bead not found)'}`
        );
        check(
            vFinal && vFinal.status === 'closed',
            `Expected ${vId} to end up closed (dispatched normally once ready: replanIds without a matching reopenIds ` +
            `entry is BY DESIGN dropped -- see the 'replanIds: DROPPED' assertion above -- not merely tolerated), got: ${vFinal ? vFinal.status : '(bead not found)'}`
        );
    });
});
