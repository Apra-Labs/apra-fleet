import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createKbWorkClient } from '../fleet-sprint/kb.mjs';
import { selfMaintainer } from './helpers/kb-maintainer-fakes.mjs';

// =============================================================================
// apply()'s demotion-execution lane: a kb_demotions id offered by
// demotionCandidates() is routed to memberCall(maintainer, 'kb_demote',
// {id, reason, evidence_files?}), filtered against demotionCandidates' OWN
// offered set (never the promotion one), and a successful demotion is
// remembered so the next bible commit carries it as demoted_ids in the SAME
// kb_bible_commit call as that round's confirmed ids. Also covers the D6
// in-sprint ping-pong guard end to end: a round-1 demotion must not come
// back as a round-2 promotion candidate while its basis is unchanged.
//
// Follows the patterns in kb-bible-commit-round.test.mjs (the harness/confirm
// shape), kb-write-routing.test.mjs (the recording harness) and
// kb-demotion-candidates.test.mjs (the own_scope kb_query fake).
// =============================================================================

const MAINT = { id: 'id-maint', name: 'maint', type: 'local' };
const REASON = 'verified against the merged code in this round';
const BASE = { baseBranch: 'main', baseCommit: 'a'.repeat(40) };
const CHANGED_FILE = 'src/thing.js';

// Entries served by the fake kb_query: INFERRED rows for promotionCandidates()
// (no own_scope), CONFIRMED rows for demotionCandidates() (own_scope: true).
let offeredPromotions = [];
let offeredDemotionRows = [];

/**
 * A fake maintainer session.
 *   - `demoteOutcome(id)` returns a tool-error response for one id (letting a
 *     test fail ONE kb_demote call without touching the others), or a
 *     falsy value to let it succeed.
 *   - `skipped` is kb_bible_commit's own skipped list; every other id in
 *     `ids`/`demoted_ids` is reported back as merged/demoted.
 *   - `currentFileHashes` and `sprintStartMs` are passed straight through to
 *     createKbWorkClient for the ping-pong guard tests.
 */
function harness({ demoteOutcome, skipped = [], currentFileHashes = async () => ({}), sprintStartMs } = {}) {
    const events = [];
    const logs = [];
    const memberCall = async (member, tool, args) => {
        if (tool === 'kb_query') {
            return args.own_scope ? { l1_results: offeredDemotionRows } : { l1_results: offeredPromotions };
        }
        events.push({ ev: tool, member: member.name, args });
        if (tool === 'kb_demote') {
            if (typeof demoteOutcome === 'function') {
                const outcome = demoteOutcome(args.id);
                if (outcome) return outcome;
            }
            return {};
        }
        if (tool === 'kb_bible_commit') {
            const isSkipped = (id) => skipped.some((s) => s.id === id);
            const merged = (args.ids || []).filter((id) => !isSkipped(id));
            const demoted = (args.demoted_ids || []).filter((id) => !isSkipped(id));
            return {
                content: [{
                    text: JSON.stringify({
                        path: '.fleet/kb-canonical.json', merged, demoted, skipped,
                        entry_count: merged.length, committed: true,
                    }),
                }],
            };
        }
        return {};
    };
    const client = createKbWorkClient({
        memberCall,
        maintainers: selfMaintainer(MAINT, ['maint', 'reviewer-1']),
        gPull: async () => {},
        gPush: async () => {},
        bibleBase: async () => BASE,
        roundChangedFiles: async () => [CHANGED_FILE],
        currentFileHashes,
        ...(sprintStartMs !== undefined ? { sprintStartMs: () => sprintStartMs } : {}),
        log: (m) => logs.push(m),
    });
    return { client, events, logs };
}

/** A CONFIRMED row demotionCandidates() would offer: eligible and touching CHANGED_FILE. */
const demotable = (id, extra = {}) => ({
    id, type: 'knowledge', confidence: 'CONFIRMED', title: id, summary: id,
    source_files: [CHANGED_FILE], ...extra,
});

/** Populate demotionCandidates()'s offered set with `entries`, then clear the bookkeeping read. */
async function offerDemotions(client, entries) {
    offeredDemotionRows = entries;
    await client.demotionCandidates('reviewer-1');
    offeredDemotionRows = [];
}

/** Populate promotionCandidates()'s offered set with `entries`; returns what it ACTUALLY offered (post-guard). */
async function offerPromotions(client, entries) {
    offeredPromotions = entries;
    const offered = await client.promotionCandidates('reviewer-1');
    offeredPromotions = [];
    return offered;
}

