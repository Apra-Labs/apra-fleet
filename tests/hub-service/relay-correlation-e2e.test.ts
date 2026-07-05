/**
 * Regression test for a real bug found while building apra-fleet-us9.12
 * (hub-brokered file transfer): docs/hub-spoke-wire-protocol.md section 3
 * specifies a `correlation_id` field on every envelope, but it was never
 * persisted by relay_queue nor forwarded over the SSE delivery stream --
 * it only "worked" in isolated unit tests that hand-constructed envelope
 * objects with correlation_id already set. This test goes through the
 * REAL hub HTTP pipeline (POST /ws/:id/envelopes -> relay_queue ->
 * fetchDeliverable, the same data GET /ws/:id/stream pushes verbatim) to
 * prove correlation_id and origin_member_id both actually round-trip now
 * (migration 008 + relay-queue.ts + envelope-routes.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { setPool, closePool } from '../../src/hub-service/db/pool.js';
import { createWorkspace } from '../../src/hub-service/workspaces.js';
import { createMember } from '../../src/hub-service/members.js';
import { createHttpServer, listen, type HttpServerHandle } from '../../src/hub-service/http-server.js';
import { sign } from '../../src/hub-service/hub-jwt.js';
import { fetchDeliverable } from '../../src/hub-service/relay-queue.js';

const SECRET = 'test-hub-secret';

async function freshPool() {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  db.public.registerFunction({ name: 'now', returns: 'timestamptz' as any, implementation: () => new Date() });
  const { Pool } = db.adapters.createPg();
  const p = new Pool();
  const migrationsDir = path.join(process.cwd(), 'db', 'migrations');
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const rawSql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    const sql = rawSql.replace(/CREATE UNLOGGED TABLE/gi, 'CREATE TABLE');
    await p.query(sql);
  }
  return p;
}

function requestJson(port: number, method: string, reqPath: string, opts: { token?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const bodyStr = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const req = http.request(
      { hostname: '127.0.0.1', port, path: reqPath, method,
        headers: {
          ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
          ...(bodyStr ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
        } },
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

describe('relay envelope correlation_id round-trip (real HTTP + real pg-mem, apra-fleet-us9.12 regression)', () => {
  let pool: any;
  let handle: HttpServerHandle;
  let port: number;
  const originalSecret = process.env.HUB_JWT_SECRET;

  beforeEach(async () => {
    process.env.HUB_JWT_SECRET = SECRET;
    pool = await freshPool();
    setPool(pool);
    await createWorkspace('ws-a', 'Workspace A', pool);

    handle = createHttpServer();
    port = await listen(handle, 0, '127.0.0.1');
  });

  afterEach(async () => {
    await handle.close();
    await closePool();
    if (originalSecret !== undefined) process.env.HUB_JWT_SECRET = originalSecret;
    else delete process.env.HUB_JWT_SECRET;
  });

  it('a submitted correlation_id survives admission and is present on the row fetchDeliverable/the SSE stream would push', async () => {
    const { token } = sign({ member_id: 'mach-1', workspace_id: 'ws-a', role: 'spoke' }, SECRET);
    await createMember('origin-member', 'ws-a', { name: 'origin', provider: 'claude' }, pool);
    await createMember('target-member', 'ws-a', { name: 'target', provider: 'claude' }, pool);

    // The FULFILLING spoke posts a result envelope back to the originator,
    // exactly as relay-executor.ts / file-transfer-relay.ts's receiver do:
    // correlation_id = the original request's envelope_id.
    const submitted = await requestJson(port, 'POST', '/ws/ws-a/envelopes', {
      token,
      body: {
        envelope_id: 'result-1', workspace_id: 'ws-a', kind: 'execute_command.result',
        from: { machine_id: null, member_id: 'target-member' }, to: { machine_id: null, member_id: 'origin-member' },
        correlation_id: 'original-request-envelope-id',
        payload: { status: 'ok', stdout: 'done' },
      },
    });
    expect(submitted.status).toBe(202);

    // This is the SAME row shape GET /ws/:id/stream pushes verbatim over
    // SSE -- if correlation_id is present here, hub-client.ts's dispatcher
    // (composeEnvelopeHandler / relay-request.ts) can actually match it.
    const deliverable = await fetchDeliverable('ws-a', 'origin-member', pool);
    expect(deliverable).toHaveLength(1);
    expect(deliverable[0].correlation_id).toBe('original-request-envelope-id');
    expect(deliverable[0].origin_member_id).toBe('target-member');
    expect(deliverable[0].payload).toEqual({ status: 'ok', stdout: 'done' });
  });
});
