import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
    createKbPrimingClient,
    createKbWorkClient,
    kbKnowledgeBlock,
    buildDoerPrompt,
    buildReviewerPrompt,
    buildFinalVerdictPrompt,
} from '../fleet-sprint/runner.js';
import { KB_MAX_KNOWLEDGE_ENTRIES, isInjectableKbEntry } from '../fleet-sprint/kb.mjs';

// Owner rule: only CONFIRMED knowledge is injected into a role prompt. Every
// engine-built KNOWLEDGE BANK block -- doer and per-round reviewer (per-dispatch
// kb_query, falling back to the sprint-start set), wrapper roles via agent()
// and the Final Review (sprint-start kb_session_prime set) -- must carry only
// CONFIRMED entries that sit outside any unresolved contradiction.
//
// The KB below is deliberately an OLD server: it ignores kb_query's
// confidence/exclude_disputed params and returns everything, and its
// kb_session_prime returns every tier. That is the worst case the engine-side
// filter exists for; a current server filters too, but the engine must not
// depend on it.

const entry = (id, title, confidence, extra = {}) => ({
    id, title, summary: `${title} summary`, confidence, source_files: ['src/x.ts'], ...extra,
});

const CONFIRMED_HIT = entry('c1', 'confirmedmarker direct hit', 'CONFIRMED');
const CONFIRMED_RELATED = entry('c2', 'confirmedmarker related claim', 'CONFIRMED');
const REJECTS = [
    entry('i1', 'inferredmarker entry', 'INFERRED'),
    entry('u1', 'unverifiedmarker entry', 'UNVERIFIED'),
    entry('f1', 'flaggedmarker entry', 'CONFIRMED', { flagged_for_review: true }),
    entry('x1', 'contradictionmarker entry', 'CONFIRMED', { contradiction_of: 'f1' }),
];
const RELATED_REJECTS = [
    entry('ri', 'relatedinferredmarker entry', 'INFERRED'),
    entry('rf', 'relatedflaggedmarker entry', 'CONFIRMED', { flagged_for_review: true }),
];
const REJECT_MARKERS = ['inferredmarker', 'unverifiedmarker', 'flaggedmarker', 'contradictionmarker', 'relatedinferredmarker', 'relatedflaggedmarker'];

function oldServer({ l1 = [CONFIRMED_HIT, ...REJECTS], related = [CONFIRMED_RELATED, ...RELATED_REJECTS], top = [...REJECTS, CONFIRMED_HIT] } = {}) {
    const calls = [];
    return {
        calls,
        callTool: async (name, args) => {
            calls.push({ name, args });
            if (name === 'member_detail') return { folder: '/srv/alpha/repo' };
            if (name === 'kb_query') return { content: [{ text: JSON.stringify({ l1_results: l1, related_claims: related }) }] };
            if (name === 'kb_session_prime') return { content: [{ text: JSON.stringify({ top_entries: top }) }] };
            return {};
        },
    };
}

function assertOnlyConfirmed(prompt, label) {
    assert.match(prompt, /KNOWLEDGE BANK -- what this repo already knows/, `${label}: block must be present`);
    assert.ok(prompt.includes('confirmedmarker direct hit'), `${label}: a CONFIRMED entry must still reach the prompt`);
    for (const marker of REJECT_MARKERS) {
        assert.ok(!prompt.includes(marker), `${label}: ${marker} must never reach the prompt`);
    }
}

