import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { doltPushMutex } from '../src/tools/dolt-push-mutex.js';
import { childIdAllocator } from '../src/tools/child-id-allocator.js';
import {
  createDoltMutex,
  createIdAllocator,
  createTicketedMutex,
  resetSprintCoordinationForTest,
} from '../src/services/sprint-coordination.js';

/** Tool handlers return a JSON string -- parse it the way real callers do. */
async function mutexCall(input: any): Promise<any> {
  return JSON.parse(await doltPushMutex(input));
}
async function allocCall(input: any): Promise<any> {
  return JSON.parse(await childIdAllocator(input));
}

function tmpAllocatorFile(): string {
  return path.join(
    os.tmpdir(),
    `apra-fleet-alloc-${process.pid}-${crypto.randomBytes(4).toString('hex')}`,
    'child-id-allocator.json',
  );
}

afterEach(async () => {
  await resetSprintCoordinationForTest();
});

describe('dolt_push_mutex tool', () => {
  it('grants a free mutex immediately and refuses a mismatched release token', async () => {
    const a = await mutexCall({ action: 'acquire', sprint_id: 'sprint-a', wait_ms: 200 });
    expect(a.granted).toBe(true);
    expect(typeof a.token).toBe('string');

    // Token-guarded: a stale/foreign token must never evict the real holder.
    expect(await mutexCall({ action: 'release', token: 'not-the-token' })).toEqual({ released: false });

    const held = await mutexCall({ action: 'status' });
    expect(held.held).toBe(true);
    expect(held.holder.sprintId).toBe('sprint-a');

    expect(await mutexCall({ action: 'release', token: a.token })).toEqual({ released: true });
    expect((await mutexCall({ action: 'status' })).held).toBe(false);
  });

  it('preserves FIFO order across polls -- a polling waiter keeps its queue position', async () => {
    const a = await mutexCall({ action: 'acquire', sprint_id: 'sprint-a', wait_ms: 100 });
    expect(a.granted).toBe(true);

    const b = await mutexCall({ action: 'acquire', sprint_id: 'sprint-b', wait_ms: 20 });
    const c = await mutexCall({ action: 'acquire', sprint_id: 'sprint-c', wait_ms: 20 });
    expect(b.granted).toBe(false);
    expect(c.granted).toBe(false);

    // B polls repeatedly while still waiting. If polling dequeued/re-enqueued
    // it, B would fall behind C and FIFO would be silently broken.
    for (let i = 0; i < 3; i += 1) {
      const poll = await mutexCall({ action: 'poll', ticket: b.ticket, wait_ms: 10 });
      expect(poll.granted).toBe(false);
    }

    const queue = await mutexCall({ action: 'status' });
    expect(queue.waiting.map((w: any) => w.sprintId)).toEqual(['sprint-b', 'sprint-c']);

    await mutexCall({ action: 'release', token: a.token });

    const bGrant = await mutexCall({ action: 'poll', ticket: b.ticket, wait_ms: 200 });
    expect(bGrant.granted).toBe(true);
    const cStill = await mutexCall({ action: 'poll', ticket: c.ticket, wait_ms: 20 });
    expect(cStill.granted).toBe(false);

    await mutexCall({ action: 'release', token: bGrant.token });
    const cGrant = await mutexCall({ action: 'poll', ticket: c.ticket, wait_ms: 200 });
    expect(cGrant.granted).toBe(true);
    await mutexCall({ action: 'release', token: cGrant.token });
  });

  it('renews a held lease and reports an unknown ticket', async () => {
    const a = await mutexCall({ action: 'acquire', sprint_id: 'sprint-a', wait_ms: 100 });
    const renewed = await mutexCall({ action: 'renew', token: a.token });
    expect(renewed.renewed).toBe(true);
    expect(renewed.expiresAt).toBeGreaterThan(Date.now() - 1);
    expect(await mutexCall({ action: 'renew', token: 'bogus' })).toEqual({ renewed: false });

    const unknown = await mutexCall({ action: 'poll', ticket: 'no-such-ticket', wait_ms: 0 });
    expect(unknown).toMatchObject({ granted: false, error: 'unknown ticket' });
    await mutexCall({ action: 'release', token: a.token });
  });

  it('cancel drops a queued waiter and lets the next in line through', async () => {
    const a = await mutexCall({ action: 'acquire', sprint_id: 'sprint-a', wait_ms: 100 });
    const b = await mutexCall({ action: 'acquire', sprint_id: 'sprint-b', wait_ms: 20 });
    const c = await mutexCall({ action: 'acquire', sprint_id: 'sprint-c', wait_ms: 20 });

    expect(await mutexCall({ action: 'cancel', ticket: b.ticket })).toMatchObject({ known: true, cancelled: true });
    await mutexCall({ action: 'release', token: a.token });

    const cGrant = await mutexCall({ action: 'poll', ticket: c.ticket, wait_ms: 200 });
    expect(cGrant.granted).toBe(true);
    await mutexCall({ action: 'release', token: cGrant.token });
  });

  it('validates required arguments per action', async () => {
    expect((await mutexCall({ action: 'acquire' })).error).toMatch(/sprint_id is required/);
    expect((await mutexCall({ action: 'poll' })).error).toMatch(/ticket is required/);
    expect((await mutexCall({ action: 'release' })).error).toMatch(/token is required/);
    expect((await mutexCall({ action: 'renew' })).error).toMatch(/token is required/);
    expect((await mutexCall({ action: 'cancel' })).error).toMatch(/ticket is required/);
  });
});

