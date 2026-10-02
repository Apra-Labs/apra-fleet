import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createKbWorkClient, vetKbWork, kbPromotionBlock, KB_MAX_PROMOTION_CANDIDATES } from '../fleet-sprint/kb.mjs';
import { reviewerVerdict, finalVerdict } from '../fleet-sprint/contracts.mjs';
import { fakeMaintainerSelector } from './helpers/kb-maintainer-fakes.mjs';

// =============================================================================
// Review candidates and CONFIRM/DISCARD judgements on the kb_maintainer:
//   - candidates are read with exactly kb_query {tag: member:<maintainer uuid>,
//     confidence: [INFERRED], limit} in the maintainer's session and filtered
//     to the sprint window (created_at >= sprint start);
//   - kb_promotions -> kb_promote {id, reason}, kb_discards -> kb_invalidate
//     {ids: [id]}, both in the maintainer's session after a G-pull;
//   - kb_discards is reviewer-only, needs a real reason, and an id both
//     promoted and discarded in one output is refused on both sides.
// =============================================================================

const REPO = 'github.com/org/widget';
const MAINT = Object.freeze({ id: '0b9d3a1e-5f2c-4c6e-9a7b-6d61696e7400', name: 'maint', type: 'remote' });
const SPRINT_START = Date.parse('2026-10-01T10:00:00.000Z');
const REASON = 'Verified against src/widget-cache.ts:42 and the tenant isolation test.';
const WRONG = 'src/widget-cache.ts:42 keys by tenant AND id -- the entry claims tenant only.';

const entry = (id, created_at, extra = {}) => ({
    id, created_at, type: 'knowledge', confidence: 'INFERRED',
    title: `entry ${id}`, summary: `summary of ${id}`, source_files: ['src/widget-cache.ts'], ...extra,
});

function harness({ entries = [], invalidateResult } = {}) {
    const events = [];
    const logs = [];
    const client = createKbWorkClient({
        maintainers: fakeMaintainerSelector({
            repoOf: { reviewer: REPO, doer: REPO, maint: REPO },
            maintainerOf: { [REPO]: MAINT },
            nonRepo: ['scratch'],
        }),
        sprintStartMs: () => SPRINT_START,
        memberCall: async (member, tool, args) => {
            events.push({ type: 'call', member: member.name, tool, args });
            if (tool === 'kb_query') return { content: [{ type: 'text', text: JSON.stringify({ l1_results: entries }) }] };
            if (tool === 'kb_invalidate') {
                const r = invalidateResult ? invalidateResult(args) : { discarded: args.ids, not_found: [], already_discarded: [] };
                return { content: [{ type: 'text', text: JSON.stringify(r) }] };
            }
            return {};
        },
        gPull: async (name) => { events.push({ type: 'gpull', member: name }); },
        log: (m) => logs.push(m),
    });
    const shape = () => events.map((e) => (e.type === 'gpull' ? `gpull:${e.member}` : `${e.tool}@${e.member}`));
    return { client, events, logs, shape };
}

