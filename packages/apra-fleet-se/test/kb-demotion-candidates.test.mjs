import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
    createKbWorkClient, vetKbWork, kbDemotionBlock, KB_MAX_DEMOTION_CANDIDATES, KB_MIN_PROMOTE_REASON,
    KB_DEMOTION_READ_LIMIT, buildDemotionCandidateQuery, isDemotableCandidate,
} from '../fleet-sprint/kb.mjs';
import { createRoundChangedFiles, createSprintChangedFiles, buildReviewerPrompt } from '../fleet-sprint/runner.js';
import { fakeMaintainerSelector } from './helpers/kb-maintainer-fakes.mjs';

// Covers kbWork.demotionCandidates() --
// the CONFIRMED entries this reviewer may demote back to INFERRED, scoped to
// THIS review round's changed files -- plus the round-diff mechanism it
// depends on (createRoundChangedFiles), and the vetKbWork/kbDemotionBlock
// pieces landed by sibling impl work that had
// no dedicated test coverage of their own until now (verified by grep: zero
// hits for kb_demotions/demotionCandidates/kbDemotionBlock anywhere under
// test/ before this file).

const REVIEWER = Object.freeze({ id: 'id-warehouse-reviewer', name: 'warehouse-reviewer', type: 'local' });
// Every KB write is routed to the repository's kb_maintainer, so the
// CONFIRMED candidates live in -- and are read from -- the maintainer's KB.
const MAINTAINER = Object.freeze({ id: 'id-warehouse-maint', name: 'warehouse-maint', type: 'remote' });
const withMaintainer = () => fakeMaintainerSelector({
    repoOf: { [REVIEWER.name]: 'example.com/warehouse', [MAINTAINER.name]: 'example.com/warehouse' },
    maintainerOf: { 'example.com/warehouse': MAINTAINER },
});

// The fake kb_query HONOURS args.limit -- it serves at most that many rows,
// exactly as the real provider does. That is what makes the cap-after-filter
// test below able to FAIL: with the offer cap used as the read limit, rows
// sitting past position 20 of the maintainer's owned CONFIRMED set are never
// served at all, so no amount of later filtering can recover them. A fake that
// ignored `limit` would return every row regardless of the ordering bug and
// would quietly pass either implementation.
function makeCallTool(entries, opts = {}) {
    const calls = [];
    return {
        calls,
        memberCall: async (member, name, args) => {
            calls.push({ name, args, member });
            if (name === 'kb_query') {
                if (opts.throwOnList) throw new Error('kb unavailable');
                if (opts.rejectOnList) return { isError: true, content: [{ type: 'text', text: 'denied' }] };
                const limit = typeof args.limit === 'number' ? args.limit : entries.length;
                return { content: [{ type: 'text', text: JSON.stringify({ l1_results: entries.slice(0, limit) }) }] };
            }
            return {};
        },
    };
}

const CONFIRMED_ENTRIES = [
    { id: 'kb-aaa', type: 'knowledge', confidence: 'CONFIRMED', title: 'Transit rows key on trackId', summary: 'open transit is keyed by (trackId, locationId)', source_files: ['server/transit.js'] },
    { id: 'kb-bbb', type: 'learning', confidence: 'CONFIRMED', title: 'Exit events are no-op when unmatched', summary: 'unmatched exit never fabricates a transit', source_files: ['server/rules.js'] },
];

