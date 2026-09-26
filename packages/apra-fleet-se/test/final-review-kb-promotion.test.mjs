import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFinalVerdictPrompt, buildReviewerPrompt, kbPromotionBlock } from '../fleet-sprint/runner.js';
import { finalVerdict } from '../fleet-sprint/contracts.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

const CANDIDATES = [
    { id: 'kb-1', title: 'Zone rules use a spatial deadband', summary: 'Not a time debounce.', source_files: ['rules/zone_transit.go'] },
    { id: 'kb-2', title: 'Build needs CC=gcc', summary: 'conda toolchain breaks cgo.', source_files: ['go_server/Makefile'] },
];

const BASE = {
    targetIssues: ['BD-1'],
    branch: 'feat/x',
    baseBranch: 'main',
    goal: 'P1/P2',
    cyclesRun: 2,
    closedCount: 5,
    openAtGoalCount: 0,
    deployFailures: [],
    integFailures: [],
};

// =============================================================================
// apra-fleet-nx7: the Final Review -- the one review that reads the WHOLE diff
// and runs the FULL suite -- received no promotion-candidate block, so it could
// never promote. Observed live 2026-08-10 on feat/zone-transit-engine, whose
// final reviewer reported: "No Knowledge Bank tools were available in this
// session and the dispatch prompt carried no promotion-candidate block, so there
// is nothing to promote." The same sprint's per-round reviewers promoted 3.
//
// Consequence: anything a doer captured in a sprint's LAST round reaches this
// reviewer and nobody else, so late-sprint knowledge was stranded at INFERRED.
// =============================================================================
test('final verdict prompt carries the KB promotion candidates', () => {
    const prompt = buildFinalVerdictPrompt({ ...BASE, kbCandidates: CANDIDATES });
    check(prompt.includes('KNOWLEDGE BANK -- promotion candidates'), 'final prompt must carry the candidate block');
    check(prompt.includes('kb-1') && prompt.includes('kb-2'), 'every candidate id must be nameable by the reviewer');
    check(prompt.includes('kb_promotions'), 'the prompt must name the structured-output field to answer in');
});

test('final verdict prompt omits the block entirely when there is nothing to promote', () => {
    for (const empty of [undefined, []]) {
        const prompt = buildFinalVerdictPrompt({ ...BASE, kbCandidates: empty });
        check(!prompt.includes('KNOWLEDGE BANK'), `no candidates (${JSON.stringify(empty)}) must not render an empty block`);
    }
});

test('the final verdict schema accepts kb_promotions', () => {
    check(finalVerdict.properties.kb_promotions, 'finalVerdict must declare kb_promotions');
    const item = finalVerdict.properties.kb_promotions.items;
    assert.deepEqual(item.required, ['id', 'reason'], 'each promotion must carry its evidence, same shape as the per-round reviewer');
});

// The per-round reviewer and the final reviewer must state the SAME evidence
// bar. If the text is ever duplicated instead of shared, the two can drift to
// different standards -- and that drift is invisible, since both sides keep
// "working", with the only symptom being inconsistent CONFIRMED quality later.
test('both reviewer prompts render the identical promotion block', () => {
    const block = kbPromotionBlock(CANDIDATES).join('\n\n');
    check(block.length > 0, 'the shared helper must render a block for non-empty candidates');
    check(buildFinalVerdictPrompt({ ...BASE, kbCandidates: CANDIDATES }).includes(block), 'final prompt must embed the shared block verbatim');
    check(
        buildReviewerPrompt({
            beadIds: ['BD-1'], acceptanceCriteriaJson: '[]', baseBranch: 'main', branch: 'feat/x', kbCandidates: CANDIDATES,
        }).includes(block),
        'per-round reviewer prompt must embed the same shared block verbatim'
    );
});

test('kbPromotionBlock demands evidence, not plausibility', () => {
    const block = kbPromotionBlock(CANDIDATES).join('\n');
    check(block.includes('independently verified'), 'must require independent verification');
    check(block.includes('Evidence, not plausibility'), 'must state the evidence bar');
    check(block.includes('Never '), 'must forbid blanket promotion');
    check(/return \[\]/.test(block), 'promoting nothing must be an explicitly valid answer');
});
