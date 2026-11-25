// Verify-before-push (invariant H5): an in-scope parent-child or blocks link
// this run did not remove is never absent from what a beads push publishes.
//
// doltPushAfter (fleet-sprint/dolt-sync.mjs) takes an optional
// verifyLinks(member) hook -- wired in a sprint to
// beadsScope.verifyLinksBeforePush (fleet-sprint/beads-scope.mjs) -- that
// runs after every reconcile `bd dolt pull` in the push path and before the
// re-push, after committing the merged working set. These tests drive the REAL createBeadsScope verify through the
// REAL doltPushAfter with a scripted command(): the push is rejected
// non-fast-forward, the reconcile pull "merges" lossily (drops the recorded
// parent link C -> P and the blocks edge X blocked-by Y from the in-memory
// table), and the guard must restore both BEFORE the re-push -- or, when a
// restore fails, issue no re-push at all and throw a typed error naming both.
//
// Hermetic: no bd/dolt process, no network, no home-dir access. ASCII only.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
    doltPushAfter,
    invalidateSyncRemoteCache,
    clearLastSyncedTip,
    clearTipProbeFailures,
    clearDegradedSyncRecords,
} from '../fleet-sprint/dolt-sync.mjs';
import { createBeadsScope } from '../fleet-sprint/beads-scope.mjs';
import { parseBdJson } from '../fleet-sprint/runner.js';
import { ParentLinkRestoreError } from '../fleet-sprint/parent-link-guard.mjs';

const NON_FAST_FORWARD_STDERR =
    'error: failed to push some refs to origin/main\n'
    + 'hint: Updates were rejected because the tip of your current branch is behind\n'
    + "hint: its remote counterpart. Use 'dolt pull' to merge the remote changes.";

const OK = { ok: true, output: '', error: null };

beforeEach(() => {
    invalidateSyncRemoteCache();
    clearLastSyncedTip();
    clearTipProbeFailures();
    clearDegradedSyncRecords();
});

const SEED = [
    { id: 'P', status: 'open', issue_type: 'feature' },
    { id: 'C', parent: 'P', status: 'open', issue_type: 'task' },
    { id: 'X', parent: 'P', status: 'open', issue_type: 'task', dependencies: [{ issue_id: 'X', depends_on_id: 'Y', type: 'blocks' }] },
    { id: 'Y', parent: 'P', status: 'open', issue_type: 'task' },
];

/**
 * A sprint-shaped harness: one in-memory beads table, a beads scope over it
 * (the ledger is fed by a first full-DB snapshot), and a scripted remote:
 * `pushes` answers each `bd dolt push` in turn (last entry repeats); a
 * `bd dolt pull` drops C's parent and X's blocks edge (the lossy merge).
 */
async function buildHarness({ pushes, failRestore = false }) {
    const db = { beads: SEED.map((b) => ({ ...b, dependencies: b.dependencies ? b.dependencies.map((d) => ({ ...d })) : undefined })) };
    const calls = [];
    const logs = [];
    let pushIndex = 0;
    const rawCommand = async (cmd, opts = {}) => {
        calls.push({ cmd, member: opts.member_name });
        if (cmd.includes('bd dolt push')) {
            const answer = pushes[Math.min(pushIndex, pushes.length - 1)];
            pushIndex += 1;
            return answer === 'reject' ? { ok: false, output: '', error: NON_FAST_FORWARD_STDERR } : OK;
        }
        if (cmd.includes('bd dolt pull')) {
            delete db.beads.find((b) => b.id === 'C').parent;
            db.beads.find((b) => b.id === 'X').dependencies = [];
            return OK;
        }
        if (cmd.startsWith('bd list --all')) {
            const byId = /--id "([^"]+)"/.exec(cmd);
            return JSON.stringify(byId ? db.beads.filter((b) => byId[1].split(',').includes(b.id)) : db.beads);
        }
        const up = /^bd update (\S+) --parent (\S+)$/.exec(cmd);
        if (up) {
            if (failRestore) return { ok: false, output: '', error: 'Error: database is locked' };
            db.beads.find((b) => b.id === up[1]).parent = up[2];
            return OK;
        }
        const add = /^bd dep add (\S+) (\S+)$/.exec(cmd);
        if (add) {
            if (failRestore) return { ok: false, output: '', error: 'Error: database is locked' };
            const bead = db.beads.find((b) => b.id === add[1]);
            bead.dependencies = [...(bead.dependencies || []), { issue_id: add[1], depends_on_id: add[2], type: 'blocks' }];
            return OK;
        }
        return OK;
    };
    const scope = createBeadsScope({
        targetIssues: ['P'],
        parseBdJson,
        getBacklogMember: () => 'backlog-member',
        log: (line) => logs.push(line),
    });
    const command = scope.wrapCommand(rawCommand);
    await scope.fetchAllBeadsShared(); // the ledger records C -> P and X blocked-by Y
    calls.length = 0;
    const indexOf = (re, from = 0) => calls.findIndex((c, i) => i >= from && re.test(c.cmd));
    const all = (re) => calls.filter((c) => re.test(c.cmd));
    return { db, calls, logs, command, scope, indexOf, all };
}

