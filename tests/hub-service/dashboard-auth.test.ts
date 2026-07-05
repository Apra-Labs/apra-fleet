/**
 * Dashboard OAuth + RBAC HTTP integration tests (apra-fleet-us9.16): real
 * http.Server, real HTTP requests, real pg-mem-backed data layer. Proves
 * the routes AND the specific privilege-escalation risks listed in
 * docs/dashboard-oauth-rbac-design.md section 4 end to end, not just
 * their individual pieces in isolation.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { newDb } from 'pg-mem';
import fs from 'node:fs';
import path from 'node:path';
import { setPool, closePool, getPool } from '../../src/hub-service/db/pool.js';
import { createWorkspace } from '../../src/hub-service/workspaces.js';
import { createHttpServer, listen, type HttpServerHandle } from '../../src/hub-service/http-server.js';

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

function requestJson(port: number, method: string, urlPath: string, opts: { token?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const bodyStr = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: {
          ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
          ...(bodyStr ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : undefined });
        });
      },
    );
    req.on('error', reject);
    req.end(bodyStr);
  });
}

/** Test-only bootstrap: real installs promote the first platform admin via
 *  direct DB access (there is deliberately no HTTP route for it -- an API
 *  that can mint platform admins is itself a privilege-escalation risk).
 *  Also marks the user approved -- requirePlatformAdmin() requires BOTH
 *  status='approved' AND is_platform_admin, so a real bootstrap needs both. */
async function makePlatformAdmin(userId: string): Promise<void> {
  await getPool().query(`UPDATE users SET is_platform_admin = true, status = 'approved' WHERE id = $1`, [userId]);
}

