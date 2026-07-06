#!/usr/bin/env node
/**
 * STATUS: REFERENCE IMPLEMENTATION ONLY -- not deployed to fleet.apralabs.com
 * and not receiving further production feature work (apra-fleet-yp3, decided
 * 2026-07-05). This code proved the wire-protocol and workspace-isolation
 * semantics (2133 passing tests) during the hub-and-spoke migration sprint,
 * but the product owner has since decided fleet-dashboard is the sole tier-3
 * persistence layer going forward -- see docs/api-contract-reconciliation.md
 * section 1.5 for the authoritative directive and
 * docs/hub-service-deployment.md for what that means for anyone deploying
 * this. Do not point HUB_DATABASE_URL/HUB_JWT_SECRET at a real environment;
 * treat this file and its tests purely as a specification of verified
 * wire-protocol/security behavior for whichever team builds the production
 * equivalent.
 *
 * Hub service entry point (apra-fleet-us9.4). Runs pending migrations,
 * then starts the HTTP server. Self-hostable: every configuration value
 * is an env var, no cloud-vendor-specific setup required (see
 * docs/adr-hub-persistence.md and the Dockerfile at the repo root).
 *
 * Required env vars:
 *   HUB_DATABASE_URL -- Postgres connection string (src/hub-service/db/pool.ts)
 *   HUB_JWT_SECRET   -- HS256 signing secret (src/hub-service/hub-jwt.ts;
 *                       MVP stopgap pending apra-fleet-us9.5's asymmetric design)
 * Optional:
 *   PORT             -- HTTP port (default 8080)
 *   HOST             -- bind address (default 0.0.0.0 -- this is a cloud
 *                       service, unlike apra-fleet.exe's loopback-only bind)
 */
import { runMigrations } from './db/pool.js';
import { createHttpServer, listen } from './http-server.js';
import { sweepExpiredToFailures } from './relay-queue.js';

/** How often the TTL sweep runs (apra-fleet-b55, wire-protocol.md section
 *  6): expired relay_queue rows are moved to 'expired' and, for request
 *  kinds, a synthetic failure result is enqueued back to the originator.
 *  5s keeps the worst-case "caller waits for a definite answer" delay
 *  small relative to the shortest per-kind TTL (5s for event.broadcast). */
const SWEEP_INTERVAL_MS = 5000;

async function main(): Promise<void> {
  await runMigrations();

  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;
  const host = process.env.HOST ?? '0.0.0.0';

  const handle = createHttpServer();
  const boundPort = await listen(handle, port, host);
  process.stdout.write(`[hub-service] listening on ${host}:${boundPort}\n`);

  const sweepTimer = setInterval(() => {
    sweepExpiredToFailures().catch((err) => {
      process.stderr.write(`[hub-service] relay-queue sweep error: ${err instanceof Error ? err.message : String(err)}\n`);
    });
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref();

  const shutdown = () => {
    process.stdout.write('[hub-service] shutting down\n');
    clearInterval(sweepTimer);
    handle.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  process.stderr.write(`[hub-service] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
