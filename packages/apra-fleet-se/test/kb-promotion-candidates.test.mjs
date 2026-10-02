import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createKbWorkClient, buildReviewerPrompt } from '../fleet-sprint/runner.js';
import { fakeMaintainerSelector } from './helpers/kb-maintainer-fakes.mjs';

// apra-fleet-0ef: kb_promote succeeded ZERO times across ~10 capture rounds in
// two live sprints -- every entry stayed INFERRED -- and the sprint logs
// carried no "kb_promote rejected" or "refused" line at all. The provider's
// conservative gates were never reached. Two defects, both here:
//
// 1. MISSING INPUT. The engine's contract is "judgment belongs to the role,
//    execution belongs here": the reviewer returns kb_promotions:[{id,reason}]
//    and the engine calls kb_promote. But a KB entry id can only come from the
//    KB, buildReviewerPrompt injected no KB context whatsoever, and the
//    reviewer subagent has no apra-fleet MCP tools. So the reviewer could never
//    name a single id and kb_promotions was structurally always empty.
//    kb_captures worked precisely because a capture needs no pre-existing id.
//
// 2. WRONG KB. The kb_promote call was not scoped the way kb_capture was, so
//    it resolved the fleet server's own KB and every promotion would have
//    failed "Entry not found" even once ids were supplied (the apra-fleet-tm7
//    repo-blindness class, fixed for capture but never for promote). Today a
//    kb_* call is scoped by its SESSION: both run AS the reviewer member.

const REVIEWER = Object.freeze({ id: 'id-warehouse-reviewer', name: 'warehouse-reviewer', type: 'local' });
// Every KB write is routed to the repository's kb_maintainer, so the INFERRED
// candidates live in -- and are read from -- the maintainer's KB.
const MAINTAINER = Object.freeze({ id: 'id-warehouse-maint', name: 'warehouse-maint', type: 'remote' });
const withMaintainer = () => fakeMaintainerSelector({
    repoOf: { [REVIEWER.name]: 'example.com/warehouse', [MAINTAINER.name]: 'example.com/warehouse' },
    maintainerOf: { 'example.com/warehouse': MAINTAINER },
});

function makeCallTool(entries, opts = {}) {
    const calls = [];
    return {
        calls,
        memberCall: async (member, name, args) => {
            calls.push({ name, args, member });
            if (name === 'kb_query') {
                if (opts.throwOnList) throw new Error('kb unavailable');
                return { content: [{ type: 'text', text: JSON.stringify({ l1_results: entries }) }] };
            }
            return {};
        },
    };
}

const INFERRED_ENTRIES = [
    { id: 'kb-aaa', type: 'knowledge', confidence: 'INFERRED', title: 'Transit rows key on trackId', summary: 'open transit is keyed by (trackId, locationId)', source_files: ['server/transit.js'] },
    { id: 'kb-bbb', type: 'learning', confidence: 'INFERRED', title: 'Exit events are no-op when unmatched', summary: 'unmatched exit never fabricates a transit', source_files: ['server/rules.js'] },
];