describe('createKbWorkClient.demotionCandidates', () => {
    test("asks the reviewer's repository maintainer for its own CONFIRMED entries touching this round's changed files", async () => {
        const { calls, memberCall } = makeCallTool(CONFIRMED_ENTRIES);
        const client = createKbWorkClient({
            memberCall,
            maintainers: withMaintainer(),
            roundChangedFiles: async () => ['server/transit.js'],
            log: () => {},
        });

        const candidates = await client.demotionCandidates(REVIEWER);

        const queryCall = calls.find((c) => c.name === 'kb_query');
        assert.ok(queryCall, 'kb_query was never called -- the reviewer gets no demotion candidates');
        // Each field spelled out rather than compared to the builder's own
        // output, which would be tautological. These ARE the four defects
        // that made the first implementation return nothing in a real sprint.
        assert.equal(
            queryCall.args.own_scope, true,
            'without own_scope a MEMBER-session CONFIRMED read is answered from the checkout bible view, '
            + 'whose rows are all untagged -- the owner filter can then never match, in any sprint',
        );
        assert.equal(queryCall.args.tag, `member:${MAINTAINER.id}`, 'kb_query refuses a call with neither query, tag nor flagged_only');
        assert.deepEqual(queryCall.args.confidence, ['CONFIRMED'], 'kb_demote accepts nothing else (E-DEMOTE-NOT-CONFIRMED)');
        assert.equal(queryCall.args.include_stale, true, 'a STALE CONFIRMED row is demotable and is exactly the kind most worth re-checking');
        assert.equal(queryCall.args.exclude_disputed, false, 'a contradiction-flagged CONFIRMED row is demotable too and must not be dropped by the read');
        assert.equal(queryCall.args.limit, KB_DEMOTION_READ_LIMIT, 'the READ limit must be the wide one');
        assert.notEqual(
            queryCall.args.limit, KB_MAX_DEMOTION_CANDIDATES,
            'the 20-entry OFFER cap must never be used as the read limit -- that makes it a pre-filter',
        );
        assert.equal(queryCall.member, MAINTAINER, 'the read must run in the maintainer session that holds the entries');
        // kb-aaa touches server/transit.js (this round's changed files);
        // kb-bbb touches server/rules.js, which this round never changed.
        assert.deepEqual(candidates.map((c) => c.id), ['kb-aaa']);
    });

    test("excludes an entry whose source_files do not intersect this round's changed files", async () => {
        const { memberCall } = makeCallTool(CONFIRMED_ENTRIES);
        const client = createKbWorkClient({
            memberCall, maintainers: withMaintainer(), roundChangedFiles: async () => ['some/unrelated.js'], log: () => {},
        });

        const candidates = await client.demotionCandidates(REVIEWER);

        assert.deepEqual(candidates, [], 'an entry outside this round\'s diff must never be offered for demotion');
    });

    test('never offers a user-directive as a demotion candidate (kb_demote refuses them)', async () => {
        const { memberCall } = makeCallTool([
            ...CONFIRMED_ENTRIES,
            { id: 'kb-ddd', type: 'user-directive', confidence: 'CONFIRMED', title: 'pending directive', summary: 'x', source_files: ['server/transit.js'] },
        ]);
        const client = createKbWorkClient({
            memberCall, maintainers: withMaintainer(), roundChangedFiles: async () => ['server/transit.js'], log: () => {},
        });

        const candidates = await client.demotionCandidates(REVIEWER);

        assert.ok(!candidates.some((c) => c.id === 'kb-ddd'), 'a user-directive entry was offered for demotion');
    });

    test('caps at KB_MAX_DEMOTION_CANDIDATES -- a 21st matching entry is not offered', async () => {
        const many = Array.from({ length: 21 }, (_, i) => ({
            id: `kb-${i}`, type: 'knowledge', confidence: 'CONFIRMED', title: `entry ${i}`, summary: 'x', source_files: ['server/transit.js'],
        }));
        const { memberCall } = makeCallTool(many);
        const client = createKbWorkClient({
            memberCall, maintainers: withMaintainer(), roundChangedFiles: async () => ['server/transit.js'], log: () => {},
        });

        const candidates = await client.demotionCandidates(REVIEWER, { scope: 'round' });

        assert.equal(candidates.length, KB_MAX_DEMOTION_CANDIDATES, 'the cap was not applied');
        assert.ok(!candidates.some((c) => c.id === 'kb-20'), 'the 21st matching entry must not be offered');
    });

    // ---- eligibility mirrors kb_demote's own refusals -----------------------
    // Read off SqliteProvider.demote(): superseded -> E-DEMOTE-SUPERSEDED,
    // user-directive -> E-DEMOTE-REFUSED-DIRECTIVE, non-CONFIRMED ->
    // E-DEMOTE-NOT-CONFIRMED. STALE is explicitly NOT a refusal there -- the
    // method's own comment calls a stale entry one of the most worth demoting,
    // because staleness is a freshness verdict and trust is a separate axis.
    test('offers a STALE owned CONFIRMED entry -- demote() permits it, so filtering it out drops the best candidates', async () => {
        const { memberCall } = makeCallTool([
            { id: 'kb-stale', type: 'knowledge', confidence: 'CONFIRMED', stale: true, title: 'stale but demotable', summary: 'x', source_files: ['server/transit.js'] },
        ]);
        const client = createKbWorkClient({
            memberCall, maintainers: withMaintainer(), roundChangedFiles: async () => ['server/transit.js'], log: () => {},
        });

        const candidates = await client.demotionCandidates(REVIEWER, { scope: 'round' });

        assert.deepEqual(candidates.map((c) => c.id), ['kb-stale'], 'a stale CONFIRMED entry is demotable and must be offered');
    });

    test('offers a contradiction-flagged owned CONFIRMED entry -- kb_demote does not refuse one', async () => {
        const { memberCall } = makeCallTool([
            { id: 'kb-flagged', type: 'knowledge', confidence: 'CONFIRMED', flagged_for_review: true, title: 'disputed', summary: 'x', source_files: ['server/transit.js'] },
            { id: 'kb-other-side', type: 'knowledge', confidence: 'CONFIRMED', contradiction_of: 'kb-flagged', title: 'the other side', summary: 'x', source_files: ['server/transit.js'] },
        ]);
        const client = createKbWorkClient({
            memberCall, maintainers: withMaintainer(), roundChangedFiles: async () => ['server/transit.js'], log: () => {},
        });

        const candidates = await client.demotionCandidates(REVIEWER, { scope: 'round' });

        assert.deepEqual(candidates.map((c) => c.id), ['kb-flagged', 'kb-other-side']);
    });

    test('never offers a SUPERSEDED entry -- the widened read admits them but kb_demote refuses them', async () => {
        const { memberCall } = makeCallTool([
            ...CONFIRMED_ENTRIES,
            { id: 'kb-sup', type: 'knowledge', confidence: 'CONFIRMED', superseded_at: '2026-10-01T00:00:00.000Z', title: 'superseded', summary: 'x', source_files: ['server/transit.js'] },
        ]);
        const client = createKbWorkClient({
            memberCall, maintainers: withMaintainer(), roundChangedFiles: async () => ['server/transit.js'], log: () => {},
        });

        const candidates = await client.demotionCandidates(REVIEWER, { scope: 'round' });

        assert.ok(
            !candidates.some((c) => c.id === 'kb-sup'),
            'include_stale also admits superseded rows (one input flag, two provider options), so the caller must drop them -- '
            + 'offering one can only produce E-DEMOTE-SUPERSEDED',
        );
    });

    test('never offers a non-CONFIRMED row the read let through', async () => {
        const { memberCall } = makeCallTool([
            ...CONFIRMED_ENTRIES,
            { id: 'kb-inf', type: 'knowledge', confidence: 'INFERRED', title: 'not confirmed', summary: 'x', source_files: ['server/transit.js'] },
        ]);
        const client = createKbWorkClient({
            memberCall, maintainers: withMaintainer(), roundChangedFiles: async () => ['server/transit.js'], log: () => {},
        });

        const candidates = await client.demotionCandidates(REVIEWER, { scope: 'round' });

        assert.ok(!candidates.some((c) => c.id === 'kb-inf'), 'kb_demote refuses anything but CONFIRMED (E-DEMOTE-NOT-CONFIRMED)');
    });

    // ---- the cap is an OFFER cap, applied LAST ------------------------------
    test('CAP AFTER FILTER: every intersecting entry is offered even when the maintainer owns far more CONFIRMED rows than the cap', async () => {
        // 60 owned CONFIRMED rows. The 5 that touch this round's changed files
        // sit at positions 40-44, i.e. WELL PAST the 20-entry offer cap. With
        // the cap used as the read limit, the read stops at position 20 and
        // none of these five is ever served -- the reviewer is offered nothing
        // while five genuinely relevant entries exist.
        const owned = Array.from({ length: 60 }, (_, i) => ({
            id: `kb-${i}`,
            type: 'knowledge',
            confidence: 'CONFIRMED',
            title: `entry ${i}`,
            summary: 'x',
            source_files: [i >= 40 && i < 45 ? 'server/transit.js' : `server/unrelated-${i}.js`],
        }));
        const { calls, memberCall } = makeCallTool(owned);
        const client = createKbWorkClient({
            memberCall, maintainers: withMaintainer(), roundChangedFiles: async () => ['server/transit.js'], log: () => {},
        });

        const candidates = await client.demotionCandidates(REVIEWER, { scope: 'round' });

        assert.deepEqual(
            candidates.map((c) => c.id),
            ['kb-40', 'kb-41', 'kb-42', 'kb-43', 'kb-44'],
            'the relevant entries were truncated away before the changed-file filter ever ran',
        );
        assert.ok(
            calls.find((c) => c.name === 'kb_query').args.limit > KB_MAX_DEMOTION_CANDIDATES,
            'the read limit must be wider than the offer cap for the filter to have anything to work on',
        );
    });

    test('the offer cap still binds AFTER filtering: 25 intersecting entries out of a wide read yield exactly 20', async () => {
        const owned = Array.from({ length: 60 }, (_, i) => ({
            id: `kb-${i}`,
            type: 'knowledge',
            confidence: 'CONFIRMED',
            title: `entry ${i}`,
            summary: 'x',
            source_files: [i >= 30 && i < 55 ? 'server/transit.js' : `server/unrelated-${i}.js`],
        }));
        const { memberCall } = makeCallTool(owned);
        const client = createKbWorkClient({
            memberCall, maintainers: withMaintainer(), roundChangedFiles: async () => ['server/transit.js'], log: () => {},
        });

        const candidates = await client.demotionCandidates(REVIEWER, { scope: 'round' });

        assert.equal(candidates.length, KB_MAX_DEMOTION_CANDIDATES, 'the prompt must stay bounded by the offer cap');
        assert.equal(candidates[0].id, 'kb-30', 'the cap keeps the first survivors of the filter, not an arbitrary pre-filter slice');
    });

    test("no changed files this round yields [] without ever reading the KB", async () => {
        const { calls, memberCall } = makeCallTool(CONFIRMED_ENTRIES);
        for (const changed of [[], null, undefined]) {
            const client = createKbWorkClient({
                memberCall, maintainers: withMaintainer(), roundChangedFiles: async () => changed, log: () => {},
            });
            assert.deepEqual(await client.demotionCandidates(REVIEWER), []);
        }
        assert.equal(calls.length, 0, 'nothing changed this round, so there is nothing to re-check -- kb_query must not even be called');
    });

    test('returns [] rather than reading the wrong KB when no maintainer is resolved', async () => {
        const { calls, memberCall } = makeCallTool(CONFIRMED_ENTRIES);
        const noSelection = createKbWorkClient({ memberCall, roundChangedFiles: async () => ['server/transit.js'], log: () => {} });
        assert.deepEqual(await noSelection.demotionCandidates(REVIEWER), []);
        const client = createKbWorkClient({ memberCall, maintainers: withMaintainer(), roundChangedFiles: async () => ['server/transit.js'], log: () => {} });
        assert.deepEqual(await client.demotionCandidates(null), []);
        assert.equal(calls.length, 0, 'a kb_* read with no maintainer would read some other KB');
    });

    test('no roundChangedFiles wired yields [] and never calls kb_query', async () => {
        const { calls, memberCall } = makeCallTool(CONFIRMED_ENTRIES);
        const client = createKbWorkClient({ memberCall, maintainers: withMaintainer(), log: () => {} });

        assert.deepEqual(await client.demotionCandidates(REVIEWER), []);
        assert.equal(calls.length, 0);
    });

    test('a round diff that could not be computed degrades to [] and never throws into the review dispatch', async () => {
        const { memberCall } = makeCallTool(CONFIRMED_ENTRIES);
        const client = createKbWorkClient({
            memberCall,
            maintainers: withMaintainer(),
            roundChangedFiles: async () => { throw new Error('git unreachable'); },
            log: () => {},
        });

        await assert.doesNotReject(() => client.demotionCandidates(REVIEWER));
        assert.deepEqual(await client.demotionCandidates(REVIEWER), []);
    });

    test('a cold or broken kb_query yields [] and never throws', async () => {
        const { memberCall } = makeCallTool([], { throwOnList: true });
        const client = createKbWorkClient({
            memberCall, maintainers: withMaintainer(), roundChangedFiles: async () => ['server/transit.js'], log: () => {},
        });

        assert.deepEqual(await client.demotionCandidates(REVIEWER), []);
    });

    test('a kb_query tool-level rejection yields []', async () => {
        const { memberCall } = makeCallTool([], { rejectOnList: true });
        const client = createKbWorkClient({
            memberCall, maintainers: withMaintainer(), roundChangedFiles: async () => ['server/transit.js'], log: () => {},
        });

        assert.deepEqual(await client.demotionCandidates(REVIEWER), []);
    });

    test('inactive client (no memberCall) yields []', async () => {
        const client = createKbWorkClient({ roundChangedFiles: async () => ['server/transit.js'], log: () => {} });
        assert.deepEqual(await client.demotionCandidates(REVIEWER), []);
    });

    test('replaces, never accumulates: a failing read the round after a successful one still yields [] -- no fallback to the prior round\'s offers', async () => {
        let round = 0;
        const changedByRound = [['server/transit.js'], ['server/rules.js']];
        const client = createKbWorkClient({
            memberCall: async (member, name) => {
                if (name !== 'kb_query') return {};
                if (round === 0) return { content: [{ type: 'text', text: JSON.stringify({ l1_results: CONFIRMED_ENTRIES }) }] };
                throw new Error('kb unavailable this round');
            },
            maintainers: withMaintainer(),
            roundChangedFiles: async () => changedByRound[round],
            log: () => {},
        });

        const first = await client.demotionCandidates(REVIEWER);
        assert.deepEqual(first.map((c) => c.id), ['kb-aaa'], 'round 1 should offer the entry touching this round\'s files');

        round = 1;
        const second = await client.demotionCandidates(REVIEWER);
        assert.deepEqual(second, [], 'a failing round-2 read must not fall back to round 1\'s offered set');
    });

    test('a maintainer not on the sprint branch skips the round-diff read entirely and offers nothing', async () => {
        const { memberCall } = makeCallTool(CONFIRMED_ENTRIES);
        let roundChangedFilesCalls = 0;
        const client = createKbWorkClient({
            memberCall,
            maintainers: withMaintainer(),
            roundChangedFiles: async () => { roundChangedFilesCalls += 1; return ['server/transit.js']; },
            checkedOutBranch: async () => ({ branch: 'main', sprintBranch: 'feat/thing' }),
            log: () => {},
        });

        const candidates = await client.demotionCandidates(REVIEWER);

        assert.deepEqual(candidates, []);
        assert.equal(roundChangedFilesCalls, 0, 'the round diff must never be computed on a maintainer checked out on the wrong branch');
    });
});

