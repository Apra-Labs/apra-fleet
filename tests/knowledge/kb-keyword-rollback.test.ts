import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';

// Rollback contract of the KB keyword index (kb-index.ts header): a kb.sqlite
// migrated by this build, then opened by 0.4.4, then by this build again, must
// keep answering keyword queries correctly in BOTH builds and never throw
// "database disk image is malformed".
//
// 0.4.4 is SIMULATED here with the exact statements it runs (copied from
// git show v0.4.4:src/services/knowledge/sqlite-provider.ts): its open-time
// IF NOT EXISTS schema, its capture INSERT, its kb_query (entries_fts MATCH,
// then a use_count/last_accessed UPDATE of every hit) and its kb_list. The
// statements are copied literally rather than imported from production code,
// so the test pins what 0.4.4 actually does. The real-0.4.4-build test is
// kb-keyword-rollback-044.test.ts.
//
// Falsifiability: restoring the DROP of entries_fts and its triggers in
// KbKeywordIndex.finish (and removing ensureLegacyFts) makes 0.4.4 recreate
// entries_fts EMPTY, so its keyword hits drop to 0 and its use_count UPDATE
// corrupts the index -- every 0.4.4 assertion below then fails.
//
// Isolation: every file lives under one mkdtemp dir removed in afterAll.

const ALL_TIERS = ['CONFIRMED', 'INFERRED', 'UNVERIFIED'] as const;

/** What 0.4.4 runs on every open (the keyword-index part of its schema). */
const V044_OPEN_SQL = `
      CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
        title,
        summary,
        content,
        tags,
        content='entries',
        content_rowid='rowid'
      );

      CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
        INSERT INTO entries_fts(rowid, title, summary, content, tags)
        VALUES (new.rowid, new.title, new.summary, new.content, new.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
        INSERT INTO entries_fts(entries_fts, rowid, title, summary, content, tags)
        VALUES ('delete', old.rowid, old.title, old.summary, old.content, old.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
        INSERT INTO entries_fts(entries_fts, rowid, title, summary, content, tags)
        VALUES ('delete', old.rowid, old.title, old.summary, old.content, old.tags);
        INSERT INTO entries_fts(rowid, title, summary, content, tags)
        VALUES (new.rowid, new.title, new.summary, new.content, new.tags);
      END;
`;

