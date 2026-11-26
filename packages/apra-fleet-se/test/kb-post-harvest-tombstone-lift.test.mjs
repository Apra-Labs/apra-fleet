import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createKbWorkClient } from '../fleet-sprint/kb.mjs';
import { createBaseBibleIds } from '../fleet-sprint/runner.js';
import { selfMaintainer, currentServerKbWork } from './helpers/kb-maintainer-fakes.mjs';

// =============================================================================
// liftOwnTombstones (post-harvest drop of an entry this branch alone added),
// driven through createKbWorkClient with a fake maintainer:
//   - a restore is confirmed from the ids kb_bible_commit LISTED as restored;
//   - an unreadable base bible is logged with the member and the reason, and
//     the withdrawal is kept;
//   - a withdrawal that never reached a pushed bible commit is reported as not
//     pushed, never as withdrawn.
// plus createBaseBibleIds direct tests (null = unreadable, empty Set = no bible).
// =============================================================================

const MAINT = { id: 'id-maint', name: 'maint', type: 'local' };
const REPO = 'example.com/org/repo';
const ID = 'eeee7777-own-entry';
const CITED = 'src/cited.ts';
const BASE = { baseBranch: 'main', baseCommit: 'a'.repeat(40) };

/**
 * `restoreAnswer`: 'listed' (the tool lists restore_ids as restored) or
 * 'omitted' (success, but no `restored` list). `baseBibleIds`: the callback.
 * `noBaseCommitAfterWithdrawal`: the base lookup loses its commit once the withdrawal was sent. `pushFails`: every G-push after the first
 * bible commit is rejected.
 */
function harness({ restoreAnswer = 'listed', baseBibleIds, noBaseCommitAfterWithdrawal = false, pushFailsAfterDrift = false } = {}) {
    const events = [];
    const logs = [];
    let drifting = false;
    let withdrawalSent = false;
    const bibleBase = async () => (noBaseCommitAfterWithdrawal && withdrawalSent ? { baseBranch: 'main' } : BASE);
    const memberCall = async (member, tool, args) => {
        if (tool === 'kb_query') return { l1_results: [{ id: ID }] };
        events.push({ ev: tool, member: member.name, args });
        if (tool === 'kb_bible_commit') {
            if (drifting && (args.ids || []).includes(ID)) {
                return { content: [{ text: JSON.stringify({ merged: [], skipped: [{ id: ID, reason: 'basis_mismatch', changed_files: [{ path: CITED, reason: 'changed' }] }], committed: false }) }] };
            }
            const withdrawn = (args.withdrawals || []).map((w) => w.id);
            if (withdrawn.length > 0) withdrawalSent = true;
            const restored = restoreAnswer === 'listed' ? (args.restore_ids || []) : undefined;
            return { content: [{ text: JSON.stringify({
                merged: (args.ids || []).filter(() => !drifting), skipped: [], withdrawn,
                ...(restored ? { restored } : {}), committed: true,
            }) }] };
        }
        if (tool === 'kb_promote') return { id: args.id, previous_confidence: 'INFERRED', new_confidence: 'CONFIRMED' };
        return {};
    };
    const client = currentServerKbWork(createKbWorkClient, {
        memberCall,
        maintainers: selfMaintainer(MAINT, ['maint', 'reviewer-1']),
        gPull: async () => {},
        gPush: async (m) => {
            events.push({ ev: 'G-push', member: m });
            if (drifting && pushFailsAfterDrift) throw new Error('! [rejected] (non-fast-forward)');
        },
        abortRebase: async () => false,
        bibleBase,
        bibleUnpushed: async () => ({ unpushed: false }),
        ...(baseBibleIds ? { baseBibleIds } : {}),
        log: (m) => logs.push(m),
    });
    return { client, events, logs, startDrift: () => { drifting = true; } };
}

async function mergeThenDrift(h) {
    await h.client.promotionCandidates('reviewer-1');
    await h.client.apply('reviewer', 'reviewer-1', { kb_promotions: [{ id: ID, reason: 'verified against the merged code in this round' }] });
    await h.client.commitRound('review C1');
    h.startDrift();
    return h.client.recheckSprintBible('post-harvest head', { noReviewLeft: true });
}

describe('liftOwnTombstones: restores are confirmed from the tool result', () => {
    test('a restore the tool lists as restored clears the withdrawal record (branch-owned id)', async () => {
        const h = harness({ baseBibleIds: async () => new Set() });
        const out = await mergeThenDrift(h);
        assert.deepEqual(out.dropped, [ID]);
        assert.ok(h.logs.some((l) => l.includes(ID) && /added to the branch bible by this sprint alone/.test(l)), h.logs.join('\n'));
        assert.equal(h.client.droppedConfirmations().find((d) => d.id === ID).withdrawn, false);
    });

    test('a restore sent but absent from the result is logged as not performed; the withdrawal stays recorded', async () => {
        const h = harness({ restoreAnswer: 'omitted', baseBibleIds: async () => new Set() });
        await mergeThenDrift(h);
        const restoreCalls = h.events.filter((e) => e.ev === 'kb_bible_commit' && (e.args.restore_ids || []).includes(ID));
        assert.equal(restoreCalls.length, 1, 'sanity: the restore was sent');
        assert.ok(h.logs.some((l) => l.includes(ID) && /restore .*was not performed/.test(l)), h.logs.join('\n'));
        assert.ok(!h.logs.some((l) => l.includes(ID) && /added to the branch bible by this sprint alone/.test(l)), 'no "removed with no tombstone" claim');
        assert.equal(h.client.droppedConfirmations().find((d) => d.id === ID).withdrawn, true, 'the drop record still shows it withdrawn');
        assert.ok(h.client.withdrawnIds().includes(ID));
    });
});

