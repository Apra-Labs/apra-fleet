import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
    createIdAllocator,
    registerIdAllocatorRoutes,
    nullChildIdAllocatorClient,
    ID_ALLOCATOR_VERSION,
    ID_ALLOCATOR_FILENAME,
} from '../src/supervisor/id-allocator.mjs';
import { createSupervisor, readJsonBody, sendJson } from '../src/supervisor/server.mjs';

// =============================================================================
// apra-fleet-eft.9.3 -- globally-coordinated child-id allocator for shared-parent
// bead creation.
//
// Acceptance criteria proved here:
//   1. C.4 concurrent same-parent creation produces ZERO id collisions.
//   2. Allocation is sequential per parent...
//   3. ...and concurrent across different parents (independent sequences, not
//      one global lock for everything).
//   4. Allocator state survives supervisor restart (persisted high-water marks).
//   5. A child that dies mid-allocation leaks no id and reserves no permanent
//      gap that breaks later allocation.
//   6. The allocator lives in the supervisor (registered as supervisor routes;
//      one authority mints ids for independent HTTP acquirers).
// =============================================================================

/** A controllable logical clock so lease-expiry tests are deterministic. */
function fakeClock(start = 1_000) {
    let t = start;
    return { now: () => t, advance: (ms) => { t += ms; } };
}

let dir;
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'id-alloc-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

/** Parse the trailing `.N` seq off a `parent.N` child id. */
function seqOf(childId, parentId) {
    return Number(childId.slice(`${parentId}.`.length));
}

describe('id-allocator -- zero collisions under concurrent same-parent creation (C.4)', () => {
    test('50 concurrent allocate() under one parent yield 50 distinct sequential ids', async () => {
        const alloc = createIdAllocator({ dataDir: dir, leaseMs: 100_000 });
        await alloc.start();

        const parent = 'apra-fleet-eft.9';
        const grants = await Promise.all(
            Array.from({ length: 50 }, () => alloc.allocate(parent, { pid: process.pid })),
        );
        const ids = grants.map((g) => g.childId);
        const unique = new Set(ids);
        assert.equal(unique.size, 50, 'every allocated child id must be distinct (no collisions)');

        // Sequential per parent: seqs are exactly 1..50 with no gaps/dupes.
        const seqs = grants.map((g) => seqOf(g.childId, parent)).sort((a, b) => a - b);
        assert.deepEqual(seqs, Array.from({ length: 50 }, (_, i) => i + 1));
        for (const id of ids) assert.ok(id.startsWith(`${parent}.`), `${id} must be parented under ${parent}`);

        await alloc.stop();
    });
});

describe('id-allocator -- concurrent across different parents (no global lock)', () => {
    test('two parents allocate independent, per-parent sequential ids in parallel', async () => {
        const alloc = createIdAllocator({ dataDir: dir, leaseMs: 100_000 });
        await alloc.start();

        const A = 'parent-A';
        const B = 'parent-B';
        // Interleave allocations across both parents concurrently.
        const jobs = [];
        for (let i = 0; i < 20; i += 1) {
            jobs.push(alloc.allocate(A, { pid: process.pid }));
            jobs.push(alloc.allocate(B, { pid: process.pid }));
        }
        const grants = await Promise.all(jobs);

        const aSeqs = grants.filter((g) => g.parentId === A).map((g) => g.seq).sort((x, y) => x - y);
        const bSeqs = grants.filter((g) => g.parentId === B).map((g) => g.seq).sort((x, y) => x - y);
        // Each parent gets its OWN contiguous 1..20 -- they do not share a counter.
        assert.deepEqual(aSeqs, Array.from({ length: 20 }, (_, i) => i + 1));
        assert.deepEqual(bSeqs, Array.from({ length: 20 }, (_, i) => i + 1));

        await alloc.stop();
    });
});

describe('id-allocator -- state survives supervisor restart', () => {
    test('a restarted allocator reloads high-water and never re-mints an id', async () => {
        const first = createIdAllocator({ dataDir: dir, leaseMs: 100_000 });
        await first.start();
        const parent = 'apra-fleet-eft.9';
        const g1 = await first.allocate(parent, { pid: process.pid });
        await first.confirm(g1.token);
        const g2 = await first.allocate(parent, { pid: process.pid });
        await first.confirm(g2.token);
        assert.equal(seqOf(g1.childId, parent), 1);
        assert.equal(seqOf(g2.childId, parent), 2);
        await first.stop();

        // Persisted file has the expected shape/version.
        const raw = JSON.parse(await readFile(path.join(dir, ID_ALLOCATOR_FILENAME), 'utf-8'));
        assert.equal(raw.version, ID_ALLOCATOR_VERSION);
        assert.equal(raw.parents[parent].highWater, 2);

        // A fresh allocator (simulating a restarted supervisor) reloads and
        // continues ABOVE the high-water -- never re-minting .1 or .2.
        const second = createIdAllocator({ dataDir: dir, leaseMs: 100_000 });
        await second.start();
        const g3 = await second.allocate(parent, { pid: process.pid });
        assert.equal(seqOf(g3.childId, parent), 3, 'restart must continue above the persisted high-water');
        await second.stop();
    });
});

