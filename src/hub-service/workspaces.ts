/**
 * Workspace CRUD (apra-fleet-us9.4), data-layer only.
 *
 * Deliberately does NOT include a "list my workspaces" query: that requires
 * per-user role scoping (`WorkspaceSchema.role`, "requesting user's role
 * within this workspace"), which needs the human-user/RBAC model
 * apra-fleet-us9.16 (Dashboard OAuth + RBAC) owns -- not yet built. create/get
 * here need no such scoping: workspace_id is already the tenant boundary
 * (the `ws` JWT claim), so any caller that has been authorized to create or
 * look up a specific workspace by id can do so without a user/role table.
 */
import type { Pool } from 'pg';
import { getPool } from './db/pool.js';

export interface WorkspaceRow {
  id: string;
  name: string;
  created_at: string;
}

export async function createWorkspace(
  id: string,
  name: string,
  pool: Pool = getPool(),
): Promise<WorkspaceRow> {
  const result = await pool.query<WorkspaceRow>(
    `INSERT INTO workspaces (id, name) VALUES ($1, $2) RETURNING *`,
    [id, name],
  );
  return result.rows[0];
}

export async function getWorkspace(id: string, pool: Pool = getPool()): Promise<WorkspaceRow | null> {
  const result = await pool.query<WorkspaceRow>(
    `SELECT * FROM workspaces WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}