const pushOpts = (h, extra = {}) => ({
    command: h.command,
    log: (m) => h.logs.push(m),
    checkSyncRemoteConfigured: async () => true,
    sleep: async () => {},
    verifyLinks: (member) => h.scope.verifyLinksBeforePush(member),
    ...extra,
});

test('push rejected -> reconcile pull drops a parent link and a blocks edge -> both are restored BEFORE the re-push', async () => {
    const h = await buildHarness({ pushes: ['reject', 'ok'] });
    const res = await doltPushAfter('writer-b', pushOpts(h));
    assert.equal(res.pushed, true);
    assert.equal(res.reconciled, true);

    const pull = h.indexOf(/^bd dolt pull/);
    const restoreParent = h.indexOf(/^bd update C --parent P$/);
    const restoreBlocks = h.indexOf(/^bd dep add X Y$/);
    const firstPush = h.indexOf(/^bd dolt push/);
    const rePush = h.indexOf(/^bd dolt push/, firstPush + 1);
    assert.ok(pull > firstPush, h.calls.map((c) => c.cmd).join('\n'));
    // The merged working set is committed first (a conflicted pull on the
    // pinned bd leaves merged links uncommitted, so a bare push drops them).
    const commit = h.indexOf(/^bd dolt commit -m /);
    assert.ok(commit > pull && commit < restoreParent && commit < restoreBlocks,
        `the working-set commit must follow the pull and precede the restores:\n${h.calls.map((c) => c.cmd).join('\n')}`);
    assert.ok(restoreParent > pull && restoreParent < rePush, `parent restore must sit between the reconcile pull and the re-push:\n${h.calls.map((c) => c.cmd).join('\n')}`);
    assert.ok(restoreBlocks > pull && restoreBlocks < rePush, `blocks restore must sit between the reconcile pull and the re-push:\n${h.calls.map((c) => c.cmd).join('\n')}`);
    // Restores run on the PUSHING clone, not the backlog member.
    assert.equal(h.calls[restoreParent].member, 'writer-b');
    assert.equal(h.calls[restoreBlocks].member, 'writer-b');
    // ERROR lines name both links.
    assert.ok(h.logs.some((l) => l.startsWith('ERROR: parent-child link vanished') && l.includes("'C'") && l.includes("'P'")), h.logs.join('\n'));
    assert.ok(h.logs.some((l) => l.startsWith('ERROR: blocks link vanished') && l.includes("'X'") && l.includes("'Y'")), h.logs.join('\n'));
    // What the re-push published carries both links.
    assert.equal(h.db.beads.find((b) => b.id === 'C').parent, 'P');
    assert.ok(h.db.beads.find((b) => b.id === 'X').dependencies.some((d) => d.depends_on_id === 'Y' && d.type === 'blocks'));
});

