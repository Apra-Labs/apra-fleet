import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    createKbWorkClient,
    buildReviewerPrompt,
    buildFinalVerdictPrompt,
    vetKbWork as runnerVet,
} from '../fleet-sprint/runner.js';
import { vetKbWork as pmVet } from '../apra-pm/lib/vet-kb-work.mjs';

// my-beads-db-qy8.13.2: permanent proof that ONE entry id cannot be promoted
// and demoted in the same round.
//
// The collision is not hypothetical: promotionCandidates offers INFERRED
// entries, demotionCandidates offers CONFIRMED/INFERRED entries whose
// source_files intersect the round diff, so a single INFERRED entry citing a
// changed file qualifies for BOTH blocks. Before the fix, vetKbWork validated
// kb_promotions and kb_demotions independently and apply() then issued
// kb_promote followed by kb_demote on that id -- a no-op in confidence terms
// that still appended two notes and stamped demoted_at.
//
// REVERT PROOF (required by this task's acceptance criteria, and confirmed by
// actually reverting locally before this was committed): revert
// my-beads-db-qy8.13.1 and
//
//   * the vetKbWork collision tests FAIL -- the colliding id is returned in
//     BOTH result.promotions and result.demotions, with no refusal recorded.
//   * 'apply() issues no kb_promote/kb_demote pair for the same id' FAILS --
//     the recorded tool calls contain both for that id.
//   * the kbDemotionBlock / buildReviewerPrompt tests FAIL -- the id appears
//     in both prompt blocks.
//   * the auto-sprint.js source assertions FAIL -- the workflow copy carries
//     neither the refusal string nor the collidingIds rule.
//
// The tests that pin the SINGLE-block behaviour pass either way, by design:
// they exist to catch a fix that over-reaches, not to prove the fix landed.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTO_SPRINT = path.join(__dirname, '..', 'apra-pm', '.claude', 'workflows', 'auto-sprint.js');

const GOOD_REASON = 'Verified against server/transit.js during this review: the cited helper changed.';

// The exact shape that lands in both candidate blocks: INFERRED, not a
// user-directive, and citing a file this round touched.
const COLLIDING_ENTRY = {
    id: 'kb-collide',
    type: 'knowledge',
    confidence: 'INFERRED',
    title: 'Transit rows key on trackId',
    summary: 'open transit is keyed by (trackId, locationId)',
    source_files: ['server/transit.js'],
};
const PROMOTION_ONLY_ENTRY = {
    id: 'kb-promote-only',
    type: 'knowledge',
    confidence: 'INFERRED',
    title: 'Only ever a promotion candidate',
    summary: 'cites a file outside this round diff',
    source_files: ['server/elsewhere.js'],
};
const DEMOTION_ONLY_ENTRY = {
    id: 'kb-demote-only',
    type: 'knowledge',
    confidence: 'CONFIRMED',
    title: 'Only ever a demotion candidate',
    summary: 'CONFIRMED, so never a promotion candidate',
    source_files: ['server/transit.js'],
};

/** The refusal string all three copies must agree on, verbatim. */
function collisionRefusal(role, id) {
    return `${role}: ${id} appears in both kb_promotions and kb_demotions -- refused both ways`;
}

const BASE_PROMPT = {
    beadIds: ['apra-fleet-aaa'],
    acceptanceCriteriaJson: '[]',
    baseBranch: 'main',
    branch: 'feat/thing',
    goal: 'P1',
};

// -----------------------------------------------------------------------------
// (1) vetKbWork -- the authoritative gate, exercised in both importable copies
//     from ONE shared fixture table so neither can satisfy it alone.
// -----------------------------------------------------------------------------
const VET_COPIES = [
    ['fleet-sprint/kb.mjs', runnerVet, (r) => r.refused],
    ['apra-pm/lib/vet-kb-work.mjs', pmVet, (r) => r.rejected],
];

