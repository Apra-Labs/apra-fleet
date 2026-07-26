/**
 * Workspace CRUD proof (apra-fleet-us9.4) via pg-mem: executes the real
 * migration file and the real workspaces.ts queries, unmodified.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import fs from 'node:fs';
import path from 'node:path';
import { setPool, closePool } from '../../src/hub-service/db/pool.js';
import { createWorkspace, getWorkspace } from '../../src/hub-service/workspaces.js';

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

describe('workspaces (pg-mem, real SQL engine, no Docker required)', () => {
  beforeEach(async () => {
    pool = await freshPool();
    setPool(pool);
  });

  afterEach(async () => {
    await closePool();
  });

  it('creates a workspace and returns the inserted row', async () => {
    const row = await createWorkspace('ws-1', 'Acme Corp', pool);
    expect(row).toMatchObject({ id: 'ws-1', name: 'Acme Corp' });
    expect(row.created_at).toBeDefined();
  });

  it('getWorkspace returns the created workspace by id', async () => {
    await createWorkspace('ws-2', 'Beta Inc', pool);
    const found = await getWorkspace('ws-2', pool);
    expect(found).toMatchObject({ id: 'ws-2', name: 'Beta Inc' });
  });

  it('getWorkspace returns null for a non-existent id', async () => {
    expect(await getWorkspace('no-such-ws', pool)).toBeNull();
  });

  it('creating a workspace with a duplicate id fails (primary key constraint)', async () => {
    await createWorkspace('ws-dup', 'First', pool);
    await expect(createWorkspace('ws-dup', 'Second', pool)).rejects.toThrow();
  });
});
