import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKbWorkClient } from '../fleet-sprint/kb.mjs';
import { fakeMaintainerSelector } from './helpers/kb-maintainer-fakes.mjs';

// The reviewer may promote or discard only KB entries offered in its dispatch's
// candidate block. apply() refuses every other id: logged, never sent to
// kb_promote / kb_invalidate.

const REPO = 'github.com/org/repo';
const MAINT = Object.freeze({ id: 'id-maint', name: 'maint', type: 'remote' });
const REASON = 'Verified against src/widget-cache.ts:42 and the tenant isolation test.';
const REFUSAL = "not in this dispatch's candidate block";

function harness() {
    const calls = [];
    const logs = [];
    let offered = [];
    const client = createKbWorkClient({
        maintainers: fakeMaintainerSelector({
            repoOf: { reviewer: REPO, maint: REPO },
            maintainerOf: { [REPO]: MAINT },
        }),
        memberCall: async (member, tool, args) => {
            calls.push({ tool, args });
            if (tool === 'kb_query') return { l1_results: offered.map((id) => ({ id })) };
            if (tool === 'kb_invalidate') {
                return { content: [{ type: 'text', text: JSON.stringify({ discarded: args.ids, not_found: [], already_discarded: [] }) }] };
            }
            return {};
        },
        gPull: async () => {},
        log: (m) => logs.push(m),
    });
    /** One review dispatch's candidate block. */
    const offer = async (ids) => { offered = ids; await client.promotionCandidates('reviewer'); };
    const writes = () => calls.filter((c) => c.tool === 'kb_promote' || c.tool === 'kb_invalidate');
    return { client, offer, logs, writes };
}

describe('reviewer promotions and discards are limited to the offered candidate block', () => {
    test('a never-offered promotion and discard are refused, logged, and make no kb call', async () => {
        const h = harness();
        await h.offer(['kb-offered']);
        const out = await h.client.apply('reviewer', 'reviewer', {
            kb_promotions: [{ id: 'kb-stray-p', reason: REASON }],
            kb_discards: [{ id: 'kb-stray-d', reason: REASON }],
        });
        assert.equal(out.promoted, 0);
        assert.equal(out.discarded, 0);
        assert.equal(out.refused, 2);
        assert.ok(h.logs.some((l) => l.includes('kb-stray-p') && l.includes(REFUSAL)), JSON.stringify(h.logs));
        assert.ok(h.logs.some((l) => l.includes('kb-stray-d') && l.includes(REFUSAL)), JSON.stringify(h.logs));
        assert.deepEqual(h.writes(), []);
    });

    test('with no candidate block offered at all, every judgement is refused', async () => {
        const h = harness();
        const out = await h.client.apply('reviewer', 'reviewer', { kb_promotions: [{ id: 'kb-x', reason: REASON }] });
        assert.equal(out.promoted, 0);
        assert.deepEqual(h.writes(), []);
    });

    test('round 1 offers {A, B}; round 2 offers {C}: a round-2 promotion of A is refused, of C applied', async () => {
        const h = harness();
        await h.offer(['A', 'B']);
        await h.offer(['C']);
        const out = await h.client.apply('reviewer', 'reviewer', {
            kb_promotions: [{ id: 'A', reason: REASON }, { id: 'C', reason: REASON }],
        });
        assert.equal(out.promoted, 1);
        assert.equal(out.refused, 1);
        assert.ok(h.logs.some((l) => l.includes(' A ') && l.includes(REFUSAL)), JSON.stringify(h.logs));
        assert.deepEqual(h.writes().map((c) => [c.tool, c.args.id]), [['kb_promote', 'C']]);
    });

    test('offered ids are promoted once and discarded, unchanged', async () => {
        const h = harness();
        await h.offer(['kb-good', 'kb-bad']);
        const out = await h.client.apply('reviewer', 'reviewer', {
            kb_promotions: [{ id: 'kb-good', reason: REASON }],
            kb_discards: [{ id: 'kb-bad', reason: REASON }],
        });
        assert.deepEqual(out, { captured: 0, promoted: 1, discarded: 1, demoted: 0, refused: 0 });
        assert.deepEqual(h.writes().map((c) => c.tool), ['kb_promote', 'kb_invalidate']);
        assert.deepEqual(h.writes()[0].args, { id: 'kb-good', reason: REASON });
        assert.deepEqual(h.writes()[1].args, { ids: ['kb-bad'] });
        assert.ok(!h.logs.some((l) => l.includes(REFUSAL)));
    });
});

describe('reviewer.md states the engine enforces the candidate block', () => {
    const md = fs.readFileSync(
        path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'apra-pm', 'agents', 'reviewer.md'), 'utf8');
    test('says the orchestrator refuses any other id and lacks the old stopgap', () => {
        assert.match(md, /refuses any other id/);
        assert.doesNotMatch(md, /does not re-check this/);
    });
});
