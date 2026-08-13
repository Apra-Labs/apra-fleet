import { test } from 'node:test';
import assert from 'node:assert/strict';
import { doltPushAfter, doltPullBefore, preflightBeadsHealthGate, repair } from '../fleet-sprint/dolt-sync.mjs';
import { buildSettleCallback } from '../fleet-sprint/dolt-settle.mjs';
import { DoltDivergedError } from '../fleet-sprint/errors.mjs';

// =============================================================================
// settleDoltConflicts() is WIRED at BOTH divergence terminals (docs/dolt-sync-
// redesign.md Parts 2.3/2.4), replacing the retired Path A -> Path B -> Tier 2
// ladder.
//
// These tests drive the REAL, unmocked doltPushAfter()/doltPullBefore() (not a
// stand-in) with an injected command() that reproduces a divergence, and prove:
//   - a push divergence that outlives the bounded reconcile RUNS settle, and a
//     settle that resolves reports the D-push reconciled/recovered instead of
//     throwing;
//   - a PULL divergence -- which had no recovery seam at all before this --
//     runs settle too, and the readiness gate inherits it;
//   - a settle that fails OPERATIONALLY surfaces the original
//     DoltDivergedError (runner.js classifies it as BEADS_SYNC_CONFLICT); it is
//     never re-labelled, never escalated to an LLM, and never retried;
//   - with NO settle callback wired, both brackets behave exactly as before.
// =============================================================================

const DIVERGENCE_STDERR =
    'error: failed to push some refs to origin/main\n'
    + 'hint: Updates were rejected because the remote contains work that you do not have locally.';

const PULL_CONFLICT_STDERR =
    'error: local changes would be stomped by merge\n'
    + 'CONFLICT (content): Merge conflict in table issues\n'
    + 'Automatic merge failed; fix conflicts and then commit the result.';

const OK = { ok: true, output: '', error: null };
const fail = (error) => ({ ok: false, output: '', error });
const remoteConfigured = async () => true;

// A command() mock whose per-command responses are drained from a queue: the
// last element is sticky once reached (so later same-command calls keep it).
function makeQueuedCommand(script) {
    const calls = [];
    const queues = new Map(Object.entries(script).map(([k, v]) => [k, [...v]]));
    const command = async (cmd, opts = {}) => {
        calls.push({ cmd, opts });
        for (const [key, queue] of queues) {
            if (cmd.includes(key)) {
                const next = queue.length > 1 ? queue.shift() : queue[0];
                return next;
            }
        }
        return OK;
    };
    return { command, calls };
}

// A settle stand-in with the exact shape buildSettleCallback() returns.
function fakeSettle({ ok = true, resolvedTables = ['issues'], throws = null } = {}) {
    const invocations = [];
    const settle = async (ctx) => {
        invocations.push(ctx);
        if (throws) throw throws;
        return { ok, resolvedTables, warnings: [], doltVersionUsed: '2.2.0' };
    };
    return { settle, invocations };
}

// --- push terminal ---------------------------------------------------------

test('a real doltPushAfter() divergence runs settle, and a resolved settle reports the D-push recovered', async () => {
    const { command } = makeQueuedCommand({
        'bd dolt push': [fail(DIVERGENCE_STDERR)],
        'bd dolt pull': [OK],
    });
    const { settle, invocations } = fakeSettle({ resolvedTables: ['issues', 'labels'] });

    const outcome = await doltPushAfter('local', { command, checkSyncRemoteConfigured: remoteConfigured, settle });

    assert.equal(outcome.ok, true);
    assert.equal(outcome.recovered, true);
    assert.equal(outcome.reconciled, true);
    assert.deepEqual(outcome.settledTables, ['issues', 'labels']);
    assert.equal(invocations.length, 1, 'settle must be invoked exactly once -- no retry loop, no tiers');
    assert.match(invocations[0].operation, /push/i);
    assert.ok(invocations[0].error instanceof DoltDivergedError, 'settle receives the typed divergence it is being asked to settle');
});

test('a settle that fails operationally still surfaces DoltDivergedError -- never re-labelled, never escalated', async () => {
    const { command } = makeQueuedCommand({
        'bd dolt push': [fail(DIVERGENCE_STDERR)],
        'bd dolt pull': [OK],
    });
    const { settle, invocations } = fakeSettle({ throws: new Error('ephemeral sql-server would not start') });
    const logs = [];

    await assert.rejects(
        () => doltPushAfter('local', { command, checkSyncRemoteConfigured: remoteConfigured, settle, log: (m) => logs.push(m) }),
        (err) => err instanceof DoltDivergedError,
    );
    assert.equal(invocations.length, 1, 'a failing settle is attempted once, never retried');
    assert.ok(logs.some((l) => /infra failure, NOT an unresolvable conflict/.test(l)), 'the log must distinguish an operational failure from an unresolvable conflict');
});

test('with NO settle callback wired, doltPushAfter() propagates the divergence immediately (pre-settle behavior preserved)', async () => {
    const { command } = makeQueuedCommand({
        'bd dolt push': [fail(DIVERGENCE_STDERR)],
        'bd dolt pull': [OK],
    });
    await assert.rejects(
        () => doltPushAfter('local', { command, checkSyncRemoteConfigured: remoteConfigured }),
        (err) => err instanceof DoltDivergedError,
    );
});

// --- pull terminal (previously recovery-free) ------------------------------

