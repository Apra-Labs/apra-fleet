import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createKbWorkClient } from '../fleet-sprint/runner.js';
import { KB_MAX_DEMOTION_CANDIDATES, KB_MAX_PROMOTION_CANDIDATES } from '../fleet-sprint/kb.mjs';

// Mirrors KB_DEMOTION_CANDIDATE_FETCH_LIMIT in fleet-sprint/kb.mjs.
// Deliberately re-stated rather than imported: importing it would make the
// revert proof below degrade into a module-load SyntaxError (which proves
// only that a symbol is missing), and would let the cap silently change
// without a single assertion noticing.
const EXPECTED_DEMOTION_FETCH_LIMIT = 100;

// my-beads-db-qy8.12.2: permanent proof that the two candidate reads behind
// the D6/D7 promotion/demotion blocks stay BOUNDED as the KB grows.
//
// The regression this guards shipped precisely because it is INVISIBLE in the
// results: on a small KB an unfiltered, unlimited kb_list and a bounded one
// return exactly the same candidates. The only place the difference shows up
// is the REQUEST, and in how many entries cross the MCP boundary -- so this
// file asserts on the recorded kb_list arguments and on the payload size, not
// on the post-filter candidate list alone.
//
// REVERT PROOF (required by this task's acceptance criteria, and confirmed by
// actually reverting locally before this was committed -- 4 of the 14 tests
// here flip to FAIL, all four in the 'demotionCandidates issues a bounded
// kb_list' suite): restore kb.mjs to its pre-my-beads-db-qy8.12.1 state and
//
//   * 'asks the server to do the changed-file intersection' FAILS --
//     args.source_files is undefined, because the old call sent repo_path and
//     scope only.
//   * 'caps the kb_list response at a constant' FAILS -- typeof args.limit is
//     'undefined', not 'number'.
//   * 'the requested bound is a constant, independent of the KB behind it'
//     FAILS for the same reason: [undefined, undefined, undefined].
//   * 'the entries crossing the MCP boundary do not grow with KB size' FAILS
//     with actual [200, 2000] against expected [100, 100] -- with no limit
//     the stub server hands back all N entries, so the boundary payload grows
//     one-for-one with the KB.
//
// The promotionCandidates suite below deliberately does NOT flip on a kb.mjs
// revert: that call site was already sending `limit`, and the cost defect
// there lived entirely in the provider (list() dropped the SQL LIMIT). Its
// revert proof is the provider test named below, not this file.
//
// The provider half of this proof (the SQL list() emits, and the new
// server-side sourceFiles filter) lives in
// tests/knowledge/kb-list-bounded-reads.test.ts.

const REPO = '/srv/warehouse/repo';
const CHANGED_FILES = ['server/transit.js', 'server/rules.js'];

/**
 * A stub kb_list that HONOURS the request arguments, the way the real server
 * does. This is the whole point: a stub that ignored `source_files`/`limit`
 * (as the sibling kb-demotion-candidates.test.mjs fake deliberately does, to
 * test the client-side filter) could never show that the request is bounded.
 */
function makeServer(entries) {
    const calls = [];
    return {
        calls,
        /** Entry counts, in order, that actually crossed the boundary. */
        payloadSizes: [],
        callTool: async function callTool(name, args) {
            calls.push({ name, args });
            if (name !== 'kb_list') return {};
            let rows = entries;
            if (Array.isArray(args.source_files) && args.source_files.length > 0) {
                rows = rows.filter((e) => Array.isArray(e.source_files)
                    && e.source_files.some((f) => args.source_files.includes(f)));
            }
            if (typeof args.confidence === 'string') {
                rows = rows.filter((e) => e.confidence === args.confidence);
            }
            if (typeof args.limit === 'number') rows = rows.slice(0, args.limit);
            this.payloadSizes.push(rows.length);
            return { content: [{ type: 'text', text: JSON.stringify({ results: rows, total: rows.length }) }] };
        },
    };
}

function bindServer(server) {
    return createKbWorkClient({ callTool: server.callTool.bind(server), log: () => {} });
}

/** N demotable entries, every one of them citing a file the round touched. */
function manyDemotable(n) {
    return Array.from({ length: n }, (_, i) => ({
        id: `kb-dem-${String(i).padStart(5, '0')}`,
        type: 'knowledge',
        confidence: i % 2 === 0 ? 'CONFIRMED' : 'INFERRED',
        title: `Entry ${i}`,
        summary: 'x',
        source_files: ['server/transit.js'],
    }));
}

