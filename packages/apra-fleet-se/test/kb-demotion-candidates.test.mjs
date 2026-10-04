import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createKbWorkClient, buildReviewerPrompt } from '../fleet-sprint/runner.js';

// D7/D6: the demotion-side mirror of kb-promotion-candidates.test.mjs.
//
// kbWork.demotionCandidates(repoPath, changedFiles) is the missing input that
// lets a reviewer return kb_demotions: without it the reviewer has no apra-fleet
// MCP tools of its own and could never name an entry id, exactly the defect
// kb-promotion-candidates.test.mjs documents for kb_promotions (apra-fleet-0ef).
//
// The D6 ping-pong guard (promotionCandidates excluding/including a demoted
// entry) is implemented SERVER-SIDE in SqliteProvider.list() (the
// `exclude_unchanged_demotions` kb_list flag) -- not re-derived in this
// fake-callTool layer, because only the real provider holds the repoPath
// anchor the re-hash needs. The real three-state exclude/include/never-
// demoted proof is tests/knowledge/kb-list-demotion-ping-pong.test.ts (a real
// SqliteProvider, a real file on disk). What belongs HERE, and is asserted
// below, is the CONTRACT at the fleet-sprint boundary: promotionCandidates
// always REQUESTS the guard, and faithfully returns whatever the server
// decided -- excluded, included, or never-demoted-so-always-included --
// without re-filtering or second-guessing it.

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

const CHANGED_FILES = ['server/transit.js', 'server/rules.js'];

const DEMOTION_ENTRIES = [
    { id: 'kb-aaa', type: 'knowledge', confidence: 'CONFIRMED', title: 'Transit rows key on trackId', summary: 'open transit is keyed by (trackId, locationId)', source_files: ['server/transit.js'] },
    { id: 'kb-bbb', type: 'learning', confidence: 'INFERRED', title: 'Exit events are no-op when unmatched', summary: 'unmatched exit never fabricates a transit', source_files: ['server/rules.js'] },
    // Cites a file the diff did NOT touch -- must be filtered out.
    { id: 'kb-ccc', type: 'knowledge', confidence: 'CONFIRMED', title: 'Unrelated entry', summary: 'about a different file entirely', source_files: ['server/unrelated.js'] },
    // UNVERIFIED is not a tier trust can be pulled DOWN from -- must be filtered out.
    { id: 'kb-ddd', type: 'knowledge', confidence: 'UNVERIFIED', title: 'Still unverified', summary: 'cites a changed file but is already at the floor', source_files: ['server/transit.js'] },
    // user-directive: demote() refuses it outright -- must be filtered out.
    { id: 'kb-eee', type: 'user-directive', confidence: 'INFERRED', title: 'A pending directive', summary: 'x', source_files: ['server/transit.js'] },
];

describe('createKbWorkClient.demotionCandidates (D7)', () => {
    test('returns only CONFIRMED/INFERRED entries whose source_files intersect the changed files', async () => {
        const { callTool } = makeCallTool(DEMOTION_ENTRIES);
        const client = createKbWorkClient({ callTool, log: () => {} });

        const candidates = await client.demotionCandidates(REPO, CHANGED_FILES);

        assert.deepEqual(candidates.map((c) => c.id).sort(), ['kb-aaa', 'kb-bbb']);
    });

    test('never offers a user-directive as a candidate (demote() refuses them)', async () => {
        const { callTool } = makeCallTool(DEMOTION_ENTRIES);
        const client = createKbWorkClient({ callTool, log: () => {} });

        const candidates = await client.demotionCandidates(REPO, CHANGED_FILES);

        assert.ok(!candidates.some((c) => c.id === 'kb-eee'), 'a pending user-directive was offered for demotion');
    });

    test('never offers an UNVERIFIED entry (nothing lower to demote it to)', async () => {
        const { callTool } = makeCallTool(DEMOTION_ENTRIES);
        const client = createKbWorkClient({ callTool, log: () => {} });

        const candidates = await client.demotionCandidates(REPO, CHANGED_FILES);

        assert.ok(!candidates.some((c) => c.id === 'kb-ddd'), 'an UNVERIFIED entry was offered for demotion');
    });

    // demotionCandidates never has to filter a superseded entry itself:
    // SqliteProvider.list()'s own WHERE clause ('e.superseded_at IS NULL')
    // excludes it unconditionally server-side, and kb_list's response never
    // even projects a superseded_at field for this layer to look at. That
    // guarantee belongs to, and is tested against, the real provider (see
    // tests/knowledge/kb-list.test.ts's "excludes superseded entries by
    // default"); nothing to re-prove with a fake kb_list here.

    test('caps at 20 even when more entries match', async () => {
        const many = Array.from({ length: 30 }, (_, i) => ({
            id: `kb-${i}`, type: 'knowledge', confidence: 'INFERRED', title: `Entry ${i}`, summary: 'x', source_files: ['server/transit.js'],
        }));
        const { callTool } = makeCallTool(many);
        const client = createKbWorkClient({ callTool, log: () => {} });

        const candidates = await client.demotionCandidates(REPO, CHANGED_FILES);

        assert.equal(candidates.length, 20);
    });

    test('returns [] and does not throw against a cold or empty KB', async () => {
        const { callTool } = makeCallTool([]);
        const client = createKbWorkClient({ callTool, log: () => {} });

        assert.deepEqual(await client.demotionCandidates(REPO, CHANGED_FILES), []);
    });

    test('a cold or broken KB yields [] and never throws into the dispatch', async () => {
        const { callTool } = makeCallTool([], { throwOnList: true });
        const client = createKbWorkClient({ callTool, log: () => {} });

        assert.deepEqual(await client.demotionCandidates(REPO, CHANGED_FILES), []);
    });

    test('returns [] rather than reading the wrong KB when no repo path is known', async () => {
        const { calls, callTool } = makeCallTool(DEMOTION_ENTRIES);
        const client = createKbWorkClient({ callTool, log: () => {} });

        assert.deepEqual(await client.demotionCandidates(null, CHANGED_FILES), []);
        assert.equal(calls.filter((c) => c.name === 'kb_list').length, 0, 'kb_list called with no repo path -- would read the server cwd KB');
    });

    test('returns [] when no changed files are known -- nothing to scope the candidates to', async () => {
        const { calls, callTool } = makeCallTool(DEMOTION_ENTRIES);
        const client = createKbWorkClient({ callTool, log: () => {} });

        assert.deepEqual(await client.demotionCandidates(REPO, []), []);
        assert.deepEqual(await client.demotionCandidates(REPO, undefined), []);
        assert.equal(calls.filter((c) => c.name === 'kb_list').length, 0);
    });

    test('inactive client (no callTool) yields []', async () => {
        const client = createKbWorkClient({ log: () => {} });
        assert.deepEqual(await client.demotionCandidates(REPO, CHANGED_FILES), []);
    });
});

