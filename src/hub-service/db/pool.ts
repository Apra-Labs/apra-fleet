/**
 * Postgres connection pool + migration runner for the hub service
 * (apra-fleet-us9.4). Postgres-only per docs/adr-hub-persistence.md --
 * no Redis/NATS in the MVP. Self-host-friendly: point HUB_DATABASE_URL at
 * any Postgres (local, docker-compose, or managed) -- no cloud-vendor lock.
 */
import { Pool } from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pool: Pool | undefined;

export function getPool(): Pool {
  if (pool) return pool;
  const connectionString = process.env.HUB_DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'HUB_DATABASE_URL is not set. The hub service requires a Postgres connection ' +
      'string (self-hostable: point it at any Postgres, local or managed).'
    );
  }
  pool = new Pool({ connectionString });
  return pool;
}

/** Test-only seam: inject a pool (e.g. pointed at a throwaway docker container). */
export function setPool(p: Pool): void {
  pool = p;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

function migrationsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/hub-service/db (built) -> ../../../db/migrations
  // src/hub-service/db (ts-node/vitest) -> ../../../db/migrations
  return path.join(here, '..', '..', '..', 'db', 'migrations');
}

/**
 * Runs every .sql file in db/migrations in filename order. Uses
 * CREATE TABLE IF NOT EXISTS throughout (see 001_hub_service_schema.sql),
 * so this is safe to call repeatedly / on every service start -- no
 * separate migration-tracking table needed for an MVP this size.
 */
export async function runMigrations(p: Pool = getPool()): Promise<void> {
  const dir = migrationsDir();
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    await p.query(sql);
  }
}