describe('apply(): kb_demotions routed to kb_demote, filtered against demotionCandidates\' own offered set', () => {
    test('an offered id is demoted; an id that was not offered is refused with the SAME message style the promotion path uses', async () => {
        const { client, events, logs } = harness();
        await offerDemotions(client, [demotable('kb-ok')]);

        const out = await client.apply('reviewer', 'reviewer-1', {
            kb_demotions: [
                { id: 'kb-ok', reason: REASON },
                { id: 'kb-not-offered', reason: REASON },
            ],
        });

        assert.equal(out.demoted, 1);
        assert.equal(out.refused, 1);
        assert.deepEqual(events.map((e) => e.ev), ['kb_demote']);
        assert.equal(events[0].args.id, 'kb-ok');
        // Byte-identical to the promotion path's own refusal wording (kb.mjs's
        // apply(): "refused -- ${role}: ${kind} ${x.id} not in this dispatch's
        // candidate block"), with kind='demotion' substituted for 'promotion'.
        assert.ok(
            logs.includes("[kb-work] refused -- reviewer: demotion kb-not-offered not in this dispatch's candidate block"),
            JSON.stringify(logs),
        );
    });

    test('the demotion offered set is never the promotion one: an id offered only for promotion cannot be demoted, and a failed demotion attempt does not disturb its promotion eligibility', async () => {
        const { client, events } = harness();
        const entry = { id: 'kb-x', type: 'knowledge', created_at: new Date().toISOString() };
        await offerPromotions(client, [entry]);

        const demoteAttempt = await client.apply('reviewer', 'reviewer-1', {
            kb_demotions: [{ id: 'kb-x', reason: REASON }],
        });
        assert.equal(demoteAttempt.demoted, 0);
        assert.equal(demoteAttempt.refused, 1);
        assert.deepEqual(events, [], 'no kb_demote call -- kb-x was offered for promotion, never for demotion');

        // The promotion offered set this test populated earlier must be
        // untouched by that refused demotion attempt.
        const promoteAttempt = await client.apply('reviewer', 'reviewer-1', {
            kb_promotions: [{ id: 'kb-x', reason: REASON }],
        });
        assert.equal(promoteAttempt.promoted, 1);
    });
});

describe('a successful demotion reaches memberCall with tool kb_demote on the MAINTAINER session', () => {
    test('evidence_files is carried through when present and omitted when absent', async () => {
        const { client, events } = harness();
        await offerDemotions(client, [demotable('kb-with-evidence'), demotable('kb-no-evidence')]);

        await client.apply('reviewer', 'reviewer-1', {
            kb_demotions: [
                { id: 'kb-with-evidence', reason: REASON, evidence_files: [CHANGED_FILE] },
                { id: 'kb-no-evidence', reason: REASON },
            ],
        });

        const demotes = events.filter((e) => e.ev === 'kb_demote');
        assert.equal(demotes.length, 2);
        assert.equal(demotes[0].member, 'maint', "routed to the maintainer session, not the reviewer's own");
        assert.deepEqual(demotes[0].args, { id: 'kb-with-evidence', reason: REASON, evidence_files: [CHANGED_FILE] });
        assert.deepEqual(demotes[1].args, { id: 'kb-no-evidence', reason: REASON });
        assert.ok(!('evidence_files' in demotes[1].args), 'evidence_files is omitted, never sent as undefined/empty');
    });
});

describe('kb_bible_commit receives demoted_ids in the SAME call as confirmed ids', () => {
    test('a round carrying both a promotion and a demotion produces exactly one kb_bible_commit call', async () => {
        const { client, events } = harness();
        await offerPromotions(client, [{ id: 'kb-promo', type: 'knowledge', created_at: new Date().toISOString() }]);
        await offerDemotions(client, [demotable('kb-demo')]);

        await client.apply('reviewer', 'reviewer-1', {
            kb_promotions: [{ id: 'kb-promo', reason: REASON }],
            kb_demotions: [{ id: 'kb-demo', reason: REASON }],
        });
        const out = await client.commitRound();

        const commits = events.filter((e) => e.ev === 'kb_bible_commit');
        assert.equal(commits.length, 1, 'one round, one bible commit call -- not one per list');
        assert.deepEqual(commits[0].args.ids, ['kb-promo']);
        assert.deepEqual(commits[0].args.demoted_ids, ['kb-demo']);
        assert.deepEqual(out, { committed: 2, pending: 0 });
    });

    test('a demotion-only round sends demoted_ids with no ids key collision -- the bible commit still runs', async () => {
        const { client, events } = harness();
        await offerDemotions(client, [demotable('kb-demo-only')]);

        await client.apply('reviewer', 'reviewer-1', { kb_demotions: [{ id: 'kb-demo-only', reason: REASON }] });
        const out = await client.commitRound();

        const commits = events.filter((e) => e.ev === 'kb_bible_commit');
        assert.equal(commits.length, 1);
        assert.deepEqual(commits[0].args.ids, []);
        assert.deepEqual(commits[0].args.demoted_ids, ['kb-demo-only']);
        assert.deepEqual(out, { committed: 1, pending: 0 });
    });
});