describe('promotion candidates: the maintainer read and the sprint window', () => {
    test('read with exactly kb_query {tag, confidence, limit} in the maintainer session', async () => {
        const h = harness({ entries: [entry('kb-new', '2026-10-01T11:00:00.000Z')] });
        const out = await h.client.promotionCandidates('reviewer');
        assert.deepEqual(h.events, [{
            type: 'call', member: 'maint', tool: 'kb_query',
            args: { tag: `member:${MAINT.id}`, confidence: ['INFERRED'], limit: KB_MAX_PROMOTION_CANDIDATES },
        }]);
        assert.deepEqual(out.map((e) => e.id), ['kb-new']);
    });

    test('only entries created at or after the sprint start are offered', async () => {
        const h = harness({
            entries: [
                entry('kb-before', '2026-10-01T09:59:59.999Z'),
                entry('kb-at-start', '2026-10-01T10:00:00.000Z'),
                entry('kb-during', '2026-10-01T12:30:00.000Z'),
                entry('kb-no-date', undefined),
                entry('kb-directive', '2026-10-01T12:31:00.000Z', { type: 'user-directive' }),
            ],
        });
        const out = await h.client.promotionCandidates('reviewer');
        assert.deepEqual(out.map((e) => e.id), ['kb-at-start', 'kb-during']);
    });

    test('the reviewer prompt block carries exactly those entries and names both judgement fields', async () => {
        const h = harness({ entries: [entry('kb-before', '2026-09-30T00:00:00.000Z'), entry('kb-during', '2026-10-01T12:30:00.000Z')] });
        const [block] = kbPromotionBlock(await h.client.promotionCandidates('reviewer'));
        assert.ok(block.includes('kb-during'));
        assert.ok(!block.includes('kb-before'), 'an entry from before the sprint must not reach the prompt');
        assert.match(block, /`kb_promotions`/);
        assert.match(block, /`kb_discards`/);
    });

    test('the candidate read never flushes while the maintainer is mid-dispatch', async () => {
        const h = harness();
        const capture = {
            type: 'knowledge', title: 'queued claim', summary: 'a claim captured this round',
            content: 'the content of the claim captured this round', source_files: ['src/a.ts'],
        };
        // Queue a capture behind a busy maintainer.
        await h.client.dispatchStarted('maint');
        await h.client.apply('doer', 'doer', { kb_captures: [capture] });
        // While the maintainer is busy the read must not flush.
        await h.client.promotionCandidates('reviewer');
        assert.deepEqual(h.shape(), ['kb_query@maint']);
        assert.equal(h.client.pendingCount(), 1);
        // Idle again: the next read applies the queued write first.
        h.events.length = 0;
        await h.client.dispatchEnded('maint');
        h.events.length = 0;
        assert.equal(h.client.pendingCount(), 0, 'the end of the dispatch applied it');
        await h.client.apply('doer', 'doer', { kb_captures: [{ ...capture, title: 'second claim' }] });
        assert.equal(h.client.pendingCount(), 0);
    });

    test('the candidate read applies writes left queued by an unreachable maintainer first', async () => {
        let down = true;
        const events = [];
        const client = createKbWorkClient({
            maintainers: fakeMaintainerSelector({ repoOf: { reviewer: REPO, doer: REPO }, maintainerOf: { [REPO]: MAINT } }),
            sprintStartMs: SPRINT_START,
            memberCall: async (member, tool) => {
                events.push(`${tool}@${member.name}`);
                return tool === 'kb_query' ? { l1_results: [] } : {};
            },
            gPull: async (name) => { events.push(`gpull:${name}`); if (down) throw new Error('connection refused'); },
            log: () => {},
        });
        await client.apply('doer', 'doer', { kb_captures: [{
            type: 'knowledge', title: 'queued claim', summary: 'a claim captured this round',
            content: 'the content of the claim captured this round', source_files: ['src/a.ts'],
        }] });
        assert.equal(client.pendingCount(), 1);
        down = false;
        await client.promotionCandidates('reviewer');
        assert.deepEqual(events, ['gpull:maint', 'gpull:maint', 'kb_capture@maint', 'kb_query@maint']);
    });

    test('a reviewer with no maintainer gets no candidates and no read is made', async () => {
        const h = harness();
        assert.deepEqual(await h.client.promotionCandidates(null), []);
        assert.deepEqual(h.events, []);
    });
});

describe('CONFIRM and DISCARD on the maintainer', () => {
    test('kb_promotions -> kb_promote {id, reason}; kb_discards -> kb_invalidate {ids: [id]}; after one G-pull', async () => {
        const h = harness();
        const out = await h.client.apply('reviewer', 'reviewer', {
            kb_promotions: [{ id: 'kb-good', reason: REASON }],
            kb_discards: [{ id: 'kb-wrong', reason: WRONG }],
        });
        assert.deepEqual(out, { captured: 0, promoted: 1, discarded: 1, refused: 0 });
        assert.deepEqual(h.shape(), ['gpull:maint', 'kb_promote@maint', 'kb_invalidate@maint']);
        assert.deepEqual(h.events[1].args, { id: 'kb-good', reason: REASON });
        assert.deepEqual(h.events[2].args, { ids: ['kb-wrong'] });
    });

    test('each discard is logged with its reason BEFORE it is attempted', async () => {
        const h = harness();
        // Record the log length at the moment kb_invalidate is called.
        let logsAtCall = -1;
        const events = h.events;
        const push = events.push.bind(events);
        events.push = (e) => { if (e.tool === 'kb_invalidate') logsAtCall = h.logs.length; return push(e); };
        await h.client.apply('reviewer', 'reviewer', { kb_discards: [{ id: 'kb-wrong', reason: WRONG }] });
        const idx = h.logs.indexOf(`[kb-work] discard kb-wrong (reviewer): ${WRONG}`);
        assert.ok(idx >= 0, JSON.stringify(h.logs));
        assert.ok(logsAtCall > idx, 'the discard and its reason must be logged before kb_invalidate runs');
    });

    test('a not-found discard is logged as non-fatal and not counted', async () => {
        const h = harness({ invalidateResult: (args) => ({ discarded: [], not_found: args.ids, already_discarded: [] }) });
        const out = await h.client.apply('reviewer', 'reviewer', { kb_discards: [{ id: 'kb-gone', reason: WRONG }] });
        assert.equal(out.discarded, 0);
        assert.ok(h.logs.includes('[kb-work] kb_invalidate: entry kb-gone not found on the maintainer -- already gone (non-fatal)'), JSON.stringify(h.logs));
        assert.equal(h.client.pendingCount(), 0, 'a not-found is final, not re-queued');
    });
});

