import { test } from 'node:test';
import assert from 'node:assert/strict';
import { doltPushAfter, DOLT_MUTEX_RENEW_INTERVAL_MS } from '../fleet-sprint/dolt-sync.mjs';
import { createDoltMutex, nullDoltPushMutexClient } from '../src/supervisor/dolt-mutex.mjs';
import { createHttpDoltPushMutexClient, createMcpDoltPushMutexClient } from '../fleet-sprint/runner.js';

// =============================================================================
// Mutex lease renewal (docs/dolt-sync-redesign.md Part 3.4).
//
// The supervisor mutex's lease is 60s and reclaimExpired() force-evicts at
// expiry EVEN IF the holder is alive, while doltPushAfter() acquired once and
// never renewed -- so mutual exclusion was silently lost partway through any
// legitimately long hold. Holds got longer under this redesign, because a
// divergence now runs a full settle (ephemeral server spawn + merge + resolve
// + republish) inside the bracket.
//
// These tests use FAKE TIMERS (never a real sleep) to prove the lease is
// renewed on the expected interval while a long settle is in flight, that
// renewal STOPS when the bracket finishes, and -- against the REAL supervisor
// mutex -- that the renewals actually prevent reclaimExpired() from evicting a
// live holder mid-settle.
// =============================================================================

const REAL_DIVERGENCE_STDERR =
    'error: failed to push some refs to origin/main\n'
    + 'hint: Updates were rejected because the remote contains work that you do not have locally.';

const OK = { ok: true, output: '', error: null };
const fail = (error) => ({ ok: false, output: '', error });
const remoteConfigured = async () => true;

/** A command() whose D-push is rejected once, so the bracket reaches its
 *  divergence terminal and runs settle. */
function divergingCommand() {
    return async (cmd) => (cmd.includes('bd dolt push') ? fail(REAL_DIVERGENCE_STDERR) : OK);
}

/** Let queued microtasks/IO drain so the bracket reaches its settle await. */
async function drain(times = 5) {
    for (let i = 0; i < times; i += 1) {
        // eslint-disable-next-line no-await-in-loop -- draining is inherently sequential
        await new Promise((resolve) => { setImmediate(resolve); });
    }
}

/** A settle callback the test can hold open for as long as it likes. */
function gatedSettle(resolvedTables = ['issues']) {
    let open;
    const gate = new Promise((resolve) => { open = resolve; });
    return { open, settle: async () => { await gate; return { ok: true, resolvedTables, warnings: [] }; } };
}

test('the renewal interval is well under the supervisor mutex lease (a renewal that lands after expiry is useless)', () => {
    const mutex = createDoltMutex();
    assert.ok(
        DOLT_MUTEX_RENEW_INTERVAL_MS < mutex.leaseMs / 2,
        `renew interval ${DOLT_MUTEX_RENEW_INTERVAL_MS}ms must be well under the ${mutex.leaseMs}ms lease`,
    );
});

test('doltPushAfter renews the mutex lease on an interval while a long settle is in progress, and stops when it completes', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });

    const renewals = [];
    let released = null;
    const mutex = {
        acquire: async () => ({ token: 'TOKEN-1' }),
        release: async (token) => { released = token; return true; },
        renew: async (token) => { renewals.push(token); return true; },
    };
    const { open, settle } = gatedSettle();

    const pending = doltPushAfter('local', {
        command: divergingCommand(), checkSyncRemoteConfigured: remoteConfigured, mutex, settle, renewIntervalMs: 20_000,
    });

    await drain();
    assert.equal(renewals.length, 0, 'nothing is renewed before the first interval elapses');

    t.mock.timers.tick(60_000); // one full 60s lease worth of 20s intervals
    await drain();
    assert.equal(renewals.length, 3, 'the lease is renewed once per interval while the settle is still running');
    assert.ok(renewals.every((tok) => tok === 'TOKEN-1'), 'every renewal carries the grant token');

    open();
    const outcome = await pending;
    assert.equal(outcome.recovered, true);
    assert.equal(released, 'TOKEN-1', 'the grant is still released in the finally');

    const atCompletion = renewals.length;
    t.mock.timers.tick(120_000);
    await drain();
    assert.equal(renewals.length, atCompletion, 'renewal STOPS once the bracket completes -- the interval is cleared in the same finally that releases');
});

