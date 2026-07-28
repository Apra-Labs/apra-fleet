/**
 * Project CRUD proof (apra-fleet-us9.4 continuation) via pg-mem: executes
 * the real migration files and the real projects.ts queries, unmodified.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import fs from 'node:fs';
import path from 'node:path';
import { setPool, closePool } from '../../src/hub-service/db/pool.js';
import { createWorkspace } from '../../src/hub-service/workspaces.js';
import { createMember } from '../../src/hub-service/members.js';
import {
  createProject, listProjects, getProject, updateProject, deleteProject,
  addProjectMember, removeProjectMember, listProjectMemberIds,
} from '../../src/hub-service/projects.js';

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

describe('projects (pg-mem, real SQL engine, no Docker required)', () => {
  beforeEach(async () => {
    pool = await freshPool();
    setPool(pool);
    await createWorkspace('ws-test', 'Test Workspace', pool);
  });

  afterEach(async () => {
    await closePool();
  });

  it('creates a project with defaults (description empty, status active)', async () => {
    const row = await createProject('proj-1', 'ws-test', { name: 'Fleet Dashboard' }, pool);
    expect(row).toMatchObject({ id: 'proj-1', workspace_id: 'ws-test', name: 'Fleet Dashboard', description: '', status: 'active' });
  });

  it('creates a project with initial members attached', async () => {
    await createMember('mem-1', 'ws-test', { name: 'alice', provider: 'claude' }, pool);
    await createMember('mem-2', 'ws-test', { name: 'bella', provider: 'claude' }, pool);

    await createProject('proj-2', 'ws-test', { name: 'With Members', memberIds: ['mem-1', 'mem-2'] }, pool);
    const memberIds = await listProjectMemberIds('proj-2', pool);
    expect(memberIds.sort()).toEqual(['mem-1', 'mem-2']);
  });

  it('listProjects returns only projects for the given workspace', async () => {
    await createWorkspace('ws-other', 'Other', pool);
    await createProject('proj-a', 'ws-test', { name: 'A' }, pool);
    await createProject('proj-b', 'ws-other', { name: 'B' }, pool);

    const listed = await listProjects('ws-test', pool);
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe('proj-a');
  });

  it('getProject returns null for a project in a DIFFERENT workspace (cross-tenant isolation)', async () => {
    await createWorkspace('ws-other', 'Other', pool);
    await createProject('proj-cross', 'ws-other', { name: 'X' }, pool);
    expect(await getProject('ws-test', 'proj-cross', pool)).toBeNull();
  });

  it('updateProject changes only the provided fields, preserving the rest', async () => {
    await createProject('proj-3', 'ws-test', { name: 'Original', description: 'orig desc' }, pool);
    const updated = await updateProject('ws-test', 'proj-3', { status: 'paused' }, pool);
    expect(updated).toMatchObject({ name: 'Original', description: 'orig desc', status: 'paused' });
  });

  it('updateProject returns null for a non-existent project', async () => {
    expect(await updateProject('ws-test', 'no-such-project', { name: 'x' }, pool)).toBeNull();
  });

  it('addProjectMember and removeProjectMember manage the many-to-many relationship', async () => {
    await createMember('mem-3', 'ws-test', { name: 'charlie', provider: 'claude' }, pool);
    await createProject('proj-4', 'ws-test', { name: 'Membership Test' }, pool);

    expect(await addProjectMember('ws-test', 'proj-4', 'mem-3', pool)).toBe(true);
    expect(await listProjectMemberIds('proj-4', pool)).toEqual(['mem-3']);

    expect(await removeProjectMember('ws-test', 'proj-4', 'mem-3', pool)).toBe(true);
    expect(await listProjectMemberIds('proj-4', pool)).toEqual([]);
  });

  it('addProjectMember is idempotent (adding the same member twice does not error or duplicate)', async () => {
    await createMember('mem-4', 'ws-test', { name: 'dana', provider: 'claude' }, pool);
    await createProject('proj-5', 'ws-test', { name: 'Idempotent Test' }, pool);

    await addProjectMember('ws-test', 'proj-5', 'mem-4', pool);
    await addProjectMember('ws-test', 'proj-5', 'mem-4', pool);
    expect(await listProjectMemberIds('proj-5', pool)).toEqual(['mem-4']);
  });

  it('addProjectMember returns false for a project in a DIFFERENT workspace (cannot cross the boundary)', async () => {
    await createWorkspace('ws-other', 'Other', pool);
    await createMember('mem-5', 'ws-other', { name: 'eve', provider: 'claude' }, pool);
    await createProject('proj-6', 'ws-other', { name: 'Other Project' }, pool);

    expect(await addProjectMember('ws-test', 'proj-6', 'mem-5', pool)).toBe(false);
  });

  it('addProjectMember returns false for a member from a DIFFERENT workspace, even when the project itself is correctly scoped (iron wall)', async () => {
    await createWorkspace('ws-other', 'Other', pool);
    await createMember('mem-foreign', 'ws-other', { name: 'foreign-member', provider: 'claude' }, pool);
    await createProject('proj-7a', 'ws-test', { name: 'Correctly Scoped Project' }, pool);

    expect(await addProjectMember('ws-test', 'proj-7a', 'mem-foreign', pool)).toBe(false);
    expect(await listProjectMemberIds('proj-7a', pool)).toEqual([]);
  });

  it('createProject with memberIds silently drops any id from a DIFFERENT workspace rather than leaking it in', async () => {
    await createWorkspace('ws-other', 'Other', pool);
    await createMember('mem-own', 'ws-test', { name: 'own-member', provider: 'claude' }, pool);
    await createMember('mem-foreign2', 'ws-other', { name: 'foreign-member-2', provider: 'claude' }, pool);

    await createProject('proj-7b', 'ws-test', { name: 'Mixed Members', memberIds: ['mem-own', 'mem-foreign2'] }, pool);
    expect(await listProjectMemberIds('proj-7b', pool)).toEqual(['mem-own']);
  });

  it('deleteProject removes the project and its membership rows', async () => {
    await createMember('mem-6', 'ws-test', { name: 'frank', provider: 'claude' }, pool);
    await createProject('proj-7', 'ws-test', { name: 'To Delete', memberIds: ['mem-6'] }, pool);

    expect(await deleteProject('ws-test', 'proj-7', pool)).toBe(true);
    expect(await getProject('ws-test', 'proj-7', pool)).toBeNull();
    expect(await deleteProject('ws-test', 'proj-7', pool)).toBe(false);
  });

  it('creating a project under a non-existent workspace fails (foreign key constraint)', async () => {
    await expect(createProject('proj-orphan', 'no-such-ws', { name: 'x' }, pool)).rejects.toThrow();
  });
});
