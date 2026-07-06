import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { FLEET_DIR } from '../../paths.js';
import { resolveProjectSlug } from './project-slug.js';
import {
  hasContradictionKeywords,
  symbolsOverlap,
  filesOverlap,
  makeFtsQuery,
  makeAudnDecision,
} from './audn.js';
import { computeFileHashBatch } from './file-hash.js';
import type {
  MemoryProvider,
  KBEntry,
  KBEntryInput,
  QueryOptions,
  KBResult,
  FileContextResult,
  PrimeOptions,
  PrimedContext,
  SyncOptions,
  SyncResult,
  AudnDecision,
  Confidence,
  CodeIntelCall,
} from './types.js';

const CONTENT_CAP = 4000;
const TRUNCATION_SUFFIX = '...[truncated]';

function truncateContent(content: string): string {
  if (content.length <= CONTENT_CAP) return content;
  return content.slice(0, CONTENT_CAP) + TRUNCATION_SUFFIX;
}

class NotImplementedError extends Error {
  constructor(method: string) {
    super(`SqliteProvider.${method}() not yet implemented`);
    this.name = 'NotImplementedError';
  }
}

export class SqliteProvider implements MemoryProvider {
  private db: Database.Database | null = null;
  readonly dbPath: string;
  readonly projectSlug: string;

  constructor(dbPath?: string) {
    if (dbPath !== undefined) {
      this.dbPath = dbPath;
      this.projectSlug = path.basename(dbPath, '.sqlite') || 'custom';
    } else {
      const slug = resolveProjectSlug();
      this.projectSlug = slug;
      const dir = path.join(FLEET_DIR, 'knowledge', slug);
      fs.mkdirSync(dir, { recursive: true });
      this.dbPath = path.join(dir, 'kb.sqlite');
    }
  }

