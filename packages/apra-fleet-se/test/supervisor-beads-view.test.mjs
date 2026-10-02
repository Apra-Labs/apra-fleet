// Tests for the supervisor's cached beads view (src/supervisor/beads-view.mjs):
// tip-checked refresh, single in-flight refresh, busy skip, scopeFreshness,
// the execute_command adapter, and freshForLaunch's never-a-cached-row rule.
//
// The REAL doltPullBefore (fleet-sprint/dolt-sync.mjs) is driven by a fake
// member command() -- no real bd, git or fleet server. dolt-sync.mjs keeps
// process-lifetime per-member memos (sync.remote answer, last-synced tip,
// probe-failure latch), so every test resets all three before and after.

import { describe, test, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    createBeadsView,
    createBeadsViewCommand,
    normalizeFleetCommandResult,
    BeadsViewUnavailableError,
} from '../src/supervisor/beads-view.mjs';
import {
    doltPullBefore,
    clearLastSyncedTip,
    clearTipProbeFailures,
    invalidateSyncRemoteCache,
} from '../fleet-sprint/dolt-sync.mjs';
import { createLedger } from '../src/supervisor/ledger.mjs';

const MEMBER = 'backlog-proj';
const REPO_ROOT = path.join(os.tmpdir(), 'beads-view-test-repo-root');
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const QUIET = { log() {}, warn() {}, error() {} };

