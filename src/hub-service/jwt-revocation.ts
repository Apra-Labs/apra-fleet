/**
 * JWT revocation lookup (apra-fleet-us9.4), backed by the `revoked_tokens`
 * table (docs/adr-hub-persistence.md "Option A: Postgres-only" -- a plain
 * indexed table is not meaningfully different from a Redis TTL-keyed set
 * at this access pattern and scale).
 *
 * Every authenticated request does a point lookup by jti before trusting a
 * token's claims; revoke() is called on logout / explicit token
 * invalidation. expires_at mirrors the token's own exp so sweepExpired can
 * drop rows once the token would have expired naturally anyway (no need to
 * remember revocations forever).
 */
import type { Pool } from 'pg';
import { getPool } from './db/pool.js';

/** Records a jti as revoked. Idempotent: revoking an already-revoked jti is a no-op. */
export async function revoke(
  jti: string,
  expiresAt: Date,
  pool: Pool = getPool(),
): Promise<void> {
  await pool.query(
    `INSERT INTO revoked_tokens (jti, expires_at)
     VALUES ($1, $2)
     ON CONFLICT (jti) DO NOTHING`,
    [jti, expiresAt.toISOString()],
  );
}

/** Point lookup used on every authenticated request. */
export async function isRevoked(jti: string, pool: Pool = getPool()): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM revoked_tokens WHERE jti = $1`,
    [jti],
  );
  return result.rows.length > 0;
}

/** Drops revocation rows for tokens that would have expired naturally anyway. */
export async function sweepExpired(pool: Pool = getPool()): Promise<number> {
  const result = await pool.query(
    `DELETE FROM revoked_tokens WHERE expires_at <= now()`,
  );
  return result.rowCount ?? 0;
}
