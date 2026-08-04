import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    DoltSync,
    classifyDoltFailure,
    classifySyncError,
    doltBackoffDelayMs,
    getDegradedSyncRecords,
    clearDegradedSyncRecords,
} from '../fleet-sprint/dolt-sync.mjs';
import { DoltDivergedError, DoltSyncError } from '../fleet-sprint/errors.mjs';

// =============================================================================
// apra-fleet-417.3.1 -- fault-tolerant dolt sync: classification, bounded retry
// with backoff, and the DEGRADED-BUT-NON-FATAL path.
//
// Product decision being pinned here (apra-fleet-417.3, not to be relitigated):
// concurrent multi-agent dolt push/pull is a NORMAL condition, so a beads-sync
// hiccup must never hard-abort an otherwise healthy sprint. DoltSync's
// purpose-based entry points therefore answer with a STRUCTURED OUTCOME and
// degrade by default; a hard abort is an explicit `fatal: true` opt-in.
//
// The single most load-bearing case is apra-fleet-spp: on 2026-08-02 a live
// fleet-mac sprint FAILED outright because a git-credential failure inside
// Dolt's embedded push client was reported as data divergence, sent down a
// reconcile ladder that could not possibly fix it, and then surfaced as
// DoltDivergedError. Nothing had diverged. The exact stderr from that run is
// asserted verbatim below.
// =============================================================================

// The verbatim stderr from the live 2026-08-02 fleet-mac D-push failure
// (sprint apra-fleet-cvb, run apra-fleet-cvb-e04f499d-6f61-4679-bbc0-78ff4580b465).
const LIVE_2026_08_02_CREDENTIAL_STDERR =
    "Error: push to origin/main: Error 1105: unknown push error; addTableFiles, "
    + "updateManifestAddFiles: fatal: could not read Username for "
    + "'https://github.com': Device not configured";

// Real Dolt non-fast-forward rejection wording, for the contrast case.
const REAL_DIVERGENCE_STDERR =
    'error: failed to push some refs to origin/main\n'
    + 'hint: Updates were rejected because the remote contains work that you do not have locally.';

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
        return { ok: true, output: '', error: null };
    };
    return { command, calls };
}

const OK = { ok: true, output: '', error: null };
const fail = (error) => ({ ok: false, output: '', error });
// The bd-level sync.remote pre-gate: positively CONFIGURED, so no bracket can
// short-circuit to its benign no-remote skip.
const remoteConfigured = async () => true;

// -----------------------------------------------------------------------------
// AC3: credential failures classify as AUTH, never DIVERGED.
// -----------------------------------------------------------------------------

test('apra-fleet-spp: the live 2026-08-02 credential stderr classifies as auth, never diverged', () => {
    assert.equal(classifyDoltFailure(LIVE_2026_08_02_CREDENTIAL_STDERR), 'auth');
    assert.notEqual(classifyDoltFailure(LIVE_2026_08_02_CREDENTIAL_STDERR), 'diverged');
});

test('a credential failure that ALSO carries divergence/lock wording still classifies as auth', () => {
    // This is why the auth patterns are checked BEFORE the (deliberately loose)
    // divergence and transient patterns. Ordering, not luck, is what makes
    // apra-fleet-spp unrepeatable.
    const mixed = `${REAL_DIVERGENCE_STDERR}\nfatal: could not read Username for 'https://github.com'`;
    assert.equal(classifyDoltFailure(mixed), 'auth');

    const withLockWord = 'Authentication failed; database is locked';
    assert.equal(classifyDoltFailure(withLockWord), 'auth');
});

test('a genuine non-fast-forward rejection still classifies as diverged', () => {
    assert.equal(classifyDoltFailure(REAL_DIVERGENCE_STDERR), 'diverged');
});

test('classifySyncError maps a DoltDivergedError to diverged and a credential DoltSyncError to auth', () => {
    const diverged = new DoltDivergedError('rejected', { member: 'm', doltOutput: REAL_DIVERGENCE_STDERR });
    assert.equal(classifySyncError(diverged), 'diverged');

    const auth = new DoltSyncError('creds', { member: 'm', doltOutput: LIVE_2026_08_02_CREDENTIAL_STDERR });
    assert.equal(classifySyncError(auth), 'auth');
});

