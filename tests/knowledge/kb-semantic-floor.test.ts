import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import {
  BUILTIN_EMBEDDING_PROFILES, DEFAULT_EMBEDDING_PROFILE, SEMANTIC_FLOORS, semanticFloorFor, resolveEmbeddingModel,
} from '../../src/services/knowledge/embedding/profiles.js';
import type { EmbedderLike } from '../../src/services/knowledge/embedding/embed-queue.js';
import { hashedBagOfWords } from '../helpers/fake-embedder.js';

// Semantic similarity floor in hybrid kb_query ranking. A dense model gives
// every text some similarity to every entry (with the real default model,
// snowflake-arctic-embed-xs, a gibberish query's best match on the eval KB
// scores 0.45-0.62 cosine), so without a floor a nonsense query, or
// kb_session_prime with a symbol the KB has never heard of, returned the
// least-unrelated entries where keyword search returns nothing.
//
// The embedder here is deterministic but shaped like the real model: every
// vector shares a common direction (weight BASELINE), so two texts with no
// word in common still score about BASELINE (~0.5, like the real model's
// unrelated pairs), and texts sharing words score well above the floor. It
// reports the default model's id and revision, so the REAL per-model floor
// from profiles.ts applies -- nothing in this file sets the floor.
//
// Falsifiability: with the floor off (QueryOptions.semantic_floor -Infinity,
// the eval override) the same nonsense queries return rows -- asserted below
// -- so removing the floor filter from SqliteProvider.hybridRows fails the
// zero-row assertions.
//
// Isolation: every file lives under one mkdtemp dir removed in afterAll.

const PROFILE = BUILTIN_EMBEDDING_PROFILES[DEFAULT_EMBEDDING_PROFILE];
const DIMS = 384;
const BASELINE = 0.5;

function realLikeVector(text: string): Float32Array {
  const bag = hashedBagOfWords(text, DIMS - 1, 'real-like');
  const v = new Float32Array(DIMS);
  v[0] = Math.sqrt(BASELINE);
  const w = Math.sqrt(1 - BASELINE);
  for (let i = 0; i < DIMS - 1; i++) v[i + 1] = w * bag[i];
  return v;
}

class RealLikeEmbedder implements EmbedderLike {
  readonly modelId = PROFILE.modelId;
  readonly revision = PROFILE.revision;
  readonly dims = DIMS;
  readonly tokenLimit = 512;
  readonly state = { state: 'ready' };
  async embedDocuments(texts: string[]): Promise<Float32Array[]> { return texts.map(realLikeVector); }
  async embedQuery(text: string): Promise<Float32Array> { return realLikeVector(text); }
}

const ALL_TIERS = ['CONFIRMED', 'INFERRED', 'UNVERIFIED'] as const;
const NONSENSE = ['qwzx plorbt vandersnoot', 'purple elephant banana spaceship', 'recipe for chocolate cake'];
const UNKNOWN_SYMBOL = 'QuxbarFrobnicator.glorpify';

let tmp: string;
let n = 0;
let p: SqliteProvider;

beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-semantic-floor-')); });
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  p = new SqliteProvider(path.join(tmp, `kb-${n++}.sqlite`));
  await p.init();
  const entries = [
    { title: 'Widget cache eviction policy', summary: 'how the widget cache evicts stale entries', symbols: ['WidgetCache.evict'] },
    { title: 'Retry the flaky upload', summary: 'upload retries with exponential backoff', symbols: ['Uploader.send'] },
    { title: 'Session token refresh', summary: 'refresh the session token before it expires', symbols: ['TokenStore.refresh'] },
    { title: 'Parser recovery notes', summary: 'parser recovers after a bad token', symbols: ['Parser.recover'] },
  ];
  for (const e of entries) {
    await p.capture({
      type: 'learning', content: e.summary, source_files: ['src/a.ts'], tags: [], content_hash: '', content_hash_type: 'sha256',
      flagged_for_review: false, author: 'floor-test', source: 'doer', confidence: 'INFERRED', ...e,
    });
  }
});
afterEach(() => {
  p.close();
  vi.restoreAllMocks();
});