function manyInferred(n) {
    return Array.from({ length: n }, (_, i) => ({
        id: `kb-inf-${String(i).padStart(5, '0')}`,
        type: 'knowledge',
        confidence: 'INFERRED',
        title: `Entry ${i}`,
        summary: 'x',
        source_files: ['server/transit.js'],
    }));
}

describe('demotionCandidates issues a bounded kb_list (my-beads-db-qy8.12.1)', () => {
    test('asks the server to do the changed-file intersection', async () => {
        const server = makeServer(manyDemotable(5));
        await bindServer(server).demotionCandidates(REPO, CHANGED_FILES);

        const listCall = server.calls.find((c) => c.name === 'kb_list');
        assert.deepEqual(
            listCall.args.source_files,
            CHANGED_FILES,
            'kb_list was not asked to scope to the round diff -- the whole KB would cross the boundary',
        );
    });

    test('caps the kb_list response at a constant', async () => {
        const server = makeServer(manyDemotable(5));
        await bindServer(server).demotionCandidates(REPO, CHANGED_FILES);

        const listCall = server.calls.find((c) => c.name === 'kb_list');
        assert.equal(typeof listCall.args.limit, 'number', 'kb_list carried no limit at all');
        assert.equal(listCall.args.limit, EXPECTED_DEMOTION_FETCH_LIMIT);
    });

    test('the requested bound is a constant, independent of the KB behind it', async () => {
        const bounds = [];
        for (const n of [1, 50, 5000]) {
            const server = makeServer(manyDemotable(n));
            await bindServer(server).demotionCandidates(REPO, CHANGED_FILES);
            bounds.push(server.calls.find((c) => c.name === 'kb_list').args.limit);
        }
        assert.deepEqual(bounds, [
            EXPECTED_DEMOTION_FETCH_LIMIT,
            EXPECTED_DEMOTION_FETCH_LIMIT,
            EXPECTED_DEMOTION_FETCH_LIMIT,
        ]);
    });

    test('the entries crossing the MCP boundary do not grow with KB size', async () => {
        const sizes = [];
        // Every N here is well above both KB_MAX_DEMOTION_CANDIDATES (20) and
        // KB_MAX_PROMOTION_CANDIDATES (40), and the last is two orders of
        // magnitude above them.
        for (const n of [200, 2000]) {
            const server = makeServer(manyDemotable(n));
            await bindServer(server).demotionCandidates(REPO, CHANGED_FILES);
            sizes.push(server.payloadSizes[0]);
        }
        assert.deepEqual(sizes, [EXPECTED_DEMOTION_FETCH_LIMIT, EXPECTED_DEMOTION_FETCH_LIMIT]);
        assert.ok(sizes[0] === sizes[1], 'the boundary payload grew with the size of the KB');
    });

    test('the candidate list handed to the reviewer is still capped at 20', async () => {
        const server = makeServer(manyDemotable(2000));
        const candidates = await bindServer(server).demotionCandidates(REPO, CHANGED_FILES);
        assert.equal(candidates.length, KB_MAX_DEMOTION_CANDIDATES);
    });

    test('the fetch bound leaves headroom above the prompt cap for the client-side filters', async () => {
        // The tier check and the user-directive exclusion still run on this
        // side, and both only ever REMOVE rows -- so asking for exactly
        // KB_MAX_DEMOTION_CANDIDATES would under-fill the block.
        assert.ok(
            EXPECTED_DEMOTION_FETCH_LIMIT > KB_MAX_DEMOTION_CANDIDATES,
            'the server-side cap must exceed the prompt cap or the page under-fills',
        );
    });
});

describe('promotionCandidates issues a bounded kb_list (my-beads-db-qy8.12.1)', () => {
    test('keeps asking for both the limit and the D6 ping-pong guard', async () => {
        const server = makeServer(manyInferred(500));
        await bindServer(server).promotionCandidates(REPO);

        const listCall = server.calls.find((c) => c.name === 'kb_list');
        // Sending BOTH is what used to make the provider drop its SQL LIMIT
        // and scan the whole INFERRED tier. The call site is unchanged; the
        // provider now honours the limit via a bounded over-fetch. Dropping
        // either argument here would "fix" the cost by losing the guard or
        // losing the bound, so both are pinned.
        assert.equal(listCall.args.limit, KB_MAX_PROMOTION_CANDIDATES);
        assert.equal(listCall.args.exclude_unchanged_demotions, true);
        assert.equal(listCall.args.confidence, 'INFERRED');
    });

    test('the entries crossing the MCP boundary do not grow with KB size', async () => {
        const sizes = [];
        for (const n of [200, 2000]) {
            const server = makeServer(manyInferred(n));
            await bindServer(server).promotionCandidates(REPO);
            sizes.push(server.payloadSizes[0]);
        }
        assert.deepEqual(sizes, [KB_MAX_PROMOTION_CANDIDATES, KB_MAX_PROMOTION_CANDIDATES]);
    });
});

