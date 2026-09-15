// The refs/dolt/data tip fingerprint driven against a REAL `git ls-remote`
// (apra-fleet-j918.6.5).
//
// THE GAP THIS CLOSES. Before this file, the entire oracle for
// toGitLsRemoteUrl / parseLsRemoteTip / getLastSyncedTip / setLastSyncedTip /
// clearLastSyncedTip was a hand-built fixture in dolt-sync-budget.test.mjs
// (`lsRemote = (sha) => ({ ok: true, output: `${sha}\trefs/dolt/data\n`, error: null })`):
// no test anywhere contacted a real `git ls-remote`. A wrong fingerprint means
// a D-pull that SHOULD happen silently does not, and that failure mode had no
// coverage. (dolt-sync-configured-remote.test.mjs DOES drive one real
// ls-remote -- its "remote-unchanged" skip test -- so the "unchanged ->
// skip" direction already had partial real coverage; the "changed -> forced
// real pull" direction, and the raw parse/get/set/clear cycle on genuine
// output, plus the empty/extra-refs/non-zero-exit shape hazards, did not.)
//
// WHAT RUNS HERE. This is additive, not a replacement for the hand-built
// fixture (which stays, and still earns its keep for the memoization/budget
// assertions that do not need a real remote). It follows the two
// real-execution precedents this package already has rather than inventing a
// third:
//   - helpers/dolt-remote-fixture.mjs (apra-fleet-j918.5.1) for the
//     bracket-level assertions: a real bare git repo as the Dolt data
//     remote, a real member clone, a real peer clone, real `git ls-remote`
//     inside the fixture's own injected command().
//   - a direct `spawnSync('git', ['ls-remote', ...])` -- the same shape
//     dolt-sync-brackets.test.mjs's eft.31 hazard-remote test uses -- for the
//     shape-hazard assertions (empty output, extra refs, non-zero exit) that
//     do not need the full bracket.
// No dolt binary, no bd binary, no network, no credentials: a `file://` bare
// repo is enough for ls-remote to succeed, return nothing, return extra refs,
// or fail exactly as a hosted one would.
//
// HOST GATING: explicit and loud, reusing dolt-remote-fixture's own probe
// (a host without `git`, without a writable temp dir, or whose temp path
// would produce a sync.remote URL dolt-sync's own safe-charset gate rejects,
// prints a DEGRADED line and skips WITH THAT REASON attached).
//
// ASCII only.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    doltPullBefore,
    getLastSyncedTip,
    setLastSyncedTip,
    clearLastSyncedTip,
    invalidateSyncRemoteCache,
    clearTipProbeFailures,
    parseLsRemoteTip,
} from '../fleet-sprint/dolt-sync.mjs';
import { DoltSyncError } from '../fleet-sprint/errors.mjs';
import { createDoltRemoteFixture, probeDoltRemoteFixtureSupport } from './helpers/dolt-remote-fixture.mjs';

const support = probeDoltRemoteFixtureSupport();
if (!support.ok) {
    console.error(`[dolt-sync-tip-fingerprint-real] DEGRADED -- real ls-remote fingerprint coverage did NOT run on this host: ${support.reason}`);
}

/** runDoltStep's backoff is injectable; never spend real time on it. */
const noSleep = async () => {};

/** A real `git ls-remote` -- no mock anywhere in this call. */
function realLsRemote(url, ref) {
    const args = ref ? ['ls-remote', url, ref] : ['ls-remote', url];
    const res = spawnSync('git', args, { encoding: 'utf8' });
    return {
        status: res.status,
        stdout: res.stdout || '',
        stderr: res.stderr || '',
    };
}

