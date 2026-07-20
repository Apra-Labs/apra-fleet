import { test, describe } from 'node:test';
import assert from 'node:assert';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
    createLedger,
    LEDGER_VERSION,
    LEDGER_SCHEMA,
    LEDGER_FILENAME,
    emptyLedgerDocument,
} from '../src/supervisor/ledger.mjs';

// apra-fleet-eft.5.1 -- combined member + issue-scope reservation ledger:
// lockstep both-axis claim/release, atomic disk persistence, exact reload.

async function tmpDir() {
    return fsp.mkdtemp(path.join(os.tmpdir(), 'eft-ledger-'));
}

describe('ledger -- lockstep claim/release + atomic persistence', () => {
    test('claim() writes both axes and persists an atomic file that reloads exactly', async () => {
        const dir = await tmpDir();
        const filePath = path.join(dir, LEDGER_FILENAME);
        const ledger = createLedger({ filePath, now: () => '2026-07-18T00:00:00.000Z' });
        await ledger.start();

        const r = await ledger.claim('sprint-a', {
            members: ['alice', 'bob', 'alice'], // deduped
            issueRoots: ['apra-fleet-x'],
            childPid: 4321,
        });
        assert.deepEqual(r.members, ['alice', 'bob']);
        assert.deepEqual(r.issueRoots, ['apra-fleet-x']);
        assert.equal(r.childPid, 4321);
        assert.equal(r.reservedAt, '2026-07-18T00:00:00.000Z');

        // On-disk document is well-formed and matches the schema shape.
        const onDisk = JSON.parse(await fsp.readFile(filePath, 'utf-8'));
        assert.equal(onDisk.version, LEDGER_VERSION);
        assert.deepEqual(onDisk.reservations['sprint-a'].members, ['alice', 'bob']);
        assert.deepEqual(onDisk.reservations['sprint-a'].issueRoots, ['apra-fleet-x']);

        // A fresh ledger reloads EXACTLY from disk (restart fidelity).
        const reloaded = createLedger({ filePath });
        await reloaded.start();
        assert.deepEqual(reloaded.get('sprint-a'), {
            members: ['alice', 'bob'],
            issueRoots: ['apra-fleet-x'],
            childPid: 4321,
            reservedAt: '2026-07-18T00:00:00.000Z',
        });

        await fsp.rm(dir, { recursive: true, force: true });
    });

    test('claim() writes both axes or NEITHER under an injected mid-write failure', async () => {
        const dir = await tmpDir();
        const filePath = path.join(dir, LEDGER_FILENAME);
        let failNext = false;
        const fs = {
            mkdir: fsp.mkdir,
            readFile: fsp.readFile,
            rename: fsp.rename,
            async writeFile(p, data, enc) {
                if (failNext) throw new Error('injected mid-write failure');
                return fsp.writeFile(p, data, enc);
            },
        };
        const ledger = createLedger({ filePath, fs });
        await ledger.start();

        failNext = true;
        await assert.rejects(
            () => ledger.claim('sprint-a', { members: ['alice'], issueRoots: ['apra-fleet-x'] }),
            /injected mid-write failure/,
        );

        // Neither axis was committed in memory -- not a half-claim.
        assert.equal(ledger.get('sprint-a'), undefined);
        assert.equal(ledger.size, 0);
        // No committed file was produced (the rename never happened).
        await assert.rejects(() => fsp.readFile(filePath, 'utf-8'), /ENOENT/);

        // Recovery: a subsequent successful claim works and persists both axes.
        failNext = false;
        await ledger.claim('sprint-a', { members: ['alice'], issueRoots: ['apra-fleet-x'] });
        const reloaded = createLedger({ filePath });
        await reloaded.start();
        assert.deepEqual(reloaded.get('sprint-a').members, ['alice']);
        assert.deepEqual(reloaded.get('sprint-a').issueRoots, ['apra-fleet-x']);

        await fsp.rm(dir, { recursive: true, force: true });
    });

    test('release() clears BOTH axes atomically and reloads empty', async () => {
        const dir = await tmpDir();
        const filePath = path.join(dir, LEDGER_FILENAME);
        const ledger = createLedger({ filePath });
        await ledger.start();

        await ledger.claim('sprint-a', { members: ['alice'], issueRoots: ['apra-fleet-x'], childPid: 11 });
        assert.equal(await ledger.release('sprint-a'), true);
        assert.equal(ledger.get('sprint-a'), undefined);
        assert.equal(ledger.size, 0);

        // Idempotent: releasing again is a no-op.
        assert.equal(await ledger.release('sprint-a'), false);

        const reloaded = createLedger({ filePath });
        await reloaded.start();
        assert.equal(reloaded.get('sprint-a'), undefined);
        assert.equal(reloaded.size, 0);

        await fsp.rm(dir, { recursive: true, force: true });
    });

    test('atomic write leaves no torn file observable by a concurrent reader', async () => {
        const dir = await tmpDir();
        const filePath = path.join(dir, LEDGER_FILENAME);
        const ledger = createLedger({ filePath });
        await ledger.start();
        await ledger.claim('sprint-a', { members: ['alice'], issueRoots: ['apra-fleet-x'] });

        // Fire many overlapping writes; concurrently read the committed file.
        const writes = [];
        for (let i = 0; i < 25; i++) {
            writes.push(ledger.claim(`sprint-${i}`, { members: [`m${i}`], issueRoots: [`root-${i}`] }));
        }
        const reads = [];
        for (let i = 0; i < 25; i++) {
            reads.push((async () => {
                const raw = await fsp.readFile(filePath, 'utf-8');
                // Every observed file must parse -- never a partial document.
                const doc = JSON.parse(raw);
                assert.equal(doc.version, LEDGER_VERSION);
            })());
        }
        await Promise.all([...writes, ...reads]);
        assert.equal(ledger.size, 26);

        await fsp.rm(dir, { recursive: true, force: true });
    });

    test('setChildPid updates only that reservation, both axes preserved', async () => {
        const dir = await tmpDir();
        const filePath = path.join(dir, LEDGER_FILENAME);
        const ledger = createLedger({ filePath });
        await ledger.start();
        await ledger.claim('sprint-a', { members: ['alice'], issueRoots: ['apra-fleet-x'] });
        const updated = await ledger.setChildPid('sprint-a', 9999);
        assert.equal(updated.childPid, 9999);
        assert.deepEqual(updated.members, ['alice']);
        assert.deepEqual(updated.issueRoots, ['apra-fleet-x']);

        const reloaded = createLedger({ filePath });
        await reloaded.start();
        assert.equal(reloaded.get('sprint-a').childPid, 9999);

        await fsp.rm(dir, { recursive: true, force: true });
    });

    test('double-claim of a live sprint is rejected; list()/get() return clones', async () => {
        const dir = await tmpDir();
        const filePath = path.join(dir, LEDGER_FILENAME);
        const ledger = createLedger({ filePath });
        await ledger.start();
        await ledger.claim('sprint-a', { members: ['alice'], issueRoots: ['apra-fleet-x'] });
        await assert.rejects(() => ledger.claim('sprint-a', { members: ['x'], issueRoots: ['y'] }), /already holds a reservation/);

        // Mutating a returned clone must not corrupt internal state.
        const got = ledger.get('sprint-a');
        got.members.push('mallory');
        assert.deepEqual(ledger.get('sprint-a').members, ['alice']);

        const listed = ledger.list();
        assert.equal(listed.length, 1);
        assert.equal(listed[0].sprintId, 'sprint-a');
        listed[0].issueRoots.push('injected');
        assert.deepEqual(ledger.get('sprint-a').issueRoots, ['apra-fleet-x']);

        await fsp.rm(dir, { recursive: true, force: true });
    });

    test('load() rejects a corrupt or wrong-version file', async () => {
        const dir = await tmpDir();
        const filePath = path.join(dir, LEDGER_FILENAME);
        await fsp.writeFile(filePath, '{ not json', 'utf-8');
        await assert.rejects(() => createLedger({ filePath }).start(), /not valid JSON/);

        await fsp.writeFile(filePath, JSON.stringify({ version: 99, reservations: {} }), 'utf-8');
        await assert.rejects(() => createLedger({ filePath }).start(), /unexpected shape or version/);

        await fsp.rm(dir, { recursive: true, force: true });
    });

    test('missing file starts as an empty ledger', async () => {
        const dir = await tmpDir();
        const filePath = path.join(dir, 'does-not-exist.json');
        const ledger = createLedger({ filePath });
        await ledger.start();
        assert.equal(ledger.size, 0);
        assert.deepEqual(ledger.toDocument(), emptyLedgerDocument());
        await fsp.rm(dir, { recursive: true, force: true });
    });
});