describe('a failing kb_demote does not abort the other demotions or the bible commit', () => {
    test('one rejected kb_demote is logged as a refusal; the remaining demotion and the bible commit proceed', async () => {
        const { client, events, logs } = harness({
            demoteOutcome: (id) => (id === 'kb-fail' ? { isError: true, content: [{ type: 'text', text: 'entry not found' }] } : null),
        });
        await offerDemotions(client, [demotable('kb-fail'), demotable('kb-ok2')]);

        const out = await client.apply('reviewer', 'reviewer-1', {
            kb_demotions: [
                { id: 'kb-fail', reason: REASON },
                { id: 'kb-ok2', reason: REASON },
            ],
        });

        assert.equal(out.demoted, 1);
        assert.equal(out.refused, 0, 'a tool-level rejection is logged as a refusal line but is not a vetKbWork refusal');
        assert.ok(
            logs.includes('[kb-work] kb_demote rejected for kb-fail (non-fatal): entry not found'),
            JSON.stringify(logs),
        );
        assert.deepEqual(events.filter((e) => e.ev === 'kb_demote').map((e) => e.args.id), ['kb-fail', 'kb-ok2']);

        const commitOut = await client.commitRound();
        const bibleCalls = events.filter((e) => e.ev === 'kb_bible_commit');
        assert.equal(bibleCalls.length, 1, 'the bible commit still ran');
        assert.deepEqual(bibleCalls[0].args.demoted_ids, ['kb-ok2'], 'only the successful demotion reaches the bible commit');
        assert.deepEqual(commitOut, { committed: 1, pending: 0 });
    });
});

describe('IN-SPRINT PING-PONG: a round-1 demotion is not re-offered for promotion in round 2 while its basis is unchanged', () => {
    test('demote in round 1; round 2 promotionCandidates omits it until a cited file is edited on disk', async () => {
        const sprintStart = Date.parse('2026-01-01T00:00:00.000Z');
        let diskHash = 'HASH-ORIGINAL';
        const { client, events } = harness({
            sprintStartMs: sprintStart,
            currentFileHashes: async (member, files) => {
                const out = {};
                for (const f of files) out[f] = diskHash;
                return out;
            },
        });

        // Round 1: the reviewer demotes 'kb-ping'.
        await offerDemotions(client, [demotable('kb-ping')]);
        await client.apply('reviewer', 'reviewer-1', { kb_demotions: [{ id: 'kb-ping', reason: REASON }] });
        assert.ok(events.some((e) => e.ev === 'kb_demote' && e.args.id === 'kb-ping'), 'the demotion actually ran');

        // Round 2: promotionCandidates() reads the SAME id back, now
        // INFERRED, carrying the demoted_at/demoted_basis_hashes a real
        // kb_query would surface for a just-demoted row.
        const pingEntry = {
            id: 'kb-ping',
            type: 'knowledge',
            created_at: new Date(sprintStart + 1000).toISOString(),
            demoted_at: new Date(sprintStart + 60000).toISOString(),
            demoted_basis_hashes: { [CHANGED_FILE]: 'HASH-ORIGINAL' },
        };

        // FALSIFICATION: with the cited file's disk hash still equal to the
        // recorded demoted_basis_hashes, the just-demoted entry must be
        // ABSENT from round 2's offered promotion candidates. Removing the
        // D6 guard (promotionCandidates' wasDemotedThisSprint/
        // demotionBasisUnchanged filtering) makes this assertion fail: the
        // entry would come straight back through the pre-existing in-window
        // filter alone, since it is INFERRED and created this sprint.
        let offered = await offerPromotions(client, [pingEntry]);
        assert.deepEqual(offered.map((e) => e.id), [], 'the just-demoted entry is not re-offered while its basis is unchanged on disk');

        // The cited file is edited: the disk hash moves on from the demote-time snapshot.
        diskHash = 'HASH-EDITED';
        offered = await offerPromotions(client, [pingEntry]);
        assert.deepEqual(offered.map((e) => e.id), ['kb-ping'], 'a changed basis is new evidence -- the entry is offered again');
    });
});