test('a credential D-push failure surfaces as a credential-named DoltSyncError, not DoltDivergedError', async () => {
    clearDegradedSyncRecords();
    const { command } = makeCommandMock({
        'bd dolt push': [fail(LIVE_2026_08_02_CREDENTIAL_STDERR)],
        'bd dolt pull': [OK],
    });
    const outcome = await DoltSync.syncAfter('fleet-mac', {
        command, checkSyncRemoteConfigured: remoteConfigured, sleep: async () => {},
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.kind, 'auth');
    assert.equal(outcome.degraded, true);
    assert.ok(outcome.error instanceof DoltSyncError, 'credential failure must not be a DoltDivergedError');
    assert.equal(outcome.error instanceof DoltDivergedError, false);
    assert.match(outcome.detail, /CREDENTIALS/);
    clearDegradedSyncRecords();
});

// -----------------------------------------------------------------------------
// AC1/AC2: structured outcome, and an unresolvable conflict degrades instead of
// aborting.
// -----------------------------------------------------------------------------

test('a successful D-push returns a structured, non-degraded outcome', async () => {
    clearDegradedSyncRecords();
    const { command } = makeCommandMock({ 'bd dolt push': [OK] });
    const outcome = await DoltSync.syncAfter('local', { command, checkSyncRemoteConfigured: remoteConfigured });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.kind, 'synced');
    assert.equal(outcome.degraded, false);
    assert.equal(outcome.member, 'local');
    assert.equal(outcome.operation, 'push');
    // Legacy fields the pre-417.3.1 consumers read are still present.
    assert.equal(outcome.pushed, true);
    assert.equal(outcome.reconciled, false);
    clearDegradedSyncRecords();
});

test('an unresolvable conflict yields degraded:true instead of throwing, and is recorded', async () => {
    clearDegradedSyncRecords();
    const logs = [];
    const degradedSeen = [];
    // Push always rejected; the single reconcile pull succeeds -- the exact
    // shape that used to end the sprint with DoltDivergedError.
    const { command } = makeCommandMock({
        'bd dolt push': [fail(REAL_DIVERGENCE_STDERR)],
        'bd dolt pull': [OK],
    });
    const outcome = await DoltSync.syncAfter('local', {
        command,
        log: (m) => logs.push(m),
        checkSyncRemoteConfigured: remoteConfigured,
        onDegraded: (o) => { degradedSeen.push(o); },
    });

    assert.equal(outcome.ok, false);
    assert.equal(outcome.kind, 'diverged');
    assert.equal(outcome.degraded, true);
    assert.ok(outcome.error instanceof DoltDivergedError);
    assert.ok(typeof outcome.detail === 'string' && outcome.detail.length > 0);

    // Logged loudly, so a degraded sync is never silent.
    assert.ok(logs.some((m) => /DEGRADED \(non-fatal\)/.test(m)), 'degraded outcome must be logged loudly');
    // Reported to the follow-up hook and durable in the record list.
    assert.equal(degradedSeen.length, 1);
    const records = getDegradedSyncRecords({ member: 'local', pendingOnly: true });
    assert.equal(records.length, 1);
    assert.equal(records[0].kind, 'diverged');
    assert.equal(records[0].operation, 'push');
    clearDegradedSyncRecords();
});

test('the next successful D-push retires the queued degraded record for that member', async () => {
    clearDegradedSyncRecords();
    const failing = makeCommandMock({
        'bd dolt push': [fail(REAL_DIVERGENCE_STDERR)],
        'bd dolt pull': [OK],
    });
    await DoltSync.syncAfter('local', { command: failing.command, checkSyncRemoteConfigured: remoteConfigured });
    assert.equal(getDegradedSyncRecords({ member: 'local', pendingOnly: true }).length, 1);

    const healthy = makeCommandMock({ 'bd dolt push': [OK] });
    const outcome = await DoltSync.syncAfter('local', { command: healthy.command, checkSyncRemoteConfigured: remoteConfigured });
    assert.equal(outcome.ok, true);
    assert.equal(getDegradedSyncRecords({ member: 'local', pendingOnly: true }).length, 0);
    // The record itself is retained for visibility, just no longer pending.
    assert.equal(getDegradedSyncRecords({ member: 'local' }).length, 1);
    clearDegradedSyncRecords();
});

