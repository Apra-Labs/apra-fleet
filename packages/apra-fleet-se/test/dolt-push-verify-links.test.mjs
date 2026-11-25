// Verify-before-push (invariant H5): an in-scope parent-child or blocks link
// this run did not remove is never absent from what a beads push publishes.
//
// doltPushAfter (fleet-sprint/dolt-sync.mjs) takes an optional
// verifyLinks(member) hook -- wired in a sprint to
// beadsScope.verifyLinksBeforePush (fleet-sprint/beads-scope.mjs) -- that
// runs after every reconcile `bd dolt pull` in the push path and before the
// re-push, after committing the merged working set, and before the first
// push of a member whose doltPullBefore pull merged remote changes (the pull
// bracket). These tests drive the REAL createBeadsScope verify through the
// REAL doltPushAfter with a scripted command(): the push is rejected
// non-fast-forward, the reconcile pull reports an auto-resolved conflict and
// "merges" lossily (drops the recorded parent link C -> P and the blocks edge
// X blocked-by Y from the in-memory table), and the guard must restore both
// BEFORE the re-push -- or, when a restore fails, issue no re-push at all and
// throw a typed error naming both. Links an AGENT changed on its clone (a
// retarget, a reversal that breaks a cycle, a reparent) are not pull losses
// and must reach the remote exactly as the agent left them.
//
// Hermetic: no bd/dolt process, no network, no home-dir access. ASCII only.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
    doltPushAfter,
    doltPullBefore,
    clearMembersOwingLinkVerify,
    invalidateSyncRemoteCache,
    clearLastSyncedTip,
    clearTipProbeFailures,
    clearDegradedSyncRecords,
} from '../fleet-sprint/dolt-sync.mjs';
import { createBeadsScope } from '../fleet-sprint/beads-scope.mjs';
import { parseBdJson } from '../fleet-sprint/runner.js';
import { ParentLinkRestoreError } from '../fleet-sprint/parent-link-guard.mjs';
import { createSyncBrackets, createGitSync } from '../fleet-sprint/git-sync.mjs';

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
    clearMembersOwingLinkVerify();
});

/** What the pinned bd prints (stdout, then stderr as the command seam appends it) for a pull that auto-resolved a conflict. */
const CONFLICTED_PULL_OUTPUT = 'Pulling from Dolt remote...\nPull complete.\n[stderr]\nNotice: auto-merged issue Y; title, updated_at settled last-write-wins';
const CLEAN_PULL_OUTPUT = 'Pulling from Dolt remote...\nPull complete.';

/** The default lossy merge: drops C's parent and X's blocks edge. */
const LOSSY_MERGE = (db) => {
    delete db.beads.find((b) => b.id === 'C').parent;
    db.beads.find((b) => b.id === 'X').dependencies = [];
};

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
 * `bd dolt pull` applies `merge` (default: drops C's parent and X's blocks
 * edge, the lossy merge) and reports a conflict unless `conflicted` is false.
 * `cycleOn(a, b)` makes `bd dep add a b` fail the way bd refuses a cycle.
 */
