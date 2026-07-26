import { test, describe } from 'node:test';
import assert from 'node:assert';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { createLedger, LEDGER_FILENAME } from '../src/supervisor/ledger.mjs';
import { createHistory, HISTORY_FILENAME, HISTORY_EVENTS } from '../src/supervisor/history.mjs';
import { createReconciler } from '../src/supervisor/reconcile.mjs';
import { createSpawner } from '../src/supervisor/spawner.mjs';
import { createReadopter, parseViewerPortFromCmdline } from '../src/supervisor/readopt.mjs';

// apra-fleet-eft.4.5 -- supervisor restart: re-adopt live children by PID from
// the persisted ledger. Pairs with eft.5.4's restart reconciler (dead
// entries release both axes + get marked aborted-by-restart; live entries
// are retained). This module's job is what happens to those RETAINED
// entries: recover their --viewer-port from the live process's own command
// line and register it with the spawner seam so they are tracked/watchdog-
// monitored/HTTP-proxyable exactly like a freshly-spawned child.

async function tmpDir() {
    return fsp.mkdtemp(path.join(os.tmpdir(), 'eft-readopt-'));
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

describe('readopt -- parseViewerPortFromCmdline', () => {
    test('recovers the port from a realistic node cmdline', () => {
        const cmdline = '/usr/bin/node /repo/packages/apra-fleet-se/bin/cli.mjs --issue PROJ-1 --members alice,bob --branch feat/x --base main --viewer-port 8123';
        assert.equal(parseViewerPortFromCmdline(cmdline), 8123);
    });

    test('tolerates an "=" separated flag form', () => {
        assert.equal(parseViewerPortFromCmdline('node cli.mjs --viewer-port=9999'), 9999);
    });

    test('returns null when the flag is absent', () => {
        assert.equal(parseViewerPortFromCmdline('node cli.mjs --issue PROJ-1'), null);
    });

    test('returns null for a malformed/out-of-range port', () => {
        assert.equal(parseViewerPortFromCmdline('node cli.mjs --viewer-port 0'), null);
        assert.equal(parseViewerPortFromCmdline('node cli.mjs --viewer-port 99999'), null);
    });

    test('returns null for non-string / empty input', () => {
        assert.equal(parseViewerPortFromCmdline(null), null);
        assert.equal(parseViewerPortFromCmdline(undefined), null);
        assert.equal(parseViewerPortFromCmdline(''), null);
    });
});

describe('readopt -- createReadopter construction', () => {
    test('throws without a ledger', () => {
        assert.throws(() => createReadopter({
            spawner: { adopt() {} },
            reconciler: { reconcile: async () => ({ released: [], retained: [] }) },
        }), TypeError);
    });

    test('throws without a spawner with adopt()', () => {
        assert.throws(() => createReadopter({
            ledger: { get() {} },
            spawner: {},
            reconciler: { reconcile: async () => ({ released: [], retained: [] }) },
        }), TypeError);
    });

    test('throws without a reconciler with reconcile()', () => {
        assert.throws(() => createReadopter({
            ledger: { get() {} },
            spawner: { adopt() {} },
        }), TypeError);
    });
});

describe('readopt -- restart re-adoption', () => {
    test('live child is re-adopted (port recovered + registered with spawner); dead child released via the reconciler', async () => {
        const dir = await tmpDir();
        const { ledger, history } = await seed(dir, [
            { sprintId: 'live', members: ['alice'], issueRoots: ['root-live'], childPid: 111 },
            { sprintId: 'dead', members: ['bob'], issueRoots: ['root-dead'], childPid: 222 },
        ]);

        const reconciler = createReconciler({
            ledger,
            history,
            isPidAlive: (pid) => pid === 111, // 111 alive, 222 dead
            now: () => '2026-07-18T02:00:00.000Z',
        });

        const spawner = createSpawner(); // real spawner: proves getLiveEntry() actually works post-adopt
        const readopter = createReadopter({
            ledger,
            spawner,
            reconciler,
            readCmdline: (pid) => (pid === 111
                ? '/usr/bin/node cli.mjs --issue PROJ-1 --viewer-port 8321'
                : null), // dead pid: unreachable, would return null anyway
            logger: { log() {}, warn() {} },
        });

        const result = await readopter.readopt();

        assert.deepEqual(result.released, ['dead']);
        assert.deepEqual(result.retained, ['live']);
        assert.deepEqual(result.unresolved, []);
        assert.equal(result.adopted.length, 1);
        assert.deepEqual(result.adopted[0], { sprintId: 'live', childPid: 111, port: 8321 });

        // The spawner now tracks the re-adopted pid exactly like a freshly
        // spawned child -- this is what makes GET /api/sprints' default
        // resolvePort(pid) and the watchdog's HTTP probe work post-restart.
        assert.deepEqual(spawner.getLiveEntry(111), { port: 8321, child: null });
        assert.ok(spawner.livePorts.has(8321));

        // Dead sprint reservation gone, marked aborted-by-restart (eft.5.4 behavior, driven via this module).
        assert.equal(ledger.get('dead'), undefined);
        assert.equal(history.latestFor('dead').event, HISTORY_EVENTS.ABORTED_BY_RESTART);

        // Live sprint reservation untouched.
        const stillLive = ledger.get('live');
        assert.deepEqual(stillLive.members, ['alice']);
        assert.deepEqual(stillLive.issueRoots, ['root-live']);

        await fsp.rm(dir, { recursive: true, force: true });
    });

    test('a live child whose port cannot be recovered is reported unresolved, not adopted, and never throws', async () => {
        const dir = await tmpDir();
        const { ledger, history } = await seed(dir, [
            { sprintId: 'live-no-port', members: ['carol'], issueRoots: ['root-c'], childPid: 333 },
        ]);
        const reconciler = createReconciler({ ledger, history, isPidAlive: () => true });
        const spawner = createSpawner();
        const warnings = [];
        const readopter = createReadopter({
            ledger,
            spawner,
            reconciler,
            readCmdline: () => null, // e.g. no /proc, permission denied, or unreadable
            logger: { log() {}, warn: (...a) => warnings.push(a.join(' ')) },
        });

        const result = await readopter.readopt();
        assert.deepEqual(result.retained, ['live-no-port']);
        assert.deepEqual(result.adopted, []);
        assert.deepEqual(result.unresolved, ['live-no-port']);
        assert.equal(spawner.getLiveEntry(333), undefined);
        assert.ok(warnings.some((w) => w.includes('live-no-port')));

        // The reservation is still retained -- a best-effort port-recovery
        // failure must never drop the ledger entry.
        assert.ok(ledger.get('live-no-port'));

        await fsp.rm(dir, { recursive: true, force: true });
    });

    test('a retained entry with no recorded childPid is reported unresolved (cannot re-adopt without a pid)', async () => {
        const dir = await tmpDir();
        const ledger = createLedger({ filePath: path.join(dir, LEDGER_FILENAME), now: () => '2026-07-18T00:00:00.000Z' });
        await ledger.start();
        const history = createHistory({ filePath: path.join(dir, HISTORY_FILENAME), now: () => '2026-07-18T00:00:00.000Z' });
        await history.start();

        // Fake reconciler that retains a sprint with no childPid (a real
        // reconciler would never retain a null-pid entry -- it treats it as
        // not-alive and releases it -- but this exercises readopt()'s own
        // defensive guard for that shape regardless).
        const reconciler = { reconcile: async () => ({ released: [], retained: ['ghost'] }) };
        await ledger.claim('ghost', { members: ['x'], issueRoots: ['r'], childPid: null });

        const spawner = createSpawner();
        const readopter = createReadopter({ ledger, spawner, reconciler, logger: { log() {}, warn() {} } });

        const result = await readopter.readopt();
        assert.deepEqual(result.adopted, []);
        assert.deepEqual(result.unresolved, ['ghost']);

        await fsp.rm(dir, { recursive: true, force: true });
    });

    test('no live entries: reconciler releases everything, readopt is a clean no-op', async () => {
        const dir = await tmpDir();
        const { ledger, history } = await seed(dir, [
            { sprintId: 'dead-only', members: ['x'], issueRoots: ['r'], childPid: 999 },
        ]);
        const reconciler = createReconciler({ ledger, history, isPidAlive: () => false });
        const spawner = createSpawner();
        const readopter = createReadopter({ ledger, spawner, reconciler, logger: { log() {}, warn() {} } });

        const result = await readopter.readopt();
        assert.deepEqual(result.released, ['dead-only']);
        assert.deepEqual(result.retained, []);
        assert.deepEqual(result.adopted, []);
        assert.deepEqual(result.unresolved, []);

        await fsp.rm(dir, { recursive: true, force: true });
    });
});
