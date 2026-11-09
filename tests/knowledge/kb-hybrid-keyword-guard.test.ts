import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import {
  guardKeywordTop, hybridOrder, ranksFromOrder, reciprocalRankFusion, KEYWORD_GUARD_KEEP, KEYWORD_GUARD_WITHIN,
  type RankedList,
} from '../../src/services/knowledge/hybrid-rank.js';
import { FakeEmbedder } from '../helpers/fake-embedder.js';

// D2f additive rule 2: every id in the keyword list's top 5 keeps a place in
// the first 8 of the hybrid order (the pushed block size).
//
// Falsifiability (both checked by hand): removing the guardKeywordTop call
// from SqliteProvider.hybridRows makes the integration case fail (the five
// keyword-only hits sort below the eight anchor+semantic rows, so limit 8
// returns none of them); making guardKeywordTop return its input makes the
// unit case fail (the target stays at position >= 8).
//
// Isolation: every file lives under one mkdtemp dir removed in afterAll.

describe('guardKeywordTop (pure)', () => {
  const others = Array.from({ length: 8 }, (_, i) => `o${i + 1}`);
  const kw = ['k1', 'k2', 'k3', 'k4', 'k5'];

  it('judge shape: keyword rank 5 / semantic rank 47 lands at ~10 under plain RRF, inside the top 8 after the guard', () => {
    const fillers = Array.from({ length: 38 }, (_, i) => `f${i + 1}`);
    const semanticOrder = [...others, ...fillers, 'k5']; // k5 is semantic rank 47
    expect(semanticOrder.indexOf('k5') + 1).toBe(47);
    const lists: RankedList[] = [
      { name: 'keyword', ranks: ranksFromOrder(kw) },
      { name: 'semantic', ranks: ranksFromOrder(semanticOrder) },
      { name: 'anchor', ranks: ranksFromOrder(others) },
    ];
    const order = hybridOrder(reciprocalRankFusion(lists), () => 1, kw);
    expect(order.indexOf('k5')).toBeGreaterThanOrEqual(KEYWORD_GUARD_WITHIN); // pushed out without the guard
    const guarded = guardKeywordTop(order, kw);
    const head = guarded.slice(0, KEYWORD_GUARD_WITHIN);
    for (const id of kw) expect(head, id).toContain(id);
    // Same ids overall; rows not moved keep their relative order.
    expect([...guarded].sort()).toEqual([...order].sort());
    const moved = new Set(kw);
    expect(guarded.filter(id => !moved.has(id))).toEqual(order.filter(id => !moved.has(id)));
  });

  it('returns the input order unchanged when every keyword top-5 id is already within the first 8', () => {
    const order = ['a', 'k1', 'b', 'k2', 'k3', 'c', 'k4', 'k5', 'd', 'e'];
    expect(guardKeywordTop(order, kw)).toEqual(order);
  });

  it('moves one outside id to the lowest non-guarded slot in the window and shifts the rest down', () => {
    const order = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'k1'];
    expect(guardKeywordTop(order, ['k1'])).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'k1', 'h', 'i']);
  });

  it('ignores keyword ids absent from the order, and keyword ids ranked below the top 5', () => {
    const order = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'x'];
    expect(guardKeywordTop(order, ['gone'])).toEqual(order);
    expect(guardKeywordTop(order, ['q1', 'q2', 'q3', 'q4', 'q5', 'x'])).toEqual(order);
    expect(KEYWORD_GUARD_KEEP).toBe(5);
  });
});

const ALL_TIERS = ['CONFIRMED', 'INFERRED', 'UNVERIFIED'];
let tmp: string;
let n = 0;
let p: SqliteProvider;

beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-keyword-guard-')); });
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  p = new SqliteProvider(path.join(tmp, `kb-${n++}.sqlite`));
  await p.init();
});
afterEach(() => { p.close(); vi.restoreAllMocks(); });

async function put(title: string, summary: string, source: string): Promise<string> {
  const e = await p.capture({
    type: 'learning', title, summary, content: summary, source_files: [source], symbols: [], tags: [],
    content_hash: '', content_hash_type: 'sha256', flagged_for_review: false, author: 'guard-test',
    source: 'doer', confidence: 'INFERRED',
  });
  return (e as { id: string }).id;
}

describe('SqliteProvider.query keyword top-5 guard (integration)', () => {
  it('keeps all five keyword-only hits in the returned 8 even when eight anchor+semantic rows outrank them', async () => {
    for (let i = 1; i <= 5; i++) await put(`zebra stripes note ${i}`, `zebra note ${i}`, 'src/kw.ts');
    for (let i = 1; i <= 8; i++) await put(`quokka burrow ${i}`, `quokka burrow ${i}`, 'src/hot.ts');

    // Keyword-only reference (no embedder, no anchors): the keyword top 5.
    const kwTop = (await p.query({ query: 'zebra', confidence: [...ALL_TIERS], limit: 8 })).results.map(e => e.id);
    expect(kwTop).toHaveLength(5);

    const emb = new FakeEmbedder('acme/guard-model', 'r1', 64);
    p.attachEmbedder(() => emb);
    expect(await p.waitForEmbeddings(10_000)).toBe(true);
    const ids = (await p.query({
      query: 'zebra', error_text: 'quokka burrow', anchor_files: ['src/hot.ts'],
      semantic_floor: -Infinity, confidence: [...ALL_TIERS], limit: 8,
    })).results.map(e => e.id);
    expect(ids).toHaveLength(8);
    for (const id of kwTop) expect(ids, id).toContain(id);
  });
});
