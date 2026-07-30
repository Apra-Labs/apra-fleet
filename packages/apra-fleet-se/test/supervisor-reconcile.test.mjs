import { test, describe } from 'node:test';
import assert from 'node:assert';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { createLedger, LEDGER_FILENAME } from '../src/supervisor/ledger.mjs';
import { createHistory, HISTORY_FILENAME, HISTORY_EVENTS } from '../src/supervisor/history.mjs';
import { createReconciler, registerReservationRoutes, SprintNotFoundError, killPid } from '../src/supervisor/reconcile.mjs';
import { createSupervisor } from '../src/supervisor/server.mjs';

// apra-fleet-eft.5.4 -- restart reconciliation (PID probe -> release both axes,
// mark aborted-by-restart) + force-release endpoint.

async function tmpDir() {
    return fsp.mkdtemp(path.join(os.tmpdir(), 'eft-reconcile-'));
}

/** Build a ledger + history pair backed by a temp dir, seeded via claim(). */
async function seed(dir, entries) {
    const ledger = createLedger({
        filePath: path.join(dir, LEDGER_FILENAME),
        now: () => '2026-07-18T00:00:00.000Z',
    });
    await ledger.start();
    for (const e of entries) {
        await ledger.claim(e.sprintId, {
            members: e.members,
            issueRoots: e.issueRoots,
            childPid: e.childPid,
        });
    }
    const history = createHistory({
        filePath: path.join(dir, HISTORY_FILENAME),
        now: () => '2026-07-18T01:00:00.000Z',
    });
    await history.start();
    return { ledger, history };
}

describe('reconcile -- restart PID probe', () => {
    test('dead child releases BOTH axes in one atomic write and shows aborted-by-restart; live child kept', async () => {
        const dir = await tmpDir();
        const ledgerPath = path.join(dir, LEDGER_FILENAME);
        const { ledger, history } = await seed(dir, [
            { sprintId: 'live', members: ['alice'], issueRoots: ['root-live'], childPid: 111 },
            { sprintId: 'dead', members: ['bob', 'carol'], issueRoots: ['root-dead'], childPid: 222 },
        ]);

        // Count on-disk writes to prove the dead entry is released in exactly
        // ONE atomic ledger write (not a torn two-step half-release).
        let writesToLedger = 0;
        const realWriteFile = fsp.writeFile;
        // The ledger created above uses fsp directly; re-create with an fs shim
        // that counts writes to the ledger temp file.
        const countingLedger = createLedger({
            filePath: ledgerPath,
            now: () => '2026-07-18T00:00:00.000Z',
            fs: {
                mkdir: fsp.mkdir,
                readFile: fsp.readFile,
                rename: fsp.rename,
                async writeFile(p, data, enc) {
                    writesToLedger += 1;
                    return realWriteFile(p, data, enc);
                },
            },
        });
        await countingLedger.start();

        const reconciler = createReconciler({
            ledger: countingLedger,
            history,
            isPidAlive: (pid) => pid === 111, // 111 alive, 222 dead
            now: () => '2026-07-18T01:00:00.000Z',
        });

        const result = await reconciler.reconcile();
        assert.deepEqual(result.released, ['dead']);
        assert.deepEqual(result.retained, ['live']);

        // Exactly one ledger write for the single dead release.
        assert.equal(writesToLedger, 1);

        // Dead sprint: BOTH axes gone from the ledger.
        assert.equal(countingLedger.get('dead'), undefined);
        // Live sprint: both axes retained.
        const stillLive = countingLedger.get('live');
        assert.deepEqual(stillLive.members, ['alice']);
        assert.deepEqual(stillLive.issueRoots, ['root-live']);

        // History marks the dead sprint aborted-by-restart with both axes recorded.
        const ev = history.latestFor('dead');
        assert.equal(ev.event, HISTORY_EVENTS.ABORTED_BY_RESTART);
        assert.deepEqual(ev.members, ['bob', 'carol']);
        assert.deepEqual(ev.issueRoots, ['root-dead']);
        // The live sprint has no terminal history event.
        assert.equal(history.latestFor('live'), undefined);

        // On-disk ledger reloads with only the live reservation.
        const reloaded = createLedger({ filePath: ledgerPath });
        await reloaded.start();
        assert.equal(reloaded.get('dead'), undefined);
        assert.ok(reloaded.get('live'));

        await fsp.rm(dir, { recursive: true, force: true });
    });

    test('an entry with no recorded childPid is treated as not-alive and released', async () => {
        const dir = await tmpDir();
        const { ledger, history } = await seed(dir, [
            { sprintId: 'orphan', members: ['x'], issueRoots: ['r'], childPid: null },
        ]);
        const reconciler = createReconciler({
            ledger,
            history,
            isPidAlive: () => { throw new Error('should not probe a null pid'); },
        });
        const result = await reconciler.reconcile();
        assert.deepEqual(result.released, ['orphan']);
        assert.equal(ledger.get('orphan'), undefined);
        assert.equal(history.latestFor('orphan').event, HISTORY_EVENTS.ABORTED_BY_RESTART);
        await fsp.rm(dir, { recursive: true, force: true });
    });
});

