import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createKbWorkClient, KB_MAX_KNOWLEDGE_ENTRIES, KB_MAX_SITUATION_QUERIES, mergeRankedLists } from '../fleet-sprint/kb.mjs';
import { fakeMaintainerSelector } from './helpers/kb-maintainer-fakes.mjs';

// Per-situation kb_query fan-out: one kb_query per bead / file situation,
// each carrying files / symbols; merged without duplicates, direct hits before
// related claims, capped at KB_MAX_KNOWLEDGE_ENTRIES (8).

const MAINT = Object.freeze({ id: 'id-maint', name: 'maint', type: 'local' });
const REPO = 'example.com/org/repo';
const selector = () => fakeMaintainerSelector({ repoOf: { maint: REPO, 'doer-1': REPO }, maintainerOf: { [REPO]: MAINT } });
const entry = (id, extra = {}) => ({ id, title: `title ${id}`, summary: `summary ${id}`, confidence: 'CONFIRMED', source_files: ['src/x.ts'], ...extra });

function harness(answer) {
    const calls = [];
    const logs = [];
    const memberCall = async (_m, name, args) => {
        calls.push({ name, args });
        if (name === 'kb_query') return answer(args, calls.filter((c) => c.name === 'kb_query').length - 1);
        if (name === 'kb_session_prime') return { content: [{ text: JSON.stringify({ top_entries: [entry('prime-1')] }) }] };
        return {};
    };
    const client = createKbWorkClient({ memberCall, maintainers: selector(), log: (l) => logs.push(l) });
    return { client, calls, logs };
}
const ok = (query, related = []) => ({ content: [{ text: JSON.stringify({ l1_results: query, related_claims: related }) }] });
const hints = (situations, extra = {}) => ({ terms: ['t'], hintSymbols: [], hintModules: [], situations, ...extra });
const bead = (n, over = {}) => ({ kind: 'bead', situation: `situation ${n}`, files: [`src/f${n}.ts`], symbols: [`sym${n}`], ...over });

