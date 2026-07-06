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
  orJoinFtsTerms,
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

    // T2.2 (F3 PART A, revised D3): additive column storing a JSON map of
    // source_file -> content hash captured AT CAPTURE TIME, for ALL entry
    // types (not just context-cache). No migration -- existing rows default
    // to '{}' (no basis) and are treated fresh/unknown, never falsely stale
    // (D1/D3 no-mass-migration). This is the freshness basis checkFreshness
    // compares against at prime() time.
    try {
      this.db.exec("ALTER TABLE entries ADD COLUMN source_file_hashes TEXT NOT NULL DEFAULT '{}'");
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
    now: string,
    sourceFileHashes: Record<string, string> = {}
  ): void {
    db.prepare(`
      INSERT INTO entries (
        id, type, title, summary, content,
        source_files, symbols, module, tags,
        content_hash, content_hash_type, stale,
        flagged_for_review, contradiction_of,
        author, source, confidence, scope, created_at,
        source_file_hashes,
        superseded_at, promoted_at, use_count
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?,
        ?, ?, ?, ?, ?,
        ?,
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
      now,
      JSON.stringify(sourceFileHashes)
    );
  }

  // T2.2 (F3 PART A): resolve a per-file hash basis for the given source_files
  // at capture time, for ALL types. Files that do not resolve are simply
  // absent from the returned map (not an error). Bounded to the caller's own
  // source_files list. Non-fatal: any hashing error yields an empty basis
  // rather than failing the capture.
  private async computeSourceFileHashes(files: string[]): Promise<Record<string, string>> {
    if (files.length === 0) return {};
    try {
      const hashes = await computeFileHashBatch(files);
      const map: Record<string, string> = {};
      for (const file of Object.keys(hashes)) {
        const result = hashes[file];
        if (result) map[file] = result.hash;
      }
      return map;
    } catch {
      return {};
    }
  }

  // T2.2 (F3 PART B, revised D3): freshness check bounded to the primed set.
  // Keyed off source_files with a per-file hash basis persisted at capture
  // time (source_file_hashes) -- NOT content_hash, which is only ever set for
  // context-cache entries that prime() already excludes from top_entries.
  // Entries with no source_files, or an empty/unparseable stored basis, are
  // left untouched (never falsely stale -- D1/D3 no-mass-migration covers
  // historical rows with no basis). For entries that DO have a basis, re-hash
  // the union of basis files ONCE (bounded to the primed set, never the whole
  // KB) and compare; any changed or now-missing basis file marks the entry
  // stale=1 (one UPDATE) and drops it from the returned list.
  private async checkFreshness(db: Database.Database, entries: KBEntry[]): Promise<KBEntry[]> {
    const candidateIds = entries.filter(e => e.source_files.length > 0).map(e => e.id);
    if (candidateIds.length === 0) return entries;

    const rows = db.prepare(
      `SELECT id, source_file_hashes FROM entries WHERE id IN (${candidateIds.map(() => '?').join(',')})`
    ).all(...candidateIds) as { id: string; source_file_hashes: string | null }[];

    const basisById = new Map<string, Record<string, string>>();
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.source_file_hashes || '{}') as Record<string, string>;
        if (parsed && Object.keys(parsed).length > 0) basisById.set(row.id, parsed);
      } catch {
        // malformed basis -- treat as no basis (never falsely stale)
      }
    }

    if (basisById.size === 0) return entries;

    const fileSet = new Set<string>();
    for (const basis of basisById.values()) {
      for (const file of Object.keys(basis)) fileSet.add(file);
    }

    const currentHashes = await computeFileHashBatch([...fileSet]);

    const staleIds: string[] = [];
    for (const [id, basis] of basisById) {
      let changed = false;
      for (const file of Object.keys(basis)) {
        const current = currentHashes[file];
        if (!current || current.hash !== basis[file]) {
          changed = true;
          break;
        }
      }
      if (changed) staleIds.push(id);
    }

    if (staleIds.length > 0) {
      db.prepare(
        `UPDATE entries SET stale = 1 WHERE id IN (${staleIds.map(() => '?').join(',')})`
      ).run(...staleIds);
    }

    const staleSet = new Set(staleIds);
    return entries.filter(e => !staleSet.has(e.id));
  }

  private findAudnCandidates(db: Database.Database, input: KBEntryInput): KBEntry[] {
    const ftsQuery = makeFtsQuery(input.title);
    if (!ftsQuery) return [];
    try {
      // D2 HALF B (candidate-discovery fix): candidates are discovered by symbol/
      // title overlap across ALL entry types -- the same-type restriction was
      // removed so cross-type contradictions (e.g. a 'knowledge' entry
      // contradicting a 'learning' entry on shared symbols) are discoverable.
      // makeAudnDecision re-imposes candidate.type === input.type for the
      // dedup/update decisions; only the contradiction path stays cross-type.
      const rows = db.prepare(`
        SELECT e.* FROM entries e
        JOIN entries_fts ON entries_fts.rowid = e.rowid
        WHERE entries_fts MATCH ?
          AND e.superseded_at IS NULL
        ORDER BY rank
        LIMIT 10
      `).all(ftsQuery) as Record<string, unknown>[];
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
    now: string,
    sourceFileHashes: Record<string, string>
  ): { id: string; audn_decision: AudnDecision } | null {
    const decision = makeAudnDecision(input, candidates, newContent);
    if (!decision) return null;

    if (decision.decision === 'none') {
      return { id: decision.matchedId, audn_decision: 'none' };
    }

    if (decision.decision === 'flagged') {
      db.prepare('UPDATE entries SET flagged_for_review = 1 WHERE id = ?').run(decision.matchedId);
      const newId = randomUUID();
      this.insertEntry(db, newId, { ...input, ...decision.newEntryOverrides }, newContent, now, sourceFileHashes);
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
      this.insertEntry(db, newId, input, newContent, now, sourceFileHashes);
      this.wireLinks(db, newId, input);
      return { id: newId, audn_decision: 'update' };
    }

    return null;
  }

  private decayConceptEntries(db: Database.Database, days: number): void {
    const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString();
    // D6 (T3.1): a user-directive is NEVER auto-decayed. This `type !=
    // 'user-directive'` clause is defensive (belt-and-braces): decay already
    // only touches confidence='INFERRED' rows, and a user-directive is always
    // stored at confidence='CONFIRMED', so it can never match the WHERE today.
    // The explicit type guard keeps the invariant true even if the confidence
    // predicate is ever loosened.
    db.prepare(`
      UPDATE entries
      SET confidence = 'UNVERIFIED'
      WHERE confidence = 'INFERRED'
        AND type != 'user-directive'
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

    // T2.2 (F3 PART A): capture() is the single choke point every caller
    // (kb_capture, kb_harvest, future paths) goes through, so every entry
    // gets a hash basis here regardless of type.
    const sourceFileHashes = await this.computeSourceFileHashes(input.source_files ?? []);

    const candidates = this.findAudnCandidates(db, input);
    if (candidates.length > 0) {
      const result = this.evaluateAudn(db, input, candidates, content, now, sourceFileHashes);
      if (result) return result;
    }

    const id = randomUUID();
    this.insertEntry(db, id, input, content, now, sourceFileHashes);
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
        // D4 (T2.1): OR-join across hint terms via the shared helper -- each
        // term is still ftsSafeTerm-quoted (tokens WITHIN one term stay
        // AND-joined), but terms are OR-joined so an entry matching ANY hint
        // symbol/module surfaces instead of requiring ALL of them.
        const l1 = await this.query({
          query: orJoinFtsTerms(searchTerms),
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

    // T2.2 (F3 PART B): bounded, non-fatal freshness check keyed off
    // source_files -- see checkFreshness. Any error (hash batch throws, DB
    // error) degrades to leaving top_entries exactly as built above.
    try {
      top_entries = await this.checkFreshness(this.getDb(), top_entries);
    } catch {
      // graceful degradation: prime() returns today's output on any error
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
    // String concatenation (not a template literal) per the ASCII pre-commit
    // hook gotcha: backtick-n escapes inside JS template literals false-
    // positive on the hook's non-ASCII scan.
    const promotionNote = reason
      ? '\n[Promoted: ' + reason + ' -- ' + (entry.author || 'unknown') + ']'
      : '\n[Promoted -- ' + (entry.author || 'unknown') + ']';
    const newContent = entry.content + promotionNote;

    // D5 (T2.3): kb_promote is a tool-layer provenance event -- stamp
    // source='promotion' on the promoted row. This is a deliberate D5
    // choice: the row's provenance reflects the promotion mechanism rather
    // than preserving the original capture source.
    db.prepare('UPDATE entries SET confidence = ?, promoted_at = ?, content = ?, source = ? WHERE id = ?')
      .run(confidence_after, now, newContent, 'promotion', id);

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