describe('reconcile -- force-release', () => {
    test('force-release frees both axes and records an audit reason', async () => {
        const dir = await tmpDir();
        const { ledger, history } = await seed(dir, [
            { sprintId: 'wedged', members: ['m1', 'm2'], issueRoots: ['root-w'], childPid: 999 },
        ]);
        const reconciler = createReconciler({ ledger, history, now: () => '2026-07-18T02:00:00.000Z' });

        const audit = await reconciler.forceRelease('wedged', { by: 'akhil', reason: 'stuck child' });
        assert.equal(audit.event, HISTORY_EVENTS.FORCE_RELEASED);
        assert.equal(audit.by, 'akhil');
        assert.equal(audit.reason, 'stuck child');

        // Both axes gone.
        assert.equal(ledger.get('wedged'), undefined);
        // Audit recorded in history with both axes.
        const ev = history.latestFor('wedged');
        assert.deepEqual(ev.members, ['m1', 'm2']);
        assert.deepEqual(ev.issueRoots, ['root-w']);
        assert.equal(ev.reason, 'stuck child');

        await fsp.rm(dir, { recursive: true, force: true });
    });

    test('force-releasing an unknown sprint id throws SprintNotFoundError', async () => {
        const dir = await tmpDir();
        const { ledger, history } = await seed(dir, []);
        const reconciler = createReconciler({ ledger, history });
        await assert.rejects(
            () => reconciler.forceRelease('nope'),
            (err) => err instanceof SprintNotFoundError && err.code === 'SPRINT_NOT_FOUND',
        );
        await fsp.rm(dir, { recursive: true, force: true });
    });
});

describe('reconcile -- apra-fleet-3i3.1 force-release also kills the live child', () => {
    test('an injected killPid is invoked with the reservation childPid, and its result is returned', async () => {
        const dir = await tmpDir();
        const { ledger, history } = await seed(dir, [
            { sprintId: 'wedged', members: ['m1'], issueRoots: ['root-w'], childPid: 777 },
        ]);
        const killedPids = [];
        const reconciler = createReconciler({
            ledger, history,
            killPid: (pid) => { killedPids.push(pid); return true; },
        });

        const result = await reconciler.forceRelease('wedged', { reason: 'operator stop' });
        assert.deepEqual(killedPids, [777]);
        assert.equal(result.childPid, 777);
        assert.equal(result.killed, true);
        // Reservation still released exactly as before.
        assert.equal(ledger.get('wedged'), undefined);

        await fsp.rm(dir, { recursive: true, force: true });
    });

    test('no recorded childPid: killPid is never called, and `killed` is null (nothing to kill)', async () => {
        const dir = await tmpDir();
        const { ledger, history } = await seed(dir, [
            { sprintId: 'no-pid', members: ['m1'], issueRoots: ['root-n'], childPid: null },
        ]);
        let called = false;
        const reconciler = createReconciler({ ledger, history, killPid: () => { called = true; return true; } });

        const result = await reconciler.forceRelease('no-pid');
        assert.equal(called, false);
        assert.equal(result.childPid, null);
        assert.equal(result.killed, null);

        await fsp.rm(dir, { recursive: true, force: true });
    });

    test('with NO killPid injected, force-release still releases the reservation and never sends a real signal (safe default)', async () => {
        const dir = await tmpDir();
        const { ledger, history } = await seed(dir, [
            // A deliberately low/system-adjacent pid to prove the default
            // NEVER attempts a real process.kill -- this must stay safe even
            // if such a pid happens to be alive on the test host.
            { sprintId: 'low-pid', members: ['m1'], issueRoots: ['root-l'], childPid: 5 },
        ]);
        const reconciler = createReconciler({ ledger, history });

        const result = await reconciler.forceRelease('low-pid');
        assert.equal(result.childPid, 5);
        assert.equal(result.killed, false); // safe no-op default: never actually kills
        assert.equal(ledger.get('low-pid'), undefined);

        await fsp.rm(dir, { recursive: true, force: true });
    });

    test('a kill failure never blocks the reservation release', async () => {
        const dir = await tmpDir();
        const { ledger, history } = await seed(dir, [
            { sprintId: 'unkillable', members: ['m1'], issueRoots: ['root-u'], childPid: 888 },
        ]);
        const reconciler = createReconciler({ ledger, history, killPid: () => false });

        const result = await reconciler.forceRelease('unkillable');
        assert.equal(result.killed, false);
        assert.equal(ledger.get('unkillable'), undefined);

        await fsp.rm(dir, { recursive: true, force: true });
    });
});

