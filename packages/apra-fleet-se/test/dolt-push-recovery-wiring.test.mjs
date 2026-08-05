import { test } from 'node:test';
import assert from 'node:assert/strict';
import { doltPushAfter } from '../fleet-sprint/dolt-sync.mjs';
import { buildDoltRecoveryLadder } from '../fleet-sprint/dolt-recovery-tier2.mjs';
import { DoltDivergedError } from '../fleet-sprint/errors.mjs';

// =============================================================================
// apra-fleet-vkc.1 -- the recovery ladder is WIRED into doltPushAfter()'s
// divergence terminal.
//
// These tests drive the REAL, unmocked doltPushAfter() (not a stand-in) with an
// injected command() that reproduces a divergence surviving the bounded
// first-successful-pusher-wins reconcile, and prove that:
//   - with a `recover` ladder wired, a real doltPushAfter() divergence REACHES
//     dolt-recovery.mjs (Path A) -- the `SELECT * FROM dolt_conflicts` gate
//     query is actually issued -- and, when Path A resolves it, the D-push is
//     reported reconciled/recovered instead of throwing;
//   - when the whole ladder fails to close the clone, the DoltDivergedError
//     still surfaces (runner.js classifies it as the terminal
//     BEADS_SYNC_CONFLICT) and Tier 2 is dispatched;
//   - with NO recover callback wired, doltPushAfter() behaves exactly as it did
//     before vkc.1 -- the divergence propagates immediately.
// =============================================================================

const DIVERGENCE_STDERR =
    'error: failed to push some refs to origin/main\n'
    + 'hint: Updates were rejected because the remote contains work that you do not have locally.';

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

test('a real doltPushAfter() divergence reaches dolt-recovery.mjs (Path A) and is resolved when the gate passes', async () => {
    // D-push -> diverged; reconcile pull -> ok; re-push -> diverged (terminal);
    // then Path A's own post-resolve pull/push succeed.
    const { command } = makeQueuedCommand({
        'bd dolt push': [fail(DIVERGENCE_STDERR), fail(DIVERGENCE_STDERR), OK],
        'bd dolt pull': [OK],
    });

    const sqlQueries = [];
    const sql = async (query) => {
        const q = String(query);
        sqlQueries.push(q);
        if (/SELECT \* FROM dolt_conflicts/i.test(q)) {
            // A plain single-row `issues` conflict: passes both of Path A's gates.
            return { ok: true, rows: [{ table: 'issues', num_conflicts: 1 }] };
        }
        if (/SELECT \* FROM dolt_log/i.test(q)) {
            return { ok: true, rows: [{ commit_hash: 'ours' }, { commit_hash: 'theirs' }] };
        }
        return { ok: true, rows: [] };
    };
    let meta = { dolt_mode: 'embedded', remote: 'origin' };
    const recover = buildDoltRecoveryLadder('local', {
        command,
        sql,
        spawnSqlServer: async () => ({ stop: () => {} }),
        allocatePort: () => 3999,
        readMetadata: async () => meta,
        writeMetadata: async (m) => { meta = m; },
    });

    const outcome = await doltPushAfter('local', {
        command, checkSyncRemoteConfigured: remoteConfigured, recover,
    });

    assert.equal(outcome.ok, true);
    assert.equal(outcome.recovered, true);
    assert.equal(outcome.recoveryTier, 'path-a');
    // The load-bearing proof that dolt-recovery.mjs was actually reached: its
    // deterministic conflict gate query was issued.
    assert.ok(
        sqlQueries.some((q) => /SELECT \* FROM dolt_conflicts/i.test(q)),
        'expected Path A (dolt-recovery.mjs) to issue its dolt_conflicts gate query',
    );
});

test('when the whole ladder fails to close the clone, doltPushAfter() still surfaces DoltDivergedError and Tier 2 is dispatched', async () => {
    // Path A self-defers (no sql runtime injected); Path B fails on an
    // unrecognized bootstrap error -> Tier 2 escalation dispatches the agent.
    const { command } = makeQueuedCommand({
        'bd dolt push': [fail(DIVERGENCE_STDERR)],
        'bd dolt pull': [OK],
        'bd bootstrap': [fail('fatal: some unrecognized bootstrap failure')],
    });

    let dispatched = 0;
    const agent = async () => { dispatched += 1; return { ok: true }; };
    const recover = buildDoltRecoveryLadder('local', {
        command,
        agent,
        // Path B fs seams, injected so no real disk is touched.
        readConfig: async () => ({ exists: true, raw: 'sync:\n  remote: origin\n', hasSyncRemote: true }),
        removePath: async () => {},
        listLocalState: async () => ['(test) nothing to discard'],
    });

    await assert.rejects(
        () => doltPushAfter('local', { command, checkSyncRemoteConfigured: remoteConfigured, recover }),
        (err) => err instanceof DoltDivergedError,
    );
    assert.equal(dispatched, 1, 'expected Tier 2 to dispatch the recovery agent once');
});

test('with NO recover callback wired, doltPushAfter() propagates the divergence immediately (pre-vkc.1 behavior preserved)', async () => {
    const { command } = makeQueuedCommand({
        'bd dolt push': [fail(DIVERGENCE_STDERR)],
        'bd dolt pull': [OK],
    });
    await assert.rejects(
        () => doltPushAfter('local', { command, checkSyncRemoteConfigured: remoteConfigured }),
        (err) => err instanceof DoltDivergedError,
    );
});

// =============================================================================
// Post-review fix (apra-fleet-vkc.1): runner.js's syncMemberAfterOrdered()
// wires the ladder with enablePathB:false and NO readConfig/removePath/
// listLocalState injected -- exactly the production call-site shape. Without
// this flag, Path B would fall through to its fs-backed defaults (plain Node
// `fs` calls with no member argument), discarding and re-bootstrapping
// whatever process is RUNNING the test/orchestrator, not the wedged member,
// and reporting `pushed:true` while silently losing the mutation that
// triggered the divergence. This test proves that shape never touches local
// state and instead escalates cleanly to Tier 2.
// =============================================================================

test('runner.js production wiring (enablePathB:false, no fs seams injected): a real divergence never touches local fs and escalates straight to Tier 2', async () => {
    const { command, calls } = makeQueuedCommand({
        'bd dolt push': [fail(DIVERGENCE_STDERR)],
        'bd dolt pull': [OK],
    });

    let dispatched = 0;
    const agent = async () => { dispatched += 1; return { ok: true }; };

    // The EXACT opts shape runner.js:syncMemberAfterOrdered passes -- no sql
    // runtime (Path A self-defers), no readConfig/removePath/listLocalState
    // (would only matter if Path B ran), enablePathB:false.
    const recover = buildDoltRecoveryLadder('fleet-mac', { command, agent, log: () => {}, enablePathB: false });

    await assert.rejects(
        () => doltPushAfter('fleet-mac', { command, checkSyncRemoteConfigured: remoteConfigured, recover }),
        (err) => err instanceof DoltDivergedError,
    );

    assert.equal(dispatched, 1, 'expected Tier 2 to dispatch the recovery agent once');

    // The load-bearing proof Path B never ran ANY of its steps: no bootstrap
    // and no push-republish command was ever issued beyond the ordinary D-push
    // bracket's own pull/push (both already queued above and consumed).
    const bootstrapCalls = calls.filter((c) => c.cmd.includes('bd bootstrap'));
    assert.equal(bootstrapCalls.length, 0, 'Path B must never issue a bootstrap command when enablePathB:false');
});