// =============================================================================
// SCOPE IS AN ARGUMENT. A per-round review scopes its demotion candidates to
// THIS round's post-merge diff; the FINAL review has no round at all and
// scopes to the sprint's cumulative baseBranch...branch diff. Which one is
// used comes from the caller's explicit `scope`, never from the candidate read
// working out who is asking.
// =============================================================================
describe('createKbWorkClient.demotionCandidates: changed-file SCOPE', () => {
    const bothScopes = (overrides = {}) => createKbWorkClient({
        maintainers: withMaintainer(),
        roundChangedFiles: async () => ['server/transit.js'],
        sprintChangedFiles: async () => ['server/rules.js'],
        log: () => {},
        ...overrides,
    });

    test("scope 'round' uses the per-round diff and scope 'sprint' uses the cumulative one -- the same KB read, two different offers", async () => {
        const { memberCall } = makeCallTool(CONFIRMED_ENTRIES);
        const client = bothScopes({ memberCall });

        // kb-aaa cites server/transit.js (the round diff); kb-bbb cites
        // server/rules.js (only in the cumulative sprint diff).
        assert.deepEqual((await client.demotionCandidates(REVIEWER, { scope: 'round' })).map((c) => c.id), ['kb-aaa']);
        assert.deepEqual((await client.demotionCandidates(REVIEWER, { scope: 'sprint' })).map((c) => c.id), ['kb-bbb']);
    });

    test("scope 'sprint' never calls the per-round diff, and scope 'round' never calls the cumulative one", async () => {
        const { memberCall } = makeCallTool(CONFIRMED_ENTRIES);
        let roundCalls = 0;
        let sprintCalls = 0;
        const client = bothScopes({
            memberCall,
            roundChangedFiles: async () => { roundCalls += 1; return ['server/transit.js']; },
            sprintChangedFiles: async () => { sprintCalls += 1; return ['server/rules.js']; },
        });

        await client.demotionCandidates(REVIEWER, { scope: 'sprint' });
        assert.equal(roundCalls, 0, "the final review has no round -- advancing the per-round diff's tracked sha from it would corrupt the next round");
        assert.equal(sprintCalls, 1);

        await client.demotionCandidates(REVIEWER, { scope: 'round' });
        assert.equal(sprintCalls, 1, 'a per-round review must not compute the cumulative sprint diff');
        assert.equal(roundCalls, 1);
    });

    test('scope defaults to the per-round diff when omitted', async () => {
        const { memberCall } = makeCallTool(CONFIRMED_ENTRIES);
        const client = bothScopes({ memberCall });

        assert.deepEqual((await client.demotionCandidates(REVIEWER)).map((c) => c.id), ['kb-aaa']);
    });

    test('an unknown scope offers nothing rather than silently falling back to the wrong diff', async () => {
        const { calls, memberCall } = makeCallTool(CONFIRMED_ENTRIES);
        const client = bothScopes({ memberCall });

        assert.deepEqual(await client.demotionCandidates(REVIEWER, { scope: 'cumulative' }), []);
        assert.equal(calls.length, 0, 'an unrecognized scope must not reach the KB at all');
    });

    // ---- criterion 7's degradations, on the FINAL-review scope too ----------
    test("scope 'sprint' with no sprintChangedFiles wired yields [] and never calls kb_query", async () => {
        const { calls, memberCall } = makeCallTool(CONFIRMED_ENTRIES);
        const client = createKbWorkClient({
            memberCall, maintainers: withMaintainer(), roundChangedFiles: async () => ['server/transit.js'], log: () => {},
        });

        assert.deepEqual(await client.demotionCandidates(REVIEWER, { scope: 'sprint' }), [], 'the round diff must never stand in for a missing sprint diff');
        assert.equal(calls.length, 0);
    });

    test("scope 'sprint': a cumulative diff that could not be computed degrades to [] and never throws into the final-review dispatch", async () => {
        const { memberCall } = makeCallTool(CONFIRMED_ENTRIES);
        const client = bothScopes({ memberCall, sprintChangedFiles: async () => { throw new Error('git unreachable'); } });

        await assert.doesNotReject(() => client.demotionCandidates(REVIEWER, { scope: 'sprint' }));
        assert.deepEqual(await client.demotionCandidates(REVIEWER, { scope: 'sprint' }), []);
    });

    test("scope 'sprint': a cold, broken or rejecting kb_query degrades to [] and never throws", async () => {
        for (const opts of [{ throwOnList: true }, { rejectOnList: true }]) {
            const { memberCall } = makeCallTool([], opts);
            const client = bothScopes({ memberCall });
            await assert.doesNotReject(() => client.demotionCandidates(REVIEWER, { scope: 'sprint' }));
            assert.deepEqual(await client.demotionCandidates(REVIEWER, { scope: 'sprint' }), []);
        }
    });

    test("scope 'sprint': no maintainer resolvable yields [] without reading some other KB", async () => {
        const { calls, memberCall } = makeCallTool(CONFIRMED_ENTRIES);
        const noSelection = createKbWorkClient({ memberCall, sprintChangedFiles: async () => ['server/rules.js'], log: () => {} });

        assert.deepEqual(await noSelection.demotionCandidates(REVIEWER, { scope: 'sprint' }), []);
        assert.deepEqual(await bothScopes({ memberCall }).demotionCandidates(null, { scope: 'sprint' }), []);
        assert.equal(calls.length, 0);
    });

    test('REPLACES, never accumulates, across scopes: the final-review read cannot inherit the last round\'s offers', async () => {
        const { memberCall } = makeCallTool(CONFIRMED_ENTRIES);
        let sprintThrows = false;
        const client = bothScopes({
            memberCall,
            sprintChangedFiles: async () => { if (sprintThrows) throw new Error('git unreachable'); return ['server/rules.js']; },
        });

        assert.deepEqual((await client.demotionCandidates(REVIEWER, { scope: 'round' })).map((c) => c.id), ['kb-aaa']);
        sprintThrows = true;
        assert.deepEqual(
            await client.demotionCandidates(REVIEWER, { scope: 'sprint' }), [],
            "a failed final-review read must not fall back to the last per-round review's offered set",
        );
    });
});

