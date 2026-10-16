// A push step that reports success is only treated as landed when the remote
// actually moved. D-push: refs/dolt/data is read before and after the push;
// an unchanged tip with unpushed local changes is a push that did not land.
// G-push: the remote branch must contain the local HEAD afterwards.
//
// Every command below is a scripted mock (no git, no bd, no network). ASCII only.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    doltPushAfter,
    parseBdDiffPending,
    invalidateSyncRemoteCache,
    clearLastSyncedTip,
    clearTipProbeFailures,
    setLastSyncedTip,
    getLastSyncedTip,
} from '../fleet-sprint/dolt-sync.mjs';
import { syncMemberAfter, checkGitPushLanded } from '../fleet-sprint/member-sync.mjs';
import { DoltSyncError, GitSyncError } from '../fleet-sprint/errors.mjs';

beforeEach(() => {
    invalidateSyncRemoteCache();
    clearLastSyncedTip();
    clearTipProbeFailures();
});

const OK = { ok: true, output: '', error: null };
const out = (output) => ({ ok: true, output, error: null });
const REMOTE_JSON = out(JSON.stringify({ value: 'git+https://example.invalid/org/beads.git' }));
const PROBE_URL = 'https://example.invalid/org/beads.git';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);
const doltTip = (sha) => out(`${sha}\trefs/dolt/data\n`);
const VC_STATUS = out(JSON.stringify({ branch: 'main', commit: 'x', schema_version: 1 }));
const DIFF_PENDING = out(JSON.stringify([{ IssueID: 't-1', DiffType: 'modified' }]));
const DIFF_NONE = out('No changes between remotes/origin/main and main\n');

/**
 * A shared Dolt remote: `remote.tip` is refs/dolt/data. `onPush(remote, n)`
 * decides what the n-th (1-based) push does to it; it may also throw-free
 * return a failure result.
 */
function makeDoltWorld({ initialTip, onPush, diff = DIFF_PENDING }) {
    const remote = { tip: initialTip };
    const calls = [];
    let pushes = 0;
    const command = async (cmd) => {
        calls.push(cmd);
        if (cmd.includes('bd config get sync.remote')) return REMOTE_JSON;
        if (cmd.includes(' ls-remote ')) return remote.tip ? doltTip(remote.tip) : out('');
        if (cmd.includes('bd vc status --json')) return VC_STATUS;
        if (cmd.startsWith('bd diff ')) return typeof diff === 'function' ? diff(remote) : diff;
        if (cmd.includes('bd dolt push')) {
            pushes += 1;
            const r = onPush(remote, pushes);
            return r || OK;
        }
        return OK;
    };
    return { remote, calls, command, pushCount: () => pushes };
}

const landedLine = (logs) => logs.filter((l) => /landed/.test(l) && !/did NOT land|not land/.test(l));

test('parseBdDiffPending recognizes the in-sync text, a change list, and unknown output', () => {
    assert.equal(parseBdDiffPending('No changes between remotes/origin/main and main'), false);
    assert.equal(parseBdDiffPending('[]'), false);
    assert.equal(parseBdDiffPending(JSON.stringify([{ IssueID: 'x' }])), true);
    assert.equal(parseBdDiffPending(''), null);
    assert.equal(parseBdDiffPending('ok (mocked)'), null);
    assert.equal(parseBdDiffPending('{"error":"branch not found"}'), null);
});

test('D-push: push reports success but refs/dolt/data did not move -> not logged as landed, reported as a failure', async () => {
    const world = makeDoltWorld({ initialTip: SHA_A, onPush: () => OK }); // never moves the tip
    setLastSyncedTip('m1', SHA_A, PROBE_URL);
    const logs = [];
    await assert.rejects(
        () => doltPushAfter('m1', { command: world.command, log: (l) => logs.push(l), sleep: async () => {} }),
        (err) => {
            assert.ok(err instanceof DoltSyncError, `expected DoltSyncError, got ${err && err.constructor.name}`);
            assert.equal(err.details.kind, 'push-not-landed');
            assert.match(err.message, /did not land/);
            return true;
        },
    );
    assert.deepEqual(landedLine(logs), [], `a push that did not land was logged as landed:\n${logs.join('\n')}`);
    assert.equal(world.pushCount(), 2, 'one bounded retry of the unlanded push');
    assert.equal(getLastSyncedTip('m1'), undefined, 'the fingerprint is forgotten');
});

