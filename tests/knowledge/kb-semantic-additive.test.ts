import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { BUILTIN_EMBEDDING_PROFILES, DEFAULT_EMBEDDING_PROFILE } from '../../src/services/knowledge/embedding/profiles.js';
import type { EmbedderLike } from '../../src/services/knowledge/embedding/embed-queue.js';
import { hashedBagOfWords } from '../helpers/fake-embedder.js';

// D2f additive rule 1: the semantic list is built from opts.query and
// error_text only, never from fts_terms. kb_session_prime (hint_symbols +
// hint_modules -> fts_terms) and a plain fts_terms read must therefore return
// exactly the same rows with a ready embedder as without one.
//
// Uses a REAL identifier bag shaped like the judge's examples, against a KB
// whose entries share vocabulary with those identifiers, and the real
// per-model floor of the default model (same real-like embedder as
// kb-semantic-floor.test.ts: shared BASELINE direction).
//
// Falsifiability: checked by temporarily restoring the old
// `semanticText = [queryText, errorText]` in SqliteProvider.hybridRows
// (queryText falls back to fts_terms): the prime and fts_terms tests then
// fail (extra semantic-only rows). The control below shows opts.query text
// does reach the semantic list, so the test is not vacuous.
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
// Judge-shaped identifier bag. The dotted symbols AND-join in FTS, so an
// entry carrying only the second half is invisible to keyword search but
// shares embedding tokens with the bag.
const HINT_SYMBOLS = ['Dispatch.isNonRetryableDispatchError', 'Delivery.secret_delivery_unavailable'];
const HINT_MODULES = ['ERROR_NOT_ENOUGH_MEMORY'];

let tmp: string;
let n = 0;
let p: SqliteProvider;

beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-semantic-additive-')); });
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  p = new SqliteProvider(path.join(tmp, `kb-${n++}.sqlite`));
  await p.init();
  const entries = [
    // Keyword-visible (exact dotted match).
    { title: 'Dispatch.isNonRetryableDispatchError classification', summary: 'Dispatch.isNonRetryableDispatchError decides retry', symbols: ['Dispatch.isNonRetryableDispatchError'] },
    { title: 'Dispatch.isNonRetryableError classification', summary: 'Dispatch.isNonRetryableError decides retry', symbols: ['Dispatch.isNonRetryableError'] },
    // Semantic-only candidates: share identifier tokens, not the FTS AND terms.
    { title: 'isNonRetryableDispatchError retry notes', summary: 'isNonRetryableDispatchError secret_delivery_unavailable ERROR_NOT_ENOUGH_MEMORY', symbols: ['Other.thing'] },
    { title: 'secret_delivery_unavailable handling', summary: 'secret_delivery_unavailable isNonRetryableDispatchError retry', symbols: ['Other.other'] },
    // Semantic-only for the single-symbol hint below: lacks the "Dispatch" half of the FTS AND.
    // The identifier sits only in content (not title/summary/symbols), which
    // neither the keyword nor the trigram index covers but the embedding sees.
    { title: 'Classifier notes', summary: 'classifier notes', content: 'isNonRetryableError retry', symbols: ['Other.third'] },
    { title: 'Unrelated parser notes', summary: 'parser recovers after a bad token', symbols: ['Parser.recover'] },
  ];
  for (const e of entries) {
    await p.capture({
      type: 'learning', content: e.summary, ...(e as { content?: string }), source_files: ['src/a.ts'], tags: [], content_hash: '', content_hash_type: 'sha256',
      flagged_for_review: false, author: 'additive-test', source: 'doer', confidence: 'INFERRED', ...e,
    });
  }
});
afterEach(() => { p.close(); vi.restoreAllMocks(); });

async function attach(): Promise<void> {
  p.attachEmbedder(() => new RealLikeEmbedder());
  expect(await p.waitForEmbeddings(10_000)).toBe(true);
}
const queryIds = async (o: Record<string, unknown>) =>
  (await p.query({ confidence: [...ALL_TIERS], limit: 20, ...o })).results.map(e => e.id);
const primeIds = async (o: Record<string, unknown>) =>
  (await p.prime({ confidence: [...ALL_TIERS], ...o })).top_entries.map(e => e.id);

describe('fts_terms never feed the semantic list (D2f additive)', () => {
  it('control: the same text as opts.query DOES produce a semantic-backed row with the model ready', async () => {
    const text = [...HINT_SYMBOLS, ...HINT_MODULES].join(' ');
    await attach();
    const after = await queryIds({ query: text, disable_lists: ['keyword'] });
    expect(after.length).toBeGreaterThan(0);
  });

  it('kb_session_prime returns the same ids in the same order with the embedder ready as without', async () => {
    const o = { hint_symbols: HINT_SYMBOLS, hint_modules: HINT_MODULES };
    const before = await primeIds(o);
    expect(before.length).toBeGreaterThan(0); // keyword-visible entry present
    await attach();
    expect(await primeIds(o)).toEqual(before);
  });

  it('a fts_terms-only read is identical with and without the embedder (rows found, and 0 stays 0)', async () => {
    const terms = [...HINT_SYMBOLS, ...HINT_MODULES];
    const withKeywordHits = await queryIds({ fts_terms: terms });
    const noKeywordHits = await queryIds({ fts_terms: ['Nope.never_seen_anywhere', 'isNonRetryableDispatchError_x'] });
    expect(noKeywordHits).toEqual([]);
    await attach();
    expect(await queryIds({ fts_terms: terms })).toEqual(withKeywordHits);
    expect(await queryIds({ fts_terms: ['Nope.never_seen_anywhere', 'isNonRetryableDispatchError_x'] })).toEqual([]);
  });

  it('use_count is not bumped for rows only a semantic list would have added', async () => {
    const o = { hint_symbols: ['Dispatch.isNonRetryableError'] };
    await attach();
    const ids = await primeIds(o);
    expect(ids.length).toBeGreaterThan(0);
    const db = (p as unknown as { getDb(): { prepare(q: string): { get(...a: string[]): { id: string; use_count: number } } } }).getDb();
    const sem = db.prepare('SELECT id, use_count FROM entries WHERE title = ?').get('Classifier notes');
    expect(ids).not.toContain(sem.id);
    expect(sem.use_count).toBe(0);
    // Control: as opts.query the same symbol DOES return that row (semantic list, keyword off).
    expect(await queryIds({ query: o.hint_symbols[0], disable_lists: ['keyword'] })).toContain(sem.id);
  });
});