describe('ledger -- apra-fleet-eft.5.5 scope-freshness indicator', () => {
    test('never-synced ledger reports lastSyncedAt=null and the literal never-synced marker (never silently absent)', async () => {
        const dir = await tmpDir();
        const ledger = createLedger({ filePath: path.join(dir, LEDGER_FILENAME) });
        await ledger.start();
        assert.deepEqual(ledger.getScopeFreshness(), { lastSyncedAt: null, ageSeconds: 'never-synced' });
        await fsp.rm(dir, { recursive: true, force: true });
    });

    test('setScopeFreshness records lastSyncedAt and getScopeFreshness derives ageSeconds from it', async () => {
        const dir = await tmpDir();
        const filePath = path.join(dir, LEDGER_FILENAME);
        const ledger = createLedger({ filePath });
        await ledger.start();

        const result = await ledger.setScopeFreshness('2026-07-19T00:00:00.000Z');
        assert.deepEqual(result, { lastSyncedAt: '2026-07-19T00:00:00.000Z', ageSeconds: 0 });

        // 90s after the recorded sync -> ageSeconds reflects elapsed time.
        const laterMs = new Date('2026-07-19T00:01:30.000Z').getTime();
        assert.deepEqual(
            ledger.getScopeFreshness(() => laterMs),
            { lastSyncedAt: '2026-07-19T00:00:00.000Z', ageSeconds: 90 },
        );
        await fsp.rm(dir, { recursive: true, force: true });
    });

    test('setScopeFreshness defaults to now() when no timestamp is given, and updates on each successful sync', async () => {
        const dir = await tmpDir();
        const filePath = path.join(dir, LEDGER_FILENAME);
        let clock = '2026-07-19T00:00:00.000Z';
        const ledger = createLedger({ filePath, now: () => clock });
        await ledger.start();

        await ledger.setScopeFreshness();
        assert.deepEqual(ledger.getScopeFreshness(() => new Date(clock).getTime()), { lastSyncedAt: clock, ageSeconds: 0 });

        // A second sync moves lastSyncedAt forward -- the value UPDATES after a sync.
        clock = '2026-07-19T00:05:00.000Z';
        await ledger.setScopeFreshness();
        assert.deepEqual(ledger.getScopeFreshness(() => new Date(clock).getTime()), { lastSyncedAt: clock, ageSeconds: 0 });
        await fsp.rm(dir, { recursive: true, force: true });
    });

    test('scopeFreshness.lastSyncedAt persists across a reload (survives restart)', async () => {
        const dir = await tmpDir();
        const filePath = path.join(dir, LEDGER_FILENAME);
        const ledger = createLedger({ filePath });
        await ledger.start();
        await ledger.setScopeFreshness('2026-07-19T00:00:00.000Z');

        const reloaded = createLedger({ filePath });
        await reloaded.start();
        assert.deepEqual(reloaded.getScopeFreshness(() => new Date('2026-07-19T00:00:00.000Z').getTime()), {
            lastSyncedAt: '2026-07-19T00:00:00.000Z',
            ageSeconds: 0,
        });
        await fsp.rm(dir, { recursive: true, force: true });
    });
});

