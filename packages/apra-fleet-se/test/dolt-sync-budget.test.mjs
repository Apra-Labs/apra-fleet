// =============================================================================
// Dolt sync budget: the three dolt-sync.mjs changes from the sync-cost review
// =============================================================================
//
//   A.2 (apra-fleet-akuv) -- memoize the per-member `bd config get sync.remote`
//       probe for the process lifetime, with explicit invalidation.
//   A.3                   -- time-box the transient retry ladder: a wall-clock
//       budget for the spawn-outage class ONLY, the short count-based ladder
//       for every other transient kind.
//   B.1                   -- remote-tip fingerprint: skip a D-pull only when
//       `git ls-remote <sync.remote> refs/dolt/data` proves the remote has not
//       moved since this member last synchronized.
//
// ASCII only.
// =============================================================================

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
    doltPullBefore,
    doltPushAfter,
    isMemberSyncRemoteConfigured,
    readMemberSyncRemote,
    invalidateSyncRemoteCache,
    noteMemberCommand,
    isSpawnOutageFailure,
    toGitLsRemoteUrl,
    parseLsRemoteTip,
    getLastSyncedTip,
    setLastSyncedTip,
    clearLastSyncedTip,
    repair,
    DOLT_GENERIC_TRANSIENT_MAX_RETRIES,
    DOLT_SPAWN_OUTAGE_BUDGET_MS,
} from '../fleet-sprint/dolt-sync.mjs';

// The memos are module-level and process-lifetime by design (one runner
// process per sprint), so every test starts from a cold cache.
beforeEach(() => {
    invalidateSyncRemoteCache();
    clearLastSyncedTip();
});

const OK = { ok: true, output: '', error: null };
const fail = (error) => ({ ok: false, output: '', error });
const REMOTE = 'git+https://github.com/Apra-Labs/apra-fleet.git';
const REMOTE_JSON = { ok: true, output: JSON.stringify({ value: REMOTE }), error: null };
const SHA_A = '89de8f0f99fabf24c8e7595f76d102baae485f6f';
const SHA_B = '1122334455667788990011223344556677889900';
const lsRemote = (sha) => ({ ok: true, output: `${sha}\trefs/dolt/data\n`, error: null });

/**
 * Prefix-scripted command mock. `script` maps a command SUBSTRING to a queue of
 * results (the last entry repeats). Records every call for assertions.
 */
function makeCommandMock(script) {
    const calls = [];
    const queues = new Map(Object.entries(script).map(([k, v]) => [k, [...v]]));
    const command = async (cmd, opts = {}) => {
        calls.push({ cmd, opts });
        for (const [key, queue] of queues) {
            if (cmd.includes(key)) {
                const next = queue.length > 1 ? queue.shift() : queue[0];
                return typeof next === 'function' ? next() : next;
            }
        }
        return OK;
    };
    const countOf = (needle) => calls.filter((c) => c.cmd.includes(needle)).length;
    return { command, calls, countOf };
}

const PROBE = 'bd config get sync.remote';
const LS_REMOTE = 'git ls-remote';
const PULL = 'bd dolt pull';
const PUSH = 'bd dolt push';

// =============================================================================
// A.2 -- sync.remote probe memoization
// =============================================================================

test('memo: the sync.remote probe is spawned ONCE per member across many calls', async () => {
    const { command, countOf } = makeCommandMock({ [PROBE]: [REMOTE_JSON] });
    for (let i = 0; i < 5; i += 1) {
        assert.equal(await isMemberSyncRemoteConfigured('m1', { command }), true);
    }
    assert.equal(countOf(PROBE), 1, 'four of the five reads must be cache hits');
});

test('memo: the cache is keyed per member -- a second member probes on its own', async () => {
    const { command, countOf } = makeCommandMock({ [PROBE]: [REMOTE_JSON] });
    await isMemberSyncRemoteConfigured('m1', { command });
    await isMemberSyncRemoteConfigured('m2', { command });
    await isMemberSyncRemoteConfigured('m1', { command });
    assert.equal(countOf(PROBE), 2, 'one probe per distinct member, then cache hits');
});