describe('buildDemotionCandidateQuery / isDemotableCandidate', () => {
    test('the read is own-scoped, CONFIRMED, stale-and-dispute inclusive, and wide', () => {
        assert.deepEqual(buildDemotionCandidateQuery('uuid-1'), {
            tag: 'member:uuid-1',
            own_scope: true,
            confidence: ['CONFIRMED'],
            include_stale: true,
            exclude_disputed: false,
            limit: KB_DEMOTION_READ_LIMIT,
        });
    });

    test('eligibility mirrors demote()\'s refusals exactly -- stale and flagged in, superseded/directive/non-CONFIRMED out', () => {
        const base = { id: 'kb-1', type: 'knowledge', confidence: 'CONFIRMED' };
        assert.equal(isDemotableCandidate(base), true);
        assert.equal(isDemotableCandidate({ ...base, stale: true }), true, 'demote() permits a stale entry');
        assert.equal(isDemotableCandidate({ ...base, flagged_for_review: true }), true, 'demote() does not refuse a flagged entry');
        assert.equal(isDemotableCandidate({ ...base, contradiction_of: 'kb-2' }), true);
        assert.equal(isDemotableCandidate({ ...base, superseded_at: '2026-01-01T00:00:00.000Z' }), false, 'E-DEMOTE-SUPERSEDED');
        assert.equal(isDemotableCandidate({ ...base, type: 'user-directive' }), false, 'E-DEMOTE-REFUSED-DIRECTIVE');
        assert.equal(isDemotableCandidate({ ...base, confidence: 'INFERRED' }), false, 'E-DEMOTE-NOT-CONFIRMED');
        for (const junk of [null, undefined, {}, { id: '' }, { id: 7, confidence: 'CONFIRMED' }]) {
            assert.equal(isDemotableCandidate(junk), false);
        }
    });
});