async function attach(): Promise<void> {
  p.attachEmbedder(() => new RealLikeEmbedder());
  expect(await p.waitForEmbeddings(10_000)).toBe(true);
}

const queryIds = async (o: Record<string, unknown>) =>
  (await p.query({ confidence: [...ALL_TIERS], limit: 20, ...o })).results.map(e => e.id);

describe('semantic similarity floor', () => {
  it('every built-in profile carries its floor from SEMANTIC_FLOORS; lookup is by model id and revision', () => {
    for (const [name, prof] of Object.entries(BUILTIN_EMBEDDING_PROFILES)) {
      expect(prof.semanticFloor, name).toBe(SEMANTIC_FLOORS[name]);
      expect(semanticFloorFor(prof.modelId, prof.revision)).toBe(SEMANTIC_FLOORS[name]);
    }
    // The fake's unrelated-pair similarity sits below the real default floor.
    expect(BASELINE + 0.05).toBeLessThan(SEMANTIC_FLOORS[DEFAULT_EMBEDDING_PROFILE]);
    // Unknown model, or a pinned model at another revision: no floor.
    expect(semanticFloorFor('acme/other', 'r1')).toBe(Number.NEGATIVE_INFINITY);
    expect(semanticFloorFor(PROFILE.modelId, 'other-revision')).toBe(Number.NEGATIVE_INFINITY);
    // A custom model: none unless its config sets semantic_floor.
    const warn = vi.fn();
    const custom = resolveEmbeddingModel({ id: 'acme/custom', semantic_floor: 0.42 }, warn);
    expect(custom.kind === 'enabled' && custom.profile.semanticFloor).toBe(0.42);
    const plain = resolveEmbeddingModel({ id: 'acme/custom' }, warn);
    expect(plain.kind === 'enabled' && plain.profile.semanticFloor).toBeUndefined();
    if (custom.kind === 'enabled') expect(semanticFloorFor('acme/custom', 'main', custom.profile)).toBe(0.42);
    expect(warn).not.toHaveBeenCalled();
    resolveEmbeddingModel({ id: 'acme/custom', semantic_floor: 3 }, warn);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/semantic_floor/));
  });

  it('a nonsense query returns 0 rows from kb_query with the model loaded (and rows with the floor off)', async () => {
    for (const q of NONSENSE) expect(await queryIds({ query: q }), q).toEqual([]);
    await attach();
    for (const q of NONSENSE) {
      expect(await queryIds({ query: q }), q).toEqual([]);
      // Falsifiability: the fake gives unrelated text real-model-like nonzero
      // similarity, so without the floor the semantic list fills the result.
      expect((await queryIds({ query: q, semantic_floor: Number.NEGATIVE_INFINITY })).length, q).toBeGreaterThan(0);
    }
  });

  it('a query with only an unknown fts_terms symbol returns 0 rows', async () => {
    expect(await queryIds({ fts_terms: [UNKNOWN_SYMBOL] })).toEqual([]);
    await attach();
    expect(await queryIds({ fts_terms: [UNKNOWN_SYMBOL] })).toEqual([]);
    expect((await queryIds({ fts_terms: [UNKNOWN_SYMBOL], semantic_floor: Number.NEGATIVE_INFINITY })).length).toBeGreaterThan(0);
  });

  it('kb_session_prime with an unknown hint symbol returns the same as before embeddings', async () => {
    const primeIds = async () => (await p.prime({ hint_symbols: [UNKNOWN_SYMBOL], confidence: [...ALL_TIERS] })).top_entries.map(e => e.id);
    const before = await primeIds();
    await attach();
    expect(await primeIds()).toEqual(before);
  });

  it('related text still clears the floor: a keyword-free paraphrase is found by the semantic list', async () => {
    await attach();
    // Same words as the entry, keyword list off: only vectors can find it.
    const ids = await queryIds({ query: 'session token refresh before it expires', disable_lists: ['keyword'] });
    expect(ids.length).toBeGreaterThan(0);
    const top = (await p.query({ query: 'session token refresh before it expires', confidence: [...ALL_TIERS], disable_lists: ['keyword'] })).results[0];
    expect(top.title).toBe('Session token refresh');
  });
});