test('memo: a positively-parsed ABSENT sync.remote is cached as absent', async () => {
    const { command, countOf } = makeCommandMock({
        [PROBE]: [{ ok: true, output: JSON.stringify({ value: '' }), error: null }],
    });
    assert.equal(await isMemberSyncRemoteConfigured('m1', { command }), false);
    assert.equal(await isMemberSyncRemoteConfigured('m1', { command }), false);
    assert.equal(countOf(PROBE), 1);
});

// The fail-CLOSED contract must survive memoization: an inconclusive read still
// reports "configured", but must NOT be cached -- otherwise one transient probe
// failure would pin the fail-safe answer for the whole sprint.
for (const [label, result] of [
    ['a failSoft error result', fail('bd exploded')],
    ['unparseable output', { ok: true, output: 'not json at all', error: null }],
    ['empty output', { ok: true, output: '', error: null }],
]) {
    test(`memo: ${label} reports CONFIGURED (fail-safe) and is NOT cached`, async () => {
        const { command, countOf } = makeCommandMock({ [PROBE]: [result] });
        assert.equal(await isMemberSyncRemoteConfigured('m1', { command }), true);
        assert.equal(await isMemberSyncRemoteConfigured('m1', { command }), true);
        assert.equal(countOf(PROBE), 2, 'an inconclusive answer must be re-probed, never memoized');
    });
}

test('memo: a thrown command() reports CONFIGURED (fail-safe) and is NOT cached', async () => {
    let calls = 0;
    const command = async () => { calls += 1; throw new Error('spawn failed'); };
    assert.equal(await isMemberSyncRemoteConfigured('m1', { command }), true);
    assert.equal(await isMemberSyncRemoteConfigured('m1', { command }), true);
    assert.equal(calls, 2);
});

test('memo: readMemberSyncRemote returns the URL alongside the boolean', async () => {
    const { command } = makeCommandMock({ [PROBE]: [REMOTE_JSON] });
    assert.deepEqual(await readMemberSyncRemote('m1', { command }), { configured: true, url: REMOTE });
});

test('memo: invalidateSyncRemoteCache(member) forces exactly one re-probe', async () => {
    const { command, countOf } = makeCommandMock({ [PROBE]: [REMOTE_JSON] });
    await isMemberSyncRemoteConfigured('m1', { command });
    assert.equal(invalidateSyncRemoteCache('m1'), 1);
    await isMemberSyncRemoteConfigured('m1', { command });
    await isMemberSyncRemoteConfigured('m1', { command });
    assert.equal(countOf(PROBE), 2);
});

test('memo: noteMemberCommand invalidates on the remote-rewiring command family only', async () => {
    for (const cmd of [
        'bd config set sync.remote https://example.com/x.git',
        'bd dolt remote add origin https://example.com/x.git',
        'bd init --database beads',
        'bd bootstrap',
        '  BD CONFIG SET sync.remote x',
        // Round-2 fix (item 5): COMPOUND command strings. A member's cwd must
        // be established in the same string, so the bd invocation is routinely
        // NOT at the start -- scripts/dolt-settle-integration.mjs issues both
        // of these shapes verbatim, and the old left-anchored regex missed
        // every one of them.
        'cd "/tmp/sandbox" && bd dolt remote add origin "https://example.com/x.git" && bd config set sync.remote "https://example.com/x.git"',
        'Set-Location "C:\\sandbox"; bd dolt remote add origin "https://example.com/x.git"; bd config set sync.remote "https://example.com/x.git"',
        'cd /tmp/x && bd bootstrap',
        'true; bd init --database beads',
        '(bd bootstrap)',
    ]) {
        assert.equal(noteMemberCommand('m1', cmd), true, `expected '${cmd}' to invalidate`);
    }
    for (const cmd of [
        'bd config get sync.remote --json',
        'bd list --all --json',
        'bd show apra-fleet-1',
        'bd dolt pull',
        'bd dolt push',
        'bd update x --status open',
        'git remote set-url origin https://example.com/x.git',
        // Still word-bounded: a longer token that merely CONTAINS the command
        // shape must not match.
        'abd bootstrap',
        'echo --bd init',
        'cd /tmp && bd list --all --json',
    ]) {
        assert.equal(noteMemberCommand('m1', cmd), false, `expected '${cmd}' NOT to invalidate`);
    }
    assert.equal(noteMemberCommand('', 'bd bootstrap'), false, 'no member -- nothing to invalidate');
    assert.equal(noteMemberCommand('m1', undefined), false, 'a non-string command must not throw');
});

