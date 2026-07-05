/**
 * Hub HTTP server integration test (apra-fleet-us9.4): real http.Server,
 * real HTTP requests, real pg-mem-backed data layer underneath -- proving
 * the routes, auth gate, and workspace-boundary enforcement all work
 * end-to-end, not just their individual pieces in isolation.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { newDb } from 'pg-mem';
import fs from 'node:fs';
import path from 'node:path';
import { setPool, closePool } from '../../src/hub-service/db/pool.js';
import { createWorkspace } from '../../src/hub-service/workspaces.js';
import { createHttpServer, listen, type HttpServerHandle } from '../../src/hub-service/http-server.js';
import { sign } from '../../src/hub-service/hub-jwt.js';

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

function requestJson(port: number, method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const bodyStr = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
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

describe('hub http-server (apra-fleet-us9.4)', () => {
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

  it('GET /health returns ok with no auth required', async () => {
    const { status, body } = await requestJson(port, 'GET', '/health');
    expect(status).toBe(200);
    expect(body).toEqual({ status: 'ok' });
  });

  it('GET /installers returns the installer list with no auth required', async () => {
    const { status, body } = await requestJson(port, 'GET', '/installers');
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
  });

  it('rejects /ws/:id/members with no token', async () => {
    const { status, body } = await requestJson(port, 'GET', '/ws/ws-a/members');
    expect(status).toBe(401);
    expect(body.error).toBeDefined();
  });

  it('rejects /ws/:id/members when the token\'s workspace_id does not match the path (the iron wall)', async () => {
    const tokenForB = sign({ member_id: 'm-1', workspace_id: 'ws-b', role: 'doer' }, SECRET);
    const { status } = await requestJson(port, 'GET', '/ws/ws-a/members', { token: tokenForB });
    expect(status).toBe(401);
  });

  it('creates and lists members for the correctly-scoped workspace', async () => {
    const token = sign({ member_id: 'm-1', workspace_id: 'ws-a', role: 'doer' }, SECRET);

    const created = await requestJson(port, 'POST', '/ws/ws-a/members', {
      token,
      body: { name: 'alice', provider: 'claude', folder: '/srv/alice' },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ workspace_id: 'ws-a', name: 'alice', provider: 'claude' });

    const listed = await requestJson(port, 'GET', '/ws/ws-a/members', { token });
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(1);
    // GET returns the joined dashboard view-model (member-view.ts), not the
    // raw CRUD row -- status/lastSeen only exist on the assembled view.
    expect(listed.body[0]).toMatchObject({ name: 'alice', provider: 'claude', status: 'awaiting-connect', lastSeen: null });
  });

  it('a member created in workspace A is invisible when listing workspace B (cross-tenant isolation)', async () => {
    const tokenA = sign({ member_id: 'm-1', workspace_id: 'ws-a', role: 'doer' }, SECRET);
    const tokenB = sign({ member_id: 'm-2', workspace_id: 'ws-b', role: 'doer' }, SECRET);

    await requestJson(port, 'POST', '/ws/ws-a/members', { token: tokenA, body: { name: 'alice', provider: 'claude' } });

    const listedB = await requestJson(port, 'GET', '/ws/ws-b/members', { token: tokenB });
    expect(listedB.body).toEqual([]);
  });

  it('rejects a POST with missing required fields', async () => {
    const token = sign({ member_id: 'm-1', workspace_id: 'ws-a', role: 'doer' }, SECRET);
    const { status, body } = await requestJson(port, 'POST', '/ws/ws-a/members', { token, body: { name: 'alice' } });
    expect(status).toBe(400);
    expect(body.error).toBeDefined();
  });

  it('returns 404 for an unknown route', async () => {
    const { status } = await requestJson(port, 'GET', '/not-a-real-route');
    expect(status).toBe(404);
  });

  it('creates, lists, updates, and deletes a project, and rejects cross-workspace access', async () => {
    const tokenA = sign({ member_id: 'm-1', workspace_id: 'ws-a', role: 'doer' }, SECRET);
    const tokenB = sign({ member_id: 'm-2', workspace_id: 'ws-b', role: 'doer' }, SECRET);

    const created = await requestJson(port, 'POST', '/ws/ws-a/projects', { token: tokenA, body: { name: 'Fleet Dashboard' } });
    expect(created.status).toBe(201);
    const projectId = created.body.id;

    const listed = await requestJson(port, 'GET', '/ws/ws-a/projects', { token: tokenA });
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0]).toMatchObject({ name: 'Fleet Dashboard', status: 'active', members: [] });

    // Cross-workspace: ws-b's token cannot see ws-a's project, and can't
    // reach it even via its own (valid-for-ws-b) token, since the resource
    // genuinely doesn't exist under ws-b -- 404, not a leaked 200.
    const listedCross = await requestJson(port, 'GET', '/ws/ws-b/projects', { token: tokenB });
    expect(listedCross.body).toEqual([]);
    const patchCrossOwnWorkspace = await requestJson(port, 'PATCH', `/ws/ws-b/projects/${projectId}`, { token: tokenB, body: { status: 'paused' } });
    expect(patchCrossOwnWorkspace.status).toBe(404);
    // ws-a's own project cannot be touched with a token minted for ws-b at all.
    const patchWrongToken = await requestJson(port, 'PATCH', `/ws/ws-a/projects/${projectId}`, { token: tokenB, body: { status: 'paused' } });
    expect(patchWrongToken.status).toBe(401);

    const patched = await requestJson(port, 'PATCH', `/ws/ws-a/projects/${projectId}`, { token: tokenA, body: { status: 'paused' } });
    expect(patched.status).toBe(200);
    expect(patched.body.status).toBe('paused');

    const deleted = await requestJson(port, 'DELETE', `/ws/ws-a/projects/${projectId}`, { token: tokenA });
    expect(deleted.status).toBe(200);
    expect((await requestJson(port, 'GET', '/ws/ws-a/projects', { token: tokenA })).body).toEqual([]);
  });

  it('adds a member to a project via POST /ws/:id/projects/:pid/members', async () => {
    const token = sign({ member_id: 'm-1', workspace_id: 'ws-a', role: 'doer' }, SECRET);

    const memberCreated = await requestJson(port, 'POST', '/ws/ws-a/members', { token, body: { name: 'alice', provider: 'claude' } });
    const memberId = memberCreated.body.id;
    const projectCreated = await requestJson(port, 'POST', '/ws/ws-a/projects', { token, body: { name: 'Team Project' } });
    const projectId = projectCreated.body.id;

    const result = await requestJson(port, 'POST', `/ws/ws-a/projects/${projectId}/members`, { token, body: { memberId } });
    expect(result.status).toBe(200);
    expect(result.body.members).toEqual([memberId]);
  });

  it('returns 404 when adding a member to a non-existent project', async () => {
    const token = sign({ member_id: 'm-1', workspace_id: 'ws-a', role: 'doer' }, SECRET);
    const { status } = await requestJson(port, 'POST', '/ws/ws-a/projects/no-such-project/members', { token, body: { memberId: 'm-x' } });
    expect(status).toBe(404);
  });

  it('GET /ws/:id/cost returns a session-scoped, workspace-isolated rollup', async () => {
    const tokenA = sign({ member_id: 'm-1', workspace_id: 'ws-a', role: 'doer' }, SECRET);
    const tokenB = sign({ member_id: 'm-2', workspace_id: 'ws-b', role: 'doer' }, SECRET);

    const noUsage = await requestJson(port, 'GET', '/ws/ws-a/cost', { token: tokenA });
    expect(noUsage.status).toBe(200);
    expect(noUsage.body).toEqual({ window: 'session', workspaceTotal: 0, usage: [] });

    const crossWorkspace = await requestJson(port, 'GET', '/ws/ws-b/cost', { token: tokenA });
    expect(crossWorkspace.status).toBe(401);
  });

  it('GET /ws/:id/activity returns an empty feed with no auth leakage across workspaces', async () => {
    const tokenA = sign({ member_id: 'm-1', workspace_id: 'ws-a', role: 'doer' }, SECRET);
    const tokenB = sign({ member_id: 'm-2', workspace_id: 'ws-b', role: 'doer' }, SECRET);

    const feed = await requestJson(port, 'GET', '/ws/ws-a/activity', { token: tokenA });
    expect(feed.status).toBe(200);
    expect(feed.body).toEqual([]);

    const crossWorkspace = await requestJson(port, 'GET', '/ws/ws-a/activity', { token: tokenB });
    expect(crossWorkspace.status).toBe(401);
  });
});