// -----------------------------------------------------------------------------
// AC4: the fatal path is still reachable, and still throws the same typed errors
// its existing consumers (terminal-reason resolution, conflict-dump capture)
// depend on.
// -----------------------------------------------------------------------------

test('fatal:true restores the DoltDivergedError hard-abort for the call sites that need it', async () => {
    clearDegradedSyncRecords();
    const { command } = makeCommandMock({
        'bd dolt push': [fail(REAL_DIVERGENCE_STDERR)],
        'bd dolt pull': [OK],
    });
    await assert.rejects(
        () => DoltSync.syncAfter('local', { command, checkSyncRemoteConfigured: remoteConfigured, fatal: true }),
        (err) => err instanceof DoltDivergedError && err.code === 'DOLT_DIVERGED',
    );
    // A fatal abort is NOT recorded as a degraded (continue-anyway) sync.
    assert.equal(getDegradedSyncRecords({ member: 'local' }).length, 0);
    clearDegradedSyncRecords();
});

test('readinessGate:true implies fatal -- the pre-flight gate still aborts the run', async () => {
    clearDegradedSyncRecords();
    const { command } = makeCommandMock({ 'bd dolt pull': [fail(REAL_DIVERGENCE_STDERR)] });
    await assert.rejects(
        () => DoltSync.syncBefore('local', { command, checkSyncRemoteConfigured: remoteConfigured, readinessGate: true }),
        (err) => err instanceof DoltDivergedError && /beads DB diverged/.test(err.message),
    );
    clearDegradedSyncRecords();
});

test('the retired healthGate spelling is rejected rather than silently ignored', async () => {
    clearDegradedSyncRecords();
    const { command } = makeCommandMock({ 'bd dolt pull': [fail(REAL_DIVERGENCE_STDERR)] });
    await assert.rejects(
        () => DoltSync.syncBefore('local', { command, checkSyncRemoteConfigured: remoteConfigured, healthGate: true }),
        /healthGate is retired.*readinessGate/,
    );
    clearDegradedSyncRecords();
});

test('the retired skipPull spelling is rejected rather than silently ignored', async () => {
    clearDegradedSyncRecords();
    const { command } = makeCommandMock({});
    await assert.rejects(
        () => DoltSync.syncBefore('local', { command, checkSyncRemoteConfigured: remoteConfigured, skipPull: true }),
        /skipPull is retired.*skipRefresh/,
    );
});

// -----------------------------------------------------------------------------
// Bounded retry with backoff for TRANSIENT.
// -----------------------------------------------------------------------------

test('doltBackoffDelayMs is exponential and capped', () => {
    assert.equal(doltBackoffDelayMs(1, 500, 8000), 500);
    assert.equal(doltBackoffDelayMs(2, 500, 8000), 1000);
    assert.equal(doltBackoffDelayMs(3, 500, 8000), 2000);
    assert.equal(doltBackoffDelayMs(99, 500, 8000), 8000, 'backoff must be bounded, never unbounded growth');
});

test('a transient pull timeout is retried with backoff, bounded, then degrades', async () => {
    clearDegradedSyncRecords();
    const slept = [];
    const { command, calls } = makeCommandMock({
        'bd dolt pull': [fail('fatal: unable to access remote: Connection timed out')],
    });
    const outcome = await DoltSync.syncBefore('local', {
        command,
        checkSyncRemoteConfigured: remoteConfigured,
        maxTransientRetries: 2,
        backoffBaseMs: 10,
        sleep: async (ms) => { slept.push(ms); },
    });

    const pulls = calls.filter((c) => c.cmd.includes('bd dolt pull'));
    assert.equal(pulls.length, 3, 'initial attempt plus exactly maxTransientRetries retries -- bounded');
    assert.deepEqual(slept, [10, 20], 'each retry waits an exponentially longer, bounded backoff');
    // Transient exhaustion is not fatal by default any more.
    assert.equal(outcome.ok, false);
    assert.equal(outcome.degraded, true);
    assert.equal(outcome.kind, 'transient');
    clearDegradedSyncRecords();
});