describe('vetKbWork refuses an id named in both kb_promotions and kb_demotions', () => {
    for (const [label, vet, refusalsOf] of VET_COPIES) {
        test(`${label}: the colliding id is dropped from BOTH lists`, () => {
            const result = vet('reviewer', {
                kb_promotions: [{ id: COLLIDING_ENTRY.id, reason: GOOD_REASON }],
                kb_demotions: [{ id: COLLIDING_ENTRY.id, reason: GOOD_REASON }],
            });

            assert.deepEqual(result.promotions, [], 'the colliding id survived in kb_promotions');
            assert.deepEqual(result.demotions, [], 'the colliding id survived in kb_demotions');
        });

        test(`${label}: the refusal is NAMED, not silent`, () => {
            const result = vet('reviewer', {
                kb_promotions: [{ id: COLLIDING_ENTRY.id, reason: GOOD_REASON }],
                kb_demotions: [{ id: COLLIDING_ENTRY.id, reason: GOOD_REASON }],
            });

            assert.deepEqual(refusalsOf(result), [collisionRefusal('reviewer', COLLIDING_ENTRY.id)]);
        });

        test(`${label}: only the colliding id is refused -- the rest of the payload survives`, () => {
            const result = vet('reviewer', {
                kb_promotions: [
                    { id: COLLIDING_ENTRY.id, reason: GOOD_REASON },
                    { id: PROMOTION_ONLY_ENTRY.id, reason: GOOD_REASON },
                ],
                kb_demotions: [
                    { id: COLLIDING_ENTRY.id, reason: GOOD_REASON },
                    { id: DEMOTION_ONLY_ENTRY.id, reason: GOOD_REASON },
                ],
            });

            assert.deepEqual(result.promotions.map((p) => p.id), [PROMOTION_ONLY_ENTRY.id]);
            assert.deepEqual(result.demotions.map((d) => d.id), [DEMOTION_ONLY_ENTRY.id]);
            assert.equal(refusalsOf(result).length, 1);
        });

        test(`${label}: two colliding ids produce two distinct refusals`, () => {
            const result = vet('reviewer', {
                kb_promotions: [
                    { id: 'kb-one', reason: GOOD_REASON },
                    { id: 'kb-two', reason: GOOD_REASON },
                ],
                kb_demotions: [
                    { id: 'kb-two', reason: GOOD_REASON },
                    { id: 'kb-one', reason: GOOD_REASON },
                ],
            });

            assert.deepEqual(result.promotions, []);
            assert.deepEqual(result.demotions, []);
            assert.deepEqual(refusalsOf(result).sort(), [
                collisionRefusal('reviewer', 'kb-one'),
                collisionRefusal('reviewer', 'kb-two'),
            ].sort());
        });

        test(`${label}: an id repeated within ONE list is not a collision`, () => {
            // Duplicate promotions are a separate concern (kb_promote is
            // idempotent at CONFIRMED); this guard is only about an id
            // appearing on both SIDES of the ladder in one round.
            const result = vet('reviewer', {
                kb_promotions: [
                    { id: 'kb-dup', reason: GOOD_REASON },
                    { id: 'kb-dup', reason: GOOD_REASON },
                ],
            });

            assert.equal(result.promotions.length, 2);
            assert.deepEqual(refusalsOf(result), []);
        });

        // NO FALSE REFUSALS. A promotion-only and a demotion-only round must
        // behave exactly as they did before the guard existed.
        test(`${label}: a promotion-only round is untouched`, () => {
            const result = vet('reviewer', {
                kb_promotions: [{ id: PROMOTION_ONLY_ENTRY.id, reason: GOOD_REASON }],
            });

            assert.deepEqual(result.promotions, [{ id: PROMOTION_ONLY_ENTRY.id, reason: GOOD_REASON }]);
            assert.deepEqual(result.demotions, []);
            assert.deepEqual(refusalsOf(result), []);
        });

        test(`${label}: a demotion-only round is untouched`, () => {
            const result = vet('reviewer', {
                kb_demotions: [{ id: DEMOTION_ONLY_ENTRY.id, reason: GOOD_REASON }],
            });

            assert.deepEqual(result.demotions, [{ id: DEMOTION_ONLY_ENTRY.id, reason: GOOD_REASON, evidence_files: [] }]);
            assert.deepEqual(result.promotions, []);
            assert.deepEqual(refusalsOf(result), []);
        });

        test(`${label}: disjoint promotions and demotions in one round both survive`, () => {
            const result = vet('reviewer', {
                kb_promotions: [{ id: PROMOTION_ONLY_ENTRY.id, reason: GOOD_REASON }],
                kb_demotions: [{ id: DEMOTION_ONLY_ENTRY.id, reason: GOOD_REASON }],
            });

            assert.deepEqual(result.promotions.map((p) => p.id), [PROMOTION_ONLY_ENTRY.id]);
            assert.deepEqual(result.demotions.map((d) => d.id), [DEMOTION_ONLY_ENTRY.id]);
            assert.deepEqual(refusalsOf(result), []);
        });
    }

    test('the two importable copies agree exactly, refusal string included', () => {
        const payload = {
            kb_promotions: [{ id: COLLIDING_ENTRY.id, reason: GOOD_REASON }, { id: 'kb-p', reason: GOOD_REASON }],
            kb_demotions: [{ id: COLLIDING_ENTRY.id, reason: GOOD_REASON }, { id: 'kb-d', reason: GOOD_REASON }],
        };
        const a = runnerVet('reviewer', payload);
        const b = pmVet('reviewer', payload);

        assert.deepEqual(a.promotions, b.promotions);
        assert.deepEqual(a.demotions, b.demotions);
        // Stronger than vet-kb-work-drift.test.mjs's count-only comparison:
        // this task's acceptance requires the same REASON STRING, not just
        // the same number of refusals.
        assert.deepEqual(a.refused, b.rejected);
    });
});

