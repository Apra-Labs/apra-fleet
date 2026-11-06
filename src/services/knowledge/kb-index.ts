// KB keyword index (design D2a) for SqliteProvider.
//
// Layout:
//   entries_kw      fts5 over NORMALIZED text (kb-normalize.ts) of title,
//                   summary, content, tags, symbols, source_files, recall_cues,
//                   error_signatures. Ranked with per-column bm25 weights.
//   entries_tri     fts5 tokenize='trigram' over the RAW title, symbols and
//                   source_files, so a partial identifier (MemberSpl) matches.
//   kb_index_pending  rowids of entries whose index rows are out of date.
//   kb_index_meta   key/value index metadata (index version, rebuild state;
//                   room for the vector feature's model id/revision/dims).
//
// Why a pending queue instead of FTS external-content triggers: the indexed
// text is a JS normalization of the entry, which plain SQL triggers cannot
// compute. Pure-SQL triggers on entries (insert, delete, and update OF the
// indexed columns only) enqueue the rowid; every keyword READ first drains the
// queue, re-deriving the index rows from entries. So every write path
// (capture, setEntryRichFields, promote/demote, bible import, discard, ...)
// stays in lockstep without each one having to remember the index, and no
// user-defined SQL function is baked into the schema (another process or an
// older binary can still write the table).
//
// Versioning: kb_index_meta.kw_version must equal KB_KEYWORD_INDEX_VERSION.
// On a mismatch (old schema, or a normalizer change) a BACKGROUND rebuild is
// started: it is claimed in a BEGIN IMMEDIATE transaction with an owner and a
// heartbeat, so two handles/processes on one kb.sqlite never both rebuild
// destructively, and it proceeds in small chunks yielded to the event loop.
// Until it finishes, keyword reads answer from the legacy entries_fts table
// when it exists, else from a LIKE scan -- never throwing.
//
// Rollback contract (an older build, e.g. 0.4.4, on the same kb.sqlite):
// the legacy external-content entries_fts and its entries_ai/ad/au triggers
// are KEPT, populated and in step, by this build -- never dropped. 0.4.4 runs
// `CREATE ... IF NOT EXISTS` for exactly that table and those triggers on
// every open; if they were missing it would recreate the table EMPTY over a
// full entries table, its keyword reads would return 0 rows, and its first
// UPDATE would issue an FTS 'delete' for a row the index never held, which
// corrupts an external-content FTS5 index ("database disk image is
// malformed") for both builds. Keeping them means 0.4.4 finds a complete,
// consistent index and keeps it consistent itself through its own triggers,
// while 0.4.4's writes also enqueue rowids through the entries_kw_* triggers
// (they are plain SQL), so this build re-indexes them on its next read.
// On every init this build also REPAIRS the legacy index (LEGACY_FTS_SQL is
// byte-for-byte what 0.4.4 creates): a missing table or trigger is created,
// and when the legacy index row count disagrees with entries (a DB from a
// pre-fix build that had dropped it, then re-created empty by 0.4.4) or an
// FTS integrity check fails, it is rebuilt from entries with the FTS5
// 'rebuild' command. The cost is one extra FTS index on writes.

import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { logLine, logWarn } from '../../utils/log-helpers.js';
import { orJoinFtsTerms } from './audn.js';
import {
  KB_NORMALIZER_VERSION,
  normalizeForIndex,
  normalizeQueryTermList,
  normalizeQueryTerms,
} from './kb-normalize.js';

/** Bumped when the keyword-index table layout changes. */
export const KB_KEYWORD_SCHEMA_VERSION = 1;
/** Bumped when the recall_cues / error_signatures shape changes. */
export const KB_CUE_SCHEMA_VERSION = 1;
/** The full keyword-index version a ready index must carry. */
export const KB_KEYWORD_INDEX_VERSION =
  `kw${KB_KEYWORD_SCHEMA_VERSION}-norm${KB_NORMALIZER_VERSION}-cue${KB_CUE_SCHEMA_VERSION}`;