// -----------------------------------------------------------------------------
// AC5 / apra-fleet-eft.17.3: the no-remote scratch-dir path is handled, and is
// NOT skipped by gating accident.
// -----------------------------------------------------------------------------

test('a scratch dir with no dolt remote is a benign, non-degraded no-op on both brackets', async () => {
    clearDegradedSyncRecords();
    const noRemote = async () => false;
    const pull = makeCommandMock({});
    const before = await DoltSync.syncBefore('scratch', { command: pull.command, checkSyncRemoteConfigured: noRemote });
    assert.equal(before.ok, true);
    assert.equal(before.degraded, false);
    assert.equal(before.kind, 'no-remote');
    assert.equal(before.skipped, true);
    assert.equal(pull.calls.filter((c) => c.cmd.includes('bd dolt')).length, 0, 'no dolt command may be issued on a no-remote clone');

    const push = makeCommandMock({});
    const after = await DoltSync.syncAfter('scratch', { command: push.command, checkSyncRemoteConfigured: noRemote });
    assert.equal(after.ok, true);
    assert.equal(after.degraded, false);
    assert.equal(after.kind, 'no-remote');
    assert.equal(push.calls.filter((c) => c.cmd.includes('bd dolt')).length, 0);
    // A benign skip is NOT a degraded sync and must not be recorded as one.
    assert.equal(getDegradedSyncRecords({ member: 'scratch' }).length, 0);
    clearDegradedSyncRecords();
});

test('the sync.remote pre-gate does NOT suppress the pull on a genuinely configured clone', async () => {
    clearDegradedSyncRecords();
    // "Gating accident" guard: a clone whose sync.remote IS configured must
    // still issue its `bd dolt pull`.
    const { command, calls } = makeCommandMock({ 'bd dolt pull': [OK] });
    const outcome = await DoltSync.syncBefore('local', { command, checkSyncRemoteConfigured: remoteConfigured });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.kind, 'synced');
    assert.equal(calls.filter((c) => c.cmd.includes('bd dolt pull')).length, 1);
    clearDegradedSyncRecords();
});

// =============================================================================
// apra-fleet-417.5 -- docs/adr-taskdb-backend-neutral-interface.md Decision 2:
// the backend-neutral degraded.kind taxonomy, and the refreshView / ensureReady
// / flush / repair / capabilities surface additions.
// =============================================================================

test('a degraded outcome carries a backend-neutral degradedKind alongside the adapter kind', async () => {
    clearDegradedSyncRecords();
    const { command } = makeCommandMock({
        'bd dolt push': [fail(LIVE_2026_08_02_CREDENTIAL_STDERR)],
        'bd dolt pull': [OK],
    });
    const outcome = await DoltSync.syncAfter('fleet-mac', {
        command, checkSyncRemoteConfigured: remoteConfigured, sleep: async () => {},
    });
    assert.equal(outcome.kind, 'auth');
    assert.equal(outcome.degradedKind, 'auth');
    clearDegradedSyncRecords();
});

test('an unresolvable divergence maps to the neutral conflict-unresolvable kind', async () => {
    clearDegradedSyncRecords();
    const { command } = makeCommandMock({ 'bd dolt push': [fail(REAL_DIVERGENCE_STDERR)] });
    const outcome = await DoltSync.syncAfter('local', { command, checkSyncRemoteConfigured: remoteConfigured });
    assert.equal(outcome.degraded, true);
    assert.equal(outcome.degradedKind, 'conflict-unresolvable');
    clearDegradedSyncRecords();
});

