import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createKbWorkClient, buildReviewerPrompt } from '../fleet-sprint/runner.js';

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
// 2. WRONG KB. The kb_promote call omitted repo_path while kb_capture passed
//    it. Per src/tools/kb-promote.ts a server-handled call without repo_path
//    resolves against the fleet server's cwd, so every promotion would have
//    failed "Entry not found" even once ids were supplied (the apra-fleet-tm7
//    repo-blindness class, fixed for capture but never for promote).

const REPO = '/srv/warehouse/repo';

function makeCallTool(entries, opts = {}) {
    const calls = [];
    return {
        calls,
        callTool: async (name, args) => {
            calls.push({ name, args });
            if (name === 'kb_list') {
                if (opts.throwOnList) throw new Error('kb unavailable');
                return { content: [{ type: 'text', text: JSON.stringify({ results: entries, total: entries.length }) }] };
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
    test('asks kb_list for INFERRED entries scoped to the reviewer repo', async () => {
        const { calls, callTool } = makeCallTool(INFERRED_ENTRIES);
        const client = createKbWorkClient({ callTool, log: () => {} });

        const candidates = await client.promotionCandidates(REPO);

        const listCall = calls.find((c) => c.name === 'kb_list');
        assert.ok(listCall, 'kb_list was never called -- the reviewer gets no candidates');
        assert.equal(listCall.args.confidence, 'INFERRED');
        assert.equal(listCall.args.repo_path, REPO, 'kb_list must be scoped to the repo under review');
        assert.deepEqual(candidates.map((c) => c.id), ['kb-aaa', 'kb-bbb']);
    });

    test('never offers a user-directive as a candidate (kb_promote refuses them)', async () => {
        const { callTool } = makeCallTool([
            ...INFERRED_ENTRIES,
            { id: 'kb-ddd', type: 'user-directive', confidence: 'INFERRED', title: 'pending directive', summary: 'x', source_files: ['a.js'] },
        ]);
        const client = createKbWorkClient({ callTool, log: () => {} });

        const candidates = await client.promotionCandidates(REPO);

        assert.ok(!candidates.some((c) => c.id === 'kb-ddd'), 'a pending user-directive was offered for promotion');
    });

    test('returns [] rather than reading the wrong KB when no repo path is known', async () => {
        const { calls, callTool } = makeCallTool(INFERRED_ENTRIES);
        const client = createKbWorkClient({ callTool, log: () => {} });

        assert.deepEqual(await client.promotionCandidates(null), []);
        assert.equal(calls.filter((c) => c.name === 'kb_list').length, 0, 'kb_list called with no repo path -- would read the server cwd KB');
    });

    test('a cold or broken KB yields [] and never throws into the dispatch', async () => {
        const { callTool } = makeCallTool([], { throwOnList: true });
        const client = createKbWorkClient({ callTool, log: () => {} });

        assert.deepEqual(await client.promotionCandidates(REPO), []);
    });

    test('inactive client (no callTool) yields []', async () => {
        const client = createKbWorkClient({ log: () => {} });
        assert.deepEqual(await client.promotionCandidates(REPO), []);
    });
});

describe('createKbWorkClient.apply: kb_promote repo scoping (apra-fleet-0ef)', () => {
    test('passes repo_path on kb_promote, exactly as it does on kb_capture', async () => {
        const calls = [];
        const client = createKbWorkClient({
            callTool: async (name, args) => { calls.push({ name, args }); return {}; },
            log: () => {},
        });

        const result = await client.apply('reviewer', REPO, {
            kb_promotions: [{ id: 'kb-aaa', reason: 'verified against server/transit.js and the reopen test' }],
        });

        const promoteCall = calls.find((c) => c.name === 'kb_promote');
        assert.ok(promoteCall, 'kb_promote was never called');
        assert.equal(
            promoteCall.args.repo_path,
            REPO,
            'kb_promote omitted repo_path -- it would resolve against the fleet server cwd and fail "Entry not found"'
        );
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