/** bm25 column weights, in entries_kw column order. */
export const KW_COLUMNS = [
  'title', 'summary', 'content', 'tags', 'symbols', 'source_files', 'recall_cues', 'error_signatures',
] as const;
export const KW_WEIGHTS: Record<(typeof KW_COLUMNS)[number], number> = {
  title: 5, summary: 3, content: 1, tags: 1, symbols: 4, source_files: 4, recall_cues: 4, error_signatures: 4,
};
const KW_BM25 = `bm25(entries_kw, ${KW_COLUMNS.map(c => KW_WEIGHTS[c]).join(', ')})`;
const TRI_BM25 = 'bm25(entries_tri, 5, 4, 4)';

const REBUILD_CHUNK_ROWS = 200;
/** A rebuild owner whose heartbeat is older than this is presumed dead. */
const REBUILD_STALE_MS = 30_000;
const TRIGRAM_MIN_LEN = 4;
const MAX_TRIGRAM_TERMS = 12;
const MAX_LIKE_TERMS = 16;

/**
 * The legacy external-content FTS and its triggers, exactly as 0.4.4 creates
 * them on open (see the rollback contract in the header). Must not change:
 * an older build re-runs these same IF NOT EXISTS statements.
 */
export const LEGACY_FTS_SQL = `
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

export interface KeywordIndexStatus {
  version: string | null;
  expected_version: string;
  ready: boolean;
  rebuilding: boolean;
  rebuild_started_at: string | null;
  rebuild_finished_at: string | null;
  rebuild_last_error: string | null;
  pending: number;
}

/** How a keyword search should match: free text or discrete terms. */
export interface KeywordSearch {
  query?: string;
  terms?: string[];
}

function jsonArrayText(raw: unknown): string {
  try {
    const v = JSON.parse((raw as string) || '[]');
    return Array.isArray(v) ? v.filter(x => typeof x === 'string').join(' ') : '';
  } catch {
    return '';
  }
}

function rawTokens(s: KeywordSearch): string[] {
  const src = s.terms?.length ? s.terms.join(' ') : (s.query ?? '');
  return src.normalize('NFKC').match(/[\p{L}\p{M}\p{N}_]+/gu) ?? [];
}

/** FTS5 MATCH for the trigram table: identifier-ish raw tokens, quoted, OR-joined. */
export function trigramMatch(s: KeywordSearch): string {
  const seen = new Set<string>();
  for (const t of rawTokens(s)) {
    if (t.length >= TRIGRAM_MIN_LEN) seen.add(t);
    if (seen.size >= MAX_TRIGRAM_TERMS) break;
  }
  // Tokens are letters/marks/digits/_ only, so quoting needs no escaping.
  return Array.from(seen).map(t => `"${t}"`).join(' OR ');
}

/** FTS5 MATCH for the normalized keyword table. */
export function keywordMatch(s: KeywordSearch): string {
  return s.terms?.length ? normalizeQueryTermList(s.terms) : normalizeQueryTerms(s.query ?? '');
}

export class KbKeywordIndex {
  private readonly owner = randomUUID();
  private readyCached = false;
  private rebuildScheduled = false;
  private closed = false;

  constructor(private readonly getDb: () => DatabaseSync | null) {}

  private db(): DatabaseSync {
    const db = this.getDb();
    if (!db) throw new Error('SqliteProvider not initialized. Call init() first.');
    return db;
  }

  // -- schema --------------------------------------------------------------

  /** Create the index tables/triggers (idempotent) and start a rebuild if needed. */
  init(): void {
    const db = this.db();
    // A provider may be closed and re-initialized: start from a clean slate.
    this.closed = false;
    this.readyCached = false;
    db.exec(`
      CREATE TABLE IF NOT EXISTS kb_index_meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );
      CREATE TABLE IF NOT EXISTS kb_index_pending (
        rid INTEGER PRIMARY KEY
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS entries_kw USING fts5(
        ${KW_COLUMNS.join(', ')},
        tokenize = 'unicode61'
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS entries_tri USING fts5(
        title, symbols, source_files,
        tokenize = 'trigram'
      );
      CREATE TRIGGER IF NOT EXISTS entries_kw_ai AFTER INSERT ON entries BEGIN
        INSERT OR IGNORE INTO kb_index_pending(rid) VALUES (new.rowid);
      END;
      CREATE TRIGGER IF NOT EXISTS entries_kw_ad AFTER DELETE ON entries BEGIN
        INSERT OR IGNORE INTO kb_index_pending(rid) VALUES (old.rowid);
      END;
      CREATE TRIGGER IF NOT EXISTS entries_kw_au
      AFTER UPDATE OF ${KW_COLUMNS.join(', ')} ON entries BEGIN
        INSERT OR IGNORE INTO kb_index_pending(rid) VALUES (old.rowid);
        INSERT OR IGNORE INTO kb_index_pending(rid) VALUES (new.rowid);
      END;
    `);
    this.setMetaIfAbsent('tokenizer_version', String(KB_NORMALIZER_VERSION));
    this.setMetaIfAbsent('cue_schema_version', String(KB_CUE_SCHEMA_VERSION));
    this.ensureLegacyFts();

    if (this.isReady()) return;

    const row = db.prepare('SELECT COUNT(*) AS n FROM entries').get() as { n: number };
    if (Number(row.n) === 0) {
      // Nothing to index: complete synchronously (fresh DB, or an empty old one).
      this.runRebuildSync();
      return;
    }
    this.startRebuild();
  }

  /**
   * Keep the legacy entries_fts (the index an older build reads) present,
   * complete and consistent -- see the rollback contract in the header.
   * Creates what is missing, then rebuilds it from entries when its row count
   * disagrees with entries or its FTS integrity check fails.
   */
  private ensureLegacyFts(): void {
    const db = this.db();
    this.inTxn(() => {
      const existed = !!db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'entries_fts'")
        .get();
      db.exec(LEGACY_FTS_SQL);
      let reason: string | null = existed ? null : 'missing';
      if (!reason) {
        const n = (db.prepare('SELECT COUNT(*) AS n FROM entries').get() as { n: number }).n;
        const m = (db.prepare('SELECT COUNT(*) AS n FROM entries_fts_docsize').get() as { n: number }).n;
        if (Number(n) !== Number(m)) reason = `row count ${m} != entries ${n}`;
      }
      if (!reason) {
        try {
          db.exec("INSERT INTO entries_fts(entries_fts, rank) VALUES ('integrity-check', 1)");
        } catch (err) {
          reason = `integrity check failed: ${(err as Error)?.message ?? String(err)}`;
        }
      }
      if (!reason) return;
      db.exec("INSERT INTO entries_fts(entries_fts) VALUES ('rebuild')");
      if (existed) logLine('kb_index', `legacy keyword index (entries_fts) rebuilt from entries (${reason})`);
    });
  }

  // -- meta ----------------------------------------------------------------

  private getMeta(key: string): string | null {
    const row = this.db().prepare('SELECT value FROM kb_index_meta WHERE key = ?').get(key) as
      | { value: string | null }
      | undefined;
    return row?.value ?? null;
  }

  private setMeta(key: string, value: string | null): void {
    this.db()
      .prepare('INSERT INTO kb_index_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  private setMetaIfAbsent(key: string, value: string): void {
    this.db().prepare('INSERT OR IGNORE INTO kb_index_meta(key, value) VALUES (?, ?)').run(key, value);
  }

  /** True once the normalized index is complete at the current version. */
  isReady(): boolean {
    if (this.readyCached) return true;
    this.readyCached = this.getMeta('kw_version') === KB_KEYWORD_INDEX_VERSION;
    return this.readyCached;
  }

  status(): KeywordIndexStatus {
    const pending = this.db().prepare('SELECT COUNT(*) AS n FROM kb_index_pending').get() as { n: number };
    const owner = this.getMeta('rebuild_owner');
    return {
      version: this.getMeta('kw_version'),
      expected_version: KB_KEYWORD_INDEX_VERSION,
      ready: this.isReady(),
      rebuilding: !this.isReady() && owner !== null,
      rebuild_started_at: this.getMeta('rebuild_started_at'),
      rebuild_finished_at: this.getMeta('rebuild_finished_at'),
      rebuild_last_error: this.getMeta('rebuild_last_error'),
      pending: Number(pending.n),
    };
  }

  // -- transactions --------------------------------------------------------

  private inTxn<T>(fn: () => T): T {
    const db = this.db();
    if (db.isTransaction) {
      db.exec('SAVEPOINT kb_kw');
      try {
        const out = fn();
        db.exec('RELEASE kb_kw');
        return out;
      } catch (err) {
        db.exec('ROLLBACK TO kb_kw');
        db.exec('RELEASE kb_kw');
        throw err;
      }
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw err;
    }
  }

  // -- index maintenance ---------------------------------------------------

  /** Re-derive the index rows of up to `max` pending rowids. Returns rows processed. */
  private processPending(max: number): number {
    const db = this.db();
    const rids = db.prepare('SELECT rid FROM kb_index_pending ORDER BY rid LIMIT ?').all(max) as { rid: number }[];
    if (rids.length === 0) return 0;
    const delKw = db.prepare('DELETE FROM entries_kw WHERE rowid = ?');
    const delTri = db.prepare('DELETE FROM entries_tri WHERE rowid = ?');
    const get = db.prepare(
      'SELECT rowid AS rid, title, summary, content, tags, symbols, source_files, recall_cues, error_signatures FROM entries WHERE rowid = ?'
    );
    const insKw = db.prepare(
      `INSERT INTO entries_kw(rowid, ${KW_COLUMNS.join(', ')}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insTri = db.prepare('INSERT INTO entries_tri(rowid, title, symbols, source_files) VALUES (?, ?, ?, ?)');
    const done = db.prepare('DELETE FROM kb_index_pending WHERE rid = ?');
    for (const { rid } of rids) {
      delKw.run(rid);
      delTri.run(rid);
      const e = get.get(rid) as Record<string, unknown> | undefined;
      if (e) {
        const symbols = jsonArrayText(e.symbols);
        const files = jsonArrayText(e.source_files);
        insKw.run(
          rid,
          normalizeForIndex(String(e.title ?? '')),
          normalizeForIndex(String(e.summary ?? '')),
          normalizeForIndex(String(e.content ?? '')),
          normalizeForIndex(jsonArrayText(e.tags)),
          normalizeForIndex(symbols),
          normalizeForIndex(files),
          normalizeForIndex(jsonArrayText(e.recall_cues)),
          normalizeForIndex(jsonArrayText(e.error_signatures)),
        );
        insTri.run(rid, String(e.title ?? ''), symbols, files);
      }
      done.run(rid);
    }
    return rids.length;
  }

  /**
   * Bring a READY index up to date before a read. Normally a handful of rows
   * (whatever was written since the last read).
   */
  private drain(): void {
    const db = this.db();
    if (!db.prepare('SELECT 1 FROM kb_index_pending LIMIT 1').get()) return;
    this.inTxn(() => {
      while (this.processPending(500) > 0) { /* drain */ }
    });
  }

  /** Reset the index and enqueue every entry (inside a claimed transaction). */
  private resetForRebuild(): void {
    const db = this.db();
    db.exec('DELETE FROM entries_kw');
    db.exec('DELETE FROM entries_tri');
    db.exec('INSERT OR IGNORE INTO kb_index_pending(rid) SELECT rowid FROM entries');
    this.setMeta('rebuild_target', KB_KEYWORD_INDEX_VERSION);
  }

  /**
   * Mark ready. The legacy entries_fts and its triggers are deliberately NOT
   * dropped: an older build on the same kb.sqlite reads them (header).
   */
  private finish(): void {
    this.setMeta('kw_version', KB_KEYWORD_INDEX_VERSION);
    this.setMeta('tokenizer_version', String(KB_NORMALIZER_VERSION));
    this.setMeta('cue_schema_version', String(KB_CUE_SCHEMA_VERSION));
    this.setMeta('rebuild_owner', null);
    this.setMeta('rebuild_heartbeat', null);
    this.setMeta('rebuild_finished_at', new Date().toISOString());
    this.setMeta('rebuild_last_error', null);
  }

  private runRebuildSync(): void {
    this.inTxn(() => {
      if (this.getMeta('kw_version') === KB_KEYWORD_INDEX_VERSION) return;
      this.resetForRebuild();
      while (this.processPending(1000) > 0) { /* index all */ }
      this.finish();
    });
    this.readyCached = true;
  }

  /**
   * Claim (or take over a dead) rebuild and run it in the background. Never
   * blocks the caller beyond the claim transaction.
   */
  startRebuild(): void {
    if (this.rebuildScheduled || this.closed) return;
    let claimed: 'mine' | 'other' | 'done' = 'other';
    try {
      claimed = this.inTxn(() => {
        if (this.getMeta('kw_version') === KB_KEYWORD_INDEX_VERSION) return 'done' as const;
        const owner = this.getMeta('rebuild_owner');
        const beat = Date.parse(this.getMeta('rebuild_heartbeat') ?? '');
        const alive = owner !== null && owner !== this.owner && Number.isFinite(beat) && Date.now() - beat < REBUILD_STALE_MS;
        if (alive) return 'other' as const;
        const now = new Date().toISOString();
        this.setMeta('rebuild_owner', this.owner);
        this.setMeta('rebuild_heartbeat', now);
        if (this.getMeta('rebuild_target') !== KB_KEYWORD_INDEX_VERSION) {
          this.resetForRebuild();
          this.setMeta('rebuild_started_at', now);
          this.setMeta('rebuild_finished_at', null);
        }
        return 'mine' as const;
      });
    } catch (err) {
      this.fail(err);
      return;
    }
    if (claimed === 'done') {
      this.readyCached = true;
      return;
    }
    if (claimed === 'other') {
      // Another handle/process is rebuilding; re-check later in case it dies.
      const t = setTimeout(() => { if (!this.closed && !this.isReadySafe()) this.startRebuild(); }, REBUILD_STALE_MS);
      t.unref?.();
      return;
    }
    const pending = this.status().pending;
    logLine('kb_index', `keyword index rebuild started (target ${KB_KEYWORD_INDEX_VERSION}, ${pending} entries queued)`);
    this.rebuildScheduled = true;
    setImmediate(() => this.rebuildChunk());
  }

  private isReadySafe(): boolean {
    try { return this.isReady(); } catch { return true; }
  }

  private rebuildChunk(): void {
    if (this.closed || this.getDb() === null) {
      this.rebuildScheduled = false;
      return;
    }
    let finished = false;
    try {
      const stillMine = this.inTxn(() => {
        if (this.getMeta('rebuild_owner') !== this.owner) return false;
        this.processPending(REBUILD_CHUNK_ROWS);
        this.setMeta('rebuild_heartbeat', new Date().toISOString());
        const left = this.db().prepare('SELECT 1 FROM kb_index_pending LIMIT 1').get();
        if (!left) {
          this.finish();
          finished = true;
        }
        return true;
      });
      if (!stillMine) {
        this.rebuildScheduled = false;
        return;
      }
    } catch (err) {
      this.rebuildScheduled = false;
      this.fail(err);
      return;
    }
    if (finished) {
      this.rebuildScheduled = false;
      this.readyCached = true;
      logLine('kb_index', `keyword index rebuild finished (version ${KB_KEYWORD_INDEX_VERSION})`);
      return;
    }
    setImmediate(() => this.rebuildChunk());
  }

  private fail(err: unknown): void {
    const msg = (err as Error)?.message ?? String(err);
    logWarn('kb_index', `keyword index rebuild failed; keyword queries use the fallback index until the next start: ${msg}`);
    try {
      this.inTxn(() => {
        if (this.getMeta('rebuild_owner') === this.owner) this.setMeta('rebuild_owner', null);
        this.setMeta('rebuild_last_error', msg);
      });
    } catch { /* DB unusable: nothing more to record */ }
  }

  /** Wait until the index is ready (tests and maintenance callers). */
  async waitUntilReady(timeoutMs = 30_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.getDb() === null) return false;
      if (this.isReady()) return true;
      if (!this.rebuildScheduled) this.startRebuild();
      await new Promise(r => setTimeout(r, 10));
    }
    return this.isReady();
  }

  close(): void {
    this.closed = true;
  }

  // -- search --------------------------------------------------------------

  private legacyFtsExists(): boolean {
    return !!this.db()
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'entries_fts'")
      .get();
  }

  /**
   * Keyword search over entries. `conditions` are SQL predicates over alias
   * `e` (ANDed), `params` their bind values. Returns entry rows in rank order.
   * Never throws for a malformed query: an unusable query returns [].
   *
   * opts.trigram folds partial-identifier (trigram) hits in below every
   * full-token hit; AUDN candidate discovery leaves it off.
   *
   * opts.column restricts the match to one indexed column (e.g.
   * 'error_signatures' for a kb_query error_text) and turns trigram off.
   */
  search(
    s: KeywordSearch,
    conditions: string[],
    params: SQLInputValue[],
    limit: number,
    opts: { trigram?: boolean; column?: (typeof KW_COLUMNS)[number] } = {}
  ): Record<string, unknown>[] {
    const db = this.db();
    const cond = conditions.length ? 'AND ' + conditions.join(' AND ') : '';
    const column = opts.column && (KW_COLUMNS as readonly string[]).includes(opts.column) ? opts.column : undefined;

    if (this.isReady()) {
      this.drain();
      const bare = keywordMatch(s);
      // FTS5 column filter: '<col> : ( ... )'. The column name comes from
      // KW_COLUMNS only, never from caller text.
      const kw = bare && column ? `${column} : (${bare})` : bare;
      const tri = opts.trigram && !column ? trigramMatch(s) : '';
      if (!kw && !tri) return [];
      const ctes: string[] = [];
      const bind: SQLInputValue[] = [];
      if (kw) {
        ctes.push(`kw AS MATERIALIZED (SELECT rowid AS rid, ${KW_BM25} AS s FROM entries_kw WHERE entries_kw MATCH ?)`);
        bind.push(kw);
      } else {
        ctes.push('kw AS (SELECT NULL AS rid, NULL AS s WHERE 0)');
      }
      if (tri) {
        ctes.push(`tri AS MATERIALIZED (SELECT rowid AS rid, ${TRI_BM25} AS s FROM entries_tri WHERE entries_tri MATCH ?)`);
        bind.push(tri);
      } else {
        ctes.push('tri AS (SELECT NULL AS rid, NULL AS s WHERE 0)');
      }
      return db.prepare(`
        WITH ${ctes.join(',\n')}
        SELECT e.* FROM entries e
        LEFT JOIN kw ON kw.rid = e.rowid
        LEFT JOIN tri ON tri.rid = e.rowid
        WHERE e.rowid IN (SELECT rid FROM kw UNION SELECT rid FROM tri)
        ${cond}
        ORDER BY (kw.rid IS NULL), kw.s, tri.s, e.created_at DESC
        LIMIT ?
      `).all(...bind, ...params, limit) as Record<string, unknown>[];
    }

    // Not ready (rebuild running): legacy index when present, else LIKE.
    const raw = rawTokens(s);
    if (!column && this.legacyFtsExists()) {
      const legacy = s.terms?.length ? orJoinFtsTerms(s.terms) : orJoinFtsTerms(raw);
      if (!legacy) return [];
      try {
        return db.prepare(`
          SELECT e.* FROM entries e
          JOIN entries_fts ON entries_fts.rowid = e.rowid
          WHERE entries_fts MATCH ?
          ${cond}
          ORDER BY rank
          LIMIT ?
        `).all(legacy, ...params, limit) as Record<string, unknown>[];
      } catch {
        // fall through to LIKE
      }
    }
    const words = Array.from(new Set(raw.map(w => w.toLowerCase()))).slice(0, MAX_LIKE_TERMS);
    if (words.length === 0) return [];
    const likeCols = column
      ? [`e.${column}`]
      : ['e.title', 'e.summary', 'e.content', 'e.symbols', 'e.source_files', 'e.tags'];
    const ors: string[] = [];
    const likeParams: SQLInputValue[] = [];
    for (const w of words) {
      const pat = '%' + w.replace(/[\\%_]/g, c => '\\' + c) + '%';
      for (const col of likeCols) {
        ors.push(`lower(${col}) LIKE ? ESCAPE '\\'`);
        likeParams.push(pat);
      }
    }
    return db.prepare(`
      SELECT e.* FROM entries e
      WHERE (${ors.join(' OR ')})
      ${cond}
      ORDER BY e.created_at DESC
      LIMIT ?
    `).all(...likeParams, ...params, limit) as Record<string, unknown>[];
  }
}