test('capabilities() declares the Dolt/beads adapter as whole-state-publish with repair WIRED (apra-fleet-vkc.1)', () => {
    const caps = DoltSync.capabilities();
    assert.equal(caps.wholeStatePublish, true);
    assert.equal(caps.supportsRepair, true);
    assert.equal(caps.supportsCoordinationLock, true);
    assert.ok(Array.isArray(caps.kinds) && caps.kinds.includes('conflict-unresolvable'));
});

test('refreshView() reports fresh:true on a successful, non-fatal probe', async () => {
    clearDegradedSyncRecords();
    const { command } = makeCommandMock({ 'bd dolt pull': [OK] });
    const result = await DoltSync.refreshView('local', { command, checkSyncRemoteConfigured: remoteConfigured });
    assert.equal(result.fresh, true);
    assert.equal(result.degraded, undefined);
    clearDegradedSyncRecords();
});

test('refreshView() reports fresh:false (never throws) on an unresolved failure', async () => {
    clearDegradedSyncRecords();
    const { command } = makeCommandMock({ 'bd dolt pull': [fail(REAL_DIVERGENCE_STDERR)] });
    const result = await DoltSync.refreshView('local', { command, checkSyncRemoteConfigured: remoteConfigured });
    assert.equal(result.fresh, false);
    assert.ok(result.degraded);
    clearDegradedSyncRecords();
});

test('ensureReady() reports ready:true on a clean pre-flight probe', async () => {
    clearDegradedSyncRecords();
    const { command } = makeCommandMock({ 'bd dolt pull': [OK] });
    const result = await DoltSync.ensureReady('local', { command, checkSyncRemoteConfigured: remoteConfigured });
    assert.equal(result.ready, true);
    clearDegradedSyncRecords();
});

test('ensureReady() is the one method permitted to refuse to start -- it still aborts on divergence', async () => {
    clearDegradedSyncRecords();
    const { command } = makeCommandMock({ 'bd dolt pull': [fail(REAL_DIVERGENCE_STDERR)] });
    await assert.rejects(
        () => DoltSync.ensureReady('local', { command, checkSyncRemoteConfigured: remoteConfigured }),
        (err) => err instanceof DoltDivergedError,
    );
    clearDegradedSyncRecords();
});

test('flush() reports the pending degradation ledger without a separate retry mechanism', async () => {
    clearDegradedSyncRecords();
    const { command } = makeCommandMock({ 'bd dolt push': [fail(REAL_DIVERGENCE_STDERR)] });
    await DoltSync.syncAfter('local', { command, checkSyncRemoteConfigured: remoteConfigured });
    const report = DoltSync.flush();
    assert.equal(report.published, false);
    assert.equal(report.degradations.length, 1);
    assert.equal(report.degradations[0].member, 'local');
    clearDegradedSyncRecords();
    const clean = DoltSync.flush();
    assert.equal(clean.published, true);
    assert.deepEqual(clean.degradations, []);
});

test('repair() with no injected command() reports not-configured rather than pretending to repair', async () => {
    const result = await DoltSync.repair('local');
    assert.equal(result.repaired, false);
    assert.match(result.escalation, /not-configured/);
});

test('repair() runs the real recovery ladder (apra-fleet-vkc.1): Path B closes a wedged clone', async () => {
    // Path A has no sql runtime injected here, so it self-defers; Path B
    // (discard-and-re-bootstrap) needs only command() + its fs defaults, which
    // we stub so no real filesystem/bootstrap is touched.
    const { command } = makeCommandMock({
        'bd bootstrap': [OK],
        'bd dolt push': [OK],
    });
    const result = await DoltSync.repair('local', {
        command,
        // Path B fs seams, injected so the test touches no real disk.
        readConfig: async () => ({ exists: true, raw: 'sync:\n  remote: origin\n', hasSyncRemote: true }),
        removePath: async () => {},
        listLocalState: async () => ['(test) nothing to discard'],
    });
    assert.equal(result.repaired, true);
    assert.equal(result.tier, 'path-b');
});
