/**
 * At-least-once relay proof (apra-fleet-us9.4) that runs unconditionally in
 * any environment (no Docker daemon required): pg-mem is a real SQL engine
 * (not a mock of our code) that executes the ACTUAL migration file and the
 * ACTUAL relay-queue.ts queries unmodified -- this exercises the real SQL
 * logic (idempotent ON CONFLICT, the FIFO/redeliver-until-acked UPDATE...
 * RETURNING, the TTL interval comparison), not a hand-rolled JS stand-in of
 * that logic. See relay-queue.docker.test.ts for the same proof against a
 * real networked Postgres, opportunistic wherever Docker is actually
 * running.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import fs from 'node:fs';
import path from 'node:path';
import { setPool, closePool } from '../../src/hub-service/db/pool.js';
import { enqueue, fetchDeliverable, ack, sweepExpired, sweepExpiredToFailures, MAX_QUEUE_DEPTH } from '../../src/hub-service/relay-queue.js';

let pool: any;

async function freshPool() {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  db.public.registerFunction({
    name: 'now',
    returns: 'timestamptz' as any,
    implementation: () => new Date(),
  });
  const { Pool } = db.adapters.createPg();
  const p = new Pool();
  const migrationsDir = path.join(process.cwd(), 'db', 'migrations');
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const rawSql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    // pg-mem compatibility shim ONLY: it doesn't parse UNLOGGED (a real-Postgres
    // performance-only modifier with no semantic effect on query results). The
    // real migration file is untouched -- this strips the keyword from the SQL
    // text in-memory for this test harness alone.
    const sql = rawSql.replace(/CREATE UNLOGGED TABLE/gi, 'CREATE TABLE');
    await p.query(sql);
  }
  return p;
}

describe('relay-queue: at-least-once delivery (pg-mem, real SQL engine, no Docker required)', () => {
  beforeEach(async () => {
    pool = await freshPool();
    setPool(pool);
    await pool.query(`INSERT INTO workspaces (id, name) VALUES ('ws-test', 'test')`);
  });

  afterEach(async () => {
    await closePool();
  });

  it('a briefly-offline target does not lose a queued envelope, and receives it on reconnect', async () => {
    await enqueue('ws-test', 'member-a', 'env-1', 'execute_command', { cmd: 'echo hi' }, 60_000, pool);

    const delivered = await fetchDeliverable('ws-test', 'member-a', pool);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].envelope_id).toBe('env-1');
    expect(delivered[0].status).toBe('delivered');
  });

  it('does NOT re-serve an already-delivered-but-unacked envelope before ack_timeout_ms elapses (apra-fleet-b55: redeliver-on-timeout, not redeliver-on-every-poll)', async () => {
    await enqueue('ws-test', 'member-b', 'env-2', 'execute_command', { cmd: 'echo redeliver' }, 60_000, pool);

    const firstFetch = await fetchDeliverable('ws-test', 'member-b', pool);
    expect(firstFetch).toHaveLength(1);

    const immediateRefetch = await fetchDeliverable('ws-test', 'member-b', pool);
    expect(immediateRefetch).toHaveLength(0);
  });

  it('redelivers an already-delivered-but-unacked envelope once ack_timeout_ms has elapsed (no silent loss before ack)', async () => {
    await enqueue('ws-test', 'member-b', 'env-2', 'execute_command', { cmd: 'echo redeliver' }, 60_000, pool);

    const firstFetch = await fetchDeliverable('ws-test', 'member-b', pool, 1);
    expect(firstFetch).toHaveLength(1);
    await new Promise(r => setTimeout(r, 20));

    const secondFetch = await fetchDeliverable('ws-test', 'member-b', pool, 1);
    expect(secondFetch).toHaveLength(1);
    expect(secondFetch[0].envelope_id).toBe('env-2');

    await ack('ws-test', 'member-b', 'env-2', pool);
    const thirdFetch = await fetchDeliverable('ws-test', 'member-b', pool, 1);
    expect(thirdFetch).toHaveLength(0);
  });

  it('re-admitting the same envelope_id after a retry is idempotent (no duplicate deliverable)', async () => {
    await enqueue('ws-test', 'member-c', 'env-3', 'send_message', { text: 'hi' }, 60_000, pool);
    await enqueue('ws-test', 'member-c', 'env-3', 'send_message', { text: 'hi' }, 60_000, pool);

    const delivered = await fetchDeliverable('ws-test', 'member-c', pool);
    expect(delivered).toHaveLength(1);
  });

  it('a different envelope_id for the same target is delivered separately (not deduped across real messages)', async () => {
    await enqueue('ws-test', 'member-d', 'env-4a', 'send_message', { text: 'first' }, 60_000, pool);
    await enqueue('ws-test', 'member-d', 'env-4b', 'send_message', { text: 'second' }, 60_000, pool);

    const delivered = await fetchDeliverable('ws-test', 'member-d', pool);
    expect(delivered).toHaveLength(2);
    expect(delivered.map(d => d.envelope_id).sort()).toEqual(['env-4a', 'env-4b']);
  });

  it('sweeps expired envelopes so they stop being delivered', async () => {
    await enqueue('ws-test', 'member-e', 'env-5', 'execute_command', { cmd: 'too late' }, 1, pool);
    await new Promise(r => setTimeout(r, 20));

    const sweptCount = await sweepExpired(pool);
    expect(sweptCount).toBeGreaterThanOrEqual(1);

    const delivered = await fetchDeliverable('ws-test', 'member-e', pool);
    expect(delivered).toHaveLength(0);
  });

  it('cross-workspace isolation (apra-fleet-us9.11 iron wall): fetchDeliverable for a member never returns another workspace\'s envelope with a colliding member id', async () => {
    await pool.query(`INSERT INTO workspaces (id, name) VALUES ('ws-other', 'other')`);
    // Same member_id string reused across two workspaces on purpose -- a
    // colliding (or attacker-injected) member_id must NOT bridge tenants.
    // fetchDeliverable now scopes by workspace_id + target_member_id (matching
    // the write side, enqueue/ack), so the iron wall is enforced inside this
    // function, not merely assumed to be applied by the caller.
    await enqueue('ws-test', 'shared-name', 'env-6', 'send_message', { text: 'a' }, 60_000, pool);
    await enqueue('ws-other', 'shared-name', 'env-7', 'send_message', { text: 'b' }, 60_000, pool);

    // Asking as ws-test gets ONLY ws-test's envelope; ws-other's is invisible.
    const deliveredTest = await fetchDeliverable('ws-test', 'shared-name', pool);
    expect(deliveredTest).toHaveLength(1);
    expect(deliveredTest[0].envelope_id).toBe('env-6');

    // And ws-other, asking for the same member_id, sees only its own envelope,
    // never ws-test's.
    const deliveredOther = await fetchDeliverable('ws-other', 'shared-name', pool);
    expect(deliveredOther).toHaveLength(1);
    expect(deliveredOther[0].envelope_id).toBe('env-7');
  });

  it('rejects the newest admission once a target member\'s queue hits the depth cap (never silently drops an older item)', async () => {
    for (let i = 0; i < MAX_QUEUE_DEPTH; i++) {
      const result = await enqueue('ws-test', 'member-full', `env-${i}`, 'execute_command', { i }, 60_000, pool);
      expect(result.ok).toBe(true);
    }
    const rejected = await enqueue('ws-test', 'member-full', 'env-overflow', 'execute_command', { i: 'overflow' }, 60_000, pool);
    expect(rejected).toEqual({ ok: false, reason: 'queue_full' });

    // The oldest item is still there -- rejecting the newest, not evicting an older one.
    const delivered = await fetchDeliverable('ws-test', 'member-full', pool);
    expect(delivered.some(d => d.envelope_id === 'env-0')).toBe(true);
    expect(delivered.some(d => d.envelope_id === 'env-overflow')).toBe(false);
  }, 20000);

  it('apra-fleet-b55: TTL-expiring an execute_command.request generates a synthetic failed result back to the originator', async () => {
    await enqueue('ws-test', 'target-member', 'req-1', 'execute_command.request', { cmd: 'too late' }, 1, pool, 'origin-member');
    await new Promise(r => setTimeout(r, 20));

    const expiredCount = await sweepExpiredToFailures(pool);
    expect(expiredCount).toBeGreaterThanOrEqual(1);

    // The original request is gone from the target's deliverable set...
    const targetDeliverable = await fetchDeliverable('ws-test', 'target-member', pool);
    expect(targetDeliverable.some(d => d.envelope_id === 'req-1')).toBe(false);

    // ...and a synthetic execute_command.result is now queued for the ORIGINATOR.
    const originDeliverable = await fetchDeliverable('ws-test', 'origin-member', pool);
    const failure = originDeliverable.find(d => d.kind === 'execute_command.result');
    expect(failure).toBeDefined();
    expect(failure?.payload).toEqual({ status: 'target_offline_ttl_expired', correlation_id: 'req-1' });
  });

  it('apra-fleet-b55: TTL-expiring a kind with no FAILURE_RESULT_KIND mapping (event.broadcast) generates no synthetic follow-up', async () => {
    await enqueue('ws-test', 'target-member', 'evt-1', 'event.broadcast', { text: 'hi' }, 1, pool, 'origin-member');
    await new Promise(r => setTimeout(r, 20));

    await sweepExpiredToFailures(pool);

    const originDeliverable = await fetchDeliverable('ws-test', 'origin-member', pool);
    expect(originDeliverable).toHaveLength(0);
  });
});