test('D-push: a push whose remote tip moved logs landed exactly as before (regression)', async () => {
    const world = makeDoltWorld({ initialTip: SHA_A, onPush: (remote) => { remote.tip = SHA_B; } });
    setLastSyncedTip('m1', SHA_A, PROBE_URL);
    const logs = [];
    const res = await doltPushAfter('m1', { command: world.command, log: (l) => logs.push(l) });
    assert.deepEqual(res, { ok: true, member: 'm1', pushed: true, reconciled: false });
    assert.equal(landedLine(logs).length, 1);
    assert.match(landedLine(logs)[0], /D-push for member 'm1' landed; forgetting its remote-tip fingerprint/);
    assert.equal(getLastSyncedTip('m1'), undefined);
    assert.ok(!world.calls.some((c) => c.startsWith('bd diff ')), 'a moved tip needs no unpushed-change read');
});

test('D-push: a remote that advanced past ours because of another machine is not a failure', async () => {
    // Ours lands at SHA_B, then a foreign push lands SHA_C before our post-push read.
    const world = makeDoltWorld({ initialTip: SHA_A, onPush: (remote) => { remote.tip = SHA_C; } });
    const res = await doltPushAfter('m1', { command: world.command, log: () => {} });
    assert.equal(res.pushed, true);
    assert.equal(getLastSyncedTip('m1'), undefined, 'the foreign SHA is never recorded as ours');
});

test('D-push: an unlanded push that lands on its retry succeeds', async () => {
    const world = makeDoltWorld({ initialTip: SHA_A, onPush: (remote, n) => { if (n === 2) remote.tip = SHA_B; } });
    const logs = [];
    const res = await doltPushAfter('m1', { command: world.command, log: (l) => logs.push(l), sleep: async () => {} });
    assert.equal(res.pushed, true);
    assert.equal(world.pushCount(), 2);
    assert.ok(logs.some((l) => /did NOT land/.test(l)), 'the unlanded first push is logged');
});

test('D-push: a no-op push (tip unchanged, nothing unpushed) succeeds without a landed log', async () => {
    const world = makeDoltWorld({ initialTip: SHA_A, onPush: () => OK, diff: DIFF_NONE });
    setLastSyncedTip('m1', SHA_A, PROBE_URL);
    const logs = [];
    const res = await doltPushAfter('m1', { command: world.command, log: (l) => logs.push(l) });
    assert.equal(res.pushed, true);
    assert.equal(res.upToDate, true);
    assert.equal(world.pushCount(), 1);
    assert.deepEqual(landedLine(logs), []);
    assert.ok(logs.some((l) => /nothing to publish/.test(l)));
    assert.equal(getLastSyncedTip('m1'), undefined, 'a no-op push still never keeps a fingerprint');
});

test('D-push: the first push to an empty remote (no refs/dolt/data before) counts as moved', async () => {
    const world = makeDoltWorld({ initialTip: null, onPush: (remote) => { remote.tip = SHA_A; } });
    const res = await doltPushAfter('m1', { command: world.command, log: () => {} });
    assert.equal(res.pushed, true);
});

test('D-push reconcile path: a re-push that does not land is not mistaken for landed because ANOTHER writer moved the remote', async () => {
    // First push rejected non-fast-forward: another writer moved the tip
    // A -> C. Reconcile pull succeeds; the re-push exits 0 but never lands.
    const world = makeDoltWorld({
        initialTip: SHA_A,
        onPush: (remote, n) => {
            if (n === 1) {
                remote.tip = SHA_C;
                return { ok: false, output: '', error: 'Updates were rejected because the remote contains work that you do not have locally.' };
            }
            return OK;
        },
    });
    const logs = [];
    await assert.rejects(
        () => doltPushAfter('m1', { command: world.command, log: (l) => logs.push(l), sleep: async () => {} }),
        (err) => err instanceof DoltSyncError && err.details.kind === 'push-not-landed',
    );
    assert.deepEqual(landedLine(logs), []);
});

