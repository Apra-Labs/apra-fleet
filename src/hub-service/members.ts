/**
 * Member CRUD (apra-fleet-us9.4), data-layer only. Scoped by workspace_id
 * throughout.
 *
 * Deliberately does NOT mint or rotate a JWT here: token issuance is
 * apra-fleet-us9.5's own concern (Cloud JWT issuance + apra-fleet join
 * enrollment), not a plain data-CRUD one -- conflating them would mean this
 * "CRUD" slice quietly depends on us9.5's still-undecided signing-key
 * strategy for the hub. createMember() only creates the row; a caller that
 * also needs a token calls into us9.5's issuer separately once it exists.
 *
 * Also does NOT assemble the full dashboard-facing Member view-model
 * (computed lastSeen/lastPrompt/jwtExp/status fields -- see
 * packages/fleet-api-contract/src/schemas/member.ts) -- those require joining
 * presence.ts and relay_queue.ts data, which is HTTP-handler-layer
 * responsibility, not this module's.
 */
import type { Pool } from 'pg';
import { getPool } from './db/pool.js';

export interface MemberRow {
  id: string;
  workspace_id: string;
  machine_id: string | null;
  name: string;
  provider: string;
  work_folder: string | null;
  created_at: string;
}

export interface CreateMemberInput {
  name: string;
  provider: string;
  machineId?: string | null;
  workFolder?: string | null;
}

export async function createMember(
  id: string,
  workspaceId: string,
  input: CreateMemberInput,
  pool: Pool = getPool(),
): Promise<MemberRow> {
  const result = await pool.query<MemberRow>(
    `INSERT INTO members (id, workspace_id, machine_id, name, provider, work_folder)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [id, workspaceId, input.machineId ?? null, input.name, input.provider, input.workFolder ?? null],
  );
  return result.rows[0];
}

export async function listMembers(workspaceId: string, pool: Pool = getPool()): Promise<MemberRow[]> {
  const result = await pool.query<MemberRow>(
    `SELECT * FROM members WHERE workspace_id = $1 ORDER BY created_at`,
    [workspaceId],
  );
  return result.rows;
}

export async function getMember(
  workspaceId: string,
  id: string,
  pool: Pool = getPool(),
): Promise<MemberRow | null> {
  const result = await pool.query<MemberRow>(
    `SELECT * FROM members WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, id],
  );
  return result.rows[0] ?? null;
}

export async function deleteMember(
  workspaceId: string,
  id: string,
  pool: Pool = getPool(),
): Promise<boolean> {
  const result = await pool.query(
    `DELETE FROM members WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, id],
  );
  return (result.rowCount ?? 0) > 0;
}