async function buildHarness({ pushes, failRestore = false, merge = LOSSY_MERGE, conflicted = true, cycleOn = null }) {
    const state = { failRestore };
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
            merge(db);
            return { ok: true, output: conflicted ? CONFLICTED_PULL_OUTPUT : CLEAN_PULL_OUTPUT, error: null };
        }
        if (cmd.startsWith('bd list --all')) {
            const byId = /--id "([^"]+)"/.exec(cmd);
            return JSON.stringify(byId ? db.beads.filter((b) => byId[1].split(',').includes(b.id)) : db.beads);
        }
        const up = /^bd update (\S+) --parent (\S+)$/.exec(cmd);
        if (up) {
            if (state.failRestore) return { ok: false, output: '', error: 'Error: database is locked' };
            db.beads.find((b) => b.id === up[1]).parent = up[2];
            return OK;
        }
        const add = /^bd dep add (\S+) (\S+)$/.exec(cmd);
        if (add) {
            if (cycleOn && cycleOn(add[1], add[2])) return { ok: false, output: '', error: 'Error: adding dependency would create a cycle' };
            if (state.failRestore) return { ok: false, output: '', error: 'Error: database is locked' };
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
    /** An agent's own edit on its clone: straight in the table, never through the engine's command path. */
    const agentEdit = (fn) => fn(db);
    return { db, calls, logs, command, scope, indexOf, all, state, agentEdit };
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
    // so without the owed verify it would publish the loss. (The same run's
    // ledger -- it remembers what the pull dropped -- now with working restores.)
    h.state.failRestore = false;
    h.calls.length = 0;
    const res = await doltPushAfter('writer-owing', pushOpts(h));
    assert.equal(res.pushed, true);
    const restore = h.indexOf(/^bd update C --parent P$/);
    const push = h.indexOf(/^bd dolt push/);
    assert.ok(restore >= 0 && restore < push, `owed verify must restore before the first push:\n${h.calls.map((c) => c.cmd).join('\n')}`);

    // Paid off: a further push for this member no longer commits or restores
    // up front -- it only takes the plain pre-push read (agent-removal record).
    h.calls.length = 0;
    await doltPushAfter('writer-owing', pushOpts(h));
    assert.equal(h.all(/^bd dolt commit|^bd update|^bd dep add/).length, 0, h.calls.map((c) => c.cmd).join('\n'));
    assert.equal(h.all(/^bd list --all/).length, 1, h.calls.map((c) => c.cmd).join('\n'));
});

test('a push accepted first time takes one plain read of the pushing clone (no commit, no restore) before the push', async () => {
    const h = await buildHarness({ pushes: ['ok'] });
    await doltPushAfter('writer-c', pushOpts(h));
    assert.equal(h.all(/^bd dolt commit|^bd update|^bd dep add/).length, 0, h.calls.map((c) => c.cmd).join('\n'));
    const read = h.indexOf(/^bd list --all/);
    assert.ok(read >= 0 && read < h.indexOf(/^bd dolt push/), h.calls.map((c) => c.cmd).join('\n'));
    assert.equal(h.all(/^bd list --all/).length, 1, h.calls.map((c) => c.cmd).join('\n'));
});