test('D-push: an unreadable remote tip keeps the old behavior and says it could not verify', async () => {
    const calls = [];
    const command = async (cmd) => {
        calls.push(cmd);
        if (cmd.includes('bd config get sync.remote')) return REMOTE_JSON;
        if (cmd.includes(' ls-remote ')) return { ok: false, output: '', error: 'Could not resolve host' };
        return OK;
    };
    const logs = [];
    const res = await doltPushAfter('m1', { command, log: (l) => logs.push(l) });
    assert.equal(res.pushed, true);
    assert.ok(logs.some((l) => /could not be verified/.test(l)), logs.join('\n'));
});

// ---------------------------------------------------------------------------
// G-push
// ---------------------------------------------------------------------------

const HEAD = 'd'.repeat(40);
const REMOTE_TIP = 'e'.repeat(40);

function makeGitWorld({ remoteTip, revListCount = '0', fetchOk = true }) {
    const calls = [];
    const command = async (cmd) => {
        calls.push(cmd);
        if (cmd === 'git rev-parse HEAD') return out(`${HEAD}\n`);
        if (cmd.startsWith('git ls-remote ')) return out(remoteTip ? `${remoteTip}\trefs/heads/feat/x\n` : '');
        if (cmd.startsWith('git fetch ')) return fetchOk ? OK : { ok: false, output: '', error: 'fetch failed' };
        if (cmd.startsWith('git rev-list --count ')) return out(`${revListCount}\n`);
        return OK; // git push
    };
    return { calls, command };
}

test('G-push: remote branch does not contain the local HEAD afterwards -> reported as a failure', async () => {
    const world = makeGitWorld({ remoteTip: REMOTE_TIP, revListCount: '2' });
    await assert.rejects(
        () => syncMemberAfter('m1', { command: world.command, branch: 'feat/x', log: () => {} }),
        (err) => {
            assert.ok(err instanceof GitSyncError, `expected GitSyncError, got ${err && err.constructor.name}`);
            assert.equal(err.details.kind, 'push-not-landed');
            assert.match(err.message, /did NOT land/);
            return true;
        },
    );
    assert.ok(world.calls.includes(`git rev-list --count ${HEAD} --not ${REMOTE_TIP}`));
});

test('G-push: remote branch missing after a successful push -> reported as a failure', async () => {
    const world = makeGitWorld({ remoteTip: null });
    await assert.rejects(
        () => syncMemberAfter('m1', { command: world.command, branch: 'feat/x', log: () => {} }),
        (err) => err instanceof GitSyncError && /does not exist on 'origin'/.test(err.message),
    );
});

test('G-push: remote tip equal to the local HEAD lands with no fetch', async () => {
    const world = makeGitWorld({ remoteTip: HEAD });
    const res = await syncMemberAfter('m1', { command: world.command, branch: 'feat/x', log: () => {} });
    assert.deepEqual(res, { ok: true, member: 'm1', pushed: true, rebased: false });
    assert.ok(!world.calls.some((c) => c.startsWith('git fetch ')));
});

test('G-push: a remote advanced by another writer on top of our HEAD is not a failure', async () => {
    const world = makeGitWorld({ remoteTip: REMOTE_TIP, revListCount: '0' });
    const res = await syncMemberAfter('m1', { command: world.command, branch: 'feat/x', log: () => {} });
    assert.equal(res.pushed, true);
    assert.ok(world.calls.includes('git fetch origin feat/x'));
});

test('G-push: an inconclusive check (fetch failed) keeps the old behavior and logs it', async () => {
    const world = makeGitWorld({ remoteTip: REMOTE_TIP, fetchOk: false });
    const logs = [];
    const res = await syncMemberAfter('m1', { command: world.command, branch: 'feat/x', log: (l) => logs.push(l) });
    assert.equal(res.pushed, true);
    assert.ok(logs.some((l) => /could not be verified/.test(l)), logs.join('\n'));
});

test('checkGitPushLanded refuses names outside the safe charset instead of building a command', async () => {
    const calls = [];
    const v = await checkGitPushLanded('m1', { command: async (c) => { calls.push(c); return OK; }, remote: 'origin', branch: 'feat;rm -rf' });
    assert.equal(v.status, 'unverified');
    assert.deepEqual(calls, []);
});