describe('createSprintChangedFiles (the cumulative sprint diff the FINAL review scopes to)', () => {
    test('fetches/fast-forward-merges BEFORE diffing, and diffs the whole baseBranch...branch range', async () => {
        const calls = [];
        let merged = false;
        const pullGitBefore = async (memberName) => { calls.push({ op: 'pull', memberName }); merged = true; };
        const command = async (cmd, opts) => {
            calls.push({ op: 'command', cmd, opts, mergedAtCallTime: merged });
            return { ok: true, output: 'round1-file.js\nround2-only-file.js\n' };
        };
        const sprintChangedFiles = createSprintChangedFiles({
            command, pullGitBefore, baseBranch: 'main', branch: 'feat/thing', log: () => {},
        });

        const files = await sprintChangedFiles('maint-1');

        assert.deepEqual(files, ['round1-file.js', 'round2-only-file.js']);
        const diff = calls.find((c) => c.op === 'command');
        assert.equal(diff.cmd, 'git diff --name-only origin/main...feat/thing');
        assert.equal(diff.mergedAtCallTime, true, 'the cumulative diff was read from a stale pre-merge tree');
        assert.equal(diff.opts.member_name, 'maint-1');
        assert.equal(diff.opts.failSoft, true);
    });

    test('is STATELESS -- unlike the per-round factory it returns the same full range on every call', async () => {
        const pullGitBefore = async () => {};
        const seen = [];
        const command = async (cmd) => { seen.push(cmd); return { ok: true, output: 'a.js\n' }; };
        const sprintChangedFiles = createSprintChangedFiles({
            command, pullGitBefore, baseBranch: 'main', branch: 'feat/thing', log: () => {},
        });

        assert.deepEqual(await sprintChangedFiles('maint-1'), ['a.js']);
        assert.deepEqual(await sprintChangedFiles('maint-1'), ['a.js']);
        assert.deepEqual(new Set(seen), new Set(['git diff --name-only origin/main...feat/thing']));
    });

    test('a failed fetch/merge or a failed diff degrades to []', async () => {
        const okCommand = async () => ({ ok: true, output: 'a.js\n' });
        const failing = createSprintChangedFiles({
            command: okCommand, pullGitBefore: async () => { throw new Error('unreachable'); }, baseBranch: 'main', branch: 'feat/thing', log: () => {},
        });
        assert.deepEqual(await failing.call(null, 'maint-1'), []);

        const badDiff = createSprintChangedFiles({
            command: async () => ({ ok: false }), pullGitBefore: async () => {}, baseBranch: 'main', branch: 'feat/thing', log: () => {},
        });
        assert.deepEqual(await badDiff('maint-1'), []);
    });
});

