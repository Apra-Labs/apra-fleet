/**
 * Machine CRUD proof (apra-fleet-us9.4) via pg-mem: executes the real
 * migration file and the real machines.ts queries, unmodified.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import fs from 'node:fs';
import path from 'node:path';
import { setPool, closePool } from '../../src/hub-service/db/pool.js';
import { createWorkspace } from '../../src/hub-service/workspaces.js';
import { registerMachine, listMachines, getMachine } from '../../src/hub-service/machines.js';

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

describe('machines (pg-mem, real SQL engine, no Docker required)', () => {
  beforeEach(async () => {
    pool = await freshPool();
    setPool(pool);
    await createWorkspace('ws-test', 'Test Workspace', pool);
  });

  afterEach(async () => {
    await closePool();
  });

  it('registers a machine under a workspace and returns the inserted row', async () => {
    const row = await registerMachine('m-1', 'ws-test', 'dev-laptop', pool);
    expect(row).toMatchObject({ id: 'm-1', workspace_id: 'ws-test', hostname: 'dev-laptop' });
  });

  it('listMachines returns only machines for the given workspace', async () => {
    await createWorkspace('ws-other', 'Other', pool);
    await registerMachine('m-a', 'ws-test', 'host-a', pool);
    await registerMachine('m-b', 'ws-other', 'host-b', pool);

    const listed = await listMachines('ws-test', pool);
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe('m-a');
  });

  it('getMachine returns null for a machine that exists but in a DIFFERENT workspace', async () => {
    await createWorkspace('ws-other', 'Other', pool);
    await registerMachine('m-cross', 'ws-other', 'host', pool);

    expect(await getMachine('ws-test', 'm-cross', pool)).toBeNull();
  });

  it('registering a machine under a non-existent workspace fails (foreign key constraint)', async () => {
    await expect(registerMachine('m-orphan', 'no-such-ws', 'host', pool)).rejects.toThrow();
  });
});