// -----------------------------------------------------------------------------
// (2) apply() -- the execution half. The gate is only worth anything if no
//     kb_promote/kb_demote pair ever reaches the MCP boundary for one id.
// -----------------------------------------------------------------------------
describe('apply() issues no kb_promote/kb_demote pair for the same id in one round', () => {
    function recordingClient() {
        const calls = [];
        const client = createKbWorkClient({
            callTool: async (name, args) => { calls.push({ name, args }); return {}; },
            log: () => {},
        });
        return { calls, client };
    }

    test('a colliding id produces neither call', async () => {
        const { calls, client } = recordingClient();

        const counts = await client.apply('reviewer', '/srv/repo', {
            kb_promotions: [{ id: COLLIDING_ENTRY.id, reason: GOOD_REASON }],
            kb_demotions: [{ id: COLLIDING_ENTRY.id, reason: GOOD_REASON }],
        });

        const touched = calls.filter((c) => c.args && c.args.id === COLLIDING_ENTRY.id);
        assert.deepEqual(touched, [], 'a colliding id reached the MCP boundary');
        assert.equal(counts.promoted, 0);
        assert.equal(counts.demoted, 0);
        assert.equal(counts.refused, 1);
    });

    test('no id is ever both promoted and demoted in one round, even in a mixed payload', async () => {
        const { calls, client } = recordingClient();

        await client.apply('reviewer', '/srv/repo', {
            kb_promotions: [
                { id: COLLIDING_ENTRY.id, reason: GOOD_REASON },
                { id: PROMOTION_ONLY_ENTRY.id, reason: GOOD_REASON },
            ],
            kb_demotions: [
                { id: COLLIDING_ENTRY.id, reason: GOOD_REASON },
                { id: DEMOTION_ONLY_ENTRY.id, reason: GOOD_REASON },
            ],
        });

        const promotedIds = new Set(calls.filter((c) => c.name === 'kb_promote').map((c) => c.args.id));
        const demotedIds = new Set(calls.filter((c) => c.name === 'kb_demote').map((c) => c.args.id));
        const both = [...promotedIds].filter((id) => demotedIds.has(id));

        assert.deepEqual(both, [], `ids both promoted and demoted in one round: ${both.join(', ')}`);
        assert.deepEqual([...promotedIds], [PROMOTION_ONLY_ENTRY.id]);
        assert.deepEqual([...demotedIds], [DEMOTION_ONLY_ENTRY.id]);
    });

    test('a promotion-only round still issues its kb_promote', async () => {
        const { calls, client } = recordingClient();

        await client.apply('reviewer', '/srv/repo', {
            kb_promotions: [{ id: PROMOTION_ONLY_ENTRY.id, reason: GOOD_REASON }],
        });

        assert.deepEqual(
            calls.filter((c) => c.name === 'kb_promote').map((c) => c.args.id),
            [PROMOTION_ONLY_ENTRY.id],
        );
        assert.equal(calls.filter((c) => c.name === 'kb_demote').length, 0);
    });

    test('a demotion-only round still issues its kb_demote', async () => {
        const { calls, client } = recordingClient();

        await client.apply('reviewer', '/srv/repo', {
            kb_demotions: [{ id: DEMOTION_ONLY_ENTRY.id, reason: GOOD_REASON }],
        });

        assert.deepEqual(
            calls.filter((c) => c.name === 'kb_demote').map((c) => c.args.id),
            [DEMOTION_ONLY_ENTRY.id],
        );
        assert.equal(calls.filter((c) => c.name === 'kb_promote').length, 0);
    });
});