describe('dolt mutex lease / dead-pid reclaim', () => {
  it('reclaims a holder whose pid is gone and hands the mutex to the next waiter', async () => {
    let alive = true;
    const mutex = createDoltMutex({
      leaseMs: 60_000,
      isPidAlive: () => alive,
      logger: { log: () => {} },
    });
    const ticketed = createTicketedMutex(mutex);

    const a = await ticketed.acquire('sprint-a', { pid: 4242, waitMs: 50 });
    expect(a.granted).toBe(true);

    const b = await ticketed.acquire('sprint-b', { pid: 4243, waitMs: 10 });
    expect(b.granted).toBe(false);

    // A "crashes" without ever releasing -- its waiter never polls again.
    alive = false;
    expect(mutex.reclaimExpired()).toBe(true);

    const bGrant = await ticketed.poll(b.ticket, { waitMs: 50 });
    expect(bGrant.granted).toBe(true);
    mutex.stop();
  });

  it('reclaims a holder whose lease expired', async () => {
    let clock = 1_000;
    const mutex = createDoltMutex({ leaseMs: 100, now: () => clock, logger: { log: () => {} } });
    const ticketed = createTicketedMutex(mutex);

    await ticketed.acquire('sprint-a', { waitMs: 20 });
    const b = await ticketed.acquire('sprint-b', { waitMs: 10 });
    expect(b.granted).toBe(false);

    clock += 1_000;
    expect(mutex.reclaimExpired()).toBe(true);
    expect((await ticketed.poll(b.ticket, { waitMs: 50 })).granted).toBe(true);
    mutex.stop();
  });

  it('drops the reclaimed holder ticket map entry on dead-pid reclaim (no unbounded growth)', async () => {
    let alive = true;
    const mutex = createDoltMutex({
      leaseMs: 60_000,
      isPidAlive: () => alive,
      logger: { log: () => {} },
    });
    const ticketed = createTicketedMutex(mutex);

    const priorSize = ticketed.ticketCount();

    const a = await ticketed.acquire('sprint-a', { pid: 5001, waitMs: 50 });
    expect(a.granted).toBe(true);
    expect(ticketed.ticketCount()).toBe(priorSize + 1);

    // A "crashes" without ever releasing or cancelling its ticket.
    alive = false;
    expect(mutex.reclaimExpired()).toBe(true);

    // The dangling ticket map entry for the reclaimed grant must be dropped,
    // not left to accumulate on the always-on fleet server.
    expect(ticketed.ticketCount()).toBe(priorSize);
    mutex.stop();
  });

  it('drops the reclaimed holder ticket map entry on lease-expiry reclaim (no unbounded growth)', async () => {
    let clock = 1_000;
    const mutex = createDoltMutex({ leaseMs: 100, now: () => clock, logger: { log: () => {} } });
    const ticketed = createTicketedMutex(mutex);

    const priorSize = ticketed.ticketCount();

    const a = await ticketed.acquire('sprint-a', { waitMs: 20 });
    expect(a.granted).toBe(true);
    expect(ticketed.ticketCount()).toBe(priorSize + 1);

    clock += 1_000;
    expect(mutex.reclaimExpired()).toBe(true);

    expect(ticketed.ticketCount()).toBe(priorSize);
    mutex.stop();
  });
});