describe('ledger -- exported schema/contract', () => {
    test('LEDGER_SCHEMA and version are stable and frozen', () => {
        assert.equal(LEDGER_VERSION, 1);
        assert.equal(LEDGER_SCHEMA.properties.version.const, LEDGER_VERSION);
        assert.equal(Object.isFrozen(LEDGER_SCHEMA), true);
        assert.deepEqual(emptyLedgerDocument(), { version: 1, reservations: {}, scopeFreshness: { lastSyncedAt: null } });
    });

    test('createLedger seam exposes start/stop lifecycle hooks and a name', () => {
        const ledger = createLedger({ filePath: path.join(os.tmpdir(), 'never-written.json') });
        assert.equal(ledger.name, 'ledger');
        assert.equal(typeof ledger.start, 'function');
        assert.equal(typeof ledger.stop, 'function');
    });
});

describe('ledger -- server reservation client (apra-fleet-eft.10.3)', () => {
    test('claim() reserves every member on the server for the sprint after the local commit', async () => {
        const dir = await tmpDir();
        const filePath = path.join(dir, LEDGER_FILENAME);
        const calls = [];
        const reservationClient = {
            async reserve(memberId, sprintId) { calls.push(['reserve', memberId, sprintId]); },
            async release(memberId, sprintId) { calls.push(['release', memberId, sprintId]); },
        };
        const ledger = createLedger({ filePath, reservationClient });
        await ledger.start();

        await ledger.claim('sprint-a', { members: ['alice', 'bob'], issueRoots: ['apra-fleet-x'] });

        assert.deepEqual(calls, [
            ['reserve', 'alice', 'sprint-a'],
            ['reserve', 'bob', 'sprint-a'],
        ]);
        await fsp.rm(dir, { recursive: true, force: true });
    });

    test('release() releases every held member on the server on a terminal event', async () => {
        const dir = await tmpDir();
        const filePath = path.join(dir, LEDGER_FILENAME);
        const calls = [];
        const reservationClient = {
            async reserve(memberId, sprintId) { calls.push(['reserve', memberId, sprintId]); },
            async release(memberId, sprintId) { calls.push(['release', memberId, sprintId]); },
        };
        const ledger = createLedger({ filePath, reservationClient });
        await ledger.start();

        await ledger.claim('sprint-a', { members: ['alice', 'bob'], issueRoots: ['apra-fleet-x'] });
        calls.length = 0;
        const removed = await ledger.release('sprint-a');

        assert.equal(removed, true);
        assert.deepEqual(calls, [
            ['release', 'alice', 'sprint-a'],
            ['release', 'bob', 'sprint-a'],
        ]);
        await fsp.rm(dir, { recursive: true, force: true });
    });

    test('release() of an unheld sprint drives no server release', async () => {
        const dir = await tmpDir();
        const filePath = path.join(dir, LEDGER_FILENAME);
        const calls = [];
        const reservationClient = {
            async reserve(memberId, sprintId) { calls.push(['reserve', memberId, sprintId]); },
            async release(memberId, sprintId) { calls.push(['release', memberId, sprintId]); },
        };
        const ledger = createLedger({ filePath, reservationClient });
        await ledger.start();

        const removed = await ledger.release('ghost-sprint');

        assert.equal(removed, false);
        assert.deepEqual(calls, []);
        await fsp.rm(dir, { recursive: true, force: true });
    });

    test('a server reservation failure is swallowed and does NOT roll back the local commit', async () => {
        const dir = await tmpDir();
        const filePath = path.join(dir, LEDGER_FILENAME);
        const errors = [];
        const reservationClient = {
            async reserve() { throw new Error('server unreachable'); },
            async release() { throw new Error('server unreachable'); },
        };
        const ledger = createLedger({ filePath, reservationClient, logger: { error: (...a) => errors.push(a) } });
        await ledger.start();

        await ledger.claim('sprint-a', { members: ['alice'], issueRoots: ['apra-fleet-x'] });

        // Local ledger committed despite the server op throwing.
        assert.deepEqual(ledger.get('sprint-a').members, ['alice']);
        assert.equal(errors.length, 1);
        await fsp.rm(dir, { recursive: true, force: true });
    });

    test('no reservationClient injected -> claim/release behave exactly as pure storage', async () => {
        const dir = await tmpDir();
        const filePath = path.join(dir, LEDGER_FILENAME);
        const ledger = createLedger({ filePath });
        await ledger.start();

        await ledger.claim('sprint-a', { members: ['alice'], issueRoots: ['apra-fleet-x'] });
        assert.deepEqual(ledger.get('sprint-a').members, ['alice']);
        assert.equal(await ledger.release('sprint-a'), true);
        assert.equal(ledger.get('sprint-a'), undefined);
        await fsp.rm(dir, { recursive: true, force: true });
    });
});
