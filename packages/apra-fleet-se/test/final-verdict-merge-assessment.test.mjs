import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    finalVerdict, validateVerdict, MERGE_ASSESSMENT_FIELDS, MERGE_RECOMMENDATIONS,
} from '../fleet-sprint/contracts.mjs';
import { buildFinalVerdictPrompt } from '../fleet-sprint/prompts.mjs';
import {
    PR_MERGE_RECOMMENDATIONS, MERGE_ASSESSMENT_LABELS, normalizeMergeAssessment, renderMergeAssessment,
} from '../fleet-sprint/pr-body.mjs';

// =============================================================================
// The Final Review's optional risk/value merge assessment: the engine-owned
// finalVerdict schema accepts it (and a verdict without it), and the Final
// Review prompt asks for every field and every recommendation value.
//
// ASCII only.
// =============================================================================

const COMPLETE = Object.freeze({
    value: 'Operators see the merge recommendation first.',
    risk: 'Low: a new optional field; old verdicts still validate.',
    default_path_changes: 'none',
    blast_radius: 'Final Review output and the sprint PR body.',
    upgrade_impact: 'none',
    proof: 'Unit tests for the schema, the prompt and the PR body.',
    recommendation: 'merge_after_proof',
    reason: 'A live PR on each hosting provider has not been raised yet.',
});

const BASE_PROMPT = {
    targetIssues: ['BD-1'], branch: 'feat/x', baseBranch: 'main',
    mergeBaseSha: 'abcdef0123456789abcdef0123456789abcdef01', goal: 'P2',
    cyclesRun: 1, closedCount: 3, openAtGoalCount: 0, deployFailures: [], integFailures: [],
};

describe('finalVerdict schema: merge_assessment', () => {
    test('a verdict WITHOUT merge_assessment is still valid', () => {
        const r = validateVerdict('finalVerdict', { verdict: 'PASS', notes: 'ok' });
        assert.equal(r.valid, true, JSON.stringify(r.errors));
    });

    test('a verdict WITH a complete merge_assessment is valid, for every recommendation value', () => {
        for (const recommendation of ['merge', 'merge_after_proof', 'do_not_merge']) {
            const r = validateVerdict('finalVerdict', { verdict: 'FAIL', notes: 'x', merge_assessment: { ...COMPLETE, recommendation } });
            assert.equal(r.valid, true, `${recommendation}: ${JSON.stringify(r.errors)}`);
        }
    });

    test('a malformed assessment (unknown recommendation, missing field, wrong type) still validates: it is advisory', () => {
        const { proof: _omit, ...partial } = COMPLETE;
        for (const merge_assessment of [{ ...COMPLETE, recommendation: 'ship_it' }, partial, { value: 5 }, 'text']) {
            const r = validateVerdict('finalVerdict', { verdict: 'PASS', notes: 'x', merge_assessment });
            assert.equal(r.valid, true, JSON.stringify(r.errors));
        }
    });

    test('merge_assessment stays optional and verdict/notes stay the only required fields', () => {
        assert.deepEqual(finalVerdict.required, ['verdict', 'notes']);
        assert.equal(finalVerdict.properties.merge_assessment.required, undefined);
        assert.deepEqual(Object.keys(finalVerdict.properties.merge_assessment.properties).sort(), [...MERGE_ASSESSMENT_FIELDS].sort());
    });

    test('the PR body renders exactly the contract recommendation values and every non-recommendation field', () => {
        assert.deepEqual([...PR_MERGE_RECOMMENDATIONS], [...MERGE_RECOMMENDATIONS]);
        assert.deepEqual(
            [...Object.keys(MERGE_ASSESSMENT_LABELS), 'recommendation', 'reason'].sort(),
            [...MERGE_ASSESSMENT_FIELDS].sort(),
        );
    });
});

describe('buildFinalVerdictPrompt: merge_assessment request', () => {
    const prompt = buildFinalVerdictPrompt(BASE_PROMPT);

    test('names the merge_assessment object and every one of its fields', () => {
        assert.ok(prompt.includes('`merge_assessment`'), 'the prompt must name the output field');
        for (const field of ['value', 'risk', 'default_path_changes', 'blast_radius', 'upgrade_impact', 'proof', 'recommendation', 'reason']) {
            assert.ok(prompt.includes('`' + field + '`'), `the prompt must ask for \`${field}\``);
        }
    });

    test('names all three recommendation values', () => {
        for (const rec of ['merge', 'merge_after_proof', 'do_not_merge']) {
            assert.ok(prompt.includes('`' + rec + '`'), `the prompt must offer \`${rec}\``);
        }
    });
});

describe('normalizeMergeAssessment / renderMergeAssessment', () => {
    test('a complete assessment normalizes unchanged, drops nothing and renders with no note', () => {
        const r = normalizeMergeAssessment({ ...COMPLETE });
        assert.deepEqual(r, { assessment: { ...COMPLETE }, dropped: [] });
        assert.ok(!renderMergeAssessment(r.assessment, r.dropped).includes('incomplete'));
    });

    test('a 5-field assessment keeps its fields and names the 3 missing', () => {
        const five = { value: 'v', risk: 'r', proof: 'p', recommendation: 'merge', reason: 'because' };
        const r = normalizeMergeAssessment(five);
        assert.deepEqual(r.assessment, five);
        assert.deepEqual(r.dropped, ['default_path_changes', 'blast_radius', 'upgrade_impact']);
        const out = renderMergeAssessment(r.assessment, r.dropped);
        assert.ok(out.includes('**Value:** v') && out.includes('`merge`'));
        assert.ok(out.includes('assessment incomplete: default_path_changes, blast_radius, upgrade_impact'), out);
        assert.ok(!out.includes('(not given)'));
    });

    test('a misspelled field is dropped and named alongside the field it should have been', () => {
        const { blast_radius, ...rest } = COMPLETE;
        const r = normalizeMergeAssessment({ ...rest, blast_radiuss: blast_radius });
        assert.deepEqual(r.dropped, ['blast_radius', 'blast_radiuss']);
        assert.ok(renderMergeAssessment(r.assessment, r.dropped).includes('assessment incomplete: blast_radius, blast_radiuss'));
    });

    test('an invalid recommendation is dropped; no valid field leaves only the note', () => {
        assert.deepEqual(normalizeMergeAssessment({ ...COMPLETE, recommendation: 'ship_it' }).dropped, ['recommendation']);
        const none = normalizeMergeAssessment({ nope: 1 });
        assert.equal(none.assessment, undefined);
        const out = renderMergeAssessment(none.assessment, none.dropped);
        assert.ok(out.startsWith('_assessment incomplete:') && !out.includes('- **'), out);
        assert.equal(normalizeMergeAssessment(undefined).dropped.length, 0);
        assert.equal(renderMergeAssessment(undefined, []), '');
    });
});