describe('child_id_allocator tool', () => {
  it('mints distinct sequential ids under one parent and confirms them', async () => {
    const one = await allocCall({ action: 'allocate', parent_id: 'apra-fleet-p', sprint_id: 's1', floor: 0 });
    const two = await allocCall({ action: 'allocate', parent_id: 'apra-fleet-p', sprint_id: 's2', floor: 0 });
    expect(one.childId).toBe('apra-fleet-p.1');
    expect(two.childId).toBe('apra-fleet-p.2');
    expect(one.token).not.toBe(two.token);

    expect(await allocCall({ action: 'confirm', token: one.token })).toEqual({ confirmed: true });
    // Idempotent: a second confirm of the same token is a no-op.
    expect(await allocCall({ action: 'confirm', token: one.token })).toEqual({ confirmed: false });

    const status = await allocCall({ action: 'status' });
    expect(status.parents['apra-fleet-p'].highWater).toBe(2);
  });

  it('honours a floor so a pre-existing child id is never re-minted', async () => {
    const first = await allocCall({ action: 'allocate', parent_id: 'apra-fleet-q', floor: 7 });
    expect(first.childId).toBe('apra-fleet-q.8');
  });

  it('returns a released reservation to the free pool for reuse', async () => {
    const a = await allocCall({ action: 'allocate', parent_id: 'apra-fleet-r' });
    const b = await allocCall({ action: 'allocate', parent_id: 'apra-fleet-r' });
    expect(b.seq).toBe(a.seq + 1);

    expect(await allocCall({ action: 'release', token: a.token })).toEqual({ released: true });
    const reused = await allocCall({ action: 'allocate', parent_id: 'apra-fleet-r' });
    expect(reused.seq).toBe(a.seq);
  });

  it('validates required arguments per action', async () => {
    expect((await allocCall({ action: 'allocate' })).error).toMatch(/parent_id is required/);
    expect((await allocCall({ action: 'confirm' })).error).toMatch(/token is required/);
    expect((await allocCall({ action: 'release' })).error).toMatch(/token is required/);
  });
});

describe('id allocator persistence and reclaim', () => {
  it('reloads high-water marks after a restart so no id is re-minted', async () => {
    const filePath = tmpAllocatorFile();
    try {
      const first = createIdAllocator({ filePath, logger: { log: () => {} } });
      await first.start();
      const a = await first.allocate('parent-x');
      await first.confirm(a.token);
      await first.stop();

      const second = createIdAllocator({ filePath, logger: { log: () => {} } });
      await second.start();
      const b = await second.allocate('parent-x');
      expect(b.seq).toBe(a.seq + 1);
      await second.stop();
    } finally {
      fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
    }
  });

  it('reclaims a reservation whose creator died, and reuses its seq', async () => {
    const filePath = tmpAllocatorFile();
    try {
      let alive = true;
      const allocator = createIdAllocator({ filePath, isPidAlive: () => alive, logger: { log: () => {} } });
      await allocator.start();

      const abandoned = await allocator.allocate('parent-y', { pid: 999_001 });
      alive = false;
      expect(allocator.reclaimExpired()).toBe(1);

      const reused = await allocator.allocate('parent-y');
      expect(reused.seq).toBe(abandoned.seq);
      await allocator.stop();
    } finally {
      fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
    }
  });

  it('assigns distinct seqs to concurrent same-parent allocations', async () => {
    const filePath = tmpAllocatorFile();
    try {
      const allocator = createIdAllocator({ filePath, logger: { log: () => {} } });
      await allocator.start();
      const grants = await Promise.all(
        Array.from({ length: 10 }, () => allocator.allocate('parent-z')),
      );
      const seqs = grants.map((g) => g.seq).sort((a, b) => a - b);
      expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      await allocator.stop();
    } finally {
      fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
    }
  });
});