describe('vetting kb_discards', () => {
    test('kb_discards from a non-reviewer role is refused and logged; nothing is invalidated', async () => {
        for (const role of ['doer', 'planner', 'harvester']) {
            assert.deepEqual(vetKbWork(role, { kb_discards: [{ id: 'kb-1', reason: WRONG }] }).discards, []);
            const h = harness();
            const out = await h.client.apply(role, 'doer', { kb_discards: [{ id: 'kb-1', reason: WRONG }] });
            assert.equal(out.discarded, 0);
            assert.equal(out.refused, 1);
            assert.ok(h.logs.includes(`[kb-work] refused -- ${role}: kb_discards refused -- discard is reviewer-only`), JSON.stringify(h.logs));
            assert.deepEqual(h.events, []);
        }
    });

    test('a discard with a short reason or no id is refused and logged', async () => {
        const h = harness();
        const out = await h.client.apply('reviewer', 'reviewer', {
            kb_discards: [{ id: 'kb-1', reason: 'x'.repeat(19) }, { reason: WRONG }, { id: 'kb-2', reason: 'x'.repeat(20) }],
        });
        assert.equal(out.refused, 2);
        assert.equal(out.discarded, 1);
        assert.ok(h.logs.includes('[kb-work] refused -- reviewer: discard kb-1 has no recorded evidence'), JSON.stringify(h.logs));
        assert.ok(h.logs.includes('[kb-work] refused -- reviewer: discard missing id'), JSON.stringify(h.logs));
        assert.deepEqual(h.events.filter((e) => e.tool === 'kb_invalidate').map((e) => e.args), [{ ids: ['kb-2'] }]);
    });

    test('an id both promoted and discarded in one output is refused on both sides, both logged', async () => {
        const h = harness();
        const out = await h.client.apply('reviewer', 'reviewer', {
            kb_promotions: [{ id: 'kb-both', reason: REASON }, { id: 'kb-ok', reason: REASON }],
            kb_discards: [{ id: 'kb-both', reason: WRONG }],
        });
        assert.deepEqual(out, { captured: 0, promoted: 1, discarded: 0, refused: 2 });
        assert.ok(h.logs.includes(`[kb-work] refused -- reviewer: promotion kb-both refused -- the same output also discards it (promote reason: ${REASON})`), JSON.stringify(h.logs));
        assert.ok(h.logs.includes(`[kb-work] refused -- reviewer: discard kb-both refused -- the same output also promotes it (discard reason: ${WRONG})`), JSON.stringify(h.logs));
        assert.deepEqual(h.shape(), ['gpull:maint', 'kb_promote@maint']);
        assert.deepEqual(h.events[1].args, { id: 'kb-ok', reason: REASON });
    });
});

describe('the output schemas carry kb_discards', () => {
    test('reviewer-output.json declares kb_discards mirroring kb_promotions', () => {
        const p = reviewerVerdict.properties.kb_promotions;
        const d = reviewerVerdict.properties.kb_discards;
        assert.ok(d, 'reviewerVerdict must declare kb_discards');
        assert.equal(d.type, 'array');
        assert.deepEqual(d.items.required, ['id', 'reason']);
        assert.equal(d.items.properties.reason.minLength, 20);
        assert.equal(d.items.properties.id.minLength, p.items.properties.id.minLength);
        assert.match(d.items.properties.id.description, /promotion candidates/);
    });

    test('the final verdict schema accepts kb_discards like kb_promotions', () => {
        const d = finalVerdict.properties.kb_discards;
        assert.ok(d, 'finalVerdict must declare kb_discards');
        assert.deepEqual(d.items.required, ['id', 'reason']);
        assert.ok(!finalVerdict.required.includes('kb_discards'), 'optional');
    });
});
