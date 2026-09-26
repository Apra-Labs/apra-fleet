/**
 * JWT revocation proof (apra-fleet-us9.4) via pg-mem: executes the real
 * migration file and the real jwt-revocation.ts queries, unmodified,
 * against an in-memory Postgres-compatible engine.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import fs from 'node:fs';
import path from 'node:path';
import { setPool, closePool } from '../../src/hub-service/db/pool.js';
import { revoke, isRevoked, sweepExpired } from '../../src/hub-service/jwt-revocation.js';

let pool: any;

async function freshPool() {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  db.public.registerFunction({ name: 'now', returns: 'timestamptz' as any, implementation: () => new Date() });
  const { Pool } = db.adapters.createPg();
  const p = new Pool();
  const migrationPath = path.join(process.cwd(), 'db', 'migrations', '001_hub_service_schema.sql');
  const rawSql = fs.readFileSync(migrationPath, 'utf8');
  const sql = rawSql.replace(/CREATE UNLOGGED TABLE/gi, 'CREATE TABLE');
  await p.query(sql);
  return p;
}

describe('jwt-revocation (pg-mem, real SQL engine, no Docker required)', () => {
  beforeEach(async () => {
    pool = await freshPool();
    setPool(pool);
  });

  afterEach(async () => {
    await closePool();
  });

  it('a never-revoked jti is not revoked', async () => {
    expect(await isRevoked('jti-never-revoked', pool)).toBe(false);
  });

  it('revoking a jti makes subsequent lookups report it revoked', async () => {
    const future = new Date(Date.now() + 60_000);
    await revoke('jti-1', future, pool);
    expect(await isRevoked('jti-1', pool)).toBe(true);
  });

  it('revoking the same jti twice is idempotent (no duplicate-key error)', async () => {
    const future = new Date(Date.now() + 60_000);
    await revoke('jti-2', future, pool);
    await expect(revoke('jti-2', future, pool)).resolves.not.toThrow();
    expect(await isRevoked('jti-2', pool)).toBe(true);
  });

  it('sweepExpired drops revocation rows past their own expiry, leaving live ones', async () => {
    const past = new Date(Date.now() - 1000);
    const future = new Date(Date.now() + 60_000);
    await revoke('jti-expired', past, pool);
    await revoke('jti-live', future, pool);

    const swept = await sweepExpired(pool);
    expect(swept).toBeGreaterThanOrEqual(1);

    expect(await isRevoked('jti-expired', pool)).toBe(false);
    expect(await isRevoked('jti-live', pool)).toBe(true);
  });
});
