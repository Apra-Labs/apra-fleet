/**
 * Activity feed proof (apra-fleet-us9.4 continuation) via pg-mem: executes
 * the real migration files and the real activity.ts queries. Also a
 * contract test validating the assembled shape against the published
 * ActivityEventSchema.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import fs from 'node:fs';
import path from 'node:path';
import { ActivityEventSchema } from '@apralabs/fleet-api-contract';
import { setPool, closePool } from '../../src/hub-service/db/pool.js';
import { createWorkspace } from '../../src/hub-service/workspaces.js';
import { recordActivity, getActivityFeed } from '../../src/hub-service/activity.js';

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

describe('activity (pg-mem, real SQL engine, no Docker required)', () => {
  beforeEach(async () => {
    pool = await freshPool();
    setPool(pool);
    await createWorkspace('ws-test', 'Test Workspace', pool);
  });

  afterEach(async () => {
    await closePool();
  });

  it('a workspace with no activity returns an empty feed', async () => {
    expect(await getActivityFeed('ws-test', 100, pool)).toEqual([]);
  });

  it('records and returns a cmd event with an exit code, validating against ActivityEventSchema', async () => {
    await recordActivity('ws-test', 'proj-1', 'mem-1', 'cmd', 'npm test', 0, pool);

    const feed = await getActivityFeed('ws-test', 100, pool);
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({ project: 'proj-1', member: 'mem-1', kind: 'cmd', text: 'npm test', exit: 0 });
    expect(feed[0].t).toBeGreaterThanOrEqual(0);
    expect(() => ActivityEventSchema.parse(feed[0])).not.toThrow();
  });

  it('records a prompt/file/commit event with no exit code (null)', async () => {
    await recordActivity('ws-test', 'proj-1', 'mem-1', 'commit', 'fix: bug', null, pool);

    const feed = await getActivityFeed('ws-test', 100, pool);
    expect(feed[0].exit).toBeNull();
    expect(() => ActivityEventSchema.parse(feed[0])).not.toThrow();
  });

  it('returns most-recent-first', async () => {
    await recordActivity('ws-test', 'proj-1', 'mem-1', 'prompt', 'first', null, pool);
    await recordActivity('ws-test', 'proj-1', 'mem-1', 'prompt', 'second', null, pool);

    const feed = await getActivityFeed('ws-test', 100, pool);
    expect(feed.map(e => e.text)).toEqual(['second', 'first']);
  });

  it('respects the limit parameter', async () => {
    for (let i = 0; i < 5; i++) {
      await recordActivity('ws-test', 'proj-1', 'mem-1', 'prompt', `event-${i}`, null, pool);
    }
    expect(await getActivityFeed('ws-test', 2, pool)).toHaveLength(2);
  });

  it('does not include activity from a DIFFERENT workspace', async () => {
    await createWorkspace('ws-other', 'Other', pool);
    await recordActivity('ws-test', 'proj-1', 'mem-1', 'cmd', 'mine', 0, pool);
    await recordActivity('ws-other', 'proj-1', 'mem-1', 'cmd', 'theirs', 0, pool);

    const feed = await getActivityFeed('ws-test', 100, pool);
    expect(feed).toHaveLength(1);
    expect(feed[0].text).toBe('mine');
  });

  it('rejects an invalid kind at the database level (CHECK constraint)', async () => {
    await expect(
      pool.query(
        `INSERT INTO activity_log (workspace_id, project_id, member_id, kind, text) VALUES ($1, $2, $3, $4, $5)`,
        ['ws-test', 'proj-1', 'mem-1', 'not-a-real-kind', 'x'],
      ),
    ).rejects.toThrow();
  });
});
