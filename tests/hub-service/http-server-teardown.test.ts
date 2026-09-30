/**
 * Hub HTTP server teardown / request-error boundary.
 *
 * Reproduces a CI flake deterministically: a spoke posts /ack right as a
 * test finishes; the handler is parked on an await (authorize -> isRevoked)
 * while teardown closes the server and the pool, then resumes and calls
 * getPool() with no pool and no HUB_DATABASE_URL. Before the fix that throw
 * escaped the (un-awaited) async request handler as an unhandled rejection.
 *
 * A gated pool holds the first query so the race window is forced open.
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
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const rawSql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    await p.query(rawSql.replace(/CREATE UNLOGGED TABLE/gi, 'CREATE TABLE'));
  }
  return p;
}

/** Wraps a pool so the next query blocks until release() is called. */
function gatedPool(real: any) {
  let armed = false;
  let release!: () => void;
  let onParked!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const parked = new Promise<void>((r) => { onParked = r; });
  const pool = {
    async query(...args: any[]) {
      if (armed) {
        armed = false;
        onParked();
        await gate;
      }
      return real.query(...args);
    },
    async end() { await real.end(); },
  };
  return { pool, arm: () => { armed = true; }, parked, release };
}

function postAck(port: number, token: string): { done: Promise<{ status: number; body: any }>; req: http.ClientRequest } {
  const bodyStr = JSON.stringify({ envelope_id: 'env-1', member_id: 'member-1' });
  let req!: http.ClientRequest;
  const done = new Promise<{ status: number; body: any }>((resolve, reject) => {
    req = http.request(
      {
        hostname: '127.0.0.1', port, path: '/ws/ws-a/ack', method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
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
  return { done, req };
}

describe('hub http-server: late in-flight request vs teardown', () => {
  let handle: HttpServerHandle;
  let port: number;
  let gated: ReturnType<typeof gatedPool>;
  let unhandled: unknown[];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  const originalSecret = process.env.HUB_JWT_SECRET;
  const originalDbUrl = process.env.HUB_DATABASE_URL;

  beforeEach(async () => {
    process.env.HUB_JWT_SECRET = SECRET;
    delete process.env.HUB_DATABASE_URL;
    const real = await freshPool();
    await createWorkspace('ws-a', 'Workspace A', real);
    gated = gatedPool(real);
    setPool(gated.pool as any);
    handle = createHttpServer();
    port = await listen(handle, 0, '127.0.0.1');
    unhandled = [];
    process.on('unhandledRejection', onUnhandled);
  });

  afterEach(async () => {
    gated.release();
    await handle.close().catch(() => {}); // already closed by the test itself
    await closePool();
    process.off('unhandledRejection', onUnhandled);
    if (originalSecret !== undefined) process.env.HUB_JWT_SECRET = originalSecret;
    else delete process.env.HUB_JWT_SECRET;
    if (originalDbUrl !== undefined) process.env.HUB_DATABASE_URL = originalDbUrl;
  });

  it('a handler that hits a torn-down pool answers 500 instead of raising an unhandled rejection', async () => {
    const { token } = sign({ sub: 'mach-a', ws: 'ws-a', role: 'spoke' }, SECRET);
    gated.arm();
    const { done } = postAck(port, token);
    await gated.parked; // handler is inside authorize -> isRevoked

    // Old teardown order: pool released while the handler is still parked.
    // Its next getPool() throws "HUB_DATABASE_URL is not set".
    await closePool();
    gated.release();

    const res = await done;
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal server error' });
    await new Promise((r) => setTimeout(r, 20));
    expect(unhandled).toEqual([]);
  });

  it('close() waits for in-flight handlers, so releasing the pool afterwards is safe', async () => {
    const { token } = sign({ sub: 'mach-a', ws: 'ws-a', role: 'spoke' }, SECRET);
    gated.arm();
    const { done, req } = postAck(port, token);
    done.catch(() => {}); // socket is force-closed by close(); client error is expected
    await gated.parked;

    let closed = false;
    const closing = handle.close().then(() => { closed = true; });
    await new Promise((r) => setTimeout(r, 50));
    expect(closed).toBe(false); // still waiting on the parked handler

    gated.release();
    await closing;
    // Handler finished while the pool was still set; tearing it down now
    // cannot race a resumed handler.
    await closePool();
    await new Promise((r) => setTimeout(r, 20));
    expect(unhandled).toEqual([]);
    req.destroy();
  });
});
