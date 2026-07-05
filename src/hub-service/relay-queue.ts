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
  origin_member_id: string | null;
  delivered_at: string | null;
}

/** Defensive per-(workspace_id, target_member_id) queue depth cap
 *  (docs/hub-spoke-wire-protocol.md section 6): exceeding it rejects the
 *  NEWEST admission attempt, never silently drops an older queued item. */
export const MAX_QUEUE_DEPTH = 1000;
export const MAX_QUEUE_BYTES = 8 * 1024 * 1024;

export type EnqueueResult =
  | { ok: true; envelope: RelayEnvelope }
  | { ok: false; reason: 'queue_full' };

/**
 * Admits an envelope. Idempotent on (workspace_id, target_member_id,
 * envelope_id): a retried admission with the same envelope_id is a no-op
 * and returns the ORIGINAL row, never a second deliverable copy.
 *
 * `originMemberId` (nullable) is whoever submitted this envelope --
 * recorded so a TTL expiry (see sweepExpiredToFailures) can address a
 * synthetic failure result back to them.
 */
export async function enqueue(
  workspaceId: string,
  targetMemberId: string,
  envelopeId: string,
  kind: string,
  payload: unknown,
  ttlMs: number,
  pool: Pool = getPool(),
  originMemberId: string | null = null,
): Promise<EnqueueResult> {
  const payloadJson = JSON.stringify(payload);
  // Byte total computed in JS, not SQL (octet_length/length aren't
  // available in pg-mem, the in-memory engine the test suite runs
  // against) -- fine for a soft defensive cap, not a precise billing
  // figure (docs/hub-spoke-wire-protocol.md section 6).
  const depth = await pool.query<{ payload: unknown }>(
    `SELECT payload FROM relay_queue
     WHERE workspace_id = $1 AND target_member_id = $2 AND status IN ('pending', 'delivered')
       AND envelope_id != $3`,
    [workspaceId, targetMemberId, envelopeId],
  );
  const count = depth.rows.length;
  const bytes = depth.rows.reduce((sum, r) => sum + Buffer.byteLength(JSON.stringify(r.payload)), 0);
  if (count >= MAX_QUEUE_DEPTH || bytes + Buffer.byteLength(payloadJson) > MAX_QUEUE_BYTES) {
    return { ok: false, reason: 'queue_full' };
  }

  const inserted = await pool.query<RelayEnvelope>(
    `INSERT INTO relay_queue (workspace_id, target_member_id, envelope_id, kind, payload, ttl_ms, origin_member_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (workspace_id, target_member_id, envelope_id) DO NOTHING
     RETURNING *`,
    [workspaceId, targetMemberId, envelopeId, kind, payloadJson, ttlMs, originMemberId],
  );
  if (inserted.rows[0]) return { ok: true, envelope: inserted.rows[0] };
  const existing = await pool.query<RelayEnvelope>(
    `SELECT * FROM relay_queue WHERE workspace_id = $1 AND target_member_id = $2 AND envelope_id = $3`,
    [workspaceId, targetMemberId, envelopeId],
  );
  return { ok: true, envelope: existing.rows[0] };
}

/** Default per docs/hub-spoke-wire-protocol.md section 5 step 5. */
export const DEFAULT_ACK_TIMEOUT_MS = 10000;

/**
 * FIFO fetch of everything still deliverable to this member -- both
 * never-yet-delivered ('pending') and delivered-but-not-yet-acked
 * ('delivered', once `ackTimeoutMs` has elapsed since the last delivery
 * attempt) envelopes, so a spoke that reconnects after a drop gets the full
 * still-owed set, not just what it never saw. Excludes expired envelopes.
 * Marks every returned row 'delivered' with a fresh `delivered_at`, so a
 * 'delivered'-but-unacked row is not re-served again until another
 * ack_timeout_ms window passes (section 5 step 5's redeliver-on-timeout,
 * not redeliver-on-every-poll).
 *
 * WORKSPACE IRON WALL (apra-fleet-us9.11): the read is scoped by
 * `workspaceId` as well as `target_member_id`. target_member_id alone is NOT
 * a workspace boundary -- a compromised spoke can announce an arbitrary
 * member_id (envelope-routes.ts's handlePresence trusts the announced
 * snapshot), so the /ws/:id/stream route MUST NOT rely on presence membership
 * to keep workspaces apart. Scoping here means even a foreign member_id that
 * lands in this machine's presence view can only ever surface envelopes
 * queued under THIS workspace, never another tenant's queue. This mirrors the
 * write side (enqueue/ack both key on workspace_id + target_member_id) so the
 * wall is symmetric on both read and write.
 */
