// Launch path wiring of the cached beads view: POST /api/sprints' issue-scope
// overlap guard decides ONLY on rows fetched by a forced fresh check made in
// that very launch (never cached rows), and a failed/timed-out check answers
// 503 with the reason -- spawner not called, ledger unchanged.
//
// Uses the REAL createBeadsView + REAL doltPullBefore (fake member command),
// the REAL createLaunchScopeGuard/composeBeforeLaunch from bin/serve.mjs, the
// REAL createSprintController and a real ledger over a temp dir. Reverting the
// serve.mjs wiring (createLaunchScopeGuard -> createScopeGuard({ ledger }) with
// its default bd fetcher) would read no injected rows at all, so the
// poisoned-cache assertions below (409 on a fresh overlap the cache hid, launch
// proceeding when the cache showed a stale overlap) could not hold.

import { describe, test, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { composeBeforeLaunch, createLaunchScopeGuard } from '../bin/serve.mjs';
import { createBeadsView } from '../src/supervisor/beads-view.mjs';
import { createSprintController, ApiError } from '../src/supervisor/api.mjs';
import { createLedger } from '../src/supervisor/ledger.mjs';
import { clearLastSyncedTip, clearTipProbeFailures, invalidateSyncRemoteCache } from '../fleet-sprint/dolt-sync.mjs';

const MEMBER = 'backlog-proj';
const SHA_A = 'a'.repeat(40);
const QUIET = { log() {}, warn() {}, error() {} };

const tmpDirs = [];
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });
const reset = () => { clearLastSyncedTip(); clearTipProbeFailures(); invalidateSyncRemoteCache(); };
beforeEach(reset);
afterEach(reset);

/** Raw bd rows: EPIC-1 with child EPIC-1.1. */
const child = (id, parent) => ({ id, status: 'open', dependencies: [{ type: 'parent-child', issue_id: id, depends_on_id: parent }] });
// Active sprint S-1 claims EPIC-1; the launch asks for EPIC-1.1 (a descendant).
const ROWS_WITH_OVERLAP = [{ id: 'EPIC-1', status: 'open' }, child('EPIC-1.1', 'EPIC-1')];
// Rows with no parent link hide the overlap:
const ROWS_NO_OVERLAP = [{ id: 'EPIC-1', status: 'open' }, { id: 'EPIC-1.1', status: 'open' }];

function fakeMember({ pullResults = [{ ok: true, output: '' }] } = {}) {
    const state = { tip: SHA_A, pulls: 0, inFlight: 0, maxInFlight: 0 };
    const queue = [...pullResults];
    async function command(cmd) {
        if (cmd.startsWith('bd config get sync.remote')) return { ok: true, output: JSON.stringify({ key: 'sync.remote', value: 'git+https://example.test/o/b.git' }) };
        if (cmd.includes(' ls-remote ')) return { ok: true, output: `${state.tip}\trefs/dolt/data\n` };
        if (cmd === 'bd dolt pull') {
            state.pulls += 1;
            state.inFlight += 1;
            state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
            await new Promise((r) => setImmediate(r));
            state.inFlight -= 1;
            const next = queue.length > 1 ? queue.shift() : queue[0];
            return typeof next === 'string' ? { ok: false, error: next } : next;
        }
        return { ok: false, error: `unexpected command: ${cmd}` };
    }
    return { state, command };
}

async function setup({ backlogMember, memberOpts, listAllBeads, viewOpts = {}, fetchOpts = {} } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-fresh-'));
    tmpDirs.push(dir);
    const ledger = createLedger({ filePath: path.join(dir, 'ledger.json') });
    await ledger.start();
    await ledger.claim('S-1', { issueRoots: ['EPIC-1'], members: ['zed'], childPid: null });
    const member = fakeMember(memberOpts);
    const list = { calls: 0 };
    const view = createBeadsView({
        backlogMember: backlogMember ?? { get: () => ({ member: { name: MEMBER }, status: 'ready', reason: null }) },
        ledger,
        command: member.command,
        repoRoot: dir,
        listAllBeads: async (...a) => { list.calls += 1; return listAllBeads(list.calls, ...a); },
        logger: QUIET,
        ...viewOpts,
    });
    const spawned = [];
    const spawner = { spawnSprint: async (o) => { spawned.push(o); return { pid: 4242, port: 9100 }; } };
    const scopeGuard = createLaunchScopeGuard({ ledger, beadsView: view, launchFetchOpts: { retryDelayMs: 0, ...fetchOpts } });
    const controller = createSprintController({
        ledger, spawner,
        listMembers: () => ({ members: [] }),
        getBacklog: () => ({ tasks: [] }),
        beforeLaunch: composeBeforeLaunch({ memberOverlapGuard: async () => {}, scopeGuard }),
    });
    const launch = () => controller.launch({ issue: 'EPIC-1.1', members: ['alice'], branch: 'feat/x', base: 'main' });
    return { ledger, member, list, view, spawned, launch };
}

async function rejection(p) {
    try { await p; } catch (err) { return err; }
    return assert.fail('expected a rejection');
}