test('without the verifyLinks option the reconcile path is unchanged: no restore, no commit', async () => {
    const h = await buildHarness({ pushes: ['reject', 'ok'] });
    const res = await doltPushAfter('writer-d', pushOpts(h, { verifyLinks: undefined }));
    assert.equal(res.reconciled, true);
    assert.equal(h.all(/^bd update|^bd dep add|^bd dolt commit/).length, 0, h.calls.map((c) => c.cmd).join('\n'));
    // The only link reads are the scope's pull bracket around the reconcile pull.
    const pull = h.indexOf(/^bd dolt pull/);
    const reads = h.calls.map((c, i) => [c, i]).filter(([c]) => /^bd list --all/.test(c.cmd)).map(([, i]) => i);
    assert.deepEqual(reads, [pull - 1, pull + 1], h.calls.map((c) => c.cmd).join('\n'));
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

// ---------------------------------------------------------------------------
// Agent link changes are not pull losses.
// ---------------------------------------------------------------------------

const NO_LOSS = () => {};
const blockersOf = (h, id) => (h.db.beads.find((b) => b.id === id).dependencies || [])
    .filter((d) => d.type === 'blocks').map((d) => d.depends_on_id).sort();
const trace = (h) => h.calls.map((c) => `${c.member}: ${c.cmd}`).join('\n');

test('an agent retarget (X blocked-by Y -> X blocked-by C) between two snapshots, no pull in between, is not reverted; the push carries it', async () => {
    const h = await buildHarness({ pushes: ['reject', 'ok'], merge: NO_LOSS });
    h.agentEdit((db) => { db.beads.find((b) => b.id === 'X').dependencies = [{ issue_id: 'X', depends_on_id: 'C', type: 'blocks' }]; });
    h.scope.invalidateAllBeadsCache();
    await h.scope.fetchAllBeadsShared(); // the second snapshot: the edge is gone, no pull since the first
    const res = await doltPushAfter('writer-b', pushOpts(h));
    assert.equal(res.pushed, true);
    assert.equal(res.reconciled, true, 'the reconcile pull and its verify ran');
    assert.equal(h.all(/^bd dep add|^bd update \S+ --parent /).length, 0, trace(h));
    assert.deepEqual(blockersOf(h, 'X'), ['C'], 'what the push published: the retargeted edge only');
    assert.ok(!h.logs.some((l) => l.startsWith('ERROR')), h.logs.join('\n'));
});

test('an agent reversal/cycle-break (remove X blocked-by Y, add Y blocked-by X) is not re-added and raises no ParentLinkRestoreError', async () => {
    const h = await buildHarness({ pushes: ['reject', 'ok'], merge: NO_LOSS, cycleOn: (a, b) => a === 'X' && b === 'Y' });
    h.agentEdit((db) => {
        db.beads.find((b) => b.id === 'X').dependencies = [];
        db.beads.find((b) => b.id === 'Y').dependencies = [{ issue_id: 'Y', depends_on_id: 'X', type: 'blocks' }];
    });
    const res = await doltPushAfter('writer-b', pushOpts(h));
    assert.equal(res.pushed, true);
    assert.equal(h.all(/^bd dep add X Y$/).length, 0, trace(h));
    assert.deepEqual(blockersOf(h, 'X'), []);
    assert.deepEqual(blockersOf(h, 'Y'), ['X']);
});

test('an agent reparent (C moved from P to X) is not reverted', async () => {
    const h = await buildHarness({ pushes: ['reject', 'ok'], merge: NO_LOSS });
    h.agentEdit((db) => { db.beads.find((b) => b.id === 'C').parent = 'X'; });
    h.scope.invalidateAllBeadsCache();
    await h.scope.fetchAllBeadsShared();
    const res = await doltPushAfter('writer-b', pushOpts(h));
    assert.equal(res.pushed, true);
    assert.equal(h.all(/^bd update \S+ --parent /).length, 0, trace(h));
    assert.equal(h.db.beads.find((b) => b.id === 'C').parent, 'X');
});

test('a link the conflicted reconcile pull dropped is restored even when an agent removed another one before it', async () => {
    const h = await buildHarness({ pushes: ['reject', 'ok'], merge: (db) => { delete db.beads.find((b) => b.id === 'C').parent; } });
    h.agentEdit((db) => { db.beads.find((b) => b.id === 'X').dependencies = []; });
    const res = await doltPushAfter('writer-b', pushOpts(h));
    assert.equal(res.pushed, true);
    assert.deepEqual(h.all(/^bd dep add|^bd update \S+ --parent /).map((c) => c.cmd), ['bd update C --parent P'], trace(h));
    assert.deepEqual(blockersOf(h, 'X'), [], 'the agent removal stays removed');
});

// ---------------------------------------------------------------------------
// Pull bracket: a doltPullBefore pull that merged remote changes owes a
// commit + verify before the member's first push, even a fast-forward one.
// ---------------------------------------------------------------------------

const pullOpts = (h, extra = {}) => ({
    command: h.command,
    log: (m) => h.logs.push(m),
    checkSyncRemoteConfigured: async () => true,
    remoteTipFingerprint: false,
    sleep: async () => {},
    ...extra,
});

test('a merged pre-dispatch pull followed by a fast-forward push commits the working set and verifies BEFORE the push', async () => {
    const h = await buildHarness({ pushes: ['ok'], merge: (db) => { delete db.beads.find((b) => b.id === 'C').parent; } });
    await doltPullBefore('writer-p', pullOpts(h));
    // The agent then removes a link of its own after that pull: not owed.
    h.agentEdit((db) => { db.beads.find((b) => b.id === 'X').dependencies = []; });
    h.calls.length = 0;

    const res = await doltPushAfter('writer-p', pushOpts(h));
    assert.equal(res.pushed, true);
    assert.equal(res.reconciled, false, 'the push fast-forwarded');
    const commit = h.indexOf(/^bd dolt commit -m /);
    const read = h.indexOf(/^bd list --all/);
    const restore = h.indexOf(/^bd update C --parent P$/);
    const push = h.indexOf(/^bd dolt push/);
    assert.ok(commit >= 0 && commit < read && read < restore && restore < push, trace(h));
    assert.equal(h.all(/^bd dep add/).length, 0, `the link removed after the pull is not restored:\n${trace(h)}`);
    assert.equal(h.db.beads.find((b) => b.id === 'C').parent, 'P');

    // Paid off: the next push neither commits nor restores (only the plain pre-push read).
    h.calls.length = 0;
    await doltPushAfter('writer-p', pushOpts(h));
    assert.equal(h.all(/^bd dolt commit|^bd update|^bd dep add/).length, 0, trace(h));
    assert.equal(h.all(/^bd list --all/).length, 1, trace(h));
});

test('a pull that merged nothing (skipped) owes neither the commit nor the verify', async () => {
    const h = await buildHarness({ pushes: ['ok'] });
    const pulled = await doltPullBefore('writer-q', pullOpts(h, { skipPull: true }));
    assert.equal(pulled.skipped, true);
    h.calls.length = 0;
    await doltPushAfter('writer-q', pushOpts(h));
    assert.equal(h.all(/^bd dolt commit|^bd update|^bd dep add/).length, 0, trace(h));
    assert.equal(h.all(/^bd list --all/).length, 1, `only the plain pre-push read:\n${trace(h)}`);
});

// ---------------------------------------------------------------------------
// Cross clone: a removal made and pushed on one clone is not restored when
// another clone pulls it (the run-wide agent-removal record).
// ---------------------------------------------------------------------------

/**
 * Two clones (separate in-memory tables) sharing one scripted remote: a
 * `bd dolt push` copies the pushing clone's table to the remote, a
 * `bd dolt pull` copies the remote into the pulling clone (a clean pull).
 * The backlog member is 'clone-y'.
 */
async function buildTwoClones() {
    const seed = [
        ...SEED.map((b) => ({ ...b, dependencies: b.dependencies ? b.dependencies.map((d) => ({ ...d })) : undefined })),
    ];
    seed.find((b) => b.id === 'C').dependencies = [{ issue_id: 'C', depends_on_id: 'Y', type: 'blocks' }];
    const copy = (rows) => rows.map((b) => ({ ...b, dependencies: b.dependencies ? b.dependencies.map((d) => ({ ...d })) : undefined }));
    const remote = { beads: copy(seed) };
    const clones = { 'clone-x': { beads: copy(seed) }, 'clone-y': { beads: copy(seed) } };
    const calls = [];
    const logs = [];
    const rawCommand = async (cmd, opts = {}) => {
        const member = opts.member_name;
        calls.push({ cmd, member });
        const db = clones[member];
        if (cmd.includes('bd dolt push')) { remote.beads = copy(db.beads); return OK; }
        if (cmd.includes('bd dolt pull')) { db.beads = copy(remote.beads); return { ok: true, output: 'Pulling from Dolt remote...\nPull complete.', error: null }; }
        if (cmd.startsWith('bd list --all')) {
            const byId = /--id "([^"]+)"/.exec(cmd);
            return JSON.stringify(byId ? db.beads.filter((b) => byId[1].split(',').includes(b.id)) : db.beads);
        }
        const up = /^bd update (\S+) --parent (\S+)$/.exec(cmd);
        if (up) { db.beads.find((b) => b.id === up[1]).parent = up[2]; return OK; }
        const add = /^bd dep add (\S+) (\S+)$/.exec(cmd);
        if (add) {
            // bd refuses an edge whose reverse already exists (a cycle).
            const reverse = db.beads.find((b) => b.id === add[2]);
            if ((reverse.dependencies || []).some((d) => d.depends_on_id === add[1])) {
                return { ok: false, output: '', error: 'Error: adding dependency would create a cycle' };
            }
            const bead = db.beads.find((b) => b.id === add[1]);
            bead.dependencies = [...(bead.dependencies || []), { issue_id: add[1], depends_on_id: add[2], type: 'blocks' }];
            return OK;
        }
        return OK;
    };
    const scope = createBeadsScope({
        targetIssues: ['P'],
        parseBdJson,
        getBacklogMember: () => 'clone-y',
        log: (line) => logs.push(line),
    });
    const command = scope.wrapCommand(rawCommand);
    await scope.fetchAllBeadsShared();
    calls.length = 0;
    return { remote, clones, calls, logs, command, scope };
}