describe('liftOwnTombstones: an unreadable base bible is logged', () => {
    test('baseBibleIds -> null: the log names the member and the reason; no restore is sent; the withdrawal is kept', async () => {
        const h = harness({ baseBibleIds: async () => null });
        await mergeThenDrift(h);
        const line = h.logs.find((l) => /could not read the base bible/.test(l));
        assert.ok(line, h.logs.join('\n'));
        assert.match(line, /maintainer 'maint'/);
        assert.ok(line.includes(`base commit ${BASE.baseCommit}`), line);
        assert.ok(line.includes(ID), 'names the kept withdrawal');
        assert.ok(h.events.every((e) => e.ev !== 'kb_bible_commit' || !(e.args.restore_ids || []).length), 'no restore sent');
        assert.equal(h.client.droppedConfirmations().find((d) => d.id === ID).withdrawn, true);
    });

    test('no base commit: the log names the member and says no base commit could be determined', async () => {
        const h = harness({ noBaseCommitAfterWithdrawal: true, baseBibleIds: async () => new Set() });
        await mergeThenDrift(h);
        const line = h.logs.find((l) => /could not read the base bible/.test(l));
        assert.ok(line, h.logs.join('\n'));
        assert.match(line, /maintainer 'maint'/);
        assert.match(line, /no base commit could be determined/);
    });

    test('baseBibleIds throws: the error text is the reason', async () => {
        const h = harness({ baseBibleIds: async () => { throw new Error('ssh: connection reset'); } });
        await mergeThenDrift(h);
        const line = h.logs.find((l) => /could not read the base bible/.test(l));
        assert.ok(line && line.includes('ssh: connection reset'), h.logs.join('\n'));
    });
});

describe('a withdrawal that never reached a pushed bible commit is reported as not pushed', () => {
    test('rejected G-push: the WARN names the id; droppedConfirmations/unpublishedBible show withdrawalNotPushed, not withdrawn', async () => {
        const h = harness({ baseBibleIds: async () => new Set(), pushFailsAfterDrift: true });
        await mergeThenDrift(h);
        assert.ok(h.logs.some((l) => /did not reach a pushed bible commit/.test(l) && l.includes(ID)), h.logs.join('\n'));
        assert.ok(!h.logs.some((l) => l.includes(ID) && /added to the branch bible by this sprint alone/.test(l)));
        for (const d of [h.client.droppedConfirmations().find((x) => x.id === ID), h.client.unpublishedBible().dropped.find((x) => x.id === ID)]) {
            assert.equal(d.withdrawn, false, 'not reported as withdrawn');
            assert.equal(d.withdrawalNotPushed, true, 'reported as not pushed');
        }
    });
});

describe('createBaseBibleIds', () => {
    const HEX = 'abc1234';
    const make = (script) => {
        const calls = [];
        const command = async (cmd, opts) => { calls.push({ cmd, opts }); return script(cmd); };
        return { read: createBaseBibleIds({ command }), calls };
    };

    test('a non-hex or non-string base commit -> null, without any git call', async () => {
        const { read, calls } = make(() => ({ ok: true, output: '' }));
        assert.equal(await read('m', 'main; rm -rf /'), null);
        assert.equal(await read('m', 'xyz'), null);
        assert.equal(await read('m', undefined), null);
        assert.equal(calls.length, 0);
    });

    test('git ls-tree fails -> null', async () => {
        const { read } = make(() => ({ ok: false, output: '' }));
        assert.equal(await read('m', HEX), null);
    });

    test('git ls-tree finds no bible -> an empty Set (no bible at that commit)', async () => {
        const { read, calls } = make((cmd) => (cmd.startsWith('git ls-tree') ? { ok: true, output: '  \n' } : { ok: false }));
        const ids = await read('m', HEX);
        assert.ok(ids instanceof Set);
        assert.equal(ids.size, 0);
        assert.equal(calls.length, 1, 'git show is not run');
    });

    test('git show fails -> null', async () => {
        const { read } = make((cmd) => (cmd.startsWith('git ls-tree') ? { ok: true, output: '.fleet/kb-canonical.json\n' } : { ok: false }));
        assert.equal(await read('m', HEX), null);
    });

    test('invalid JSON -> null', async () => {
        const { read } = make((cmd) => (cmd.startsWith('git ls-tree') ? { ok: true, output: '.fleet/kb-canonical.json\n' } : { ok: true, output: '{not json' }));
        assert.equal(await read('m', HEX), null);
    });

    test('a valid bible -> the Set of entry ids; entries without a string id are skipped', async () => {
        const doc = { entries: [{ id: 'a' }, { id: 'b' }, { id: 7 }, {}, null, { title: 'no id' }] };
        const { read, calls } = make((cmd) => (cmd.startsWith('git ls-tree') ? { ok: true, output: '.fleet/kb-canonical.json\n' } : { ok: true, output: JSON.stringify(doc) }));
        const ids = await read('maint', HEX);
        assert.deepEqual([...ids].sort(), ['a', 'b']);
        assert.ok(calls.every((c) => c.opts.member_name === 'maint'));
        assert.ok(calls[1].cmd.includes(`${HEX}:.fleet/kb-canonical.json`));
    });

    test('a bible document with no entries array -> an empty Set', async () => {
        const { read } = make((cmd) => (cmd.startsWith('git ls-tree') ? { ok: true, output: 'x\n' } : { ok: true, output: '{}' }));
        assert.equal((await read('m', HEX)).size, 0);
    });
});