describe('launch overlap guard uses a forced fresh check, never cached rows', () => {
    test('poisoned cache hides an overlap the fresh fetch shows -> 409 naming the overlap; fetch happened in that call', async () => {
        const t = await setup({ listAllBeads: (n) => (n === 1 ? ROWS_NO_OVERLAP : ROWS_WITH_OVERLAP) });
        await t.view.refresh(); // seeds the (poisoned) cache: no overlap
        assert.equal(t.list.calls, 1);
        const err = await rejection(t.launch());
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 409);
        assert.match(err.message, /S-1/);
        assert.match(err.message, /EPIC-1\.1/);
        assert.equal(t.list.calls, 2, 'the guard fetched within the launch call');
        assert.equal(t.spawned.length, 0);
    });

    test('inverse: cache shows an overlap, fresh rows are clean -> launch proceeds', async () => {
        const t = await setup({ listAllBeads: (n) => (n === 1 ? ROWS_WITH_OVERLAP : ROWS_NO_OVERLAP) });
        await t.view.refresh();
        const res = await t.launch();
        assert.equal(t.list.calls, 2);
        assert.equal(t.spawned.length, 1);
        assert.ok(t.ledger.get(res.sprintId));
    });

    test('unchanged remote tip on launch: no bd dolt pull, but listAllBeads IS called', async () => {
        const t = await setup({ listAllBeads: () => ROWS_NO_OVERLAP });
        await t.view.refresh();
        const pullsBefore = t.member.state.pulls;
        await t.launch();
        assert.equal(t.member.state.pulls, pullsBefore, 'no pull on an unchanged tip');
        assert.equal(t.list.calls, 2, 're-list happens');
    });

    test('a launch during an in-flight background refresh joins it: at most one pull in flight', async () => {
        const t = await setup({ listAllBeads: () => ROWS_NO_OVERLAP });
        const bg = t.view.refresh(); // background refresh occupying the slot
        const res = await t.launch();
        await bg;
        assert.equal(t.member.state.maxInFlight, 1);
        assert.ok(res.sprintId);
    });
});

describe('launch: a failed fresh check answers 503 with the reason', () => {
    async function assert503(t, re) {
        const before = t.ledger.list().length;
        const err = await rejection(t.launch());
        assert.ok(err instanceof ApiError, String(err));
        assert.equal(err.status, 503);
        assert.match(err.message, re);
        assert.equal(t.spawned.length, 0, 'spawner not called');
        assert.equal(t.ledger.list().length, before, 'no new reservation');
    }

    test('pull error', async () => {
        const t = await setup({ listAllBeads: () => ROWS_NO_OVERLAP, memberOpts: { pullResults: ['fatal: remote exploded'] } });
        await assert503(t, /remote exploded/);
    });

    test('listAllBeads error', async () => {
        const t = await setup({ listAllBeads: () => { throw new Error('bd list blew up'); } });
        await assert503(t, /bd list blew up/);
    });

    test('degraded backlog member', async () => {
        const t = await setup({
            listAllBeads: () => ROWS_NO_OVERLAP,
            backlogMember: { get: () => ({ member: null, status: 'degraded', reason: 'no member registered' }) },
        });
        await assert503(t, /no member registered/);
        assert.equal(t.list.calls, 0);
    });

    test('timeout (fake clock): the check never finishes within the bound', async () => {
        const timers = [];
        const nowMs = 1_000_000;
        const t = await setup({
            listAllBeads: () => ROWS_NO_OVERLAP,
            viewOpts: {
                doltPullBefore: () => new Promise(() => {}), // never settles
                setTimeout: (fn) => { timers.push(fn); return { unref() {} }; },
                clearTimeout() {},
            },
            fetchOpts: { timeoutMs: 5000, now: () => nowMs },
        });
        const p = t.launch();
        await new Promise((r) => setImmediate(r));
        assert.equal(timers.length, 1, 'launch armed exactly one wall-clock timer');
        timers[0]();
        const err = await rejection(p);
        assert.equal(err.status, 503);
        assert.match(err.message, /did not finish within/);
        assert.equal(t.spawned.length, 0);
    });
});

describe('launch: busy/lock skips', () => {
    test('a single transient busy skip is retried inside the bound and the launch succeeds', async () => {
        const t = await setup({
            listAllBeads: () => ROWS_NO_OVERLAP,
            memberOpts: { pullResults: ['database is locked', { ok: true, output: '' }] },
        });
        const res = await t.launch();
        assert.ok(res.sprintId);
        assert.equal(t.member.state.pulls, 2, 'one busy pull, one retried pull');
        assert.equal(t.spawned.length, 1);
    });

    test('a persistent busy state answers 503 once retries are exhausted', async () => {
        const t = await setup({
            listAllBeads: () => ROWS_NO_OVERLAP,
            memberOpts: { pullResults: ['database is locked'] },
            fetchOpts: { busyRetries: 2 },
        });
        const err = await rejection(t.launch());
        assert.equal(err.status, 503);
        assert.match(err.message, /lock/);
        assert.equal(t.member.state.pulls, 3, 'initial attempt + 2 retries');
        assert.equal(t.spawned.length, 0);
    });

    test('a non-transient failure answers 503 immediately (no retry)', async () => {
        const t = await setup({ listAllBeads: () => ROWS_NO_OVERLAP, memberOpts: { pullResults: ['fatal: bad object'] } });
        const err = await rejection(t.launch());
        assert.equal(err.status, 503);
        assert.equal(t.member.state.pulls, 1);
    });
});