test('memo: noteMemberCommand only drops the named member, not the whole cache', async () => {
    const { command, countOf } = makeCommandMock({ [PROBE]: [REMOTE_JSON] });
    await isMemberSyncRemoteConfigured('m1', { command });
    await isMemberSyncRemoteConfigured('m2', { command });
    noteMemberCommand('m1', 'bd config set sync.remote https://example.com/x.git');
    await isMemberSyncRemoteConfigured('m1', { command }); // re-probes
    await isMemberSyncRemoteConfigured('m2', { command }); // still cached
    assert.equal(countOf(PROBE), 3);
});

test('memo: noteMemberCommand also FORGETS the recorded remote tip (round-2 item 4)', async () => {
    // A `bd init`/`bd bootstrap` can replace the member's local Dolt clone
    // outright. The remote tip has not moved, so a surviving fingerprint would
    // match and skip the pull the freshly-recreated (empty) clone needs most.
    const { command, countOf } = makeCommandMock({
        [PROBE]: [REMOTE_JSON],
        [LS_REMOTE]: [lsRemote(SHA_A)],
        [PULL]: [OK],
    });
    setLastSyncedTip('m1', SHA_A);
    setLastSyncedTip('m2', SHA_A);
    assert.equal(noteMemberCommand('m1', 'cd /tmp/x && bd bootstrap'), true);
    assert.equal(getLastSyncedTip('m1'), undefined, 'a re-bootstrapped clone must not keep its fingerprint');
    assert.equal(getLastSyncedTip('m2'), SHA_A, 'only the named member is affected');
    // ...and the next D-pull for that member is real, not remote-unchanged.
    const res = await doltPullBefore('m1', { command });
    assert.deepEqual(res, { ok: true, member: 'm1' });
    assert.equal(countOf(PULL), 1);
});

test('memo: a non-invalidating command leaves the recorded tip alone', async () => {
    setLastSyncedTip('m1', SHA_A);
    assert.equal(noteMemberCommand('m1', 'bd list --all --json'), false);
    assert.equal(getLastSyncedTip('m1'), SHA_A);
});

test('memo: the auth self-heal path invalidates the member memo', async () => {
    const { command, countOf } = makeCommandMock({
        [PROBE]: [REMOTE_JSON],
        [PULL]: [fail('fatal: could not read Username for https://github.com'), OK],
    });
    let healed = 0;
    await doltPullBefore('m1', {
        command,
        remoteTipFingerprint: false,
        onAuthFailure: async () => { healed += 1; },
    });
    assert.equal(healed, 1, 'the one-shot self-heal fired');
    // The pre-gate probed once; the self-heal dropped the memo, so a later read
    // re-probes rather than trusting a possibly-rewired cached answer.
    const before = countOf(PROBE);
    await isMemberSyncRemoteConfigured('m1', { command });
    assert.equal(countOf(PROBE), before + 1, 'self-heal must have invalidated the memo');
});

test('memo: repair() invalidates both the sync.remote memo and the recorded tip', async () => {
    const { command } = makeCommandMock({ [PROBE]: [REMOTE_JSON] });
    await isMemberSyncRemoteConfigured('m1', { command });
    setLastSyncedTip('m1', SHA_A);
    await repair('m1', { command, settle: async () => ({ ok: true, resolvedTables: [] }) });
    assert.equal(getLastSyncedTip('m1'), undefined, 'a repair must forget the fingerprint');
    const { command: c2, countOf } = makeCommandMock({ [PROBE]: [REMOTE_JSON] });
    await isMemberSyncRemoteConfigured('m1', { command: c2 });
    assert.equal(countOf(PROBE), 1, 'a repair must have dropped the memo');
});

// =============================================================================
// A.3 -- time-boxed retry ladder
// =============================================================================