// CONTENT EQUIVALENCE. Bounding the read must not change WHICH candidates the
// reviewer is offered on any KB the old unbounded read already returned whole
// -- same ids, same order. This fixture is the exact one
// kb-demotion-candidates.test.mjs pinned before the bounding change.
describe('bounding the reads does not change the candidates on a small KB', () => {
    const SMALL_KB = [
        { id: 'kb-aaa', type: 'knowledge', confidence: 'CONFIRMED', title: 'Transit rows key on trackId', summary: 's', source_files: ['server/transit.js'] },
        { id: 'kb-bbb', type: 'learning', confidence: 'INFERRED', title: 'Exit events are no-op when unmatched', summary: 's', source_files: ['server/rules.js'] },
        { id: 'kb-ccc', type: 'knowledge', confidence: 'CONFIRMED', title: 'Unrelated entry', summary: 's', source_files: ['server/unrelated.js'] },
        { id: 'kb-ddd', type: 'knowledge', confidence: 'UNVERIFIED', title: 'Still unverified', summary: 's', source_files: ['server/transit.js'] },
        { id: 'kb-eee', type: 'user-directive', confidence: 'INFERRED', title: 'A pending directive', summary: 's', source_files: ['server/transit.js'] },
    ];

    test('demotionCandidates returns the same ids in the same order as before', async () => {
        const server = makeServer(SMALL_KB);
        const candidates = await bindServer(server).demotionCandidates(REPO, CHANGED_FILES);
        assert.deepEqual(candidates.map((c) => c.id), ['kb-aaa', 'kb-bbb']);
    });

    test('a server that ignores source_files yields the identical candidate list', async () => {
        // An older fleet server's zod schema STRIPS the unknown key rather
        // than erroring. The client-side intersection is retained for exactly
        // this case, and must produce the same answer.
        const legacy = makeServer(SMALL_KB);
        const legacyCallTool = async (name, args) => {
            const stripped = { ...args };
            delete stripped.source_files;
            return legacy.callTool(name, stripped);
        };
        const client = createKbWorkClient({ callTool: legacyCallTool, log: () => {} });

        const candidates = await client.demotionCandidates(REPO, CHANGED_FILES);
        assert.deepEqual(candidates.map((c) => c.id), ['kb-aaa', 'kb-bbb']);
    });

    test('promotionCandidates returns the same ids in the same order as before', async () => {
        const server = makeServer([
            { id: 'kb-111', type: 'knowledge', confidence: 'INFERRED', title: 'One', summary: 's', source_files: ['server/transit.js'] },
            { id: 'kb-222', type: 'user-directive', confidence: 'INFERRED', title: 'Directive', summary: 's', source_files: ['server/transit.js'] },
            { id: 'kb-333', type: 'learning', confidence: 'INFERRED', title: 'Three', summary: 's', source_files: ['server/rules.js'] },
        ]);
        const candidates = await bindServer(server).promotionCandidates(REPO);
        assert.deepEqual(candidates.map((c) => c.id), ['kb-111', 'kb-333']);
    });
});

describe('the bounded reads keep their best-effort degradation', () => {
    test('no repo path still means no kb_list call at all', async () => {
        const server = makeServer(manyDemotable(5));
        const client = bindServer(server);

        assert.deepEqual(await client.demotionCandidates(null, CHANGED_FILES), []);
        assert.deepEqual(await client.promotionCandidates(''), []);
        assert.equal(server.calls.filter((c) => c.name === 'kb_list').length, 0);
    });

    test('no changed files still means no kb_list call -- an empty source_files filter would read the whole KB', async () => {
        const server = makeServer(manyDemotable(5));
        assert.deepEqual(await bindServer(server).demotionCandidates(REPO, []), []);
        assert.equal(server.calls.filter((c) => c.name === 'kb_list').length, 0);
    });

    test('a throwing kb_list degrades to [] rather than failing the review', async () => {
        const client = createKbWorkClient({
            callTool: async () => { throw new Error('kb unavailable'); },
            log: () => {},
        });
        assert.deepEqual(await client.demotionCandidates(REPO, CHANGED_FILES), []);
        assert.deepEqual(await client.promotionCandidates(REPO), []);
    });
});