const tmpDirs = [];
function makeTmpDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beads-view-test-'));
    tmpDirs.push(dir);
    return dir;
}
after(() => {
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function resetDoltSyncState() {
    clearLastSyncedTip();
    clearTipProbeFailures();
    invalidateSyncRemoteCache();
}
beforeEach(resetDoltSyncState);
afterEach(resetDoltSyncState);

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

/**
 * A fake member command() answering the three command shapes doltPullBefore
 * issues: the sync.remote probe, the ls-remote tip probe, and `bd dolt pull`.
 * `pullResults` is a queue of results for successive pulls (the last one
 * repeats); a string entry is a failure with that error text.
 */
function fakeMember({ syncRemote = 'git+https://example.test/org/beads.git', tip = SHA_A, pullResults = [{ ok: true, output: '' }] } = {}) {
    const state = { tip, syncRemote, pulls: 0, lsRemotes: 0, calls: [] };
    const queue = [...pullResults];
    async function command(cmd, opts = {}) {
        state.calls.push({ cmd, opts });
        if (cmd.startsWith('bd config get sync.remote')) {
            return { ok: true, output: JSON.stringify({ key: 'sync.remote', value: state.syncRemote }) };
        }
        if (cmd.includes(' ls-remote ')) {
            state.lsRemotes += 1;
            return { ok: true, output: `${state.tip}\trefs/dolt/data\n` };
        }
        if (cmd === 'bd dolt pull') {
            state.pulls += 1;
            const next = queue.length > 1 ? queue.shift() : queue[0];
            return typeof next === 'string' ? { ok: false, error: next } : next;
        }
        return { ok: false, error: `unexpected command: ${cmd}` };
    }
    return { state, command };
}

function readyMember(name = MEMBER) {
    return { get: () => ({ member: { name }, status: 'ready', reason: null }) };
}

/** A listAllBeads fake that counts calls and records the options it got. */
function fakeList(rowsFor = (n) => [{ id: `row-${n}` }]) {
    const state = { calls: 0, opts: [] };
    async function listAllBeads(opts) {
        state.calls += 1;
        state.opts.push(opts);
        return rowsFor(state.calls);
    }
    return { state, listAllBeads };
}

/** Wrap the real doltPullBefore so its opts can be asserted. */
function spyPull() {
    const calls = [];
    async function pull(member, opts) {
        calls.push({ member, opts });
        return doltPullBefore(member, opts);
    }
    return { calls, pull };
}

function steppingClock(start = Date.parse('2026-10-01T00:00:00Z'), stepMs = 1000) {
    let t = start;
    return () => { t += stepMs; return t; };
}

async function realLedger() {
    const ledger = createLedger({ dataDir: makeTmpDir() });
    await ledger.start();
    return ledger;
}

describe('cached beads view: tip-checked refresh', () => {
    test('unchanged tip: the second refresh issues no bd dolt pull and no listAllBeads, yet lastSyncedAt advances', async () => {
        const member = fakeMember();
        const list = fakeList();
        const ledger = await realLedger();
        const view = createBeadsView({ backlogMember: readyMember(), ledger, command: member.command, repoRoot: REPO_ROOT, listAllBeads: list.listAllBeads, now: steppingClock(), logger: QUIET });

        await view.refresh();
        assert.equal(member.state.pulls, 1);
        assert.equal(list.state.calls, 1);
        const first = ledger.getScopeFreshness().lastSyncedAt;
        assert.equal(typeof first, 'string');

        const snap = await view.refresh();
        assert.equal(member.state.pulls, 1, 'no bd dolt pull on an unchanged remote tip');
        assert.equal(list.state.calls, 1, 'no re-list on an unchanged remote tip');
        assert.deepEqual(snap.rows, [{ id: 'row-1' }]);
        const second = ledger.getScopeFreshness().lastSyncedAt;
        assert.ok(Date.parse(second) > Date.parse(first), `lastSyncedAt advanced (${first} -> ${second})`);
        assert.equal(snap.lastError, null);
        assert.equal(snap.lastSkip, null);
    });

    test('changed tip: exactly one pull and one list, rows replaced, scope freshness is a number of seconds', async () => {
        const member = fakeMember();
        const list = fakeList();
        const ledger = await realLedger();
        assert.equal(ledger.getScopeFreshness().ageSeconds, 'never-synced');
        const view = createBeadsView({ backlogMember: readyMember(), ledger, command: member.command, repoRoot: REPO_ROOT, listAllBeads: list.listAllBeads, logger: QUIET });

        await view.refresh();
        member.state.tip = SHA_B;
        const pullsBefore = member.state.pulls;
        const listsBefore = list.state.calls;
        const snap = await view.refresh();
        assert.equal(member.state.pulls - pullsBefore, 1);
        assert.equal(list.state.calls - listsBefore, 1);
        assert.deepEqual(snap.rows, [{ id: 'row-2' }]);
        assert.equal(typeof ledger.getScopeFreshness().ageSeconds, 'number');
    });

    test('listAllBeads runs with cwd = the repoRoot the view was constructed with', async () => {
        const member = fakeMember();
        const list = fakeList();
        const view = createBeadsView({ backlogMember: readyMember(), command: member.command, repoRoot: REPO_ROOT, listAllBeads: list.listAllBeads, logger: QUIET });
        await view.refresh();
        await view.freshForLaunch();
        assert.equal(list.state.calls, 2);
        for (const opts of list.state.opts) assert.deepEqual(opts, { cwd: REPO_ROOT });
    });

    test('no-remote: rows are re-listed on every refresh, and no pull is issued', async () => {
        const member = fakeMember({ syncRemote: '' });
        const list = fakeList();
        const view = createBeadsView({ backlogMember: readyMember(), command: member.command, repoRoot: REPO_ROOT, listAllBeads: list.listAllBeads, logger: QUIET });
        for (let i = 0; i < 3; i += 1) await view.refresh();
        assert.equal(list.state.calls, 3);
        assert.equal(member.state.pulls, 0);
        assert.deepEqual(view.snapshot().rows, [{ id: 'row-3' }]);
    });

    test('empty-remote: rows are re-listed on every refresh', async () => {
        const member = fakeMember({ pullResults: ['Error 1105: no branches found in remote'] });
        const list = fakeList();
        const view = createBeadsView({ backlogMember: readyMember(), command: member.command, repoRoot: REPO_ROOT, listAllBeads: list.listAllBeads, logger: QUIET });
        for (let i = 0; i < 3; i += 1) await view.refresh();
        assert.equal(list.state.calls, 3);
        assert.equal(view.snapshot().lastError, null);
    });
});

describe('cached beads view: busy skip and failures', () => {
    // Revert-proof: drop `maxTransientRetries: 0` from runCheck()'s
    // doltPullBefore call in beads-view.mjs and runDoltStep() falls back to
    // its default transient ladder -- it sleeps the backoff and re-issues the
    // pull, which this fake answers with success on the second try. The round
    // is then NOT skipped (lastSkip stays null, scope freshness advances, two
    // pulls in one refresh), so the assertions below fail, as does the
    // explicit maxTransientRetries check.
    test('a lock/busy pull failure skips the round (rows and freshness kept, no lastError); the next refresh succeeds', async () => {
        const member = fakeMember({ pullResults: [{ ok: true, output: '' }, 'database is locked', { ok: true, output: '' }] });
        const list = fakeList();
        const ledger = await realLedger();
        const spy = spyPull();
        const view = createBeadsView({ backlogMember: readyMember(), ledger, command: member.command, repoRoot: REPO_ROOT, listAllBeads: list.listAllBeads, doltPullBefore: spy.pull, now: steppingClock(), logger: QUIET });

        await view.refresh();
        const freshnessBefore = ledger.getScopeFreshness().lastSyncedAt;
        member.state.tip = SHA_B; // force a real pull on the next round

        const pullsBefore = member.state.pulls;
        const skipped = await view.refresh();
        assert.equal(member.state.pulls - pullsBefore, 1, 'a busy pull is attempted once, not retried');
        assert.ok(skipped.lastSkip, 'lastSkip set');
        assert.match(skipped.lastSkip.reason, /lock/i);
        assert.equal(skipped.lastError, null);
        assert.deepEqual(skipped.rows, [{ id: 'row-1' }], 'cached rows unchanged');
        assert.equal(list.state.calls, 1);
        assert.equal(ledger.getScopeFreshness().lastSyncedAt, freshnessBefore, 'scope freshness not advanced on a skip');
        for (const call of spy.calls) {
            assert.equal(call.opts.maxTransientRetries, 0);
            assert.equal(call.opts.settle, undefined, 'the supervisor never runs settle');
        }

        const next = await view.refresh();
        assert.equal(next.lastSkip, null);
        assert.equal(next.lastError, null);
        assert.deepEqual(next.rows, [{ id: 'row-2' }]);
        assert.notEqual(ledger.getScopeFreshness().lastSyncedAt, freshnessBefore);
    });

    test('a lock/busy listAllBeads failure is also a skip, not an error', async () => {
        const member = fakeMember();
        let n = 0;
        const view = createBeadsView({
            backlogMember: readyMember(), command: member.command, repoRoot: REPO_ROOT, logger: QUIET,
            listAllBeads: async () => { n += 1; if (n === 2) throw new Error('database is locked'); return [{ id: `row-${n}` }]; },
        });
        await view.refresh();
        await assert.rejects(view.freshForLaunch(), (err) => err instanceof BeadsViewUnavailableError && err.kind === 'skip');
        const snap = view.snapshot();
        assert.ok(snap.lastSkip);
        assert.equal(snap.lastError, null);
        assert.deepEqual(snap.rows, [{ id: 'row-1' }]);
    });

    for (const [label, errorText, pattern] of [
        ['auth', 'fatal: Authentication failed for https://example.test/org/beads.git', /credentials/i],
        ['unreachable', 'failed to get remote db: file:///gone/beads: no such file or directory', /unreachable/i],
    ]) {
        test(`an ${label} pull failure records lastError with the reason and keeps cached rows`, async () => {
            const member = fakeMember({ pullResults: [{ ok: true, output: '' }, errorText] });
            const list = fakeList();
            const ledger = await realLedger();
            const view = createBeadsView({ backlogMember: readyMember(), ledger, command: member.command, repoRoot: REPO_ROOT, listAllBeads: list.listAllBeads, now: steppingClock(), logger: QUIET });
            await view.refresh();
            const freshnessBefore = ledger.getScopeFreshness().lastSyncedAt;
            member.state.tip = SHA_B;
            const snap = await view.refresh();
            assert.ok(snap.lastError, 'lastError set');
            assert.match(snap.lastError.message, pattern);
            assert.equal(snap.lastSkip, null);
            assert.deepEqual(snap.rows, [{ id: 'row-1' }]);
            assert.equal(ledger.getScopeFreshness().lastSyncedAt, freshnessBefore);
        });
    }

    for (const [label, handle] of [
        ['degraded', { get: () => ({ member: null, status: 'degraded', reason: 'no reachable fleet HTTP singleton' }) }],
        ['null', { get: () => ({ member: null, status: 'degraded', reason: null }) }],
    ]) {
        test(`a ${label} backlog member yields lastError with the reason and lists nothing`, async () => {
            const member = fakeMember();
            const list = fakeList();
            const view = createBeadsView({ backlogMember: handle, command: member.command, repoRoot: REPO_ROOT, listAllBeads: list.listAllBeads, logger: QUIET });
            const snap = await view.refresh();
            assert.ok(snap.lastError);
            assert.match(snap.lastError.message, /backlog member not ready/);
            if (label === 'degraded') assert.match(snap.lastError.message, /no reachable fleet HTTP singleton/);
            assert.equal(snap.rows, null);
            assert.equal(list.state.calls, 0, 'no silent list without a pullable clone');
            assert.equal(member.state.calls.length, 0, 'no member command issued');
        });
    }
});

describe('cached beads view: single in-flight and non-blocking reads', () => {
    test('5 concurrent refresh() calls -> 1 pull and 1 listAllBeads', async () => {
        const member = fakeMember();
        const list = fakeList();
        const view = createBeadsView({ backlogMember: readyMember(), command: member.command, repoRoot: REPO_ROOT, listAllBeads: list.listAllBeads, logger: QUIET });
        const snaps = await Promise.all([1, 2, 3, 4, 5].map(() => view.refresh()));
        assert.equal(member.state.pulls, 1);
        assert.equal(list.state.calls, 1);
        for (const s of snaps) assert.deepEqual(s.rows, [{ id: 'row-1' }]);
    });

    test('refreshIfStale returns before the refresh resolves, and does nothing within the max age', async () => {
        const gate = deferred();
        let pulls = 0;
        let t = 1_000_000;
        const view = createBeadsView({
            backlogMember: readyMember(), command: async () => ({ ok: true, output: '' }), repoRoot: REPO_ROOT, logger: QUIET,
            now: () => t,
            doltPullBefore: async () => { pulls += 1; await gate.promise; return { ok: true, member: MEMBER }; },
            listAllBeads: async () => [{ id: 'r' }],
        });
        assert.equal(view.refreshIfStale(10_000), true);
        assert.equal(view.snapshot().refreshing, true, 'returned while the refresh is still pending');
        assert.equal(view.snapshot().rows, null);
        assert.equal(view.refreshIfStale(10_000), false, 'nothing started while one is in flight');
        gate.resolve();
        await view.refresh(); // joins the in-flight one
        assert.equal(pulls, 1);
        assert.deepEqual(view.snapshot().rows, [{ id: 'r' }]);

        t += 5_000;
        assert.equal(view.refreshIfStale(10_000), false, 'within max age: no refresh');
        assert.equal(view.snapshot().refreshing, false);
        assert.equal(pulls, 1);

        t += 10_000;
        assert.equal(view.refreshIfStale(10_000), true, 'past max age: refresh started');
        await view.refresh();
        assert.equal(pulls, 2);
    });
});

describe('cached beads view: execute_command adapter', () => {
    test('timeout_s passed by doltPullBefore reaches executeFleetCommand as timeoutSeconds', async () => {
        const requests = [];
        const resolveConnection = async () => ({ mode: 'http', url: 'http://127.0.0.1:1/mcp' });
        const executeFleetCommand = async (req) => {
            requests.push(req);
            if (req.command.startsWith('bd config get sync.remote')) {
                return { ok: true, output: 'Exit code: 0\n{"value":"git+https://example.test/x.git"}', exitCode: 0, stdout: '{"value":"git+https://example.test/x.git"}', stderr: '' };
            }
            if (req.command.includes(' ls-remote ')) {
                return { ok: true, output: `Exit code: 0\n${SHA_A}\trefs/dolt/data`, exitCode: 0, stdout: `${SHA_A}\trefs/dolt/data\n`, stderr: '' };
            }
            return { ok: true, output: 'Exit code: 0\n', exitCode: 0, stdout: '', stderr: '' };
        };
        const command = createBeadsViewCommand({ executeFleetCommand, resolveConnection });
        const view = createBeadsView({ backlogMember: readyMember(), command, repoRoot: REPO_ROOT, listAllBeads: async () => [], pullTimeoutS: 17, logger: QUIET });
        await view.refresh();
        const pullReq = requests.find((r) => r.command === 'bd dolt pull');
        assert.ok(pullReq, 'a real pull was issued through the adapter');
        assert.equal(pullReq.timeoutSeconds, 17);
        assert.equal(pullReq.member, MEMBER);
        assert.equal(pullReq.resolveConnection, resolveConnection);
        // The unprefixed stdout let the sync.remote probe parse, so the second
        // refresh is a tip-checked skip.
        await view.refresh();
        assert.equal(requests.filter((r) => r.command === 'bd dolt pull').length, 1);
    });

    test('a non-zero exit is a failure even though execute_command does not flag isError', () => {
        assert.deepEqual(
            normalizeFleetCommandResult({ ok: true, output: 'Exit code: 1\nx', exitCode: 1, stdout: '', stderr: 'database is locked' }),
            { ok: false, error: 'Exit code 1: database is locked' },
        );
        assert.deepEqual(normalizeFleetCommandResult({ ok: true, output: 'Exit code: 2\nboom' }), { ok: false, error: 'Exit code 2: boom' });
        assert.deepEqual(normalizeFleetCommandResult({ ok: true, output: 'Exit code: 0\nhello' }), { ok: true, output: 'hello' });
        assert.deepEqual(normalizeFleetCommandResult({ ok: false, error: 'nope' }), { ok: false, error: 'nope' });
    });
});

describe('cached beads view: freshForLaunch', () => {
    test('resolves rows from its own listAllBeads call, never the poisoned cached ones', async () => {
        const member = fakeMember();
        let n = 0;
        const view = createBeadsView({
            backlogMember: readyMember(), command: member.command, repoRoot: REPO_ROOT, logger: QUIET,
            listAllBeads: async () => { n += 1; return n === 1 ? [{ id: 'POISONED' }] : [{ id: 'fresh' }]; },
        });
        await view.refresh();
        assert.deepEqual(view.snapshot().rows, [{ id: 'POISONED' }]);
        // Tip unchanged: refresh() alone would keep the poisoned rows...
        await view.refresh();
        assert.equal(n, 1);
        // ...but freshForLaunch always re-lists within the call.
        const rows = await view.freshForLaunch();
        assert.equal(n, 2);
        assert.deepEqual(rows, [{ id: 'fresh' }]);
        assert.deepEqual(view.snapshot().rows, [{ id: 'fresh' }], 'fresh rows written into the cache');
        assert.equal(member.state.pulls, 1, 'the pull itself was still tip-skipped');
    });

    test('joins an in-flight refresh instead of running two concurrently', async () => {
        const gates = [deferred(), deferred()];
        let active = 0;
        let maxActive = 0;
        let calls = 0;
        const view = createBeadsView({
            backlogMember: readyMember(), command: async () => ({ ok: true, output: '' }), repoRoot: REPO_ROOT, logger: QUIET,
            doltPullBefore: async () => ({ ok: true, member: MEMBER }),
            listAllBeads: async () => {
                const i = calls;
                calls += 1;
                active += 1;
                maxActive = Math.max(maxActive, active);
                try { await gates[i].promise; } finally { active -= 1; }
                return [{ id: `list-${i}` }];
            },
        });
        const refreshing = view.refresh();
        const launching = view.freshForLaunch({ timeoutMs: 5_000 });
        await new Promise((r) => setImmediate(r));
        assert.equal(calls, 1, 'freshForLaunch waits for the in-flight refresh');
        gates[0].resolve();
        await refreshing;
        await new Promise((r) => setImmediate(r));
        assert.equal(calls, 2, 'then runs its own check');
        gates[1].resolve();
        assert.deepEqual(await launching, [{ id: 'list-1' }]);
        assert.equal(maxActive, 1, 'never two lists in flight');
    });

    test('rejects with a reason on timeout, keeping the slot until the work settles', async () => {
        const gate = deferred();
        let calls = 0;
        // The production timer is unref'd (it must never keep the supervisor
        // alive); here nothing else is pending, so an unref'd timer would let
        // the event loop drain before it fires. Inject a referenced one.
        const view = createBeadsView({
            backlogMember: readyMember(), command: async () => ({ ok: true, output: '' }), repoRoot: REPO_ROOT, logger: QUIET,
            doltPullBefore: async () => ({ ok: true, member: MEMBER }),
            listAllBeads: async () => { calls += 1; await gate.promise; return [{ id: 'late' }]; },
            setTimeout: (fn, ms) => ({ handle: setTimeout(fn, ms) }),
            clearTimeout: (t) => clearTimeout(t && t.handle),
        });
        await assert.rejects(view.freshForLaunch({ timeoutMs: 30 }), (err) => {
            assert.ok(err instanceof BeadsViewUnavailableError);
            assert.equal(err.kind, 'timeout');
            assert.match(err.reason, /30ms/);
            return true;
        });
        assert.equal(view.snapshot().refreshing, true, 'the slot is still held');
        assert.equal(view.refreshIfStale(0), false, 'no second concurrent check');
        gate.resolve();
        await view.refresh();
        assert.equal(calls, 1);
    });

    for (const [label, handle] of [
        ['degraded', { get: () => ({ member: null, status: 'degraded', reason: 'fleet unreachable' }) }],
        ['null', { get: () => ({ member: null, status: 'degraded', reason: null }) }],
    ]) {
        test(`rejects with a reason for a ${label} backlog member`, async () => {
            const list = fakeList();
            const view = createBeadsView({ backlogMember: handle, command: async () => ({ ok: true, output: '' }), repoRoot: REPO_ROOT, listAllBeads: list.listAllBeads, logger: QUIET });
            await assert.rejects(view.freshForLaunch({ timeoutMs: 5_000 }), (err) => {
                assert.ok(err instanceof BeadsViewUnavailableError);
                assert.match(err.reason, /backlog member not ready/);
                return true;
            });
            assert.equal(list.state.calls, 0);
        });
    }
});