test('retry: the spawn-outage class is recognized; ordinary transients are not', () => {
    assert.equal(isSpawnOutageFailure('fork/exec C:\\Program Files\\Git\\bin\\git.exe: Not enough memory resources'), true);
    assert.equal(isSpawnOutageFailure('fork/exec /usr/bin/git: resource unavailable'), true);
    assert.equal(isSpawnOutageFailure('Not enough memory resources are available to process this command.'), true);
    assert.equal(isSpawnOutageFailure('connection refused'), false);
    assert.equal(isSpawnOutageFailure('database is locked'), false);
    assert.equal(isSpawnOutageFailure(''), false);
    assert.equal(isSpawnOutageFailure(null), false);
});

test('retry: an ordinary transient keeps the pre-widening count-based ladder (5 retries by default)', async () => {
    // Round-2 fix: the round-1 value of 2 (~1.5s of backoff) was described as
    // "the pre-widening ladder" but the actual pre-widening default was 5
    // (~15.5s) -- see the constants block in dolt-sync.mjs. Production must not
    // under-retry to keep a test suite fast; a slow test injects `sleep`.
    assert.equal(DOLT_GENERIC_TRANSIENT_MAX_RETRIES, 5);
    const { command, countOf } = makeCommandMock({
        [PROBE]: [REMOTE_JSON],
        [PULL]: [fail('connection refused')],
    });
    const slept = [];
    await assert.rejects(() => doltPullBefore('m1', {
        command,
        remoteTipFingerprint: false,
        sleep: async (ms) => { slept.push(ms); },
    }));
    assert.equal(countOf(PULL), 6, 'initial attempt plus exactly 5 retries');
    // ...and at the SHORT 8s backoff cap, not the 30s spawn-outage cap.
    assert.deepEqual(slept, [500, 1000, 2000, 4000, 8000]);
    assert.equal(slept.reduce((a, b) => a + b, 0), 15500, 'the pre-widening ~15.5s total backoff budget');
});

test('retry: an ordinary transient is bounded by COUNT even when wall-clock time is trivial', async () => {
    const { command, countOf } = makeCommandMock({
        [PROBE]: [REMOTE_JSON],
        [PULL]: [fail('database is locked')],
    });
    await assert.rejects(() => doltPullBefore('m1', {
        command,
        remoteTipFingerprint: false,
        maxTransientRetries: 5,
        sleep: async () => {},
    }));
    assert.equal(countOf(PULL), 6, 'an explicitly-passed maxTransientRetries is still honored');
});

test('retry: a spawn outage is bounded by WALL CLOCK, not by maxTransientRetries', async () => {
    // A fake clock the injected sleep() advances, so the budget is exercised
    // deterministically and the suite never actually waits.
    let clock = 0;
    const { command, countOf } = makeCommandMock({
        [PROBE]: [REMOTE_JSON],
        [PULL]: [fail('fork/exec git.exe: Not enough memory resources')],
    });
    await assert.rejects(() => doltPullBefore('m1', {
        command,
        remoteTipFingerprint: false,
        maxTransientRetries: 2, // deliberately tiny -- must NOT bound this class
        now: () => clock,
        sleep: async (ms) => { clock += ms; },
    }));
    // Far more than the 2-retry generic ladder would allow: the ladder ran
    // until the 3-minute wall-clock budget was spent.
    assert.ok(countOf(PULL) > 3, `expected the wall-clock budget to outlast the count bound, saw ${countOf(PULL)} attempts`);
    assert.ok(clock >= DOLT_SPAWN_OUTAGE_BUDGET_MS, `expected the full budget to be consumed, saw ${clock}ms`);
});

test('retry: a spawn outage that clears inside the budget succeeds without exhausting it', async () => {
    let clock = 0;
    const { command, countOf } = makeCommandMock({
        [PROBE]: [REMOTE_JSON],
        [PULL]: [fail('fork/exec git.exe: Not enough memory resources'), fail('fork/exec git.exe: Not enough memory resources'), OK],
    });
    const res = await doltPullBefore('m1', {
        command,
        remoteTipFingerprint: false,
        now: () => clock,
        sleep: async (ms) => { clock += ms; },
    });
    assert.equal(res.ok, true);
    assert.equal(countOf(PULL), 3);
    assert.ok(clock < DOLT_SPAWN_OUTAGE_BUDGET_MS, 'the budget is a ceiling, not a floor');
});