describe('only CONFIRMED, undisputed KB entries reach a role prompt', () => {
    test('isInjectableKbEntry: CONFIRMED and undisputed only', () => {
        assert.equal(isInjectableKbEntry(CONFIRMED_HIT), true);
        for (const e of [...REJECTS, ...RELATED_REJECTS]) assert.equal(isInjectableKbEntry(e), false, e.title);
        assert.equal(isInjectableKbEntry(null), false);
        assert.equal(isInjectableKbEntry({ id: 'n', title: 'no tier' }), false, 'a missing tier is not CONFIRMED');
    });

    test('relevantKnowledge asks kb_query for CONFIRMED, undisputed entries', async () => {
        const { calls, callTool } = oldServer();
        const client = createKbWorkClient({ callTool, log: () => {} });

        await client.relevantKnowledge('/srv/a', ['anything']);

        const q = calls.find((c) => c.name === 'kb_query');
        assert.deepEqual(q.args.confidence, ['CONFIRMED']);
        assert.equal(q.args.exclude_disputed, true);
        assert.equal(q.args.expand_related, true);
    });

    test('relevantKnowledge drops what an old server returns anyway, direct hits and related claims alike', async () => {
        const { callTool } = oldServer();
        const client = createKbWorkClient({ callTool, log: () => {} });

        const out = await client.relevantKnowledge('/srv/a', ['anything']);

        assert.deepEqual(out.map((e) => e.id), ['c1', 'c2']);
        assert.equal(out[1].via, 'kb-graph');
    });

    test('doer prompt: per-dispatch knowledge carries CONFIRMED entries only', async () => {
        const { callTool } = oldServer();
        const client = createKbWorkClient({ callTool, log: () => {} });
        const kbKnowledge = await client.relevantKnowledge('/srv/a', ['anything']);

        assertOnlyConfirmed(buildDoerPrompt({ beadIds: ['x-1'], branch: 'feat/x', feedback: null, kbKnowledge }), 'doer');
    });

    test('per-round reviewer prompt: per-dispatch knowledge carries CONFIRMED entries only', async () => {
        const { callTool } = oldServer();
        const client = createKbWorkClient({ callTool, log: () => {} });
        const kbKnowledge = await client.relevantKnowledge('/srv/a', ['anything']);

        assertOnlyConfirmed(buildReviewerPrompt({
            beadIds: ['x-1'], acceptanceCriteriaJson: '{}', baseBranch: 'main', branch: 'feat/x', kbKnowledge,
        }), 'reviewer');
    });

    test('sprint-start prime keeps CONFIRMED entries only', async () => {
        const { callTool } = oldServer();
        const priming = createKbPrimingClient({ callTool, members: ['alpha'], log: () => {} });

        await priming.primeAll();

        assert.deepEqual(priming.knowledgeOf('alpha').map((e) => e.id), ['c1']);
    });

    // Mirrors runner.js agent(): kbKnowledgeBlock(kbPriming.knowledgeOf(member),
    // { captureChannel }) -- the wiring itself is pinned by
    // kb-prompt-contract-wrapper-roles.test.mjs.
    test('wrapper-role (agent()) block: sprint-start knowledge carries CONFIRMED entries only', async () => {
        const { callTool } = oldServer();
        const priming = createKbPrimingClient({ callTool, members: ['alpha'], log: () => {} });
        await priming.primeAll();

        for (const captureChannel of [true, false]) {
            const [block] = kbKnowledgeBlock(priming.knowledgeOf('alpha'), { captureChannel });
            assertOnlyConfirmed(block, `wrapper role (captureChannel=${captureChannel})`);
        }
    });

    test('final review prompt: sprint-start knowledge carries CONFIRMED entries only', async () => {
        const { callTool } = oldServer();
        const priming = createKbPrimingClient({ callTool, members: ['alpha'], log: () => {} });
        await priming.primeAll();

        assertOnlyConfirmed(buildFinalVerdictPrompt({
            targetIssues: ['x-1'], branch: 'feat/x', baseBranch: 'main', goal: 'g', cyclesRun: 1,
            closedCount: 1, openAtGoalCount: 0, deployFailures: [], integFailures: [],
            kbCandidates: [], kbKnowledge: priming.knowledgeOf('alpha'),
        }), 'final review');
    });

    test('kbKnowledgeBlock is itself a chokepoint: an unfiltered list renders CONFIRMED entries only', () => {
        const [block] = kbKnowledgeBlock([...REJECTS, CONFIRMED_HIT, ...RELATED_REJECTS]);
        assertOnlyConfirmed(block, 'direct kbKnowledgeBlock');
    });

    test('nothing CONFIRMED means no block at all, not an empty one', () => {
        assert.deepEqual(kbKnowledgeBlock([...REJECTS, ...RELATED_REJECTS]), []);
    });

    test('the header no longer overclaims verification or explains INFERRED', () => {
        const [block] = kbKnowledgeBlock([CONFIRMED_HIT]);
        const header = block.slice(0, block.indexOf('You do not need to call'));
        assert.ok(header.startsWith('KNOWLEDGE BANK -- what this repo already knows.'), 'heading line unchanged');
        assert.ok(!/captured and verified/.test(header), 'no "captured and verified" overclaim');
        assert.ok(!/INFERRED/.test(header), 'no INFERRED guidance -- none are injected');
        assert.match(header, /Only CONFIRMED entries are included/);
        assert.match(header, /the code wins/);
    });

    test('the 12-entry cap applies AFTER filtering, on both paths', async () => {
        const inferred = Array.from({ length: 20 }, (_, i) => entry(`inf${i}`, `inferredmarker ${i}`, 'INFERRED'));
        const confirmed = Array.from({ length: 15 }, (_, i) => entry(`conf${i}`, `confirmedmarker ${i}`, 'CONFIRMED'));
        const { callTool } = oldServer({ l1: [...inferred, ...confirmed], related: [], top: [...inferred, ...confirmed.slice(0, 3)] });

        const out = await createKbWorkClient({ callTool, log: () => {} }).relevantKnowledge('/srv/a', ['x']);
        assert.equal(out.length, KB_MAX_KNOWLEDGE_ENTRIES);
        assert.ok(out.every((e) => e.confidence === 'CONFIRMED'));

        const priming = createKbPrimingClient({ callTool, members: ['alpha'], log: () => {} });
        await priming.primeAll();
        assert.deepEqual(priming.knowledgeOf('alpha').map((e) => e.id), ['conf0', 'conf1', 'conf2'],
            'INFERRED entries ranked first must not crowd the CONFIRMED ones out of the cap');
    });

    // develop.mjs / runner.js: `queried.length > 0 ? queried : kbPriming.knowledgeOf(member)`.
    test('an all-unconfirmed query result falls back to the (filtered) sprint-start set', async () => {
        const { callTool } = oldServer({ l1: REJECTS, related: RELATED_REJECTS });
        const work = createKbWorkClient({ callTool, log: () => {} });
        const priming = createKbPrimingClient({ callTool, members: ['alpha'], log: () => {} });
        await priming.primeAll();

        const queried = await work.relevantKnowledge('/srv/a', ['x']);
        assert.deepEqual(queried, [], 'nothing injectable from the query');
        const kbKnowledge = queried.length > 0 ? queried : priming.knowledgeOf('alpha');
        assertOnlyConfirmed(buildDoerPrompt({ beadIds: ['x-1'], branch: 'feat/x', feedback: null, kbKnowledge }), 'doer fallback');
    });
});
