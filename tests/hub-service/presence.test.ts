/**
 * Presence proof (apra-fleet-us9.4) via pg-mem: executes the real migration
 * file and the real presence.ts queries, unmodified, against an in-memory
 * Postgres-compatible engine.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import fs from 'node:fs';
import path from 'node:path';
import { setPool, closePool } from '../../src/hub-service/db/pool.js';
import { announce, announceSnapshot, listForMachine, isStale } from '../../src/hub-service/presence.js';

let pool: any;

async function freshPool() {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  db.public.registerFunction({ name: 'now', returns: 'timestamptz' as any, implementation: () => new Date() });
  const { Pool } = db.adapters.createPg();
  const p = new Pool();
  const migrationPath = path.join(process.cwd(), 'db', 'migrations', '001_hub_service_schema.sql');
  const rawSql = fs.readFileSync(migrationPath, 'utf8');
  const sql = rawSql.replace(/CREATE UNLOGGED TABLE/gi, 'CREATE TABLE');
  await p.query(sql);
  return p;
}

describe('presence (pg-mem, real SQL engine, no Docker required)', () => {
  beforeEach(async () => {
    pool = await freshPool();
    setPool(pool);
  });

  afterEach(async () => {
    await closePool();
  });

  it('announcing a member makes it show up for its machine', async () => {
    await announce('machine-1', 'member-a', 'online', pool);
    const rows = await listForMachine('machine-1', pool);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ machine_id: 'machine-1', member_id: 'member-a', status: 'online' });
  });

  it('re-announcing the same member updates status in place, not a duplicate row', async () => {
    await announce('machine-1', 'member-a', 'online', pool);
    await announce('machine-1', 'member-a', 'busy', pool);

    const rows = await listForMachine('machine-1', pool);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('busy');
  });

  it('lists multiple members on the same machine independently', async () => {
    await announce('machine-1', 'member-a', 'online', pool);
    await announce('machine-1', 'member-b', 'idle', pool);

    const rows = await listForMachine('machine-1', pool);
    expect(rows.map(r => r.member_id).sort()).toEqual(['member-a', 'member-b']);
  });

  it('a member never announced is treated as stale', async () => {
    const stale = await isStale('machine-1', 'member-never-seen', 60_000, pool);
    expect(stale).toBe(true);
  });

  it('a freshly announced member is not stale', async () => {
    await announce('machine-1', 'member-a', 'online', pool);
    const stale = await isStale('machine-1', 'member-a', 60_000, pool);
    expect(stale).toBe(false);
  });

  it('announceSnapshot (apra-fleet-us9.6) replaces, not merges: a member absent from a later snapshot is dropped', async () => {
    await announceSnapshot('machine-1', [{ memberId: 'member-a', status: 'online' }, { memberId: 'member-b', status: 'busy' }], pool);
    await announceSnapshot('machine-1', [{ memberId: 'member-a', status: 'online' }], pool);

    const rows = await listForMachine('machine-1', pool);
    expect(rows.map(r => r.member_id)).toEqual(['member-a']);
  });

  it('announceSnapshot with an empty list clears every member for that machine (e.g. clean shutdown re-announce)', async () => {
    await announceSnapshot('machine-1', [{ memberId: 'member-a', status: 'online' }], pool);
    await announceSnapshot('machine-1', [], pool);

    const rows = await listForMachine('machine-1', pool);
    expect(rows).toHaveLength(0);
  });

  it('announceSnapshot never touches presence rows for a DIFFERENT machine', async () => {
    await announce('machine-2', 'member-z', 'online', pool);
    await announceSnapshot('machine-1', [{ memberId: 'member-a', status: 'online' }], pool);

    const rows = await listForMachine('machine-2', pool);
    expect(rows.map(r => r.member_id)).toEqual(['member-z']);
  });
});