test('retry: the spawn-outage budget stops retrying once the wall clock is spent', async () => {
    // The clock advances on its own (as a long per-attempt timeout would), so
    // the budget is consumed by ELAPSED time rather than by backoff sleeps --
    // this is precisely the case the old count-based bound could not bound.
    let clock = 0;
    const { command, countOf } = makeCommandMock({
        [PROBE]: [REMOTE_JSON],
        [PULL]: [() => { clock += 60000; return fail('fork/exec git.exe: Not enough memory resources'); }],
    });
    await assert.rejects(() => doltPullBefore('m1', {
        command,
        remoteTipFingerprint: false,
        now: () => clock,
        sleep: async (ms) => { clock += ms; },
    }));
    assert.ok(countOf(PULL) <= 5, `a 60s-per-attempt outage must exhaust a 180s budget in a handful of attempts, saw ${countOf(PULL)}`);
});

test('retry: a diverged failure is still never retried, under either ladder', async () => {
    const { command, countOf } = makeCommandMock({
        [PROBE]: [REMOTE_JSON],
        [PULL]: [fail('merge conflict detected in table issues')],
    });
    await assert.rejects(() => doltPullBefore('m1', { command, remoteTipFingerprint: false, sleep: async () => {} }));
    assert.equal(countOf(PULL), 1);
});

// =============================================================================
// B.1 -- remote-tip fingerprint
// =============================================================================

test('fingerprint: toGitLsRemoteUrl strips bd\'s git+ scheme prefix', () => {
    assert.equal(toGitLsRemoteUrl(REMOTE), 'https://github.com/Apra-Labs/apra-fleet.git');
    assert.equal(toGitLsRemoteUrl('https://github.com/a/b.git'), 'https://github.com/a/b.git');
    assert.equal(toGitLsRemoteUrl('ssh://git@github.com/a/b.git'), 'ssh://git@github.com/a/b.git');
});

test('fingerprint: toGitLsRemoteUrl REFUSES anything outside the safe charset', () => {
    // The probe string reaches the member's own shell, which may be PowerShell
    // or a POSIX shell; rather than quote for both, an unsafe URL yields no
    // fingerprint and therefore a real pull.
    for (const bad of [
        'https://host/a b.git',
        'https://host/a.git; rm -rf /',
        'https://host/$(whoami).git',
        "https://host/'x'.git",
        'https://host/`x`.git',
        'https://host/a&b.git',
        '',
        '   ',
        'git+',
        null,
        undefined,
        42,
    ]) {
        assert.equal(toGitLsRemoteUrl(bad), null, `expected ${JSON.stringify(bad)} to be refused`);
    }
});

test('fingerprint: parseLsRemoteTip reads the refs/dolt/data SHA and nothing else', () => {
    assert.equal(parseLsRemoteTip(`${SHA_A}\trefs/dolt/data`), SHA_A);
    assert.equal(parseLsRemoteTip(`${SHA_A}\trefs/dolt/data\n`), SHA_A);
    assert.equal(parseLsRemoteTip(`${SHA_B}\trefs/heads/main\n${SHA_A}\trefs/dolt/data\n`), SHA_A);
    // Anything unrecognized is "unknown", which the caller turns into a real pull.
    assert.equal(parseLsRemoteTip(`${SHA_B}\trefs/heads/main`), null);
    assert.equal(parseLsRemoteTip(''), null);
    assert.equal(parseLsRemoteTip(null), null);
    assert.equal(parseLsRemoteTip('fatal: repository not found'), null);
});

test('fingerprint: an UNCHANGED remote tip skips the real pull', async () => {
    const { command, countOf } = makeCommandMock({
        [PROBE]: [REMOTE_JSON],
        [LS_REMOTE]: [lsRemote(SHA_A)],
        [PULL]: [OK],
    });
    setLastSyncedTip('m1', SHA_A);
    const res = await doltPullBefore('m1', { command });
    assert.deepEqual(res, { ok: true, member: 'm1', skipped: true, reason: 'remote-unchanged', remoteTip: SHA_A });
    assert.equal(countOf(PULL), 0, 'the whole point: no bd dolt pull spawn');
    assert.equal(countOf(LS_REMOTE), 1);
});

