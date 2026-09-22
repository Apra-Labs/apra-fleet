// The D-pull / D-push brackets against a GENUINELY CONFIGURED sync.remote
// (apra-fleet-j918.5.1).
//
// THE GAP THIS CLOSES. Every other dolt-sync suite in this package drives
// doltPullBefore/doltPushAfter with sync.remote EMPTY -- the recorded bd
// fixtures answer `bd config get sync.remote --json` with `{"value":""}` in
// all 2766 occurrences, and real-bd mode runs in a scratch `bd init` workspace
// that has no sync.remote either, synthesizing `bd dolt pull/push` as clean
// no-ops. So both brackets took their pre-gate exit,
// `{ skipped: true, reason: 'no-remote' }`, in every mode: the entire push /
// reject / reconcile / re-push path below that gate had no coverage anywhere.
//
// WHAT RUNS HERE. helpers/dolt-remote-fixture.mjs stands up a real bare git
// repo as the Dolt data remote (beads syncs through `refs/dolt/data` on a git
// remote, which is what dolt-sync.mjs's own tip probe assumes), points a real
// bd-level sync.remote at it over `file://`, and translates the brackets'
// commands into real git. Assertions are therefore about OUTCOMES -- what SHA
// and which files landed on the remote, what the member's local tip became --
// not merely that a command was attempted. No dolt binary, no bd binary, no
// network, no credentials.
//
// WALL CLOCK: ~7s for the whole file on a 2026 MacBook Pro (6 tests, each
// building its own throwaway bare remote plus three real clones -- that cost
// is git process spawns, not waiting). Two orders of magnitude under the
// suite's ~5-minute per-file budget. Every call injects
// `sleep: noSleep`, so no case can ever spend runDoltStep's real backoff
// ladder (~15.5s per exhausted step) -- the mistake that made
// dolt-sync-brackets.test.mjs a CI outlier.
//
// HOST GATING: explicit and loud. A host without a usable `git`, or whose
// temp path would produce a sync.remote URL dolt-sync's SAFE_REMOTE_URL_RE
// rejects, prints a DEGRADED line and skips WITH THAT REASON attached, rather
// than reporting a silent pass.
//
// ASCII only.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
    doltPullBefore,
    doltPushAfter,
    getLastSyncedTip,
    invalidateSyncRemoteCache,
    clearLastSyncedTip,
    clearTipProbeFailures,
} from '../fleet-sprint/dolt-sync.mjs';
import { DoltSyncError } from '../fleet-sprint/errors.mjs';
import { createDoltRemoteFixture, probeDoltRemoteFixtureSupport } from './helpers/dolt-remote-fixture.mjs';

const support = probeDoltRemoteFixtureSupport();
if (!support.ok) {
    console.error(`[dolt-sync-configured-remote] DEGRADED -- configured-sync.remote coverage did NOT run on this host: ${support.reason}`);
}

/** runDoltStep's backoff is injectable; never spend real time on it. */
const noSleep = async () => {};

