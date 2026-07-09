/**
 * Audit-log proof (apra-fleet-us9.4) via pg-mem: executes the real
 * migration file and the real audit-log.ts queries, unmodified, against an
 * in-memory Postgres-compatible engine.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import fs from 'node:fs';
import path from 'node:path';
import { setPool, closePool } from '../../src/hub-service/db/pool.js';
import { record, listForWorkspace } from '../../src/hub-service/audit-log.js';

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
  await p.query(`INSERT INTO workspaces (id, name) VALUES ('ws-test', 'test')`);
  return p;
}

describe('audit-log (pg-mem, real SQL engine, no Docker required)', () => {
  beforeEach(async () => {
    pool = await freshPool();
    setPool(pool);
  });

  afterEach(async () => {
    await closePool();
  });

  it('records an entry with actor and structured detail', async () => {
    const row = await record('ws-test', 'user-1', 'member.create', { memberId: 'm-1' }, pool);
    expect(row.action).toBe('member.create');
    expect(row.detail).toEqual({ memberId: 'm-1' });
  });

  it('records an entry with a null actor (system-initiated action)', async () => {
    const row = await record('ws-test', null, 'token.revoke', { jti: 'jti-1' }, pool);
    expect(row.actor_id).toBeNull();
  });

  it('lists a workspace\'s entries most-recent-first', async () => {
    await record('ws-test', 'user-1', 'action.first', {}, pool);
    await record('ws-test', 'user-1', 'action.second', {}, pool);

    const rows = await listForWorkspace('ws-test', 100, pool);
    expect(rows).toHaveLength(2);
    expect(rows[0].action).toBe('action.second');
    expect(rows[1].action).toBe('action.first');
  });

  it('does not return another workspace\'s entries', async () => {
    await pool.query(`INSERT INTO workspaces (id, name) VALUES ('ws-other', 'other')`);
    await record('ws-test', 'user-1', 'action.mine', {}, pool);
    await record('ws-other', 'user-1', 'action.theirs', {}, pool);

    const rows = await listForWorkspace('ws-test', 100, pool);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('action.mine');
  });
});
