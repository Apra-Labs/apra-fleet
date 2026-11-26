import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';

// The schema migration (ALTER TABLE entries ADD COLUMN ...) ignores only the
// "duplicate column name" error. A locked or read-only DB that still lacks a
// migrated column must fail at init, naming the DB path and the sqlite cause,
// not pass init and fail later as "no such column". Real node:sqlite files in
// a per-test temp dir.

let dir: string;
let dbPath: string;

/**
 * An old-schema DB: a fully initialised KB (WAL mode, every table, trigger and
 * index in place) whose entries table lacks the newest migrated column. So the
 * only thing init still has to do is the ALTER, and that is where a locked or
 * read-only file must be reported.
 */
async function makeOldSchema(file: string): Promise<void> {
  const p = new SqliteProvider(file);
  await p.init();
  p.close();
  const db = new DatabaseSync(file);
  db.exec('ALTER TABLE entries DROP COLUMN bible_updated_at');
  const cols = (db.prepare('PRAGMA table_info(entries)').all() as Array<{ name: string }>).map(c => c.name);
  expect(cols).not.toContain('bible_updated_at');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-migration-'));
  dbPath = path.join(dir, 'kb.sqlite');
});
afterEach(() => {
  try { fs.chmodSync(dbPath, 0o644); } catch { /* may not exist */ }
  fs.rmSync(dir, { recursive: true, force: true });
});

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

describe('SqliteProvider.init schema migration', () => {
  it('re-opening an already-migrated DB succeeds twice in a row (duplicate column is ignored)', async () => {
    await makeOldSchema(dbPath);
    for (let i = 0; i < 3; i++) {
      const p = new SqliteProvider(dbPath);
      await p.init();
      p.close();
    }
  });

  it.skipIf(process.platform === 'win32' || isRoot)('a read-only old-schema DB fails at init naming the path and the cause, not "no such column"', async () => {
    await makeOldSchema(dbPath);
    fs.chmodSync(dbPath, 0o444);
    const p = new SqliteProvider(dbPath);
    const err = await p.init().then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain(path.resolve(dbPath));
    expect(err!.message).toMatch(/readonly|read-only|read only/i);
    expect(err!.message).not.toMatch(/no such column/i);
  });

  it('a DB held under an exclusive lock fails at init naming the path and a busy/locked cause', async () => {
    await makeOldSchema(dbPath);
    const holder = new DatabaseSync(dbPath);
    holder.exec('BEGIN EXCLUSIVE');
    try {
      const p = new SqliteProvider(dbPath);
      const err = await p.init().then(() => null, (e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err!.message).toContain(path.resolve(dbPath));
      expect(err!.message).toMatch(/locked|busy/i);
      expect(err!.message).not.toMatch(/no such column/i);
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
  }, 30_000);
});
