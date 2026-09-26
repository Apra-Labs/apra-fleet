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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    doltPullBefore,
    doltPushAfter,
    isMemberSyncRemoteConfigured,
    readMemberSyncRemote,
    invalidateSyncRemoteCache,
    noteMemberCommand,
    noteMemberDispatchCompleted,
    isMemberDispatchedSinceVerified,
    isTipProbeDisabled,
    clearTipProbeFailures,
    DOLT_TIP_PROBE_MAX_CONSECUTIVE_FAILURES,
    isSpawnOutageFailure,
    toGitLsRemoteUrl,
    parseLsRemoteTip,
    getLastSyncedTip,
    setLastSyncedTip,
    clearLastSyncedTip,
    repair,
    classifyDoltFailure,
    DOLT_GENERIC_TRANSIENT_MAX_RETRIES,
    DOLT_SPAWN_OUTAGE_BUDGET_MS,
} from '../fleet-sprint/dolt-sync.mjs';

// The memos are module-level and process-lifetime by design (one runner
// process per sprint), so every test starts from a cold cache.
beforeEach(() => {
    invalidateSyncRemoteCache();
    clearLastSyncedTip();
    clearTipProbeFailures();
});

const OK = { ok: true, output: '', error: null };
const fail = (error) => ({ ok: false, output: '', error });
const REMOTE = 'git+https://github.com/Apra-Labs/apra-fleet.git';
const REMOTE_JSON = { ok: true, output: JSON.stringify({ value: REMOTE }), error: null };
/** The exact `git ls-remote` target REMOTE resolves to -- a fingerprint is
 *  bound to this URL, so every hand-planted tip below names it. */
const PROBE_URL = 'https://github.com/Apra-Labs/apra-fleet.git';
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
const LS_REMOTE = ' ls-remote ';
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
    assert.deepEqual(await readMemberSyncRemote('m1', { command }), { configured: true, url: REMOTE, positive: true });
});

test('memo: verify:true bypasses the memo, refreshes it, and a fail-safe answer reports positive:false', async () => {
    const { command, countOf } = makeCommandMock({ [PROBE]: [REMOTE_JSON] });
    await readMemberSyncRemote('m1', { command });
    await readMemberSyncRemote('m1', { command, verify: true });
    assert.equal(countOf(PROBE), 2, 'verify must re-spawn the probe');
    await readMemberSyncRemote('m1', { command });
    assert.equal(countOf(PROBE), 2, '...and the refreshed answer is memoized again');
    const { command: broken } = makeCommandMock({ [PROBE]: [fail('bd exploded')] });
    assert.deepEqual(await readMemberSyncRemote('m1', { command: broken, verify: true }), { configured: true, url: null, positive: false });
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
    setLastSyncedTip('m1', SHA_A, PROBE_URL);
    setLastSyncedTip('m2', SHA_A, PROBE_URL);
    assert.equal(noteMemberCommand('m1', 'cd /tmp/x && bd bootstrap'), true);
    assert.equal(getLastSyncedTip('m1'), undefined, 'a re-bootstrapped clone must not keep its fingerprint');
    assert.equal(getLastSyncedTip('m2'), SHA_A, 'only the named member is affected');
    // ...and the next D-pull for that member is real, not remote-unchanged.
    const res = await doltPullBefore('m1', { command });
    assert.deepEqual(res, { ok: true, member: 'm1' });
    assert.equal(countOf(PULL), 1);
});