describe('createKbWorkClient.promotionCandidates (apra-fleet-0ef)', () => {
    test("asks the reviewer's repository maintainer for its own INFERRED entries", async () => {
        const { calls, memberCall } = makeCallTool(INFERRED_ENTRIES);
        const client = createKbWorkClient({ memberCall, maintainers: withMaintainer(), log: () => {} });

        const candidates = await client.promotionCandidates(REVIEWER);

        const queryCall = calls.find((c) => c.name === 'kb_query');
        assert.ok(queryCall, 'kb_query was never called -- the reviewer gets no candidates');
        assert.deepEqual(queryCall.args, { tag: `member:${MAINTAINER.id}`, confidence: ['INFERRED'], limit: 40 });
        assert.equal(queryCall.member, MAINTAINER, 'the read must run in the maintainer session that holds the captures');
        assert.deepEqual(candidates.map((c) => c.id), ['kb-aaa', 'kb-bbb']);
    });

    test('never offers a user-directive as a candidate (kb_promote refuses them)', async () => {
        const { memberCall } = makeCallTool([
            ...INFERRED_ENTRIES,
            { id: 'kb-ddd', type: 'user-directive', confidence: 'INFERRED', title: 'pending directive', summary: 'x', source_files: ['a.js'] },
        ]);
        const client = createKbWorkClient({ memberCall, maintainers: withMaintainer(), log: () => {} });

        const candidates = await client.promotionCandidates(REVIEWER);

        assert.ok(!candidates.some((c) => c.id === 'kb-ddd'), 'a pending user-directive was offered for promotion');
    });

    test('returns [] rather than reading the wrong KB when no maintainer is resolved', async () => {
        const { calls, memberCall } = makeCallTool(INFERRED_ENTRIES);
        const noSelection = createKbWorkClient({ memberCall, log: () => {} });
        assert.deepEqual(await noSelection.promotionCandidates(REVIEWER), []);
        const client = createKbWorkClient({ memberCall, maintainers: withMaintainer(), log: () => {} });
        assert.deepEqual(await client.promotionCandidates(null), []);
        assert.equal(calls.length, 0, 'a kb_* read with no maintainer would read some other KB');
    });

    test('a cold or broken KB yields [] and never throws into the dispatch', async () => {
        const { memberCall } = makeCallTool([], { throwOnList: true });
        const client = createKbWorkClient({ memberCall, maintainers: withMaintainer(), log: () => {} });

        assert.deepEqual(await client.promotionCandidates(REVIEWER), []);
    });

    test('inactive client (no memberCall) yields []', async () => {
        const client = createKbWorkClient({ log: () => {} });
        assert.deepEqual(await client.promotionCandidates(REVIEWER), []);
    });
});

describe('createKbWorkClient.apply: kb_promote member scoping (apra-fleet-0ef)', () => {
    test("runs kb_promote in the repository maintainer's session, exactly as kb_capture is", async () => {
        // The promotion candidates are read from the maintainer's KB, so the
        // promotion must run there too -- in the reviewer's own session the id
        // would not exist and every promotion would fail "Entry not found".
        const calls = [];
        const client = createKbWorkClient({
            memberCall: async (member, name, args) => { calls.push({ name, args, member }); return {}; },
            maintainers: withMaintainer(),
            gPull: async () => {},
            log: () => {},
        });

        const result = await client.apply('reviewer', REVIEWER, {
            kb_promotions: [{ id: 'kb-aaa', reason: 'verified against server/transit.js and the reopen test' }],
        });

        const promoteCall = calls.find((c) => c.name === 'kb_promote');
        assert.ok(promoteCall, 'kb_promote was never called');
        assert.equal(promoteCall.member, MAINTAINER, 'kb_promote must run in the maintainer session that holds the entry');
        assert.equal(promoteCall.args.repo_path, undefined);
        assert.equal(result.promoted, 1);
    });
});

describe('buildReviewerPrompt: promotion candidates (apra-fleet-0ef)', () => {
    const BASE = {
        beadIds: ['apra-fleet-aaa'],
        acceptanceCriteriaJson: '[]',
        baseBranch: 'main',
        branch: 'feat/thing',
        goal: 'P1',
    };

    test('carries each candidate id into the prompt', () => {
        const prompt = buildReviewerPrompt({ ...BASE, kbCandidates: INFERRED_ENTRIES });

        for (const e of INFERRED_ENTRIES) {
            assert.ok(prompt.includes(e.id), `candidate ${e.id} missing from the reviewer prompt`);
            assert.ok(prompt.includes(e.title), `candidate title for ${e.id} missing`);
        }
        assert.match(prompt, /kb_promotions/, 'prompt never names the output field the engine reads');
    });

    test('omits the KB block entirely when there are no candidates', () => {
        for (const kbCandidates of [[], undefined]) {
            const prompt = buildReviewerPrompt({ ...BASE, kbCandidates });
            assert.ok(!/kb_promotions/.test(prompt), `empty candidate set still emitted a KB block (${JSON.stringify(kbCandidates)})`);
        }
    });
});
