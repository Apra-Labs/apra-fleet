import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    doltPushAfter,
    doltRaceJitterDelayMs,
    DOLT_PUSH_RACE_MAX_RECONCILES,
    DOLT_PUSH_RACE_BACKOFF_BASE_MS,
    invalidateSyncRemoteCache,
    clearLastSyncedTip,
    clearTipProbeFailures,
    clearDegradedSyncRecords,
    getDegradedSyncRecords,
    DoltSync,
} from '../fleet-sprint/dolt-sync.mjs';
import { DoltDivergedError, DoltSyncError, DoltPushRaceError } from '../fleet-sprint/errors.mjs';

// =============================================================================
// D-push race heal (dolt-sync.mjs doltPushAfter / runDoltStep).
//
// Two writers on one shared beads remote: the loser's push is rejected
// non-fast-forward. That is a routine race the bracket heals by a reconcile
// pull plus a re-push, so it must read as ONE info line -- not as
// "FAILED ... may be stale". A remote that keeps rejecting is retried a bounded
// number of times with jittered waits drawn from the injected sleep, then
// surfaces as the typed DoltPushRaceError. A credential failure is never
// treated as a race.
//
// Hermetic: command() is an injected script reproducing dolt's real
// non-fast-forward rejection text; no bd/dolt process, no network, no home-dir
// access. ASCII only.
// =============================================================================

// Dolt's real non-fast-forward rejection on `bd dolt push`.
const NON_FAST_FORWARD_STDERR =
    'error: failed to push some refs to origin/main\n'
    + 'hint: Updates were rejected because the tip of your current branch is behind\n'
    + "hint: its remote counterpart. Use 'dolt pull' to merge the remote changes.";

// A real credential failure on push (classifies 'auth').
const CREDENTIAL_STDERR =
    "Error: push to origin/main: Error 1105: unknown push error; addTableFiles, "
    + "updateManifestAddFiles: fatal: could not read Username for "
    + "'https://github.com': Device not configured";

const OK = { ok: true, output: '', error: null };
const reject = () => ({ ok: false, output: '', error: NON_FAST_FORWARD_STDERR });

beforeEach(() => {
    invalidateSyncRemoteCache();
    clearLastSyncedTip();
    clearTipProbeFailures();
    clearDegradedSyncRecords();
});

/** Scripted command(): `pushes` answers each `bd dolt push` in turn (the last
 *  entry repeats); pulls succeed; anything else answers ok. */
function scriptedRemote({ pushes, pull = () => OK }) {
    const calls = [];
    let pushIndex = 0;
    const command = async (cmd, opts = {}) => {
        calls.push({ cmd, opts });
        if (cmd.includes('bd dolt push')) {
            const answer = pushes[Math.min(pushIndex, pushes.length - 1)];
            pushIndex += 1;
            return answer();
        }
        if (cmd.includes('bd dolt pull')) return pull();
        return OK;
    };
    const count = (needle) => calls.filter((c) => c.cmd.includes(needle)).length;
    return { command, calls, count };
}

const STALE_RE = /FAILED|may be stale/;
const RACE_INFO_RE = /lost a race with another writer; reconciling/;

test('a push rejected non-fast-forward then healed by one reconcile logs exactly one info line and no FAILED/may-be-stale line', async () => {
    const remote = scriptedRemote({ pushes: [reject, () => OK] });
    const logs = [];
    const sleeps = [];
    const res = await doltPushAfter('writer-b', {
        command: remote.command,
        log: (m) => logs.push(m),
        checkSyncRemoteConfigured: async () => true,
        sleep: async (ms) => { sleeps.push(ms); },
    });
    assert.deepEqual(res, { ok: true, member: 'writer-b', pushed: true, reconciled: true });
    assert.equal(remote.count('bd dolt push'), 2, 'first push, then one re-push');
    assert.equal(remote.count('bd dolt pull'), 1, 'one reconcile pull');
    assert.equal(logs.filter((l) => RACE_INFO_RE.test(l)).length, 1, `expected exactly one race info line:\n${logs.join('\n')}`);
    assert.deepEqual(logs.filter((l) => STALE_RE.test(l)), [], 'no FAILED / may-be-stale line for a healed race');
    assert.equal(sleeps.length, 1, 'one jittered wait before the one reconcile cycle');
});

