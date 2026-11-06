// KB entry -> code-index links (design D2a anchors).
//
// At capture, an entry's symbols and source files are resolved to code-index
// nodes and stored in entry_code_links; the freshness sweep re-resolves them.
// They feed the anchor list of the hybrid search: lookupAnchors(files,
// symbols) returns entries whose linked files intersect the given files, or
// whose linked symbols are one code-graph hop from (or equal to) the given
// symbols.
//
// Layering: this module (src/services) must NOT import src/tools -- the code
// intelligence provider lives there and src/tools already imports the KB
// service (see the header of src/tools/code-intelligence-kb-enrich.ts), so an
// import here would close a cycle. The tool layer injects a CodeLinkResolver
// instead (src/tools/kb-code-link-resolver.ts).
//
// Never-wait rule: capture only schedules resolution (off the request path,
// like embeddings); a missing code index, a disabled provider or a throwing
// resolver is a skip and never fails a capture. The expected skips (no
// resolver attached, no ready code index -- the normal state of a host
// without code intelligence) are recorded in kb_index_meta and readable
// through status(), not written to the fleet log on every capture; an
// unexpected resolver error is logged as a warning (once per distinct error).

import type { DatabaseSync } from 'node:sqlite';
import { logLine, logWarn } from '../../utils/log-helpers.js';

export type CodeNodeKind = 'symbol' | 'file';

export interface CodeLinkItem {
  kind: CodeNodeKind;
  ref: string;
}

export interface CodeLinksStatus {
  /** When links were last written. */
  last_resolved_at: string | null;
  /** Why the last resolution attempt was skipped (cleared by a successful one). */
  last_skip: string | null;
  last_skip_at: string | null;
}

export interface ResolvedCodeLink extends CodeLinkItem {
  /** False when the code index has no such node (stored, never an error). */
  resolved: boolean;
  /** One-hop callers/callees (symbol names) when the code index provides them. */
  neighbours?: string[];
}

/**
 * Resolve items against the active code index. Resolves to null when there
 * is no usable code index (no provider, provider none, index not ready): the
 * caller skips and keeps the links it has. May throw; callers catch.
 */
export type CodeLinkResolver = (items: CodeLinkItem[]) => Promise<ResolvedCodeLink[] | null>;

export type CodeLinkLog = (level: 'info' | 'warn', message: string) => void;

const defaultLog: CodeLinkLog = (level, m) => (level === 'warn' ? logWarn('kb_code_links', m) : logLine('kb_code_links', m));

/** Normalize a file reference for comparison: forward slashes, no leading ./ */
export function normalizeFileRef(f: string): string {
  return f.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '');
}

