/**
 * Dashboard human-user data layer (apra-fleet-us9.16), per
 * docs/dashboard-oauth-rbac-design.md. Distinct from member/machine auth --
 * this is the RBAC system for humans signing into the dashboard via OAuth.
 *
 * Default-deny throughout: a brand-new user has status='pending', role=null,
 * and zero user_workspace_roles rows -- no access to anything until an
 * explicit is_platform_admin approval action (approveUser()) grants both a
 * role and an initial workspace set in one call, matching
 * ApproveUserRequestSchema's shape exactly.
 */
import type { Pool } from 'pg';
import { getPool } from './db/pool.js';

export type UserStatus = 'pending' | 'approved' | 'rejected';
export type UserRole = 'member' | 'admin' | 'superadmin';

export interface UserRow {
  id: string;
  email: string;
  name: string;
  oauth_provider: string;
  oauth_subject: string;
  status: UserStatus;
  role: UserRole | null;
  is_platform_admin: boolean;
  created_at: string;
  last_login_at: string | null;
}

/**
 * Finds an existing user by (oauth_provider, oauth_subject) and touches
 * last_login_at, or creates a brand-new pending user with zero access.
 * This is the OAuth-callback entry point -- see http-server.ts's
 * POST /auth/oauth/:provider, which is responsible for the actual
 * provider token exchange (out of scope here, see the design doc section 5)
 * before calling this with an already-verified identity.
 */
export async function findOrCreateUser(
  id: string,
  oauthProvider: 'google' | 'microsoft',
  oauthSubject: string,
  email: string,
  name: string,
  pool: Pool = getPool(),
): Promise<UserRow> {
  const existing = await pool.query<UserRow>(
    `SELECT * FROM users WHERE oauth_provider = $1 AND oauth_subject = $2`,
    [oauthProvider, oauthSubject],
  );
  if (existing.rows[0]) {
    const touched = await pool.query<UserRow>(
      `UPDATE users SET last_login_at = now() WHERE id = $1 RETURNING *`,
      [existing.rows[0].id],
    );
    return touched.rows[0];
  }

  const created = await pool.query<UserRow>(
    `INSERT INTO users (id, email, name, oauth_provider, oauth_subject)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [id, email, name, oauthProvider, oauthSubject],
  );
  return created.rows[0];
}

export async function getUser(id: string, pool: Pool = getPool()): Promise<UserRow | null> {
  const result = await pool.query<UserRow>(`SELECT * FROM users WHERE id = $1`, [id]);
  return result.rows[0] ?? null;
}

/** Platform-admin-only per the contract (GET /admin/users); gating happens
 *  at the HTTP layer, not here -- this is a plain data-layer query. */
export async function listUsers(pool: Pool = getPool()): Promise<UserRow[]> {
  const result = await pool.query<UserRow>(`SELECT * FROM users ORDER BY created_at`);
  return result.rows;
}

export async function listUserWorkspaceIds(userId: string, pool: Pool = getPool()): Promise<string[]> {
  const result = await pool.query<{ workspace_id: string }>(
    `SELECT workspace_id FROM user_workspace_roles WHERE user_id = $1 ORDER BY assigned_at`,
    [userId],
  );
  return result.rows.map(r => r.workspace_id);
}

/** True iff `userId` has a membership row for `workspaceId` (default-deny:
 *  no row means no access, this is the ONLY thing that grants it). */
export async function hasWorkspaceAccess(
  userId: string,
  workspaceId: string,
  pool: Pool = getPool(),
): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM user_workspace_roles WHERE user_id = $1 AND workspace_id = $2`,
    [userId, workspaceId],
  );
  return result.rows.length > 0;
}

/**
 * Approves a pending/rejected user: sets status='approved', assigns
 * `role`, and grants membership in every workspace id in `workspaceIds`
 * (additive -- does not remove any pre-existing assignment). Returns null
 * if the user doesn't exist.
 */
export async function approveUser(
  userId: string,
  role: UserRole,
  workspaceIds: string[],
  pool: Pool = getPool(),
): Promise<UserRow | null> {
  const updated = await pool.query<UserRow>(
    `UPDATE users SET status = 'approved', role = $2 WHERE id = $1 RETURNING *`,
    [userId, role],
  );
  if (!updated.rows[0]) return null;

  for (const workspaceId of workspaceIds) {
    await pool.query(
      `INSERT INTO user_workspace_roles (user_id, workspace_id) VALUES ($1, $2)
       ON CONFLICT (user_id, workspace_id) DO NOTHING`,
      [userId, workspaceId],
    );
  }
  return updated.rows[0];
}

export async function rejectUser(userId: string, pool: Pool = getPool()): Promise<UserRow | null> {
  const result = await pool.query<UserRow>(
    `UPDATE users SET status = 'rejected' WHERE id = $1 RETURNING *`,
    [userId],
  );
  return result.rows[0] ?? null;
}

/** Updates only the user's role -- does not touch status or workspace
 *  assignments. Returns null if the user doesn't exist. */
export async function updateUserRole(
  userId: string,
  role: UserRole,
  pool: Pool = getPool(),
): Promise<UserRow | null> {
  const result = await pool.query<UserRow>(
    `UPDATE users SET role = $2 WHERE id = $1 RETURNING *`,
    [userId, role],
  );
  return result.rows[0] ?? null;
}

export async function deleteUser(userId: string, pool: Pool = getPool()): Promise<boolean> {
  await pool.query(`DELETE FROM user_workspace_roles WHERE user_id = $1`, [userId]);
  const result = await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  return (result.rowCount ?? 0) > 0;
}
