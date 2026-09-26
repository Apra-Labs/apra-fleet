import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';

/**
 * KB audit 2026-08-11, retrieval telemetry.
 *
 * query() has always bumped use_count/last_accessed for what it returns ("
 * retrieval means relevance"), but an entry handed to an agent from the
 * canonical-bible cold-seed never went through query() -- it was parsed out of
 * a JSON file. Since the sprint engine primes without hints, the bible is the
 * ONLY thing it delivers, so every delivery was invisible: 0 of 23 entries in
 * the apra-fleet KB carried a use_count while entries were genuinely being
 * handed out, and kb_stats.retrieval.hit_rate read 0 for all three repos.
 *
 * touch() closes that gap. It is the write half of "delivery is retrieval", and
 * is deliberately id-scoped and existence-tolerant: a bible carries entries
 * exported from ANOTHER machine's KB, so an id that is not local is normal, not
 * an error.
 */

function makeInput(overrides: Partial<KBEntryInput> = {}): KBEntryInput {
  return {
    type: 'knowledge',
    title: 'Registry initialization behavior',
    summary: 'How the registry init works at startup.',
    content: 'The registry initializes lazily on first access via getOrCreate().',
    source_files: ['src/services/registry.ts'],
    symbols: ['initRegistry'],
    tags: [],
    content_hash: '',
    content_hash_type: 'sha256',
    flagged_for_review: false,
    author: 'test-agent',
    source: 'doer',
    confidence: 'INFERRED',
    ...overrides,
  };
}

let provider: SqliteProvider;

beforeEach(async () => {
  provider = new SqliteProvider(':memory:');
  await provider.init();
});

afterEach(() => {
  provider.close();
});

async function useCountOf(id: string): Promise<number> {
  return (await provider.list({})).find(e => e.id === id)!.use_count;
}

describe('SqliteProvider.touch (delivery telemetry)', () => {
  it('bumps use_count and stamps last_accessed for the ids it is given', async () => {
    const { id } = await provider.capture(makeInput());
    expect(await useCountOf(id)).toBe(0);

    const before = new Date().toISOString();
    const touched = await provider.touch([id]);

    expect(touched).toBe(1);
    expect(await useCountOf(id)).toBe(1);
    const entry = (await provider.list({})).find(e => e.id === id)!;
    expect(entry.last_accessed).toBeDefined();
    expect(entry.last_accessed! >= before).toBe(true);
  });

  it('is additive across calls -- two deliveries count as two', async () => {
    const { id } = await provider.capture(makeInput());

    await provider.touch([id]);
    await provider.touch([id]);

    expect(await useCountOf(id)).toBe(2);
  });

  it('ignores ids that are not in this KB -- a bible carries other machines\' ids', async () => {
    const { id } = await provider.capture(makeInput());

    const touched = await provider.touch([id, 'not-a-local-id', 'nor-this-one']);

    expect(touched).toBe(1);
    expect(await useCountOf(id)).toBe(1);
  });

  it('an empty id list is a no-op', async () => {
    expect(await provider.touch([])).toBe(0);
  });

  it('feeds kb_stats.retrieval, which is the number the audit read as zero', async () => {
    const { id } = await provider.capture(makeInput());
    const cold = await provider.stats();
    expect(cold.retrieval.entries_retrieved).toBe(0);
    expect(cold.retrieval.hit_rate).toBe(0);

    await provider.touch([id]);

    const warm = await provider.stats();
    expect(warm.retrieval.entries_retrieved).toBe(1);
    expect(warm.retrieval.total_uses).toBe(1);
    expect(warm.retrieval.hit_rate).toBe(1);
  });
});