describe('reconcile -- killPid() real implementation', () => {
    // process.kill is stubbed in every case below -- this suite must NEVER
    // send a real signal to a real pid, deterministic-existence assumptions
    // about high/reserved pid numbers are exactly the kind of test-host-
    // dependent flakiness (or worse, an actual kill of an unrelated process)
    // this module's whole safe-default design (see reconcile.mjs's module
    // doc) exists to avoid.
    test('a successful signal delivery returns true', () => {
        const realKill = process.kill;
        let calledWith = null;
        process.kill = (pid, signal) => { calledWith = { pid, signal }; };
        try {
            assert.equal(killPid(4242), true);
            assert.deepEqual(calledWith, { pid: 4242, signal: 'SIGKILL' });
        } finally {
            process.kill = realKill;
        }
    });

    test('ESRCH (already gone) is treated as a successful kill', () => {
        const realKill = process.kill;
        process.kill = () => { const err = new Error('no such process'); err.code = 'ESRCH'; throw err; };
        try {
            assert.equal(killPid(4242), true);
        } finally {
            process.kill = realKill;
        }
    });

    test('a non-ESRCH failure (e.g. EPERM) returns false, never throws', () => {
        const realKill = process.kill;
        process.kill = () => { const err = new Error('not permitted'); err.code = 'EPERM'; throw err; };
        try {
            assert.equal(killPid(4242), false);
        } finally {
            process.kill = realKill;
        }
    });

    test('an invalid pid returns false without calling process.kill at all', () => {
        const realKill = process.kill;
        let called = false;
        process.kill = () => { called = true; };
        try {
            assert.equal(killPid(0), false);
            assert.equal(killPid(-1), false);
            assert.equal(killPid(1.5), false);
            assert.equal(called, false);
        } finally {
            process.kill = realKill;
        }
    });
});

// -- HTTP route wiring ------------------------------------------------------

/** Minimal mock req/res for driving supervisor.handleRequest directly. */
function mockReq(method, url, body) {
    const chunks = body !== undefined ? [Buffer.from(JSON.stringify(body))] : [];
    return {
        method,
        url,
        on(event, cb) {
            if (event === 'data') { for (const c of chunks) cb(c); }
            if (event === 'end') { cb(); }
            return this;
        },
    };
}
function mockRes() {
    return {
        statusCode: undefined,
        headers: undefined,
        body: undefined,
        headersSent: false,
        writeHead(status, headers) { this.statusCode = status; this.headers = headers; this.headersSent = true; },
        end(body) { this.body = body; },
    };
}

describe('reconcile -- POST /api/reservations/:sprintId/force-release route', () => {
    test('known sprint id: 200 and reservation is released', async () => {
        const dir = await tmpDir();
        const { ledger, history } = await seed(dir, [
            { sprintId: 'sprint-x', members: ['a'], issueRoots: ['r'], childPid: 5 },
        ]);
        const reconciler = createReconciler({ ledger, history });
        const supervisor = createSupervisor({ port: 0 });
        registerReservationRoutes(supervisor, reconciler);

        const res = mockRes();
        await supervisor.handleRequest(
            mockReq('POST', '/api/reservations/sprint-x/force-release', { by: 'op', reason: 'manual' }),
            res,
        );
        assert.equal(res.statusCode, 200);
        const payload = JSON.parse(res.body);
        assert.equal(payload.status, 'force-released');
        assert.equal(payload.sprintId, 'sprint-x');
        assert.equal(ledger.get('sprint-x'), undefined);

        await fsp.rm(dir, { recursive: true, force: true });
    });

    test('unknown sprint id: 404', async () => {
        const dir = await tmpDir();
        const { ledger, history } = await seed(dir, []);
        const reconciler = createReconciler({ ledger, history });
        const supervisor = createSupervisor({ port: 0 });
        registerReservationRoutes(supervisor, reconciler);

        const res = mockRes();
        await supervisor.handleRequest(
            mockReq('POST', '/api/reservations/ghost/force-release', {}),
            res,
        );
        assert.equal(res.statusCode, 404);

        await fsp.rm(dir, { recursive: true, force: true });
    });

    test('the :sprintId param does not shadow exact routes (health still works)', async () => {
        const dir = await tmpDir();
        const { ledger, history } = await seed(dir, []);
        const reconciler = createReconciler({ ledger, history });
        const supervisor = createSupervisor({ port: 0 });
        registerReservationRoutes(supervisor, reconciler);

        const res = mockRes();
        await supervisor.handleRequest(mockReq('GET', '/api/health'), res);
        assert.equal(res.statusCode, 200);
        assert.equal(JSON.parse(res.body).status, 'ok');

        await fsp.rm(dir, { recursive: true, force: true });
    });
});