describe('configured sync.remote: the non-skip D-pull/D-push path', { skip: support.ok ? false : support.reason }, () => {
    beforeEach(() => {
        // The sync.remote answer, the remote-tip fingerprint and the probe
        // failure counters are module-level memos shared by every test here.
        invalidateSyncRemoteCache();
        clearLastSyncedTip();
        clearTipProbeFailures();
    });

    test('D-push publishes the member beads mutation: the remote refs/dolt/data really moves', async () => {
        const fx = createDoltRemoteFixture({ member: 'push-member' });
        try {
            const remoteBefore = fx.remoteTip();
            const mutated = fx.mutate('closed-bead-1');
            assert.notEqual(mutated, remoteBefore, 'the member clone is genuinely ahead of the remote');
            assert.equal(fx.remoteTip(), remoteBefore, 'and nothing has reached the remote yet');

            const res = await doltPushAfter(fx.member, { command: fx.command, sleep: noSleep });

            // deepEqual (not a property spot-check) is the proof this is NOT
            // the skip path: the no-remote exit returns `skipped: true,
            // reason: 'no-remote'` alongside these keys.
            assert.deepEqual(res, { ok: true, member: 'push-member', pushed: true, reconciled: false });
            assert.equal(fx.commandsOf('bd dolt push').length, 1, 'exactly one push was issued');

            assert.equal(fx.remoteTip(), mutated, 'the remote refs/dolt/data now points at the pushed commit');
            assert.ok(
                fx.remoteFiles().includes('beads/closed-bead-1.json'),
                `the mutation's data landed on the remote; remote tree was ${JSON.stringify(fx.remoteFiles())}`,
            );
        } finally {
            fx.cleanup();
        }
    });

    test("D-pull fetches another machine's published beads state into this clone", async () => {
        const fx = createDoltRemoteFixture({ member: 'pull-member' });
        try {
            const localBefore = fx.localTip();
            const peerTip = fx.peerPublish('peer-closed-bead');
            assert.equal(fx.remoteTip(), peerTip, 'the peer published to the shared remote');
            assert.equal(fx.localTip(), localBefore, 'the member clone has not seen it yet');
            assert.ok(!fx.localFiles().includes('beads/peer-closed-bead.json'));

            const res = await doltPullBefore(fx.member, { command: fx.command, sleep: noSleep });

            assert.deepEqual(res, { ok: true, member: 'pull-member' }, 'the real pull ran (no skip, no reason)');
            assert.equal(fx.commandsOf('bd dolt pull').length, 1, 'exactly one pull was issued');

            assert.equal(fx.localTip(), peerTip, "the local refs/dolt/data fast-forwarded onto the peer's commit");
            assert.ok(
                fx.localFiles().includes('beads/peer-closed-bead.json'),
                `the peer's beads data is now in this clone; local tree was ${JSON.stringify(fx.localFiles())}`,
            );
            assert.equal(getLastSyncedTip('pull-member'), peerTip, 'the successful pull recorded the remote-tip fingerprint');
        } finally {
            fx.cleanup();
        }
    });

    test('a second D-pull against an unchanged remote skips as remote-unchanged -- a skip earned by a real pull, not by an absent remote', async () => {
        const fx = createDoltRemoteFixture({ member: 'fingerprint-member' });
        try {
            const peerTip = fx.peerPublish('peer-bead');
            const first = await doltPullBefore(fx.member, { command: fx.command, sleep: noSleep });
            assert.deepEqual(first, { ok: true, member: 'fingerprint-member' });

            const second = await doltPullBefore(fx.member, { command: fx.command, sleep: noSleep });

            assert.deepEqual(second, {
                ok: true,
                member: 'fingerprint-member',
                skipped: true,
                reason: 'remote-unchanged',
                remoteTip: peerTip,
            }, "the second call skips on the tip fingerprint, NOT on 'no-remote'");
            assert.equal(fx.commandsOf('bd dolt pull').length, 1, 'the second call issued no pull command');
            assert.equal(fx.commandsOf('ls-remote').length, 2, 'but it did re-probe the remote tip for real');
            assert.equal(fx.localTip(), peerTip, 'the clone is still exactly at the tip the first pull brought it to');
            assert.equal(fx.remoteTip(), peerTip, 'and the remote never moved');
        } finally {
            fx.cleanup();
        }
    });

    test('a push rejected by another writer reconciles once and lands BOTH writers data on the remote', async () => {
        const fx = createDoltRemoteFixture({ member: 'loser-member' });
        try {
            // Another machine wins the race, then this member commits its own
            // beads mutation on top of the older state: a real non-fast-forward.
            const peerTip = fx.peerPublish('peer-won-bead');
            const localTip = fx.mutate('local-loser-bead');
            assert.notEqual(localTip, peerTip);

            const res = await doltPushAfter(fx.member, { command: fx.command, sleep: noSleep });

            assert.deepEqual(res, { ok: true, member: 'loser-member', pushed: true, reconciled: true });
            assert.deepEqual(
                fx.calls.map((c) => c.cmd).filter((c) => c.includes('bd dolt')),
                ['bd dolt push', 'bd dolt pull', 'bd dolt push'],
                'exactly one bounded reconcile: push (rejected), one pull, one re-push',
            );

            const remoteFiles = fx.remoteFiles();
            assert.ok(remoteFiles.includes('beads/peer-won-bead.json'), `the winner's data survived: ${JSON.stringify(remoteFiles)}`);
            assert.ok(remoteFiles.includes('beads/local-loser-bead.json'), `the loser's data was published too: ${JSON.stringify(remoteFiles)}`);
            assert.equal(fx.remoteTip(), fx.localTip(), 'the remote ends at exactly the reconciled commit this clone built');
            assert.equal(getLastSyncedTip('loser-member'), undefined, 'a landed push forgets the fingerprint (only the push knows the new SHA)');
        } finally {
            fx.cleanup();
        }
    });

    test('a configured-but-broken remote FAILS the push instead of downgrading it to a benign no-remote skip', async () => {
        const fx = createDoltRemoteFixture({ member: 'broken-remote-member' });
        try {
            const mutated = fx.mutate('unpublishable-bead');
            // sync.remote stays configured; the repository it names is gone.
            fx.destroyRemote();

            await assert.rejects(
                () => doltPushAfter(fx.member, { command: fx.command, sleep: noSleep }),
                (err) => {
                    assert.ok(err instanceof DoltSyncError, `expected DoltSyncError, got ${err && err.constructor && err.constructor.name}: ${err && err.message}`);
                    assert.match(err.message, /D-push/);
                    assert.ok(!/no dolt remote configured/i.test(err.message), 'a live sync.remote must never be reported as an absent one');
                    return true;
                },
            );
            assert.ok(fx.commandsOf('bd dolt push').length >= 1, 'the push was genuinely attempted, not gated out');
            assert.equal(fx.localTip(), mutated, 'the unpublished mutation is still sitting in the local clone');
        } finally {
            fx.cleanup();
        }
    });

    test('control: the same fixture with sync.remote neutralized takes the no-remote skip and issues no dolt command', async () => {
        const fx = createDoltRemoteFixture({ member: 'neutralized-member' });
        try {
            const mutated = fx.mutate('never-published-bead');
            fx.neutralizeSyncRemote();

            const push = await doltPushAfter(fx.member, { command: fx.command, sleep: noSleep });
            invalidateSyncRemoteCache();
            const pull = await doltPullBefore(fx.member, { command: fx.command, sleep: noSleep });

            assert.deepEqual(push, { ok: true, member: 'neutralized-member', pushed: false, reconciled: false, skipped: true, reason: 'no-remote' });
            assert.deepEqual(pull, { ok: true, member: 'neutralized-member', skipped: true, reason: 'no-remote' });
            assert.equal(fx.commandsOf('bd dolt').length, 0, 'no dolt command was issued at all');
            assert.notEqual(fx.remoteTip(), mutated, 'and nothing reached the reachable remote');
        } finally {
            fx.cleanup();
        }
    });
});
