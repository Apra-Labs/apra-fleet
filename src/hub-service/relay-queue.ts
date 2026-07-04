/**
 * At-least-once message relay (apra-fleet-us9.4), backed by the
 * `relay_queue` Postgres table (docs/adr-hub-persistence.md). This is the
 * single most important correctness property in the hub MVP: a briefly
 * disconnected spoke must not silently lose a queued execute_command
 * (docs/hub-spoke-master-plan.md section 6; docs/hub-spoke-wire-protocol.md
 * sections 5-6).
 *
 * State machine: pending -> delivered -> acked (terminal), or -> expired
 * (terminal, TTL swept). "delivered but not yet acked" is intentionally
 * re-served on every fetch -- redeliver-until-acked, not deliver-once.
 * envelope_id is unique per (workspace_id, target_member_id): re-admitting
 * the same envelope_id (a spoke retry after a dropped ack) is a no-op, not
 * a duplicate deliverable.
 */
import type { Pool } from 'pg';
import { getPool } from './db/pool.js';

export interface RelayEnvelope {
  id: number;
  workspace_id: string;
  target_member_id: string;
  envelope_id: string;
  kind: string;
  payload: unknown;
  status: 'pending' | 'delivered' | 'acked' | 'expired';
  created_at: string;
  ttl_ms: number;
  acked_at: string | null;
}

/**
 * Admits an envelope. Idempotent on (workspace_id, target_member_id,
 * envelope_id): a retried admission with the same envelope_id is a no-op
 * and returns the ORIGINAL row, never a second deliverable copy.
 */
export async function enqueue(
  workspaceId: string,
  targetMemberId: string,
  envelopeId: string,
  kind: string,
  payload: unknown,
  ttlMs: number,
  pool: Pool = getPool(),
): Promise<RelayEnvelope> {
  const inserted = await pool.query<RelayEnvelope>(
    `INSERT INTO relay_queue (workspace_id, target_member_id, envelope_id, kind, payload, ttl_ms)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (workspace_id, target_member_id, envelope_id) DO NOTHING
     RETURNING *`,
    [workspaceId, targetMemberId, envelopeId, kind, JSON.stringify(payload), ttlMs],
  );
  if (inserted.rows[0]) return inserted.rows[0];
  const existing = await pool.query<RelayEnvelope>(
    `SELECT * FROM relay_queue WHERE workspace_id = $1 AND target_member_id = $2 AND envelope_id = $3`,
    [workspaceId, targetMemberId, envelopeId],
  );
  return existing.rows[0];
}

/**
 * FIFO fetch of everything still deliverable to this member -- both
 * never-yet-delivered ('pending') and delivered-but-not-acked ('delivered')
 * envelopes, so a spoke that reconnects after a drop gets the full
 * still-owed set, not just what it never saw. Excludes expired envelopes.
 * Marks any 'pending' row fetched here as 'delivered' (idempotent: fetching
 * an already-'delivered' row leaves it 'delivered').
 */
export async function fetchDeliverable(
  targetMemberId: string,
  pool: Pool = getPool(),
): Promise<RelayEnvelope[]> {
  const result = await pool.query<RelayEnvelope>(
    `UPDATE relay_queue
     SET status = 'delivered'
     WHERE target_member_id = $1
       AND status IN ('pending', 'delivered')
       AND created_at + (ttl_ms::text || ' milliseconds')::interval > now()
     RETURNING *`,
    [targetMemberId],
  );
  return result.rows.sort((a, b) => a.id - b.id);
}

/**
 * Retires an envelope. Idempotent: acking an already-acked or
 * already-expired envelope is a no-op, not an error.
 */
export async function ack(
  workspaceId: string,
  targetMemberId: string,
  envelopeId: string,
  pool: Pool = getPool(),
): Promise<void> {
  await pool.query(
    `UPDATE relay_queue
     SET status = 'acked', acked_at = now()
     WHERE workspace_id = $1 AND target_member_id = $2 AND envelope_id = $3
       AND status IN ('pending', 'delivered')`,
    [workspaceId, targetMemberId, envelopeId],
  );
}

/** TTL sweep: moves anything past its deadline (measured from hub admission
 *  time, never the originator's own timestamp) to the terminal 'expired'
 *  state so it stops being served by fetchDeliverable. */
export async function sweepExpired(pool: Pool = getPool()): Promise<number> {
  const result = await pool.query(
    `UPDATE relay_queue
     SET status = 'expired'
     WHERE status IN ('pending', 'delivered')
       AND created_at + (ttl_ms::text || ' milliseconds')::interval <= now()`,
  );
  return result.rowCount ?? 0;
}
