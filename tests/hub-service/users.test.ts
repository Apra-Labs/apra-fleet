/**
 * Dashboard user/RBAC data layer proof (apra-fleet-us9.16) via pg-mem:
 * executes the real migration files and the real users.ts queries.
 * Covers the specific privilege-escalation risks listed in
 * docs/dashboard-oauth-rbac-design.md section 4.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import fs from 'node:fs';
import path from 'node:path';
import { setPool, closePool } from '../../src/hub-service/db/pool.js';
import { createWorkspace } from '../../src/hub-service/workspaces.js';
import {
  findOrCreateUser, getUser, listUsers, approveUser, rejectUser,
  updateUserRole, deleteUser, listUserWorkspaceIds, hasWorkspaceAccess,
} from '../../src/hub-service/users.js';

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

describe('users / dashboard RBAC (pg-mem, real SQL engine, no Docker required)', () => {
  beforeEach(async () => {
    pool = await freshPool();
    setPool(pool);
    await createWorkspace('ws-a', 'Workspace A', pool);
    await createWorkspace('ws-b', 'Workspace B', pool);
  });

  afterEach(async () => {
    await closePool();
  });

  describe('OAuth find-or-create + pending-by-default (zero access until approved)', () => {
    it('a brand-new user lands pending, with no role and no workspace access at all', async () => {
      const user = await findOrCreateUser('u-1', 'google', 'sub-1', 'alice@example.com', 'Alice', pool);
      expect(user.status).toBe('pending');
      expect(user.role).toBeNull();
      expect(user.is_platform_admin).toBe(false);
      expect(await listUserWorkspaceIds('u-1', pool)).toEqual([]);
      expect(await hasWorkspaceAccess('u-1', 'ws-a', pool)).toBe(false);
    });

    it('re-login for the same (oauth_provider, oauth_subject) finds the existing user, not a duplicate', async () => {
      await findOrCreateUser('u-1', 'google', 'sub-1', 'alice@example.com', 'Alice', pool);
      const secondLogin = await findOrCreateUser('u-2-attempted', 'google', 'sub-1', 'alice@example.com', 'Alice', pool);

      expect(secondLogin.id).toBe('u-1'); // the ORIGINAL id, not the new one requested
      expect(await getUser('u-2-attempted', pool)).toBeNull();
    });

    it('re-login updates last_login_at', async () => {
      const first = await findOrCreateUser('u-1', 'google', 'sub-1', 'alice@example.com', 'Alice', pool);
      expect(first.last_login_at).toBeNull();

      const second = await findOrCreateUser('u-1', 'google', 'sub-1', 'alice@example.com', 'Alice', pool);
      expect(second.last_login_at).not.toBeNull();
    });

    it('different oauth_subject values under the same provider are different users', async () => {
      await findOrCreateUser('u-1', 'google', 'sub-1', 'alice@example.com', 'Alice', pool);
      await findOrCreateUser('u-2', 'google', 'sub-2', 'bob@example.com', 'Bob', pool);
      expect(await listUsers(pool)).toHaveLength(2);
    });
  });

  describe('approval flow', () => {
    it('approveUser sets status=approved, role, and grants the initial workspace set', async () => {
      await findOrCreateUser('u-1', 'google', 'sub-1', 'alice@example.com', 'Alice', pool);
      const approved = await approveUser('u-1', 'admin', ['ws-a', 'ws-b'], pool);

      expect(approved?.status).toBe('approved');
      expect(approved?.role).toBe('admin');
      expect((await listUserWorkspaceIds('u-1', pool)).sort()).toEqual(['ws-a', 'ws-b']);
      expect(await hasWorkspaceAccess('u-1', 'ws-a', pool)).toBe(true);
    });

    it('approveUser returns null for a non-existent user', async () => {
      expect(await approveUser('no-such-user', 'member', ['ws-a'], pool)).toBeNull();
    });

    it('approveUser is additive to existing workspace assignments, not a wholesale replace', async () => {
      await findOrCreateUser('u-1', 'google', 'sub-1', 'alice@example.com', 'Alice', pool);
      await approveUser('u-1', 'member', ['ws-a'], pool);
      await approveUser('u-1', 'admin', ['ws-b'], pool); // re-approval with a different workspace

      expect((await listUserWorkspaceIds('u-1', pool)).sort()).toEqual(['ws-a', 'ws-b']);
    });

    it('rejectUser sets status=rejected without granting any access', async () => {
      await findOrCreateUser('u-1', 'google', 'sub-1', 'alice@example.com', 'Alice', pool);
      const rejected = await rejectUser('u-1', pool);
      expect(rejected?.status).toBe('rejected');
      expect(await listUserWorkspaceIds('u-1', pool)).toEqual([]);
    });

    it('a rejected user re-attempting OAuth login does NOT silently flip back to pending -- status is untouched by findOrCreateUser', async () => {
      await findOrCreateUser('u-1', 'google', 'sub-1', 'alice@example.com', 'Alice', pool);
      await rejectUser('u-1', pool);

      const reLogin = await findOrCreateUser('u-1', 'google', 'sub-1', 'alice@example.com', 'Alice', pool);
      expect(reLogin.status).toBe('rejected');
    });
  });

  describe('role updates', () => {
    it('updateUserRole changes only the role, leaving status/workspaces untouched', async () => {
      await findOrCreateUser('u-1', 'google', 'sub-1', 'alice@example.com', 'Alice', pool);
      await approveUser('u-1', 'member', ['ws-a'], pool);

      const updated = await updateUserRole('u-1', 'superadmin', pool);
      expect(updated?.role).toBe('superadmin');
      expect(updated?.status).toBe('approved');
      expect(await listUserWorkspaceIds('u-1', pool)).toEqual(['ws-a']);
    });

    it('updateUserRole returns null for a non-existent user', async () => {
      expect(await updateUserRole('no-such-user', 'admin', pool)).toBeNull();
    });
  });

  describe('deletion and workspace isolation', () => {
    it('deleteUser removes the user and all their workspace assignments', async () => {
      await findOrCreateUser('u-1', 'google', 'sub-1', 'alice@example.com', 'Alice', pool);
      await approveUser('u-1', 'member', ['ws-a'], pool);

      expect(await deleteUser('u-1', pool)).toBe(true);
      expect(await getUser('u-1', pool)).toBeNull();
      expect(await deleteUser('u-1', pool)).toBe(false);
    });

    it('a user assigned to ws-a has no access to ws-b (default deny)', async () => {
      await findOrCreateUser('u-1', 'google', 'sub-1', 'alice@example.com', 'Alice', pool);
      await approveUser('u-1', 'member', ['ws-a'], pool);

      expect(await hasWorkspaceAccess('u-1', 'ws-a', pool)).toBe(true);
      expect(await hasWorkspaceAccess('u-1', 'ws-b', pool)).toBe(false);
    });
  });
});