  async init(): Promise<void> {
    if (this.db !== null) return;

    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(this.dbPath);

    this.db.pragma('journal_mode=WAL');
    this.db.pragma('busy_timeout=5000');
    this.db.pragma('synchronous=NORMAL');
    this.db.pragma('cache_size=-20000');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        content TEXT NOT NULL,
        source_files TEXT NOT NULL DEFAULT '[]',
        symbols TEXT NOT NULL DEFAULT '[]',
        module TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        content_hash TEXT NOT NULL DEFAULT '',
        content_hash_type TEXT NOT NULL DEFAULT 'sha256',
        stale INTEGER NOT NULL DEFAULT 0,
        flagged_for_review INTEGER NOT NULL DEFAULT 0,
        contradiction_of TEXT,
        author TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'doer',
        confidence TEXT NOT NULL DEFAULT 'INFERRED',
        scope TEXT NOT NULL DEFAULT 'project',
        created_at TEXT NOT NULL,
        superseded_at TEXT,
        promoted_at TEXT,
        use_count INTEGER NOT NULL DEFAULT 0,
        last_accessed TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_entries_type ON entries(type);
      CREATE INDEX IF NOT EXISTS idx_entries_confidence ON entries(confidence);
      CREATE INDEX IF NOT EXISTS idx_entries_created_at ON entries(created_at);
      CREATE INDEX IF NOT EXISTS idx_entries_superseded_at ON entries(superseded_at);
      CREATE INDEX IF NOT EXISTS idx_entries_use_count ON entries(use_count);

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

      CREATE TABLE IF NOT EXISTS links (
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        link_type TEXT NOT NULL,
        PRIMARY KEY (from_id, to_id, link_type)
      );
    `);

    // Migration: add scope column to existing DBs
    try {
      this.db.exec("ALTER TABLE entries ADD COLUMN scope TEXT NOT NULL DEFAULT 'project'");
    } catch {}
  }

  private getDb(): Database.Database {
    if (!this.db) throw new Error('SqliteProvider not initialized. Call init() first.');
    return this.db;
  }

  private rowToEntry(row: Record<string, unknown>): KBEntry {
    return {
      id: row.id as string,
      type: row.type as KBEntry['type'],
      title: row.title as string,
      summary: row.summary as string,
      content: row.content as string,
      source_files: JSON.parse((row.source_files as string) || '[]'),
      symbols: JSON.parse((row.symbols as string) || '[]'),
      module: row.module as string | undefined,
      tags: JSON.parse((row.tags as string) || '[]'),
      content_hash: row.content_hash as string,
      content_hash_type: row.content_hash_type as 'git' | 'sha256',
      stale: (row.stale as number) === 1,
      flagged_for_review: (row.flagged_for_review as number) === 1,
      contradiction_of: row.contradiction_of as string | undefined,
      author: row.author as string,
      source: row.source as KBEntry['source'],
      confidence: row.confidence as Confidence,
      scope: (row.scope as 'project' | 'global' | undefined) ?? 'project',
      created_at: row.created_at as string,
      superseded_at: row.superseded_at as string | undefined,
      promoted_at: row.promoted_at as string | undefined,
      use_count: row.use_count as number,
      last_accessed: row.last_accessed as string | undefined,
    };
  }

  private insertEntry(
    db: Database.Database,
    id: string,
    input: KBEntryInput,
    content: string,
    now: string
  ): void {
    db.prepare(`
      INSERT INTO entries (
        id, type, title, summary, content,
        source_files, symbols, module, tags,
        content_hash, content_hash_type, stale,
        flagged_for_review, contradiction_of,
        author, source, confidence, scope, created_at,
        superseded_at, promoted_at, use_count
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?,
        ?, ?, ?, ?, ?,
        NULL, NULL, 0
      )
    `).run(
      id,
      input.type,
      input.title,
      input.summary,
      content,
      JSON.stringify(input.source_files ?? []),
      JSON.stringify(input.symbols ?? []),
      input.module ?? null,
      JSON.stringify(input.tags ?? []),
      input.content_hash ?? '',
      input.content_hash_type ?? 'sha256',
      0,
      input.flagged_for_review ? 1 : 0,
      input.contradiction_of ?? null,
      input.author ?? '',
      input.source,
      input.confidence,
      input.scope ?? 'project',
      now
    );
  }

  private findAudnCandidates(db: Database.Database, input: KBEntryInput): KBEntry[] {
    const ftsQuery = makeFtsQuery(input.title);
    if (!ftsQuery) return [];
    try {
      const rows = db.prepare(`
        SELECT e.* FROM entries e
        JOIN entries_fts ON entries_fts.rowid = e.rowid
        WHERE entries_fts MATCH ?
          AND e.superseded_at IS NULL
          AND e.type = ?
        ORDER BY rank
        LIMIT 10
      `).all(ftsQuery, input.type) as Record<string, unknown>[];
      return rows.map(r => this.rowToEntry(r));
    } catch {
      return [];
    }
  }

  private evaluateAudn(
    db: Database.Database,
    input: KBEntryInput,
    candidates: KBEntry[],
    newContent: string,
    now: string
  ): { id: string; audn_decision: AudnDecision } | null {
    const decision = makeAudnDecision(input, candidates, newContent);
    if (!decision) return null;

    if (decision.decision === 'none') {
      return { id: decision.matchedId, audn_decision: 'none' };
    }

    if (decision.decision === 'flagged') {
      db.prepare('UPDATE entries SET flagged_for_review = 1 WHERE id = ?').run(decision.matchedId);
      const newId = randomUUID();
      this.insertEntry(db, newId, { ...input, ...decision.newEntryOverrides }, newContent, now);
      this.wireLinks(db, newId, input);
      return { id: newId, audn_decision: 'flagged' };
    }

    if (decision.decision === 'update') {
      // D2 (F2a): a superseded entry MUST be marked both superseded_at AND
      // stale = 1 so it is excluded from query()/prime() by default (query
      // filters stale = 0 independently of superseded_at). content_hash is
      // left intact. Only the 'update' branch touches this; the flagged/none
      // branches are owned by the contradiction path.
      db.prepare('UPDATE entries SET superseded_at = ?, stale = 1 WHERE id = ?').run(now, decision.matchedId);
      const newId = randomUUID();
      this.insertEntry(db, newId, input, newContent, now);
      this.wireLinks(db, newId, input);
      return { id: newId, audn_decision: 'update' };
    }

    return null;
  }

  private decayConceptEntries(db: Database.Database, days: number): void {
    const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString();
    db.prepare(`
      UPDATE entries
      SET confidence = 'UNVERIFIED'
      WHERE confidence = 'INFERRED'
        AND superseded_at IS NULL
        AND (source_files = '[]' OR source_files IS NULL OR source_files = '')
        AND (last_accessed IS NULL OR last_accessed < ?)
        AND (promoted_at IS NULL OR promoted_at < ?)
    `).run(cutoff, cutoff);
  }

  private wireLinks(db: Database.Database, newId: string, input: KBEntryInput): void {
    const symbols = input.symbols ?? [];
    const files = input.source_files ?? [];
    if (symbols.length === 0 && files.length === 0) return;

    const existingRows = db.prepare(
      'SELECT id, symbols, source_files FROM entries WHERE id != ? AND superseded_at IS NULL'
    ).all(newId) as { id: string; symbols: string; source_files: string }[];

    const linkStmt = db.prepare(
      'INSERT OR IGNORE INTO links (from_id, to_id, link_type) VALUES (?, ?, ?)'
    );

    for (const row of existingRows) {
      const existingSymbols: string[] = JSON.parse(row.symbols || '[]');
      const existingFiles: string[] = JSON.parse(row.source_files || '[]');
      if (symbols.length > 0 && symbols.some(s => existingSymbols.includes(s))) {
        linkStmt.run(newId, row.id, 'shares_symbol');
      }
      if (files.length > 0 && files.some(f => existingFiles.includes(f))) {
        linkStmt.run(newId, row.id, 'shares_file');
      }
    }
  }

  async capture(input: KBEntryInput): Promise<{ id: string; audn_decision: AudnDecision }> {
    const db = this.getDb();
    const now = new Date().toISOString();
    const content = truncateContent(input.content);

    const candidates = this.findAudnCandidates(db, input);
    if (candidates.length > 0) {
      const result = this.evaluateAudn(db, input, candidates, content, now);
      if (result) return result;
    }

    const id = randomUUID();
    this.insertEntry(db, id, input, content, now);
    this.wireLinks(db, id, input);
    return { id, audn_decision: 'add' };
  }

  async query(opts: QueryOptions): Promise<KBResult> {
    const db = this.getDb();
    const conditions: string[] = [];
    const params: unknown[] = [];

    // Direct ID lookup bypasses FTS and filters
    if (opts.ids?.length) {
      const placeholders = opts.ids.map(() => '?').join(',');
      const rows = db.prepare(
        `SELECT * FROM entries WHERE id IN (${placeholders})`
      ).all(...opts.ids) as Record<string, unknown>[];

      const results = rows.map(r => this.rowToEntry(r));
      if (results.length > 0) {
        db.prepare(`
          UPDATE entries SET use_count = use_count + 1, last_accessed = ?
          WHERE id IN (${results.map(() => '?').join(',')})
        `).run(new Date().toISOString(), ...results.map(r => r.id));
      }
      return { results, total: results.length, l1_only: false };
    }

    if (!opts.include_superseded) {
      conditions.push('e.superseded_at IS NULL');
    }
    if (!opts.include_stale) {
      conditions.push('e.stale = 0');
    }
    if (opts.type) {
      conditions.push('e.type = ?');
      params.push(opts.type);
    }
    if (opts.flagged_only) {
      conditions.push('(e.flagged_for_review = 1 OR e.contradiction_of IS NOT NULL)');
    }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const limit = opts.limit ?? 20;

    let rows: Record<string, unknown>[];

    if (opts.query) {
      const ftsWhere = conditions.length > 0 ? 'AND ' + conditions.join(' AND ') : '';
      rows = db.prepare(`
        SELECT e.* FROM entries e
        JOIN entries_fts ON entries_fts.rowid = e.rowid
        WHERE entries_fts MATCH ?
        ${ftsWhere}
        ORDER BY rank
        LIMIT ?
      `).all(opts.query, ...params, limit) as Record<string, unknown>[];
    } else {
      rows = db.prepare(`
        SELECT e.* FROM entries e
        ${where}
        ORDER BY e.created_at DESC
        LIMIT ?
      `).all(...params, limit) as Record<string, unknown>[];
    }

    const results = rows.map(r => {
      const entry = this.rowToEntry(r);
      if (opts.l1_only) {
        return { ...entry, content: '' };
      }
      return entry;
    });

    if (results.length > 0) {
      db.prepare(`
        UPDATE entries SET use_count = use_count + 1, last_accessed = ?
        WHERE id IN (${results.map(() => '?').join(',')})
      `).run(new Date().toISOString(), ...results.map(r => r.id));
    }

    return { results, total: results.length, l1_only: opts.l1_only ?? false };
  }

  async context(files: string[]): Promise<FileContextResult[]> {
    const db = this.getDb();
    const results: FileContextResult[] = [];

    const fileEntries = new Map<string, KBEntry>();
    for (const file of files) {
      const rows = db.prepare(`
        SELECT * FROM entries
        WHERE type = 'context-cache'
          AND superseded_at IS NULL
          AND EXISTS (SELECT 1 FROM json_each(source_files) WHERE value = ?)
        ORDER BY created_at DESC
        LIMIT 1
      `).all(file) as Record<string, unknown>[];

      if (rows.length > 0) {
        fileEntries.set(file, this.rowToEntry(rows[0]));
      }
    }

    const hashes = await computeFileHashBatch(files);

    for (const file of files) {
      const entry = fileEntries.get(file);
      if (!entry) {
        results.push({ file, status: 'missing' });
        continue;
      }

      if (entry.content_hash === 'invalidated') {
        results.push({ file, status: 'stale', reason: 'invalidated', entry_id: entry.id });
        continue;
      }

      const hashResult = hashes[file];
      if (!hashResult) {
        results.push({ file, status: 'stale', reason: 'file_missing', entry_id: entry.id });
        continue;
      }

      if (hashResult.hash === entry.content_hash) {
        results.push({
          file,
          status: 'fresh',
          summary: entry.summary,
          content_hash: entry.content_hash,
          entry_id: entry.id,
        });
      } else {
        results.push({ file, status: 'stale', reason: 'hash_mismatch', entry_id: entry.id });
      }
    }

    return results;
  }

  async invalidate(files: string[]): Promise<{ invalidated: number }> {
    const db = this.getDb();
    let invalidated = 0;

    for (const file of files) {
      const rows = db.prepare(`
        SELECT id FROM entries
        WHERE type = 'context-cache'
          AND superseded_at IS NULL
          AND EXISTS (
            SELECT 1 FROM json_each(source_files) WHERE value = ?
          )
      `).all(file) as { id: string }[];

      if (rows.length > 0) {
        const ids = rows.map(r => r.id);
        db.prepare(`
          UPDATE entries
          SET content_hash = 'invalidated', stale = 1
          WHERE id IN (${ids.map(() => '?').join(',')})
        `).run(...ids);
        invalidated += ids.length;
      }
    }

    return { invalidated };
  }

  async getLinked(id: string): Promise<KBEntry[]> {
    const db = this.getDb();
    const rows = db.prepare(`
      SELECT DISTINCT e.* FROM entries e
      JOIN links l ON (l.from_id = ? AND l.to_id = e.id)
                   OR (l.to_id = ? AND l.from_id = e.id)
      WHERE e.superseded_at IS NULL
    `).all(id, id) as Record<string, unknown>[];
    return rows.map(r => this.rowToEntry(r));
  }

  async prime(opts: PrimeOptions): Promise<PrimedContext> {
    this.decayConceptEntries(this.getDb(), opts.decay_after_days ?? 30);

    const fileResults = opts.session_files?.length
      ? await this.context(opts.session_files)
      : [];

    const stale_files = fileResults
      .filter(r => r.status === 'stale' || r.status === 'missing')
      .map(r => r.file);

    const fresh_summaries = fileResults.filter(r => r.status === 'fresh');

    const session_warm = opts.session_files?.length
      ? stale_files.length === 0
      : true;

    const searchTerms: string[] = [];
    if (opts.hint_symbols?.length) searchTerms.push(...opts.hint_symbols);
    if (opts.hint_modules?.length) searchTerms.push(...opts.hint_modules);

    let top_entries: KBEntry[] = [];
    if (searchTerms.length > 0) {
      try {
        const l1 = await this.query({
          query: searchTerms.join(' '),
          l1_only: true,
          limit: 10,
          include_stale: false,
        });
        top_entries = l1.results
          .filter(e => e.type !== 'context-cache')
          .map(e => ({ ...e, content: '' }));
      } catch {
        // FTS match may fail on unusual tokens
      }
    }

    const recommended_code_calls: CodeIntelCall[] = [];
    if (opts.hint_symbols?.length) {
      for (const symbol of opts.hint_symbols) {
        recommended_code_calls.push({ tool: 'code_context', args: { name: symbol } });
      }
    }
    if (opts.session_files?.length) {
      for (const file of opts.session_files) {
        recommended_code_calls.push({ tool: 'code_impact', args: { target: file, direction: 'upstream' } });
      }
    }

    let token_estimate = 0;
    for (const entry of top_entries) {
      token_estimate += Math.ceil((entry.summary?.length || 0) / 4);
    }
    for (const result of fresh_summaries) {
      token_estimate += Math.ceil((result.summary?.length || 0) / 4);
    }

    return {
      session_warm,
      stale_files,
      top_entries,
      fresh_summaries,
      recommended_code_calls,
      token_estimate,
    };
  }

  async promote(id: string, reason?: string): Promise<{ id: string; confidence_before: Confidence; confidence_after: Confidence }> {
    const db = this.getDb();
    const row = db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`Entry not found: ${id}`);

    const entry = this.rowToEntry(row);
    if (entry.superseded_at) throw new Error(`Cannot promote superseded entry: ${id}`);

    const confidence_before = entry.confidence;
    let confidence_after: Confidence;

    if (confidence_before === 'UNVERIFIED') {
      confidence_after = 'INFERRED';
    } else if (confidence_before === 'INFERRED') {
      confidence_after = 'CONFIRMED';
    } else {
      return { id, confidence_before, confidence_after: confidence_before };
    }

    const now = new Date().toISOString();
    const promotionNote = reason
      ? `\n[Promoted: ${reason} -- ${entry.author || 'unknown'}]`
      : `\n[Promoted -- ${entry.author || 'unknown'}]`;
    const newContent = entry.content + promotionNote;

    db.prepare('UPDATE entries SET confidence = ?, promoted_at = ?, content = ? WHERE id = ?')
      .run(confidence_after, now, newContent, id);

    return { id, confidence_before, confidence_after };
  }

  async sync(opts?: SyncOptions): Promise<SyncResult> {
    return { synced: false, reason: 'local-only provider' };
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}
