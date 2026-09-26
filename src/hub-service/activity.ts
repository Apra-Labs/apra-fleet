/**
 * Workspace activity feed (apra-fleet-us9.4 continuation), matching
 * @apralabs/fleet-api-contract's ActivityEventSchema.
 *
 * Same "build the real read side, prove it with synthetic data" pattern as
 * usage.ts/relay-queue.ts: recordActivity() (write side) is real and
 * tested today, even though nothing calls it for genuine dispatches yet --
 * that's apra-fleet-us9.6/us9.7's job (spoke mode / relay migration), not
 * a reason to leave the read side unbuilt.
 *
 * The contract's `GET /ws/:id/activity` summary says "(SSE)" -- this MVP
 * returns a plain JSON array (the response schema itself is just
 * z.array(ActivityEventSchema), no SSE-specific shape), matching the
 * project's self-hostable/minimal-surface ethos; upgrading the transport
 * to a real SSE push is a separate, additive change to the HTTP layer, not
 * a data-model one.
 */
import type { Pool } from 'pg';
import { getPool } from './db/pool.js';

export type ActivityKind = 'cmd' | 'prompt' | 'file' | 'commit';

export interface ActivityEvent {
  t: number;
  member: string;
  project: string;
  kind: ActivityKind;
  text: string;
  exit: number | null;
}

export async function recordActivity(
  workspaceId: string,
  projectId: string,
  memberId: string,
  kind: ActivityKind,
  text: string,
  exitCode: number | null = null,
  pool: Pool = getPool(),
): Promise<void> {
  await pool.query(
    `INSERT INTO activity_log (workspace_id, project_id, member_id, kind, text, exit_code)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [workspaceId, projectId, memberId, kind, text, exitCode],
  );
}

export async function getActivityFeed(
  workspaceId: string,
  limit = 100,
  pool: Pool = getPool(),
): Promise<ActivityEvent[]> {
  const result = await pool.query<{
    project_id: string; member_id: string; kind: ActivityKind; text: string; exit_code: number | null; created_at: string;
  }>(
    `SELECT project_id, member_id, kind, text, exit_code, created_at
     FROM activity_log WHERE workspace_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT $2`,
    [workspaceId, limit],
  );

  return result.rows.map(r => ({
    t: Math.max(0, Math.floor((Date.now() - new Date(r.created_at).getTime()) / 1000)),
    member: r.member_id,
    project: r.project_id,
    kind: r.kind,
    text: r.text,
    exit: r.exit_code,
  }));
}