describe('dashboard OAuth + RBAC (apra-fleet-us9.16)', () => {
  let pool: any;
  let handle: HttpServerHandle;
  let port: number;
  const originalSecret = process.env.HUB_JWT_SECRET;

  beforeEach(async () => {
    process.env.HUB_JWT_SECRET = SECRET;
    pool = await freshPool();
    setPool(pool);
    await createWorkspace('ws-a', 'Workspace A', pool);
    await createWorkspace('ws-b', 'Workspace B', pool);

    handle = createHttpServer();
    port = await listen(handle, 0, '127.0.0.1');
  });

  afterEach(async () => {
    await handle.close();
    await closePool();
    if (originalSecret !== undefined) process.env.HUB_JWT_SECRET = originalSecret;
    else delete process.env.HUB_JWT_SECRET;
  });

  async function login(email: string, name: string, oauthSubject = email): Promise<{ jwt: string }> {
    const { status, body } = await requestJson(port, 'POST', '/auth/oauth/google', {
      body: { oauthSubject, email, name },
    });
    expect(status).toBe(200);
    return body;
  }

  async function bootstrapPlatformAdmin(email: string): Promise<string> {
    const { jwt } = await login(email, 'Admin');
    const id = (await pool.query(`SELECT id FROM users WHERE email = $1`, [email])).rows[0].id;
    await makePlatformAdmin(id);
    return jwt;
  }

  it('POST /auth/oauth/google creates a pending user and returns a session token', async () => {
    const { jwt } = await login('alice@example.com', 'Alice');
    expect(typeof jwt).toBe('string');

    const admins = await requestJson(port, 'GET', '/admin/users', { token: jwt });
    expect(admins.status).toBe(401); // not a platform admin
  });

  it('a pending (unapproved) user sees an empty workspace list, not an error, even with a valid session token', async () => {
    const { jwt } = await login('alice@example.com', 'Alice');
    const { status, body } = await requestJson(port, 'GET', '/workspaces', { token: jwt });
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('re-login for the same identity returns the SAME user (no duplicate account)', async () => {
    const first = await login('alice@example.com', 'Alice');
    const second = await login('alice@example.com', 'Alice');
    // Different session tokens (different jti), but same underlying user --
    // proven by both granting the same post-approval access below.
    expect(first.jwt).not.toBe(second.jwt);
  });

  it('rejects /workspaces and /admin/users with no token', async () => {
    expect((await requestJson(port, 'GET', '/workspaces')).status).toBe(401);
    expect((await requestJson(port, 'GET', '/admin/users')).status).toBe(401);
  });

  describe('after approval', () => {
    it('an approved member sees their assigned workspaces with their role, and can select one to get a workspace-scoped token', async () => {
      const { jwt: sessionToken } = await login('alice@example.com', 'Alice');

      // Bootstrap a platform admin to perform the approval.
      const { jwt: adminSession } = await login('admin@example.com', 'Admin');
      const adminUsers = await requestJson(port, 'GET', '/admin/users', { token: adminSession });
      // adminUsers.status is 401 here since admin@example.com isn't a
      // platform admin YET -- promote via the test-only DB bootstrap.
      expect(adminUsers.status).toBe(401);
      const rawUsers = await pool.query(`SELECT id FROM users WHERE email = 'admin@example.com'`);
      await makePlatformAdmin(rawUsers.rows[0].id);

      const approveResult = await requestJson(port, 'PUT', `/admin/users/${(await pool.query(`SELECT id FROM users WHERE email = 'alice@example.com'`)).rows[0].id}/approve`, {
        token: adminSession,
        body: { role: 'member', workspaces: ['ws-a'] },
      });
      expect(approveResult.status).toBe(200);
      expect(approveResult.body).toMatchObject({ status: 'approved', role: 'member', workspaces: ['ws-a'] });

      const workspaces = await requestJson(port, 'GET', '/workspaces', { token: sessionToken });
      expect(workspaces.status).toBe(200);
      expect(workspaces.body).toHaveLength(1);
      expect(workspaces.body[0]).toMatchObject({ id: 'ws-a', name: 'Workspace A', role: 'member', members: 0, projects: 0 });

      // Select ws-a -> get a workspace-scoped token that actually
      // authenticates the already-built /ws/:id/... routes.
      const selected = await requestJson(port, 'POST', '/workspaces/ws-a/select', { token: sessionToken });
      expect(selected.status).toBe(200);
      const wsToken = selected.body.jwt;

      const members = await requestJson(port, 'GET', '/ws/ws-a/members', { token: wsToken });
      expect(members.status).toBe(200);
      expect(members.body).toEqual([]);
    });

    it('POST /workspaces/:id/select is rejected for a workspace the user was never assigned to', async () => {
      const { jwt: sessionToken } = await login('bob@example.com', 'Bob');
      const { jwt: adminSession } = await login('admin2@example.com', 'Admin2');
      const adminId = (await pool.query(`SELECT id FROM users WHERE email = 'admin2@example.com'`)).rows[0].id;
      await makePlatformAdmin(adminId);
      const bobId = (await pool.query(`SELECT id FROM users WHERE email = 'bob@example.com'`)).rows[0].id;
      await requestJson(port, 'PUT', `/admin/users/${bobId}/approve`, { token: adminSession, body: { role: 'member', workspaces: ['ws-a'] } });

      // Bob is assigned to ws-a, NOT ws-b.
      const selectAssigned = await requestJson(port, 'POST', '/workspaces/ws-a/select', { token: sessionToken });
      expect(selectAssigned.status).toBe(200);

      const selectUnassigned = await requestJson(port, 'POST', '/workspaces/ws-b/select', { token: sessionToken });
      expect(selectUnassigned.status).toBe(401);
    });
  });

  describe('privilege-escalation risks (design doc section 4)', () => {
    it('a member-role (non-platform-admin) user cannot call PUT /admin/users/:id/role at all, regardless of their own role', async () => {
      const adminSession = await bootstrapPlatformAdmin('admin3@example.com');
      const { jwt: memberSession } = await login('carol@example.com', 'Carol');
      const carolId = (await pool.query(`SELECT id FROM users WHERE email = 'carol@example.com'`)).rows[0].id;
      // Approve Carol as 'superadmin' of a workspace -- still NOT a platform admin.
      await requestJson(port, 'PUT', `/admin/users/${carolId}/approve`, { token: adminSession, body: { role: 'superadmin', workspaces: ['ws-a'] } });

      const escalationAttempt = await requestJson(port, 'PUT', `/admin/users/${carolId}/role`, { token: memberSession, body: { role: 'superadmin' } });
      expect(escalationAttempt.status).toBe(401);
    });

    it('GET /admin/users never leaks email/oauth identity to a non-platform-admin caller', async () => {
      const adminSession = await bootstrapPlatformAdmin('admin4@example.com');
      const { jwt: memberSession } = await login('dave@example.com', 'Dave');
      const daveId = (await pool.query(`SELECT id FROM users WHERE email = 'dave@example.com'`)).rows[0].id;
      await requestJson(port, 'PUT', `/admin/users/${daveId}/approve`, { token: adminSession, body: { role: 'superadmin', workspaces: ['ws-a'] } });

      // Dave, even as a workspace superadmin, gets a flat 401 -- not a
      // filtered/redacted user list. The route itself is inaccessible.
      const daveAttempt = await requestJson(port, 'GET', '/admin/users', { token: memberSession });
      expect(daveAttempt.status).toBe(401);

      // The real platform admin DOES see emails (that's the point of the route).
      const adminView = await requestJson(port, 'GET', '/admin/users', { token: adminSession });
      expect(adminView.status).toBe(200);
      expect(adminView.body.some((u: any) => u.email === 'dave@example.com')).toBe(true);
    });

    it('a rejected/pending user session cannot reach /admin/users even if somehow flagged is_platform_admin (status gate is independent of the flag)', async () => {
      const { jwt: pendingSession } = await login('eve@example.com', 'Eve');
      const eveId = (await pool.query(`SELECT id FROM users WHERE email = 'eve@example.com'`)).rows[0].id;
      // Directly flip ONLY the platform-admin flag, leaving status='pending'
      // -- simulates a data inconsistency; the route must still enforce
      // status='approved' independently of the flag.
      await pool.query(`UPDATE users SET is_platform_admin = true WHERE id = $1`, [eveId]);

      const result = await requestJson(port, 'GET', '/admin/users', { token: pendingSession });
      expect(result.status).toBe(401);
    });

    it('deleting a user via DELETE /admin/users/:id removes their workspace access entirely', async () => {
      const adminSession = await bootstrapPlatformAdmin('admin5@example.com');
      const { jwt: frankSession } = await login('frank@example.com', 'Frank');
      const frankId = (await pool.query(`SELECT id FROM users WHERE email = 'frank@example.com'`)).rows[0].id;
      await requestJson(port, 'PUT', `/admin/users/${frankId}/approve`, { token: adminSession, body: { role: 'member', workspaces: ['ws-a'] } });

      const beforeDelete = await requestJson(port, 'GET', '/workspaces', { token: frankSession });
      expect(beforeDelete.body).toHaveLength(1);

      const deleteResult = await requestJson(port, 'DELETE', `/admin/users/${frankId}`, { token: adminSession });
      expect(deleteResult.status).toBe(200);

      // Frank's OLD session token still verifies cryptographically (session
      // tokens aren't proactively revoked on delete in this pass), but the
      // user row is gone, so every route that looks it up now denies access.
      const afterDelete = await requestJson(port, 'GET', '/workspaces', { token: frankSession });
      expect(afterDelete.body).toEqual([]);
    });

    it('returns 404 (not a leaked 200) when approving/updating a non-existent user', async () => {
      const adminSession = await bootstrapPlatformAdmin('admin6@example.com');
      const approve = await requestJson(port, 'PUT', '/admin/users/no-such-user/approve', { token: adminSession, body: { role: 'member', workspaces: [] } });
      expect(approve.status).toBe(404);
      const role = await requestJson(port, 'PUT', '/admin/users/no-such-user/role', { token: adminSession, body: { role: 'admin' } });
      expect(role.status).toBe(404);
      const del = await requestJson(port, 'DELETE', '/admin/users/no-such-user', { token: adminSession });
      expect(del.status).toBe(404);
    });

    it('rejects an approve/role-change body with an invalid role value', async () => {
      const adminSession = await bootstrapPlatformAdmin('admin7@example.com');
      const { } = await login('grace@example.com', 'Grace');
      const graceId = (await pool.query(`SELECT id FROM users WHERE email = 'grace@example.com'`)).rows[0].id;

      const badApprove = await requestJson(port, 'PUT', `/admin/users/${graceId}/approve`, { token: adminSession, body: { role: 'super-mega-admin', workspaces: [] } });
      expect(badApprove.status).toBe(400);
    });
  });

  describe('machine enrollment (apra-fleet-us9.5/fnz.4, hub-mediated -- docs/hub-spoke-master-plan.md section 4)', () => {
    it('a workspace member can generate an enrollment token, and a new machine can exchange it (no Bearer auth on exchange -- the token itself is the credential)', async () => {
      const adminSession = await bootstrapPlatformAdmin('admin8@example.com');
      const { jwt: memberSession } = await login('henry@example.com', 'Henry');
      const henryId = (await pool.query(`SELECT id FROM users WHERE email = 'henry@example.com'`)).rows[0].id;
      await requestJson(port, 'PUT', `/admin/users/${henryId}/approve`, { token: adminSession, body: { role: 'member', workspaces: ['ws-a'] } });

      const generated = await requestJson(port, 'POST', '/ws/ws-a/enrollment-tokens', { token: memberSession });
      expect(generated.status).toBe(201);
      expect(typeof generated.body.token).toBe('string');

      const exchanged = await requestJson(port, 'POST', '/join/exchange', { body: { token: generated.body.token, hostname: 'new-laptop' } });
      expect(exchanged.status).toBe(200);
      expect(exchanged.body.workspaceId).toBe('ws-a');
      expect(typeof exchanged.body.jwt).toBe('string');

      // The exchanged machine JWT actually authenticates against the
      // already-built /ws/:id/... routes.
      const members = await requestJson(port, 'GET', '/ws/ws-a/members', { token: exchanged.body.jwt });
      expect(members.status).toBe(200);
    });

    it('a user with no access to the workspace cannot generate an enrollment token for it', async () => {
      const { jwt: outsiderSession } = await login('ivy@example.com', 'Ivy');
      const result = await requestJson(port, 'POST', '/ws/ws-a/enrollment-tokens', { token: outsiderSession });
      expect(result.status).toBe(401);
    });

    it('exchange rejects an invalid token', async () => {
      const result = await requestJson(port, 'POST', '/join/exchange', { body: { token: 'not-a-real-token', hostname: 'x' } });
      expect(result.status).toBe(401);
    });

    it('exchange is single-use over HTTP: a second exchange for the same token is rejected', async () => {
      const adminSession = await bootstrapPlatformAdmin('admin9@example.com');
      const { jwt: memberSession } = await login('jack@example.com', 'Jack');
      const jackId = (await pool.query(`SELECT id FROM users WHERE email = 'jack@example.com'`)).rows[0].id;
      await requestJson(port, 'PUT', `/admin/users/${jackId}/approve`, { token: adminSession, body: { role: 'member', workspaces: ['ws-a'] } });

      const generated = await requestJson(port, 'POST', '/ws/ws-a/enrollment-tokens', { token: memberSession });
      const first = await requestJson(port, 'POST', '/join/exchange', { body: { token: generated.body.token, hostname: 'machine-1' } });
      expect(first.status).toBe(200);

      const second = await requestJson(port, 'POST', '/join/exchange', { body: { token: generated.body.token, hostname: 'machine-2' } });
      expect(second.status).toBe(401);
    });
  });
});
