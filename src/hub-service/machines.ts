/**
 * Machine CRUD (apra-fleet-us9.4), data-layer only. Scoped by workspace_id
 * throughout -- the same tenant boundary as everything else in the hub
 * schema (docs/adr-hub-persistence.md).
 */
import type { Pool } from 'pg';
import { getPool } from './db/pool.js';

export interface MachineRow {
  id: string;
  workspace_id: string;
  hostname: string;
  created_at: string;
}

export async function registerMachine(
  id: string,
  workspaceId: string,
  hostname: string,
  pool: Pool = getPool(),
): Promise<MachineRow> {
  const result = await pool.query<MachineRow>(
    `INSERT INTO machines (id, workspace_id, hostname) VALUES ($1, $2, $3) RETURNING *`,
    [id, workspaceId, hostname],
  );
  return result.rows[0];
}

export async function listMachines(workspaceId: string, pool: Pool = getPool()): Promise<MachineRow[]> {
  const result = await pool.query<MachineRow>(
    `SELECT * FROM machines WHERE workspace_id = $1 ORDER BY created_at`,
    [workspaceId],
  );
  return result.rows;
}

export async function getMachine(
  workspaceId: string,
  id: string,
  pool: Pool = getPool(),
): Promise<MachineRow | null> {
  const result = await pool.query<MachineRow>(
    `SELECT * FROM machines WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, id],
  );
  return result.rows[0] ?? null;
}