// -----------------------------------------------------------------------------
// (3) The prompt blocks -- the collision should not even be OFFERED.
// -----------------------------------------------------------------------------
describe('the candidate blocks offer a colliding id at most once', () => {
    /** Count the prompt blocks that name this id. */
    function blocksNaming(prompt, id) {
        const promotionBlock = /KNOWLEDGE BANK -- promotion candidates[^]*?(?=KNOWLEDGE BANK -- demotion candidates|$)/.exec(prompt);
        const demotionBlock = /KNOWLEDGE BANK -- demotion candidates[^]*/.exec(prompt);
        return {
            promotion: Boolean(promotionBlock && promotionBlock[0].includes(id)),
            demotion: Boolean(demotionBlock && demotionBlock[0].includes(id)),
        };
    }

    test('buildReviewerPrompt: an entry in both candidate sets is offered in exactly one block', () => {
        const prompt = buildReviewerPrompt({
            ...BASE_PROMPT,
            kbCandidates: [COLLIDING_ENTRY, PROMOTION_ONLY_ENTRY],
            kbDemotionCandidates: [COLLIDING_ENTRY, DEMOTION_ONLY_ENTRY],
        });

        const where = blocksNaming(prompt, COLLIDING_ENTRY.id);
        assert.ok(
            !(where.promotion && where.demotion),
            'the same id was offered for BOTH promotion and demotion in one prompt',
        );
        // Promotion keeps it -- that is the block the entry was captured for.
        assert.ok(where.promotion, 'the colliding id vanished from the prompt entirely');
    });

    test('buildReviewerPrompt: the non-colliding candidates are still offered in their own blocks', () => {
        const prompt = buildReviewerPrompt({
            ...BASE_PROMPT,
            kbCandidates: [COLLIDING_ENTRY, PROMOTION_ONLY_ENTRY],
            kbDemotionCandidates: [COLLIDING_ENTRY, DEMOTION_ONLY_ENTRY],
        });

        assert.deepEqual(blocksNaming(prompt, PROMOTION_ONLY_ENTRY.id), { promotion: true, demotion: false });
        assert.deepEqual(blocksNaming(prompt, DEMOTION_ONLY_ENTRY.id), { promotion: false, demotion: true });
    });

    test('buildFinalVerdictPrompt applies the same exclusion', () => {
        const prompt = buildFinalVerdictPrompt({
            targetIssues: ['apra-fleet-aaa'],
            branch: 'feat/thing',
            baseBranch: 'main',
            goal: 'P1',
            cyclesRun: 1,
            closedCount: 1,
            openAtGoalCount: 0,
            deployFailures: [],
            integFailures: [],
            kbCandidates: [COLLIDING_ENTRY],
            kbDemotionCandidates: [COLLIDING_ENTRY, DEMOTION_ONLY_ENTRY],
        });

        const where = blocksNaming(prompt, COLLIDING_ENTRY.id);
        assert.ok(!(where.promotion && where.demotion), 'the final-review prompt offered one id in both blocks');
        assert.deepEqual(blocksNaming(prompt, DEMOTION_ONLY_ENTRY.id), { promotion: false, demotion: true });
    });

    test('the demotion block disappears entirely when every candidate was already offered for promotion', () => {
        const prompt = buildReviewerPrompt({
            ...BASE_PROMPT,
            kbCandidates: [COLLIDING_ENTRY],
            kbDemotionCandidates: [COLLIDING_ENTRY],
        });

        assert.ok(
            !/KNOWLEDGE BANK -- demotion candidates/.test(prompt),
            'an empty demotion block was still emitted, inviting kb_demotions with nothing to name',
        );
    });

    test('a demotion-only round still gets its full demotion block', () => {
        const prompt = buildReviewerPrompt({
            ...BASE_PROMPT,
            kbDemotionCandidates: [COLLIDING_ENTRY, DEMOTION_ONLY_ENTRY],
        });

        assert.match(prompt, /KNOWLEDGE BANK -- demotion candidates/);
        for (const e of [COLLIDING_ENTRY, DEMOTION_ONLY_ENTRY]) {
            assert.ok(prompt.includes(e.id), `candidate ${e.id} missing from a demotion-only prompt`);
        }
    });
});

