// Background embedding of KB entries (design D2a/D2c/D2f).
//
// A capture never waits for its embedding. Every write that creates or
// changes embeddable text enqueues the entry id into kb_embed_pending through
// pure-SQL triggers (vector-store.ts), inside the same write, and returns. This
// queue drains kb_embed_pending OFF the request path: kick() only schedules a
// run on the event loop, and a run batches entries, embeds them with the
// active embedder and stores their vectors. It never throws into a caller:
// with embedding disabled, or the embedder failed, a run is a logged no-op and
// keyword and anchor search keep serving.
//
// Model identity: kb_index_meta records the model id, revision and dims the
// vectors were built with (vec_model_id / vec_model_revision / vec_dims) plus
// the vector index version (KB_VECTOR_INDEX_VERSION: chunker + layout). When a
// run finds them different from the active embedder, it starts a background
// REBUILD: it re-enqueues every live entry and records the new identity; the
// queue then re-embeds them. Scoring only ever reads the active model's rows
// (vector-store.ts), so the old model's vectors are never used after the
// switch even before the rebuild finishes; they are deleted once it does.
//
// Two handles or processes on one kb.sqlite (WAL, busy_timeout=5000): the
// rebuild is CLAIMED in a BEGIN IMMEDIATE transaction through kb_index_meta
// (vec_rebuild_owner + heartbeat), the same scheme the keyword index uses, so
// only one of them resets the queue and deletes the old model's rows. While
// another live owner rebuilds, this queue stays out of its way and re-checks
// later (the owner drains the shared pending table, captures from this
// process included).
//
// The bible carries no vectors: they are model-specific. Each host embeds
// the bible's entries after kb_import, through the same triggers.

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { logLine, logWarn } from '../../../utils/log-helpers.js';
import { inputsHash, KB_CHUNKER_VERSION, type VectorInput } from './chunker.js';
import { INVALIDATED_HASH, type VectorModel, type VectorStore } from './vector-store.js';

/** Bumped when the vector layout changes; with the chunker version it forces a rebuild. */
export const KB_VECTOR_SCHEMA_VERSION = 1;
export const KB_VECTOR_INDEX_VERSION = `vec${KB_VECTOR_SCHEMA_VERSION}-chunk${KB_CHUNKER_VERSION}`;

/** What the queue needs from an embedder (embedding/embedder.ts Embedder satisfies it). */
export interface EmbedderLike {
  readonly state: { state: string; reason?: string };
  readonly modelId: string | null;
  readonly revision: string | null;
  readonly dims: number | undefined;
  readonly tokenLimit: number | null;
  embedDocuments(texts: string[]): Promise<Float32Array[] | null>;
  /**
   * Embed a search query (profile query prefix applied); null when disabled
   * or failed. Optional: an embedder without it gives hybrid search no
   * semantic list (keyword + anchor only).
   */
  embedQuery?(text: string): Promise<Float32Array | null>;
}

/** Resolves the active embedder at run time (so a swapped process embedder is seen). */
export type EmbedderSource = () => EmbedderLike | null;

export type EmbedQueueLog = (level: 'info' | 'warn', message: string) => void;

export interface EmbedQueueStatus {
  model_id: string | null;
  model_revision: string | null;
  dims: number | null;
  index_version: string | null;
  pending: number;
  rebuilding: boolean;
  rebuild_started_at: string | null;
  rebuild_finished_at: string | null;
  rebuild_last_error: string | null;
}

export interface EmbedQueueOptions {
  getDb: () => DatabaseSync | null;
  store: VectorStore;
  /** The vector inputs of an entry at a token limit, or null when unknown. */
  inputsFor: (id: string, tokenLimit: number) => VectorInput[] | null;
  log?: EmbedQueueLog;
  batchSize?: number;
}

const DEFAULT_BATCH = 16;
const DEFAULT_TOKEN_LIMIT = 512;
/** A rebuild owner whose heartbeat is older than this is presumed dead. */
const REBUILD_STALE_MS = 30_000;
const PROGRESS_EVERY_BATCHES = 10;

