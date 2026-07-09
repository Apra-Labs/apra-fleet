/**
 * Usage ledger proof (apra-fleet-us9.15) via pg-mem: executes the real
 * migration file and the real usage.ts queries, unmodified. Proves the
 * rollup/aggregation math (SUM/GROUP BY) is correct, independent of
 * whether anything real writes to this ledger yet (recordUsage() itself
 * is exercised with synthetic data, same pattern as relay-queue.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import fs from 'node:fs';
import path from 'node:path';
import { CostResponseSchema } from '@apralabs/fleet-api-contract';
import { setPool, closePool } from '../../src/hub-service/db/pool.js';
import { createWorkspace } from '../../src/hub-service/workspaces.js';
import { recordUsage, getCostResponse } from '../../src/hub-service/usage.js';

let pool: any;

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

describe('usage (pg-mem, real SQL engine, no Docker required)', () => {
  beforeEach(async () => {
    pool = await freshPool();
    setPool(pool);
    await createWorkspace('ws-test', 'Test Workspace', pool);
  });

  afterEach(async () => {
    await closePool();
  });

  it('a workspace with no usage recorded reports a zero total and empty breakdown, validating against CostResponseSchema', async () => {
    const response = await getCostResponse('ws-test', pool);
    expect(response).toEqual({ window: 'session', workspaceTotal: 0, usage: [] });
    expect(() => CostResponseSchema.parse(response)).not.toThrow();
  });

  it('rolls up multiple usage records for the same (project, member) into one entry', async () => {
    await recordUsage('ws-test', 'mem-1', 'proj-1', 100, 0.05, pool);
    await recordUsage('ws-test', 'mem-1', 'proj-1', 50, 0.02, pool);

    const response = await getCostResponse('ws-test', pool);
    expect(response.usage).toHaveLength(1);
    expect(response.usage[0]).toMatchObject({ project: 'proj-1', member: 'mem-1', tokens: 150, cost: 0.07 });
    expect(response.workspaceTotal).toBeCloseTo(0.07);
  });

  it('keeps separate (project, member) pairs distinct in the breakdown', async () => {
    await recordUsage('ws-test', 'mem-1', 'proj-1', 100, 0.05, pool);
    await recordUsage('ws-test', 'mem-2', 'proj-1', 200, 0.10, pool);
    await recordUsage('ws-test', 'mem-1', 'proj-2', 300, 0.15, pool);

    const response = await getCostResponse('ws-test', pool);
    expect(response.usage).toHaveLength(3);
    expect(response.workspaceTotal).toBeCloseTo(0.30);
    for (const record of response.usage) {
      expect(() => CostResponseSchema.shape.usage.element.parse(record)).not.toThrow();
    }
  });

  it('excludes rows with no project_id from the per-(project,member) breakdown, but still counts them in workspaceTotal', async () => {
    await recordUsage('ws-test', 'mem-1', null, 100, 0.05, pool);
    await recordUsage('ws-test', 'mem-2', 'proj-1', 50, 0.02, pool);

    const response = await getCostResponse('ws-test', pool);
    expect(response.usage).toHaveLength(1);
    expect(response.usage[0].project).toBe('proj-1');
    // Both records count toward the workspace total even though the
    // project-less one is not itemized in the breakdown.
    expect(response.workspaceTotal).toBeCloseTo(0.07);
  });

  it('does not include usage from a DIFFERENT workspace', async () => {
    await createWorkspace('ws-other', 'Other', pool);
    await recordUsage('ws-test', 'mem-1', 'proj-1', 100, 0.05, pool);
    await recordUsage('ws-other', 'mem-2', 'proj-1', 999, 9.99, pool);

    const response = await getCostResponse('ws-test', pool);
    expect(response.workspaceTotal).toBeCloseTo(0.05);
    expect(response.usage).toHaveLength(1);
  });

  it('a no-LLM ("compute only", apra-fleet-us9.14) member reporting tokens:0 cost:0 still shows up in the breakdown', async () => {
    await recordUsage('ws-test', 'mem-compute-only', 'proj-1', 0, 0, pool);

    const response = await getCostResponse('ws-test', pool);
    expect(response.usage).toEqual([{ project: 'proj-1', member: 'mem-compute-only', tokens: 0, cost: 0 }]);
  });
});
