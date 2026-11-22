import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCmd, runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';
import { buildReviewerPrompt, PRIOR_REVIEW_FINDINGS_CAP } from '../fleet-sprint/prompts.mjs';
import { policyFor } from '../fleet-sprint/role-policies.mjs';
import { createRoundSessionRegistry } from '../fleet-sprint/round-session.mjs';

// Review rounds 2+ inside one cycle start in a FRESH reviewer session (resume
// false) and carry only a capped summary of the prior round's findings, never
// the prior round's session. A max_turns-exhausted round is still resumed by
// its OWN explicit session id. The planner's round resume is unchanged.

const FINDINGS_MARKER = 'prior-round.review-findings';
const HUGE_NOTES_TAIL = 'ZZ-TAIL-SENTINEL';

test('mock sprint: reviewer rounds 2+ are fresh, carry a capped prior-findings summary; max_turns resumes own session', async () => {
    await withScenarioMarkers('reviewer fresh rounds', async () => {
        const sc = await runDevelopLoopScenario('reviewerfresh', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: fresh-review target A' }],
            maxCycles: 2,
            reviewerHandler: async ({ opts, tempDir: td, epicBead, reviewRound: rRound }) => {
                const list = JSON.parse((await runCmd(`bd list --parent ${epicBead.id} --all --json`, td)).stdout || '[]');
                const a = list.find((b) => b.title.startsWith('Task: fresh-review target A'));
                if (rRound === 1 || rRound === 2) {
                    const notes = rRound === 1
                        ? `round-one finding. ${'x'.repeat(PRIOR_REVIEW_FINDINGS_CAP * 2)}${HUGE_NOTES_TAIL}`
                        : 'round-two finding.';
                    return {
                        content: [{ text: JSON.stringify({ verdict: 'CHANGES_NEEDED', notes, reopenIds: [a.id], newTasks: [] }) }],
                        structuredContent: { sessionId: `sess-rev-r${rRound}` },
                    };
                }
                // Round 3: first attempt runs out of turns on its own session;
                // the in-dispatch resume must carry that session's explicit id.
                if (opts.resume === false || opts.resume === undefined) {
                    return {
                        content: [{ text: 'out of turns' }],
                        structuredContent: { isError: true, reason: 'max_turns_exhausted', sessionId: 'sess-rev-mt' },
                    };
                }
                return {
                    content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'ok', reopenIds: [], newTasks: [] }) }],
                };
            },
        });
        assert.ok(!sc.error, `scenario errored: ${sc.error ? sc.error.message : ''}`);

        const rev = sc.dispatched.filter((d) => d.agent === 'reviewer' && d.label !== 'Final Review');
        assert.ok(rev.length >= 4, `expected >=4 reviewer dispatches, got ${rev.length}`);
        // Round 1, 2, 3 (first attempt): all fresh, despite earlier session ids.
        assert.equal(rev[0].resume, false, 'round 1 fresh');
        assert.equal(rev[1].resume, false, `round 2 must be fresh, got ${JSON.stringify(rev[1].resume)}`);
        assert.equal(rev[2].resume, false, `round 3 must be fresh, got ${JSON.stringify(rev[2].resume)}`);
        // Round 1 has no findings block; rounds 2 and 3 do.
        assert.ok(!rev[0].prompt.includes(FINDINGS_MARKER), 'round 1 prompt must carry no findings block');
        assert.ok(rev[1].prompt.includes(FINDINGS_MARKER) && rev[1].prompt.includes('CHANGES_NEEDED') && rev[1].prompt.includes('reopenIds: '), 'round 2 prompt carries round 1 summary');
        assert.ok(rev[1].prompt.includes('round-one finding.'), 'round 2 prompt names round 1 notes');
        assert.ok(!rev[1].prompt.includes(HUGE_NOTES_TAIL), 'oversized notes are truncated to the cap');
        assert.ok(rev[2].prompt.includes('round-two finding.'), 'round 3 prompt carries round 2 summary');
        // max_turns resume continues the exhausted dispatch's OWN session.
        assert.equal(rev[3].resume, 'sess-rev-mt', `max_turns resume must use own session id, got ${JSON.stringify(rev[3].resume)}`);
    });
});

test('buildReviewerPrompt: prior findings block lists reopen ids and new-task titles, is capped, and is optional', () => {
    const base = {
        beadIds: ['b-1'], acceptanceCriteriaJson: '[]', baseBranch: 'main', branch: 'feat/x',
        mergeBaseSha: 'a'.repeat(40),
    };
    assert.ok(!buildReviewerPrompt(base).includes(FINDINGS_MARKER));
    const p = buildReviewerPrompt({
        ...base,
        priorRoundFindings: {
            verdict: 'CHANGES_NEEDED', notes: 'n'.repeat(PRIOR_REVIEW_FINDINGS_CAP * 3),
            reopenIds: ['b-9'], newTasks: [{ title: 'Add missing test' }],
        },
    });
    assert.ok(p.includes('b-9') && p.includes('Add missing test') && p.includes('CHANGES_NEEDED'));
    assert.ok(p.length < buildReviewerPrompt(base).length + PRIOR_REVIEW_FINDINGS_CAP + 1500, 'summary is length-capped');
});

test('planner keeps its round-session resume; reviewer policy is fresh-session', () => {
    assert.equal(policyFor('planner').resumeArg.kind, 'round-session');
    assert.equal(policyFor('reviewer').resumeArg.kind, 'fresh-session');
    const reg = createRoundSessionRegistry();
    reg.record('planner', 1, 'sess-plan', {});
    assert.equal(reg.resumeArgFor('planner', 1), 'sess-plan');
    assert.equal(reg.resumeArgFor('planner', 2), false);
});