const defaultLog: EmbedQueueLog = (level, m) => (level === 'warn' ? logWarn('kb_embedding', m) : logLine('kb_embedding', m));

type StopReason = 'drained' | 'unusable' | 'error' | 'blocked' | 'closed';

/**
 * Embedder-state notices (disabled, failed: <reason>) already logged by any
 * queue in this process: the embedder is process-wide, so every KB provider
 * would otherwise repeat the same line.
 */
const processNotices = new Set<string>();

export class EmbedQueue {
  private readonly owner = randomUUID();
  private readonly log: EmbedQueueLog;
  private readonly batchSize: number;
  private source: EmbedderSource | null = null;
  private scheduled = false;
  private runPromise: Promise<void> | null = null;
  private rerun = false;
  /** attach() ran during a run: always run again with the new source. */
  private sourceChanged = false;
  private closed = false;
  private recheckTimer: NodeJS.Timeout | null = null;
  private lastNotice = '';
  private batchesThisRebuild = 0;
  /** Why the last run stopped (tests and diagnostics). */
  lastStop: StopReason | null = null;

  constructor(private readonly opts: EmbedQueueOptions) {
    this.log = opts.log ?? defaultLog;
    this.batchSize = opts.batchSize ?? DEFAULT_BATCH;
  }

  /** Set (or with null, clear) the embedder source, then schedule a run. */
  attach(source: EmbedderSource | null): void {
    this.source = source;
    this.lastNotice = '';
    if (this.runPromise) this.sourceChanged = true;
    this.kick();
  }

  get attached(): boolean {
    return this.source !== null;
  }

  /** Re-open after a provider close() + init(). */
  reopen(): void {
    this.closed = false;
  }

  close(): void {
    this.closed = true;
    if (this.recheckTimer) clearTimeout(this.recheckTimer);
    this.recheckTimer = null;
  }

