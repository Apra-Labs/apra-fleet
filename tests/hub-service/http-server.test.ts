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

/** Connects to an SSE endpoint, collects `data:` frames as they arrive,
 *  and destroys the connection once `count` frames have been seen
 *  (apra-fleet-b55's stream is a long-lived push, not a request/response --
 *  requestJson's wait-for-'end' would hang forever on it). */
function readSseFrames(port: number, path: string, token: string, count: number, timeoutMs = 5000): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      (res) => {
        let buffer = '';
        const frames: unknown[] = [];
        const timer = setTimeout(() => { req.destroy(); reject(new Error(`readSseFrames timed out with ${frames.length}/${count} frames`)); }, timeoutMs);
        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8');
          let idx: number;
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const raw = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const dataLines = raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
            if (dataLines.length) frames.push(JSON.parse(dataLines.join('')));
            if (frames.length >= count) {
              clearTimeout(timer);
              req.destroy();
              resolve(frames);
              return;
            }
          }
        });
      },
    );
    req.on('error', (err) => { if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(err); });
    req.end();
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
    const { token: tokenForB } = sign({ member_id: 'm-1', workspace_id: 'ws-b', role: 'doer' }, SECRET);
    const { status } = await requestJson(port, 'GET', '/ws/ws-a/members', { token: tokenForB });
    expect(status).toBe(401);
  });

  it('creates and lists members for the correctly-scoped workspace', async () => {
    const { token: adminToken } = sign({ member_id: 'm-1', workspace_id: 'ws-a', role: 'doer' }, SECRET);

    const created = await requestJson(port, 'POST', '/ws/ws-a/members', {
      token: adminToken,
      body: { name: 'alice', provider: 'claude', folder: '/srv/alice' },
    });
    expect(created.status).toBe(201);
    // Matches MemberTokenResponseSchema: {member, jwt} -- the jwt is shown
    // exactly once at issuance, never re-returned by any GET.
    expect(created.body.member).toMatchObject({ name: 'alice', provider: 'claude' });
    expect(typeof created.body.jwt).toBe('string');
    const memberToken = created.body.jwt;

    const listed = await requestJson(port, 'GET', '/ws/ws-a/members', { token: adminToken });
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(1);
    // GET returns the joined dashboard view-model (member-view.ts), not the
    // raw CRUD row -- status/lastSeen only exist on the assembled view.
    expect(listed.body[0]).toMatchObject({ name: 'alice', provider: 'claude', status: 'awaiting-connect', lastSeen: null });
    expect(listed.body[0]).not.toHaveProperty('jwt');

    // The newly-issued member token itself authenticates fine (it's a real,
    // valid, non-revoked token for ws-a).
    const selfList = await requestJson(port, 'GET', '/ws/ws-a/members', { token: memberToken });
    expect(selfList.status).toBe(200);
  });

  it('POST /ws/:id/members/:mid/rotate revokes the old token and issues a new one that authenticates', async () => {
    const { token: adminToken } = sign({ member_id: 'm-1', workspace_id: 'ws-a', role: 'doer' }, SECRET);

    const created = await requestJson(port, 'POST', '/ws/ws-a/members', { token: adminToken, body: { name: 'bella', provider: 'gemini' } });
    const memberId = created.body.member.id;
    const oldToken = created.body.jwt;

    const rotated = await requestJson(port, 'POST', `/ws/ws-a/members/${memberId}/rotate`, { token: adminToken });
    expect(rotated.status).toBe(200);
    expect(rotated.body.member).toMatchObject({ id: memberId, name: 'bella' });
    const newToken = rotated.body.jwt;
    expect(newToken).not.toBe(oldToken);

    // Old token is now revoked -- rejected immediately, not just eventually.
    const withOldToken = await requestJson(port, 'GET', '/ws/ws-a/members', { token: oldToken });
    expect(withOldToken.status).toBe(401);

    // New token works.
    const withNewToken = await requestJson(port, 'GET', '/ws/ws-a/members', { token: newToken });
    expect(withNewToken.status).toBe(200);
  });

  it('POST /ws/:id/members/:mid/rotate returns 404 for a non-existent member', async () => {
    const { token: adminToken } = sign({ member_id: 'm-1', workspace_id: 'ws-a', role: 'doer' }, SECRET);
    const { status } = await requestJson(port, 'POST', '/ws/ws-a/members/no-such-member/rotate', { token: adminToken });
    expect(status).toBe(404);
  });

  it('a member created in workspace A is invisible when listing workspace B (cross-tenant isolation)', async () => {
    const { token: tokenA } = sign({ member_id: 'm-1', workspace_id: 'ws-a', role: 'doer' }, SECRET);
    const { token: tokenB } = sign({ member_id: 'm-2', workspace_id: 'ws-b', role: 'doer' }, SECRET);

    await requestJson(port, 'POST', '/ws/ws-a/members', { token: tokenA, body: { name: 'alice', provider: 'claude' } });

    const listedB = await requestJson(port, 'GET', '/ws/ws-b/members', { token: tokenB });
    expect(listedB.body).toEqual([]);
  });

  it('rejects a POST with missing required fields', async () => {
    const { token: token } = sign({ member_id: 'm-1', workspace_id: 'ws-a', role: 'doer' }, SECRET);
    const { status, body } = await requestJson(port, 'POST', '/ws/ws-a/members', { token, body: { name: 'alice' } });
    expect(status).toBe(400);
    expect(body.error).toBeDefined();
  });

  it('returns 404 for an unknown route', async () => {
    const { status } = await requestJson(port, 'GET', '/not-a-real-route');
    expect(status).toBe(404);
  });

  it('creates, lists, updates, and deletes a project, and rejects cross-workspace access', async () => {
    const { token: tokenA } = sign({ member_id: 'm-1', workspace_id: 'ws-a', role: 'doer' }, SECRET);
    const { token: tokenB } = sign({ member_id: 'm-2', workspace_id: 'ws-b', role: 'doer' }, SECRET);

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
    const { token: token } = sign({ member_id: 'm-1', workspace_id: 'ws-a', role: 'doer' }, SECRET);

    const memberCreated = await requestJson(port, 'POST', '/ws/ws-a/members', { token, body: { name: 'alice', provider: 'claude' } });
    const memberId = memberCreated.body.member.id;
    const projectCreated = await requestJson(port, 'POST', '/ws/ws-a/projects', { token, body: { name: 'Team Project' } });
    const projectId = projectCreated.body.id;

    const result = await requestJson(port, 'POST', `/ws/ws-a/projects/${projectId}/members`, { token, body: { memberId } });
    expect(result.status).toBe(200);
    expect(result.body.members).toEqual([memberId]);
  });

  it('returns 404 when adding a member to a non-existent project', async () => {
    const { token: token } = sign({ member_id: 'm-1', workspace_id: 'ws-a', role: 'doer' }, SECRET);
    const { status } = await requestJson(port, 'POST', '/ws/ws-a/projects/no-such-project/members', { token, body: { memberId: 'm-x' } });
    expect(status).toBe(404);
  });

  it('GET /ws/:id/cost returns a session-scoped, workspace-isolated rollup', async () => {
    const { token: tokenA } = sign({ member_id: 'm-1', workspace_id: 'ws-a', role: 'doer' }, SECRET);
    const { token: tokenB } = sign({ member_id: 'm-2', workspace_id: 'ws-b', role: 'doer' }, SECRET);

    const noUsage = await requestJson(port, 'GET', '/ws/ws-a/cost', { token: tokenA });
    expect(noUsage.status).toBe(200);
    expect(noUsage.body).toEqual({ window: 'session', workspaceTotal: 0, usage: [] });

    const crossWorkspace = await requestJson(port, 'GET', '/ws/ws-b/cost', { token: tokenA });
    expect(crossWorkspace.status).toBe(401);
  });

  it('GET /ws/:id/activity returns an empty feed with no auth leakage across workspaces', async () => {
    const { token: tokenA } = sign({ member_id: 'm-1', workspace_id: 'ws-a', role: 'doer' }, SECRET);
    const { token: tokenB } = sign({ member_id: 'm-2', workspace_id: 'ws-b', role: 'doer' }, SECRET);

    const feed = await requestJson(port, 'GET', '/ws/ws-a/activity', { token: tokenA });
    expect(feed.status).toBe(200);
    expect(feed.body).toEqual([]);

    const crossWorkspace = await requestJson(port, 'GET', '/ws/ws-a/activity', { token: tokenB });
    expect(crossWorkspace.status).toBe(401);
  });

  it('POST /ws/:id/envelopes rejects with no token, and enforces the workspace iron wall', async () => {
    const noAuth = await requestJson(port, 'POST', '/ws/ws-a/envelopes', {
      body: { envelope_id: 'e1', workspace_id: 'ws-a', kind: 'presence.heartbeat', from: { machine_id: 'mach-1', member_id: null }, to: {} },
    });
    expect(noAuth.status).toBe(401);

    const { token: tokenB } = sign({ member_id: 'mach-1', workspace_id: 'ws-b', role: 'spoke' }, SECRET);
    const crossWorkspace = await requestJson(port, 'POST', '/ws/ws-a/envelopes', {
      token: tokenB,
      body: { envelope_id: 'e1', workspace_id: 'ws-a', kind: 'presence.heartbeat', from: { machine_id: 'mach-1', member_id: null }, to: {} },
    });
    expect(crossWorkspace.status).toBe(401);
  });

  it('POST /ws/:id/envelopes accepts a presence.announce and POST /ws/:id/ack retires a relayed envelope end-to-end', async () => {
    const { token: machineToken } = sign({ member_id: 'mach-1', workspace_id: 'ws-a', role: 'spoke' }, SECRET);

    const announce = await requestJson(port, 'POST', '/ws/ws-a/envelopes', {
      token: machineToken,
      body: {
        envelope_id: 'e-announce', workspace_id: 'ws-a', kind: 'presence.announce',
        from: { machine_id: 'mach-1', member_id: null }, to: {},
        payload: { members: [{ member_id: 'mem-1', status: 'online' }] },
      },
    });
    expect(announce.status).toBe(200);
    expect(announce.body.kind).toBe('presence.ack');

    const created = await requestJson(port, 'POST', '/ws/ws-a/members', {
      token: machineToken, body: { name: 'bob', provider: 'claude' },
    });
    const targetMemberId = created.body.member.id;

    const submitted = await requestJson(port, 'POST', '/ws/ws-a/envelopes', {
      token: machineToken,
      body: {
        envelope_id: 'e-cmd', workspace_id: 'ws-a', kind: 'execute_command.request',
        from: { machine_id: 'mach-1', member_id: null }, to: { machine_id: null, member_id: targetMemberId },
        payload: { cmd: 'echo hi' },
      },
    });
    expect(submitted.status).toBe(202);

    const acked = await requestJson(port, 'POST', '/ws/ws-a/ack', {
      token: machineToken,
      body: { envelope_id: 'e-cmd', member_id: targetMemberId },
    });
    expect(acked.status).toBe(200);
    expect(acked.body).toEqual({ acked: true });
  });

  it('GET /ws/:id/stream (apra-fleet-b55) pushes a relayed envelope to the correct machine, workspace-scoped', async () => {
    const { token: machineToken } = sign({ member_id: 'mach-1', workspace_id: 'ws-a', role: 'spoke' }, SECRET);

    const created = await requestJson(port, 'POST', '/ws/ws-a/members', { token: machineToken, body: { name: 'carol', provider: 'claude' } });
    const targetMemberId = created.body.member.id;

    await requestJson(port, 'POST', '/ws/ws-a/envelopes', {
      token: machineToken,
      body: {
        envelope_id: 'e-announce', workspace_id: 'ws-a', kind: 'presence.announce',
        from: { machine_id: 'mach-1', member_id: null }, to: {},
        payload: { members: [{ member_id: targetMemberId, status: 'online' }] },
      },
    });

    await requestJson(port, 'POST', '/ws/ws-a/envelopes', {
      token: machineToken,
      body: {
        envelope_id: 'e-cmd-2', workspace_id: 'ws-a', kind: 'execute_command.request',
        from: { machine_id: 'mach-1', member_id: null }, to: { machine_id: null, member_id: targetMemberId },
        payload: { cmd: 'echo streamed' },
      },
    });

    const frames = await readSseFrames(port, '/ws/ws-a/stream', machineToken, 1);
    expect(frames).toHaveLength(1);
    expect((frames[0] as any).envelope_id).toBe('e-cmd-2');
    expect((frames[0] as any).payload).toEqual({ cmd: 'echo streamed' });
  }, 10000);

  it('rejects GET /ws/:id/stream with no token', async () => {
    const noAuth = await requestJson(port, 'GET', '/ws/ws-a/stream');
    expect(noAuth.status).toBe(401);
  });
});
