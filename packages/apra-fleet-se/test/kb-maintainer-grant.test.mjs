import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createKbWorkClient, createKbPrimingClient, KB_MAINTAINER_CALL } from '../fleet-sprint/kb.mjs';
import { selfMaintainer } from './helpers/kb-maintainer-fakes.mjs';

// =============================================================================
// The kb_maintainer grant: only a member session opened with it is served
// kb_promote (and kb_resolve_contradiction), so every write the engine applies
// AS a repository's kb_maintainer -- the queued capture / promote / discard and
// the review-round kb_bible_commit -- must pass KB_MAINTAINER_CALL as
// memberCall's fourth argument. Ordinary reads (the promotion-candidate
// kb_query) must not: they run in a plain engine member session.
// =============================================================================

const MAINT = { id: 'id-maint', name: 'maint', type: 'local' };
const REASON = 'verified against the merged code in this round';
const BASE = { baseBranch: 'main', baseCommit: 'a'.repeat(40) };

function harness() {
    const calls = [];
    const memberCall = async (member, tool, args, ...rest) => {
        calls.push({ tool, member: member.name, opts: rest[0], arity: 3 + rest.length });
        if (tool === 'kb_query') return { l1_results: [{ id: 'e1' }, { id: 'e2' }] };
        if (tool === 'kb_bible_commit') {
            return { content: [{ text: JSON.stringify({ path: '.fleet/kb-canonical.json', merged: args.ids, skipped: [], entry_count: args.ids.length, committed: true }) }] };
        }
        if (tool === 'kb_capture') return { content: [{ text: JSON.stringify({ id: 'c1', audn_decision: 'add', confidence_clamped: false }) }] };
        if (tool === 'kb_invalidate') return { content: [{ text: JSON.stringify({ discarded: [args.ids[0]], not_found: [], already_discarded: [] }) }] };
        return { content: [{ text: '{}' }] };
    };
    const client = createKbWorkClient({
        memberCall,
        maintainers: selfMaintainer(MAINT, ['maint', 'reviewer-1']),
        gPull: async () => {},
        gPush: async () => {},
        abortRebase: async () => false,
        bibleBase: async () => BASE,
        bibleUnpushed: async () => ({ unpushed: false }),
        log: () => {},
    });
    return { client, calls };
}

describe('kb_maintainer grant on engine KB writes', () => {
    test('KB_MAINTAINER_CALL is the frozen { kbMaintainer: true } option', () => {
        assert.deepEqual(KB_MAINTAINER_CALL, { kbMaintainer: true });
        assert.ok(Object.isFrozen(KB_MAINTAINER_CALL));
    });

    test('promote and the bible commit carry the grant; the candidate kb_query does not', async () => {
        const { client, calls } = harness();
        await client.promotionCandidates('reviewer-1');
        await client.apply('reviewer', 'reviewer-1', { kb_promotions: [{ id: 'e1', reason: REASON }] });
        await client.commitRound('review C1');

        const byTool = (t) => calls.filter((c) => c.tool === t);
        assert.ok(byTool('kb_promote').length === 1, JSON.stringify(calls));
        for (const c of [...byTool('kb_promote'), ...byTool('kb_bible_commit')]) {
            assert.equal(c.member, 'maint');
            assert.deepEqual(c.opts, { kbMaintainer: true }, `${c.tool} must carry the kb_maintainer grant`);
        }
        assert.ok(byTool('kb_bible_commit').length === 1, JSON.stringify(calls));
        for (const c of byTool('kb_query')) {
            assert.equal(c.opts, undefined, 'a read is not made with the maintainer grant');
            assert.equal(c.arity, 3);
        }
    });

    test('queued captures and discards applied on the maintainer carry the grant too', async () => {
        const { client, calls } = harness();
        await client.promotionCandidates('reviewer-1');
        await client.apply('reviewer', 'reviewer-1', {
            kb_captures: [{ type: 'knowledge', title: 'A captured fact here', summary: 'A summary of the captured fact for the test.', content: 'Content of the captured fact for the test.', source_files: ['src/a.ts'] }],
            kb_discards: [{ id: 'e2', reason: 'superseded by the merged code in this round' }],
        });
        const writes = calls.filter((c) => c.tool === 'kb_capture' || c.tool === 'kb_invalidate');
        assert.deepEqual(writes.map((c) => c.tool).sort(), ['kb_capture', 'kb_invalidate'], JSON.stringify(calls));
        for (const c of writes) assert.deepEqual(c.opts, { kbMaintainer: true }, c.tool);
    });

    // The sprint-start bible import on a repository's kb_maintainer is the
    // trusted seeding path for the kb_import trust anchor: a session without
    // the grant imports only a bible the maintainer side already recorded, so
    // a bible this hub never saw would never land. The prime read itself
    // stays a plain (grant-less) call. Priming runs before anything cleans the
    // maintainer's checkout, so the grant import must name the base branch's
    // remote-tracking ref (never the work tree or HEAD).
    function primingHarness(extra) {
        const calls = [];
        const logs = [];
        const memberCall = async (member, tool, args, ...rest) => {
            calls.push({ tool, args, member: member.name, opts: rest[0], arity: 3 + rest.length });
            if (tool === 'kb_session_prime') return { top_entries: [] };
            return { imported: 0 };
        };
        const callTool = async (name, args) => (name === 'member_detail'
            ? { id: `id-${args.member_name}`, type: 'local', folder: `/srv/${args.member_name}` }
            : {});
        const priming = createKbPrimingClient({
            callTool, memberCall, members: ['reviewer-1'],
            maintainers: selfMaintainer(MAINT, ['maint', 'reviewer-1']),
            log: (m) => logs.push(m),
            ...extra,
        });
        return { priming, calls, logs };
    }

    test('the priming kb_import on the maintainer carries the grant and reads the base branch ref; kb_session_prime does not', async () => {
        const { priming, calls } = primingHarness({ baseBranch: 'main' });
        await priming.primeAll();

        const imp = calls.filter((c) => c.tool === 'kb_import');
        assert.equal(imp.length, 1, JSON.stringify(calls));
        assert.equal(imp[0].member, 'maint');
        assert.deepEqual(imp[0].opts, { kbMaintainer: true });
        assert.deepEqual(imp[0].args, { skip_sweep: true, ref: 'refs/remotes/origin/main' });
        for (const c of calls.filter((c) => c.tool === 'kb_session_prime')) {
            assert.equal(c.opts, undefined, 'the prime read is not made with the maintainer grant');
        }
    });

    test('without a (valid) base branch the maintainer makes no bible import at all -- never a work-tree or HEAD fallback', async () => {
        for (const extra of [{}, { baseBranch: '-x' }, { baseBranch: 'a..b' }]) {
            const { priming, calls, logs } = primingHarness(extra);
            await priming.primeAll();
            assert.equal(calls.filter((c) => c.tool === 'kb_import').length, 0, JSON.stringify(calls));
            assert.ok(calls.some((c) => c.tool === 'kb_session_prime'), 'priming itself still runs');
            assert.ok(logs.some((m) => /no base branch -- bible import skipped/.test(m)), logs.join('\n'));
        }
    });
});
