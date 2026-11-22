import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
    createKbWorkClient as createKbWorkClientRaw, vetKbWork, kbDemotionBlock, KB_MAX_DEMOTION_CANDIDATES, KB_MIN_PROMOTE_REASON,
    KB_DEMOTION_READ_LIMIT, buildDemotionCandidateQuery, buildBibleDemotionCandidateQuery, isDemotableCandidate,
} from '../fleet-sprint/kb.mjs';
import { createSprintChangedFiles, createBranchWithdrawnEntries, buildReviewerPrompt, buildFinalVerdictPrompt } from '../fleet-sprint/runner.js';
import { fakeMaintainerSelector, withKbCapabilities, ALL_KB_ROUTES } from './helpers/kb-maintainer-fakes.mjs';

// Covers kbWork.demotionCandidates() -- the CONFIRMED entries the FINAL
// reviewer may demote (a round review is offered none), scoped to the
// sprint's cumulative changed files and widened to every CONFIRMED entry
// citing them (not only the maintainer's own) -- plus the cumulative-diff
// mechanism it depends on (createSprintChangedFiles), the withdrawal-route
// feature detection, and the vetKbWork/kbDemotionBlock pieces.

const REVIEWER = Object.freeze({ id: 'id-warehouse-reviewer', name: 'warehouse-reviewer', type: 'local' });
// Every KB write is routed to the repository's kb_maintainer, so the
// CONFIRMED candidates live in -- and are read from -- the maintainer's KB.
const MAINTAINER = Object.freeze({ id: 'id-warehouse-maint', name: 'warehouse-maint', type: 'remote' });
// The candidate read is feature-detected on the maintainer's own session,
// local or remote: its tools/list must name kb_capabilities and that tool's
// routes must include `withdraw`. A current server lists kb_capabilities;
// its kb_bible_commit schema is deliberately left WITHOUT withdrawals /
// restore_ids, so a detection still sniffing that schema offers nothing.
const newSchemaListTools = async () => ({
    tools: [
        { name: 'kb_capabilities', inputSchema: { properties: {} } },
        { name: 'kb_bible_commit', inputSchema: { properties: { ids: {} } } },
    ],
});
// An older server: no kb_capabilities -- even though its kb_bible_commit
// schema advertises withdrawals and restore_ids, it is offered nothing.
const oldSchemaListTools = async () => ({
    tools: [{ name: 'kb_bible_commit', inputSchema: { properties: { ids: {}, withdrawals: {}, restore_ids: {} } } }],
});
// Every client below answers kb_capabilities on its memberCall with every
// route (a SQLite KB) unless the test passes `capabilityRoutes` (an http KB
// server's list) or `capabilities` (a raw kb_capabilities answer).
function createKbWorkClient(opts = {}) {
    const { capabilityRoutes, capabilities, ...rest } = opts;
    if (typeof rest.memberCall !== 'function') return createKbWorkClientRaw(rest);
    const inner = rest.memberCall;
    const memberCall = capabilities !== undefined
        ? async (member, name, ...a) => (name === 'kb_capabilities' ? capabilities(member) : inner(member, name, ...a))
        : withKbCapabilities(inner, capabilityRoutes || ALL_KB_ROUTES);
    return createKbWorkClientRaw({ ...rest, memberCall });
}
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
    test("asks the reviewer's repository maintainer for every CONFIRMED entry touching the sprint's changed files", async () => {
        const { calls, memberCall } = makeCallTool(CONFIRMED_ENTRIES);
        const client = createKbWorkClient({
            memberCall,
            maintainers: withMaintainer(), listTools: newSchemaListTools,
            sprintChangedFiles: async () => ['server/transit.js'],
            log: () => {},
        });

        const candidates = await client.demotionCandidates(REVIEWER);

        const queries = calls.filter((c) => c.name === 'kb_query');
        assert.equal(queries.length, 2, 'the read is two kb_query calls: the bible view and the maintainer\'s own rows');
        const bibleCall = queries.find((c) => !c.args.own_scope);
        const ownCall = queries.find((c) => c.args.own_scope);
        assert.ok(bibleCall, 'no bible-view read: only the maintainer\'s own entries could ever be offered');
        assert.ok(ownCall, 'no own-scope read: an entry promoted this sprint (not in the bible yet) could never be offered');
        // The widened read: every CONFIRMED entry citing a changed file,
        // whoever captured it -- so NO member tag on it.
        assert.deepEqual(bibleCall.args.files, ['server/transit.js'], 'the bible read must be file-filtered to the changed files');
        assert.equal(bibleCall.args.tag, undefined, 'a member tag would narrow the read back to the maintainer\'s own entries');
        assert.deepEqual(bibleCall.args.confidence, ['CONFIRMED']);
        assert.equal(bibleCall.args.include_stale, true, 'a STALE CONFIRMED row is exactly the kind most worth re-checking');
        assert.equal(bibleCall.args.exclude_disputed, false, 'a contradiction-flagged CONFIRMED row must not be dropped by the read');
        assert.equal(bibleCall.args.limit, KB_DEMOTION_READ_LIMIT, 'the READ limit must be the wide one');
        assert.equal(ownCall.args.tag, `member:${MAINTAINER.id}`, 'kb_query refuses a call with neither query, tag nor flagged_only');
        assert.equal(ownCall.args.limit, KB_DEMOTION_READ_LIMIT);
        for (const q of queries) {
            assert.notEqual(q.args.limit, KB_MAX_DEMOTION_CANDIDATES, 'the OFFER cap must never be used as the read limit');
            assert.equal(q.member, MAINTAINER, 'the read must run in the maintainer session that holds the entries');
        }
        // kb-aaa touches server/transit.js (a changed file); kb-bbb touches
        // server/rules.js, which the sprint never changed.
        assert.deepEqual(candidates.map((c) => c.id), ['kb-aaa']);
    });

    test("excludes an entry whose source_files do not intersect the sprint's changed files", async () => {
        const { memberCall } = makeCallTool(CONFIRMED_ENTRIES);
        const client = createKbWorkClient({
            memberCall, maintainers: withMaintainer(), listTools: newSchemaListTools, sprintChangedFiles: async () => ['some/unrelated.js'], log: () => {},
        });

        const candidates = await client.demotionCandidates(REVIEWER);

        assert.deepEqual(candidates, [], 'an entry outside the sprint\'s diff must never be offered for demotion');
    });

    test('never offers a user-directive as a demotion candidate (kb_demote refuses them)', async () => {
        const { memberCall } = makeCallTool([
            ...CONFIRMED_ENTRIES,
            { id: 'kb-ddd', type: 'user-directive', confidence: 'CONFIRMED', title: 'pending directive', summary: 'x', source_files: ['server/transit.js'] },
        ]);
        const client = createKbWorkClient({
            memberCall, maintainers: withMaintainer(), listTools: newSchemaListTools, sprintChangedFiles: async () => ['server/transit.js'], log: () => {},
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
            memberCall, maintainers: withMaintainer(), listTools: newSchemaListTools, sprintChangedFiles: async () => ['server/transit.js'], log: () => {},
        });

        const candidates = await client.demotionCandidates(REVIEWER, { scope: 'sprint' });

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
            memberCall, maintainers: withMaintainer(), listTools: newSchemaListTools, sprintChangedFiles: async () => ['server/transit.js'], log: () => {},
        });

        const candidates = await client.demotionCandidates(REVIEWER, { scope: 'sprint' });

        assert.deepEqual(candidates.map((c) => c.id), ['kb-stale'], 'a stale CONFIRMED entry is demotable and must be offered');
    });

    test('offers a contradiction-flagged owned CONFIRMED entry -- kb_demote does not refuse one', async () => {
        const { memberCall } = makeCallTool([
            { id: 'kb-flagged', type: 'knowledge', confidence: 'CONFIRMED', flagged_for_review: true, title: 'disputed', summary: 'x', source_files: ['server/transit.js'] },
            { id: 'kb-other-side', type: 'knowledge', confidence: 'CONFIRMED', contradiction_of: 'kb-flagged', title: 'the other side', summary: 'x', source_files: ['server/transit.js'] },
        ]);
        const client = createKbWorkClient({
            memberCall, maintainers: withMaintainer(), listTools: newSchemaListTools, sprintChangedFiles: async () => ['server/transit.js'], log: () => {},
        });

        const candidates = await client.demotionCandidates(REVIEWER, { scope: 'sprint' });

        assert.deepEqual(candidates.map((c) => c.id), ['kb-flagged', 'kb-other-side']);
    });

    test('never offers a SUPERSEDED entry -- the widened read admits them but kb_demote refuses them', async () => {
        const { memberCall } = makeCallTool([
            ...CONFIRMED_ENTRIES,
            { id: 'kb-sup', type: 'knowledge', confidence: 'CONFIRMED', superseded_at: '2026-10-01T00:00:00.000Z', title: 'superseded', summary: 'x', source_files: ['server/transit.js'] },
        ]);
        const client = createKbWorkClient({
            memberCall, maintainers: withMaintainer(), listTools: newSchemaListTools, sprintChangedFiles: async () => ['server/transit.js'], log: () => {},
        });

        const candidates = await client.demotionCandidates(REVIEWER, { scope: 'sprint' });

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
            memberCall, maintainers: withMaintainer(), listTools: newSchemaListTools, sprintChangedFiles: async () => ['server/transit.js'], log: () => {},
        });

        const candidates = await client.demotionCandidates(REVIEWER, { scope: 'sprint' });

        assert.ok(!candidates.some((c) => c.id === 'kb-inf'), 'kb_demote refuses anything but CONFIRMED (E-DEMOTE-NOT-CONFIRMED)');
    });

    // ---- the cap is an OFFER cap, applied LAST ------------------------------
    test('CAP AFTER FILTER: every intersecting entry is offered even when the maintainer owns far more CONFIRMED rows than the cap', async () => {
        // 60 owned CONFIRMED rows. The 5 that touch the sprint's changed files
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
            memberCall, maintainers: withMaintainer(), listTools: newSchemaListTools, sprintChangedFiles: async () => ['server/transit.js'], log: () => {},
        });

        const candidates = await client.demotionCandidates(REVIEWER, { scope: 'sprint' });

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
            memberCall, maintainers: withMaintainer(), listTools: newSchemaListTools, sprintChangedFiles: async () => ['server/transit.js'], log: () => {},
        });

        const candidates = await client.demotionCandidates(REVIEWER, { scope: 'sprint' });

        assert.equal(candidates.length, KB_MAX_DEMOTION_CANDIDATES, 'the prompt must stay bounded by the offer cap');
        assert.equal(candidates[0].id, 'kb-30', 'the cap keeps the first survivors of the filter, not an arbitrary pre-filter slice');
    });

    test("no changed files in the sprint yields [] without ever reading the KB", async () => {
        const { calls, memberCall } = makeCallTool(CONFIRMED_ENTRIES);
        for (const changed of [[], null, undefined]) {
            const client = createKbWorkClient({
                memberCall, maintainers: withMaintainer(), listTools: newSchemaListTools, sprintChangedFiles: async () => changed, log: () => {},
            });
            assert.deepEqual(await client.demotionCandidates(REVIEWER), []);
        }
        assert.equal(calls.length, 0, 'nothing changed, so there is nothing to re-check -- kb_query must not even be called');
    });

    test('returns [] rather than reading the wrong KB when no maintainer is resolved', async () => {
        const { calls, memberCall } = makeCallTool(CONFIRMED_ENTRIES);
        const noSelection = createKbWorkClient({ memberCall, sprintChangedFiles: async () => ['server/transit.js'], log: () => {} });
        assert.deepEqual(await noSelection.demotionCandidates(REVIEWER), []);
        const client = createKbWorkClient({ memberCall, maintainers: withMaintainer(), listTools: newSchemaListTools, sprintChangedFiles: async () => ['server/transit.js'], log: () => {} });
        assert.deepEqual(await client.demotionCandidates(null), []);
        assert.equal(calls.length, 0, 'a kb_* read with no maintainer would read some other KB');
    });

    test('no sprintChangedFiles wired yields [] and never calls kb_query', async () => {
        const { calls, memberCall } = makeCallTool(CONFIRMED_ENTRIES);
        const client = createKbWorkClient({ memberCall, maintainers: withMaintainer(), listTools: newSchemaListTools, log: () => {} });

        assert.deepEqual(await client.demotionCandidates(REVIEWER), []);
        assert.equal(calls.length, 0);
    });

    test('a sprint diff that could not be computed degrades to [] and never throws into the review dispatch', async () => {
        const { memberCall } = makeCallTool(CONFIRMED_ENTRIES);
        const client = createKbWorkClient({
            memberCall,
            maintainers: withMaintainer(), listTools: newSchemaListTools,
            sprintChangedFiles: async () => { throw new Error('git unreachable'); },
            log: () => {},
        });

        await assert.doesNotReject(() => client.demotionCandidates(REVIEWER));
        assert.deepEqual(await client.demotionCandidates(REVIEWER), []);
    });

    test('a cold or broken kb_query yields [] and never throws', async () => {
        const { memberCall } = makeCallTool([], { throwOnList: true });
        const client = createKbWorkClient({
            memberCall, maintainers: withMaintainer(), listTools: newSchemaListTools, sprintChangedFiles: async () => ['server/transit.js'], log: () => {},
        });

        assert.deepEqual(await client.demotionCandidates(REVIEWER), []);
    });

    test('a kb_query tool-level rejection yields []', async () => {
        const { memberCall } = makeCallTool([], { rejectOnList: true });
        const client = createKbWorkClient({
            memberCall, maintainers: withMaintainer(), listTools: newSchemaListTools, sprintChangedFiles: async () => ['server/transit.js'], log: () => {},
        });

        assert.deepEqual(await client.demotionCandidates(REVIEWER), []);
    });

    test('inactive client (no memberCall) yields []', async () => {
        const client = createKbWorkClient({ sprintChangedFiles: async () => ['server/transit.js'], log: () => {} });
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
            maintainers: withMaintainer(), listTools: newSchemaListTools,
            sprintChangedFiles: async () => changedByRound[round],
            log: () => {},
        });

        const first = await client.demotionCandidates(REVIEWER);
        assert.deepEqual(first.map((c) => c.id), ['kb-aaa'], 'round 1 should offer the entry touching this round\'s files');

        round = 1;
        const second = await client.demotionCandidates(REVIEWER);
        assert.deepEqual(second, [], 'a failing round-2 read must not fall back to round 1\'s offered set');
    });

    test('a maintainer not on the sprint branch skips the sprint-diff read entirely and offers nothing', async () => {
        const { memberCall } = makeCallTool(CONFIRMED_ENTRIES);
        let sprintChangedFilesCalls = 0;
        const client = createKbWorkClient({
            memberCall,
            maintainers: withMaintainer(), listTools: newSchemaListTools,
            sprintChangedFiles: async () => { sprintChangedFilesCalls += 1; return ['server/transit.js']; },
            checkedOutBranch: async () => ({ branch: 'main', sprintBranch: 'feat/thing' }),
            log: () => {},
        });

        const candidates = await client.demotionCandidates(REVIEWER);

        assert.deepEqual(candidates, []);
        assert.equal(sprintChangedFilesCalls, 0, 'the sprint diff must never be computed on a maintainer checked out on the wrong branch');
    });
});