test('cross clone: clone X removes one blocks edge and retargets another, pushes; clone Y pulls cleanly and pushes -- nothing is restored, no ParentLinkRestoreError', async () => {
    const h = await buildTwoClones();
    const opts = (extra = {}) => ({
        command: h.command,
        log: (m) => h.logs.push(m),
        checkSyncRemoteConfigured: async () => true,
        remoteTipFingerprint: false,
        sleep: async () => {},
        verifyLinks: (member) => h.scope.verifyLinksBeforePush(member),
        ...extra,
    });
    // Both members pull before their dispatch (sets each clone's baseline).
    await doltPullBefore('clone-x', opts());
    await doltPullBefore('clone-y', opts());
    // The planner on clone X: remove X blocked-by Y; retarget C blocked-by Y -> C blocked-by X.
    const x = h.clones['clone-x'].beads;
    x.find((b) => b.id === 'X').dependencies = [];
    x.find((b) => b.id === 'C').dependencies = [{ issue_id: 'C', depends_on_id: 'X', type: 'blocks' }];
    await doltPushAfter('clone-x', opts());
    // Clone Y pulls X's push (a clean pull: the links are present before and missing after) and pushes.
    await doltPullBefore('clone-y', opts());
    await doltPushAfter('clone-y', opts());

    const trace2 = h.calls.map((c) => `${c.member}: ${c.cmd}`).join('\n');
    assert.equal(h.calls.filter((c) => /^bd dep add|^bd update \S+ --parent /.test(c.cmd)).length, 0, trace2);
    const remoteBlockers = (id) => (h.remote.beads.find((b) => b.id === id).dependencies || []).map((d) => d.depends_on_id).sort();
    assert.deepEqual(remoteBlockers('X'), [], 'the removed edge is not on the remote');
    assert.deepEqual(remoteBlockers('C'), ['X'], 'only the retargeted edge is on the remote');
    assert.ok(!h.logs.some((l) => l.startsWith('ERROR')), h.logs.join('\n'));
});