test('fingerprint: a MOVED remote tip does a real pull and records the pre-pull SHA', async () => {
    const { command, countOf } = makeCommandMock({
        [PROBE]: [REMOTE_JSON],
        [LS_REMOTE]: [lsRemote(SHA_B)],
        [PULL]: [OK],
    });
    setLastSyncedTip('m1', SHA_A);
    const res = await doltPullBefore('m1', { command });
    assert.deepEqual(res, { ok: true, member: 'm1' });
    assert.equal(countOf(PULL), 1);
    assert.equal(getLastSyncedTip('m1'), SHA_B, 'the SHA observed BEFORE the pull is what gets recorded');
});

test('fingerprint: with NO recorded tip the pull is real, and the tip is then recorded', async () => {
    const { command, countOf } = makeCommandMock({
        [PROBE]: [REMOTE_JSON],
        [LS_REMOTE]: [lsRemote(SHA_A)],
        [PULL]: [OK],
    });
    assert.equal(getLastSyncedTip('m1'), undefined);
    await doltPullBefore('m1', { command });
    assert.equal(countOf(PULL), 1, 'no recorded tip must never skip');
    assert.equal(getLastSyncedTip('m1'), SHA_A);
    // ...and the NEXT pull, tip unchanged, is now skippable.
    await doltPullBefore('m1', { command });
    assert.equal(countOf(PULL), 1);
});

test('fingerprint: a FAILED ls-remote falls through to a real pull, never a skip', async () => {
    const { command, countOf } = makeCommandMock({
        [PROBE]: [REMOTE_JSON],
        [LS_REMOTE]: [fail('fatal: unable to access remote: Could not resolve host')],
        [PULL]: [OK],
    });
    setLastSyncedTip('m1', SHA_A);
    const res = await doltPullBefore('m1', { command });
    assert.deepEqual(res, { ok: true, member: 'm1' }, 'must NOT report remote-unchanged');
    assert.equal(countOf(PULL), 1, 'a probe failure must fail OPEN into a real pull');
    assert.equal(getLastSyncedTip('m1'), SHA_A, 'an unread tip leaves the recorded one untouched');
});

test('fingerprint: a THROWN ls-remote falls through to a real pull', async () => {
    let pulls = 0;
    const command = async (cmd) => {
        if (cmd.includes(PROBE)) return REMOTE_JSON;
        if (cmd.includes(LS_REMOTE)) throw new Error('transport exploded');
        if (cmd.includes(PULL)) { pulls += 1; return OK; }
        return OK;
    };
    setLastSyncedTip('m1', SHA_A);
    const res = await doltPullBefore('m1', { command });
    assert.deepEqual(res, { ok: true, member: 'm1' });
    assert.equal(pulls, 1);
});

test('fingerprint: UNPARSEABLE ls-remote output falls through to a real pull', async () => {
    const { command, countOf } = makeCommandMock({
        [PROBE]: [REMOTE_JSON],
        [LS_REMOTE]: [{ ok: true, output: 'warning: no refs matched\n', error: null }],
        [PULL]: [OK],
    });
    setLastSyncedTip('m1', SHA_A);
    await doltPullBefore('m1', { command });
    assert.equal(countOf(PULL), 1);
});

test('fingerprint: an unreadable sync.remote issues NO probe and does a real pull', async () => {
    // sync.remote cannot be positively parsed -> fail-safe "configured", but no
    // URL, so there is nothing to ls-remote and no fingerprint is attempted.
    const { command, countOf } = makeCommandMock({
        [PROBE]: [{ ok: true, output: '', error: null }],
        [PULL]: [OK],
    });
    setLastSyncedTip('m1', SHA_A);
    await doltPullBefore('m1', { command });
    assert.equal(countOf(LS_REMOTE), 0);
    assert.equal(countOf(PULL), 1);
});

test('fingerprint: the ls-remote target comes from sync.remote, never from git origin', async () => {
    const { command, calls } = makeCommandMock({
        [PROBE]: [{ ok: true, output: JSON.stringify({ value: 'git+https://example.invalid/other/repo.git' }), error: null }],
        [LS_REMOTE]: [lsRemote(SHA_A)],
        [PULL]: [OK],
    });
    await doltPullBefore('m1', { command });
    const probe = calls.find((c) => c.cmd.includes(LS_REMOTE));
    assert.ok(probe, 'expected an ls-remote probe');
    assert.equal(probe.cmd, 'git ls-remote https://example.invalid/other/repo.git refs/dolt/data');
    assert.ok(!/\borigin\b/.test(probe.cmd), 'must never probe git origin -- it can differ from sync.remote');
});

