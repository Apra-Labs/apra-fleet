/**
 * Real-Postgres proof of the at-least-once relay guarantee (apra-fleet-us9.4).
 * Spins up an actual disposable Postgres container via Docker, runs the
 * real migration file, and exercises the real relay-queue module against
 * it -- this is deliberately NOT mocked, per the project's standing bar
 * that a test must prove the feature works, not just that a function
 * returns without throwing.
 *
 * Requires Docker on the machine running this suite. Skipped automatically
 * (not failed) if Docker isn't available, so it doesn't break CI/dev
 * environments without Docker -- see the `docker info` guard below.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { Pool } from 'pg';
import { setPool, runMigrations, closePool } from '../../src/hub-service/db/pool.js';
import { enqueue, fetchDeliverable, ack, sweepExpired } from '../../src/hub-service/relay-queue.js';

let dockerAvailable = true;
try {
  execSync('docker info', { stdio: 'ignore' });
} catch {
  dockerAvailable = false;
}

const containerName = `apra-fleet-relay-test-${process.pid}`;
let pool: Pool;

describe.skipIf(!dockerAvailable)('relay-queue: at-least-once delivery (real Postgres)', () => {
  beforeAll(async () => {
    execSync(
      `docker run -d --rm --name ${containerName} -e POSTGRES_PASSWORD=test -p 0:5432 postgres:16-alpine`,
      { stdio: 'ignore' },
    );
    const portOutput = execSync(`docker port ${containerName} 5432`).toString().trim();
    const port = portOutput.split(':').pop();

    pool = new Pool({ connectionString: `postgres://postgres:test@127.0.0.1:${port}/postgres` });

    // Wait for Postgres to actually accept connections (container start !=
    // ready to accept queries).
    const deadline = Date.now() + 30_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        await pool.query('SELECT 1');
        lastError = undefined;
        break;
      } catch (err) {
        lastError = err;
        await new Promise(r => setTimeout(r, 300));
      }
    }
    if (lastError) throw new Error(`Postgres never became ready: ${lastError}`);

    setPool(pool);
    await runMigrations(pool);
  }, 45_000);

  afterAll(async () => {
    await closePool();
    try {
      execSync(`docker rm -f ${containerName}`, { stdio: 'ignore' });
    } catch {
      // best-effort cleanup
    }
  });

  it('a briefly-offline target does not lose a queued envelope, and receives it on reconnect', async () => {
    const ws = 'ws-test-1';
    const member = 'member-offline-then-reconnect';
    await pool.query(`INSERT INTO workspaces (id, name) VALUES ($1, 'test') ON CONFLICT DO NOTHING`, [ws]);

    // Envelope admitted while the target is "offline" (i.e. nobody is
    // calling fetchDeliverable for it yet -- exactly the scenario the ADR
    // requires not to lose).
    await enqueue(ws, member, 'env-1', 'execute_command', { cmd: 'echo hi' }, 60_000);

    // "Reconnect": the target's spoke connects and fetches.
    const delivered = await fetchDeliverable(ws, member);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].envelope_id).toBe('env-1');
    expect(delivered[0].status).toBe('delivered');
  });

  it('redelivers an already-delivered-but-unacked envelope on a second reconnect (no silent loss before ack)', async () => {
    const ws = 'ws-test-1';
    const member = 'member-redeliver-before-ack';
    await pool.query(`INSERT INTO workspaces (id, name) VALUES ($1, 'test') ON CONFLICT DO NOTHING`, [ws]);
    await enqueue(ws, member, 'env-2', 'execute_command', { cmd: 'echo redeliver' }, 60_000);

    const firstFetch = await fetchDeliverable(ws, member);
    expect(firstFetch).toHaveLength(1);

    // Simulate the spoke dropping before it acked -- a second reconnect
    // must still see the envelope, proving delivery alone never retires it.
    const secondFetch = await fetchDeliverable(ws, member);
    expect(secondFetch).toHaveLength(1);
    expect(secondFetch[0].envelope_id).toBe('env-2');

    // Only ack retires it.
    await ack(ws, member, 'env-2');
    const thirdFetch = await fetchDeliverable(ws, member);
    expect(thirdFetch).toHaveLength(0);
  });

  it('re-admitting the same envelope_id after a retry is idempotent (no duplicate deliverable)', async () => {
    const ws = 'ws-test-1';
    const member = 'member-idempotent-retry';
    await pool.query(`INSERT INTO workspaces (id, name) VALUES ($1, 'test') ON CONFLICT DO NOTHING`, [ws]);

    await enqueue(ws, member, 'env-3', 'send_message', { text: 'hi' }, 60_000);
    // Simulate the spoke retrying admission after a dropped ack-of-admission.
    await enqueue(ws, member, 'env-3', 'send_message', { text: 'hi' }, 60_000);

    const delivered = await fetchDeliverable(ws, member);
    expect(delivered).toHaveLength(1); // not 2
  });

  it('sweeps expired envelopes so they stop being delivered', async () => {
    const ws = 'ws-test-1';
    const member = 'member-ttl-expiry';
    await pool.query(`INSERT INTO workspaces (id, name) VALUES ($1, 'test') ON CONFLICT DO NOTHING`, [ws]);

    // ttl_ms = 1: effectively already expired the moment it's admitted.
    await enqueue(ws, member, 'env-4', 'execute_command', { cmd: 'too late' }, 1);
    await new Promise(r => setTimeout(r, 50));

    const sweptCount = await sweepExpired();
    expect(sweptCount).toBeGreaterThanOrEqual(1);

    const delivered = await fetchDeliverable(ws, member);
    expect(delivered).toHaveLength(0);
  });
});