  /** Schedule a run off the current call stack. Cheap, idempotent, never throws. */
  kick(): void {
    if (this.closed || this.source === null) return;
    if (this.runPromise) {
      this.rerun = true;
      return;
    }
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      if (this.closed || this.opts.getDb() === null) return;
      this.runPromise = this.run().finally(() => {
        this.runPromise = null;
        if (this.rerun) {
          this.rerun = false;
          // After an unusable/error stop only a new source warrants a retry
          // now; otherwise the next write or read kicks it.
          if (this.lastStop === 'drained' || this.sourceChanged) this.kick();
        }
        this.sourceChanged = false;
      });
    });
  }

  /** Resolve true once no run is scheduled or in flight (false on timeout). */
  async whenIdle(timeoutMs = 30_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.scheduled && !this.runPromise) return true;
      if (this.runPromise) {
        let t: NodeJS.Timeout | undefined;
        await Promise.race([
          this.runPromise,
          new Promise<void>(r => { t = setTimeout(r, Math.max(1, deadline - Date.now())); }),
        ]);
        if (t) clearTimeout(t);
      } else {
        await new Promise(r => setTimeout(r, 2));
      }
    }
    return !this.scheduled && !this.runPromise;
  }

  // -- meta ------------------------------------------------------------------

  private db(): DatabaseSync {
    const db = this.opts.getDb();
    if (!db) throw new Error('SqliteProvider not initialized. Call init() first.');
    return db;
  }

  private getMeta(key: string): string | null {
    const row = this.db().prepare('SELECT value FROM kb_index_meta WHERE key = ?').get(key) as { value: string | null } | undefined;
    return row?.value ?? null;
  }

  private setMeta(key: string, value: string | null): void {
    this.db()
      .prepare('INSERT INTO kb_index_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  private inTxn<T>(fn: () => T): T {
    const db = this.db();
    if (db.isTransaction) {
      db.exec('SAVEPOINT kb_vec');
      try {
        const out = fn();
        db.exec('RELEASE kb_vec');
        return out;
      } catch (err) {
        db.exec('ROLLBACK TO kb_vec');
        db.exec('RELEASE kb_vec');
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

  status(): EmbedQueueStatus {
    const pending = this.db().prepare('SELECT COUNT(*) AS n FROM kb_embed_pending').get() as { n: number };
    const dims = this.getMeta('vec_dims');
    return {
      model_id: this.getMeta('vec_model_id'),
      model_revision: this.getMeta('vec_model_revision'),
      dims: dims === null ? null : Number(dims),
      index_version: this.getMeta('vec_index_version'),
      pending: Number(pending.n),
      rebuilding: this.getMeta('vec_rebuild_owner') !== null,
      rebuild_started_at: this.getMeta('vec_rebuild_started_at'),
      rebuild_finished_at: this.getMeta('vec_rebuild_finished_at'),
      rebuild_last_error: this.getMeta('vec_rebuild_last_error'),
    };
  }

  /** The model identity the stored vectors were built with, when fully known. */
  recordedModel(): VectorModel | null {
    const modelId = this.getMeta('vec_model_id');
    const revision = this.getMeta('vec_model_revision');
    const dims = this.getMeta('vec_dims');
    if (modelId === null || revision === null || dims === null) return null;
    return { modelId, revision, dims: Number(dims) };
  }

  private notice(level: 'info' | 'warn', key: string, message: string): void {
    if (this.lastNotice === key || processNotices.has(key)) return;
    this.lastNotice = key;
    processNotices.add(key);
    this.log(level, message);
  }

  private foreignOwnerAlive(): boolean {
    const owner = this.getMeta('vec_rebuild_owner');
    if (owner === null || owner === this.owner) return false;
    const beat = Date.parse(this.getMeta('vec_rebuild_heartbeat') ?? '');
    return Number.isFinite(beat) && Date.now() - beat < REBUILD_STALE_MS;
  }

  /**
   * Make the recorded model identity match `emb`, claiming a rebuild when it
   * does not. 'blocked' while another live handle/process owns a rebuild.
   */
  private ensureModel(emb: EmbedderLike & { modelId: string; revision: string }): 'ok' | 'blocked' {
    const wantDims = emb.dims ?? null;
    const matches = () => {
      const dims = this.getMeta('vec_dims');
      return this.getMeta('vec_model_id') === emb.modelId
        && this.getMeta('vec_model_revision') === emb.revision
        && this.getMeta('vec_index_version') === KB_VECTOR_INDEX_VERSION
        && (wantDims === null || dims === null || Number(dims) === wantDims);
    };
    if (matches() && !this.foreignOwnerAlive()) return 'ok';
    return this.inTxn(() => {
      if (this.foreignOwnerAlive()) return 'blocked' as const;
      if (matches()) return 'ok' as const;
      const from = this.getMeta('vec_model_id');
      const fromRev = this.getMeta('vec_model_revision');
      const now = new Date().toISOString();
      const live = this.db().prepare(
        `SELECT COUNT(*) AS n FROM entries WHERE superseded_at IS NULL AND content_hash != '${INVALIDATED_HASH}'`,
      ).get() as { n: number };
      const anyVectors = this.opts.store.count() > 0;
      if (Number(live.n) === 0 && !anyVectors) {
        // Nothing to (re-)embed (a fresh KB): record the identity, no rebuild.
        this.setMeta('vec_model_id', emb.modelId);
        this.setMeta('vec_model_revision', emb.revision);
        this.setMeta('vec_dims', wantDims === null ? null : String(wantDims));
        this.setMeta('vec_index_version', KB_VECTOR_INDEX_VERSION);
        return 'ok' as const;
      }
      this.setMeta('vec_rebuild_owner', this.owner);
      this.setMeta('vec_rebuild_heartbeat', now);
      this.setMeta('vec_rebuild_started_at', now);
      this.setMeta('vec_rebuild_finished_at', null);
      this.setMeta('vec_rebuild_last_error', null);
      this.setMeta('vec_model_id', emb.modelId);
      this.setMeta('vec_model_revision', emb.revision);
      this.setMeta('vec_dims', wantDims === null ? null : String(wantDims));
      this.setMeta('vec_index_version', KB_VECTOR_INDEX_VERSION);
      this.setMeta('vec_cleanup_needed', '1');
      this.db().exec(
        `INSERT OR IGNORE INTO kb_embed_pending(entry_id)
         SELECT id FROM entries WHERE superseded_at IS NULL AND content_hash != '${INVALIDATED_HASH}'`,
      );
      const pending = this.db().prepare('SELECT COUNT(*) AS n FROM kb_embed_pending').get() as { n: number };
      this.batchesThisRebuild = 0;
      this.log('info',
        `vector index rebuild started: ${from === null ? 'no vectors yet' : `${from}@${fromRev}`} -> ${emb.modelId}@${emb.revision} ` +
        `(${KB_VECTOR_INDEX_VERSION}, ${Number(pending.n)} entries queued); keyword search keeps serving meanwhile`);
      return 'ok' as const;
    });
  }

  /** Pending drained: finish an owned rebuild and drop other models' vectors. */
  private finishDrain(emb: EmbedderLike): void {
    this.inTxn(() => {
      if (this.foreignOwnerAlive()) return;
      const mine = this.getMeta('vec_rebuild_owner') === this.owner;
      if (this.getMeta('vec_cleanup_needed') === '1') {
        const modelId = this.getMeta('vec_model_id');
        const revision = this.getMeta('vec_model_revision');
        const dims = this.getMeta('vec_dims') ?? (emb.dims !== undefined ? String(emb.dims) : null);
        if (modelId !== null && revision !== null && dims !== null) {
          const removed = this.opts.store.deleteOtherModels({ modelId, revision, dims: Number(dims) });
          this.setMeta('vec_cleanup_needed', null);
          if (removed > 0) this.log('info', `vector index: removed ${removed} vectors of previous models`);
        }
      }
      if (mine) {
        this.setMeta('vec_rebuild_owner', null);
        this.setMeta('vec_rebuild_heartbeat', null);
        this.setMeta('vec_rebuild_finished_at', new Date().toISOString());
        this.log('info', `vector index rebuild finished (${this.getMeta('vec_model_id')}@${this.getMeta('vec_model_revision')}, ${this.opts.store.count()} vectors)`);
      }
    });
  }

  private failRebuild(reason: string): void {
    try {
      this.inTxn(() => {
        if (this.getMeta('vec_rebuild_owner') !== this.owner) return;
        this.setMeta('vec_rebuild_owner', null);
        this.setMeta('vec_rebuild_heartbeat', null);
        this.setMeta('vec_rebuild_last_error', reason);
        this.log('warn', `vector index rebuild failed, will resume at the next start: ${reason}; keyword and anchor search continue`);
      });
    } catch { /* DB unusable: nothing more to record */ }
  }

  private scheduleRecheck(): void {
    if (this.recheckTimer || this.closed) return;
    this.recheckTimer = setTimeout(() => { this.recheckTimer = null; this.kick(); }, REBUILD_STALE_MS);
    this.recheckTimer.unref?.();
  }

  // -- the run ---------------------------------------------------------------

  private async run(): Promise<void> {
    try {
      this.lastStop = await this.drain();
    } catch (err) {
      this.lastStop = 'error';
      this.log('warn', `background embedding stopped: ${(err as Error)?.message ?? String(err)}; keyword and anchor search continue`);
    }
  }

  private async drain(): Promise<StopReason> {
    for (;;) {
      if (this.closed || this.opts.getDb() === null) return 'closed';
      const emb = this.source?.() ?? null;
      if (!emb) return 'unusable';
      const state = emb.state.state;
      if (state === 'disabled' || emb.modelId === null || emb.revision === null) {
        this.notice('info', 'disabled', 'embedding is disabled (embedding.model none): KB entries are not embedded; keyword and anchor search serve');
        return 'unusable';
      }
      if (state === 'failed') {
        const reason = emb.state.reason ?? 'embedder failed';
        this.notice('warn', `failed:${reason}`, `embedder unavailable, KB entries are not embedded (keyword and anchor search serve): ${reason}`);
        this.failRebuild(reason);
        return 'unusable';
      }
      const active = emb as EmbedderLike & { modelId: string; revision: string };
      if (this.ensureModel(active) === 'blocked') {
        this.scheduleRecheck();
        return 'blocked';
      }

      const db = this.db();
      const ids = (db.prepare('SELECT entry_id FROM kb_embed_pending ORDER BY entry_id LIMIT ?').all(this.batchSize) as { entry_id: string }[])
        .map(r => r.entry_id);
      if (ids.length === 0) {
        this.finishDrain(active);
        return 'drained';
      }

      const tokenLimit = active.tokenLimit ?? DEFAULT_TOKEN_LIMIT;
      const items: { id: string; inputs: VectorInput[]; hash: string }[] = [];
      for (const id of ids) {
        const inputs = this.liveInputs(id, tokenLimit);
        if (!inputs) {
          db.prepare('DELETE FROM kb_embed_pending WHERE entry_id = ?').run(id);
          continue;
        }
        items.push({ id, inputs, hash: inputsHash(inputs) });
      }
      if (items.length === 0) continue;

      const texts = items.flatMap(i => i.inputs.map(x => x.embedText));
      const vectors = await active.embedDocuments(texts);
      if (this.closed || this.opts.getDb() === null) return 'closed';
      if (!vectors || vectors.length !== texts.length) {
        const after = active.state;
        if (after.state === 'failed') {
          const reason = after.reason ?? 'embedder failed';
          this.notice('warn', `failed:${reason}`, `embedder unavailable, KB entries are not embedded (keyword and anchor search serve): ${reason}`);
          this.failRebuild(reason);
          return 'unusable';
        }
        this.log('warn', `embedding a batch of ${items.length} KB entries failed; they stay queued for the next run`);
        return 'error';
      }

      const dims = vectors[0]?.length ?? active.dims ?? 0;
      const model: VectorModel = { modelId: active.modelId, revision: active.revision, dims };
      let k = 0;
      this.inTxn(() => {
        if (this.getMeta('vec_dims') === null && dims > 0) this.setMeta('vec_dims', String(dims));
        for (const item of items) {
          const vecs = vectors.slice(k, k + item.inputs.length);
          k += item.inputs.length;
          const now = this.liveInputs(item.id, tokenLimit);
          if (!now) {
            db.prepare('DELETE FROM kb_embed_pending WHERE entry_id = ?').run(item.id);
            continue;
          }
          // Text changed while it was being embedded: leave it queued, the
          // next batch embeds the new text.
          if (inputsHash(now) !== item.hash) continue;
          this.opts.store.replaceEntryVectors(item.id, model, item.inputs.map((inp, i) => ({
            kind: inp.kind, ordinal: inp.ordinal, textHash: inp.textHash, vector: vecs[i],
          })));
          db.prepare('DELETE FROM kb_embed_pending WHERE entry_id = ?').run(item.id);
        }
        if (this.getMeta('vec_rebuild_owner') === this.owner) {
          this.setMeta('vec_rebuild_heartbeat', new Date().toISOString());
        }
      });
      if (this.getMeta('vec_rebuild_owner') === this.owner && ++this.batchesThisRebuild % PROGRESS_EVERY_BATCHES === 0) {
        const left = db.prepare('SELECT COUNT(*) AS n FROM kb_embed_pending').get() as { n: number };
        this.log('info', `vector index rebuild progress: ${Number(left.n)} entries left`);
      }
      // Yield between batches so a long rebuild never starves request handling.
      await new Promise(r => setImmediate(r));
    }
  }

  /** Inputs of a live entry, or null when the entry is gone or retired. */
  private liveInputs(id: string, tokenLimit: number): VectorInput[] | null {
    const row = this.db().prepare('SELECT superseded_at, content_hash FROM entries WHERE id = ?').get(id) as
      | { superseded_at: string | null; content_hash: string }
      | undefined;
    if (!row || row.superseded_at !== null || row.content_hash === INVALIDATED_HASH) return null;
    return this.opts.inputsFor(id, tokenLimit);
  }
}