test('renewals keep the REAL supervisor mutex from reclaiming a live holder mid-settle', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });

    // A real mutex with an injected clock, so "time passes" deterministically.
    let clock = 0;
    const mutex = createDoltMutex({ now: () => clock, isPidAlive: () => true });
    const client = {
        acquire: async (sprintId, o) => mutex.acquire(sprintId, o),
        release: async (token) => mutex.release(token),
        renew: async (token) => Boolean(mutex.renew(token)),
    };
    const { open, settle } = gatedSettle();

    const pending = doltPushAfter('local', {
        command: divergingCommand(), checkSyncRemoteConfigured: remoteConfigured, mutex: client, sprintId: 'sprint-A', settle, renewIntervalMs: 20_000,
    });
    await drain();
    assert.equal(mutex.status().holder.sprintId, 'sprint-A', 'the bracket holds the mutex while it settles');

    // Advance well past the 60s lease, ticking the renew interval as we go.
    for (let elapsed = 0; elapsed < 180_000; elapsed += 20_000) {
        clock += 20_000;
        t.mock.timers.tick(20_000);
        // eslint-disable-next-line no-await-in-loop -- sequential by design
        await drain();
        mutex.reclaimExpired();
        assert.ok(mutex.status().holder, `the live holder must never be force-evicted mid-settle (t=${clock}ms, 3x the lease)`);
        assert.equal(mutex.status().holder.sprintId, 'sprint-A');
    }

    open();
    await pending;
    assert.equal(mutex.status().holder, null, 'the mutex is free again once the bracket finishes');
});

test('a refused or failing renewal is logged, never fatal to the push', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const logs = [];
    const mutex = {
        acquire: async () => ({ token: 'TOKEN-2' }),
        release: async () => true,
        renew: async () => { throw new Error('supervisor unreachable'); },
    };
    const { open, settle } = gatedSettle([]);

    const pending = doltPushAfter('local', {
        command: divergingCommand(), checkSyncRemoteConfigured: remoteConfigured, mutex, settle, renewIntervalMs: 20_000, log: (m) => logs.push(m),
    });
    await drain();
    t.mock.timers.tick(20_000);
    await drain();
    open();
    const outcome = await pending;

    assert.equal(outcome.ok, true, 'a failed lease renewal must not fail the push');
    assert.ok(logs.some((l) => /renewal for member 'local' failed/.test(l)), 'the failure is surfaced in the log, never swallowed');
});

test('a renewal REFUSED by the server (lease already reclaimed) is logged loudly rather than passing silently', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const logs = [];
    const mutex = {
        acquire: async () => ({ token: 'TOKEN-3' }),
        release: async () => true,
        renew: async () => false,
    };
    const { open, settle } = gatedSettle([]);
    const pending = doltPushAfter('local', {
        command: divergingCommand(), checkSyncRemoteConfigured: remoteConfigured, mutex, settle, renewIntervalMs: 20_000, log: (m) => logs.push(m),
    });
    await drain();
    t.mock.timers.tick(20_000);
    await drain();
    open();
    await pending;
    assert.ok(logs.some((l) => /REFUSED/.test(l)), 'a refused renewal means another sprint may now hold the mutex -- it must be visible');
});

test('a mutex client with no renew() (the null client / supervisor-less topology) never throws', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const legacyClient = { acquire: async () => ({ token: null }), release: async () => true };
    const outcome = await doltPushAfter('local', {
        command: async () => OK, checkSyncRemoteConfigured: remoteConfigured, mutex: legacyClient,
    });
    assert.equal(outcome.ok, true);
    t.mock.timers.tick(120_000);

    const nullClient = nullDoltPushMutexClient();
    assert.equal(typeof nullClient.renew, 'function', 'the null client keeps shape parity with the real clients');
    assert.equal(await nullClient.renew('anything'), true);
});

// --- the two child-side clients actually speak renew --------------------------

test('createHttpDoltPushMutexClient.renew() posts the supervisor renew route and reports the outcome', async () => {
    const posted = [];
    const client = createHttpDoltPushMutexClient({
        serviceUrl: 'http://localhost:8787',
        sprintId: 'sprint-A',
        fetch: async (url, init) => {
            posted.push({ url, body: JSON.parse(init.body) });
            return { ok: true, status: 200, json: async () => ({ renewed: true, expiresAt: 123 }) };
        },
    });
    assert.equal(await client.renew('TOKEN-9'), true);
    assert.equal(posted[0].url, 'http://localhost:8787/api/dolt-push-mutex/sprint-A/renew');
    assert.deepEqual(posted[0].body, { token: 'TOKEN-9' });
    assert.equal(await client.renew(null), false, 'no token means nothing to renew');
});

test('createHttpDoltPushMutexClient.renew() treats a transport failure as non-fatal', async () => {
    const logs = [];
    const client = createHttpDoltPushMutexClient({
        serviceUrl: 'http://localhost:8787',
        sprintId: 'sprint-A',
        fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
        log: (m) => logs.push(m),
    });
    assert.equal(await client.renew('TOKEN-9'), false);
    assert.ok(logs.some((l) => /renew failed \(non-fatal/.test(l)));
});

test('createMcpDoltPushMutexClient.renew() calls the fleet dolt_push_mutex tool with action renew', async () => {
    const calls = [];
    const client = createMcpDoltPushMutexClient({
        sprintId: 'sprint-A',
        callTool: async (name, args) => {
            calls.push({ name, args });
            return JSON.stringify({ renewed: true, expiresAt: 456 });
        },
    });
    assert.equal(await client.renew('TOKEN-7'), true);
    assert.deepEqual(calls[0], { name: 'dolt_push_mutex', args: { action: 'renew', token: 'TOKEN-7' } });
});