describe('id-allocator -- a child that dies mid-allocation leaks no permanent gap', () => {
    test('an abandoned (unconfirmed, dead-pid) reservation is reclaimed and reused', async () => {
        const clock = fakeClock();
        // pid 1 is "alive"; the crashed child pid 999999 is dead.
        const alive = new Set([process.pid]);
        const alloc = createIdAllocator({
            dataDir: dir,
            leaseMs: 10_000,
            now: clock.now,
            isPidAlive: (pid) => alive.has(pid),
        });
        await alloc.start();

        const parent = 'apra-fleet-eft.9';
        // A healthy child confirms .1.
        const g1 = await alloc.allocate(parent, { pid: process.pid });
        await alloc.confirm(g1.token);
        // A child grabs .2 then DIES mid-allocation (never confirms; pid dead).
        const dead = await alloc.allocate(parent, { pid: 999_999 });
        assert.equal(seqOf(dead.childId, parent), 2);

        // Its pid is dead -> the next allocate reclaims and REUSES seq 2 rather
        // than skipping it (no permanent gap) and without colliding with .1.
        const g3 = await alloc.allocate(parent, { pid: process.pid });
        assert.equal(seqOf(g3.childId, parent), 2, 'reclaimed hole must be reused, not permanently skipped');

        await alloc.stop();
    });

    test('lease expiry reclaims a silently-abandoned reservation (no pid probe)', async () => {
        const clock = fakeClock();
        const alloc = createIdAllocator({ dataDir: dir, leaseMs: 10_000, now: clock.now });
        await alloc.start();
        const parent = 'p';
        const abandoned = await alloc.allocate(parent, { pid: null }); // pid opt-out
        assert.equal(abandoned.seq, 1);
        clock.advance(10_001); // lease elapses
        const reused = await alloc.allocate(parent, { pid: null });
        assert.equal(reused.seq, 1, 'expired reservation seq must be reclaimed and reused');
        await alloc.stop();
    });

    test('explicit release() returns a reserved seq to the pool', async () => {
        const alloc = createIdAllocator({ dataDir: dir, leaseMs: 100_000 });
        await alloc.start();
        const parent = 'p';
        const g1 = await alloc.allocate(parent, { pid: process.pid });
        assert.equal(await alloc.release(g1.token), true);
        // A confirmed id is NOT released; an unknown token is a no-op.
        assert.equal(await alloc.release('nope'), false);
        const g2 = await alloc.allocate(parent, { pid: process.pid });
        assert.equal(g2.seq, 1, 'released seq must be reused');
        await alloc.stop();
    });
});

describe('id-allocator -- floor seeds above pre-existing children', () => {
    test('first allocation respects the floor (existing child count)', async () => {
        const alloc = createIdAllocator({ dataDir: dir, leaseMs: 100_000 });
        await alloc.start();
        const parent = 'apra-fleet-eft.9';
        // Parent already has .1.2.3 from before the allocator existed.
        const g = await alloc.allocate(parent, { pid: process.pid, floor: 3 });
        assert.equal(seqOf(g.childId, parent), 4, 'must mint above the pre-existing floor');
        await alloc.stop();
    });
});

describe('id-allocator -- lives in the supervisor (end-to-end over HTTP routes)', () => {
    test('two independent HTTP clients under one parent get distinct ids', async () => {
        const alloc = createIdAllocator({ dataDir: dir, leaseMs: 100_000 });
        await alloc.start();
        const supervisor = createSupervisor({ idAllocator: alloc });
        registerIdAllocatorRoutes(supervisor, alloc, { readJsonBody, sendJson });
        await supervisor.start();
        const { port } = supervisor;
        const base = `http://127.0.0.1:${port}`;

        async function allocateOverHttp(parentId) {
            const res = await fetch(`${base}/api/child-id-allocator/${encodeURIComponent(parentId)}/allocate`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ pid: process.pid, sprintId: 'sprint-x' }),
            });
            assert.equal(res.status, 200);
            return res.json();
        }

        const parent = 'apra-fleet-eft.9';
        // Two "sprints" hit the shared supervisor concurrently.
        const [a, b] = await Promise.all([allocateOverHttp(parent), allocateOverHttp(parent)]);
        assert.notEqual(a.childId, b.childId, 'two HTTP acquirers must never get the same child id');
        assert.deepEqual([a.seq, b.seq].sort((x, y) => x - y), [1, 2]);

        // Confirm one, release the other -> released seq is reused.
        const cRes = await fetch(`${base}/api/child-id-allocator/confirm`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: a.token }),
        });
        assert.deepEqual(await cRes.json(), { confirmed: true });
        const rRes = await fetch(`${base}/api/child-id-allocator/release`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: b.token }),
        });
        assert.deepEqual(await rRes.json(), { released: true });

        const c = await allocateOverHttp(parent);
        assert.equal(c.seq, b.seq, 'the released seq must be reused by the next allocation');

        // Status snapshot is reachable.
        const statusRes = await fetch(`${base}/api/child-id-allocator`);
        const status = await statusRes.json();
        assert.ok(status.parents[parent], 'status snapshot exposes the parent state');

        await supervisor.stop('test done');
    });
});

describe('id-allocator -- null client keeps create call sites uniform', () => {
    test('nullChildIdAllocatorClient returns childId null and no-op confirm/release', async () => {
        const client = nullChildIdAllocatorClient();
        const g = await client.allocate('p', { pid: process.pid });
        assert.equal(g.childId, null, 'null client signals "let bd derive the id"');
        assert.equal(await client.confirm(g.token), true);
        assert.equal(await client.release(g.token), true);
    });
});