// =============================================================================
// FINAL REVIEW ONLY, WIDENED, FEATURE-DETECTED. A round review is offered no
// demotion candidates; the final review is offered every CONFIRMED entry
// citing a file the sprint changed (not only the maintainer's own), capped;
// and a maintainer whose kb_bible_commit cannot carry a withdrawal is offered
// nothing, with a WARN naming it and the upgrade.
// =============================================================================
describe('createKbWorkClient.demotionCandidates: final review only, widened, feature-detected', () => {
    const OTHERS = [
        // In the branch's bible, captured by some OTHER member: no maintainer tag.
        { id: 'kb-other', type: 'knowledge', confidence: 'CONFIRMED', title: 'captured elsewhere', summary: 'x', source_files: ['server/transit.js'], tags: [] },
    ];
    const OWN = [
        { id: 'kb-own', type: 'knowledge', confidence: 'CONFIRMED', title: 'promoted this sprint', summary: 'x', source_files: ['server/transit.js'], tags: [`member:${MAINTAINER.id}`] },
    ];
    /** A kb_query fake that answers the bible-view read and the own-scope read differently. */
    const splitReads = (bible, own) => {
        const calls = [];
        return {
            calls,
            memberCall: async (member, name, args) => {
                calls.push({ name, args, member });
                if (name !== 'kb_query') return {};
                const rows = args.own_scope ? own : bible;
                return { content: [{ type: 'text', text: JSON.stringify({ l1_results: rows.slice(0, args.limit) }) }] };
            },
        };
    };

    test("a round review ('round' scope) is offered nothing and never reaches the KB or git", async () => {
        const { calls, memberCall } = splitReads(OTHERS, OWN);
        let diffs = 0;
        const logs = [];
        const client = createKbWorkClient({
            memberCall, maintainers: withMaintainer(), listTools: newSchemaListTools,
            sprintChangedFiles: async () => { diffs += 1; return ['server/transit.js']; },
            log: (l) => logs.push(l),
        });

        assert.deepEqual(await client.demotionCandidates(REVIEWER, { scope: 'round' }), []);
        assert.equal(calls.length, 0, 'a round review must not read demotion candidates');
        assert.equal(diffs, 0);
        assert.ok(logs.some((l) => /only the final review/.test(l)), logs.join('\n'));
    });

    test('the final review is offered entries beyond the maintainer\'s own: bible entries from any member plus its own unpublished ones', async () => {
        const { memberCall } = splitReads(OTHERS, OWN);
        const client = createKbWorkClient({
            memberCall, maintainers: withMaintainer(), listTools: newSchemaListTools,
            sprintChangedFiles: async () => ['server/transit.js'], log: () => {},
        });

        const offered = await client.demotionCandidates(REVIEWER, { scope: 'sprint' });

        assert.deepEqual(offered.map((e) => e.id), ['kb-other', 'kb-own'],
            'an entry captured by another member (no maintainer tag) must be offered -- the old owner-scoped read never could');
    });

    test('scope defaults to the final review\'s sprint scope', async () => {
        const { memberCall } = splitReads(OTHERS, []);
        const client = createKbWorkClient({
            memberCall, maintainers: withMaintainer(), listTools: newSchemaListTools,
            sprintChangedFiles: async () => ['server/transit.js'], log: () => {},
        });
        assert.deepEqual((await client.demotionCandidates(REVIEWER)).map((e) => e.id), ['kb-other']);
    });

    test('an entry in both reads is offered once (the bible copy wins)', async () => {
        const bibleCopy = { ...OWN[0], title: 'bible copy' };
        const { memberCall } = splitReads([bibleCopy], OWN);
        const client = createKbWorkClient({
            memberCall, maintainers: withMaintainer(), listTools: newSchemaListTools,
            sprintChangedFiles: async () => ['server/transit.js'], log: () => {},
        });
        const offered = await client.demotionCandidates(REVIEWER);
        assert.deepEqual(offered.map((e) => [e.id, e.title]), [['kb-own', 'bible copy']]);
    });

    test('the widened offer is still capped at KB_MAX_DEMOTION_CANDIDATES across both reads', async () => {
        const mk = (prefix, n) => Array.from({ length: n }, (_, i) => ({
            id: `${prefix}-${i}`, type: 'knowledge', confidence: 'CONFIRMED', title: `${prefix} ${i}`, summary: 'x', source_files: ['server/transit.js'],
        }));
        const { memberCall } = splitReads(mk('bible', 15), mk('own', 15));
        const client = createKbWorkClient({
            memberCall, maintainers: withMaintainer(), listTools: newSchemaListTools,
            sprintChangedFiles: async () => ['server/transit.js'], log: () => {},
        });
        const offered = await client.demotionCandidates(REVIEWER);
        assert.equal(offered.length, KB_MAX_DEMOTION_CANDIDATES);
        assert.equal(offered.filter((e) => e.id.startsWith('bible-')).length, 15, 'the bible read comes first');
    });

    test('an own-scope read the KB refuses (e.g. a KB server without that route) still offers the bible entries', async () => {
        const logs = [];
        const client = createKbWorkClient({
            memberCall: async (member, name, args) => {
                if (name !== 'kb_query') return {};
                if (args.own_scope) return { isError: true, content: [{ type: 'text', text: 'E-KB-HTTP-UNSUPPORTED: own_scope' }] };
                return { content: [{ type: 'text', text: JSON.stringify({ l1_results: OTHERS }) }] };
            },
            maintainers: withMaintainer(), listTools: newSchemaListTools,
            sprintChangedFiles: async () => ['server/transit.js'], log: (l) => logs.push(l),
        });
        assert.deepEqual((await client.demotionCandidates(REVIEWER)).map((e) => e.id), ['kb-other']);
        assert.ok(logs.some((l) => /own demotion candidates rejected/.test(l)), logs.join('\n'));
    });

    // Withdrawal feature detection: kb_capabilities on the maintainer's own
    // session. The old detection (sniffing kb_bible_commit's schema for
    // withdrawals / restore_ids) is gone: oldSchemaListTools advertises both
    // and is still refused, newSchemaListTools advertises neither and is
    // still accepted.
    const warnFor = (logs) => logs.find((l) => l.includes('WARN') && l.includes(`'${MAINTAINER.name}'`));

    test('a maintainer whose server does not offer kb_capabilities (older fleet server) is offered nothing, with a WARN naming it and what is missing', async () => {
        const { calls, memberCall } = splitReads(OTHERS, OWN);
        const logs = [];
        let diffs = 0;
        let capabilityCalls = 0;
        const client = createKbWorkClient({
            memberCall, maintainers: withMaintainer(), listTools: oldSchemaListTools,
            capabilities: async () => { capabilityCalls += 1; return { content: [{ type: 'text', text: JSON.stringify({ routes: ['withdraw'] }) }] }; },
            sprintChangedFiles: async () => { diffs += 1; return ['server/transit.js']; },
            log: (l) => logs.push(l),
        });

        assert.deepEqual(await client.demotionCandidates(REVIEWER), []);
        assert.equal(calls.filter((c) => c.name === 'kb_query').length, 0, 'no KB read for a maintainer that cannot record a withdrawal');
        assert.equal(diffs, 0, 'no git traffic either');
        assert.equal(capabilityCalls, 0, 'a tool the session does not list is never called');
        assert.ok(!calls.some((c) => c.name === 'kb_demote'), 'never a fallback to kb_demote');
        const warn = warnFor(logs);
        assert.ok(warn, logs.join('\n'));
        assert.match(warn, /kb_capabilities/);
        assert.match(warn, /upgrade/);
        assert.match(warn, /no demotion candidates/);
    });

    test('an http KB server whose kb_capabilities routes lack withdraw is offered nothing, with a WARN naming the maintainer and the route', async () => {
        const { calls, memberCall } = splitReads(OTHERS, OWN);
        const logs = [];
        const client = createKbWorkClient({
            // A current fleet server (kb_capabilities, and a kb_bible_commit
            // that takes withdrawals) in front of an http KB server that
            // serves demote but not the optional withdraw route.
            listTools: async () => ({ tools: [{ name: 'kb_capabilities', inputSchema: { properties: {} } }, ...(await oldSchemaListTools()).tools] }),
            memberCall, maintainers: withMaintainer(),
            capabilityRoutes: ['capture', 'query', 'promote', 'list', 'demote'],
            sprintChangedFiles: async () => ['server/transit.js'], log: (l) => logs.push(l),
        });

        assert.deepEqual(await client.demotionCandidates(REVIEWER), []);
        assert.equal(calls.filter((c) => c.name === 'kb_query').length, 0);
        assert.ok(!calls.some((c) => c.name === 'kb_demote'), 'never a fallback to kb_demote');
        const warn = warnFor(logs);
        assert.ok(warn, logs.join('\n'));
        assert.match(warn, /'withdraw'/);
        assert.match(warn, /demote/, 'the WARN lists the routes the server does serve');
    });

    test('an http KB server whose routes include withdraw is offered candidates', async () => {
        const { memberCall } = splitReads(OTHERS, []);
        const logs = [];
        const client = createKbWorkClient({
            memberCall, maintainers: withMaintainer(), listTools: newSchemaListTools,
            capabilityRoutes: ['capture', 'query', 'promote', 'withdraw'],
            sprintChangedFiles: async () => ['server/transit.js'], log: (l) => logs.push(l),
        });
        assert.deepEqual((await client.demotionCandidates(REVIEWER)).map((e) => e.id), ['kb-other']);
        assert.equal(warnFor(logs), undefined, logs.join('\n'));
    });

    test('a SQLite KB (kb_capabilities reports every route) is offered candidates, and kb_capabilities is called on the maintainer', async () => {
        const { memberCall } = splitReads(OTHERS, []);
        const capCalls = [];
        const client = createKbWorkClient({
            memberCall, maintainers: withMaintainer(), listTools: newSchemaListTools,
            capabilities: async (member) => { capCalls.push(member); return { content: [{ type: 'text', text: JSON.stringify({ contract: 'v1', routes: [...ALL_KB_ROUTES], branch_aware: false, query_filters: ['files', 'symbols'] }) }] }; },
            sprintChangedFiles: async () => ['server/transit.js'], log: () => {},
        });
        assert.deepEqual((await client.demotionCandidates(REVIEWER)).map((e) => e.id), ['kb-other']);
        assert.deepEqual(capCalls.map((m) => m.name), [MAINTAINER.name], 'kb_capabilities is read on the maintainer, never the reviewer');
    });

    test('the kb_capabilities answer is logged once per maintainer and repository (routes and contract), not once per offering', async () => {
        for (const [routes, offered] of [[[...ALL_KB_ROUTES], ['kb-other']], [['capture', 'query', 'demote'], []]]) {
            const { memberCall } = splitReads(OTHERS, []);
            const logs = [];
            const client = createKbWorkClient({
                memberCall, maintainers: withMaintainer(), listTools: newSchemaListTools,
                capabilities: async () => ({ content: [{ type: 'text', text: JSON.stringify({ contract: 'v1', routes }) }] }),
                sprintChangedFiles: async () => ['server/transit.js'], log: (l) => logs.push(l),
            });
            assert.deepEqual((await client.demotionCandidates(REVIEWER)).map((e) => e.id), offered);
            assert.deepEqual((await client.demotionCandidates(REVIEWER)).map((e) => e.id), offered);
            const lines = logs.filter((l) => /kb_capabilities on /.test(l));
            assert.deepEqual(lines, [
                `[kb-work] kb_capabilities on '${MAINTAINER.name}' (example.com/warehouse): routes=[${routes.join(', ')}], contract=v1`,
            ], logs.join('\n'));
        }
    });

    test('a failing, rejected or unreadable kb_capabilities answer fails closed with a WARN and is retried at the next offering', async () => {
        const answers = [
            async () => { throw new Error('unreachable'); },
            async () => ({ isError: true, content: [{ type: 'text', text: 'E-KB-HTTP-UNREACHABLE: 503' }] }),
            async () => ({ content: [{ type: 'text', text: 'not json' }] }),
            async () => ({ content: [{ type: 'text', text: JSON.stringify({ contract: 'v1' }) }] }),
        ];
        for (const answer of answers) {
            const { memberCall } = splitReads(OTHERS, []);
            const logs = [];
            let calls = 0;
            let ok = false;
            const client = createKbWorkClient({
                memberCall, maintainers: withMaintainer(), listTools: newSchemaListTools,
                capabilities: async (m) => { calls += 1; return ok ? { content: [{ type: 'text', text: JSON.stringify({ routes: ['withdraw'] }) }] } : answer(m); },
                sprintChangedFiles: async () => ['server/transit.js'], log: (l) => logs.push(l),
            });
            assert.deepEqual(await client.demotionCandidates(REVIEWER), []);
            assert.ok(warnFor(logs), logs.join('\n'));
            ok = true;
            assert.deepEqual((await client.demotionCandidates(REVIEWER)).map((e) => e.id), ['kb-other'], 'a failure is not cached');
            assert.equal(calls, 2);
        }
    });

    test('a tools/list that throws, or answers unreadably, once is not cached: the next offering offers candidates', async () => {
        const failures = [
            async () => { throw new Error('session dropped'); },
            async () => 'not json',
            async () => ({ content: [{ type: 'text', text: 'not json' }] }),
        ];
        for (const failure of failures) {
            const { memberCall } = splitReads(OTHERS, []);
            const logs = [];
            let lists = 0;
            const client = createKbWorkClient({
                memberCall, maintainers: withMaintainer(),
                listTools: async (...a) => { lists += 1; return lists === 1 ? failure(...a) : newSchemaListTools(...a); },
                sprintChangedFiles: async () => ['server/transit.js'], log: (l) => logs.push(l),
            });
            assert.deepEqual(await client.demotionCandidates(REVIEWER), [], 'the failed listing offers nothing');
            assert.ok(warnFor(logs), logs.join('\n'));
            assert.deepEqual((await client.demotionCandidates(REVIEWER)).map((e) => e.id), ['kb-other'], 'a tools/list failure is not cached');
            assert.equal(lists, 2);
        }
    });

    test('the support answer is cached per member AND repository: a gap for one repository does not hide another', async () => {
        const OTHER_REVIEWER = { id: 'id-shop-reviewer', name: 'shop-reviewer', type: 'local' };
        const { memberCall } = splitReads(OTHERS, []);
        const logs = [];
        let caps = 0;
        const client = createKbWorkClient({
            memberCall,
            maintainers: fakeMaintainerSelector({
                repoOf: { [REVIEWER.name]: 'example.com/warehouse', [OTHER_REVIEWER.name]: 'example.com/shop', [MAINTAINER.name]: 'example.com/warehouse' },
                maintainerOf: { 'example.com/warehouse': MAINTAINER, 'example.com/shop': MAINTAINER },
            }),
            listTools: newSchemaListTools,
            // The first repository's KB server lacks the withdraw route; the second serves it.
            capabilities: async () => {
                caps += 1;
                return { content: [{ type: 'text', text: JSON.stringify({ contract: 'v1', routes: caps === 1 ? ['capture', 'query'] : [...ALL_KB_ROUTES] }) }] };
            },
            sprintChangedFiles: async () => ['server/transit.js'], log: (l) => logs.push(l),
        });
        assert.deepEqual(await client.demotionCandidates(REVIEWER), [], 'the first repository has no withdraw route');
        assert.deepEqual((await client.demotionCandidates(OTHER_REVIEWER)).map((e) => e.id), ['kb-other'],
            'the second repository is checked on its own, not answered from the first one\'s cached gap');
        assert.equal(caps, 2);
        assert.deepEqual(await client.demotionCandidates(REVIEWER), [], 'a definite answer is still cached for its own repository');
        assert.equal(caps, 2);
    });

    test('a maintainer with no listTools wired, or a failing one, is treated as old (fail closed)', async () => {
        for (const listTools of [undefined, async () => { throw new Error('unreachable'); }, async () => 'not json']) {
            const { memberCall } = splitReads(OTHERS, OWN);
            const logs = [];
            const client = createKbWorkClient({
                memberCall, maintainers: withMaintainer(), listTools,
                sprintChangedFiles: async () => ['server/transit.js'], log: (l) => logs.push(l),
            });
            assert.deepEqual(await client.demotionCandidates(REVIEWER), []);
            assert.ok(warnFor(logs), logs.join('\n'));
        }
    });

    // A local member is served by the separately running local apra-fleet
    // server, which can be an older build than the engine: it is feature
    // detected through its own session exactly like a remote one.
    const localMaintainerClient = (listTools, logs = [], extra = {}) => {
        const local = { ...MAINTAINER, type: 'local' };
        const { calls, memberCall } = splitReads(OTHERS, []);
        const client = createKbWorkClient({
            memberCall,
            maintainers: fakeMaintainerSelector({
                repoOf: { [REVIEWER.name]: 'example.com/warehouse', [local.name]: 'example.com/warehouse' },
                maintainerOf: { 'example.com/warehouse': local },
            }),
            listTools,
            sprintChangedFiles: async () => ['server/transit.js'], log: (l) => logs.push(l),
            ...extra,
        });
        return { client, calls };
    };

    test('a LOCAL maintainer whose server offers kb_capabilities with withdraw is offered candidates (read from its own session)', async () => {
        let lists = 0;
        const { client } = localMaintainerClient(async (...a) => { lists += 1; return newSchemaListTools(...a); });
        assert.deepEqual((await client.demotionCandidates(REVIEWER)).map((e) => e.id), ['kb-other']);
        assert.equal(lists, 1, 'a local member is feature-detected too');
    });

    test('a LOCAL maintainer whose running server predates kb_capabilities is offered nothing, with a WARN naming it', async () => {
        const logs = [];
        const { client, calls } = localMaintainerClient(oldSchemaListTools, logs);
        assert.deepEqual(await client.demotionCandidates(REVIEWER), []);
        assert.equal(calls.filter((c) => c.name === 'kb_query').length, 0);
        const warn = warnFor(logs);
        assert.ok(warn, logs.join('\n'));
        assert.match(warn, /kb_capabilities/);
        assert.match(warn, /upgrade/);
    });

    test('the capabilities answer is read once per maintainer and cached', async () => {
        let lists = 0;
        let caps = 0;
        const { memberCall } = splitReads(OTHERS, []);
        const client = createKbWorkClient({
            memberCall, maintainers: withMaintainer(),
            listTools: async (...a) => { lists += 1; return newSchemaListTools(...a); },
            capabilities: async () => { caps += 1; return { content: [{ type: 'text', text: JSON.stringify({ routes: ['withdraw'] }) }] }; },
            sprintChangedFiles: async () => ['server/transit.js'], log: () => {},
        });
        await client.demotionCandidates(REVIEWER);
        await client.demotionCandidates(REVIEWER);
        assert.equal(lists, 1);
        assert.equal(caps, 1);
    });

    test("no sprintChangedFiles wired yields [] and never calls kb_query", async () => {
        const { calls, memberCall } = makeCallTool(CONFIRMED_ENTRIES);
        const client = createKbWorkClient({ memberCall, maintainers: withMaintainer(), listTools: newSchemaListTools, log: () => {} });

        assert.deepEqual(await client.demotionCandidates(REVIEWER, { scope: 'sprint' }), []);
        assert.equal(calls.length, 0);
    });

    test('an unknown scope offers nothing rather than silently falling back to some diff', async () => {
        const { calls, memberCall } = makeCallTool(CONFIRMED_ENTRIES);
        const client = createKbWorkClient({
            memberCall, maintainers: withMaintainer(), listTools: newSchemaListTools,
            sprintChangedFiles: async () => ['server/transit.js'], log: () => {},
        });

        assert.deepEqual(await client.demotionCandidates(REVIEWER, { scope: 'cumulative' }), []);
        assert.equal(calls.length, 0, 'an unrecognized scope must not reach the KB at all');
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

    test('the bible read is file-filtered, untagged, CONFIRMED, stale-and-dispute inclusive, and wide', () => {
        assert.deepEqual(buildBibleDemotionCandidateQuery(['a.js', 'b.js']), {
            files: ['a.js', 'b.js'],
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

    test('is STATELESS -- it returns the same full range on every call', async () => {
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

describe('vetKbWork: kb_demotions', () => {
    const REASON = 'checked the same cited test this review and it now fails';
    const EVIDENCE = ['test/foo.test.ts'];

    test('kb_demotions is reviewer-only: a non-reviewer role is refused wholesale and nothing is executed', () => {
        const result = vetKbWork('doer', { kb_demotions: [{ id: 'kb-aaa', reason: REASON, evidence_files: EVIDENCE }] });
        assert.deepEqual(result.demotions, []);
        assert.ok(result.refused.some((r) => r === 'doer: kb_demotions refused -- demotion is reviewer-only'));
    });

    test('a demotion with a missing id is refused; the rest of the list is still processed', () => {
        const result = vetKbWork('reviewer', { kb_demotions: [{ reason: REASON, evidence_files: EVIDENCE }, { id: 'kb-bbb', reason: REASON, evidence_files: EVIDENCE }] });
        assert.deepEqual(result.demotions.map((d) => d.id), ['kb-bbb']);
        assert.ok(result.refused.some((r) => r === 'reviewer: demotion missing id'));
    });

    test('a 19-character reason is refused; a 20-character reason is accepted', () => {
        const short = vetKbWork('reviewer', { kb_demotions: [{ id: 'kb-aaa', reason: 'x'.repeat(19), evidence_files: EVIDENCE }] });
        assert.deepEqual(short.demotions, []);
        assert.ok(short.refused.some((r) => r === 'reviewer: demotion kb-aaa has no recorded evidence'));

        const exact = vetKbWork('reviewer', { kb_demotions: [{ id: 'kb-aaa', reason: 'x'.repeat(KB_MIN_PROMOTE_REASON), evidence_files: EVIDENCE }] });
        assert.deepEqual(exact.demotions.map((d) => d.id), ['kb-aaa']);
    });

    test('evidence_files is carried through, and a demotion with none is refused', () => {
        const withEvidence = vetKbWork('reviewer', { kb_demotions: [{ id: 'kb-aaa', reason: REASON, evidence_files: EVIDENCE }] });
        assert.deepEqual(withEvidence.demotions[0].evidence_files, EVIDENCE);

        for (const evidence of [undefined, [], [''], [42]]) {
            const item = { id: 'kb-bbb', reason: REASON };
            if (evidence !== undefined) item.evidence_files = evidence;
            const result = vetKbWork('reviewer', { kb_demotions: [item] });
            assert.deepEqual(result.demotions, [], JSON.stringify(evidence));
            assert.ok(result.refused.includes('reviewer: demotion kb-bbb names no evidence file'), JSON.stringify(result.refused));
        }
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
            kb_demotions: [{ id: 'kb-x', reason: REASON, evidence_files: EVIDENCE }],
        });
        assert.deepEqual(result.promotions, []);
        assert.deepEqual(result.demotions, []);
        assert.ok(result.refused.includes(`reviewer: promotion kb-x refused -- the same output also demotes it (promote reason: ${REASON})`));
        assert.ok(result.refused.includes(`reviewer: demotion kb-x refused -- the same output also promotes it (demote reason: ${REASON})`));
    });

    test('three-way collision guard: an id in kb_discards and kb_demotions is refused in both', () => {
        const result = vetKbWork('reviewer', {
            kb_discards: [{ id: 'kb-y', reason: REASON }],
            kb_demotions: [{ id: 'kb-y', reason: REASON, evidence_files: EVIDENCE }],
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
            kb_demotions: [{ id: 'kb-z', reason: REASON, evidence_files: EVIDENCE }],
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
            kb_demotions: [{ id: 'kb-shared', reason: REASON, evidence_files: EVIDENCE }],
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

describe('demotion candidates reach the FINAL verdict prompt only', () => {
    const BASE = {
        beadIds: ['BD-1'],
        acceptanceCriteriaJson: '[]',
        baseBranch: 'main', mergeBaseSha: 'abcdef0123456789abcdef0123456789abcdef01',
        branch: 'feat/thing',
        goal: 'P1',
    };

    test('the round reviewer prompt carries no demotion block, even if a caller passed candidates', () => {
        const prompt = buildReviewerPrompt({ ...BASE, kbDemoteCandidates: CONFIRMED_ENTRIES });

        for (const e of CONFIRMED_ENTRIES) {
            assert.ok(!prompt.includes(e.id), `demotion candidate ${e.id} reached a ROUND reviewer prompt`);
        }
        assert.ok(!/kb_demotions/.test(prompt), 'a round reviewer prompt must not ask for kb_demotions');
    });

    test('the final verdict prompt carries each demotion candidate id', () => {
        const prompt = buildFinalVerdictPrompt({
            targetIssues: ['BD-1'], branch: 'feat/thing', baseBranch: 'main', mergeBaseSha: BASE.mergeBaseSha, goal: 'P1',
            cyclesRun: 1, closedCount: 1, openAtGoalCount: 0, deployFailures: [], integFailures: [],
            kbDemoteCandidates: CONFIRMED_ENTRIES,
        });
        for (const e of CONFIRMED_ENTRIES) assert.ok(prompt.includes(e.id), `demotion candidate ${e.id} missing from the final verdict prompt`);
        assert.match(prompt, /kb_demotions/);
    });
});

// =============================================================================
// A RELAUNCH can restore an earlier withdrawal: entries an earlier final
// review on this branch withdrew are read from the committed bibles
// (createBranchWithdrawnEntries) and offered FIRST, regardless of the changed
// files, marked withdrawn_on_branch -- the checkout bible view no longer
// holds them, so the widened read alone could never offer one.
// =============================================================================
describe('createBranchWithdrawnEntries (this branch\'s earlier withdrawals)', () => {
    const BIBLE = '.fleet/kb-canonical.json';
    const tomb = (id, extra = {}) => ({ id, at: '2026-11-17T00:00:00.000Z', reason: 'withdrawn', note: `note ${id}`, evidence_files: ['src/x.js'], ...extra });
    const fakeCommand = (byCmd) => {
        const calls = [];
        const command = async (cmd, opts) => {
            calls.push({ cmd, opts });
            const v = byCmd[cmd];
            return v === undefined ? { ok: false, output: 'fatal: path does not exist' } : { ok: true, output: JSON.stringify(v) };
        };
        return { calls, command };
    };

    test('returns a branch-added withdrawn tombstone as a CONFIRMED candidate built from the base bible entry', async () => {
        const { calls, command } = fakeCommand({
            [`git show HEAD:${BIBLE}`]: { entries: [], demotions: [tomb('kb-mine'), tomb('kb-merged'), { id: 'kb-dem', reason: 'demoted', at: 'x' }] },
            [`git show origin/main:${BIBLE}`]: {
                entries: [{ id: 'kb-mine', type: 'learning', title: 'base title', summary: 'base summary', source_files: ['src/a.js'] }],
                demotions: [tomb('kb-merged')],
            },
        });
        const read = createBranchWithdrawnEntries({ command, baseBranch: 'main', log: () => {} });

        const rows = await read('maint-1');

        assert.deepEqual(rows, [{
            id: 'kb-mine', type: 'learning', confidence: 'CONFIRMED', title: 'base title', summary: 'base summary', source_files: ['src/a.js'],
        }], 'a tombstone merged from the base, or a demoted one, is not this branch\'s to restore');
        for (const c of calls) {
            assert.equal(c.opts.member_name, 'maint-1');
            assert.equal(c.opts.failSoft, true);
        }
    });

    test('a tombstone whose entry the base bible lacks is built from the tombstone itself', async () => {
        const { command } = fakeCommand({ [`git show HEAD:${BIBLE}`]: { entries: [], demotions: [tomb('kb-new')] } });
        const rows = await createBranchWithdrawnEntries({ command, baseBranch: 'main' })('m');
        assert.deepEqual(rows, [{ id: 'kb-new', type: 'knowledge', confidence: 'CONFIRMED', title: 'withdrawn entry kb-new', summary: 'note kb-new', source_files: ['src/x.js'] }]);
    });

    test('no bible on the branch, an unparseable one, or no withdrawn tombstone: nothing, and the base is never read', async () => {
        for (const head of [undefined, 'not json', { entries: [] }]) {
            const calls = [];
            const command = async (cmd) => {
                calls.push(cmd);
                if (head === undefined) return { ok: false, output: '' };
                return { ok: true, output: typeof head === 'string' ? head : JSON.stringify(head) };
            };
            assert.deepEqual(await createBranchWithdrawnEntries({ command, baseBranch: 'main' })('m'), []);
            assert.equal(calls.length, 1, 'the base bible is read only when the branch carries a withdrawal');
        }
    });

    // .read is the PR body's read: "nothing carried" and "could not read" must differ.
    test('.read: rows carry the base title and the tombstone note; no bible on the branch is ok with no rows', async () => {
        const { command } = fakeCommand({
            [`git show HEAD:${BIBLE}`]: { entries: [], demotions: [tomb('kb-mine'), tomb('kb-orphan')] },
            [`git show origin/main:${BIBLE}`]: { entries: [{ id: 'kb-mine', title: 'base title', summary: 's', source_files: [] }] },
        });
        const res = await createBranchWithdrawnEntries({ command, baseBranch: 'main' }).read('m');
        assert.equal(res.ok, true);
        assert.deepEqual(res.rows.map((r) => [r.id, r.base_title, r.tombstone_note]), [['kb-mine', 'base title', 'note kb-mine'], ['kb-orphan', '', 'note kb-orphan']]);

        const calls = [];
        const noBible = async (cmd) => {
            calls.push(cmd);
            if (cmd.startsWith('git ls-tree --name-only HEAD -- ')) return { ok: true, output: '\n' };
            return { ok: false, output: `fatal: path '${BIBLE}' does not exist in 'HEAD'` };
        };
        assert.deepEqual(await createBranchWithdrawnEntries({ command: noBible, baseBranch: 'main' }).read('m'), { ok: true, rows: [] });
        assert.deepEqual(calls, [`git show HEAD:${BIBLE}`, `git ls-tree --name-only HEAD -- ${BIBLE}`]);
    });

    test('.read: a failed or unparseable HEAD read of a bible that exists (or an unanswerable ls-tree) is ok:false naming the command', async () => {
        const cases = [
            { show: { ok: false, output: 'ssh: connection reset' }, ls: { ok: true, output: `${BIBLE}\n` } },
            { show: { ok: true, output: 'not json' }, ls: { ok: true, output: `${BIBLE}\n` } },
            { show: { ok: false, output: 'ssh: connection reset' }, ls: { ok: false, output: 'ssh: connection reset' } },
        ];
        for (const c of cases) {
            const command = async (cmd) => (cmd.startsWith('git ls-tree') ? c.ls : c.show);
            const res = await createBranchWithdrawnEntries({ command, baseBranch: 'main' }).read('maint-1');
            assert.equal(res.ok, false, JSON.stringify(c));
            assert.deepEqual(res.rows, []);
            assert.ok(res.error.includes(`'git show HEAD:${BIBLE}' on 'maint-1'`), res.error);
        }
    });
});

describe('demotionCandidates: this branch\'s earlier withdrawals are offered first', () => {
    const withdrawnRow = { id: 'kb-earlier', type: 'knowledge', confidence: 'CONFIRMED', title: 'withdrawn before', summary: 's', source_files: ['elsewhere.js'] };

    test('offered first, marked withdrawn_on_branch, even though it cites no changed file', async () => {
        const { memberCall } = makeCallTool(CONFIRMED_ENTRIES);
        const client = createKbWorkClient({
            memberCall, maintainers: withMaintainer(), listTools: newSchemaListTools,
            sprintChangedFiles: async () => ['server/transit.js'],
            branchWithdrawals: async () => [withdrawnRow],
            log: () => {},
        });

        const offered = await client.demotionCandidates(REVIEWER);

        assert.deepEqual(offered.map((e) => e.id), ['kb-earlier', 'kb-aaa']);
        assert.equal(offered[0].withdrawn_on_branch, true);
        const block = kbDemotionBlock(offered).join('\n');
        assert.match(block, /"withdrawn_on_this_branch": true/);
        assert.match(block, /holding it restores it/);
    });

    test('a failing branch read degrades to the plain offer', async () => {
        const { memberCall } = makeCallTool(CONFIRMED_ENTRIES);
        const logs = [];
        const client = createKbWorkClient({
            memberCall, maintainers: withMaintainer(), listTools: newSchemaListTools,
            sprintChangedFiles: async () => ['server/transit.js'],
            branchWithdrawals: async () => { throw new Error('git unreachable'); },
            log: (l) => logs.push(l),
        });
        assert.deepEqual((await client.demotionCandidates(REVIEWER)).map((e) => e.id), ['kb-aaa']);
        assert.ok(logs.some((l) => /earlier withdrawals/.test(l)), logs.join('\n'));
    });

    test('an earlier withdrawal is offered even when the sprint changed no file the KB cites', async () => {
        const { calls, memberCall } = makeCallTool(CONFIRMED_ENTRIES);
        const client = createKbWorkClient({
            memberCall, maintainers: withMaintainer(), listTools: newSchemaListTools,
            sprintChangedFiles: async () => [],
            branchWithdrawals: async () => [withdrawnRow],
            log: () => {},
        });
        assert.deepEqual((await client.demotionCandidates(REVIEWER)).map((e) => e.id), ['kb-earlier']);
        assert.equal(calls.filter((c) => c.name === 'kb_query').length, 0, 'no changed files: no KB read');
    });
});