function parseList(raw: unknown): string[] {
  try {
    const v = JSON.parse((raw as string) || '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
  } catch {
    return [];
  }
}

export class CodeLinkStore {
  private resolver: CodeLinkResolver | null = null;
  private readonly queued = new Set<string>();
  /** A full re-resolve of every live entry is pending (freshness sweep). */
  private fullPending = false;
  private scheduled = false;
  private running: Promise<void> | null = null;
  private closed = false;
  private lastNotice = '';

  constructor(
    private readonly getDb: () => DatabaseSync | null,
    private readonly log: CodeLinkLog = defaultLog,
  ) {}

  private db(): DatabaseSync {
    const db = this.getDb();
    if (!db) throw new Error('SqliteProvider not initialized. Call init() first.');
    return db;
  }

  init(): void {
    this.closed = false;
    this.db().exec(`
      CREATE TABLE IF NOT EXISTS entry_code_links (
        entry_id TEXT NOT NULL,
        node_kind TEXT NOT NULL,
        node_ref TEXT NOT NULL,
        resolved INTEGER NOT NULL DEFAULT 0,
        resolved_at TEXT NOT NULL,
        neighbours TEXT NOT NULL DEFAULT '[]',
        PRIMARY KEY (entry_id, node_kind, node_ref)
      );
      CREATE INDEX IF NOT EXISTS idx_entry_code_links_ref ON entry_code_links(node_kind, node_ref);
      CREATE TRIGGER IF NOT EXISTS entries_code_links_ad AFTER DELETE ON entries BEGIN
        DELETE FROM entry_code_links WHERE entry_id = old.id;
      END;
    `);
  }

  close(): void {
    this.closed = true;
    this.queued.clear();
    this.fullPending = false;
  }

  /** Set (or with null, clear) the resolver the tool layer injects. */
  setResolver(resolver: CodeLinkResolver | null): void {
    this.resolver = resolver;
  }

  get hasResolver(): boolean {
    return this.resolver !== null;
  }

  private notice(level: 'info' | 'warn', key: string, message: string): void {
    if (this.lastNotice === key) return;
    this.lastNotice = key;
    this.log(level, message);
  }

  private setMeta(key: string, value: string | null): void {
    this.db()
      .prepare('INSERT INTO kb_index_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  private getMeta(key: string): string | null {
    const row = this.db().prepare('SELECT value FROM kb_index_meta WHERE key = ?').get(key) as { value: string | null } | undefined;
    return row?.value ?? null;
  }

  /** Record why resolution was skipped (KB status, not the fleet log). Never throws. */
  private recordSkip(reason: string): void {
    try {
      if (this.closed || this.getDb() === null) return;
      this.setMeta('code_links_last_skip', reason);
      this.setMeta('code_links_last_skip_at', new Date().toISOString());
    } catch { /* status only */ }
  }

  status(): CodeLinksStatus {
    return {
      last_resolved_at: this.getMeta('code_links_last_resolved_at'),
      last_skip: this.getMeta('code_links_last_skip'),
      last_skip_at: this.getMeta('code_links_last_skip_at'),
    };
  }

  /** Queue a re-resolve of every live entry (the freshness sweep). Never throws. */
  enqueueAll(): void {
    if (this.closed) return;
    this.fullPending = true;
    this.enqueue([]);
  }

  /** Queue entries for resolution and schedule a background run. Never throws. */
  enqueue(ids: string[]): void {
    if (this.closed) return;
    for (const id of ids) this.queued.add(id);
    if (this.queued.size === 0 && !this.fullPending) return;
    if (this.scheduled || this.running) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      if (this.closed || this.getDb() === null) return;
      this.running = this.drainQueued().finally(() => {
        this.running = null;
        if ((this.queued.size > 0 || this.fullPending) && !this.closed && this.resolver) this.enqueue([]);
      });
    });
  }

  /** Resolve true once nothing is scheduled or running (false on timeout). */
  async whenIdle(timeoutMs = 30_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.scheduled && !this.running) return true;
      if (this.running) await this.running;
      else await new Promise(r => setTimeout(r, 2));
    }
    return !this.scheduled && !this.running;
  }

  private async drainQueued(): Promise<void> {
    const full = this.fullPending;
    const ids = [...this.queued];
    this.queued.clear();
    this.fullPending = false;
    if (!full && ids.length === 0) return;
    // No resolver attached (the global KB, a remote member's folder, a
    // provider used directly): nothing to resolve against, silently.
    if (!this.resolver) return;
    await this.resolveEntries(full ? null : ids);
  }

  /** Live entries' items to resolve. */
  private itemsFor(ids: string[] | null): Map<string, CodeLinkItem[]> {
    const db = this.db();
    const rows = (ids === null
      ? db.prepare("SELECT id, symbols, source_files FROM entries WHERE superseded_at IS NULL AND content_hash != 'invalidated'").all()
      : db.prepare(
          `SELECT id, symbols, source_files FROM entries WHERE id IN (${ids.map(() => '?').join(',')})
           AND superseded_at IS NULL AND content_hash != 'invalidated'`,
        ).all(...ids)) as { id: string; symbols: string; source_files: string }[];
    const out = new Map<string, CodeLinkItem[]>();
    for (const r of rows) {
      const items: CodeLinkItem[] = [
        ...parseList(r.symbols).map(ref => ({ kind: 'symbol' as const, ref: ref.trim() })),
        ...parseList(r.source_files).map(ref => ({ kind: 'file' as const, ref: normalizeFileRef(ref) })),
      ];
      if (items.length > 0) out.set(r.id, items);
    }
    return out;
  }

  /**
   * Resolve the links of `ids` (null = every live entry) and replace their
   * rows. Returns the number of entries whose links were written, or null
   * when skipped (no resolver, no code index, resolver threw). Never throws.
   */
  async resolveEntries(ids: string[] | null): Promise<number | null> {
    const resolver = this.resolver;
    if (!resolver) {
      this.recordSkip('no code-intelligence resolver is attached');
      return null;
    }
    try {
      const work = this.itemsFor(ids);
      if (work.size === 0) return 0;
      // One resolver call over the distinct items of every entry.
      const distinct = new Map<string, CodeLinkItem>();
      for (const items of work.values()) for (const it of items) distinct.set(`${it.kind}\0${it.ref}`, it);
      const resolved = await resolver([...distinct.values()]);
      if (this.closed || this.getDb() === null) return null;
      if (resolved === null) {
        this.recordSkip('no ready code index (code intelligence off, not configured, or the index is missing or building)');
        return null;
      }
      const byKey = new Map(resolved.map(r => [`${r.kind}\0${r.ref}`, r]));
      const db = this.db();
      const now = new Date().toISOString();
      const del = db.prepare('DELETE FROM entry_code_links WHERE entry_id = ?');
      const ins = db.prepare(
        `INSERT OR REPLACE INTO entry_code_links (entry_id, node_kind, node_ref, resolved, resolved_at, neighbours)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      let written = 0;
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const [id, items] of work) {
          del.run(id);
          for (const it of items) {
            const r = byKey.get(`${it.kind}\0${it.ref}`);
            const neighbours = r?.resolved && Array.isArray(r.neighbours) ? [...new Set(r.neighbours.filter(x => typeof x === 'string' && x !== ''))] : [];
            ins.run(id, it.kind, it.ref, r?.resolved ? 1 : 0, now, JSON.stringify(neighbours));
          }
          written++;
        }
        this.setMeta('code_links_last_resolved_at', now);
        this.setMeta('code_links_last_skip', null);
        this.setMeta('code_links_last_skip_at', null);
        db.exec('COMMIT');
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
        throw err;
      }
      this.lastNotice = '';
      return written;
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      this.recordSkip(`resolver error: ${msg}`);
      this.notice('warn', `error:${msg}`, `resolving KB code links failed, existing links kept (captures unaffected): ${msg}`);
      return null;
    }
  }

  /** Stored links of one entry (tests and diagnostics). */
  linksOf(entryId: string): ResolvedCodeLink[] {
    const rows = this.db()
      .prepare('SELECT node_kind, node_ref, resolved, neighbours FROM entry_code_links WHERE entry_id = ? ORDER BY node_kind, node_ref')
      .all(entryId) as { node_kind: CodeNodeKind; node_ref: string; resolved: number; neighbours: string }[];
    return rows.map(r => ({ kind: r.node_kind, ref: r.node_ref, resolved: r.resolved === 1, neighbours: parseList(r.neighbours) }));
  }

  /**
   * Live entry ids whose linked files intersect `files`, or whose linked
   * symbols equal or sit one hop (a stored neighbour) from any of `symbols`.
   */
  lookupAnchors(files: string[], symbols: string[]): string[] {
    const fileRefs = [...new Set(files.map(normalizeFileRef).filter(Boolean))];
    const symRefs = [...new Set(symbols.map(s => s.trim()).filter(Boolean))];
    if (fileRefs.length === 0 && symRefs.length === 0) return [];
    const ors: string[] = [];
    const params: string[] = [];
    if (fileRefs.length > 0) {
      ors.push(`(l.node_kind = 'file' AND l.node_ref IN (${fileRefs.map(() => '?').join(',')}))`);
      params.push(...fileRefs);
    }
    if (symRefs.length > 0) {
      const marks = symRefs.map(() => '?').join(',');
      ors.push(`(l.node_kind = 'symbol' AND (l.node_ref IN (${marks})
        OR EXISTS (SELECT 1 FROM json_each(l.neighbours) WHERE json_each.value IN (${marks}))))`);
      params.push(...symRefs, ...symRefs);
    }
    const rows = this.db().prepare(`
      SELECT DISTINCT l.entry_id AS id FROM entry_code_links l
      JOIN entries e ON e.id = l.entry_id
      WHERE e.superseded_at IS NULL AND e.content_hash != 'invalidated'
        AND (${ors.join(' OR ')})
      ORDER BY l.entry_id
    `).all(...params) as { id: string }[];
    return rows.map(r => r.id);
  }
}