test('memo: a non-invalidating command leaves the recorded tip alone', async () => {
    setLastSyncedTip('m1', SHA_A, PROBE_URL);
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

test('memo: the auth self-heal path ALSO forgets the recorded tip, symmetric with repair() (round-3 item 6)', async () => {
    // A re-provisioned credential can rewire the remote the fingerprint was
    // minted against. Round 2 dropped only the sync.remote memo here; the
    // module's own invariant says both memos go together, and repair()
    // already did both. Use a D-PUSH so the pre-pull probe path cannot be what
    // records or clears anything: the only tip mutation in this test is the
    // self-heal's.
    const { command } = makeCommandMock({
        [PROBE]: [REMOTE_JSON],
        [PUSH]: [fail('fatal: could not read Username for https://github.com'), fail('fatal: could not read Username for https://github.com')],
    });
    setLastSyncedTip('m1', SHA_A, PROBE_URL);
    setLastSyncedTip('m2', SHA_A, PROBE_URL);
    let healed = 0;
    await assert.rejects(() => doltPushAfter('m1', {
        command,
        pushBeads: true,
        sleep: async () => {},
        onAuthFailure: async () => {
            healed += 1;
            assert.equal(getLastSyncedTip('m1'), undefined, 'the tip must already be gone when the self-heal callback runs');
        },
    }));
    assert.equal(healed, 1, 'the one-shot self-heal fired');
    assert.equal(getLastSyncedTip('m1'), undefined);
    assert.equal(getLastSyncedTip('m2'), SHA_A, 'only the healed member is affected');
});

// -----------------------------------------------------------------------------
// Round 4 -- the post-dispatch seam is SOFT. An agent's `bd` commands run in
// its own session on the member and never pass through the runner's command()
// wrapper, so noteMemberCommand() is structurally blind to them. Round 3 made
// every settled dispatch wipe both memos, which emptied the fingerprint before
// every dispatch bracket (the primary path) and re-spawned the sync.remote
// probe once per dispatch (golden transcript: 1 -> 14). Round 4 replaces the
// wipe with a MARK: the memos survive the dispatch, and the member's
// sync.remote is re-read only at the one decision a stale memo could turn
// into stale data -- the moment a D-pull is about to be SKIPPED on the
// fingerprint. See noteMemberDispatchCompleted() for the per-event reasoning
// (bootstrap is non-destructive / clones from the remote; a forced init is
// unrescuable by any pull; a rewired sync.remote is caught right here).
// -----------------------------------------------------------------------------

/** One member's bracket under the runner: pre-dispatch D-pull, the dispatch
 *  itself (the seam), and -- for a beads-mutating role -- the D-push. */
async function bracket(member, command, { pushBeads = false } = {}) {
    const pull = await doltPullBefore(member, { command });
    noteMemberDispatchCompleted(member);
    if (pushBeads) await doltPushAfter(member, { command, pushBeads: true });
    return pull;
}

test('dispatch seam: THE RESTORED BENEFIT -- a read-only dispatch keeps the fingerprint, so the next bracket skips its pull', async () => {
    const { command, countOf } = makeCommandMock({
        [PROBE]: [REMOTE_JSON],
        [LS_REMOTE]: [lsRemote(SHA_A)],
        [PULL]: [OK],
    });
    // Bracket 1: no fingerprint yet -> real pull, tip recorded.
    assert.deepEqual(await bracket('m1', command), { ok: true, member: 'm1' });
    assert.equal(countOf(PULL), 1);
    assert.equal(isMemberDispatchedSinceVerified('m1'), true, 'the dispatch marked the member');
    // Brackets 2..4 (reviewer / plan-reviewer / deployer style, no push): the
    // remote never moved, so every one of them is a provable no-op and is
    // skipped. Round 3 pulled for real on every one of these.
    for (let i = 0; i < 3; i += 1) {
        const res = await bracket('m1', command);
        assert.equal(res.reason, 'remote-unchanged', `bracket ${i + 2} must skip`);
    }
    assert.equal(countOf(PULL), 1, 'exactly one real pull across four brackets');
    // The price of the first skip after a dispatch is ONE sync.remote re-read
    // (a config.yaml read), after which the member is verified again until
    // its next dispatch: 1 initial probe + 1 re-read per post-dispatch skip.
    assert.equal(countOf(PROBE), 4, 'one initial probe, then one re-read per post-dispatch skip -- never per dispatch');
    assert.equal(isMemberDispatchedSinceVerified('m1'), true, 'the last bracket dispatched again, so the mark is set again');
});

test('dispatch seam: consecutive orchestrator-only reads between dispatches re-read NOTHING', async () => {
    const { command, countOf } = makeCommandMock({
        [PROBE]: [REMOTE_JSON],
        [LS_REMOTE]: [lsRemote(SHA_A)],
        [PULL]: [OK],
    });
    await bracket('m1', command);
    const probesAfterBracket = countOf(PROBE);
    // The first post-dispatch skip re-verifies once...
    assert.equal((await doltPullBefore('m1', { command })).reason, 'remote-unchanged');
    assert.equal(countOf(PROBE), probesAfterBracket + 1);
    assert.equal(isMemberDispatchedSinceVerified('m1'), false, 'a positive re-read clears the mark');
    // ...and every further read with no dispatch in between is a pure cache hit.
    for (let i = 0; i < 5; i += 1) {
        assert.equal((await doltPullBefore('m1', { command })).reason, 'remote-unchanged');
    }
    assert.equal(countOf(PROBE), probesAfterBracket + 1);
    assert.equal(countOf(PULL), 1);
});

test('dispatch seam: a bracket whose remote tip MOVED pays no re-read at all', async () => {
    const { command, countOf } = makeCommandMock({
        [PROBE]: [REMOTE_JSON],
        [LS_REMOTE]: [lsRemote(SHA_A), lsRemote(SHA_B)],
        [PULL]: [OK],
    });
    await bracket('m1', command);
    const probesAfterBracket = countOf(PROBE);
    const res = await doltPullBefore('m1', { command });
    assert.deepEqual(res, { ok: true, member: 'm1' }, 'moved tip -> real pull');
    assert.equal(countOf(PROBE), probesAfterBracket, 'no skip was on the table, so nothing to confirm');
    assert.equal(getLastSyncedTip('m1'), SHA_B);
    assert.equal(isMemberDispatchedSinceVerified('m1'), true, 'still unverified -- the next SKIP will confirm');
});

test('dispatch seam: a beads-mutating dispatch still forgets the tip via its push -- the seam adds nothing on top', async () => {
    const { command, countOf } = makeCommandMock({
        [PROBE]: [REMOTE_JSON],
        [LS_REMOTE]: [lsRemote(SHA_A)],
        [PULL]: [OK],
        [PUSH]: [OK],
    });
    await bracket('m1', command, { pushBeads: true });
    assert.equal(getLastSyncedTip('m1'), undefined, 'the push forgot the tip (round-3 item 1), as before');
    assert.equal(countOf(PROBE), 1, 'the D-push pre-gate was a memo hit -- the seam did not drop the memo');
    const res = await doltPullBefore('m1', { command });
    assert.equal(res.skipped, undefined, "the pusher's next pull is real");
    assert.equal(countOf(PULL), 2);
});

// The reliability side. `remote.tip` is the shared refs/dolt/data; `clone`
// models what the member's local DB is derived from ('remote@<sha>' means it
// was cloned/pulled from the remote at that SHA); the dispatch callback is
// what the agent did to the member in its own session.
function makeMemberWorld({ initialTip }) {
    const remote = { tip: initialTip };
    const member = { clone: null, syncRemote: REMOTE };
    const calls = [];
    const command = async (cmd, opts = {}) => {
        calls.push({ cmd, opts });
        if (cmd.includes(PROBE)) return { ok: true, output: JSON.stringify({ value: member.syncRemote }), error: null };
        if (cmd.includes(LS_REMOTE)) return lsRemote(remote.tip);
        if (cmd.includes(PULL)) { member.clone = `remote@${remote.tip}`; return OK; }
        return OK;
    };
    const countOf = (needle) => calls.filter((c) => c.cmd.includes(needle)).length;
    return { remote, member, command, calls, countOf };
}

test('dispatch seam: RELIABILITY -- an agent-side `bd bootstrap` leaves the fingerprint TRUE, so the skip it permits is correct', async () => {
    const { remote, member, command, countOf } = makeMemberWorld({ initialTip: SHA_A });
    await doltPullBefore('m1', { command });
    assert.equal(member.clone, `remote@${SHA_A}`);
    // The agent's session: `bd bootstrap` with a DB present is non-destructive
    // (validates, reports "database exists"); with `--database <other>` it
    // CLONES from sync.remote -- i.e. the clone is at the remote's tip.
    member.clone = `remote@${remote.tip}`;
    noteMemberDispatchCompleted('m1');
    const res = await doltPullBefore('m1', { command });
    assert.equal(res.reason, 'remote-unchanged');
    assert.equal(member.clone, `remote@${SHA_A}`, 'the skipped pull would have fetched exactly what the clone already holds');
    assert.equal(countOf(PULL), 1);
});

test('dispatch seam: RELIABILITY -- a remote that moved DURING the dispatch is never skipped, bootstrap or not', async () => {
    const { remote, member, command, countOf } = makeMemberWorld({ initialTip: SHA_A });
    await doltPullBefore('m1', { command });
    remote.tip = SHA_B; // some other machine pushed while the agent ran
    member.clone = `remote@${SHA_A}`;
    noteMemberDispatchCompleted('m1');
    const res = await doltPullBefore('m1', { command });
    assert.deepEqual(res, { ok: true, member: 'm1' });
    assert.equal(member.clone, `remote@${SHA_B}`, 'the real pull brought the clone current');
    assert.equal(countOf(PULL), 2);
});

test('dispatch seam: RELIABILITY -- an agent-side `bd config set sync.remote <other>` is caught before the skip; the fingerprint is forgotten', async () => {
    const OTHER = 'git+https://example.invalid/other/beads.git';
    const { member, command, countOf, calls } = makeMemberWorld({ initialTip: SHA_A });
    await doltPullBefore('m1', { command });
    assert.equal(getLastSyncedTip('m1'), SHA_A);
    // The one reset a surviving fingerprint would get WRONG: the clone should
    // now follow a different remote, whose tip the old fingerprint says
    // nothing about. The agent's own `bd config set` never passed through
    // command(), so only the lazy re-read can see it.
    member.syncRemote = OTHER;
    noteMemberDispatchCompleted('m1');
    const res = await doltPullBefore('m1', { command });
    assert.deepEqual(res, { ok: true, member: 'm1' }, 'must NOT skip on a fingerprint minted against the old remote');
    assert.equal(countOf(PULL), 2);
    assert.equal(getLastSyncedTip('m1'), undefined, 'the stale fingerprint is forgotten, not re-recorded from a probe of the wrong remote');
    assert.equal(isMemberDispatchedSinceVerified('m1'), false, 'the re-read verified the member');
    // From here on the probe targets the NEW remote (the memo was refreshed).
    await doltPullBefore('m1', { command });
    const lastProbe = calls.filter((c) => c.cmd.includes(LS_REMOTE)).pop();
    assert.equal(lastProbe.cmd, 'git -c credential.interactive=never -c core.askPass= ls-remote https://example.invalid/other/beads.git refs/dolt/data');
});

test('dispatch seam: RELIABILITY -- a sync.remote NEUTRALIZED under a dispatch takes the no-remote exit: no pull command, fingerprint forgotten', async () => {
    // The pre-gate's own contract: a `bd dolt pull` against a clone whose
    // sync.remote is absent would let bd re-arm a Dolt remote from git's
    // origin. The re-read that guards the skip must honor that contract too,
    // not fall through to "pull for real".
    const { member, command, countOf } = makeMemberWorld({ initialTip: SHA_A });
    await doltPullBefore('m1', { command });
    member.syncRemote = '';
    noteMemberDispatchCompleted('m1');
    const res = await doltPullBefore('m1', { command });
    assert.deepEqual(res, { ok: true, member: 'm1', skipped: true, reason: 'no-remote' });
    assert.equal(countOf(PULL), 1, 'no bd dolt pull against a neutralized clone');
    assert.equal(getLastSyncedTip('m1'), undefined);
    // ...and the memo now says absent, so the next bracket's pre-gate exits
    // before any probe.
    const probes = countOf(PROBE);
    const next = await doltPullBefore('m1', { command });
    assert.equal(next.reason, 'no-remote');
    assert.equal(countOf(PROBE), probes);
    assert.equal(countOf(LS_REMOTE), 2);
});

test('dispatch seam: RELIABILITY -- a member memoized as NO-REMOTE re-reads sync.remote after a dispatch, so a remote wired by the agent is honored (round-4 review, finding 1)', async () => {
    // The cached "absent" answer never reaches the skip path (both pre-gates
    // exit on it first), so without this the member's every later D-push
    // would report a benign no-remote skip -- success -- while its bead
    // closes never left the clone, for the rest of the process.
    const { member, command, countOf } = makeMemberWorld({ initialTip: SHA_A });
    member.syncRemote = '';
    assert.equal((await doltPullBefore('m1', { command })).reason, 'no-remote');
    assert.equal((await doltPushAfter('m1', { command, pushBeads: true })).reason, 'no-remote');
    assert.equal(countOf(PROBE), 1, 'absent is memoized like any positive answer');
    // Undispatched, the memo holds.
    assert.equal((await doltPullBefore('m1', { command })).reason, 'no-remote');
    assert.equal(countOf(PROBE), 1);
    // The agent wires a remote in its own session (bd init --remote / bd
    // config set sync.remote), invisible to noteMemberCommand.
    member.syncRemote = REMOTE;
    noteMemberDispatchCompleted('m1');
    const push = await doltPushAfter('m1', { command, pushBeads: true });
    assert.equal(push.pushed, true, 'the post-dispatch D-push must publish, not take the stale no-remote exit');
    assert.equal(countOf(PROBE), 2, 'exactly one re-read, at the first pre-gate after the dispatch');
    assert.equal(countOf(PUSH), 1);
    assert.equal(isMemberDispatchedSinceVerified('m1'), false);
    // ...and the refreshed answer is memoized again: the next pull probes the
    // remote for real, with no further config get.
    const pull = await doltPullBefore('m1', { command });
    assert.deepEqual(pull, { ok: true, member: 'm1' });
    assert.equal(countOf(PROBE), 2);
    assert.equal(countOf(LS_REMOTE), 1);
});

test('dispatch seam: a member memoized as NO-REMOTE that stays that way pays one re-read per dispatch, nothing more', async () => {
    const { command, countOf } = makeCommandMock({
        [PROBE]: [{ ok: true, output: JSON.stringify({ value: '' }), error: null }],
    });
    await bracket('m1', command, { pushBeads: true });
    await bracket('m1', command, { pushBeads: true });
    await bracket('m1', command, { pushBeads: true });
    // bracket = pull pre-gate + dispatch + push pre-gate: the first pre-gate
    // after each dispatch re-reads, the one before it is a hit -- so one
    // initial probe plus at most one per dispatch.
    assert.equal(countOf(PROBE), 4, '1 + one per dispatch for a no-remote member (the golden mock sprint is exactly this shape)');
    assert.equal(countOf(PULL) + countOf(PUSH) + countOf(LS_REMOTE), 0, 'still never a bd dolt command against a neutralized clone');
});

test('dispatch seam: RELIABILITY -- an UNREADABLE sync.remote after a dispatch falls through to a real pull, never a skip', async () => {
    const probeResults = [REMOTE_JSON, fail('bd exploded')];
    const { command, countOf } = makeCommandMock({
        [PROBE]: probeResults,
        [LS_REMOTE]: [lsRemote(SHA_A)],
        [PULL]: [OK],
    });
    await bracket('m1', command);
    const res = await doltPullBefore('m1', { command });
    assert.deepEqual(res, { ok: true, member: 'm1' }, 'doubt never produces a skip');
    assert.equal(countOf(PULL), 2);
    assert.equal(getLastSyncedTip('m1'), SHA_A, 'the tip observed at the still-memoized URL is recorded by the real pull');
    assert.equal(isMemberDispatchedSinceVerified('m1'), true, 'still unverified: the next skip attempt confirms again');
});

test('dispatch seam: a fingerprint minted at one URL never validates a probe of another', async () => {
    setLastSyncedTip('m1', SHA_A, 'https://example.invalid/elsewhere.git');
    const { command, countOf } = makeCommandMock({
        [PROBE]: [REMOTE_JSON],
        [LS_REMOTE]: [lsRemote(SHA_A)],
        [PULL]: [OK],
    });
    const res = await doltPullBefore('m1', { command });
    assert.deepEqual(res, { ok: true, member: 'm1' });
    assert.equal(countOf(PULL), 1);
    assert.equal(getLastSyncedTip('m1'), SHA_A, 're-minted against the URL actually probed');
});

test('dispatch seam: setLastSyncedTip without a URL records nothing (doubt never skips)', async () => {
    setLastSyncedTip('m1', SHA_A);
    assert.equal(getLastSyncedTip('m1'), undefined);
    setLastSyncedTip('m1', SHA_A, '');
    assert.equal(getLastSyncedTip('m1'), undefined);
});

test('dispatch seam: a non-member argument is a no-op and never throws', () => {
    setLastSyncedTip('m1', SHA_A, PROBE_URL);
    assert.equal(noteMemberDispatchCompleted(''), false);
    assert.equal(noteMemberDispatchCompleted(undefined), false);
    assert.equal(noteMemberDispatchCompleted(null), false);
    assert.equal(getLastSyncedTip('m1'), SHA_A);
    assert.equal(isMemberDispatchedSinceVerified('m1'), false);
});

test('dispatch seam: the HARD seams clear the mark along with both memos', async () => {
    const { command } = makeCommandMock({ [PROBE]: [REMOTE_JSON] });
    await isMemberSyncRemoteConfigured('m1', { command });
    noteMemberDispatchCompleted('m1');
    assert.equal(isMemberDispatchedSinceVerified('m1'), true);
    noteMemberCommand('m1', 'bd bootstrap');
    assert.equal(isMemberDispatchedSinceVerified('m1'), false);
    noteMemberDispatchCompleted('m1');
    await repair('m1', { command, settle: async () => ({ ok: true, resolvedTables: [] }) });
    assert.equal(isMemberDispatchedSinceVerified('m1'), false);
});

test('dispatch seam: runner.js calls it from the central agent() wrapper, in a finally, before the post-dispatch sync can run', () => {
    // Static pin on the wiring: the seam only upholds its invariant if it is
    // installed at the ONE place every dispatch settles (the agent() wrapper,
    // which withGitSync awaits before its post-dispatch D-push) and fires on
    // failure as well as success (a `finally`). A refactor that moves it into
    // one withGitSync branch, or behind a success check, must fail here.
    const runnerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fleet-sprint/runner.js');
    const source = fs.readFileSync(runnerPath, 'utf-8');
    const wrapper = source.match(/const agent = async \(prompt, opts = \{\}\) => \{[\s\S]*?\n {4}\};/);
    assert.ok(wrapper, 'expected the central agent() wrapper in runner.js');
    assert.match(wrapper[0], /agentRaw\(/, 'the wrapper must still delegate to the raw primitive');
    assert.match(
        wrapper[0],
        /finally\s*\{\s*if \(opts\.member_name\) DoltSync\.noteMemberDispatchCompleted\(opts\.member_name\);/,
        'the seam must fire from a finally inside the agent() wrapper, keyed on the dispatched member',
    );
    assert.equal(
        (source.match(/DoltSync\.noteMemberDispatchCompleted\(/g) || []).length, 1,
        'exactly one call site: the central wrapper (per-call-site invalidation is the pattern this replaces)',
    );
});

test('memo: repair() invalidates both the sync.remote memo and the recorded tip', async () => {
    const { command } = makeCommandMock({ [PROBE]: [REMOTE_JSON] });
    await isMemberSyncRemoteConfigured('m1', { command });
    setLastSyncedTip('m1', SHA_A, PROBE_URL);
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
    // Round-3 item 5: the memory-resources wording on its own is NOT the
    // class. It was a dead pattern -- the 'dolt' provider's TRANSIENT table
    // has no such entry, so a text carrying only that wording classifies
    // 'unknown' and never reaches this sub-classifier; and Go's os/exec always
    // prefixes a spawn refusal with `fork/exec <path>:`, so the live incident
    // text carries both halves on one line. The list now matches what can
    // actually arrive here, nothing more.
    assert.equal(classifyDoltFailure('Not enough memory resources are available to process this command.'), 'unknown');
    assert.equal(isSpawnOutageFailure('Not enough memory resources are available to process this command.'), false);
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

test('retry: a spawn outage is bounded by WALL CLOCK, not by the generic retry count, when maxTransientRetries is left unset', async () => {
    // A fake clock the injected sleep() advances, so the budget is exercised
    // deterministically and the suite never actually waits. No explicit
    // maxTransientRetries: the production shape (no runner call site passes
    // one), so the spawn-outage class gets its full wall-clock budget.
    let clock = 0;
    const { command, countOf } = makeCommandMock({
        [PROBE]: [REMOTE_JSON],
        [PULL]: [fail('fork/exec git.exe: Not enough memory resources')],
    });
    await assert.rejects(() => doltPullBefore('m1', {
        command,
        remoteTipFingerprint: false,
        now: () => clock,
        sleep: async (ms) => { clock += ms; },
    }));
    // Far more than the 5-retry generic ladder would allow: the ladder ran
    // until the 3-minute wall-clock budget was spent.
    assert.ok(countOf(PULL) > DOLT_GENERIC_TRANSIENT_MAX_RETRIES + 1, `expected the wall-clock budget to outlast the generic count bound, saw ${countOf(PULL)} attempts`);
    assert.ok(clock >= DOLT_SPAWN_OUTAGE_BUDGET_MS, `expected the full budget to be consumed, saw ${clock}ms`);
});

test('retry: an EXPLICIT maxTransientRetries caps the spawn-outage ladder too (round-3 item 4)', async () => {
    // The documented contract: "an explicitly passed maxTransientRetries is
    // still honored". Round 2 honored it only for the generic class; the
    // spawn-outage branch ignored it and always ran to its 3-minute budget. A
    // caller asking for a tight bound must get one on BOTH ladders.
    let clock = 0;
    const { command, countOf } = makeCommandMock({
        [PROBE]: [REMOTE_JSON],
        [PULL]: [fail('fork/exec git.exe: Not enough memory resources')],
    });
    await assert.rejects(() => doltPullBefore('m1', {
        command,
        remoteTipFingerprint: false,
        maxTransientRetries: 2,
        now: () => clock,
        sleep: async (ms) => { clock += ms; },
    }));
    assert.equal(countOf(PULL), 3, 'initial attempt plus exactly the 2 explicitly requested retries');
    assert.ok(clock < DOLT_SPAWN_OUTAGE_BUDGET_MS, `the explicit cap must stop the ladder long before the wall-clock budget, saw ${clock}ms`);
    // ...and it is a cap, not a floor: the wall-clock budget still applies
    // underneath a generous explicit count.
    clock = 0;
    const { command: c2, countOf: count2 } = makeCommandMock({
        [PROBE]: [REMOTE_JSON],
        [PULL]: [() => { clock += 60000; return fail('fork/exec git.exe: Not enough memory resources'); }],
    });
    await assert.rejects(() => doltPullBefore('m1', {
        command: c2,
        remoteTipFingerprint: false,
        maxTransientRetries: 100,
        now: () => clock,
        sleep: async (ms) => { clock += ms; },
    }));
    assert.ok(count2(PULL) <= 5, `the wall-clock budget must still bound a 60s-per-attempt outage under a large explicit cap, saw ${count2(PULL)}`);
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

test('fingerprint: toGitLsRemoteUrl REFUSES a bare Dolt remote NAME or a scheme-less path (round-4 fix A)', () => {
    // sync.remote can legitimately be a Dolt remote NAME (the integration
    // fixtures set `bd config set sync.remote origin`). It passes the charset
    // gate, but `git ls-remote origin` resolves against GIT'S origin -- the
    // one target this probe must never use. A bare filesystem path is a Dolt
    // file remote, never a git repository. Both yield null: a real pull.
    for (const bare of ['origin', 'upstream', 'my-remote', '/srv/dolt/beads', 'C:/dolt/beads', 'github.com/a/b.git', 'git+origin']) {
        assert.equal(toGitLsRemoteUrl(bare), null, `expected ${JSON.stringify(bare)} to be refused`);
    }
    // Scheme-bearing values -- including bd's own git+file:// spelling that the
    // sandboxes use -- are still accepted.
    assert.equal(toGitLsRemoteUrl('git+file:///tmp/sbx/.apra-fleet-toy-origin.git'), 'file:///tmp/sbx/.apra-fleet-toy-origin.git');
    assert.equal(toGitLsRemoteUrl('file:///C:/Users/x/origin.git'), 'file:///C:/Users/x/origin.git');
});

test('fingerprint: a bare remote-name sync.remote issues NO ls-remote and does a real pull (round-4 fix A)', async () => {
    const { command, countOf } = makeCommandMock({
        [PROBE]: [{ ok: true, output: JSON.stringify({ value: 'origin' }), error: null }],
        [PULL]: [OK],
    });
    setLastSyncedTip('m1', SHA_A, 'origin');
    const res = await doltPullBefore('m1', { command });
    assert.deepEqual(res, { ok: true, member: 'm1' });
    assert.equal(countOf(LS_REMOTE), 0, "must never run `git ls-remote origin` -- that is git's origin, not the Dolt remote");
    assert.equal(countOf(PULL), 1);
});

test('fingerprint: toGitLsRemoteUrl STRIPS http(s) userinfo so a credential never enters a journaled command (round-4 fix B)', () => {
    assert.equal(
        toGitLsRemoteUrl('git+https://x-access-token:ghp_AbC123XYZ@github.com/Apra-Labs/apra-fleet.git'),
        'https://github.com/Apra-Labs/apra-fleet.git',
    );
    assert.equal(toGitLsRemoteUrl('https://user@github.com/a/b.git'), 'https://github.com/a/b.git');
    assert.equal(toGitLsRemoteUrl('http://user:p-w_d.1@host.example/a.git'), 'http://host.example/a.git');
    // A password full of shell metacharacters must not disable the probe: the
    // charset gate runs on the STRIPPED url.
    assert.equal(toGitLsRemoteUrl('https://u:p$(x)`y`\'z\'@github.com/a/b.git'), 'https://github.com/a/b.git');
    // ssh userinfo is the login name, not a secret, and is needed to connect.
    assert.equal(toGitLsRemoteUrl('ssh://git@github.com/a/b.git'), 'ssh://git@github.com/a/b.git');
    assert.equal(toGitLsRemoteUrl('git+ssh://git@github.com/a/b.git'), 'ssh://git@github.com/a/b.git');
});

test('fingerprint: the journaled probe command carries no credential even when sync.remote embeds one (round-4 fix B)', async () => {
    const TOKEN = 'ghp_SECRETSECRETSECRET';
    const { command, calls } = makeCommandMock({
        [PROBE]: [{ ok: true, output: JSON.stringify({ value: `git+https://x-access-token:${TOKEN}@github.com/o/r.git` }), error: null }],
        [LS_REMOTE]: [lsRemote(SHA_A)],
        [PULL]: [OK],
    });
    await doltPullBefore('m1', { command });
    const probe = calls.find((c) => c.cmd.includes(LS_REMOTE));
    assert.ok(probe, 'expected an ls-remote probe');
    assert.equal(probe.cmd, 'git -c credential.interactive=never -c core.askPass= ls-remote https://github.com/o/r.git refs/dolt/data');
    for (const c of calls) {
        assert.ok(!c.cmd.includes(TOKEN), `credential leaked into a command string: ${c.cmd}`);
        assert.ok(!String(c.opts.label || '').includes(TOKEN), 'credential leaked into a command label');
    }
    assert.equal(getLastSyncedTip('m1'), SHA_A);
});

test('fingerprint: the probe can never wait on a credential prompt (round-4 review, finding 2)', async () => {
    const { command, calls } = makeCommandMock({
        [PROBE]: [REMOTE_JSON],
        [LS_REMOTE]: [lsRemote(SHA_A)],
        [PULL]: [OK],
    });
    await doltPullBefore('m1', { command });
    const probe = calls.find((c) => c.cmd.includes(LS_REMOTE));
    // GCM's own no-UI switch, and no askpass program: with no terminal an
    // unauthenticated probe fails at once instead of sitting on the 30s
    // probe timeout every bracket. `-c` config, never a shell env prefix
    // (the member's shell may be PowerShell).
    assert.match(probe.cmd, /^git -c credential\.interactive=never -c core\.askPass= ls-remote /);
    assert.ok(!/^\s*\w+=\S+\s+git/.test(probe.cmd), 'no shell-level env assignment');
    assert.equal(probe.opts.timeout_s, 30);
});

test('fingerprint: a probe that keeps failing is DISABLED for the member after two consecutive failures (round-4 review, finding 2)', async () => {
    // A member whose only credential was the URL-embedded one (no helper), or
    // whose sync.remote is a Dolt-native remote git cannot list, would
    // otherwise pay a failed round trip on every one of ~20 brackets.
    const { command, countOf } = makeCommandMock({
        [PROBE]: [REMOTE_JSON],
        [LS_REMOTE]: [fail('fatal: could not read Username for https://github.com: terminal prompts disabled')],
        [PULL]: [OK],
    });
    assert.equal(DOLT_TIP_PROBE_MAX_CONSECUTIVE_FAILURES, 2);
    for (let i = 0; i < 6; i += 1) {
        const res = await doltPullBefore('m1', { command });
        assert.deepEqual(res, { ok: true, member: 'm1' }, 'always a real pull, never a skip');
    }
    assert.equal(countOf(LS_REMOTE), 2, 'two failed probes, then none');
    assert.equal(isTipProbeDisabled('m1'), true);
    assert.equal(countOf(PULL), 6);
    assert.equal(isTipProbeDisabled('m2'), false, 'per member');
    // A hard seam (credentials re-provisioned, a repair, an orchestrator
    // rewire) re-arms the probe.
    noteMemberCommand('m1', 'bd config set sync.remote x');
    assert.equal(isTipProbeDisabled('m1'), false);
    await doltPullBefore('m1', { command });
    assert.equal(countOf(LS_REMOTE), 3);
});

test('fingerprint: one probe blip does not disable the probe -- a success resets the failure count', async () => {
    const { command, countOf } = makeCommandMock({
        [PROBE]: [REMOTE_JSON],
        [LS_REMOTE]: [fail('Could not resolve host'), lsRemote(SHA_A), fail('Could not resolve host'), lsRemote(SHA_A)],
        [PULL]: [OK],
    });
    for (let i = 0; i < 4; i += 1) await doltPullBefore('m1', { command });
    assert.equal(countOf(LS_REMOTE), 4, 'never disabled: failures were not consecutive');
    assert.equal(isTipProbeDisabled('m1'), false);
    assert.equal(getLastSyncedTip('m1'), SHA_A);
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
    setLastSyncedTip('m1', SHA_A, PROBE_URL);
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
    setLastSyncedTip('m1', SHA_A, PROBE_URL);
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
    setLastSyncedTip('m1', SHA_A, PROBE_URL);
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
    setLastSyncedTip('m1', SHA_A, PROBE_URL);
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
    setLastSyncedTip('m1', SHA_A, PROBE_URL);
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
    setLastSyncedTip('m1', SHA_A, PROBE_URL);
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
    assert.equal(probe.cmd, 'git -c credential.interactive=never -c core.askPass= ls-remote https://example.invalid/other/repo.git refs/dolt/data');
    assert.ok(!/\borigin\b/.test(probe.cmd), 'must never probe git origin -- it can differ from sync.remote');
});

test('fingerprint: remoteTipFingerprint:false disables the probe entirely', async () => {
    const { command, countOf } = makeCommandMock({
        [PROBE]: [REMOTE_JSON],
        [LS_REMOTE]: [lsRemote(SHA_A)],
        [PULL]: [OK],
    });
    setLastSyncedTip('m1', SHA_A, PROBE_URL);
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
    setLastSyncedTip('m1', SHA_A, PROBE_URL);
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

// -----------------------------------------------------------------------------
// The PUSH side (round-3 item 1). A push never records a fingerprint -- it
// only forgets one -- and issues no ls-remote at all. See "WHY A PUSH CANNOT
// MINT A FINGERPRINT" in dolt-sync.mjs: the remote's new refs/dolt/data SHA
// is a git commit minted INSIDE the push (Dolt's git blobstore), not derivable
// from local state, and any post-push network read can observe a stranger's
// later push instead of ours.
// -----------------------------------------------------------------------------

/**
 * A tiny model of the SHARED remote plus one member's command() against it:
 * `remote.tip` is the live refs/dolt/data; ls-remote reads it; this member's
 * push advances it to `pushedTo`. `afterPush` runs synchronously the moment
 * the push has landed -- i.e. in the window BEFORE any post-push read this
 * member could issue -- which is where a foreign machine's push goes.
 */
function makeRacingRemote({ initialTip, pushedTo, afterPush = () => {} }) {
    const remote = { tip: initialTip };
    const calls = [];
    const command = async (cmd, opts = {}) => {
        calls.push({ cmd, opts });
        if (cmd.includes(PROBE)) return REMOTE_JSON;
        if (cmd.includes(LS_REMOTE)) return lsRemote(remote.tip);
        if (cmd.includes(PUSH)) {
            remote.tip = pushedTo;
            afterPush(remote);
            return OK;
        }
        return OK;
    };
    const countOf = (needle) => calls.filter((c) => c.cmd.includes(needle)).length;
    return { remote, command, calls, countOf };
}

test('fingerprint: THE FOREIGN-PUSH RACE -- an unrelated machine pushes right after ours; its SHA must never become our tip', async () => {
    // The race the round-2 design lost:
    //   1. this member is current with the remote at SHA_A (pulled it).
    //   2. this member pushes local commits; the remote advances to SHA_B.
    //   3. BEFORE this member could read the remote again, an unrelated
    //      machine (not in this fleet, not under our push mutex) pushes; the
    //      remote is now at SHA_C, which this clone has never seen.
    //   4. the round-2 code read the tip here, saw SHA_C !== SHA_A ("the ref
    //      advanced, so I moved it"), recorded SHA_C as this member's
    //      lastSyncedTip -- and the next D-pull saw SHA_C === SHA_C and
    //      SKIPPED the pull that would have fetched the stranger's commit.
    const SHA_C = 'cccccccccccccccccccccccccccccccccccccccc';
    const { command, countOf } = makeRacingRemote({
        initialTip: SHA_A,
        pushedTo: SHA_B,
        afterPush: (remote) => { remote.tip = SHA_C; }, // the foreign push
    });
    setLastSyncedTip('m1', SHA_A, PROBE_URL);

    const res = await doltPushAfter('m1', { command, pushBeads: true });
    assert.equal(res.pushed, true);
    assert.equal(countOf(LS_REMOTE), 0, 'a push must never read the remote tip -- that read is the race');
    assert.notEqual(getLastSyncedTip('m1'), SHA_C, "the stranger's SHA must never be recorded as ours");
    assert.equal(getLastSyncedTip('m1'), undefined, 'a push FORGETS the fingerprint; it never mints one');

    // The proof that matters: the next D-pull is REAL and fetches SHA_C.
    const pullRes = await doltPullBefore('m1', { command });
    assert.equal(pullRes.skipped, undefined, 'the next D-pull must not be skipped against a foreign SHA');
    assert.equal(countOf(PULL), 1);
    assert.equal(getLastSyncedTip('m1'), SHA_C, 'only the pull may record the tip, and only the one it observed before pulling');
    // ...after which, with the remote quiet, the skip is re-armed as usual.
    await doltPullBefore('m1', { command });
    assert.equal(countOf(PULL), 1);
});

test('fingerprint: a real push FORGETS the tip and issues no ls-remote; the next pull is real, then re-arms the skip', async () => {
    const { command, countOf } = makeRacingRemote({ initialTip: SHA_A, pushedTo: SHA_B });
    setLastSyncedTip('m1', SHA_A, PROBE_URL);
    const res = await doltPushAfter('m1', { command, pushBeads: true });
    assert.deepEqual(res, { ok: true, member: 'm1', pushed: true, reconciled: false });
    assert.equal(countOf(LS_REMOTE), 0, 'no probe before OR after the push (round-3 item 3: no network round trip inside the mutex)');
    assert.equal(getLastSyncedTip('m1'), undefined);
    const pullRes = await doltPullBefore('m1', { command });
    assert.equal(pullRes.skipped, undefined, "the pusher's next pull is real (one redundant pull is the safe error)");
    assert.equal(countOf(PULL), 1);
    assert.equal(getLastSyncedTip('m1'), SHA_B);
    await doltPullBefore('m1', { command });
    assert.equal(countOf(PULL), 1, 'the pull after that is a provable no-op again');
});

test('fingerprint: a NO-OP push (nothing local to publish) records nothing either -- the round-2 race stays closed', async () => {
    // Another machine pushed (remote at SHA_B); this member never pulled that
    // and pushes with nothing new -- `bd dolt push` still exits 0 and the ref
    // does not move. Recording SHA_B would claim a freshness this clone lacks.
    // The push layer cannot even tell a no-op from a real push (bd prints the
    // same output for both), and it does not need to: neither records.
    const { command, countOf } = makeRacingRemote({ initialTip: SHA_B, pushedTo: SHA_B });
    const res = await doltPushAfter('m1', { command, pushBeads: true });
    assert.equal(res.pushed, true);
    assert.equal(getLastSyncedTip('m1'), undefined, 'a no-op push must never mint a fingerprint');
    const pullRes = await doltPullBefore('m1', { command });
    assert.equal(pullRes.skipped, undefined, 'the next D-pull must be REAL, not remote-unchanged');
    assert.equal(countOf(PULL), 1);
});

test('fingerprint: a no-op push by a clone carrying a STALE tip forgets it rather than re-confirming it', async () => {
    const { command, countOf } = makeRacingRemote({ initialTip: SHA_B, pushedTo: SHA_B });
    setLastSyncedTip('m1', SHA_A, PROBE_URL);
    await doltPushAfter('m1', { command, pushBeads: true });
    assert.equal(getLastSyncedTip('m1'), undefined);
    await doltPullBefore('m1', { command });
    assert.equal(countOf(PULL), 1, 'the stale tip must not survive into a skip');
});

test('fingerprint: a no-op push by a clone that WAS current forgets its tip too (conservative by construction)', async () => {
    // The one case the round-2 design kept a fingerprint for. This layer can
    // no longer distinguish it from the stale case without a network read --
    // and the network read is the race -- so it pays one redundant pull.
    const { command, countOf } = makeRacingRemote({ initialTip: SHA_A, pushedTo: SHA_A });
    setLastSyncedTip('m1', SHA_A, PROBE_URL);
    await doltPushAfter('m1', { command, pushBeads: true });
    assert.equal(getLastSyncedTip('m1'), undefined);
    await doltPullBefore('m1', { command });
    assert.equal(countOf(PULL), 1, 'one real pull, then the skip is re-armed');
    await doltPullBefore('m1', { command });
    assert.equal(countOf(PULL), 1);
});

test('fingerprint: the reconcile path (rejected push -> one pull -> re-push) forgets the tip and never probes', async () => {
    const { command, countOf } = makeCommandMock({
        [PROBE]: [REMOTE_JSON],
        [LS_REMOTE]: [lsRemote(SHA_B)],
        [PUSH]: [fail('Updates were rejected because the remote contains work'), OK],
        [PULL]: [OK],
    });
    setLastSyncedTip('m1', SHA_A, PROBE_URL);
    const res = await doltPushAfter('m1', { command, pushBeads: true, sleep: async () => {} });
    assert.deepEqual(res, { ok: true, member: 'm1', pushed: true, reconciled: true });
    assert.equal(countOf(LS_REMOTE), 0, 'neither the first push nor the re-push may probe the remote');
    assert.equal(countOf(PUSH), 2);
    assert.equal(countOf(PULL), 1, 'exactly the one bounded reconcile pull');
    assert.equal(getLastSyncedTip('m1'), undefined, 'the reconcile pull is NOT the fingerprinting pull -- the re-push then moves the remote past it');
});

test('fingerprint: a FAILED (non-diverged) push leaves the recorded tip alone -- nothing moved, nothing to forget', async () => {
    // Transient-exhausted, no divergence: the remote did not move and this
    // clone did not change, so the pre-existing fingerprint is exactly as
    // trustworthy as before. (A DIVERGED failure is different -- next test --
    // because the reconcile machinery moves the clone.)
    const { command, countOf } = makeCommandMock({
        [PROBE]: [REMOTE_JSON],
        [PUSH]: [fail('connection refused')],
    });
    setLastSyncedTip('m1', SHA_A, PROBE_URL);
    await assert.rejects(() => doltPushAfter('m1', { command, pushBeads: true, sleep: async () => {} }));
    assert.equal(countOf(LS_REMOTE), 0);
    assert.equal(getLastSyncedTip('m1'), SHA_A);
});

test('fingerprint: the push side issues no ls-remote whether or not remoteTipFingerprint is passed', async () => {
    for (const opts of [{}, { remoteTipFingerprint: false }, { remoteTipFingerprint: true }]) {
        const { command, countOf } = makeCommandMock({
            [PROBE]: [REMOTE_JSON],
            [LS_REMOTE]: [lsRemote(SHA_A)],
            [PUSH]: [OK],
        });
        await doltPushAfter('m1', { command, pushBeads: true, ...opts });
        assert.equal(countOf(LS_REMOTE), 0, `no probe at all for opts ${JSON.stringify(opts)}`);
        assert.equal(countOf(PUSH), 1);
    }
});

test('fingerprint: a diverged push forgets the tip', async () => {
    const { command } = makeCommandMock({
        [PROBE]: [REMOTE_JSON],
        [LS_REMOTE]: [lsRemote(SHA_B)],
        [PUSH]: [fail('Updates were rejected because the remote contains work')],
        [PULL]: [OK],
    });
    setLastSyncedTip('m1', SHA_A, PROBE_URL);
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
