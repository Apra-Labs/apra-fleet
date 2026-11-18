import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import {
  KB_KEYWORD_INDEX_VERSION,
  MAX_QUERY_KEYWORD_TERMS,
  boundedQueryTerms,
} from '../../src/services/knowledge/kb-keyword-index.js';

// Upgrade safety for the keyword index: a kb.sqlite built with the 0.4.5
// schema (tests/fixtures/kb-v045-schema.sql, dumped from what 0.4.5 creates;
// no entries_kw, no index version) opens with this build and answers through
// the new index with no manual step. Writes made by an older build (plain SQL
// on entries) are picked up on the next read, and the legacy entries_fts that
// an older build reads stays consistent.

const SCHEMA_045 = fs.readFileSync(path.resolve(__dirname, '../fixtures/kb-v045-schema.sql'), 'utf-8');

let dir: string;
let dbFile: string;
const open: SqliteProvider[] = [];

/** Insert a row exactly the way 0.4.5's insertEntry writes one (legacy triggers fire). */
function insert045(db: DatabaseSync, id: string, title: string, summary: string, symbols: string[] = [], files: string[] = []): void {
  db.prepare(`
    INSERT INTO entries (id, type, title, summary, content, source_files, symbols, tags, author, source,
      confidence, scope, created_at, source_file_hashes)
    VALUES (?, 'knowledge', ?, ?, ?, ?, ?, '[]', 'doer', 'doer', 'CONFIRMED', 'project', ?, '{}')
  `).run(id, title, summary, summary, JSON.stringify(files), JSON.stringify(symbols), new Date().toISOString());
}

function build045Kb(): void {
  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec(SCHEMA_045);
  insert045(db, 'e-split', 'getMemberSplitRead merges the bible half first', 'Member mixed-tier reads are split by tier.', ['getMemberSplitRead'], ['src/services/knowledge/kb-self.ts']);
  insert045(db, 'e-retry', 'Retrying uploads after a failed handshake', 'The client retries failed uploads with backoff.');
  insert045(db, 'e-other', 'Dashboard colours', 'Theme palette for the dashboard.');
  db.close();
}

async function openProvider(): Promise<SqliteProvider> {
  const p = new SqliteProvider(dbFile);
  await p.init();
  open.push(p);
  return p;
}

async function ids(p: SqliteProvider, query: string): Promise<string[]> {
  return (await p.query({ query, limit: 20 })).results.map(e => e.id);
}

function legacyIntegrityOk(): void {
  const db = new DatabaseSync(dbFile);
  try {
    // Throws "database disk image is malformed" when the external-content
    // index disagrees with entries.
    db.exec("INSERT INTO entries_fts(entries_fts) VALUES ('integrity-check')");
    const n = (db.prepare('SELECT count(*) AS n FROM entries').get() as { n: number }).n;
    const legacyHits = db.prepare('SELECT count(*) AS n FROM entries_fts WHERE entries_fts MATCH ?').get('"dashboard" OR "retrying" OR "getMemberSplitRead" OR "added"') as { n: number };
    expect(legacyHits.n).toBeLessThanOrEqual(n);
  } finally {
    db.close();
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-kw-upgrade-'));
  dbFile = path.join(dir, 'kb.sqlite');
  build045Kb();
});