test('fingerprint: remoteTipFingerprint:false disables the probe entirely', async () => {
    const { command, countOf } = makeCommandMock({
        [PROBE]: [REMOTE_JSON],
        [LS_REMOTE]: [lsRemote(SHA_A)],
        [PULL]: [OK],
    });
    setLastSyncedTip('m1', SHA_A);
    await doltPullBefore('m1', { command, remoteTipFingerprint: false });
    assert.equal(countOf(LS_REMOTE), 0);
    assert.equal(countOf(PULL), 1);
});

test('fingerprint: a divergence FORGETS the recorded tip so the next pull is real', async () => {
    const { command } = makeCommandMock({
        [PROBE]: [REMOTE_JSON],
        [LS_REMOTE]: [lsRemote(SHA_B)],
        [PULL]: [fail('merge conflict detected in table issues')],
    });
    setLastSyncedTip('m1', SHA_A);
    await assert.rejects(() => doltPullBefore('m1', { command }));
    assert.equal(getLastSyncedTip('m1'), undefined);
});

test('fingerprint: a FAILED pull does not record the observed tip', async () => {
    const { command } = makeCommandMock({
        [PROBE]: [REMOTE_JSON],
        [LS_REMOTE]: [lsRemote(SHA_B)],
        [PULL]: [fail('connection refused')],
    });
    await assert.rejects(() => doltPullBefore('m1', { command, sleep: async () => {} }));
    assert.equal(getLastSyncedTip('m1'), undefined, 'only a SUCCESSFUL pull may record a tip');
});

test('fingerprint: a push that ADVANCES the remote records the post-push tip, so the next pull skips', async () => {
    // The ls-remote queue: SHA_A immediately before the push, SHA_B for every
    // read after it -- i.e. this push actually published something.
    const { command, countOf } = makeCommandMock({
        [PROBE]: [REMOTE_JSON],
        [LS_REMOTE]: [lsRemote(SHA_A), lsRemote(SHA_B)],
        [PUSH]: [OK],
        [PULL]: [OK],
    });
    const res = await doltPushAfter('m1', { command, pushBeads: true });
    assert.equal(res.pushed, true);
    assert.equal(getLastSyncedTip('m1'), SHA_B, 'the SHA read AFTER a successful push (still under the mutex)');
    const pullRes = await doltPullBefore('m1', { command });
    assert.equal(pullRes.reason, 'remote-unchanged');
    assert.equal(countOf(PULL), 0, 'the pusher is the last writer, so its next pull is a provable no-op');
});

test('fingerprint: a NO-OP push from a possibly-behind clone must NOT record a tip (round-2 race)', async () => {
    // The exact race the round-2 review found:
    //   1. another machine pushed; the remote is at SHA_B.
    //   2. this member never pulled that, and has no recorded tip for it.
    //   3. this member pushes with nothing local to publish -- `bd dolt push`
    //      still exits 0 and the ref does not move.
    // Recording SHA_B here would claim a freshness this clone does not have,
    // and the next D-pull would skip a pull it genuinely needs.
    const { command, countOf } = makeCommandMock({
        [PROBE]: [REMOTE_JSON],
        [LS_REMOTE]: [lsRemote(SHA_B)], // unchanged before AND after the push
        [PUSH]: [OK],
        [PULL]: [OK],
    });
    const res = await doltPushAfter('m1', { command, pushBeads: true });
    assert.equal(res.pushed, true);
    assert.equal(getLastSyncedTip('m1'), undefined, 'a no-op push must never mint a fingerprint');
    const pullRes = await doltPullBefore('m1', { command });
    assert.equal(pullRes.skipped, undefined, 'the next D-pull must be REAL, not remote-unchanged');
    assert.equal(countOf(PULL), 1);
});