describe('createRoundChangedFiles (the per-round diff, not the cumulative one)', () => {
    function fakeGit({ diffOutputs = {} } = {}) {
        const calls = [];
        let merged = false;
        const pullGitBefore = async (memberName) => {
            calls.push({ op: 'pull', memberName });
            merged = true;
        };
        const command = async (cmd, opts) => {
            calls.push({ op: 'command', cmd, opts, mergedAtCallTime: merged });
            if (cmd === 'git rev-parse HEAD') {
                return { ok: true, output: merged ? 'post-merge-sha' : 'pre-merge-sha' };
            }
            const key = Object.keys(diffOutputs).find((k) => cmd === `git diff --name-only ${k}`);
            if (key) return { ok: true, output: diffOutputs[key] };
            return { ok: true, output: '' };
        };
        return { calls, pullGitBefore, command, mergedFlag: () => merged };
    }

    test('fetches/fast-forward-merges BEFORE reading HEAD and diffing, and diffs from the base branch on the first round', async () => {
        const { calls, pullGitBefore, command } = fakeGit({
            diffOutputs: { 'origin/main...post-merge-sha': 'a.js\nb.js\n' },
        });
        const roundChangedFiles = createRoundChangedFiles({ command, pullGitBefore, baseBranch: 'main', log: () => {} });

        const files = await roundChangedFiles('maint-1');

        assert.deepEqual(files, ['a.js', 'b.js']);
        const revParse = calls.find((c) => c.op === 'command' && c.cmd === 'git rev-parse HEAD');
        assert.equal(revParse.mergedAtCallTime, true, 'HEAD was read BEFORE the fetch/merge -- a stale pre-merge snapshot');
        const diff = calls.find((c) => c.op === 'command' && c.cmd.startsWith('git diff'));
        assert.equal(diff.cmd, 'git diff --name-only origin/main...post-merge-sha');
    });

    test('FALSIFICATION: computing the diff before the fetch/merge reads the stale pre-merge tree -- proving this test suite actually discriminates the order', async () => {
        // Same fakes as above, but this reverted variant reads HEAD and diffs
        // BEFORE calling pullGitBefore -- the superseded upstream attempt's
        // defect described above. It is written here,
        // inline, purely to prove the fakes above can tell the two orders
        // apart; the correct order is exercised by createRoundChangedFiles
        // itself in the test above and is never reverted in production code.
        async function revertedRoundChangedFiles({ command, pullGitBefore, baseBranch }) {
            const headRes = await command('git rev-parse HEAD', {});
            await pullGitBefore('maint-1');
            const diffRes = await command(`git diff --name-only origin/${baseBranch}...${headRes.output}`, {});
            return String(diffRes.output || '').split('\n').filter(Boolean);
        }
        const { command, pullGitBefore } = fakeGit({
            diffOutputs: {
                'origin/main...pre-merge-sha': 'stale-only.js\n',
                'origin/main...post-merge-sha': 'a.js\nb.js\n',
            },
        });

        const files = await revertedRoundChangedFiles({ command, pullGitBefore, baseBranch: 'main' });

        assert.deepEqual(files, ['stale-only.js'], 'the reverted (pre-merge) order must read the stale tree');
        assert.notDeepEqual(files, ['a.js', 'b.js'], 'the reverted order must NOT match the correct post-merge result');
    });

    test("round 2 diffs from round 1's merged tip, not from the base branch again -- never the cumulative sprint diff", async () => {
        const shas = ['round1-sha', 'round2-sha'];
        let callIndex = 0;
        const calls = [];
        const pullGitBefore = async () => {};
        const command = async (cmd) => {
            calls.push(cmd);
            if (cmd === 'git rev-parse HEAD') {
                const sha = shas[callIndex];
                callIndex += 1;
                return { ok: true, output: sha };
            }
            // Round 1: origin/main...round1-sha. Round 2 (per-round): the
            // interesting case is round1-sha...round2-sha, which must differ
            // from what the CUMULATIVE diff (origin/main...round2-sha) would
            // have returned.
            if (cmd === 'git diff --name-only origin/main...round1-sha') return { ok: true, output: 'round1-file.js\n' };
            if (cmd === 'git diff --name-only round1-sha...round2-sha') return { ok: true, output: 'round2-only-file.js\n' };
            if (cmd === 'git diff --name-only origin/main...round2-sha') return { ok: true, output: 'round1-file.js\nround2-only-file.js\n' };
            return { ok: true, output: '' };
        };
        const roundChangedFiles = createRoundChangedFiles({ command, pullGitBefore, baseBranch: 'main', log: () => {} });

        const round1Files = await roundChangedFiles('maint-1');
        const round2Files = await roundChangedFiles('maint-1');

        assert.deepEqual(round1Files, ['round1-file.js']);
        // The per-round diff for round 2 is round1-sha...round2-sha, which is
        // STRICTLY SMALLER than the cumulative origin/main...round2-sha diff
        // the engine's other (unrelated) diffFiles helper would have
        // returned for the same round -- proving this is genuinely the
        // per-round set, not the cumulative one.
        assert.deepEqual(round2Files, ['round2-only-file.js']);
        assert.notDeepEqual(round2Files, ['round1-file.js', 'round2-only-file.js']);
        assert.ok(calls.includes('git diff --name-only round1-sha...round2-sha'), 'round 2 must diff from round 1\'s tip');
        assert.ok(!calls.includes('git diff --name-only origin/main...round2-sha'), 'round 2 must never fall back to the cumulative base-branch diff');
    });

    test('a failed fetch/merge degrades to [] and does not advance the tracked round sha', async () => {
        let shouldFail = true;
        const pullGitBefore = async () => { if (shouldFail) throw new Error('unreachable'); };
        const diffCalls = [];
        const command = async (cmd) => {
            if (cmd === 'git rev-parse HEAD') return { ok: true, output: 'sha-1' };
            diffCalls.push(cmd);
            if (cmd === 'git diff --name-only origin/main...sha-1') return { ok: true, output: 'f.js\n' };
            return { ok: true, output: '' };
        };
        const roundChangedFiles = createRoundChangedFiles({ command, pullGitBefore, baseBranch: 'main', log: () => {} });

        const failed = await roundChangedFiles('maint-1');
        assert.deepEqual(failed, [], 'a failed fetch/merge must degrade to [], never throw');

        shouldFail = false;
        const recovered = await roundChangedFiles('maint-1');
        assert.deepEqual(recovered, ['f.js'], 'the failed round must not have recorded a stale "previous round" sha');
        assert.ok(diffCalls.includes('git diff --name-only origin/main...sha-1'), 'the recovered round must still diff from the base branch, not a sha from the failed attempt');
    });

    test('a failed git command degrades to []', async () => {
        const pullGitBefore = async () => {};
        const command = async (cmd) => (cmd === 'git rev-parse HEAD' ? { ok: false } : { ok: true, output: 'x.js\n' });
        const roundChangedFiles = createRoundChangedFiles({ command, pullGitBefore, baseBranch: 'main', log: () => {} });

        assert.deepEqual(await roundChangedFiles('maint-1'), []);
    });
});

