/**
 * Member token issuance/rotation proof (apra-fleet-us9.5 continuation) via
 * pg-mem: executes the real migration files and the real member-tokens.ts/
 * hub-jwt.ts/jwt-revocation.ts code together, unmodified.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import fs from 'node:fs';
import path from 'node:path';
import { setPool, closePool } from '../../src/hub-service/db/pool.js';
import { createWorkspace } from '../../src/hub-service/workspaces.js';
import { createMember, getMember } from '../../src/hub-service/members.js';
import { issueMemberToken, rotateMemberToken } from '../../src/hub-service/member-tokens.js';
import { verify } from '../../src/hub-service/hub-jwt.js';
import { isRevoked } from '../../src/hub-service/jwt-revocation.js';

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

describe('member-tokens (pg-mem, real SQL engine, no Docker required)', () => {
  let pool: any;
  const originalSecret = process.env.HUB_JWT_SECRET;

  beforeEach(async () => {
    process.env.HUB_JWT_SECRET = SECRET;
    pool = await freshPool();
    setPool(pool);
    await createWorkspace('ws-test', 'Test Workspace', pool);
    await createMember('mem-1', 'ws-test', { name: 'alice', provider: 'claude' }, pool);
  });

  afterEach(async () => {
    await closePool();
    if (originalSecret !== undefined) process.env.HUB_JWT_SECRET = originalSecret;
    else delete process.env.HUB_JWT_SECRET;
  });

  it('issueMemberToken mints a valid token and persists its jti on the member row', async () => {
    const token = await issueMemberToken('ws-test', 'mem-1', pool);
    const claims = verify(token, SECRET);
    expect(claims).toMatchObject({ sub: 'mem-1', ws: 'ws-test' });

    const member = await getMember('ws-test', 'mem-1', pool);
    expect(member?.current_jti).toBe(claims!.jti);
  });

  it('rotateMemberToken revokes the OLD jti and mints a genuinely new token', async () => {
    const firstToken = await issueMemberToken('ws-test', 'mem-1', pool);
    const firstClaims = verify(firstToken, SECRET)!;

    const secondToken = await rotateMemberToken('ws-test', 'mem-1', pool);
    expect(secondToken).not.toBeNull();
    expect(secondToken).not.toBe(firstToken);

    // The old token's jti is now revoked -- verify() itself doesn't check
    // revocation (that's an auth-gate concern, see http-server.ts), but
    // isRevoked() must report it.
    expect(await isRevoked(firstClaims.jti, pool)).toBe(true);

    const secondClaims = verify(secondToken!, SECRET)!;
    expect(await isRevoked(secondClaims.jti, pool)).toBe(false);

    const member = await getMember('ws-test', 'mem-1', pool);
    expect(member?.current_jti).toBe(secondClaims.jti);
  });

  it('rotateMemberToken on a member with no prior token just issues one (nothing to revoke)', async () => {
    const token = await rotateMemberToken('ws-test', 'mem-1', pool);
    expect(token).not.toBeNull();
    expect(verify(token!, SECRET)).toMatchObject({ sub: 'mem-1' });
  });

  it('rotateMemberToken returns null for a non-existent member', async () => {
    expect(await rotateMemberToken('ws-test', 'no-such-member', pool)).toBeNull();
  });

  it('rotateMemberToken returns null for a member that exists but in a DIFFERENT workspace', async () => {
    await createWorkspace('ws-other', 'Other', pool);
    await createMember('mem-cross', 'ws-other', { name: 'eve', provider: 'claude' }, pool);
    expect(await rotateMemberToken('ws-test', 'mem-cross', pool)).toBeNull();
  });

  it('rotating twice revokes each successive jti, leaving only the latest valid', async () => {
    const token1 = await issueMemberToken('ws-test', 'mem-1', pool);
    const token2 = await rotateMemberToken('ws-test', 'mem-1', pool);
    const token3 = await rotateMemberToken('ws-test', 'mem-1', pool);

    const jti1 = verify(token1, SECRET)!.jti;
    const jti2 = verify(token2!, SECRET)!.jti;
    const jti3 = verify(token3!, SECRET)!.jti;

    expect(await isRevoked(jti1, pool)).toBe(true);
    expect(await isRevoked(jti2, pool)).toBe(true);
    expect(await isRevoked(jti3, pool)).toBe(false);
  });
});
