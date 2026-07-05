/**
 * Envelope submission (apra-fleet-us9.6 slice 1): the spoke -> hub half of
 * docs/hub-spoke-wire-protocol.md. Routes a single submitted envelope by
 * `kind` to presence tracking (presence.ts) or the at-least-once relay
 * queue (relay-queue.ts). Pure logic, HTTP-framework-agnostic, so it can be
 * unit tested directly and wired into http-server.ts as a thin adapter.
 *
 * Deliberately NOT yet implemented here (future slices, not silently
 * dropped): the SSE delivery stream (hub -> spoke push, wire-protocol.md
 * section 5 step 4), synthetic `<kind>.failed` generation on TTL expiry
 * (section 6), and per-member queue depth cap (section 6) -- this slice
 * covers admission only: presence upsert and relay-queue enqueue, both of
 * which are independently useful and testable before the push/expiry
 * machinery exists.
 */
import type { Pool } from 'pg';
import type { HubJwtClaims } from './hub-jwt.js';
import { announceSnapshot, announce } from './presence.js';
import { enqueue } from './relay-queue.js';
import { getMember } from './members.js';
import { getPool } from './db/pool.js';

/** Default TTLs per docs/hub-spoke-wire-protocol.md section 3.1. Presence
 *  kinds are intentionally absent -- they are never queued. */
export const DEFAULT_TTL_MS: Record<string, number> = {
  'execute_command.request': 30000,
  'execute_command.result': 60000,
  'execute_command.long_running_update': 60000,
  'send_message.deliver': 15000,
  'send_message.ack': 15000,
  'execute_prompt.request': 30000,
  'execute_prompt.result': 120000,
  'event.broadcast': 5000,
};

const PRESENCE_KINDS = new Set(['presence.announce', 'presence.heartbeat']);

/** Heartbeat interval assumed by the hub (section 4): 15s + 5s grace. */
const NEXT_HEARTBEAT_DUE_MS = 20000;

export interface EnvelopeFromTo {
  machine_id: string | null;
  member_id: string | null;
}

export interface InboundEnvelope {
  envelope_id: string;
  workspace_id: string;
  kind: string;
  from: EnvelopeFromTo;
  to: EnvelopeFromTo;
  ttl_ms?: number | null;
  payload?: unknown;
}

export interface SubmitResult {
  status: number;
  body: unknown;
}

/**
 * Handles one submitted envelope. `claims` is the already-verified machine
 * JWT for the submitting spoke -- its workspace_id is authoritative; a
 * mismatch against the envelope's own workspace_id is rejected (400), never
 * silently corrected (wire-protocol.md section 3).
 */
export async function submitEnvelope(
  claims: HubJwtClaims,
  env: InboundEnvelope,
  pool: Pool = getPool(),
): Promise<SubmitResult> {
  if (env.workspace_id !== claims.workspace_id) {
    return { status: 400, body: { error: 'workspace_id does not match bearer token' } };
  }

  if (PRESENCE_KINDS.has(env.kind)) {
    return handlePresence(claims, env, pool);
  }

  if (!(env.kind in DEFAULT_TTL_MS)) {
    return { status: 400, body: { error: `unknown envelope kind: ${env.kind}` } };
  }

  return handleRelay(claims, env, pool);
}

async function handlePresence(claims: HubJwtClaims, env: InboundEnvelope, pool: Pool): Promise<SubmitResult> {
  // A machine-level JWT's `member_id` claim IS the machine_id (hub-jwt.ts:
  // machine tokens are minted via enrollment.ts's exchangeEnrollmentToken
  // with member_id set to the new machine's id -- there is no separate
  // machine_id claim).
  const machineId = claims.member_id;
  if (env.kind === 'presence.announce') {
    const members = (env.payload as { members?: Array<{ member_id: string; status: string }> } | undefined)?.members ?? [];
    await announceSnapshot(machineId, members.map((m) => ({ memberId: m.member_id, status: m.status })), pool);
  } else {
    // presence.heartbeat: cheap liveness ping, no member snapshot -- only
    // renews last_seen for members already known via a prior announce.
    const memberId = env.from.member_id;
    if (memberId) await announce(machineId, memberId, 'online', pool);
  }
  return { status: 200, body: { kind: 'presence.ack', payload: { next_heartbeat_due_ms: NEXT_HEARTBEAT_DUE_MS } } };
}

async function handleRelay(claims: HubJwtClaims, env: InboundEnvelope, pool: Pool): Promise<SubmitResult> {
  if (env.to.member_id) {
    const target = await getMember(claims.workspace_id, env.to.member_id, pool);
    if (!target) {
      return { status: 403, body: { error: 'target member does not resolve in this workspace' } };
    }
  } else {
    return { status: 400, body: { error: 'relay envelope requires to.member_id' } };
  }

  const ttlMs = env.ttl_ms ?? DEFAULT_TTL_MS[env.kind];
  const row = await enqueue(claims.workspace_id, env.to.member_id, env.envelope_id, env.kind, env.payload, ttlMs, pool);
  return { status: 202, body: { envelope_id: row.envelope_id, status: row.status } };
}