describe('vetKbWork: kb_demotions', () => {
    const REASON = 'checked the same cited test this review and it now fails';

    test('kb_demotions is reviewer-only: a non-reviewer role is refused wholesale and nothing is executed', () => {
        const result = vetKbWork('doer', { kb_demotions: [{ id: 'kb-aaa', reason: REASON }] });
        assert.deepEqual(result.demotions, []);
        assert.ok(result.refused.some((r) => r === 'doer: kb_demotions refused -- demotion is reviewer-only'));
    });

    test('a demotion with a missing id is refused; the rest of the list is still processed', () => {
        const result = vetKbWork('reviewer', { kb_demotions: [{ reason: REASON }, { id: 'kb-bbb', reason: REASON }] });
        assert.deepEqual(result.demotions.map((d) => d.id), ['kb-bbb']);
        assert.ok(result.refused.some((r) => r === 'reviewer: demotion missing id'));
    });

    test('a 19-character reason is refused; a 20-character reason is accepted', () => {
        const short = vetKbWork('reviewer', { kb_demotions: [{ id: 'kb-aaa', reason: 'x'.repeat(19) }] });
        assert.deepEqual(short.demotions, []);
        assert.ok(short.refused.some((r) => r === 'reviewer: demotion kb-aaa has no recorded evidence'));

        const exact = vetKbWork('reviewer', { kb_demotions: [{ id: 'kb-aaa', reason: 'x'.repeat(KB_MIN_PROMOTE_REASON) }] });
        assert.deepEqual(exact.demotions.map((d) => d.id), ['kb-aaa']);
    });

    test('evidence_files is carried through when present and omitted (not an empty array) when absent', () => {
        const withEvidence = vetKbWork('reviewer', { kb_demotions: [{ id: 'kb-aaa', reason: REASON, evidence_files: ['test/foo.test.ts'] }] });
        assert.deepEqual(withEvidence.demotions[0].evidence_files, ['test/foo.test.ts']);

        const withoutEvidence = vetKbWork('reviewer', { kb_demotions: [{ id: 'kb-bbb', reason: REASON }] });
        assert.ok(!('evidence_files' in withoutEvidence.demotions[0]), 'evidence_files must be omitted, not sent as []');
    });

    test('the pre-existing two-way promote/discard refusal messages are byte-identical to the pre-kb_demotions wording', () => {
        const result = vetKbWork('reviewer', {
            kb_promotions: [{ id: 'kb-shared', reason: REASON }],
            kb_discards: [{ id: 'kb-shared', reason: REASON }],
        });
        assert.deepEqual(result.promotions, []);
        assert.deepEqual(result.discards, []);
        assert.ok(result.refused.includes(`reviewer: promotion kb-shared refused -- the same output also discards it (promote reason: ${REASON})`));
        assert.ok(result.refused.includes(`reviewer: discard kb-shared refused -- the same output also promotes it (discard reason: ${REASON})`));
    });

    test('three-way collision guard: an id in kb_promotions and kb_demotions is refused in both', () => {
        const result = vetKbWork('reviewer', {
            kb_promotions: [{ id: 'kb-x', reason: REASON }],
            kb_demotions: [{ id: 'kb-x', reason: REASON }],
        });
        assert.deepEqual(result.promotions, []);
        assert.deepEqual(result.demotions, []);
        assert.ok(result.refused.includes(`reviewer: promotion kb-x refused -- the same output also demotes it (promote reason: ${REASON})`));
        assert.ok(result.refused.includes(`reviewer: demotion kb-x refused -- the same output also promotes it (demote reason: ${REASON})`));
    });

    test('three-way collision guard: an id in kb_discards and kb_demotions is refused in both', () => {
        const result = vetKbWork('reviewer', {
            kb_discards: [{ id: 'kb-y', reason: REASON }],
            kb_demotions: [{ id: 'kb-y', reason: REASON }],
        });
        assert.deepEqual(result.discards, []);
        assert.deepEqual(result.demotions, []);
        assert.ok(result.refused.includes(`reviewer: discard kb-y refused -- the same output also demotes it (discard reason: ${REASON})`));
        assert.ok(result.refused.includes(`reviewer: demotion kb-y refused -- the same output also discards it (demote reason: ${REASON})`));
    });

    test('three-way collision guard: an id in ALL THREE lists is refused in every one of them', () => {
        const result = vetKbWork('reviewer', {
            kb_promotions: [{ id: 'kb-z', reason: REASON }],
            kb_discards: [{ id: 'kb-z', reason: REASON }],
            kb_demotions: [{ id: 'kb-z', reason: REASON }],
        });
        assert.deepEqual(result.promotions, []);
        assert.deepEqual(result.discards, []);
        assert.deepEqual(result.demotions, []);
        assert.ok(result.refused.includes(`reviewer: promotion kb-z refused -- the same output also discards and demotes it (promote reason: ${REASON})`));
        assert.ok(result.refused.includes(`reviewer: discard kb-z refused -- the same output also promotes and demotes it (discard reason: ${REASON})`));
        assert.ok(result.refused.includes(`reviewer: demotion kb-z refused -- the same output also promotes and discards it (demote reason: ${REASON})`));
    });

    test('an unrelated id in only one list is unaffected by the collision guard', () => {
        const result = vetKbWork('reviewer', {
            kb_promotions: [{ id: 'kb-shared', reason: REASON }, { id: 'kb-solo', reason: REASON }],
            kb_demotions: [{ id: 'kb-shared', reason: REASON }],
        });
        assert.deepEqual(result.promotions.map((p) => p.id), ['kb-solo']);
        assert.deepEqual(result.demotions, []);
    });
});