test('a remote that keeps rejecting is retried a bounded number of times with jittered waits, then throws the typed race error', async () => {
    const remote = scriptedRemote({ pushes: [reject] });
    const logs = [];
    const sleeps = [];
    // Distinct random draws make the jitter observable: each delay is
    // base * 2^(cycle-1) scaled into [half, full] by the draw.
    const draws = [0, 0.5, 1];
    let drawIndex = 0;
    await assert.rejects(
        () => doltPushAfter('writer-b', {
            command: remote.command,
            log: (m) => logs.push(m),
            checkSyncRemoteConfigured: async () => true,
            sleep: async (ms) => { sleeps.push(ms); },
            random: () => draws[drawIndex++ % draws.length],
        }),
        (err) => {
            assert.ok(err instanceof DoltPushRaceError, `expected DoltPushRaceError, got ${err && err.name}: ${err && err.message}`);
            assert.ok(err instanceof DoltDivergedError, 'still a divergence for the terminal-reason plumbing');
            assert.equal(err.kind, 'remote-race');
            assert.equal(err.details.kind, 'remote-race');
            assert.equal(err.details.attempts, DOLT_PUSH_RACE_MAX_RECONCILES);
            assert.equal(err.member, 'writer-b');
            assert.match(err.message, /race with other writers/);
            assert.doesNotMatch(err.message, /may be stale/);
            return true;
        },
    );
    assert.equal(DOLT_PUSH_RACE_MAX_RECONCILES, 3);
    assert.equal(remote.count('bd dolt push'), 1 + DOLT_PUSH_RACE_MAX_RECONCILES, 'first push plus one re-push per cycle, never more');
    assert.equal(remote.count('bd dolt pull'), DOLT_PUSH_RACE_MAX_RECONCILES, 'one reconcile pull per cycle');
    assert.equal(sleeps.length, DOLT_PUSH_RACE_MAX_RECONCILES, `one wait per cycle, got ${JSON.stringify(sleeps)}`);
    const base = DOLT_PUSH_RACE_BACKOFF_BASE_MS;
    assert.deepEqual(sleeps, [base / 2, Math.round(base * 1.5), base * 4], 'jitter scales each cycle backoff into [half, full]');
    assert.equal(new Set(sleeps).size, sleeps.length, 'the waits are not identical');
    assert.deepEqual(logs.filter((l) => /may be stale/.test(l)), [], 'the race never reads as stale data');
});

test('jittered waits stay inside [half, full] of the cycle backoff for any draw', () => {
    for (let cycle = 1; cycle <= DOLT_PUSH_RACE_MAX_RECONCILES; cycle += 1) {
        const full = DOLT_PUSH_RACE_BACKOFF_BASE_MS * 2 ** (cycle - 1);
        for (const r of [0, 0.123, 0.5, 0.999, 1]) {
            const d = doltRaceJitterDelayMs(cycle, DOLT_PUSH_RACE_BACKOFF_BASE_MS, () => r);
            assert.ok(d >= full / 2 && d <= full, `cycle ${cycle} draw ${r}: ${d} outside [${full / 2}, ${full}]`);
        }
    }
});

test('the race error degrades through DoltSync.syncAfter with its own kind kept on the record', async () => {
    const remote = scriptedRemote({ pushes: [reject] });
    const outcome = await DoltSync.syncAfter('writer-b', {
        command: remote.command,
        checkSyncRemoteConfigured: async () => true,
        sleep: async () => {},
    });
    assert.equal(outcome.degraded, true);
    assert.ok(outcome.error instanceof DoltPushRaceError);
    const [record] = getDegradedSyncRecords({ member: 'writer-b', pendingOnly: true });
    assert.equal(record.errorKind, 'remote-race');
    assert.equal(DoltSync.flush().published, false);
});

test('an auth failure on push stays kind auth, invokes the self-heal hook once, and never enters the race loop', async () => {
    const remote = scriptedRemote({ pushes: [() => ({ ok: false, output: '', error: CREDENTIAL_STDERR })] });
    const logs = [];
    const sleeps = [];
    const heals = [];
    const onAuthFailure = async (info) => { heals.push(info); };
    await assert.rejects(
        () => doltPushAfter('writer-b', {
            command: remote.command,
            log: (m) => logs.push(m),
            checkSyncRemoteConfigured: async () => true,
            sleep: async (ms) => { sleeps.push(ms); },
            onAuthFailure,
        }),
        (err) => {
            assert.ok(err instanceof DoltSyncError, 'the auth terminal is a DoltSyncError');
            assert.equal(err instanceof DoltDivergedError, false, 'never folded into a divergence');
            assert.equal(err instanceof DoltPushRaceError, false, 'never a race');
            assert.equal(err.details.kind, 'auth');
            return true;
        },
    );
    assert.equal(heals.length, 1, 'the existing one-shot self-heal ran exactly once');
    assert.equal(heals[0].failureKind, 'auth');
    assert.equal(remote.count('bd dolt push'), 2, 'the failed push plus the single post-heal retry');
    assert.equal(remote.count('bd dolt pull'), 0, 'no reconcile pull: the race loop was not entered');
    assert.deepEqual(sleeps, [], 'no race wait was taken');
    assert.deepEqual(logs.filter((l) => RACE_INFO_RE.test(l)), [], 'no race info line');
});

test('a reconcile pull that cannot merge is still a real conflict (DoltDivergedError, not the race error)', async () => {
    const remote = scriptedRemote({
        pushes: [reject],
        pull: () => ({ ok: false, output: '', error: 'merge conflict detected' }),
    });
    await assert.rejects(
        () => doltPushAfter('writer-b', { command: remote.command, checkSyncRemoteConfigured: async () => true, sleep: async () => {} }),
        (err) => {
            assert.ok(err instanceof DoltDivergedError);
            assert.equal(err instanceof DoltPushRaceError, false);
            assert.equal(err.operation, 'push-reconcile');
            return true;
        },
    );
    assert.equal(remote.count('bd dolt pull'), 1, 'a real conflict is not retried');
});