test('a doltPullBefore() divergence -- which had NO recovery seam before -- runs settle and self-heals', async () => {
    const { command } = makeQueuedCommand({ 'bd dolt pull': [fail(PULL_CONFLICT_STDERR)] });
    const { settle, invocations } = fakeSettle();

    const outcome = await doltPullBefore('local', { command, checkSyncRemoteConfigured: remoteConfigured, settle });

    assert.equal(outcome.ok, true);
    assert.equal(outcome.recovered, true);
    assert.deepEqual(outcome.settledTables, ['issues']);
    assert.equal(invocations.length, 1);
    assert.match(invocations[0].operation, /pull/i);
});

test('the readiness gate inherits the same pull-side settle (a wedged clone no longer hard-aborts the sprint)', async () => {
    const { command } = makeQueuedCommand({ 'bd dolt pull': [fail(PULL_CONFLICT_STDERR)] });
    const { settle } = fakeSettle();
    const outcome = await preflightBeadsHealthGate('local', { command, checkSyncRemoteConfigured: remoteConfigured, settle });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.recovered, true);
});

test('a pull divergence with no settle wired, or with a settle that fails, still aborts with DoltDivergedError', async () => {
    const noSettle = makeQueuedCommand({ 'bd dolt pull': [fail(PULL_CONFLICT_STDERR)] });
    await assert.rejects(
        () => doltPullBefore('local', { command: noSettle.command, checkSyncRemoteConfigured: remoteConfigured }),
        (err) => err instanceof DoltDivergedError,
    );

    const failing = makeQueuedCommand({ 'bd dolt pull': [fail(PULL_CONFLICT_STDERR)] });
    const { settle } = fakeSettle({ throws: new Error('no usable dolt binary') });
    await assert.rejects(
        () => doltPullBefore('local', { command: failing.command, checkSyncRemoteConfigured: remoteConfigured, settle }),
        (err) => err instanceof DoltDivergedError,
    );
});

// --- repair(): the operator entry point onto the same function -------------

test('repair() runs settle, not a ladder, and reports the settled tables', async () => {
    const { command } = makeQueuedCommand({});
    const { settle } = fakeSettle({ resolvedTables: ['issues'] });
    const result = await repair('local', { command, settle });
    assert.equal(result.repaired, true);
    assert.deepEqual(result.result.resolvedTables, ['issues']);
    assert.equal(result.tier, undefined, 'there are no tiers any more');
});

test('repair() reports an operational settle failure without throwing, and refuses without a command()', async () => {
    const { command } = makeQueuedCommand({});
    const { settle } = fakeSettle({ throws: new Error('server would not start') });
    const failed = await repair('local', { command, settle });
    assert.equal(failed.repaired, false);
    assert.equal(failed.escalation, 'settle-operational-failure');

    const unconfigured = await repair('local', {});
    assert.equal(unconfigured.repaired, false);
    assert.match(unconfigured.escalation, /requires an injected command/);
});

// =============================================================================
// The EXACT production wiring shape runner.js uses: buildSettleCallback(member,
// { command, log }) with no platform supplied, threaded into the D-push
// bracket. Proves the member's platform is PROBED (never assumed to be the
// orchestrator's) and that the real settle path is entered.
// =============================================================================

test('runner.js production wiring: buildSettleCallback probes the MEMBER platform and drives the real settle', async () => {
    const seen = [];
    let insideSettle = false;
    let serverUp = false;
    const command = async (cmd) => {
        seen.push(cmd);
        // Every D-push bracket attempt is rejected (a divergence outliving the
        // bounded reconcile); settle's OWN republish push succeeds.
        if (cmd.includes('bd dolt push')) return insideSettle ? OK : fail(DIVERGENCE_STDERR);
        if (cmd.includes('process.platform')) return { ok: true, output: 'linux x64\n', error: null };
        if (cmd === 'bd dolt status') { insideSettle = true; return { ok: true, output: 'Dolt engine: embedded (in-process, no server)\n  Data: /home/u/.beads/embeddeddolt\n', error: null }; }
        if (/version"?$/.test(cmd.trim())) return { ok: true, output: 'dolt version 2.2.0\n', error: null };
        if (/TcpTestSucceeded|dev\/tcp/.test(cmd)) return { ok: true, output: serverUp ? 'True' : 'False', error: null };
        if (/nohup .* sql-server/.test(cmd)) { serverUp = true; return { ok: true, output: 'PID:1234', error: null }; }
        if (/^kill 1234/.test(cmd)) { serverUp = false; return OK; }
        if (/--no-tls --host=/.test(cmd)) {
            if (/SELECT `table` FROM dolt_conflicts/.test(cmd)) return { ok: true, output: JSON.stringify([]), error: null };
            if (/SELECT COUNT/.test(cmd)) return { ok: true, output: JSON.stringify([{ n: 0 }]), error: null };
            return OK;
        }
        return OK;
    };

    const settle = buildSettleCallback('fleet-lin-dev1', { command, log: () => {} });
    const outcome = await doltPushAfter('fleet-lin-dev1', { command, checkSyncRemoteConfigured: remoteConfigured, settle });

    assert.equal(outcome.recovered, true, 'the real settle callback must resolve this divergence');
    assert.ok(seen.some((c) => c.includes('process.platform')), 'the member platform must be probed, never assumed from the orchestrator');
    assert.ok(seen.some((c) => /nohup .* sql-server/.test(c)), 'the POSIX detached spawn must be used for a linux member, proving the probed platform is what drives settle');
    assert.ok(!seen.some((c) => /--user|--password/.test(c)), 'settle must never pass --user/--password (the ga61 credential-prompt landmine)');
});