/** Simulated 0.4.4 handle on a kb.sqlite. */
class V044 {
  readonly db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('PRAGMA busy_timeout=5000');
    this.db.exec(V044_OPEN_SQL);
  }
  capture(title: string): string {
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO entries (id, type, title, summary, content, source_files, symbols, module, tags,
        content_hash, content_hash_type, stale, flagged_for_review, contradiction_of,
        author, source, confidence, scope, created_at, superseded_at, promoted_at, use_count, last_accessed)
      VALUES (?, 'knowledge', ?, 'captured by 0.4.4', 'body', '["src/a.ts"]', '[]', NULL, '[]',
        '', 'sha256', 0, 0, NULL, 'v044', 'doer', 'INFERRED', 'project', ?, NULL, NULL, 0, NULL)
    `).run(id, title, new Date().toISOString());
    return id;
  }
  /** 0.4.4 kb_query: OR-joined quoted terms over entries_fts, then a use_count bump of every hit. */
  query(words: string[]): string[] {
    const match = words.map(w => `"${w}"`).join(' OR ');
    const rows = this.db.prepare(`
      SELECT e.* FROM entries e
      JOIN entries_fts ON entries_fts.rowid = e.rowid
      WHERE entries_fts MATCH ?
      AND e.superseded_at IS NULL
      ORDER BY rank
      LIMIT 100
    `).all(match) as { id: string }[];
    const now = new Date().toISOString();
    const bump = this.db.prepare('UPDATE entries SET use_count = use_count + 1, last_accessed = ? WHERE id = ?');
    for (const r of rows) bump.run(now, r.id);
    return rows.map(r => r.id);
  }
  list(): string[] {
    return (this.db.prepare(
      'SELECT * FROM entries e WHERE e.superseded_at IS NULL AND e.stale = 0 ORDER BY e.created_at DESC LIMIT 1000'
    ).all() as { id: string }[]).map(r => r.id);
  }
  integrity(): void {
    this.db.exec("INSERT INTO entries_fts(entries_fts, rank) VALUES ('integrity-check', 1)");
  }
  close(): void {
    this.db.close();
  }
}

function input(title: string): KBEntryInput {
  return {
    type: 'knowledge',
    title,
    summary: 'rollback fixture',
    content: 'rollback fixture body',
    source_files: ['src/a.ts'],
    symbols: [],
    tags: [],
    content_hash: '',
    content_hash_type: 'sha256',
    flagged_for_review: false,
    author: 'rollback-test',
    source: 'doer',
    confidence: 'INFERRED',
  };
}

let tmp: string;
let repo: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-keyword-rollback-'));
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function openNew(file: string): Promise<SqliteProvider> {
  const p = new SqliteProvider(file, repo);
  await p.init();
  expect(await p.waitForKeywordIndex(30_000)).toBe(true);
  return p;
}

async function newIds(p: SqliteProvider, query: string): Promise<string[]> {
  const r = await p.query({ query, confidence: [...ALL_TIERS], limit: 100 });
  return r.results.map(e => e.id).sort();
}

describe('KB keyword index: rollback to 0.4.4 and re-upgrade (simulated 0.4.4)', () => {
  it('both builds keep correct keyword hits and no malformed error over two rollback cycles', async () => {
    const file = path.join(tmp, 'cycle.sqlite');
    const expected: string[] = [];

    // (1) New build creates the DB and migrates it.
    let p = await openNew(file);
    expected.push((await p.capture(input('Zephyr beacon alpha'))).id);
    expected.push((await p.capture(input('Zephyr beacon bravo'))).id);
    await p.capture(input('Unrelated pelican note'));
    expect(await newIds(p, 'zephyr')).toEqual([...expected].sort());
    p.close();

    for (let cycle = 1; cycle <= 2; cycle++) {
      // (2) 0.4.4 opens it: its keyword reads see every entry, its writes do not corrupt.
      const old = new V044(file);
      try {
        expect(old.query(['zephyr']).sort()).toEqual([...expected].sort());
        expect(() => old.list()).not.toThrow();
        expected.push(old.capture(`Zephyr beacon from 044 cycle ${cycle}`));
        expect(old.query(['zephyr']).sort()).toEqual([...expected].sort());
        expect(old.list()).toEqual(expect.arrayContaining(expected));
        expect(() => old.integrity()).not.toThrow();
      } finally {
        old.close();
      }

      // (3) New build re-opens it: same hits plus the 0.4.4 capture, list works.
      p = await openNew(file);
      try {
        expect(await newIds(p, 'zephyr')).toEqual([...expected].sort());
        const listed = await p.list({ confidence: [...ALL_TIERS], limit: 1000 });
        expect(listed.map(e => e.id)).toEqual(expect.arrayContaining(expected));
        // New-build writes keep the legacy index consistent for the next rollback.
        expected.push((await p.capture(input(`Zephyr beacon new cycle ${cycle}`))).id);
        expect(await newIds(p, 'zephyr')).toEqual([...expected].sort());
      } finally {
        p.close();
      }
    }

    const chk = new DatabaseSync(file);
    try {
      expect(() => chk.exec("INSERT INTO entries_fts(entries_fts, rank) VALUES ('integrity-check', 1)")).not.toThrow();
    } finally {
      chk.close();
    }
  });

  it('repairs a DB whose entries_fts a pre-fix build dropped and 0.4.4 then re-created empty', async () => {
    const file = path.join(tmp, 'repair.sqlite');
    const expected: string[] = [];
    let p = await openNew(file);
    expected.push((await p.capture(input('Quokka ledger one'))).id);
    expected.push((await p.capture(input('Quokka ledger two'))).id);
    p.close();

    // A pre-fix build dropped the legacy index once migration finished.
    const pre = new DatabaseSync(file);
    pre.exec(`
      DROP TRIGGER IF EXISTS entries_ai;
      DROP TRIGGER IF EXISTS entries_ad;
      DROP TRIGGER IF EXISTS entries_au;
      DROP TABLE IF EXISTS entries_fts;
    `);
    pre.close();

    // 0.4.4 re-creates it EMPTY; it captures one entry (indexed by its trigger).
    const old = new V044(file);
    try {
      expected.push(old.capture('Quokka ledger from 044'));
    } finally {
      old.close();
    }

    // New build: repairs the legacy index and answers correctly.
    p = await openNew(file);
    try {
      expect(await newIds(p, 'quokka')).toEqual([...expected].sort());
      await expect(p.list({ confidence: [...ALL_TIERS], limit: 1000 })).resolves.toBeDefined();
    } finally {
      p.close();
    }

    // 0.4.4 again: now finds every entry and stays consistent.
    const old2 = new V044(file);
    try {
      expect(old2.query(['quokka']).sort()).toEqual([...expected].sort());
      expect(() => old2.integrity()).not.toThrow();
    } finally {
      old2.close();
    }
  });

  it('an UPDATE in 0.4.4 over an empty re-created index throws malformed; the new build repairs it', async () => {
    const file = path.join(tmp, 'corrupt.sqlite');
    let p = await openNew(file);
    const ids = [(await p.capture(input('Ibex marker one'))).id, (await p.capture(input('Ibex marker two'))).id];
    p.close();

    const pre = new DatabaseSync(file);
    pre.exec('DROP TRIGGER IF EXISTS entries_ai; DROP TRIGGER IF EXISTS entries_ad; DROP TRIGGER IF EXISTS entries_au; DROP TABLE IF EXISTS entries_fts;');
    pre.close();
    const old = new V044(file);
    try {
      // The failure mode the rollback contract prevents: an FTS 'delete' for
      // a row the empty index never held.
      expect(() => old.db.prepare('UPDATE entries SET use_count = use_count + 1').run()).toThrow(/malformed/);
    } finally {
      old.close();
    }

    p = await openNew(file);
    try {
      expect(await newIds(p, 'ibex')).toEqual([...ids].sort());
      await expect(p.list({ confidence: [...ALL_TIERS], limit: 1000 })).resolves.toBeDefined();
    } finally {
      p.close();
    }
    const chk = new V044(file);
    try {
      expect(() => chk.integrity()).not.toThrow();
      expect(chk.query(['ibex']).sort()).toEqual([...ids].sort());
      expect(() => chk.db.prepare('UPDATE entries SET use_count = use_count + 1').run()).not.toThrow();
    } finally {
      chk.close();
    }
  });

  it('a stale legacy index with a matching row count is caught by the integrity check and rebuilt', async () => {
    const file = path.join(tmp, 'stale.sqlite');
    let p = await openNew(file);
    const id = (await p.capture(input('Okapi original title'))).id;
    p.close();

    // Change a row behind the legacy index's back (no trigger fires).
    const raw = new DatabaseSync(file);
    raw.exec('DROP TRIGGER entries_au');
    raw.prepare("UPDATE entries SET title = 'Narwhal replaced title' WHERE id = ?").run(id);
    raw.close();

    p = await openNew(file);
    p.close();
    const chk = new V044(file);
    try {
      expect(() => chk.integrity()).not.toThrow();
      expect(chk.query(['narwhal'])).toEqual([id]);
      expect(chk.query(['okapi'])).toEqual([]);
    } finally {
      chk.close();
    }
  });
});
