import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createKbWorkClient } from '../fleet-sprint/kb.mjs';
import { selfMaintainer } from './helpers/kb-maintainer-fakes.mjs';

// =============================================================================
// The review-round bible commit (createKbWorkClient.commitRound), with fakes:
// every promotion the maintainer applied is a confirmation; after a review
// round the engine runs, on the maintainer, G-pull -> kb_bible_commit -> G-push,
// retries a rejected G-push exactly once, and keeps the ids queued (with a
// WARN) when the retry fails too. seal() stops every further commit.
// =============================================================================

const MAINT = { id: 'id-maint', name: 'maint', type: 'local' };
const REPO = 'example.com/org/repo';
const REASON = 'verified against the merged code in this round';
const BASE = { baseBranch: 'main', baseCommit: 'a'.repeat(40) };

/**
 * A fake maintainer: records every event in order. `pushFailures` is how many
 * G-pushes fail before one succeeds.
 */
function harness({ pushFailures = 0, committed = true } = {}) {
    const events = [];
    const logs = [];
    let pushesLeftToFail = pushFailures;
    const memberCall = async (member, tool, args) => {
        events.push({ ev: tool, member: member.name, args });
        if (tool === 'kb_bible_commit') {
            return { content: [{ text: JSON.stringify({ path: '.fleet/kb-canonical.json', merged: args.ids, skipped: [], entry_count: args.ids.length, committed }) }] };
        }
        return {};
    };
    const client = createKbWorkClient({
        memberCall,
        maintainers: selfMaintainer(MAINT, ['maint', 'reviewer-1']),
        gPull: async (m, opts = {}) => { events.push({ ev: opts.resetToRemoteTip ? 'G-pull(reset)' : 'G-pull', member: m }); },
        gPush: async (m) => {
            events.push({ ev: 'G-push', member: m });
            if (pushesLeftToFail > 0) {
                pushesLeftToFail--;
                throw new Error('! [rejected] (non-fast-forward)');
            }
        },
        abortRebase: async (m) => { events.push({ ev: 'rebase--abort', member: m }); return false; },
        bibleBase: async () => BASE,
        log: (m) => logs.push(m),
    });
    return { client, events, logs };
}

async function confirm(client, ids) {
    await client.apply('reviewer', 'reviewer-1', { kb_promotions: ids.map((id) => ({ id, reason: REASON })) });
}

const gitAndBible = (events) => events.filter((e) => e.ev !== 'kb_promote').map((e) => e.ev);