export async function fetchDeliverable(
  workspaceId: string,
  targetMemberId: string,
  pool: Pool = getPool(),
  ackTimeoutMs: number = DEFAULT_ACK_TIMEOUT_MS,
): Promise<RelayEnvelope[]> {
  const result = await pool.query<RelayEnvelope>(
    `UPDATE relay_queue
     SET status = 'delivered', delivered_at = now()
     WHERE workspace_id = $1
       AND target_member_id = $2
       AND created_at + (ttl_ms::text || ' milliseconds')::interval > now()
       AND (
         status = 'pending'
         OR (status = 'delivered' AND delivered_at + ($3::text || ' milliseconds')::interval <= now())
       )
     RETURNING *`,
    [workspaceId, targetMemberId, ackTimeoutMs],
  );
  return result.rows.sort((a: RelayEnvelope, b: RelayEnvelope) => a.id - b.id);
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
  const result = await pool.query<RelayEnvelope>(
    `UPDATE relay_queue
     SET status = 'expired'
     WHERE status IN ('pending', 'delivered')
       AND created_at + (ttl_ms::text || ' milliseconds')::interval <= now()
     RETURNING *`,
  );
  return result.rowCount ?? 0;
}

/**
 * Request-kind envelopes whose TTL expiry must produce a synthetic failure
 * result back to the originator (docs/hub-spoke-wire-protocol.md section 6)
 * -- mapped to the RESULT kind a caller is actually waiting on via
 * `correlation_id`. Kinds absent from this map (results/acks/broadcasts)
 * are terminal already or explicitly need no catch-up (section 3.1) and
 * are simply expired with no synthetic follow-up.
 */
export const FAILURE_RESULT_KIND: Record<string, string> = {
  'execute_command.request': 'execute_command.result',
  'execute_prompt.request': 'execute_prompt.result',
  'send_message.deliver': 'send_message.ack',
};

/** TTLs for the synthetic failure envelopes themselves, matching each
 *  result kind's own default in docs/hub-spoke-wire-protocol.md section 3.1. */
const FAILURE_TTL_MS: Record<string, number> = {
  'execute_command.result': 60000,
  'execute_prompt.result': 120000,
  'send_message.ack': 15000,
};

/**
 * Sweeps TTL-expired envelopes and, for request kinds with an entry in
 * FAILURE_RESULT_KIND, enqueues a synthetic failure result addressed back
 * to the envelope's origin_member_id (never dropped silently -- a caller
 * blocked on `correlation_id` gets a definite answer). Rows with no
 * origin_member_id (should not normally happen for spoke-submitted
 * envelopes) or an unmapped kind are simply expired with no follow-up.
 * Returns the count of envelopes expired (not the count of synthetic
 * failures generated, which may be fewer).
 */
export async function sweepExpiredToFailures(pool: Pool = getPool()): Promise<number> {
  const result = await pool.query<RelayEnvelope>(
    `UPDATE relay_queue
     SET status = 'expired'
     WHERE status IN ('pending', 'delivered')
       AND created_at + (ttl_ms::text || ' milliseconds')::interval <= now()
     RETURNING *`,
  );
  for (const row of result.rows) {
    const failureKind = FAILURE_RESULT_KIND[row.kind];
    if (!failureKind || !row.origin_member_id) continue;
    await enqueue(
      row.workspace_id,
      row.origin_member_id,
      `${row.envelope_id}.ttl-failed`,
      failureKind,
      { status: 'target_offline_ttl_expired', correlation_id: row.envelope_id },
      FAILURE_TTL_MS[failureKind] ?? 60000,
      pool,
      null,
    );
  }
  return result.rowCount ?? 0;
}
