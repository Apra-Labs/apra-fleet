import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { KB_KEYWORD_INDEX_VERSION } from '../../src/services/knowledge/kb-index.js';
import { kbQuery } from '../../src/tools/kb-query.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';

// KB keyword index (design D2a), end to end against a real SqliteProvider on a
// temp kb.sqlite: identifier normalization at BOTH index and query time,
// per-column bm25 weights, the trigram partial-identifier index, migration of
// a DB built with the old external-content FTS schema, and the unchanged
// kb_query response contract.
//
// Falsifiability: reverting the normalizer (kb-normalize.ts normalizeTokens)
// to identity -- emitting the raw text unchanged -- makes the split and stem
// assertions below ('member split' and 'reading' finding the entry) fail. The
// compound identifier is deliberately mentioned only in the summary, which the
// trigram index does not cover, so no raw-substring path can satisfy them.
//
// Isolation: every file lives under one mkdtemp dir removed in afterAll.

const ALL_TIERS = ['CONFIRMED', 'INFERRED', 'UNVERIFIED'] as const;

let tmp: string;
let repo: string;
const providers: SqliteProvider[] = [];

function input(over: Partial<KBEntryInput>): KBEntryInput {
  return {
    type: 'knowledge',
    title: 'untitled',
    summary: 'no summary',
    content: 'no content',
    source_files: ['src/a.ts'],
    symbols: [],
    tags: [],
    content_hash: '',
    content_hash_type: 'sha256',
    flagged_for_review: false,
    author: 'kw-test',
    source: 'doer',
    confidence: 'INFERRED',
    ...over,
  };
}

async function freshProvider(name: string): Promise<SqliteProvider> {
  const p = new SqliteProvider(path.join(tmp, `${name}.sqlite`), repo);
  await p.init();
  providers.push(p);
  return p;
}