describe('remote-tip fingerprint: real git ls-remote, no hand-built fixture (apra-fleet-j918.6.5)', { skip: support.ok ? false : support.reason }, () => {
    beforeEach(() => {
        // The fingerprint map and probe-failure counters are module-level
        // memos shared by every test here.
        invalidateSyncRemoteCache();
        clearLastSyncedTip();
        clearTipProbeFailures();
    });

    test('a real ls-remote against a real refs/dolt/data ref drives parseLsRemoteTip and the get/set/clear cycle', () => {
        const fx = createDoltRemoteFixture({ member: 'cycle-member', prefix: 'j918-6-5-cycle-' });
        try {
            const seedTip = fx.remoteTip();
            const probe = realLsRemote(fx.remoteUrl, 'refs/dolt/data');
            assert.equal(probe.status, 0, `real git ls-remote must succeed against a live bare repo: ${probe.stderr}`);
            const sha = parseLsRemoteTip(probe.stdout);
            assert.equal(sha, seedTip, 'parseLsRemoteTip reads exactly the seeded refs/dolt/data SHA from genuine ls-remote output');

            assert.equal(getLastSyncedTip('cycle-member'), undefined, 'nothing recorded yet');
            setLastSyncedTip('cycle-member', sha, fx.remoteUrl);
            assert.equal(getLastSyncedTip('cycle-member'), sha, 'set/get round-trips the genuinely observed SHA');

            // Advance the remote for real, then probe again for real.
            const peerTip = fx.peerPublish('peer-advance');
            assert.notEqual(peerTip, seedTip, 'precondition: the remote genuinely moved');
            const probeAfterMove = realLsRemote(fx.remoteUrl, 'refs/dolt/data');
            assert.equal(probeAfterMove.status, 0, `real git ls-remote must succeed after the remote advanced: ${probeAfterMove.stderr}`);
            const movedSha = parseLsRemoteTip(probeAfterMove.stdout);
            assert.equal(movedSha, peerTip, 'a fresh real probe reads the newly advanced tip');
            assert.notEqual(movedSha, getLastSyncedTip('cycle-member'), 'the freshly observed tip differs from the still-recorded fingerprint');

            const cleared = clearLastSyncedTip('cycle-member');
            assert.equal(cleared, 1);
            assert.equal(getLastSyncedTip('cycle-member'), undefined, 'clear really forgets the fingerprint');
        } finally {
            fx.cleanup();
        }
    });

    test('advancing the remote makes the D-pull fingerprint differ and forces a real pull; leaving it unchanged makes the skip fire (both directions, real git throughout)', async () => {
        const fx = createDoltRemoteFixture({ member: 'advance-member', prefix: 'j918-6-5-advance-' });
        try {
            const peerTip1 = fx.peerPublish('peer-bead-1');
            const first = await doltPullBefore(fx.member, { command: fx.command, sleep: noSleep });
            assert.deepEqual(first, { ok: true, member: fx.member }, 'the first D-pull is real -- nothing was recorded yet');
            assert.equal(getLastSyncedTip(fx.member), peerTip1, 'the real pull recorded a fingerprint read from a genuine ls-remote');

            // Direction 1: the remote is UNCHANGED -> the skip fires.
            const second = await doltPullBefore(fx.member, { command: fx.command, sleep: noSleep });
            assert.deepEqual(second, {
                ok: true, member: fx.member, skipped: true, reason: 'remote-unchanged', remoteTip: peerTip1,
            }, 'an unmoved remote is provably skipped -- earned by a real ls-remote match, not an absent remote');
            assert.equal(fx.commandsOf('bd dolt pull').length, 1, 'still exactly one real pull so far');
            assert.equal(fx.commandsOf('ls-remote').length, 2, 'both calls genuinely re-probed the remote tip');

            // Direction 2: the remote genuinely ADVANCES -> the fingerprint
            // differs and a real pull is forced, never another skip.
            const peerTip2 = fx.peerPublish('peer-bead-2');
            assert.notEqual(peerTip2, peerTip1, 'precondition: the remote genuinely advanced');

            const third = await doltPullBefore(fx.member, { command: fx.command, sleep: noSleep });
            assert.deepEqual(third, { ok: true, member: fx.member }, 'the changed fingerprint forces a genuine third pull, not a skip');
            assert.equal(fx.commandsOf('bd dolt pull').length, 2, 'exactly one more real pull was issued once the remote moved');
            assert.equal(fx.localTip(), peerTip2, 'the member clone really fast-forwarded onto the newly published tip');
            assert.equal(getLastSyncedTip(fx.member), peerTip2, 'the fingerprint now reflects the new tip, read from a genuine ls-remote');
        } finally {
            fx.cleanup();
        }
    });

    test('shape hazard: a result with extra refs alongside refs/dolt/data (pointing at a DIFFERENT SHA) still yields exactly the dolt-data SHA', () => {
        // dolt-remote-fixture.mjs deliberately keeps refs/heads/main and
        // refs/dolt/data in lockstep (same SHA always), so it cannot exercise
        // a genuine ref-selection mistake -- picking the wrong line would
        // accidentally read the right SHA anyway. Build a small standalone
        // remote here where the two refs diverge for real, so parseLsRemoteTip
        // choosing the wrong line is observable.
        const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'j918-6-5-extra-')));
        try {
            const remoteDir = path.join(root, 'diverged-remote.git');
            const remoteUrl = `file://${remoteDir}`;
            const workDir = path.join(root, 'work');
            const run = (args, cwd) => {
                const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
                if (res.status !== 0) throw new Error(`fixture setup: 'git ${args.join(' ')}' failed: ${res.stdout}${res.stderr}`);
                return res.stdout.trim();
            };
            run(['init', '--bare', '-b', 'main', remoteDir], root);
            fs.mkdirSync(workDir);
            run(['init', '-b', 'main'], workDir);
            run(['config', 'user.email', 'j918-6-5@test.local'], workDir);
            run(['config', 'user.name', 'j918-6-5'], workDir);

            fs.writeFileSync(path.join(workDir, 'README.md'), 'first\n', 'utf-8');
            run(['add', 'README.md'], workDir);
            run(['commit', '-m', 'first'], workDir);
            const firstSha = run(['rev-parse', 'HEAD'], workDir);
            run(['update-ref', 'refs/dolt/data', firstSha], workDir);

            // main advances again, but refs/dolt/data deliberately does NOT --
            // the two refs now genuinely point at different commits.
            fs.writeFileSync(path.join(workDir, 'README.md'), 'second\n', 'utf-8');
            run(['add', 'README.md'], workDir);
            run(['commit', '-m', 'second'], workDir);
            const secondSha = run(['rev-parse', 'HEAD'], workDir);
            assert.notEqual(secondSha, firstSha, 'precondition: the two commits are genuinely different');

            run(['push', remoteUrl, 'refs/heads/main:refs/heads/main', 'refs/dolt/data:refs/dolt/data'], workDir);

            // No ref filter: real git returns HEAD, refs/heads/main (at
            // secondSha) AND refs/dolt/data (at firstSha) in one genuine
            // multi-line result carrying two DIFFERENT SHAs.
            const probe = realLsRemote(remoteUrl);
            assert.equal(probe.status, 0, `real git ls-remote must succeed: ${probe.stderr}`);
            const lines = probe.stdout.trim().split('\n').filter(Boolean);
            assert.ok(lines.length >= 2, `expected multiple refs in genuine output, got: ${JSON.stringify(lines)}`);
            assert.ok(lines.some((l) => l.includes('refs/heads/main') && l.includes(secondSha)), 'sanity: refs/heads/main genuinely carries the second (different) SHA');
            assert.ok(lines.some((l) => l.includes('refs/dolt/data') && l.includes(firstSha)), 'sanity: refs/dolt/data genuinely carries the first (different) SHA');

            const sha = parseLsRemoteTip(probe.stdout);
            assert.equal(sha, firstSha, 'parseLsRemoteTip picks exactly the refs/dolt/data line -- not refs/heads/main, HEAD, or any other line -- out of a genuine multi-ref, multi-SHA result');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('shape hazard: an EMPTY real ls-remote result (no refs/dolt/data on the remote at all) parses to null and never reads as up-to-date', async () => {
        const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'j918-6-5-empty-')));
        try {
            const remoteDir = path.join(root, 'partial-remote.git');
            const remoteUrl = `file://${remoteDir}`;
            const workDir = path.join(root, 'work');
            const run = (args, cwd) => {
                const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
                if (res.status !== 0) throw new Error(`fixture setup: 'git ${args.join(' ')}' failed: ${res.stdout}${res.stderr}`);
                return res;
            };
            run(['init', '--bare', '-b', 'main', remoteDir], root);
            fs.mkdirSync(workDir);
            run(['init', '-b', 'main'], workDir);
            run(['config', 'user.email', 'j918-6-5@test.local'], workDir);
            run(['config', 'user.name', 'j918-6-5'], workDir);
            fs.writeFileSync(path.join(workDir, 'README.md'), 'seed\n', 'utf-8');
            run(['add', 'README.md'], workDir);
            run(['commit', '-m', 'seed'], workDir);
            // refs/heads/main is real and pushed; refs/dolt/data is
            // deliberately never created on this remote.
            run(['push', remoteUrl, 'refs/heads/main:refs/heads/main'], workDir);

            const directProbe = realLsRemote(remoteUrl, 'refs/dolt/data');
            assert.equal(directProbe.status, 0, 'a genuine no-match ls-remote still exits 0 on real git');
            assert.equal(directProbe.stdout.trim(), '', 'genuinely no refs/dolt/data line comes back');
            assert.equal(parseLsRemoteTip(directProbe.stdout), null, 'an empty genuine result parses to null');

            const calls = [];
            const command = async (cmd) => {
                calls.push(cmd);
                if (cmd.includes('bd config get sync.remote --json')) {
                    return { ok: true, output: JSON.stringify({ value: remoteUrl }), error: null };
                }
                if (/\bls-remote\b/.test(cmd)) {
                    // Run the probe exactly as dolt-sync.mjs composes it.
                    const argv = cmd.trim().split(/\s+/).slice(1);
                    const res = spawnSync('git', argv, { encoding: 'utf8' });
                    const output = `${res.stdout || ''}${res.stderr || ''}`;
                    return { ok: res.status === 0, output, error: res.status === 0 ? null : output.trim() };
                }
                if (cmd.includes('bd dolt pull')) return { ok: true, output: '', error: null };
                return { ok: true, output: '', error: null };
            };

            const res = await doltPullBefore('empty-fp-member', { command, sleep: noSleep });

            assert.deepEqual(res, { ok: true, member: 'empty-fp-member' }, 'no fingerprint-skip fields -- the empty real probe never reads as up-to-date');
            assert.equal(calls.filter((c) => /\bls-remote\b/.test(c)).length, 1, 'the probe genuinely ran');
            assert.equal(calls.filter((c) => c.includes('bd dolt pull')).length, 1, 'a real pull was genuinely attempted, never skipped on the empty probe');
            assert.equal(getLastSyncedTip('empty-fp-member'), undefined, 'an unparseable/empty probe mints no fingerprint either');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('shape hazard: a real non-zero-exit ls-remote (destroyed remote) falls through to a genuinely attempted pull, never a false skip', async () => {
        const fx = createDoltRemoteFixture({ member: 'destroyed-remote-member', prefix: 'j918-6-5-nonzero-' });
        try {
            const peerTip = fx.peerPublish('peer-before-destroy');
            const first = await doltPullBefore(fx.member, { command: fx.command, sleep: noSleep });
            assert.deepEqual(first, { ok: true, member: fx.member });
            assert.equal(getLastSyncedTip(fx.member), peerTip, 'precondition: a fingerprint is genuinely recorded before the remote is destroyed');

            const directProbeBefore = realLsRemote(fx.remoteUrl, 'refs/dolt/data');
            assert.equal(directProbeBefore.status, 0, 'sanity: the probe succeeds for real while the remote is alive');

            fx.destroyRemote();
            const directProbeAfter = realLsRemote(fx.remoteUrl, 'refs/dolt/data');
            assert.notEqual(directProbeAfter.status, 0, 'a destroyed remote genuinely fails ls-remote with a non-zero exit');

            await assert.rejects(
                () => doltPullBefore(fx.member, { command: fx.command, sleep: noSleep }),
                (err) => {
                    assert.ok(err instanceof DoltSyncError, `expected DoltSyncError, got ${err && err.constructor && err.constructor.name}: ${err && err.message}`);
                    return true;
                },
                'a failed real probe must never be read as up-to-date: it falls through to a real pull, which then fails for the genuine infra reason',
            );
            assert.ok(fx.commandsOf('ls-remote').length >= 2, 'the fingerprint probe genuinely ran again against the now-destroyed remote');
            assert.ok(fx.commandsOf('bd dolt pull').length >= 1, 'a real pull was genuinely attempted despite the failed probe -- never silently skipped');
        } finally {
            fx.cleanup();
        }
    });
});
