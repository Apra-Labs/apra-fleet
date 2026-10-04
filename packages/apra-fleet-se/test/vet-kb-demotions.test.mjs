import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { vetKbWork, KB_PROMOTER_ROLES, KB_MIN_PROMOTE_REASON } from '../fleet-sprint/runner.js';

// D6/C4: vetKbWork's kb_demotions gate -- the validation half of the
// demotion path, exercised directly (no callTool at all; vetKbWork is a pure
// function of (role, result)). Mirrors the kb_promotions gate exactly: same
// KB_PROMOTER_ROLES reviewer-only check, same KB_MIN_PROMOTE_REASON evidence
// floor, same refused-array recording instead of throwing.

const GOOD_REASON = 'Verified against server/transit.js: the cited helper was removed in this diff.';

describe('vetKbWork kb_demotions gate (D6/C4)', () => {
    test('a reviewer demotion with a sufficient reason is accepted', () => {
        const result = vetKbWork('reviewer', {
            kb_demotions: [{ id: 'kb-abc', reason: GOOD_REASON }],
        });

        assert.deepEqual(result.demotions, [{ id: 'kb-abc', reason: GOOD_REASON, evidence_files: [] }]);
        assert.deepEqual(result.refused, []);
    });

    test('evidence_files is carried through, trimmed to real strings only', () => {
        const result = vetKbWork('reviewer', {
            kb_demotions: [{ id: 'kb-abc', reason: GOOD_REASON, evidence_files: ['server/transit.js', '', 42, null, 'server/rules.js'] }],
        });

        assert.deepEqual(result.demotions[0].evidence_files, ['server/transit.js', 'server/rules.js']);
    });

    test('evidence_files is optional -- omitted or empty both succeed with []', () => {
        for (const evidence_files of [undefined, []]) {
            const result = vetKbWork('reviewer', {
                kb_demotions: [{ id: 'kb-abc', reason: GOOD_REASON, ...(evidence_files === undefined ? {} : { evidence_files }) }],
            });
            assert.deepEqual(result.demotions[0].evidence_files, []);
            assert.deepEqual(result.refused, []);
        }
    });

    test('REFUSES kb_demotions from every non-reviewer role, recording it in refused (never throws)', () => {
        for (const role of ['doer', 'planner', 'harvester', 'deployer', 'plan-reviewer']) {
            const result = vetKbWork(role, {
                kb_demotions: [{ id: 'kb-abc', reason: GOOD_REASON }],
            });

            assert.deepEqual(result.demotions, [], `${role} must not have any demotion accepted`);
            assert.equal(result.refused.length, 1, `${role}'s kb_demotions must be refused, not silently dropped`);
            assert.match(result.refused[0], /demotion is reviewer-only/);
        }
    });

    test('REFUSES a reason shorter than 20 trimmed characters', () => {
        const result = vetKbWork('reviewer', {
            kb_demotions: [{ id: 'kb-abc', reason: 'too short' }],
        });

        assert.deepEqual(result.demotions, []);
        assert.equal(result.refused.length, 1);
        assert.match(result.refused[0], /no recorded evidence/);
    });

    test('a reason of exactly 20 characters (after trim) is accepted; 19 is refused', () => {
        const exactly20 = vetKbWork('reviewer', { kb_demotions: [{ id: 'kb-abc', reason: 'x'.repeat(20) }] });
        assert.equal(exactly20.demotions.length, 1);

        const nineteen = vetKbWork('reviewer', { kb_demotions: [{ id: 'kb-abc', reason: 'x'.repeat(19) }] });
        assert.equal(nineteen.demotions.length, 0);
        assert.equal(nineteen.refused.length, 1);
    });

    test('whitespace-only and empty reasons are refused (trimmed length counts)', () => {
        for (const reason of ['', '   ', '\n\n']) {
            const result = vetKbWork('reviewer', { kb_demotions: [{ id: 'kb-abc', reason }] });
            assert.deepEqual(result.demotions, []);
            assert.equal(result.refused.length, 1);
        }
    });

    test('a demotion missing an id is refused', () => {
        const result = vetKbWork('reviewer', {
            kb_demotions: [{ reason: GOOD_REASON }],
        });

        assert.deepEqual(result.demotions, []);
        assert.equal(result.refused.length, 1);
        assert.match(result.refused[0], /demotion missing id/);
    });

    test('a demotion with an empty-string id is refused', () => {
        const result = vetKbWork('reviewer', {
            kb_demotions: [{ id: '', reason: GOOD_REASON }],
        });

        assert.deepEqual(result.demotions, []);
        assert.equal(result.refused.length, 1);
    });

    test('one bad demotion does not discard a good one beside it', () => {
        const result = vetKbWork('reviewer', {
            kb_demotions: [
                { id: 'kb-bad', reason: 'short' },
                { id: 'kb-good', reason: GOOD_REASON },
            ],
        });

        assert.deepEqual(result.demotions.map((d) => d.id), ['kb-good']);
        assert.equal(result.refused.length, 1);
    });

    test('kb_demotions and kb_promotions are vetted independently in the same call', () => {
        const result = vetKbWork('reviewer', {
            kb_promotions: [{ id: 'kb-promo', reason: GOOD_REASON }],
            kb_demotions: [{ id: 'kb-demo', reason: GOOD_REASON }],
        });

        assert.equal(result.promotions.length, 1);
        assert.equal(result.demotions.length, 1);
        assert.deepEqual(result.refused, []);
    });

    test('missing/non-array/null kb_demotions all degrade to no demotions, never throw', () => {
        for (const payload of [{}, { kb_demotions: null }, { kb_demotions: 'nope' }, null, undefined]) {
            const result = vetKbWork('reviewer', payload);
            assert.deepEqual(result.demotions, []);
        }
    });

    test('reuses KB_PROMOTER_ROLES and KB_MIN_PROMOTE_REASON -- the same constants kb_promotions is gated by', () => {
        assert.ok(KB_PROMOTER_ROLES.has('reviewer'));
        assert.ok(!KB_PROMOTER_ROLES.has('doer'));
        assert.equal(KB_MIN_PROMOTE_REASON, 20);
    });
});
