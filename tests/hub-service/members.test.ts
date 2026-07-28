/**
 * Member CRUD proof (apra-fleet-us9.4) via pg-mem: executes the real
 * migration file and the real members.ts queries, unmodified.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import fs from 'node:fs';
import path from 'node:path';
import { setPool, closePool } from '../../src/hub-service/db/pool.js';
import { createWorkspace } from '../../src/hub-service/workspaces.js';
import { registerMachine } from '../../src/hub-service/machines.js';
import { createMember, listMembers, getMember, deleteMember } from '../../src/hub-service/members.js';

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

describe('members (pg-mem, real SQL engine, no Docker required)', () => {
  beforeEach(async () => {
    pool = await freshPool();
    setPool(pool);
    await createWorkspace('ws-test', 'Test Workspace', pool);
  });

  afterEach(async () => {
    await closePool();
  });

  it('creates a member with no machine (machine_id nullable) and returns the inserted row', async () => {
    const row = await createMember('mem-1', 'ws-test', { name: 'alice', provider: 'claude' }, pool);
    expect(row).toMatchObject({ id: 'mem-1', workspace_id: 'ws-test', name: 'alice', provider: 'claude', machine_id: null });
  });

  it('creates a member attached to a registered machine', async () => {
    await registerMachine('m-1', 'ws-test', 'dev-laptop', pool);
    const row = await createMember('mem-2', 'ws-test', { name: 'bella', provider: 'gemini', machineId: 'm-1', workFolder: '/srv/work' }, pool);
    expect(row.machine_id).toBe('m-1');
    expect(row.work_folder).toBe('/srv/work');
  });

  it('supports provider "none" (apra-fleet-us9.14 no-LLM members)', async () => {
    const row = await createMember('mem-none', 'ws-test', { name: 'plain-executor', provider: 'none' }, pool);
    expect(row.provider).toBe('none');
  });

  it('listMembers returns only members for the given workspace', async () => {
    await createWorkspace('ws-other', 'Other', pool);
    await createMember('mem-a', 'ws-test', { name: 'a', provider: 'claude' }, pool);
    await createMember('mem-b', 'ws-other', { name: 'b', provider: 'claude' }, pool);

    const listed = await listMembers('ws-test', pool);
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe('mem-a');
  });

  it('getMember returns null for a member that exists but in a DIFFERENT workspace (cross-tenant isolation)', async () => {
    await createWorkspace('ws-other', 'Other', pool);
    await createMember('mem-cross', 'ws-other', { name: 'x', provider: 'claude' }, pool);

    expect(await getMember('ws-test', 'mem-cross', pool)).toBeNull();
  });

  it('deleteMember removes the row and returns true; returns false for a non-existent member', async () => {
    await createMember('mem-del', 'ws-test', { name: 'to-delete', provider: 'claude' }, pool);

    expect(await deleteMember('ws-test', 'mem-del', pool)).toBe(true);
    expect(await getMember('ws-test', 'mem-del', pool)).toBeNull();
    expect(await deleteMember('ws-test', 'mem-del', pool)).toBe(false);
  });

  it('creating a member under a non-existent workspace fails (foreign key constraint)', async () => {
    await expect(createMember('mem-orphan', 'no-such-ws', { name: 'x', provider: 'claude' }, pool)).rejects.toThrow();
  });
});