// ---------------------------------------------------------------------------
// Baselines: every clone has a read to compare with before an agent edits it.
// ---------------------------------------------------------------------------

const twoCloneOpts = (h, extra = {}) => ({
    command: h.command,
    log: (m) => h.logs.push(m),
    checkSyncRemoteConfigured: async () => true,
    remoteTipFingerprint: false,
    sleep: async () => {},
    verifyLinks: (member) => h.scope.verifyLinksBeforePush(member),
    ...extra,
});
const twoCloneTrace = (h) => h.calls.map((c) => `${c.member}: ${c.cmd}`).join('\n');
const remoteBlockersOf = (h, id) => (h.remote.beads.find((b) => b.id === id).dependencies || []).map((d) => d.depends_on_id).sort();

test('backlog planner whose first pull is skipped breaks a cycle and pushes; a doer clone then pulls and pushes -- nothing is restored, no ParentLinkRestoreError', async () => {
    // The backlog clone (clone-y) got no pull bracket: the launch gate pulled
    // before the scope was known and the first planner's pull is skipped.
    // Its only earlier read is the fresh snapshot buildTwoClones took.
    const h = await buildTwoClones();
    const pulled = await doltPullBefore('clone-y', twoCloneOpts(h, { skipPull: true }));
    assert.equal(pulled.skipped, true);
    // The planner reverses X blocked-by Y into Y blocked-by X (a cycle-break).
    const y = h.clones['clone-y'].beads;
    y.find((b) => b.id === 'X').dependencies = [];
    y.find((b) => b.id === 'Y').dependencies = [{ issue_id: 'Y', depends_on_id: 'X', type: 'blocks' }];
    await doltPushAfter('clone-y', twoCloneOpts(h));
    // A doer member pulls the planner's push (present before, missing after) and pushes.
    await doltPullBefore('clone-x', twoCloneOpts(h));
    await doltPushAfter('clone-x', twoCloneOpts(h));

    assert.equal(h.calls.filter((c) => /^bd dep add|^bd update \S+ --parent /.test(c.cmd)).length, 0, twoCloneTrace(h));
    assert.deepEqual(remoteBlockersOf(h, 'X'), [], 'the reversed edge is not brought back');
    assert.deepEqual(remoteBlockersOf(h, 'Y'), ['X']);
    assert.ok(!h.logs.some((l) => l.startsWith('ERROR')), h.logs.join('\n'));
});

