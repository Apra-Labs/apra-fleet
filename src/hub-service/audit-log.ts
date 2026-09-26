/**
 * Audit log writes (apra-fleet-us9.4), backed by the `audit_log` table.
 * Every workspace-scoped mutation (member/machine/project changes, JWT
 * issuance/revocation, relay admission of privileged actions) should record
 * one row here -- append-only, no update/delete path by design.
 */
import type { Pool } from 'pg';
import { getPool } from './db/pool.js';

export interface AuditLogRow {
  id: number;
  workspace_id: string;
  actor_id: string | null;
  action: string;
  detail: unknown;
  created_at: string;
}

export async function record(
  workspaceId: string,
  actorId: string | null,
  action: string,
  detail: unknown,
  pool: Pool = getPool(),
): Promise<AuditLogRow> {
  const result = await pool.query<AuditLogRow>(
    `INSERT INTO audit_log (workspace_id, actor_id, action, detail)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [workspaceId, actorId, action, detail === undefined ? null : JSON.stringify(detail)],
  );
  return result.rows[0];
}

/** Most-recent-first, for a workspace's audit trail view. */
export async function listForWorkspace(
  workspaceId: string,
  limit = 100,
  pool: Pool = getPool(),
): Promise<AuditLogRow[]> {
  const result = await pool.query<AuditLogRow>(
    `SELECT * FROM audit_log WHERE workspace_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
    [workspaceId, limit],
  );
  return result.rows;
}