describe('knowledgeFor: per-situation queries', () => {
    test('KB_MAX_KNOWLEDGE_ENTRIES is 8', () => {
        assert.equal(KB_MAX_KNOWLEDGE_ENTRIES, 8);
    });

    test('two beads -> two kb_query calls, each with its files and symbols', async () => {
        const { client, calls } = harness(() => ok([entry('a')]));
        await client.knowledgeFor('doer-1', hints([bead(1), bead(2)]));
        const qs = calls.filter((c) => c.name === 'kb_query');
        assert.equal(qs.length, 2);
        assert.equal(qs[0].args.query, 'situation 1');
        assert.deepEqual(qs[0].args.files, ['src/f1.ts']);
        assert.deepEqual(qs[0].args.symbols, ['sym1']);
        assert.deepEqual(qs[1].args.files, ['src/f2.ts']);
        assert.equal(qs[0].args.error_text, undefined);
        assert.deepEqual(qs[0].args.confidence, ['CONFIRMED']);
    });

    test('results merge without duplicates and cap at 8', async () => {
        const mk = (p) => Array.from({ length: 12 }, (_, i) => entry(`${p}${i}`));
        const { client } = harness((_a, n) => ok(n === 0 ? [...mk('s'), entry('dup')] : [entry('dup'), ...mk('s')]));
        const { entries } = await client.knowledgeFor('doer-1', hints([bead(1), bead(2)]));
        assert.equal(entries.length, 8);
        assert.equal(new Set(entries.map((e) => e.id)).size, 8);
    });

    test('round-robin: each query contributes its best hit before any contributes its second', async () => {
        const { client } = harness((_a, n) => ok([entry(`q${n}a`), entry(`q${n}b`)]));
        const { entries } = await client.knowledgeFor('doer-1', hints([bead(1), bead(2)]));
        assert.deepEqual(entries.map((e) => e.id), ['q0a', 'q1a', 'q0b', 'q1b']);
    });

    test('direct hits come before via:kb-graph related claims', async () => {
        const { client } = harness((_a, n) => ok([entry('d' + n)], [entry('r' + n)]));
        const { entries } = await client.knowledgeFor('doer-1', hints([bead(1), bead(2)]));
        assert.deepEqual(entries.map((e) => e.id), ['d0', 'd1', 'r0', 'r1']);
        assert.equal(entries[2].via, 'kb-graph');
    });

    test('a kb_query isError for one bead does not drop the other bead\'s results', async () => {
        const { client, logs } = harness((_a, n) => (n === 0
            ? { isError: true, content: [{ text: 'boom' }] }
            : ok([entry('survivor')])));
        const { entries, source } = await client.knowledgeFor('doer-1', hints([bead(1), bead(2)]));
        assert.deepEqual(entries.map((e) => e.id), ['survivor']);
        assert.equal(source, 'query');
        assert.ok(logs.some((l) => /kb_query rejected/.test(l)));
    });

    test('a thrown kb_query is non-fatal too', async () => {
        const { client } = harness((_a, n) => { if (n === 0) throw new Error('down'); return ok([entry('ok1')]); });
        const { entries } = await client.knowledgeFor('doer-1', hints([bead(1), bead(2)]));
        assert.deepEqual(entries.map((e) => e.id), ['ok1']);
    });

    test('query count is bounded at KB_MAX_SITUATION_QUERIES, beads before files', async () => {
        const sits = [...Array.from({ length: 4 }, (_, i) => ({ kind: 'file', situation: `file ${i}`, files: [`f${i}`], symbols: [] })), bead(1), bead(2), bead(3)];
        const { client, calls } = harness(() => ok([entry('a')]));
        await client.knowledgeFor('doer-1', hints(sits));
        const qs = calls.filter((c) => c.name === 'kb_query');
        assert.equal(qs.length, KB_MAX_SITUATION_QUERIES);
        assert.deepEqual(qs.slice(0, 3).map((c) => c.args.query), ['situation 1', 'situation 2', 'situation 3']);
    });

    test('every query answered with nothing relevant: no entries, and no kb_session_prime fallback', async () => {
        const { client, calls } = harness(() => ok([]));
        const { entries, source } = await client.knowledgeFor('doer-1', hints([bead(1), bead(2)], { hintSymbols: ['s'] }));
        assert.deepEqual(entries, []);
        assert.equal(source, 'query');
        assert.ok(!calls.some((c) => c.name === 'kb_session_prime'));
    });

    test('every query unanswered (rejected or thrown) falls back to kb_session_prime', async () => {
        const { client, calls } = harness((_args, i) => {
            if (i === 0) return { isError: true, content: [{ text: 'boom' }] };
            throw new Error('unreachable');
        });
        const { entries, source } = await client.knowledgeFor('doer-1', hints([bead(1), bead(2)], { hintSymbols: ['s'] }));
        assert.equal(source, 'prime');
        assert.deepEqual(entries.map((e) => e.id), ['prime-1']);
        assert.ok(calls.some((c) => c.name === 'kb_session_prime'));
    });

    test('every kb_query asks for the relevance cutoff (relevant_only)', async () => {
        const { client, calls } = harness(() => ok([entry('a')]));
        await client.knowledgeFor('doer-1', hints([bead(1)]));
        await client.knowledgeFor('doer-1', ['alpha', 'beta']);
        const qs = calls.filter((c) => c.name === 'kb_query');
        assert.equal(qs.length, 2);
        for (const q of qs) assert.equal(q.args.relevant_only, true);
    });

    test('legacy hints (bare term list) still issue one joined kb_query without files/symbols', async () => {
        const { client, calls } = harness(() => ok([entry('a')]));
        await client.knowledgeFor('doer-1', ['alpha', 'beta']);
        const qs = calls.filter((c) => c.name === 'kb_query');
        assert.equal(qs.length, 1);
        assert.equal(qs[0].args.query, 'alpha beta');
        assert.equal(qs[0].args.files, undefined);
        assert.equal(qs[0].args.symbols, undefined);
    });

    test('mergeRankedLists: error_text lists rank first', () => {
        const out = mergeRankedLists([{ entries: [entry('plain')] }, { withError: true, entries: [entry('err')] }], 8);
        assert.deepEqual(out.map((e) => e.id), ['err', 'plain']);
    });
});