describe('kbDemotionBlock', () => {
    test('renders nothing for an empty or absent candidate list', () => {
        for (const kbCandidates of [[], undefined, null]) {
            assert.deepEqual(kbDemotionBlock(kbCandidates), []);
        }
    });

    test('renders the offered ids, titles and the kb_demotions output field', () => {
        const block = kbDemotionBlock(CONFIRMED_ENTRIES);
        assert.ok(block.length > 0);
        const text = block.join('\n');
        for (const e of CONFIRMED_ENTRIES) {
            assert.ok(text.includes(e.id), `candidate ${e.id} missing from the demotion block`);
            assert.ok(text.includes(e.title), `candidate title for ${e.id} missing`);
        }
        assert.match(text, /kb_demotions/, 'the block never names the output field the engine reads');
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

    test('carries each demotion candidate id into the prompt', () => {
        const prompt = buildReviewerPrompt({ ...BASE, kbDemoteCandidates: CONFIRMED_ENTRIES });

        for (const e of CONFIRMED_ENTRIES) {
            assert.ok(prompt.includes(e.id), `demotion candidate ${e.id} missing from the reviewer prompt`);
        }
        assert.match(prompt, /kb_demotions/, 'prompt never names the output field the engine reads');
    });

    test('omits the demotion block entirely when there are no candidates', () => {
        for (const kbDemoteCandidates of [[], undefined]) {
            const prompt = buildReviewerPrompt({ ...BASE, kbDemoteCandidates });
            assert.ok(!/kb_demotions/.test(prompt), `empty demotion candidate set still emitted a KB block (${JSON.stringify(kbDemoteCandidates)})`);
        }
    });
});