afterEach(() => {
  while (open.length) open.pop()!.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('keyword index upgrade from a 0.4.5 kb.sqlite', () => {
  it('the fixture really is the 0.4.5 shape: legacy FTS present, no keyword index', () => {
    const db = new DatabaseSync(dbFile);
    const names = (db.prepare("SELECT name FROM sqlite_master").all() as Array<{ name: string }>).map(r => r.name);
    db.close();
    expect(names).toContain('entries_fts');
    expect(names).not.toContain('entries_kw');
    expect(names).not.toContain('kb_index_meta');
  });

  it('opens with no manual step, rebuilds the index and answers normalized queries', async () => {
    const p = await openProvider();
    // Split identifier parts and a stemmed form find entries the 0.4.5 read
    // could not ("member split read" vs getMemberSplitRead; "retry" vs Retrying).
    expect(await ids(p, 'member split read')).toEqual(['e-split']);
    expect(await ids(p, 'retry handshake')).toEqual(['e-retry']);
    // A path the entry cites is searchable by its parts.
    expect(await ids(p, 'kb-self.ts')).toEqual(['e-split']);
    const db = new DatabaseSync(dbFile);
    const v = db.prepare("SELECT value FROM kb_index_meta WHERE key = 'kw_version'").get() as { value: string };
    const kwRows = (db.prepare('SELECT count(*) AS n FROM entries_kw').get() as { n: number }).n;
    db.close();
    expect(v.value).toBe(KB_KEYWORD_INDEX_VERSION);
    expect(kwRows).toBe(3);
  });

  it('picks up writes an older build makes through plain SQL on entries (insert, update, delete)', async () => {
    const p = await openProvider();
    expect(await ids(p, 'dashboard')).toEqual(['e-other']);
    const old = new DatabaseSync(dbFile);
    old.exec('PRAGMA busy_timeout=5000');
    insert045(old, 'e-added', 'Added by an older build', 'Webhook signature verification.');
    old.prepare("UPDATE entries SET title = 'Status page colours', summary = 'Theme palette.', content = 'Theme palette.' WHERE id = 'e-other'").run();
    old.prepare("DELETE FROM entries WHERE id = 'e-retry'").run();
    old.close();
    expect(await ids(p, 'webhook signatures')).toEqual(['e-added']);
    expect(await ids(p, 'dashboard')).toEqual([]);
    expect(await ids(p, 'status page')).toEqual(['e-other']);
    expect(await ids(p, 'retry handshake')).toEqual([]);
    legacyIntegrityOk();
  });

  it('a use_count bump (every read) does not queue a re-index', async () => {
    const p = await openProvider();
    await ids(p, 'dashboard');
    await ids(p, 'dashboard');
    const db = new DatabaseSync(dbFile);
    const pending = (db.prepare('SELECT count(*) AS n FROM kb_index_pending').get() as { n: number }).n;
    db.close();
    expect(pending).toBe(0);
  });

  it('rebuilds on open when the stored index version is older, and only once', async () => {
    let p = await openProvider();
    p.close();
    open.pop();
    const db = new DatabaseSync(dbFile);
    db.prepare("UPDATE kb_index_meta SET value = 'kw0-norm0' WHERE key = 'kw_version'").run();
    db.exec('DELETE FROM entries_kw');
    db.close();
    p = await openProvider();
    expect(await ids(p, 'member split read')).toEqual(['e-split']);
    const check = new DatabaseSync(dbFile);
    expect((check.prepare("SELECT value FROM kb_index_meta WHERE key = 'kw_version'").get() as { value: string }).value).toBe(KB_KEYWORD_INDEX_VERSION);
    check.close();
    // A second handle on the same file finds the index current and leaves it be.
    const p2 = await openProvider();
    expect(await ids(p2, 'member split read')).toEqual(['e-split']);
  });

  it('an older build reopening the upgraded file still answers from the legacy index', async () => {
    const p = await openProvider();
    await ids(p, 'dashboard');
    p.close();
    open.pop();
    // What 0.4.5 runs on open: the same IF NOT EXISTS DDL, then its keyword read.
    const old = new DatabaseSync(dbFile);
    old.exec(SCHEMA_045.replace(/CREATE (TABLE|INDEX|VIRTUAL TABLE|TRIGGER) /g, 'CREATE $1 IF NOT EXISTS '));
    const rows = old.prepare(`
      SELECT e.id FROM entries e JOIN entries_fts ON entries_fts.rowid = e.rowid
      WHERE entries_fts MATCH ? ORDER BY rank
    `).all('"dashboard"') as Array<{ id: string }>;
    old.close();
    expect(rows.map(r => r.id)).toEqual(['e-other']);
    legacyIntegrityOk();
  });
});

describe('bounded free-text query terms', () => {
  it('keeps the first MAX_QUERY_KEYWORD_TERMS distinct terms', () => {
    const words = Array.from({ length: MAX_QUERY_KEYWORD_TERMS + 10 }, (_, i) => `w${i}`);
    const terms = boundedQueryTerms(words.join(' '));
    expect(terms).toHaveLength(MAX_QUERY_KEYWORD_TERMS);
    expect(terms[0]).toBe('w0');
    expect(terms).not.toContain(`w${MAX_QUERY_KEYWORD_TERMS}`);
  });

  it('a term past the bound does not match; the same term early does', async () => {
    const p = await openProvider();
    const filler = Array.from({ length: MAX_QUERY_KEYWORD_TERMS }, (_, i) => `zz${i}`).join(' ');
    expect(await ids(p, `${filler} dashboard`)).toEqual([]);
    expect(await ids(p, `dashboard ${filler}`)).toEqual(['e-other']);
  });

  it('discrete fts_terms are never bounded', async () => {
    const p = await openProvider();
    const terms = [...Array.from({ length: MAX_QUERY_KEYWORD_TERMS + 5 }, (_, i) => `zz${i}`), 'getMemberSplitRead'];
    const r = await p.query({ fts_terms: terms, limit: 20 });
    expect(r.results.map(e => e.id)).toEqual(['e-split']);
  });
});