// -----------------------------------------------------------------------------
// (4) The third lockstep copy. auto-sprint.js is executed by Claude's Workflow
//     tool in a VM with no filesystem and no require(), so it is reachable only
//     as text -- the same technique vet-kb-work-drift.test.mjs uses.
// -----------------------------------------------------------------------------
describe('the workflow copy carries the same collision rule', () => {
    const src = fs.readFileSync(AUTO_SPRINT, 'utf-8');

    test('auto-sprint.js carries the identical refusal string', () => {
        assert.match(src, /\$\{role\}: \$\{id\} appears in both kb_promotions and kb_demotions -- refused both ways/);
    });

    test('auto-sprint.js computes the colliding ids the same way', () => {
        assert.match(src, /const collidingIds = new Set\(/);
        assert.match(src, /demotions\.filter\(\(d\) => promotions\.some\(\(p\) => p\.id === d\.id\)\)\.map\(\(d\) => d\.id\)/);
    });

    test('auto-sprint.js drops the colliding id from BOTH returned lists', () => {
        assert.match(src, /promotions: promotions\.filter\(\(p\) => !collidingIds\.has\(p\.id\)\)/);
        assert.match(src, /demotions: demotions\.filter\(\(d\) => !collidingIds\.has\(d\.id\)\)/);
    });

    test('the refusal string in the workflow copy matches the importable copies verbatim', () => {
        // Rebuild the literal the importable copies produce and check the
        // workflow template renders the same text for the same inputs.
        const rendered = collisionRefusal('reviewer', 'kb-x');
        const template = /`(\$\{role\}: \$\{id\} appears in both kb_promotions and kb_demotions -- refused both ways)`/.exec(src);
        assert.ok(template, 'no collision refusal template found in auto-sprint.js');
        assert.equal(
            template[1].replace('${role}', 'reviewer').replace('${id}', 'kb-x'),
            rendered,
        );
    });
});
