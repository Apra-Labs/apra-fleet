import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createKbWorkClient } from '../fleet-sprint/kb.mjs';
import { selfMaintainer } from './helpers/kb-maintainer-fakes.mjs';

// kb_bible_commit answering committed:false WITH not_committed_reason means the
// server saw the committed bible does not hold this call's merge: a lost write.
// Through the real client and the tool's real answer shape, the ids stay queued
// whatever origin holds, nothing is reported committed, and a later clean round
// lands them. (Fakes for the maintainer's git steps only.)

const MAINT = { id: 'id-maint', name: 'maint', type: 'local' };
const REASON = 'verified against the merged code in this round';
const BASE = { baseBranch: 'main', baseCommit: 'a'.repeat(40) };
const LOST = "another writer replaced the bible before this call's commit landed: the committed bible is missing merged e1";

function toolAnswer(body) {
    return { content: [{ type: 'text', text: JSON.stringify(body) }] };
}

function lostWriteAnswer(ids) {
    return toolAnswer({
        path: '.fleet/kb-canonical.json', merged: ids, demoted: [], skipped: [], removed: [],
        entry_count: 1, backfilled: 0, committed: false, not_committed_reason: LOST,
    });
}

function cleanAnswer(ids) {
    return toolAnswer({
        path: '.fleet/kb-canonical.json', merged: ids, demoted: [], skipped: [], removed: [],
        entry_count: ids.length, backfilled: 0, committed: true,
    });
}

function harness({ unpushed, answers }) {
    const events = [];
    const logs = [];
    let offered = [];
    let commits = 0;
    const client = createKbWorkClient({
        memberCall: async (_member, tool, args) => {
            if (tool === 'kb_query') return { l1_results: offered.map((id) => ({ id })) };
            events.push(tool);
            if (tool === 'kb_bible_commit') return answers(commits++, args.ids);
            return {};
        },
        maintainers: selfMaintainer(MAINT, ['maint', 'reviewer-1']),
        gPull: async (_m, opts = {}) => { events.push(opts.resetToRemoteTip ? 'G-pull(reset)' : 'G-pull'); },
        gPush: async () => { events.push('G-push'); },
        abortRebase: async () => { events.push('rebase--abort'); return false; },
        bibleBase: async () => BASE,
        bibleUnpushed: async () => { events.push('publication-check'); return { unpushed }; },
        log: (m) => logs.push(m),
    });
    const confirm = async (ids) => {
        offered = ids;
        await client.promotionCandidates('reviewer-1');
        await client.apply('reviewer', 'reviewer-1', { kb_promotions: ids.map((id) => ({ id, reason: REASON })) });
    };
    return { client, confirm, events, logs };
}

for (const unpushed of [true, false]) {
    describe(`a lost write with bibleUnpushed answering unpushed:${unpushed}`, () => {
        test('the ids stay queued, nothing is pushed or reported committed, and the WARN names the reason', async () => {
            const { client, confirm, events, logs } = harness({ unpushed, answers: (_n, ids) => lostWriteAnswer(ids) });
            await confirm(['e1']);

            const out = await client.commitRound('review C1');

            assert.deepEqual(out, { committed: 0, pending: 1 });
            assert.deepEqual(client.pendingConfirmations(), ['e1']);
            assert.ok(!events.includes('G-push'), events.join(', '));
            assert.ok(!events.includes('publication-check'), 'the lost write is decided before the publication check');
            assert.ok(!logs.some((l) => /committed and pushed|already in the bible/.test(l)), logs.join('\n'));
            assert.ok(logs.some((l) => l.includes('WARN') && l.includes(LOST)), logs.join('\n'));
        });

        test('the retry resets onto the remote tip, so the leftover local commit cannot wedge the next pull', async () => {
            const { client, confirm, events } = harness({ unpushed, answers: (_n, ids) => lostWriteAnswer(ids) });
            await confirm(['e1']);
            await client.commitRound('review C1');
            const after = events.slice(events.indexOf('kb_bible_commit'));
            assert.deepEqual(after, [
                'kb_bible_commit', 'rebase--abort', 'G-pull(reset)', 'kb_bible_commit', 'rebase--abort', 'G-pull(reset)',
            ]);
        });

        test('the same round lands the id when the retry merges cleanly', async () => {
            const { client, confirm, events, logs } = harness({
                unpushed, answers: (n, ids) => (n === 0 ? lostWriteAnswer(ids) : cleanAnswer(ids)),
            });
            await confirm(['e1']);

            const out = await client.commitRound('review C1');

            assert.deepEqual(out, { committed: 1, pending: 0 });
            assert.deepEqual(client.pendingConfirmations(), []);
            assert.equal(events.filter((e) => e === 'G-push').length, 1);
            assert.ok(logs.some((l) => l.includes('did not land') && l.includes(LOST)), logs.join('\n'));
        });

        test('a later round lands the id after both attempts of the first were lost', async () => {
            const { client, confirm, events } = harness({
                unpushed, answers: (n, ids) => (n < 2 ? lostWriteAnswer(ids) : cleanAnswer(ids)),
            });
            await confirm(['e1']);

            assert.deepEqual(await client.commitRound('review C1'), { committed: 0, pending: 1 });
            assert.ok(!events.includes('G-push'));

            assert.deepEqual(await client.commitRound('review C2'), { committed: 1, pending: 0 });
            assert.deepEqual(client.pendingConfirmations(), []);
            assert.equal(events.filter((e) => e === 'G-push').length, 1);
        });
    });
}

test('a plain committed:false with no reason still follows the publication check', async () => {
    const { client, confirm, events } = harness({
        unpushed: false,
        answers: (_n, ids) => toolAnswer({ path: 'p', merged: ids, skipped: [], entry_count: 1, committed: false }),
    });
    await confirm(['e1']);
    assert.deepEqual(await client.commitRound('review C1'), { committed: 0, pending: 0 });
    assert.deepEqual(client.pendingConfirmations(), []);
    assert.ok(events.includes('publication-check'));
    assert.ok(!events.includes('G-push'));
});

describe('flushRepo: the G-pull scope (a batch of usage or feedback only reads no checkout file)', () => {
    function flushHarness() {
        const events = [];
        const client = createKbWorkClient({
            memberCall: async (_member, tool) => { events.push(tool); return {}; },
            maintainers: selfMaintainer(MAINT, ['maint', 'doer-1']),
            gPull: async () => { events.push('G-pull'); },
            log: () => {},
        });
        return { client, events };
    }
    const CAPTURE = {
        type: 'knowledge', title: 'Retry budget is read once at startup',
        summary: 'The retry budget is read once at boot; editing it needs a service restart.',
        trigger: 'hidden-invariant', source_files: ['src/retry.ts'], symbols: ['loadRetryBudget'],
    };

    test('usage only: no G-pull, the report still lands', async () => {
        const { client, events } = flushHarness();
        await client.reportUsage('doer-1', { pushed: ['a'], cited: ['a'] });
        assert.deepEqual(events, ['kb_usage']);
    });

    test('feedback only: no G-pull, the note still lands', async () => {
        const { client, events } = flushHarness();
        await client.feedback('doer', 'doer-1', [{ id: 'a', reason: 'proved wrong' }]);
        assert.deepEqual(events, ['kb_feedback']);
    });

    test('a capture: G-pull first', async () => {
        const { client, events } = flushHarness();
        await client.apply('doer', 'doer-1', { kb_captures: [CAPTURE] });
        assert.deepEqual(events, ['G-pull', 'kb_capture']);
    });
});
