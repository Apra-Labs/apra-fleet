// KB vector store (design D2a, vector half): per-entry multi-vectors in
// kb.sqlite, stored as float16 BLOBs and tagged with the model that made them.
//
// Table entry_vectors: one row per (entry, model id, model revision, dims,
// vector kind, ordinal). Kinds: title_summary | cue | chunk | error | tried
// (see chunker.ts for what each holds). text_hash is the hash of the embedded
// input text, so a stale embedding (text changed while it was computed) is
// never written over a newer one.
//
// Lifecycle is driven by pure-SQL triggers on entries, the same pattern the
// keyword index uses (kb-index.ts): an insert, or an update of any embeddable
// column, enqueues the entry id into kb_embed_pending (drained off the request
// path by embed-queue.ts); retiring an entry (superseded_at set, or
// content_hash 'invalidated' from kb_invalidate by file) or deleting
// it removes its vectors. So every write path -- capture, setEntryRichFields,
// promote/demote, bible import, discard, contradiction resolution -- stays in
// lockstep without each one having to remember the vectors.
//
// Scoring is brute force over the ACTIVE model's rows only: model id,
// revision and dims must all match, so vectors from two models are never
// compared or mixed. An entry scores by its best-matching vector. No vector
// database: under 5k entries a full scan is a few milliseconds.

import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

export const VECTOR_KINDS = ['title_summary', 'cue', 'chunk', 'error', 'tried'] as const;
export type VectorKind = (typeof VECTOR_KINDS)[number];

/** Identity of the model a vector was made with; vectors of different identities never meet. */
export interface VectorModel {
  modelId: string;
  revision: string;
  dims: number;
}

export interface StoredVector {
  kind: VectorKind;
  ordinal: number;
  textHash: string;
  vector: Float32Array;
}

export interface VectorScore {
  entry_id: string;
  /** Cosine similarity of the entry's best-matching vector. */
  score: number;
  /** Which vector matched best. */
  kind: VectorKind;
  ordinal: number;
}

// ---------------------------------------------------------------------------
// float16 <-> float32
// ---------------------------------------------------------------------------

const f32Scratch = new Float32Array(1);
const u32Scratch = new Uint32Array(f32Scratch.buffer);

/** IEEE 754 binary16 bits of a number (round to nearest even; overflow -> inf). */
export function float32ToFloat16Bits(value: number): number {
  f32Scratch[0] = value;
  const x = u32Scratch[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  let mant = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant !== 0 ? 0x200 : 0); // inf / NaN
  const e = exp - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00; // too large: inf
  if (e <= 0) {
    // Subnormal half (or zero).
    if (e < -10) return sign;
    mant |= 0x800000;
    const shift = 14 - e;
    let half = mant >>> shift;
    const rem = mant & ((1 << shift) - 1);
    const halfway = 1 << (shift - 1);
    if (rem > halfway || (rem === halfway && (half & 1) !== 0)) half++;
    return sign | half;
  }
  let half = sign | (e << 10) | (mant >>> 13);
  const rem = mant & 0x1fff;
  // A carry out of the mantissa correctly bumps the exponent (up to inf).
  if (rem > 0x1000 || (rem === 0x1000 && (half & 1) !== 0)) half++;
  return half;
}

/** The number a binary16 bit pattern encodes. */
export function float16BitsToFloat32(bits: number): number {
  const sign = (bits & 0x8000) !== 0 ? -1 : 1;
  const exp = (bits >>> 10) & 0x1f;
  const mant = bits & 0x3ff;
  if (exp === 0) return sign * mant * 2 ** -24;
  if (exp === 0x1f) return mant !== 0 ? NaN : sign * Infinity;
  return sign * (1 + mant / 1024) * 2 ** (exp - 15);
}

/** Pack a vector as little-endian float16 bytes (the BLOB format). */
export function encodeFloat16(vec: Float32Array | number[]): Uint8Array {
  const out = new Uint8Array(vec.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < vec.length; i++) view.setUint16(i * 2, float32ToFloat16Bits(vec[i]), true);
  return out;
}

