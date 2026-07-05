/**
 * Member token issuance + rotation (apra-fleet-us9.5 continuation).
 *
 * The SIGNING mechanism (HS256, hub-jwt.ts) is an explicit MVP stopgap --
 * us9.5's real design is asymmetric signing. The issuance/rotation/
 * revocation STORY here is not a stopgap: it reuses jwt-revocation.ts
 * (already built for apra-fleet-us9.4) exactly as-is, and stays correct
 * once the signing mechanism is swapped out from under it.
 *
 * "apra-fleet join enrollment" (the other half of us9.5's title) is
 * deliberately NOT part of this module -- that's the network-facing
 * bootstrap flow tied to the same trust-boundary question as
 * apra-fleet-fnz.4 (should a spoke be reachable beyond loopback for LAN
 * enrollment?), a policy decision this module doesn't need answered:
 * issuing/rotating a token for an ALREADY-KNOWN member (one already
 * created via POST /ws/:id/members) requires no new network exposure.
 */
import { getMember, setCurrentJti } from './members.js';
import { revoke } from './jwt-revocation.js';
import { sign } from './hub-jwt.js';
import type { Pool } from 'pg';
import { getPool } from './db/pool.js';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** Mints and persists a fresh token for a member that has none yet (or is
 *  getting its very first one at creation time). Does NOT revoke anything
 *  -- there is nothing to revoke on first issuance. */
export async function issueMemberToken(
  workspaceId: string,
  memberId: string,
  pool: Pool = getPool(),
): Promise<string> {
  const { token, jti } = sign({ sub: memberId, ws: workspaceId, role: 'doer' });
  await setCurrentJti(workspaceId, memberId, jti, pool);
  return token;
}

/**
 * Revokes the member's current token (if any) and mints a fresh one.
 * Returns null if the member doesn't exist in this workspace.
 */
export async function rotateMemberToken(
  workspaceId: string,
  memberId: string,
  pool: Pool = getPool(),
): Promise<string | null> {
  const member = await getMember(workspaceId, memberId, pool);
  if (!member) return null;

  if (member.current_jti) {
    // We don't track the old token's exact original expiry separately;
    // revoking it through its own worst-case lifetime (sign()'s own
    // window) is sufficient -- sweepExpired() will clean the row up once
    // that time genuinely passes, and the token is rejected immediately
    // regardless via isRevoked(), well before its natural expiry.
    await revoke(member.current_jti, new Date(Date.now() + SEVEN_DAYS_MS), pool);
  }

  return issueMemberToken(workspaceId, memberId, pool);
}
