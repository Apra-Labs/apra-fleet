/**
 * Presence tracking (apra-fleet-us9.4), backed by the UNLOGGED `presence`
 * table (docs/adr-hub-persistence.md "presence is UNLOGGED" decision).
 * Losing this table on a hard crash is an accepted tradeoff: spokes
 * reconnect and re-announce as the normal recovery path, so there is no
 * durability requirement here.
 */
import type { Pool } from 'pg';
import { getPool } from './db/pool.js';

export interface PresenceRow {
  machine_id: string;
  member_id: string;
  status: string;
  last_seen: string;
}

/**
 * Upserts a member's presence for a machine. Called on every heartbeat /
 * status change from a spoke -- idempotent by (machine_id, member_id).
 */
export async function announce(
  machineId: string,
  memberId: string,
  status: string,
  pool: Pool = getPool(),
): Promise<void> {
  await pool.query(
    `INSERT INTO presence (machine_id, member_id, status, last_seen)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (machine_id, member_id)
     DO UPDATE SET status = $3, last_seen = now()`,
    [machineId, memberId, status],
  );
}

/** Reads current presence for every member on a machine. */
export async function listForMachine(
  machineId: string,
  pool: Pool = getPool(),
): Promise<PresenceRow[]> {
  const result = await pool.query<PresenceRow>(
    `SELECT * FROM presence WHERE machine_id = $1 ORDER BY member_id`,
    [machineId],
  );
  return result.rows;
}

/**
 * A member is considered stale (likely disconnected without a clean
 * announce) if its last_seen is older than staleMs. Callers use this to
 * decide whether to still trust a cached "online" status.
 */
export async function isStale(
  machineId: string,
  memberId: string,
  staleMs: number,
  pool: Pool = getPool(),
): Promise<boolean> {
  const result = await pool.query<{ stale: boolean }>(
    `SELECT (last_seen + ($3::text || ' milliseconds')::interval <= now()) AS stale
     FROM presence WHERE machine_id = $1 AND member_id = $2`,
    [machineId, memberId, staleMs],
  );
  if (result.rows.length === 0) return true;
  return result.rows[0].stale;
}