describe('commitRound: the review-round bible commit on the kb_maintainer', () => {
    test('call order is G-pull, then kb_bible_commit, then G-push -- with the round ids and the base', async () => {
        const { client, events } = harness();
        await confirm(client, ['e1', 'e2']);

        const out = await client.commitRound('review C1');

        // The promotions' own batch G-pull comes first; the bible commit is the
        // three events after the last kb_promote.
        const afterPromotes = events.slice(events.map((e) => e.ev).lastIndexOf('kb_promote') + 1);
        assert.deepEqual(afterPromotes.map((e) => e.ev), ['G-pull', 'kb_bible_commit', 'G-push']);
        const call = afterPromotes[1];
        assert.equal(call.member, 'maint', 'kb_bible_commit runs in the maintainer session');
        assert.deepEqual(call.args, { ids: ['e1', 'e2'], baseBranch: 'main', baseCommit: BASE.baseCommit });
        assert.deepEqual(out, { committed: 2, pending: 0 });
        assert.deepEqual(client.pendingConfirmations(), []);
    });

    test('a round with no confirmations makes no kb_bible_commit call and touches no git', async () => {
        const { client, events } = harness();
        // A capture-only round: no promotion, so no confirmation.
        await client.apply('reviewer', 'reviewer-1', { kb_captures: [] });

        const out = await client.commitRound();

        assert.deepEqual(events, []);
        assert.deepEqual(out, { committed: 0, pending: 0 });
    });

    test('a rejected G-push is retried exactly once: rebase --abort, G-pull onto the remote tip, kb_bible_commit with the same ids, G-push', async () => {
        const { client, events, logs } = harness({ pushFailures: 1 });
        await confirm(client, ['e1']);
        const before = events.length;

        const out = await client.commitRound();

        assert.deepEqual(events.slice(before).map((e) => e.ev), [
            'G-pull', 'kb_bible_commit', 'G-push',
            'rebase--abort', 'G-pull(reset)', 'kb_bible_commit', 'G-push',
        ]);
        const commits = events.filter((e) => e.ev === 'kb_bible_commit');
        assert.deepEqual(commits.map((c) => c.args.ids), [['e1'], ['e1']], 'the retry re-commits the same ids');
        assert.deepEqual(out, { committed: 1, pending: 0 });
        assert.ok(logs.some((l) => /retrying once/.test(l)));
        assert.ok(!logs.some((l) => /WARN/.test(l)), 'a successful retry is not a warning');
    });

    test('a second push failure keeps the ids queued with a WARN; the next successful round commits them', async () => {
        const { client, events, logs } = harness({ pushFailures: 2 });
        await confirm(client, ['e1', 'e2']);
        const before = events.length;

        const first = await client.commitRound('review C1');

        // Exactly one retry -- never a third push -- then the checkout is put
        // back on the remote tip so the maintainer's next G-pull fast-forwards.
        assert.deepEqual(events.slice(before).map((e) => e.ev), [
            'G-pull', 'kb_bible_commit', 'G-push',
            'rebase--abort', 'G-pull(reset)', 'kb_bible_commit', 'G-push',
            'rebase--abort', 'G-pull(reset)',
        ]);
        assert.deepEqual(first, { committed: 0, pending: 2 });
        assert.deepEqual(client.pendingConfirmations(), ['e1', 'e2']);
        assert.ok(logs.some((l) => /^\[kb-work\] WARN: bible commit for .* failed at G-push .* 2 confirmation\(s\) stay queued for the next round$/.test(l)), logs.join('\n'));

        // Next round: a new confirmation joins the queued ones in one commit.
        await confirm(client, ['e3']);
        const mark = events.length;
        const second = await client.commitRound('review C2');

        const next = events.slice(mark).filter((e) => e.ev === 'kb_bible_commit');
        assert.equal(next.length, 1);
        assert.deepEqual(next[0].args.ids, ['e1', 'e2', 'e3'], 'nothing queued is lost');
        assert.deepEqual(second, { committed: 3, pending: 0 });
        assert.deepEqual(client.pendingConfirmations(), []);
    });

    test('nothing committed (entry set unchanged) means nothing pushed', async () => {
        const { client, events } = harness({ committed: false });
        await confirm(client, ['e1']);
        const before = events.length;

        await client.commitRound();

        assert.deepEqual(gitAndBible(events.slice(before)), ['G-pull', 'kb_bible_commit']);
        assert.deepEqual(client.pendingConfirmations(), []);
    });

    test('after seal() (a FAIL verdict or an abort) nothing further is committed and the queue is not flushed', async () => {
        const { client, events } = harness();
        await confirm(client, ['e1']);
        client.seal('final review verdict FAIL');
        const before = events.length;

        const out = await client.commitRound('harvest');

        assert.deepEqual(events.slice(before), [], 'no G-pull, no kb_bible_commit, no G-push');
        assert.deepEqual(out, { committed: 0, pending: 1 });
        assert.deepEqual(client.pendingConfirmations(), ['e1']);
    });

    test('an unresolvable base keeps the ids queued and makes no kb_bible_commit call', async () => {
        const logs = [];
        const events = [];
        const client = createKbWorkClient({
            memberCall: async (m, tool) => { events.push(tool); return {}; },
            maintainers: selfMaintainer(MAINT, ['maint', 'reviewer-1']),
            gPull: async () => {},
            gPush: async () => { events.push('G-push'); },
            bibleBase: async () => null,
            log: (m) => logs.push(m),
        });
        await confirm(client, ['e1']);

        const out = await client.commitRound();

        assert.ok(!events.includes('kb_bible_commit'));
        assert.ok(!events.includes('G-push'));
        assert.deepEqual(out, { committed: 0, pending: 1 });
        assert.ok(logs.some((l) => /WARN: bible commit .* failed at base resolution/.test(l)));
    });
});