describe('createKbWorkClient.promotionCandidates requests the D6 ping-pong guard', () => {
    test('kb_list is asked for exclude_unchanged_demotions -- the real exclusion runs server-side', async () => {
        const { calls, callTool } = makeCallTool([]);
        const client = createKbWorkClient({ callTool, log: () => {} });

        await client.promotionCandidates(REPO);

        const listCall = calls.find((c) => c.name === 'kb_list');
        assert.equal(listCall.args.exclude_unchanged_demotions, true);
    });

    // Three-state contract: whatever the server decided to include is passed
    // through untouched (minus the type==='user-directive' filter this layer
    // already owns). The server's actual exclude/include decision is proven
    // for real against a real provider and a real file on disk in
    // tests/knowledge/kb-list-demotion-ping-pong.test.ts -- duplicating that
    // here with a fake kb_list would only prove the fake agrees with itself.
    test('passes through exactly the entries the server already decided to include', async () => {
        const neverDemoted = { id: 'kb-never', type: 'knowledge', confidence: 'INFERRED', title: 'Never demoted', summary: 'x', source_files: ['a.ts'] };
        const includedAfterChange = { id: 'kb-changed', type: 'knowledge', confidence: 'INFERRED', title: 'Basis changed since demotion', summary: 'x', source_files: ['b.ts'] };
        // A server that applied the guard would simply OMIT a still-unchanged
        // demoted entry from `results` -- there is nothing for this layer to
        // see or re-exclude.
        const { callTool } = makeCallTool([neverDemoted, includedAfterChange]);
        const client = createKbWorkClient({ callTool, log: () => {} });

        const candidates = await client.promotionCandidates(REPO);

        assert.deepEqual(candidates.map((c) => c.id).sort(), ['kb-changed', 'kb-never']);
    });
});

describe('buildReviewerPrompt: demotion candidates', () => {
    const BASE = {
        beadIds: ['apra-fleet-aaa'],
        acceptanceCriteriaJson: '[]',
        baseBranch: 'main',
        branch: 'feat/thing',
        goal: 'P1',
    };

    test('carries each candidate id into the prompt', () => {
        const prompt = buildReviewerPrompt({ ...BASE, kbDemotionCandidates: DEMOTION_ENTRIES.slice(0, 2) });

        for (const e of DEMOTION_ENTRIES.slice(0, 2)) {
            assert.ok(prompt.includes(e.id), `candidate ${e.id} missing from the reviewer prompt`);
            assert.ok(prompt.includes(e.title), `candidate title for ${e.id} missing`);
        }
        assert.match(prompt, /kb_demotions/, 'prompt never names the output field the engine reads');
    });

    test('omits the KB demotion block entirely when there are no candidates', () => {
        for (const kbDemotionCandidates of [[], undefined]) {
            const prompt = buildReviewerPrompt({ ...BASE, kbDemotionCandidates });
            assert.ok(!/kb_demotions/.test(prompt), `empty candidate set still emitted a KB demotion block (${JSON.stringify(kbDemotionCandidates)})`);
        }
    });
});