async function titles(p: SqliteProvider, query: string): Promise<string[]> {
  const r = await p.query({ query, confidence: [...ALL_TIERS], limit: 50 });
  return r.results.map(e => e.title);
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-keyword-index-'));
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(repo, 'src', 'services', 'knowledge'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(repo, 'src', 'b.ts'), 'export const b = 1;\n');
  fs.writeFileSync(path.join(repo, 'src', 'services', 'knowledge', 'kb-self.ts'), 'export const s = 1;\n');
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  for (const p of providers) p.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('normalization at index and query time', () => {
  let p: SqliteProvider;
  const TITLE = 'Cohort lookup helper';

  beforeAll(async () => {
    p = await freshProvider('norm');
    await p.capture(input({
      title: TITLE,
      summary: 'getMemberSplitRead decides the cohort.',
      content: 'Lives next to the session code.',
      source_files: ['src/services/knowledge/kb-self.ts'],
    }));
    await p.capture(input({
      title: 'Unrelated pelican note',
      summary: 'Pelicans glide.',
      content: 'Nothing about cohorts here.',
      source_files: ['src/b.ts'],
    }));
  });

  it("splits camelCase: 'member split' finds getMemberSplitRead", async () => {
    expect(await titles(p, 'member split')).toContain(TITLE);
  });

  it("stems: 'reading' finds the Read part of getMemberSplitRead", async () => {
    expect(await titles(p, 'reading')).toContain(TITLE);
  });

  it("splits paths and kebab-case: 'kb-self' finds source_files src/services/knowledge/kb-self.ts", async () => {
    const t = await titles(p, 'kb-self');
    expect(t).toContain(TITLE);
    expect(t).not.toContain('Unrelated pelican note');
  });

  it('the exact compound identifier still matches', async () => {
    expect(await titles(p, 'getMemberSplitRead')).toContain(TITLE);
  });

  it('fts_terms callers (prime) go through the same normalizer', async () => {
    const r = await p.query({ fts_terms: ['getMemberSplitRead'], confidence: [...ALL_TIERS] });
    expect(r.results.map(e => e.title)).toContain(TITLE);
  });
});

describe('column weights', () => {
  let p: SqliteProvider;

  beforeAll(async () => {
    p = await freshProvider('weights');
    // Same words in each pair; only the column carrying the query word differs.
    await p.capture(input({
      title: 'Alpha quasar ledger',
      summary: 'Notes on the ledger.',
      content: 'Ledger rows are batched.',
      source_files: ['src/a.ts'],
    }));
    await p.capture(input({
      title: 'Alpha ledger notes',
      summary: 'Notes on the ledger.',
      content: 'Ledger rows are batched quasar.',
      source_files: ['src/b.ts'],
    }));
    await p.capture(input({
      title: 'Beta pipeline record',
      summary: 'Pipeline record details.',
      content: 'Pipeline record rows.',
      symbols: ['nebulaHandler'],
      source_files: ['src/a.ts'],
    }));
    await p.capture(input({
      title: 'Beta pipeline entry',
      summary: 'Pipeline record details.',
      content: 'Pipeline record rows nebulaHandler.',
      symbols: [],
      source_files: ['src/b.ts'],
    }));
  });

  it('a title hit ranks above a content-only hit', async () => {
    const t = await titles(p, 'quasar');
    expect(t.slice(0, 2)).toEqual(['Alpha quasar ledger', 'Alpha ledger notes']);
  });

  it('a symbols hit ranks above a content-only hit', async () => {
    const t = await titles(p, 'nebulaHandler');
    expect(t.slice(0, 2)).toEqual(['Beta pipeline record', 'Beta pipeline entry']);
  });
});

describe('trigram index', () => {
  it('a partial identifier matches via the trigram index', async () => {
    const p = await freshProvider('trigram');
    await p.capture(input({
      title: 'Split read routing',
      summary: 'Routes reads.',
      content: 'See the symbol.',
      symbols: ['getMemberSplitRead'],
      source_files: ['src/a.ts'],
    }));
    expect(await titles(p, 'MemberSpl')).toEqual(['Split read routing']);
    // A partial that appears nowhere still returns nothing.
    expect(await titles(p, 'Zqxwv')).toEqual([]);
  });

  it('a full-token hit ranks above a trigram-only hit', async () => {
    const p = await freshProvider('trigram-rank');
    await p.capture(input({
      title: 'Holder of the partial',
      summary: 'Partial only.',
      content: 'nothing',
      symbols: ['widgetsmithery'],
      source_files: ['src/a.ts'],
    }));
    await p.capture(input({
      title: 'Holder of the token',
      summary: 'Full token.',
      content: 'widgetsmith appears whole here',
      source_files: ['src/b.ts'],
    }));
    const t = await titles(p, 'widgetsmith');
    expect(t[0]).toBe('Holder of the token');
    expect(t).toContain('Holder of the partial');
  });
});

describe('migration from the old external-content FTS schema', () => {
  const OLD_COUNT = 450;
  let dbFile: string;
  let rowidsBefore: unknown;

  beforeAll(() => {
    dbFile = path.join(tmp, 'old-schema.sqlite');
    const old = new DatabaseSync(dbFile);
    old.exec(`
      CREATE TABLE entries (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL,
        content TEXT NOT NULL, source_files TEXT NOT NULL DEFAULT '[]', symbols TEXT NOT NULL DEFAULT '[]',
        module TEXT, tags TEXT NOT NULL DEFAULT '[]', content_hash TEXT NOT NULL DEFAULT '',
        content_hash_type TEXT NOT NULL DEFAULT 'sha256', stale INTEGER NOT NULL DEFAULT 0,
        flagged_for_review INTEGER NOT NULL DEFAULT 0, contradiction_of TEXT,
        author TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'doer',
        confidence TEXT NOT NULL DEFAULT 'INFERRED', scope TEXT NOT NULL DEFAULT 'project',
        created_at TEXT NOT NULL, superseded_at TEXT, promoted_at TEXT,
        use_count INTEGER NOT NULL DEFAULT 0, last_accessed TEXT
      );
      CREATE VIRTUAL TABLE entries_fts USING fts5(
        title, summary, content, tags, content='entries', content_rowid='rowid'
      );
      CREATE TRIGGER entries_ai AFTER INSERT ON entries BEGIN
        INSERT INTO entries_fts(rowid, title, summary, content, tags)
        VALUES (new.rowid, new.title, new.summary, new.content, new.tags);
      END;
      CREATE TRIGGER entries_ad AFTER DELETE ON entries BEGIN
        INSERT INTO entries_fts(entries_fts, rowid, title, summary, content, tags)
        VALUES ('delete', old.rowid, old.title, old.summary, old.content, old.tags);
      END;
      CREATE TRIGGER entries_au AFTER UPDATE ON entries BEGIN
        INSERT INTO entries_fts(entries_fts, rowid, title, summary, content, tags)
        VALUES ('delete', old.rowid, old.title, old.summary, old.content, old.tags);
        INSERT INTO entries_fts(rowid, title, summary, content, tags)
        VALUES (new.rowid, new.title, new.summary, new.content, new.tags);
      END;
    `);
    const ins = old.prepare(
      'INSERT INTO entries (id, type, title, summary, content, source_files, symbols, confidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    for (let i = 0; i < OLD_COUNT; i++) {
      ins.run(
        `legacy-${i}`, 'knowledge', `Legacy fact ${i} about orbitwidget`, `Summary ${i}.`, `Body ${i}.`,
        '["src/a.ts"]', `["legacyHandler${i}"]`, 'CONFIRMED', new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      );
    }
    rowidsBefore = old.prepare('SELECT id, rowid AS r FROM entries ORDER BY rowid').all();
    old.close();
  });

  it('migrates in place: queries answer during the background rebuild, every entry survives, version recorded', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logs.push(args.join(' ')); });

    const p = new SqliteProvider(dbFile, repo);
    await p.init();
    providers.push(p);

    // init did not wait for the rebuild.
    const atInit = p.keywordIndexStatus();
    expect(atInit.ready).toBe(false);
    expect(atInit.rebuilding).toBe(true);
    expect(atInit.pending).toBeGreaterThan(0);

    // A query issued during the rebuild returns results instead of throwing.
    const during = await p.query({ query: 'orbitwidget', confidence: [...ALL_TIERS], limit: 1000 });
    expect(during.results.length).toBe(OLD_COUNT);

    expect(await p.waitForKeywordIndex(30_000)).toBe(true);
    const status = p.keywordIndexStatus();
    expect(status.version).toBe(KB_KEYWORD_INDEX_VERSION);
    expect(status.rebuild_finished_at).not.toBeNull();
    expect(status.pending).toBe(0);
    expect(logs.some(l => /keyword index rebuild started/.test(l))).toBe(true);
    expect(logs.some(l => /keyword index rebuild finished/.test(l))).toBe(true);

    // Every old entry is still found through kb_query.
    vi.spyOn(kbProvidersModule, 'getKbProviders').mockResolvedValue({
      project: p, global: p, projectSlug: 'kw-test',
    } as any);
    const out = JSON.parse(await kbQuery({ query: 'orbitwidget', limit: 1000, confidence: [...ALL_TIERS] }));
    const ids = new Set(out.l1_results.map((e: { id: string }) => e.id));
    for (let i = 0; i < OLD_COUNT; i++) expect(ids.has(`legacy-${i}`)).toBe(true);

    // Normalization now applies to migrated rows: a split symbol part finds one.
    const sym = await p.query({ query: 'legacy handler 17', confidence: [...ALL_TIERS], limit: 5 });
    expect(sym.results.map(e => e.id)).toContain('legacy-17');

    // ids and rowids unchanged; the legacy FTS and its triggers are KEPT,
    // complete and consistent, for an older build on the same file (kb-index.ts
    // header, rollback contract).
    p.close();
    const chk = new DatabaseSync(dbFile);
    try {
      expect(chk.prepare('SELECT id, rowid AS r FROM entries ORDER BY rowid').all()).toEqual(rowidsBefore);
      const legacy = chk.prepare(
        "SELECT name FROM sqlite_master WHERE name IN ('entries_fts', 'entries_ai', 'entries_ad', 'entries_au') ORDER BY name"
      ).all() as { name: string }[];
      expect(legacy.map(r => r.name)).toEqual(['entries_ad', 'entries_ai', 'entries_au', 'entries_fts']);
      const docs = chk.prepare('SELECT COUNT(*) AS n FROM entries_fts_docsize').get() as { n: number };
      expect(Number(docs.n)).toBe(OLD_COUNT);
      expect(() => chk.exec("INSERT INTO entries_fts(entries_fts, rank) VALUES ('integrity-check', 1)")).not.toThrow();
      const meta = chk.prepare("SELECT value FROM kb_index_meta WHERE key = 'kw_version'").get() as { value: string };
      expect(meta.value).toBe(KB_KEYWORD_INDEX_VERSION);
    } finally {
      chk.close();
    }
  });
});