/** Unpack a little-endian float16 BLOB into a float32 vector. */
export function decodeFloat16(bytes: Uint8Array): Float32Array {
  const n = Math.floor(bytes.byteLength / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = float16BitsToFloat32(view.getUint16(i * 2, true));
  return out;
}

/** Cosine similarity; 0 when either vector is all zeros or the lengths differ. */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** Columns whose change makes an entry's vectors out of date (see chunker.ts). */
export const EMBEDDABLE_COLUMNS = [
  'title', 'summary', 'content', 'recall_cues', 'error_signatures', 'module', 'source_files', 'symbols', 'trigger', 'type',
] as const;

/** content_hash marker kb_invalidate (by file) writes on a retired entry. */
export const INVALIDATED_HASH = 'invalidated';
/** SQL predicate over alias e: the entry is live (neither superseded nor invalidated). */
export const LIVE_ENTRY_SQL = `e.superseded_at IS NULL AND e.content_hash != '${INVALIDATED_HASH}'`;

export class VectorStore {
  constructor(private readonly getDb: () => DatabaseSync | null) {}

  private db(): DatabaseSync {
    const db = this.getDb();
    if (!db) throw new Error('SqliteProvider not initialized. Call init() first.');
    return db;
  }

  /** Create the vector table, the embed queue table and their triggers (idempotent). */
  init(): void {
    this.db().exec(`
      CREATE TABLE IF NOT EXISTS entry_vectors (
        entry_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        model_id TEXT NOT NULL,
        model_revision TEXT NOT NULL,
        dims INTEGER NOT NULL,
        text_hash TEXT NOT NULL,
        vec BLOB NOT NULL,
        PRIMARY KEY (entry_id, model_id, model_revision, dims, kind, ordinal)
      );
      CREATE INDEX IF NOT EXISTS idx_entry_vectors_model ON entry_vectors(model_id, model_revision, dims);
      CREATE TABLE IF NOT EXISTS kb_embed_pending (
        entry_id TEXT PRIMARY KEY
      );
      CREATE TRIGGER IF NOT EXISTS entries_vec_ai AFTER INSERT ON entries BEGIN
        INSERT OR IGNORE INTO kb_embed_pending(entry_id) VALUES (new.id);
      END;
      CREATE TRIGGER IF NOT EXISTS entries_vec_au
      AFTER UPDATE OF ${EMBEDDABLE_COLUMNS.join(', ')}, superseded_at, content_hash ON entries BEGIN
        INSERT OR IGNORE INTO kb_embed_pending(entry_id) VALUES (new.id);
      END;
      CREATE TRIGGER IF NOT EXISTS entries_vec_retire
      AFTER UPDATE OF superseded_at, content_hash ON entries
      WHEN new.superseded_at IS NOT NULL OR new.content_hash = '${INVALIDATED_HASH}' BEGIN
        DELETE FROM entry_vectors WHERE entry_id = new.id;
      END;
      CREATE TRIGGER IF NOT EXISTS entries_vec_ad AFTER DELETE ON entries BEGIN
        DELETE FROM entry_vectors WHERE entry_id = old.id;
        DELETE FROM kb_embed_pending WHERE entry_id = old.id;
      END;
    `);
  }

  /** Replace every vector of `entryId` under `model` with `vectors`. */
  replaceEntryVectors(entryId: string, model: VectorModel, vectors: StoredVector[]): void {
    const db = this.db();
    db.prepare('DELETE FROM entry_vectors WHERE entry_id = ? AND model_id = ? AND model_revision = ? AND dims = ?')
      .run(entryId, model.modelId, model.revision, model.dims);
    const ins = db.prepare(
      `INSERT OR REPLACE INTO entry_vectors (entry_id, kind, ordinal, model_id, model_revision, dims, text_hash, vec)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const v of vectors) {
      if (v.vector.length !== model.dims) {
        throw new Error(`vector for ${entryId} has ${v.vector.length} dims, model ${model.modelId} has ${model.dims}`);
      }
      ins.run(entryId, v.kind, v.ordinal, model.modelId, model.revision, model.dims, v.textHash, encodeFloat16(v.vector));
    }
  }

  /** Remove every vector of an entry (all models). */
  deleteEntryVectors(entryId: string): void {
    this.db().prepare('DELETE FROM entry_vectors WHERE entry_id = ?').run(entryId);
  }

  /** Remove every vector NOT made by `model` (after a rebuild to it). Returns rows removed. */
  deleteOtherModels(model: VectorModel): number {
    const r = this.db()
      .prepare('DELETE FROM entry_vectors WHERE NOT (model_id = ? AND model_revision = ? AND dims = ?)')
      .run(model.modelId, model.revision, model.dims);
    return Number(r.changes);
  }

  /** Text hashes of an entry's vectors under `model`, keyed kind:ordinal. */
  entryTextHashes(entryId: string, model: VectorModel): Map<string, string> {
    const rows = this.db()
      .prepare('SELECT kind, ordinal, text_hash FROM entry_vectors WHERE entry_id = ? AND model_id = ? AND model_revision = ? AND dims = ?')
      .all(entryId, model.modelId, model.revision, model.dims) as { kind: string; ordinal: number; text_hash: string }[];
    return new Map(rows.map(r => [`${r.kind}:${r.ordinal}`, r.text_hash]));
  }

  /** Stored vectors of one entry, optionally limited to one model. */
  entryVectors(entryId: string, model?: VectorModel): (StoredVector & VectorModel)[] {
    const where = model ? ' AND model_id = ? AND model_revision = ? AND dims = ?' : '';
    const params: SQLInputValue[] = model ? [entryId, model.modelId, model.revision, model.dims] : [entryId];
    const rows = this.db()
      .prepare(`SELECT kind, ordinal, model_id, model_revision, dims, text_hash, vec FROM entry_vectors WHERE entry_id = ?${where} ORDER BY kind, ordinal`)
      .all(...params) as { kind: VectorKind; ordinal: number; model_id: string; model_revision: string; dims: number; text_hash: string; vec: Uint8Array }[];
    return rows.map(r => ({
      kind: r.kind,
      ordinal: Number(r.ordinal),
      textHash: r.text_hash,
      vector: decodeFloat16(r.vec),
      modelId: r.model_id,
      revision: r.model_revision,
      dims: Number(r.dims),
    }));
  }

  /** Row count, optionally for one model. */
  count(model?: VectorModel): number {
    const row = model
      ? this.db().prepare('SELECT COUNT(*) AS n FROM entry_vectors WHERE model_id = ? AND model_revision = ? AND dims = ?')
        .get(model.modelId, model.revision, model.dims)
      : this.db().prepare('SELECT COUNT(*) AS n FROM entry_vectors').get();
    return Number((row as { n: number }).n);
  }

  /**
   * Score live entries against `query` using ONLY `model`'s vectors (id,
   * revision and dims all match; nothing else is ever read). An entry's score
   * is its best vector's cosine. Sorted best first; `limit` caps the result.
   */
  score(query: Float32Array, model: VectorModel, opts: { limit?: number; entryIds?: string[] } = {}): VectorScore[] {
    if (query.length !== model.dims) return [];
    const params: SQLInputValue[] = [model.modelId, model.revision, model.dims];
    let idFilter = '';
    if (opts.entryIds) {
      if (opts.entryIds.length === 0) return [];
      idFilter = ` AND v.entry_id IN (${opts.entryIds.map(() => '?').join(',')})`;
      params.push(...opts.entryIds);
    }
    const rows = this.db().prepare(`
      SELECT v.entry_id, v.kind, v.ordinal, v.vec
      FROM entry_vectors v
      JOIN entries e ON e.id = v.entry_id
      WHERE v.model_id = ? AND v.model_revision = ? AND v.dims = ?
        AND ${LIVE_ENTRY_SQL}${idFilter}
    `).all(...params) as { entry_id: string; kind: VectorKind; ordinal: number; vec: Uint8Array }[];
    const best = new Map<string, VectorScore>();
    for (const r of rows) {
      const s = cosine(query, decodeFloat16(r.vec));
      const prev = best.get(r.entry_id);
      if (!prev || s > prev.score) best.set(r.entry_id, { entry_id: r.entry_id, score: s, kind: r.kind, ordinal: Number(r.ordinal) });
    }
    const out = [...best.values()].sort((a, b) => b.score - a.score || a.entry_id.localeCompare(b.entry_id));
    return opts.limit !== undefined ? out.slice(0, Math.max(0, opts.limit)) : out;
  }
}
