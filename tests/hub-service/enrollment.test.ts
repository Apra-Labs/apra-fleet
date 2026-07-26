/**
 * Enrollment-token proof (apra-fleet-us9.5 continuation / apra-fleet-fnz.4)
 * via pg-mem: executes the real migration files and the real
 * enrollment.ts queries. Covers single-use atomicity (the core safety
 * property of a bootstrap credential) and expiry.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import fs from 'node:fs';
import path from 'node:path';
import { setPool, closePool } from '../../src/hub-service/db/pool.js';
import { createWorkspace } from '../../src/hub-service/workspaces.js';
import { generateEnrollmentToken, exchangeEnrollmentToken } from '../../src/hub-service/enrollment.js';
import { verify } from '../../src/hub-service/hub-jwt.js';
import { getMachine } from '../../src/hub-service/machines.js';

const SECRET = 'test-hub-secret';

async function freshPool() {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  db.public.registerFunction({ name: 'now', returns: 'timestamptz' as any, implementation: () => new Date() });
  const { Pool } = db.adapters.createPg();
  const p = new Pool();
  const migrationsDir = path.join(process.cwd(), 'db', 'migrations');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    const rawSql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    const sql = rawSql.replace(/CREATE UNLOGGED TABLE/gi, 'CREATE TABLE');
    await p.query(sql);
  }
  return p;
}

describe('enrollment (pg-mem, real SQL engine, no Docker required)', () => {
  let pool: any;
  const originalSecret = process.env.HUB_JWT_SECRET;

  beforeEach(async () => {
    process.env.HUB_JWT_SECRET = SECRET;
    pool = await freshPool();
    setPool(pool);
    await createWorkspace('ws-test', 'Test Workspace', pool);
  });

  afterEach(async () => {
    await closePool();
    if (originalSecret !== undefined) process.env.HUB_JWT_SECRET = originalSecret;
    else delete process.env.HUB_JWT_SECRET;
  });

  it('generates a token scoped to a workspace with a future expiry', async () => {
    const { token, expiresAt } = await generateEnrollmentToken('ws-test', 15 * 60 * 1000, pool);
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(20);
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('exchanges a valid token for a machine JWT scoped to the right workspace, and registers the machine', async () => {
    const { token } = await generateEnrollmentToken('ws-test', 15 * 60 * 1000, pool);
    const result = await exchangeEnrollmentToken(token, 'new-laptop', pool);

    expect(result).not.toBeNull();
    expect(result!.workspaceId).toBe('ws-test');

    const claims = verify(result!.jwt, SECRET);
    expect(claims).toMatchObject({ sub: result!.machineId, ws: 'ws-test', role: 'spoke' });

    const machine = await getMachine('ws-test', result!.machineId, pool);
    expect(machine?.hostname).toBe('new-laptop');
  });

  it('a token is single-use: a second exchange attempt for the same token fails', async () => {
    const { token } = await generateEnrollmentToken('ws-test', 15 * 60 * 1000, pool);

    const first = await exchangeEnrollmentToken(token, 'machine-1', pool);
    expect(first).not.toBeNull();

    const second = await exchangeEnrollmentToken(token, 'machine-2', pool);
    expect(second).toBeNull();
  });

  it('rejects an unknown token', async () => {
    expect(await exchangeEnrollmentToken('not-a-real-token', 'machine-1', pool)).toBeNull();
  });

  it('rejects an expired token', async () => {
    // Generate with a negative TTL, so expires_at is already in the past --
    // avoids vi.useFakeTimers(), which was observed to hang pg-mem's async
    // Pool operations during this test's own development.
    const { token } = await generateEnrollmentToken('ws-test', -1000, pool);
    expect(await exchangeEnrollmentToken(token, 'machine-1', pool)).toBeNull();
  });

  it('two concurrent exchange attempts for the same token: exactly one succeeds (atomic claim, not a check-then-act race)', async () => {
    const { token } = await generateEnrollmentToken('ws-test', 15 * 60 * 1000, pool);

    const [a, b] = await Promise.all([
      exchangeEnrollmentToken(token, 'racer-a', pool),
      exchangeEnrollmentToken(token, 'racer-b', pool),
    ]);

    const successes = [a, b].filter(r => r !== null);
    expect(successes).toHaveLength(1);
  });

  it('a token generated for one workspace cannot be exchanged into a JWT for a different workspace', async () => {
    await createWorkspace('ws-other', 'Other', pool);
    const { token } = await generateEnrollmentToken('ws-test', 15 * 60 * 1000, pool);

    const result = await exchangeEnrollmentToken(token, 'machine-1', pool);
    expect(result!.workspaceId).toBe('ws-test');
    expect(result!.workspaceId).not.toBe('ws-other');
  });
});
