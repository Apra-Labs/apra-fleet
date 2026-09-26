/**
 * Usage/cost ledger (apra-fleet-us9.15), rolling up per-(project, member)
 * token/cost records to a workspace total for the dashboard's Cost view.
 *
 * Honesty contract (docs/hub-spoke-master-plan.md Addendum item 3,
 * packages/fleet-api-contract's UsageRecordSchema/CostResponseSchema):
 * session-cumulative only -- there is no 7d/30d windowing, and
 * CostResponseSchema.window is a literal 'session' for exactly that reason.
 * This module does the real rollup math (SUM/GROUP BY) over whatever rows
 * actually exist; it never fabricates a time window the data doesn't
 * support.
 *
 * recordUsage() is the write side (called once real usage flows through
 * this hub -- apra-fleet-us9.6/us9.7, not yet built, are what would call it
 * for real dispatches). getCostResponse() is the read/rollup side and is
 * fully real and tested today, independent of whether anything is writing
 * to it yet -- same "build the read side against the real schema, prove it
 * with synthetic data" pattern as relay-queue.ts/audit-log.ts.
 *
 * Rows with no project_id (nullable in the schema -- not every usage event
 * is necessarily project-scoped) are excluded from the per-(project,
 * member) breakdown, since UsageRecordSchema requires a non-empty project
 * id. They ARE still counted in workspaceTotal, since the workspace total
 * has no such per-record shape constraint.
 */
import type { Pool } from 'pg';
import { getPool } from './db/pool.js';

export interface UsageRecordRow {
  project: string;
  member: string;
  tokens: number;
  cost: number;
}

export interface CostResponse {
  window: 'session';
  workspaceTotal: number;
  usage: UsageRecordRow[];
}

export async function recordUsage(
  workspaceId: string,
  memberId: string,
  projectId: string | null,
  tokens: number,
  costUsd: number,
  pool: Pool = getPool(),
): Promise<void> {
  await pool.query(
    `INSERT INTO usage_ledger (workspace_id, project_id, member_id, tokens, cost_usd)
     VALUES ($1, $2, $3, $4, $5)`,
    [workspaceId, projectId, memberId, tokens, costUsd],
  );
}

export async function getCostResponse(workspaceId: string, pool: Pool = getPool()): Promise<CostResponse> {
  const totalResult = await pool.query<{ total: string | null }>(
    `SELECT SUM(cost_usd) AS total FROM usage_ledger WHERE workspace_id = $1`,
    [workspaceId],
  );
  const workspaceTotal = Number(totalResult.rows[0]?.total ?? 0);

  const breakdownResult = await pool.query<{ project_id: string; member_id: string; tokens: string; cost: string }>(
    `SELECT project_id, member_id, SUM(tokens) AS tokens, SUM(cost_usd) AS cost
     FROM usage_ledger
     WHERE workspace_id = $1 AND project_id IS NOT NULL
     GROUP BY project_id, member_id
     ORDER BY project_id, member_id`,
    [workspaceId],
  );

  return {
    window: 'session',
    workspaceTotal,
    usage: breakdownResult.rows.map(r => ({
      project: r.project_id,
      member: r.member_id,
      tokens: Number(r.tokens),
      cost: Number(r.cost),
    })),
  };
}