describe('non-ASCII text in the keyword index (strings written as \\u escapes)', () => {
  const GRUESSE = 'Gr\u00fc\u00dfe';
  const NIHONGO = '\u65e5\u672c\u8a9e';

  it('a keyword kb_query for a non-ASCII word finds the entry whose title contains it', async () => {
    const p = await freshProvider('non-ascii');
    const de = await p.capture(input({ title: `${GRUESSE} aus dem Lager`, summary: 'German note.', content: 'Body.' }));
    const ja = await p.capture(input({ title: `${NIHONGO} notes`, summary: 'Japanese note.', content: 'Body.', source_files: ['src/b.ts'] }));
    await p.capture(input({ title: 'Plain ascii neighbour', summary: 'Nothing else.', content: 'Body.' }));
    vi.spyOn(kbProvidersModule, 'getKbProviders').mockResolvedValue({
      project: p, global: p, projectSlug: 'kw-test',
    } as any);
    const q1 = JSON.parse(await kbQuery({ query: GRUESSE, limit: 10, confidence: [...ALL_TIERS] }));
    expect(q1.l1_results.map((e: { id: string }) => e.id)).toEqual([de.id]);
    const q2 = JSON.parse(await kbQuery({ query: NIHONGO, limit: 10, confidence: [...ALL_TIERS] }));
    expect(q2.l1_results.map((e: { id: string }) => e.id)).toEqual([ja.id]);
  });

  it('an index built by the previous normalizer version rebuilds on the next open and keeps the legacy index intact', async () => {
    const file = path.join(tmp, 'norm-version.sqlite');
    let p = new SqliteProvider(file, repo);
    await p.init();
    const de = await p.capture(input({ title: `${GRUESSE} vom Versionstest`, summary: 'Version note.', content: 'Body.' }));
    await p.capture(input({ title: 'Ascii sibling for the version test', summary: 'Sibling.', content: 'Body.' }));
    expect(await p.waitForKeywordIndex(30_000)).toBe(true);
    p.close();

    // Make the DB look like a ready index from normalizer version 1, which
    // dropped every non-ASCII token.
    expect(KB_KEYWORD_INDEX_VERSION).toContain('norm2');
    const raw = new DatabaseSync(file);
    raw.prepare("UPDATE kb_index_meta SET value = ? WHERE key = 'kw_version'").run(KB_KEYWORD_INDEX_VERSION.replace('norm2', 'norm1'));
    raw.exec('DELETE FROM entries_kw');
    raw.close();

    p = new SqliteProvider(file, repo);
    await p.init();
    providers.push(p);
    const atInit = p.keywordIndexStatus();
    expect(atInit.ready).toBe(false);
    expect(atInit.rebuilding).toBe(true);
    expect(await p.waitForKeywordIndex(30_000)).toBe(true);
    expect(p.keywordIndexStatus().version).toBe(KB_KEYWORD_INDEX_VERSION);
    const r = await p.query({ query: GRUESSE, confidence: [...ALL_TIERS], limit: 10 });
    expect(r.results.map(e => e.id)).toEqual([de.id]);

    // The version-triggered rebuild keeps the rollback contract (kb-index.ts).
    const chk = new DatabaseSync(file);
    try {
      const docs = chk.prepare('SELECT COUNT(*) AS n FROM entries_fts_docsize').get() as { n: number };
      expect(Number(docs.n)).toBe(2);
      expect(() => chk.exec("INSERT INTO entries_fts(entries_fts, rank) VALUES ('integrity-check', 1)")).not.toThrow();
    } finally {
      chk.close();
    }
  });
});

describe('additive kb_query contract', () => {
  it('query + limit returns the same response keys and entry keys as before', async () => {
    const p = await freshProvider('contract');
    await p.capture(input({ title: 'Contract shape entry', summary: 'Shape check.', content: 'Shape body.' }));
    vi.spyOn(kbProvidersModule, 'getKbProviders').mockResolvedValue({
      project: p, global: p, projectSlug: 'kw-test',
    } as any);
    const out = JSON.parse(await kbQuery({ query: 'shape', limit: 5, confidence: [...ALL_TIERS] }));
    expect(Object.keys(out).sort()).toEqual(['l1_results', 'l2_expanded']);
    expect(out.l1_results).toHaveLength(1);
    const byId = (await p.query({ ids: [out.l1_results[0].id] })).results[0];
    // No index-internal column (rowid, score) leaks into a result row.
    expect(Object.keys(out.l1_results[0]).sort()).toEqual(Object.keys(JSON.parse(JSON.stringify(byId))).sort());
  });
});
