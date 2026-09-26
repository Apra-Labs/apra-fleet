/**
 * Member view-model assembly proof (apra-fleet-us9.4) via pg-mem: executes
 * the real migration file and the real member-view.ts join logic. Also a
 * contract test -- validates the assembled shape against the published
 * @apralabs/fleet-api-contract MemberSchema at runtime, catching wire-format
 * drift that type-checking alone would miss.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import fs from 'node:fs';
import path from 'node:path';
import { MemberSchema } from '@apralabs/fleet-api-contract';
import { setPool, closePool } from '../../src/hub-service/db/pool.js';
import { createWorkspace } from '../../src/hub-service/workspaces.js';
import { registerMachine } from '../../src/hub-service/machines.js';
import { createMember } from '../../src/hub-service/members.js';
import { announce } from '../../src/hub-service/presence.js';
import { getMemberView, listMemberViews } from '../../src/hub-service/member-view.js';

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

describe('member-view (pg-mem, real SQL engine, no Docker required)', () => {
  beforeEach(async () => {
    pool = await freshPool();
    setPool(pool);
    await createWorkspace('ws-test', 'Test Workspace', pool);
  });

  afterEach(async () => {
    await closePool();
  });

  it('getMemberView returns null for a non-existent member', async () => {
    expect(await getMemberView('ws-test', 'no-such-member', pool)).toBeNull();
  });

  it('assembles a view for a member with no machine and no presence: awaiting-connect, honest nulls throughout', async () => {
    await createMember('mem-1', 'ws-test', { name: 'alice', provider: 'claude' }, pool);

    const view = await getMemberView('ws-test', 'mem-1', pool);
    expect(view).toMatchObject({
      id: 'mem-1', name: 'alice', provider: 'claude',
      status: 'awaiting-connect', machine: 'unknown', lastSeen: null,
      model: null, lastPrompt: null, lastPromptAt: null, tags: [], jwtExp: 0, agentVer: 'unknown',
    });
    expect(() => MemberSchema.parse(view)).not.toThrow();
  });

  it('a member with a machine but NO presence entry reports offline (registered, never connected)', async () => {
    await registerMachine('m-1', 'ws-test', 'dev-laptop', pool);
    await createMember('mem-2', 'ws-test', { name: 'bella', provider: 'gemini', machineId: 'm-1', workFolder: '/srv/work' }, pool);

    const view = await getMemberView('ws-test', 'mem-2', pool);
    expect(view?.status).toBe('offline');
    expect(view?.machine).toBe('dev-laptop');
    expect(view?.folder).toBe('/srv/work');
    expect(() => MemberSchema.parse(view)).not.toThrow();
  });

  it('a member WITH a live presence entry reports its real status and a computed lastSeen', async () => {
    await registerMachine('m-1', 'ws-test', 'dev-laptop', pool);
    await createMember('mem-3', 'ws-test', { name: 'charlie', provider: 'claude', machineId: 'm-1' }, pool);
    await announce('m-1', 'mem-3', 'online', pool);

    const view = await getMemberView('ws-test', 'mem-3', pool);
    expect(view?.status).toBe('online');
    expect(view?.lastSeen).not.toBeNull();
    expect(view!.lastSeen!).toBeGreaterThanOrEqual(0);
    expect(() => MemberSchema.parse(view)).not.toThrow();
  });

  it('presence for a DIFFERENT member on the same machine does not leak into this member\'s view', async () => {
    await registerMachine('m-1', 'ws-test', 'dev-laptop', pool);
    await createMember('mem-4', 'ws-test', { name: 'dana', provider: 'claude', machineId: 'm-1' }, pool);
    await createMember('mem-5', 'ws-test', { name: 'eve', provider: 'claude', machineId: 'm-1' }, pool);
    await announce('m-1', 'mem-5', 'busy', pool);

    const view4 = await getMemberView('ws-test', 'mem-4', pool);
    const view5 = await getMemberView('ws-test', 'mem-5', pool);
    expect(view4?.status).toBe('offline');
    expect(view5?.status).toBe('busy');
  });

  it('listMemberViews returns views for every member in the workspace, each validating against MemberSchema', async () => {
    await createMember('mem-6', 'ws-test', { name: 'frank', provider: 'codex' }, pool);
    await createMember('mem-7', 'ws-test', { name: 'grace', provider: 'none' }, pool);

    const views = await listMemberViews('ws-test', pool);
    expect(views).toHaveLength(2);
    for (const v of views) {
      expect(() => MemberSchema.parse(v)).not.toThrow();
    }
  });

  it('does not include members from a DIFFERENT workspace', async () => {
    await createWorkspace('ws-other', 'Other', pool);
    await createMember('mem-cross', 'ws-other', { name: 'zed', provider: 'claude' }, pool);

    const views = await listMemberViews('ws-test', pool);
    expect(views).toEqual([]);
  });
});