test('fingerprint: a no-op push STALE-tip case forgets the old tip rather than re-confirming it', async () => {
    // Same shape, but this member does carry a recorded tip -- an OLD one
    // (SHA_A) that no longer matches the remote (SHA_B). The push publishes
    // nothing, so nothing about this clone became current with SHA_B.
    const { command, countOf } = makeCommandMock({
        [PROBE]: [REMOTE_JSON],
        [LS_REMOTE]: [lsRemote(SHA_B)],
        [PUSH]: [OK],
        [PULL]: [OK],
    });
    setLastSyncedTip('m1', SHA_A);
    await doltPushAfter('m1', { command, pushBeads: true });
    assert.equal(getLastSyncedTip('m1'), undefined);
    await doltPullBefore('m1', { command });
    assert.equal(countOf(PULL), 1, 'the stale tip must not survive into a skip');
});

test('fingerprint: a no-op push by a clone ALREADY current keeps its fingerprint (no needless pull)', async () => {
    // The benign no-op: this member is recorded as current with the remote tip
    // and the push publishes nothing, so the fingerprint still holds and the
    // next pull may still be skipped.
    const { command, countOf } = makeCommandMock({
        [PROBE]: [REMOTE_JSON],
        [LS_REMOTE]: [lsRemote(SHA_A)],
        [PUSH]: [OK],
        [PULL]: [OK],
    });
    setLastSyncedTip('m1', SHA_A);
    await doltPushAfter('m1', { command, pushBeads: true });
    assert.equal(getLastSyncedTip('m1'), SHA_A);
    const pullRes = await doltPullBefore('m1', { command });
    assert.equal(pullRes.reason, 'remote-unchanged');
    assert.equal(countOf(PULL), 0);
});

test('fingerprint: the pre-push tip read is skipped entirely when remoteTipFingerprint is off', async () => {
    const { command, countOf } = makeCommandMock({
        [PROBE]: [REMOTE_JSON],
        [LS_REMOTE]: [lsRemote(SHA_A)],
        [PUSH]: [OK],
    });
    await doltPushAfter('m1', { command, pushBeads: true, remoteTipFingerprint: false });
    assert.equal(countOf(LS_REMOTE), 0, 'no probe at all -- neither before nor after the push');
});

test('fingerprint: a push whose post-push probe fails forgets the tip (next pull is real)', async () => {
    const { command, countOf } = makeCommandMock({
        [PROBE]: [REMOTE_JSON],
        [LS_REMOTE]: [fail('unable to access remote')],
        [PUSH]: [OK],
        [PULL]: [OK],
    });
    setLastSyncedTip('m1', SHA_A);
    await doltPushAfter('m1', { command, pushBeads: true });
    assert.equal(getLastSyncedTip('m1'), undefined, 'a stale pre-push tip must never survive a push');
    await doltPullBefore('m1', { command });
    assert.equal(countOf(PULL), 1);
});

test('fingerprint: a diverged push forgets the tip', async () => {
    const { command } = makeCommandMock({
        [PROBE]: [REMOTE_JSON],
        [LS_REMOTE]: [lsRemote(SHA_B)],
        [PUSH]: [fail('Updates were rejected because the remote contains work')],
        [PULL]: [OK],
    });
    setLastSyncedTip('m1', SHA_A);
    await assert.rejects(() => doltPushAfter('m1', { command, pushBeads: true, sleep: async () => {} }));
    assert.equal(getLastSyncedTip('m1'), undefined);
});

test('fingerprint: the sync.remote pre-gate still wins -- an absent remote skips before any probe', async () => {
    const { command, countOf } = makeCommandMock({
        [PROBE]: [{ ok: true, output: JSON.stringify({ value: '' }), error: null }],
        [PULL]: [OK],
    });
    const res = await doltPullBefore('m1', { command });
    assert.equal(res.reason, 'no-remote');
    assert.equal(countOf(LS_REMOTE), 0, 'a neutralized clone must issue no commands at all');
    assert.equal(countOf(PULL), 0);
});

test('fingerprint: the probe reuses the MEMOIZED sync.remote -- no extra bd config get', async () => {
    const { command, countOf } = makeCommandMock({
        [PROBE]: [REMOTE_JSON],
        [LS_REMOTE]: [lsRemote(SHA_A)],
        [PULL]: [OK],
    });
    await doltPullBefore('m1', { command });
    await doltPullBefore('m1', { command });
    await doltPullBefore('m1', { command });
    assert.equal(countOf(PROBE), 1, 'one sync.remote probe for three brackets');
    assert.equal(countOf(PULL), 1, 'and only the first pull was real');
});
