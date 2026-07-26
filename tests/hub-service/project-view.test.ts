/**
 * Project view-model assembly proof (apra-fleet-us9.4 continuation) via
 * pg-mem, plus a contract test validating the assembled shape against the
 * published @apralabs/fleet-api-contract ProjectSchema.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import fs from 'node:fs';
import path from 'node:path';
import { ProjectSchema } from '@apralabs/fleet-api-contract';
import { setPool, closePool } from '../../src/hub-service/db/pool.js';
import { createWorkspace } from '../../src/hub-service/workspaces.js';
import { createMember } from '../../src/hub-service/members.js';
import { createProject } from '../../src/hub-service/projects.js';
import { getProjectView, listProjectViews } from '../../src/hub-service/project-view.js';

let pool: any;

async function freshPool() {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  db.public.registerFunction({ name: 'now', returns: 'timestamptz' as any, implementation: () => new Date() });
  const { Pool } = db.adapters.createPg();
  const p = new Pool();
  const migrationsDir = path.join(process.cwd(), 'db', 'migrations');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    const rawSql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    const sql = rawSql.replace(/CREATE UNLOGGED TABLE/gi, 'CREATE TABLE');
    await p.query(sql);
  }
  return p;
}

describe('project-view (pg-mem, real SQL engine, no Docker required)', () => {
  beforeEach(async () => {
    pool = await freshPool();
    setPool(pool);
    await createWorkspace('ws-test', 'Test Workspace', pool);
  });

  afterEach(async () => {
    await closePool();
  });

  it('getProjectView returns null for a non-existent project', async () => {
    expect(await getProjectView('ws-test', 'no-such-project', pool)).toBeNull();
  });

  it('assembles a view with no members: empty members array, valid against ProjectSchema', async () => {
    await createProject('proj-1', 'ws-test', { name: 'Solo Project', description: 'a desc' }, pool);

    const view = await getProjectView('ws-test', 'proj-1', pool);
    expect(view).toMatchObject({ id: 'proj-1', name: 'Solo Project', desc: 'a desc', status: 'active', members: [] });
    expect(view!.lastActivity).toBeGreaterThanOrEqual(0);
    expect(() => ProjectSchema.parse(view)).not.toThrow();
  });

  it('assembles a view including its attached members', async () => {
    await createMember('mem-1', 'ws-test', { name: 'alice', provider: 'claude' }, pool);
    await createMember('mem-2', 'ws-test', { name: 'bella', provider: 'claude' }, pool);
    await createProject('proj-2', 'ws-test', { name: 'Team Project', memberIds: ['mem-1', 'mem-2'] }, pool);

    const view = await getProjectView('ws-test', 'proj-2', pool);
    expect(view!.members.sort()).toEqual(['mem-1', 'mem-2']);
    expect(() => ProjectSchema.parse(view)).not.toThrow();
  });

  it('listProjectViews returns views for every project in the workspace, each validating against ProjectSchema', async () => {
    await createProject('proj-3', 'ws-test', { name: 'First' }, pool);
    await createProject('proj-4', 'ws-test', { name: 'Second' }, pool);

    const views = await listProjectViews('ws-test', pool);
    expect(views).toHaveLength(2);
    for (const v of views) {
      expect(() => ProjectSchema.parse(v)).not.toThrow();
    }
  });

  it('does not include projects from a DIFFERENT workspace', async () => {
    await createWorkspace('ws-other', 'Other', pool);
    await createProject('proj-cross', 'ws-other', { name: 'Cross' }, pool);

    expect(await listProjectViews('ws-test', pool)).toEqual([]);
  });
});
