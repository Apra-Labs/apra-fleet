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
  CaptureOpts,
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
  ProviderStats,
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

  // T1.3 (F2/D2 HARDENED): the ANCHORED feedback-downvote marker. feedback()
  // writes exactly '\n\n[feedback ' + new Date().toISOString() + '] ...'
  // (see feedback()). The predicate below excludes any entry carrying this
  // marker from revival, so a feedback-downvoted entry stays retired even if
  // some later flow clears its flagged_for_review bit (the T3.1 winner path
  // clears flags; the marker is the durable downvote record). We anchor to the
  // two-newline prefix PLUS the ISO date shape ('[feedback ' + YYYY-MM-DDT)
  // rather than a bare '[feedback ' substring: an entry whose content merely
  // QUOTES the feedback-note format (e.g. a learning ABOUT the kb_feedback
  // mechanism -- such entries exist in this very KB) must NOT be permanently
  // excluded from revival once freshness-staled. Chosen pattern stated here and
  // used verbatim by the shared predicate.
  private static readonly FEEDBACK_MARKER_RE = /\n\n\[feedback \d{4}-\d{2}-\d{2}T/;

  // T1.3 (F2/D2 HARDENED) -- THE UN-STALE PREDICATE (binding, verbatim):
  //
  //     stale = 1
  //     AND superseded_at IS NULL
  //     AND flagged_for_review = 0
  //     AND content_hash != 'invalidated'
  //     AND content NOT LIKE the ANCHORED feedback marker (FEEDBACK_MARKER_RE:
  //         /\n\n\[feedback \d{4}-\d{2}-\d{2}T/ -- the newline+ISO-timestamp
  //         form feedback() actually writes, NOT a bare substring)
  //     AND the re-hash of the FULL stored basis matches current files
  //
  // That is precisely the freshness-staled population. stale=1 is set by FOUR
  // actors -- freshness mismatch (prime/sweep), supersede (AUDN update, carries
  // superseded_at), feedback downvote (carries flagged_for_review=1 AND the
  // marker), and invalidate() (sets content_hash='invalidated', leaves
  // flagged=0, superseded NULL, basis untouched) -- and ONLY the first may
  // revive. This method evaluates the four NON-hash reason conjuncts; the
  // caller owns the stale=1 gate and the full-basis re-hash (it batches the
  // hashing). Shared by checkFreshness(), freshnessSweep(), and (T3.1)
  // resolveContradiction() -- ONE implementation, never copied.
  private freshnessRevivable(e: {
    superseded_at?: string | null;
    flagged_for_review: boolean;
    content_hash: string;
    content: string;
  }): boolean {
    if (e.superseded_at) return false;                 // supersede actor
    if (e.flagged_for_review) return false;            // feedback flag standing
    if (e.content_hash === 'invalidated') return false; // invalidate actor
    if (SqliteProvider.FEEDBACK_MARKER_RE.test(e.content ?? '')) return false; // durable downvote
    return true;
  }

  // T1.3 (F2/D2): the FULL-basis re-hash conjunct. Returns true only when the
  // stored basis is non-empty AND every basis file resolves to a current hash
  // equal to the stored one. An empty basis never matches (never revive on an
  // empty/malformed basis); a partial match (some file changed/missing) is NOT
  // a full match, so a multi-file entry with only one file matching is not
  // revived. Complement (not a full match) is exactly "basis mismatch" used for
  // the stale=1 direction.
  private basisFullyMatches(
    basis: Record<string, string>,
    currentHashes: Record<string, { hash: string } | null | undefined>
  ): boolean {
    const files = Object.keys(basis);
    if (files.length === 0) return false;
    for (const file of files) {
      const current = currentHashes[file];
      if (!current || current.hash !== basis[file]) return false;
    }
    return true;
  }

  // Parse a stored source_file_hashes JSON map; returns null for empty or
  // malformed bases (never falsely stale, never falsely revive).
  private parseBasis(raw: string | null): Record<string, string> | null {
    try {
      const parsed = JSON.parse(raw || '{}') as Record<string, string>;
      if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) return parsed;
      return null;
    } catch {
      return null;
    }
  }

  // T1.3 (F2/D2 HARDENED): freshness check bounded to the primed set, now
  // BIDIRECTIONAL. Keyed off source_files with a per-file hash basis persisted
  // at capture time (source_file_hashes) -- NOT content_hash, which is only ever
  // set for context-cache entries that prime() already excludes from
  // top_entries. Entries with no source_files, or an empty/unparseable stored
  // basis, are left untouched (never falsely stale). For entries that DO have a
  // basis, re-hash the union of basis files ONCE (bounded to the primed set,
  // never the whole KB): a basis MISMATCH marks stale=1 and drops the entry from
  // the returned list; a FULL basis match on an entry that is stale AND passes
  // the shared un-stale predicate clears stale=0.
  //
  // CAVEAT (also on freshnessSweep): prime()'s candidate set EXCLUDES stale
  // entries by definition (query filters stale=0), so in practice the un-stale
  // direction here is a no-op -- prime alone CANNOT revive a staled entry.
  // Branch-switch revival requires freshnessSweep() (invoked by kb_import in
  // T2.1 and /pm kb-reconcile in T3.2), NOT just a prime. kb_stats stays
  // read-only (D2). The un-stale branch is implemented here for consistency and
  // to share the exact predicate, but the real revival surface is the sweep.
  private async checkFreshness(db: Database.Database, entries: KBEntry[]): Promise<KBEntry[]> {
    const candidates = entries.filter(e => e.source_files.length > 0);
    if (candidates.length === 0) return entries;

    const candidateIds = candidates.map(e => e.id);
    const rows = db.prepare(
      `SELECT id, source_file_hashes FROM entries WHERE id IN (${candidateIds.map(() => '?').join(',')})`
    ).all(...candidateIds) as { id: string; source_file_hashes: string | null }[];

    const basisById = new Map<string, Record<string, string>>();
    for (const row of rows) {
      const basis = this.parseBasis(row.source_file_hashes);
      if (basis) basisById.set(row.id, basis);
    }
    if (basisById.size === 0) return entries;

    const entryById = new Map(entries.map(e => [e.id, e]));

    const fileSet = new Set<string>();
    for (const basis of basisById.values()) {
      for (const file of Object.keys(basis)) fileSet.add(file);
    }

    const currentHashes = await computeFileHashBatch([...fileSet]);

    const staleIds: string[] = [];
    const unstaleIds: string[] = [];
    for (const [id, basis] of basisById) {
      const entry = entryById.get(id);
      const matches = this.basisFullyMatches(basis, currentHashes);
      if (!matches) {
        staleIds.push(id);
      } else if (entry && entry.stale && this.freshnessRevivable(entry)) {
        unstaleIds.push(id);
      }
    }

    if (staleIds.length > 0) {
      db.prepare(
        `UPDATE entries SET stale = 1 WHERE id IN (${staleIds.map(() => '?').join(',')})`
      ).run(...staleIds);
    }
    if (unstaleIds.length > 0) {
      db.prepare(
        `UPDATE entries SET stale = 0 WHERE id IN (${unstaleIds.map(() => '?').join(',')})`
      ).run(...unstaleIds);
    }

    const staleSet = new Set(staleIds);
    return entries.filter(e => !staleSet.has(e.id));
  }

  // T1.3 (F2/D2 HARDENED) resolution R2: a bounded, full-KB bidirectional
  // freshness sweep -- the revival surface that prime() cannot be (its candidate
  // set excludes stale entries). Runs the SAME shared predicate in BOTH
  // directions over ALL entries with a non-empty basis: a basis mismatch marks a
  // currently-fresh entry stale=1; a full basis match revives a stale entry that
  // passes freshnessRevivable() (superseded, feedback-downvoted, and invalidated
  // entries stay retired). Bounded: ONE computeFileHashBatch over the union of
  // all basis files (the KB is <1000 entries -- fine for an explicit command;
  // NOT wired into prime). Exposed as MCP tool kb_freshness_sweep and invoked by
  // kb_import (T2.1) and /pm kb-reconcile (T3.2).
  //
  // Return semantics: `checked` counts entries with a non-empty, parseable basis
  // that were evaluated against the hash batch (entries with no/empty/malformed
  // basis are neither staled nor revived nor counted). `staled` counts fresh
  // entries newly marked stale on a mismatch; `unstaled` counts stale entries
  // revived on a full match.
  //
  // T3.1 (D4 fold-in, Phase 2 review MEDIUM yashr-d8b): optional `root` anchors
  // basis re-hashing at an explicit repo path (e.g. kb_import's --repo) WITHOUT
  // a global process.chdir. Previously kb-import.ts's sweepAnchored() wrapped
  // this call in process.chdir(repoAnchor)/process.chdir(prevCwd) across the
  // await -- a global, process-wide mutation for the duration of the hashing
  // that any other concurrent async work in the same process would also
  // observe. Threading the anchor straight into computeFileHashBatch's { cwd }
  // option removes that global side effect entirely; behavior is identical
  // (relative basis paths still resolve against the intended repo root,
  // absolute basis paths are unaffected either way). Omitting root preserves
  // exact prior behavior (implicit process.cwd() resolution).
  async freshnessSweep(root?: string): Promise<{ checked: number; staled: number; unstaled: number }> {
    const db = this.getDb();
    const rows = db.prepare(
      `SELECT id, stale, superseded_at, flagged_for_review, content_hash, content, source_file_hashes
       FROM entries`
    ).all() as {
      id: string;
      stale: number;
      superseded_at: string | null;
      flagged_for_review: number;
      content_hash: string;
      content: string;
      source_file_hashes: string | null;
    }[];

    const basisById = new Map<string, Record<string, string>>();
    const rowById = new Map<string, typeof rows[number]>();
    for (const row of rows) {
      const basis = this.parseBasis(row.source_file_hashes);
      if (basis) {
        basisById.set(row.id, basis);
        rowById.set(row.id, row);
      }
    }
    if (basisById.size === 0) return { checked: 0, staled: 0, unstaled: 0 };

    const fileSet = new Set<string>();
    for (const basis of basisById.values()) {
      for (const file of Object.keys(basis)) fileSet.add(file);
    }
    const currentHashes = await computeFileHashBatch([...fileSet], root ? { cwd: root } : undefined);

    const staleIds: string[] = [];
    const unstaleIds: string[] = [];
    let checked = 0;
    for (const [id, basis] of basisById) {
      checked++;
      const row = rowById.get(id)!;
      const matches = this.basisFullyMatches(basis, currentHashes);
      const isStale = row.stale === 1;
      if (!matches) {
        if (!isStale) staleIds.push(id); // freshness mismatch actor
      } else if (isStale && this.freshnessRevivable({
        superseded_at: row.superseded_at,
        flagged_for_review: row.flagged_for_review === 1,
        content_hash: row.content_hash,
        content: row.content,
      })) {
        unstaleIds.push(id);
      }
    }

    if (staleIds.length > 0) {
      db.prepare(
        `UPDATE entries SET stale = 1 WHERE id IN (${staleIds.map(() => '?').join(',')})`
      ).run(...staleIds);
    }
    if (unstaleIds.length > 0) {
      db.prepare(
        `UPDATE entries SET stale = 0 WHERE id IN (${unstaleIds.map(() => '?').join(',')})`
      ).run(...unstaleIds);
    }

    return { checked, staled: staleIds.length, unstaled: unstaleIds.length };
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
    // F1 (D1): only an ACTIVE directive (type='user-directive' AND
    // confidence='CONFIRMED') is exempt from decay. A pending/rejected directive
    // proposal is UNVERIFIED, so it is already below the INFERRED decay target
    // and decay is not observable on it (L2). The rekeyed guard
    // `NOT (type='user-directive' AND confidence='CONFIRMED')` keeps the
    // invariant precise: a hypothetical INFERRED user-directive row would decay
    // like any concept, while an ACTIVE directive never does.
    db.prepare(`
      UPDATE entries
      SET confidence = 'UNVERIFIED'
      WHERE confidence = 'INFERRED'
        AND NOT (type = 'user-directive' AND confidence = 'CONFIRMED')
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

  async capture(input: KBEntryInput, opts?: CaptureOpts): Promise<{ id: string; audn_decision: AudnDecision }> {
    const db = this.getDb();
    const now = new Date().toISOString();

    // F1 (D1, closes yashr-9ha): capture() is the single choke point every
    // MCP-reachable route flows through (the kb_capture handler AND the HTTP
    // /api/kb/capture route on the KB server). Enforcing the directive
    // proposal-transformation HERE -- not only in the kb_capture handler --
    // means no capture route can mint an active directive. A user-directive
    // captured over MCP is forced to a PENDING PROPOSAL: confidence downgraded
    // to UNVERIFIED, flagged_for_review set, a 'directive:pending' tag added,
    // and scope forced to 'project' (M1: a global proposal would be unreachable
    // by the project CLI that approves it). Activation is CLI-only via the
    // dedicated approveDirective/addDirective methods, which bypass capture().
    if (input.type === 'user-directive') {
      const existingTags = input.tags ?? [];
      const tags = existingTags.includes('directive:pending')
        ? existingTags
        : [...existingTags, 'directive:pending'];
      input = {
        ...input,
        confidence: 'UNVERIFIED',
        flagged_for_review: true,
        scope: 'project',
        tags,
      };
    }

    // T1.2 (F3, R3, KB 9462ab04): general confidence clamp -- the ENFORCEMENT
    // copy. The kb_capture tool handler (kb-capture.ts) also clamps and returns
    // a confidence_clamped UX flag to MCP callers, but the HTTP /api/kb/capture
    // route calls provider.capture(JSON.parse(body)) directly
    // (kb-server.ts:133-141), bypassing that handler and previously able to mint
    // CONFIRMED for non-directive types. This block is the single enforcement
    // choke point every route flows through: for NON-directive types an incoming
    // CONFIRMED is downgraded to INFERRED with a bracketed content note that
    // mirrors the handler's wording. CONFIRMED is minted ONLY by promote() and
    // approveDirective/addDirective, all of which bypass capture() -- they are
    // not exemptions here, they simply never reach this code.
    //
    // Ordering: the directive gate above has already forced user-directive
    // entries to UNVERIFIED proposals, so this clamp never fires for them; the
    // explicit type check keeps that intent legible. Keep this block AFTER the
    // directive gate.
    //
    // T2.1 (F4, D3, MEDIUM-4) PROVENANCE NORMALIZATION -- runs BEFORE the clamp,
    // AFTER the directive gate. insertEntry() persists input.source verbatim, so
    // the two PRIVILEGED provenance values -- 'import' (the kb_import trusted
    // channel) and 'promotion' (stamped only by promote(), which never calls
    // capture()) -- must never be settable by a deserialized route body. When the
    // internal import mode is NOT engaged, a caller-supplied source of 'import'
    // or 'promotion' is OVERWRITTEN with 'unknown' (we mark provenance we cannot
    // vouch for, rather than lying with 'session'). Under import mode the tool's
    // own source='import' is legitimate and survives. Without this, an HTTP
    // caller could stamp forged trusted-channel provenance (clamped, but
    // mislabeled -- audits keyed on source='import' would trust forged rows).
    if (!opts?.importMode && (input.source === 'import' || input.source === 'promotion')) {
      input = { ...input, source: 'unknown' };
    }

    // T2.1 (F4, D3): import is the SOLE capture()-level exemption to this clamp.
    // The internal import-mode flag is a SECOND parameter of capture() (opts),
    // NEVER a field of the deserialized input (the HTTP route passes exactly one
    // argument and the MCP handler builds input from zod fields, so a second
    // parameter is structurally unreachable from any deserialized route -- R4).
    // When import mode is engaged, a NON-directive entry keeps its bible
    // confidence: the bible is a git-reviewed, human-merged artifact (the trusted
    // channel) and re-clamping would demote the whole team's CONFIRMED knowledge
    // on every import. The directive gate above still ran first, so a bible
    // cannot smuggle an active directive even under import mode.
    // String concatenation (not a template literal) per the ASCII pre-commit
    // hook's backtick-escape false-positive.
    if (!opts?.importMode && input.type !== 'user-directive' && input.confidence === 'CONFIRMED') {
      input = {
        ...input,
        confidence: 'INFERRED',
        content: input.content + '\n\n[confidence clamped: CONFIRMED requires kb_promote]',
      };
    }

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

    // T2.1 (F4, D3, LOW-2): on the pure 'add' path, kb_import preserves the
    // bible entry's id (opts.preferredId) so a re-import dedupes EXACTLY via the
    // id-skip gate (kb_import checks hasEntry() before ever calling capture, so
    // the id is guaranteed free here). AUDN's update/flagged branches above
    // always mint a fresh randomUUID -- an id collision with different content is
    // resolved by AUDN under a new id, never by overwriting the preserved id.
    const id = opts?.preferredId ?? randomUUID();
    this.insertEntry(db, id, input, content, now, sourceFileHashes);
    this.wireLinks(db, id, input);
    return { id, audn_decision: 'add' };
  }

  // T2.1 (F4, D3, LOW-2): existence check for kb_import's per-entry id-skip --
  // the FIRST gate, run BEFORE capture()/AUDN. Idempotency cannot rely on AUDN
  // alone: AUDN dedupe needs symbol AND file overlap (symbolsOverlap/filesOverlap
  // return false on empty arrays), so a symbol-less or file-less bible entry
  // would re-add on every import if AUDN were the only guard. Checks ALL rows
  // (superseded/stale included) so a previously-absorbed entry never re-adds, and
  // -- unlike query({ids}) -- bumps no use_count/last_accessed telemetry.
  hasEntry(id: string): boolean {
    const row = this.getDb().prepare('SELECT 1 FROM entries WHERE id = ?').get(id);
    return row !== undefined;
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
    if (opts.tag) {
      // T-tag-filter: exact-match WHERE clause via json_each, same pattern as
      // list()'s symbol filter above. This is NOT an FTS term -- it is ANDed
      // into `conditions`, which both the FTS-query branch (ftsWhere) and the
      // plain-listing branch (where) already consume below, so it composes
      // with `query` and other filters without touching the FTS/OR-join logic.
      conditions.push('EXISTS (SELECT 1 FROM json_each(e.tags) WHERE value = ?)');
      params.push(opts.tag);
    }
    if (opts.flagged_only) {
      conditions.push('(e.flagged_for_review = 1 OR e.contradiction_of IS NOT NULL)');
    } else {
      // H2 (F1, D1, closes yashr-9ha): default retrieval NEVER surfaces a
      // pending or rejected directive PROPOSAL (type='user-directive' with
      // confidence != 'CONFIRMED'). Only an ACTIVE (CONFIRMED) directive
      // surfaces. This is the surgical exclusion the pending representation
      // alone does not provide (flagged UNVERIFIED rows otherwise match FTS).
      // The flagged_only audit path is exempt (above) -- that is where a human
      // finds pending proposals; kb_list uses a separate method and is likewise
      // unaffected. prime() delegates here, so it inherits the exclusion.
      conditions.push("NOT (e.type = 'user-directive' AND e.confidence != 'CONFIRMED')");
    }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const limit = opts.limit ?? 20;

    let rows: Record<string, unknown>[];

    if (opts.query || opts.fts_terms?.length) {
      // ONE sanitization point. Free text is tokenized then OR-joined; internal
      // callers pass discrete terms via fts_terms. Raw MATCH threw on '.', '-',
      // '(', ')', '/' and implicit-AND'd multi-term queries to zero rows.
      const ftsQuery = opts.fts_terms?.length
        ? orJoinFtsTerms(opts.fts_terms)
        : orJoinFtsTerms(opts.query!.match(/[A-Za-z0-9_]+/g) ?? []);
      if (!ftsQuery) return { results: [], total: 0, l1_only: !!opts.l1_only };
      const ftsWhere = conditions.length > 0 ? 'AND ' + conditions.join(' AND ') : '';
      rows = db.prepare(`
        SELECT e.* FROM entries e
        JOIN entries_fts ON entries_fts.rowid = e.rowid
        WHERE entries_fts MATCH ?
        ${ftsWhere}
        ORDER BY rank
        LIMIT ?
      `).all(ftsQuery, ...params, limit) as Record<string, unknown>[];
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
          fts_terms: searchTerms,
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

  // T3.3 (F8a, D8): dedicated read-only listing for kb_list. CHOICE (stated
  // per PLAN.md): a separate provider method rather than a query() option --
  // query() bumps use_count/last_accessed unconditionally (its "retrieval
  // means relevance" telemetry contract, exercised by retrieval paths like
  // kb_query/prime), and kb_list's purpose is pure audit/inspection ("is the
  // CONFIRMED set what we think it is") which should not perturb that
  // telemetry. A dedicated method keeps the two contracts textually distinct
  // instead of an easy-to-miss opt-out flag threaded through query(). Always
  // excludes superseded and stale entries (no override -- this is an
  // audit-the-live-set tool, not a full-history query).
  async list(opts: {
    confidence?: Confidence;
    type?: KBEntry['type'];
    module?: string;
    symbol?: string;
    tag?: string;
    limit?: number;
  }): Promise<KBEntry[]> {
    const db = this.getDb();
    const conditions: string[] = ['e.superseded_at IS NULL', 'e.stale = 0'];
    const params: unknown[] = [];

    if (opts.confidence) {
      conditions.push('e.confidence = ?');
      params.push(opts.confidence);
    }
    if (opts.type) {
      conditions.push('e.type = ?');
      params.push(opts.type);
    }
    if (opts.module) {
      conditions.push('e.module = ?');
      params.push(opts.module);
    }
    if (opts.symbol) {
      conditions.push('EXISTS (SELECT 1 FROM json_each(e.symbols) WHERE value = ?)');
      params.push(opts.symbol);
    }
    if (opts.tag) {
      conditions.push('EXISTS (SELECT 1 FROM json_each(e.tags) WHERE value = ?)');
      params.push(opts.tag);
    }

    const where = 'WHERE ' + conditions.join(' AND ');
    const limitClause = opts.limit !== undefined ? 'LIMIT ?' : '';
    if (opts.limit !== undefined) params.push(opts.limit);

    const rows = db.prepare(`
      SELECT e.* FROM entries e
      ${where}
      ORDER BY e.id ASC
      ${limitClause}
    `).all(...params) as Record<string, unknown>[];

    return rows.map(r => this.rowToEntry(r));
  }

  async promote(id: string, reason?: string): Promise<{ id: string; confidence_before: Confidence; confidence_after: Confidence }> {
    const db = this.getDb();
    const row = db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`Entry not found: ${id}`);

    const entry = this.rowToEntry(row);
    if (entry.superseded_at) throw new Error(`Cannot promote superseded entry: ${id}`);

    // H1 (F1, D1, closes yashr-9ha): promote() REFUSES any user-directive entry.
    // The promote ladder (UNVERIFIED -> INFERRED -> CONFIRMED) would otherwise
    // let two agent-callable kb_promote calls walk a pending directive proposal
    // up to type='user-directive' + confidence='CONFIRMED' -- exactly the ACTIVE
    // predicate -- re-opening the forge-a-directive attack through the side door.
    // Directive activation is human-terminal ONLY, via the dedicated
    // approveDirective() method (which does NOT delegate here). Refuse ENTIRELY
    // so the pending/active state stays binary.
    if (entry.type === 'user-directive') {
      throw new Error(
        'Cannot promote a user-directive via kb_promote (F1/D1): directive activation is human-terminal only. Run `apra-fleet kb approve-directive ' + id + '` (or `reject-directive ' + id + '` to discard).'
      );
    }

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

  // T3.1 (F8, D7): kb_feedback downvote path -- marks an entry stale=1 +
  // flagged_for_review=1 and appends an ASCII feedback note. NEVER deletes,
  // NEVER touches confidence: a downvoted CONFIRMED entry stays
  // CONFIRMED-but-stale-flagged; the human resolves it in kb-review.
  // EXCEPTION (D7, verbatim): an ACTIVE user-directive (type='user-directive'
  // AND confidence='CONFIRMED') outranks agent experience -- feedback flags it
  // for review but must NOT stale it (the human decides in kb-review). This is
  // keyed off ACTIVE directives only (type + CONFIRMED, same rekey as the T1.1
  // supersede/decay guards) -- a pending directive proposal (confidence !=
  // 'CONFIRMED') is not yet "active" and stales normally like any other entry.
  async feedback(id: string, reason: string, author: string): Promise<KBEntry> {
    const db = this.getDb();
    const row = db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new Error('Entry not found: ' + id);
    const entry = this.rowToEntry(row);

    const now = new Date().toISOString();
    // String concatenation (not a template literal) per the ASCII pre-commit
    // hook gotcha: backtick-n/t/r escapes inside template literals
    // false-positive on the hook's non-ASCII scan (same convention as
    // promote()'s promotionNote above and kb-export.ts).
    const note = '\n\n[feedback ' + now + '] ' + author + ': ' + reason;
    const newContent = truncateContent(entry.content + note);

    const isActiveDirective = entry.type === 'user-directive' && entry.confidence === 'CONFIRMED';

    if (isActiveDirective) {
      db.prepare('UPDATE entries SET flagged_for_review = 1, content = ? WHERE id = ?')
        .run(newContent, id);
    } else {
      db.prepare('UPDATE entries SET stale = 1, flagged_for_review = 1, content = ? WHERE id = ?')
        .run(newContent, id);
    }

    const updated = db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as Record<string, unknown>;
    return this.rowToEntry(updated);
  }

  // T3.1 (F5 step 3, D4 HARDENED): flaggedPairs() -- flagged entries joined to
  // their contradiction_of counterpart. LIVENESS CONTRACT (binding, MEDIUM-3):
  // pair membership requires ONLY superseded_at IS NULL on BOTH sides -- STALE
  // MEMBERS MUST BE INCLUDED. Do NOT reuse the codebase's default "live"
  // filter (superseded_at IS NULL AND stale = 0, as in list()/stats()/
  // query()): the imported side of a pair is TYPICALLY stale after the
  // post-import freshnessSweep, and the default filter would make this method
  // return nothing and the prefilter silently no-op.
  //
  // PAIR ASYMMETRY (verified, KB a2781b82 + feedback.md): AUDN's contradiction
  // branch inserts the NEW entry (the "challenger") with contradiction_of
  // pointing at the OLD entry (the "original") and flagged_for_review lands on
  // the OLD side ONLY (the new entry's flagged_for_review is explicitly false
  // in newEntryOverrides). A genuine pair is therefore identified by
  // challenger.contradiction_of = original.id -- NOT by flagged_for_review
  // alone: a lone entry downvoted via feedback() also carries
  // flagged_for_review = 1 but has no contradiction_of counterpart and must
  // NEVER be returned here.
  //
  // Pairs involving an ACTIVE user-directive (type = 'user-directive' AND
  // confidence = 'CONFIRMED') on EITHER side are excluded entirely -- an
  // active directive can be the target of AUDN's contradiction path (the
  // contradiction check runs before the AUDN active-directive supersede guard,
  // see audn.ts), but directives outrank mechanics: the flag stays for a human
  // via /pm kb-review, never the mechanical prefilter or the reconciler agent.
  async flaggedPairs(): Promise<{ original: KBEntry; challenger: KBEntry }[]> {
    const db = this.getDb();
    const idRows = db.prepare(`
      SELECT o.id as original_id, c.id as challenger_id
      FROM entries c
      JOIN entries o ON o.id = c.contradiction_of
      WHERE c.contradiction_of IS NOT NULL
        AND o.superseded_at IS NULL
        AND c.superseded_at IS NULL
        AND NOT (o.type = 'user-directive' AND o.confidence = 'CONFIRMED')
        AND NOT (c.type = 'user-directive' AND c.confidence = 'CONFIRMED')
    `).all() as { original_id: string; challenger_id: string }[];

    const pairs: { original: KBEntry; challenger: KBEntry }[] = [];
    for (const row of idRows) {
      const originalRow = db.prepare('SELECT * FROM entries WHERE id = ?').get(row.original_id) as Record<string, unknown> | undefined;
      const challengerRow = db.prepare('SELECT * FROM entries WHERE id = ?').get(row.challenger_id) as Record<string, unknown> | undefined;
      if (!originalRow || !challengerRow) continue; // defensive; join guarantees both exist
      pairs.push({ original: this.rowToEntry(originalRow), challenger: this.rowToEntry(challengerRow) });
    }
    return pairs;
  }

  // T3.1 (F5 step 3, D4 HARDENED HIGH-1/R7): the SINGLE write path for ALL
  // reconcile resolutions -- both kb_reconcile_prefilter's mechanical wins and
  // the T3.2 reconciler agent's code-decided wins. Deliberately NOT composed
  // from promote() + feedback(): promote()'s one-step ladder cannot lift
  // AUDN's UNVERIFIED contradiction-born entries directly to CONFIRMED, and
  // neither promote() nor feedback() clears flagged_for_review or
  // contradiction_of (KB a2781b82) -- this method is the only place both
  // outcomes are produced together, atomically, for a pair.
  //
  // LINKAGE REFUSAL (re-review MEDIUM-1, binding): before writing ANYTHING,
  // verify the two ids form a GENUINE contradiction pair --
  // loser.contradiction_of === winner.id OR winner.contradiction_of ===
  // loser.id (the AUDN pair asymmetry means the pointer sits on either side
  // depending on which side happens to win) -- AND both rows exist AND
  // neither is already superseded AND neither side is an ACTIVE
  // user-directive. Refuse (throw) otherwise: NOTHING is written. Without this
  // check any caller could mint CONFIRMED from any tier in ONE call and
  // permanently retire an arbitrary unrelated entry.
  //
  // WINNER path -- explicit order (re-review MEDIUM-2, THE ORDER MATTERS):
  //   (1) confidence = 'CONFIRMED' regardless of starting tier (the merged
  //       code IS the verdict; reconcile is verdict-equivalent), with the
  //       evidence note appended to content.
  //   (2) clear the winner's flag fields FIRST: flagged_for_review = 0 AND
  //       contradiction_of = NULL, unconditionally on the winner row -- the
  //       pair asymmetry means exactly one of the two was actually set, so
  //       clearing both is harmless on whichever side the winner is.
  //   (3) THEN, and only then, evaluate the shared D2 freshnessRevivable
  //       predicate (+ the full-basis re-hash conjunct) against the
  //       POST-flag-clear row, and clear stale ONLY if it holds. Evaluating
  //       the predicate BEFORE step (2) would self-defeat for a flagged
  //       OLD-side winner (the predicate requires flagged_for_review = 0) --
  //       it would end CONFIRMED but stale = 1 and silently vanish from the
  //       kb_export bible. The durable exclusions (the anchored "[feedback "
  //       marker, content_hash = 'invalidated') are UNAFFECTED by the
  //       flag-clear, so a downvoted or invalidated winner still stays
  //       retired: it wins the CONTRADICTION, not its reputation.
  //
  // LOSER: superseded_at = now + stale = 1 + flagged_for_review cleared
  // (retired with an audit trail -- the existing loser invariant). NEVER
  // deletes anything, on either side.
  async resolveContradiction(
    winnerId: string,
    loserId: string,
    evidence: string
  ): Promise<{ winnerId: string; loserId: string }> {
    const db = this.getDb();
    const winnerRow = db.prepare('SELECT * FROM entries WHERE id = ?').get(winnerId) as Record<string, unknown> | undefined;
    const loserRow = db.prepare('SELECT * FROM entries WHERE id = ?').get(loserId) as Record<string, unknown> | undefined;

    if (!winnerRow || !loserRow) {
      throw new Error('resolveContradiction: refused -- one or both entries do not exist (winner=' + winnerId + ', loser=' + loserId + ')');
    }
    const winner = this.rowToEntry(winnerRow);
    const loser = this.rowToEntry(loserRow);

    if (winner.superseded_at || loser.superseded_at) {
      throw new Error('resolveContradiction: refused -- one or both entries are already superseded (winner=' + winnerId + ', loser=' + loserId + ')');
    }

    const linked = loser.contradiction_of === winner.id || winner.contradiction_of === loser.id;
    if (!linked) {
      throw new Error('resolveContradiction: refused -- ids do not form a genuine contradiction pair (winner=' + winnerId + ', loser=' + loserId + ')');
    }

    const isActiveDirective = (e: KBEntry): boolean => e.type === 'user-directive' && e.confidence === 'CONFIRMED';
    if (isActiveDirective(winner) || isActiveDirective(loser)) {
      throw new Error('resolveContradiction: refused -- pair involves an active user-directive; directives are never auto-resolved (winner=' + winnerId + ', loser=' + loserId + ')');
    }

    const now = new Date().toISOString();
    // String concatenation (not a template literal) per the ASCII pre-commit
    // hook gotcha: backtick-n/t/r escapes inside template literals
    // false-positive on the hook's non-ASCII scan.
    const evidenceNote = '\n\n[reconciled ' + now + '] winner over ' + loserId + ': ' + evidence;
    const newContent = truncateContent(winner.content + evidenceNote);

    // (1) confidence + evidence note, (2) flag-clear FIRST (both fields,
    // unconditionally -- harmless on whichever side actually held a value).
    db.prepare(
      "UPDATE entries SET confidence = 'CONFIRMED', content = ?, flagged_for_review = 0, contradiction_of = NULL WHERE id = ?"
    ).run(newContent, winnerId);

    // (3) THEN evaluate the shared D2 predicate on the POST-flag-clear row.
    const refreshedRow = db.prepare('SELECT * FROM entries WHERE id = ?').get(winnerId) as Record<string, unknown>;
    const refreshedWinner = this.rowToEntry(refreshedRow);
    if (refreshedWinner.stale) {
      const revivable = this.freshnessRevivable({
        superseded_at: refreshedWinner.superseded_at ?? null,
        flagged_for_review: refreshedWinner.flagged_for_review,
        content_hash: refreshedWinner.content_hash,
        content: refreshedWinner.content,
      });
      if (revivable) {
        const basis = this.parseBasis((refreshedRow as { source_file_hashes?: string | null }).source_file_hashes ?? null);
        if (basis) {
          const currentHashes = await computeFileHashBatch(Object.keys(basis));
          if (this.basisFullyMatches(basis, currentHashes)) {
            db.prepare('UPDATE entries SET stale = 0 WHERE id = ?').run(winnerId);
          }
        }
      }
    }

    // LOSER: audit trail, never deletes. contradiction_of is intentionally
    // left as-is on the loser (harmless, and preserves which pair this row
    // was once part of for later inspection); only flagged_for_review is
    // cleared per the stated invariant.
    db.prepare(
      'UPDATE entries SET superseded_at = ?, stale = 1, flagged_for_review = 0 WHERE id = ?'
    ).run(now, loserId);

    return { winnerId, loserId };
  }

  // T3.1 (F5 step 3, D4 HARDENED, resolution R1): kb_reconcile_prefilter's
  // provider backing. For each pair from flaggedPairs(), re-hash BOTH sides'
  // FULL bases against the CURRENT worktree (one computeFileHashBatch over the
  // union of every basis file across every pair -- same batching discipline as
  // freshnessSweep): exactly one side fully matches -> that side WINS
  // mechanically via resolveContradiction with the verbatim evidence string
  // "hash-basis match on merged worktree". Both match, both mismatch, or
  // EITHER side has an empty/missing basis -> left untouched for the T3.2
  // reconciler agent. Directive pairs are already excluded by flaggedPairs()
  // itself (MEDIUM-3 liveness contract); the explicit re-check here is
  // belt-and-suspenders defense in depth and feeds the skipped_directive
  // count honestly rather than assuming the upstream filter can never regress.
  async reconcilePrefilter(): Promise<{
    pairs: number;
    resolved: { winnerId: string; loserId: string }[];
    left_for_agent: { originalId: string; challengerId: string }[];
    skipped_directive: number;
  }> {
    const pairs = await this.flaggedPairs();
    const resolved: { winnerId: string; loserId: string }[] = [];
    const left_for_agent: { originalId: string; challengerId: string }[] = [];
    let skipped_directive = 0;

    if (pairs.length === 0) {
      return { pairs: 0, resolved, left_for_agent, skipped_directive };
    }

    const isActiveDirective = (e: KBEntry): boolean => e.type === 'user-directive' && e.confidence === 'CONFIRMED';

    const liveTouchable = pairs.filter(pair => {
      if (isActiveDirective(pair.original) || isActiveDirective(pair.challenger)) {
        skipped_directive++;
        return false;
      }
      return true;
    });

    const db = this.getDb();
    const allIds = liveTouchable.flatMap(p => [p.original.id, p.challenger.id]);
    const basisById = new Map<string, Record<string, string> | null>();
    if (allIds.length > 0) {
      const basisRows = db.prepare(
        `SELECT id, source_file_hashes FROM entries WHERE id IN (${allIds.map(() => '?').join(',')})`
      ).all(...allIds) as { id: string; source_file_hashes: string | null }[];
      for (const row of basisRows) basisById.set(row.id, this.parseBasis(row.source_file_hashes));
    }

    const fileSet = new Set<string>();
    for (const basis of basisById.values()) {
      if (basis) for (const file of Object.keys(basis)) fileSet.add(file);
    }
    const currentHashes = await computeFileHashBatch([...fileSet]);

    for (const pair of liveTouchable) {
      const originalBasis = basisById.get(pair.original.id) ?? null;
      const challengerBasis = basisById.get(pair.challenger.id) ?? null;
      const originalMatches = originalBasis ? this.basisFullyMatches(originalBasis, currentHashes) : false;
      const challengerMatches = challengerBasis ? this.basisFullyMatches(challengerBasis, currentHashes) : false;

      if (originalMatches && !challengerMatches) {
        await this.resolveContradiction(pair.original.id, pair.challenger.id, 'hash-basis match on merged worktree');
        resolved.push({ winnerId: pair.original.id, loserId: pair.challenger.id });
      } else if (challengerMatches && !originalMatches) {
        await this.resolveContradiction(pair.challenger.id, pair.original.id, 'hash-basis match on merged worktree');
        resolved.push({ winnerId: pair.challenger.id, loserId: pair.original.id });
      } else {
        left_for_agent.push({ originalId: pair.original.id, challengerId: pair.challenger.id });
      }
    }

    return { pairs: pairs.length, resolved, left_for_agent, skipped_directive };
  }

  // --- F1 (D1) directive activation primitives ---
  // These are the human-terminal trust surface for user-directives. They are
  // called ONLY by the `apra-fleet kb ...` CLI commands (src/cli/kb-directives.ts)
  // and are NEVER exposed over MCP: MCP has no user-vs-agent identity, so the
  // only unforgeable channel is a command the human runs in their own terminal.
  // approveDirective is DEDICATED (it does NOT delegate to promote(), which
  // refuses user-directive entries outright per H1).

  // Audit read (no use_count bump): all non-rejected directives -- pending
  // proposals (UNVERIFIED + 'directive:pending') and active directives
  // (CONFIRMED). Rejected directives are superseded and excluded.
  async listDirectives(): Promise<KBEntry[]> {
    const db = this.getDb();
    const rows = db.prepare(`
      SELECT * FROM entries
      WHERE type = 'user-directive' AND superseded_at IS NULL
      ORDER BY created_at DESC
    `).all() as Record<string, unknown>[];
    return rows.map(r => this.rowToEntry(r));
  }

  // Human approval: a pending proposal becomes an ACTIVE directive. Sets
  // confidence='CONFIRMED', author='user' (the human at the terminal is the
  // authority), clears flagged_for_review, drops the 'directive:pending' tag,
  // and stamps promoted_at=now (activation is the promotion-equivalent event,
  // keeping kb_export's updated_at and F5's promote_ratio coherent). From here
  // all directive semantics apply (never decayed, top-tier retrieval, only a
  // human supersede via reject).
  async approveDirective(id: string): Promise<KBEntry> {
    const db = this.getDb();
    const row = db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new Error('Directive not found: ' + id);
    const entry = this.rowToEntry(row);
    if (entry.type !== 'user-directive') throw new Error('Not a user-directive: ' + id);
    if (entry.superseded_at) throw new Error('Cannot approve a rejected directive: ' + id);
    if (entry.confidence === 'CONFIRMED') throw new Error('Directive already active: ' + id);

    const now = new Date().toISOString();
    const tags = entry.tags.filter(t => t !== 'directive:pending');
    db.prepare(
      "UPDATE entries SET confidence = 'CONFIRMED', author = 'user', flagged_for_review = 0, tags = ?, promoted_at = ? WHERE id = ?"
    ).run(JSON.stringify(tags), now, id);

    const updated = db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as Record<string, unknown>;
    return this.rowToEntry(updated);
  }

  // Human rejection: works on a pending proposal OR an active directive (the
  // approve-new + reject-old supersede flow, resolution 2). Marks superseded_at
  // and stale so it drops from retrieval, but NEVER deletes and KEEPS the
  // 'directive:pending' tag as an audit trail.
  async rejectDirective(id: string): Promise<KBEntry> {
    const db = this.getDb();
    const row = db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new Error('Directive not found: ' + id);
    const entry = this.rowToEntry(row);
    if (entry.type !== 'user-directive') throw new Error('Not a user-directive: ' + id);
    if (entry.superseded_at) throw new Error('Directive already rejected: ' + id);

    const now = new Date().toISOString();
    db.prepare('UPDATE entries SET superseded_at = ?, stale = 1 WHERE id = ?').run(now, id);

    const updated = db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as Record<string, unknown>;
    return this.rowToEntry(updated);
  }

  // Direct human add: creates an ALREADY-ACTIVE directive (the human terminal is
  // the trust root, D1). Bypasses capture() -- which would force the proposal
  // representation -- and inserts directly at confidence='CONFIRMED',
  // author='user', source='user-directive', promoted_at=now.
  async addDirective(text: string, symbols?: string[]): Promise<KBEntry> {
    const db = this.getDb();
    const now = new Date().toISOString();
    const id = randomUUID();
    const title = text.length > 80 ? text.slice(0, 77) + '...' : text;
    const summary = text.length > 200 ? text.slice(0, 197) + '...' : text;
    const input: KBEntryInput = {
      type: 'user-directive',
      title,
      summary,
      content: text,
      source_files: [],
      symbols: symbols ?? [],
      module: undefined,
      tags: [],
      content_hash: '',
      content_hash_type: 'sha256',
      flagged_for_review: false,
      contradiction_of: undefined,
      author: 'user',
      source: 'user-directive',
      confidence: 'CONFIRMED',
      scope: 'project',
    };
    this.insertEntry(db, id, input, truncateContent(text), now);
    db.prepare('UPDATE entries SET promoted_at = ? WHERE id = ?').run(now, id);
    this.wireLinks(db, id, input);

    const row = db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as Record<string, unknown>;
    return this.rowToEntry(row);
  }

  async sync(opts?: SyncOptions): Promise<SyncResult> {
    return { synced: false, reason: 'local-only provider' };
  }

  // T2.1 (F5, D4): dedicated no-bump aggregation read, following the kb_list
  // pattern -- every query below is a plain SELECT/COUNT/GROUP BY, never an
  // UPDATE, so use_count/last_accessed telemetry is untouched (inspecting the
  // KB's health is not "retrieval" for that purpose, same rationale as list()).
  //
  // "Live" (used for retrieval.hit_rate's denominator and coverage, per
  // resolution 6 and D4) means superseded_at IS NULL AND stale = 0 --
  // identical to list()'s and query()'s default filter. totals/stale/
  // flagged/superseded below are deliberately UNFILTERED (whole-table counts)
  // so they show full volume; only retrieval.hit_rate and coverage are
  // liveness-scoped.
  async stats(opts?: { symbols?: string[] }): Promise<ProviderStats> {
    const db = this.getDb();

    const byConfidenceRows = db.prepare(
      'SELECT confidence, COUNT(*) as c FROM entries GROUP BY confidence'
    ).all() as { confidence: Confidence; c: number }[];
    const by_confidence: Record<Confidence, number> = { CONFIRMED: 0, INFERRED: 0, UNVERIFIED: 0 };
    let total = 0;
    for (const row of byConfidenceRows) {
      by_confidence[row.confidence] = row.c;
      total += row.c;
    }

    const byTypeRows = db.prepare(
      'SELECT type, COUNT(*) as c FROM entries GROUP BY type'
    ).all() as { type: KBEntry['type']; c: number }[];
    const by_type: Record<KBEntry['type'], number> = {
      'context-cache': 0,
      'learning': 0,
      'knowledge': 0,
      'runbook': 0,
      'user-directive': 0,
    };
    for (const row of byTypeRows) {
      by_type[row.type] = row.c;
    }

    const staleRow = db.prepare('SELECT COUNT(*) as c FROM entries WHERE stale = 1').get() as { c: number };
    const flaggedRow = db.prepare('SELECT COUNT(*) as c FROM entries WHERE flagged_for_review = 1').get() as { c: number };
    const supersededRow = db.prepare('SELECT COUNT(*) as c FROM entries WHERE superseded_at IS NOT NULL').get() as { c: number };

    const liveRow = db.prepare(
      'SELECT COUNT(*) as c FROM entries WHERE superseded_at IS NULL AND stale = 0'
    ).get() as { c: number };
    const totalLive = liveRow.c;

    const retrievedRow = db.prepare(
      'SELECT COUNT(*) as c FROM entries WHERE use_count > 0 AND superseded_at IS NULL AND stale = 0'
    ).get() as { c: number };
    const totalUsesRow = db.prepare('SELECT COALESCE(SUM(use_count), 0) as s FROM entries').get() as { s: number };
    const hit_rate = totalLive > 0 ? retrievedRow.c / totalLive : null;

    const confirmedRow = db.prepare("SELECT COUNT(*) as c FROM entries WHERE confidence = 'CONFIRMED'").get() as { c: number };
    const promotedRow = db.prepare('SELECT COUNT(*) as c FROM entries WHERE promoted_at IS NOT NULL').get() as { c: number };
    const promote_ratio = confirmedRow.c > 0 ? promotedRow.c / confirmedRow.c : null;

    const result: ProviderStats = {
      totals: { by_confidence, by_type, total },
      stale: staleRow.c,
      flagged: flaggedRow.c,
      superseded: supersededRow.c,
      retrieval: { entries_retrieved: retrievedRow.c, total_uses: totalUsesRow.s, hit_rate },
      promote_ratio,
    };

    if (opts?.symbols?.length) {
      const symbolStmt = db.prepare(`
        SELECT COUNT(*) as c FROM entries
        WHERE confidence = 'CONFIRMED' AND superseded_at IS NULL AND stale = 0
          AND EXISTS (SELECT 1 FROM json_each(symbols) WHERE value = ?)
      `);
      const symbols: Record<string, boolean> = {};
      let trueCount = 0;
      for (const symbol of opts.symbols) {
        const row = symbolStmt.get(symbol) as { c: number };
        const covered = row.c > 0;
        symbols[symbol] = covered;
        if (covered) trueCount++;
      }
      result.coverage = {
        fraction: opts.symbols.length > 0 ? trueCount / opts.symbols.length : 0,
        symbols,
      };
    }

    return result;
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}