test('a failing restore aborts the push: no re-push is issued and the typed error names both edges', async () => {
    const h = await buildHarness({ pushes: ['reject', 'ok'], failRestore: true });
    await assert.rejects(() => doltPushAfter('writer-b', pushOpts(h)), (err) => {
        assert.ok(err instanceof ParentLinkRestoreError, `${err && err.name}: ${err && err.message}`);
        const kinds = err.edges.map((e) => e.kind).sort();
        assert.deepEqual(kinds, ['blocks', 'parent-child']);
        assert.match(err.message, /parent-child link 'C' -> parent 'P'/);
        assert.match(err.message, /blocks link 'X' blocked by 'Y'/);
        assert.match(err.message, /bd update C --parent P/);
        assert.match(err.message, /bd dep add X Y/);
        return true;
    });
    assert.equal(h.all(/^bd dolt push/).length, 1, `only the first (rejected) push; no re-push after a failed restore:\n${h.calls.map((c) => c.cmd).join('\n')}`);
    assert.ok(h.logs.some((l) => /ABORTED after reconcile pull 1/.test(l)), h.logs.join('\n'));
});

test('after an aborted push the member owes a verify: its next push verifies BEFORE the first push attempt', async () => {
    const h = await buildHarness({ pushes: ['reject', 'ok'], failRestore: true });
    await assert.rejects(() => doltPushAfter('writer-owing', pushOpts(h)), ParentLinkRestoreError);

    // The clone still lacks both links. The next push is accepted at once,
    // so without the owed verify it would publish the loss. (A fresh
    // harness whose restores work, over the same lossy table.)
    const fixed = await buildHarness({ pushes: ['ok'] });
    fixed.db.beads = h.db.beads;
    const res = await doltPushAfter('writer-owing', pushOpts(fixed));
    assert.equal(res.pushed, true);
    const restore = fixed.indexOf(/^bd update C --parent P$/);
    const push = fixed.indexOf(/^bd dolt push/);
    assert.ok(restore >= 0 && restore < push, `owed verify must restore before the first push:\n${fixed.calls.map((c) => c.cmd).join('\n')}`);

    // Paid off: a further push for this member no longer verifies up front.
    fixed.calls.length = 0;
    await doltPushAfter('writer-owing', pushOpts(fixed));
    assert.equal(fixed.all(/^bd list --all/).length, 0, fixed.calls.map((c) => c.cmd).join('\n'));
});

test('a push accepted first time issues no verify read (nothing was pulled inside the push path)', async () => {
    const h = await buildHarness({ pushes: ['ok'] });
    await doltPushAfter('writer-c', pushOpts(h));
    assert.equal(h.all(/^bd list --all/).length, 0, h.calls.map((c) => c.cmd).join('\n'));
});

test('without the verifyLinks option the reconcile path is unchanged: no link read, no restore', async () => {
    const h = await buildHarness({ pushes: ['reject', 'ok'] });
    const res = await doltPushAfter('writer-d', pushOpts(h, { verifyLinks: undefined }));
    assert.equal(res.reconciled, true);
    assert.equal(h.all(/^bd list --all|^bd update|^bd dep add|^bd dolt commit/).length, 0, h.calls.map((c) => c.cmd).join('\n'));
});

test('a working-set commit that fails aborts the push before any re-push', async () => {
    const h = await buildHarness({ pushes: ['reject', 'ok'] });
    const command = async (cmd, opts) => (cmd.startsWith('bd dolt commit')
        ? { ok: false, output: '', error: 'Error: cannot commit: working set is invalid' }
        : h.command(cmd, opts));
    await assert.rejects(() => doltPushAfter('writer-e', pushOpts(h, { command })), (err) => {
        assert.match(err.message, /could not commit member 'writer-e' merged beads working set/);
        return true;
    });
    assert.equal(h.all(/^bd dolt push/).length, 1, h.calls.map((c) => c.cmd).join('\n'));
});
