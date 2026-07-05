/**
 * Machine enrollment-token generation + exchange (apra-fleet-us9.5
 * continuation / apra-fleet-fnz.4, re-scoped per
 * docs/hub-spoke-master-plan.md section 4). Hub-mediated, NOT peer-to-peer
 * LAN: a new machine's `apra-fleet join <token>` calls this hub directly
 * (already network-facing by design) -- no local machine needs to accept
 * any inbound connection for this flow, so it is unaffected by the
 * loopback-only bind decision on apra-fleet.exe (docs/paths.ts's
 * APRA_FLEET_HOST).
 *
 * Tokens are short-lived, single-use, and workspace-scoped. Exchange is
 * atomic (UPDATE ... WHERE used_at IS NULL, checked via rowCount) to
 * close the replay/race window between "check unused" and "mark used".
 */
import crypto from 'node:crypto';
import type { Pool } from 'pg';
import { getPool } from './db/pool.js';
import { registerMachine } from './machines.js';
import { sign as signHubJwt } from './hub-jwt.js';

const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 minutes -- short-lived by design

export interface EnrollmentTokenRow {
  token: string;
  workspace_id: string;
  role: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
}

export async function generateEnrollmentToken(
  workspaceId: string,
  ttlMs: number = DEFAULT_TTL_MS,
  pool: Pool = getPool(),
): Promise<{ token: string; expiresAt: string }> {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + ttlMs);
  await pool.query(
    `INSERT INTO enrollment_tokens (token, workspace_id, expires_at) VALUES ($1, $2, $3)`,
    [token, workspaceId, expiresAt.toISOString()],
  );
  return { token, expiresAt: expiresAt.toISOString() };
}

export interface ExchangeResult {
  machineId: string;
  workspaceId: string;
  jwt: string;
}

/**
 * Redeems a token for a machine JWT: validates it exists, is unexpired,
 * and unused (atomically claiming it in the same statement -- a second
 * concurrent exchange attempt for the same token loses the race and gets
 * null, never a second valid machine/JWT pair). Registers the machine and
 * mints its JWT (hub-jwt.ts's existing shape, member_id slot repurposed to
 * hold machine_id -- see session-jwt.ts's header comment on the
 * not-yet-reconciled claim-shape family).
 */
export async function exchangeEnrollmentToken(
  token: string,
  hostname: string,
  pool: Pool = getPool(),
): Promise<ExchangeResult | null> {
  const claimed = await pool.query<EnrollmentTokenRow>(
    `UPDATE enrollment_tokens
     SET used_at = now()
     WHERE token = $1 AND used_at IS NULL AND expires_at > now()
     RETURNING *`,
    [token],
  );
  const row = claimed.rows[0];
  if (!row) return null;

  const machineId = crypto.randomUUID();
  await registerMachine(machineId, row.workspace_id, hostname, pool);
  const { token: jwt } = signHubJwt({ member_id: machineId, workspace_id: row.workspace_id, role: row.role });

  return { machineId, workspaceId: row.workspace_id, jwt };
}