test('a member with no baseline gets one before its agent runs (ensureLinkBaseline); its removal is then not restored by another clone', async () => {
    const h = await buildTwoClones();
    // clone-x's pull is skipped (no bracket, no read): the dispatch bracket
    // reads it before the agent runs.
    await doltPullBefore('clone-x', twoCloneOpts(h, { skipPull: true }));
    h.calls.length = 0;
    assert.deepEqual(await h.scope.ensureLinkBaseline('clone-x'), { read: true });
    assert.deepEqual(h.calls.map((c) => `${c.member}: ${c.cmd.split(' ').slice(0, 3).join(' ')}`), ['clone-x: bd list --all'], twoCloneTrace(h));
    // A second call issues nothing: the clone already has a baseline.
    h.calls.length = 0;
    assert.deepEqual(await h.scope.ensureLinkBaseline('clone-x'), { read: false });
    assert.equal(h.calls.length, 0);
    // The agent on clone-x removes X blocked-by Y and pushes; the backlog clone pulls and pushes.
    h.clones['clone-x'].beads.find((b) => b.id === 'X').dependencies = [];
    await doltPushAfter('clone-x', twoCloneOpts(h));
    await doltPullBefore('clone-y', twoCloneOpts(h));
    await doltPushAfter('clone-y', twoCloneOpts(h));
    await h.scope.fetchAllBeadsShared();

    assert.equal(h.calls.filter((c) => /^bd dep add|^bd update \S+ --parent /.test(c.cmd)).length, 0, twoCloneTrace(h));
    assert.deepEqual(remoteBlockersOf(h, 'X'), []);
    assert.ok(!h.logs.some((l) => l.startsWith('ERROR')), h.logs.join('\n'));
});

test('the dispatch bracket asks for a link baseline before a beads-pushing agent runs, and not for a read-only one', async () => {
    const seen = [];
    const order = [];
    const gitSync = createGitSync({
        brackets: createSyncBrackets(),
        command: async () => OK,
        log: () => {},
        branch: 'b',
        syncMemberBefore: async () => {},
        syncMemberAfterOrdered: async () => { order.push('sync-after'); },
        isNoMutationDispatchFailure: () => false,
        ensureLinkBaseline: async (member) => { seen.push(member); order.push('baseline'); return { read: true }; },
    });
    await gitSync.withGitSync('m1', false, async () => { order.push('dispatch'); }, { pushBeads: true, needsVcsAuth: false, skipPreDispatchSync: true });
    assert.deepEqual(seen, ['m1']);
    assert.deepEqual(order, ['baseline', 'dispatch', 'sync-after']);
    seen.length = 0;
    await gitSync.withGitSync('m2', false, async () => {}, { pushBeads: false, needsVcsAuth: false, skipPreDispatchSync: true });
    assert.deepEqual(seen, [], 'a read-only dispatch pushes no beads, so it needs no baseline');
});
