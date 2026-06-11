import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';

function makeInput(overrides: Partial<KBEntryInput> = {}): KBEntryInput {
  return {
    type: 'knowledge',
    title: 'Registry initialization behavior',
    summary: 'How the registry init works at startup.',
    content: 'The registry initializes lazily on first access via getOrCreate(). It caches resolved instances in a Map keyed by provider name.',
    source_files: ['src/services/registry.ts'],
    symbols: ['initRegistry', 'getOrCreate'],
    tags: ['registry', 'init'],
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

describe('kb_query', () => {
  it('basic query returns L1 results', async () => {
    await provider.capture(makeInput());

    const result = await provider.query({
      query: 'registry initialization',
      l1_only: true,
    });

    expect(result.results.length).toBeGreaterThan(0);
    expect(result.l1_only).toBe(true);
    expect(result.results[0].content).toBe('');
  });

  it('type filter works (knowledge vs context-cache)', async () => {
    await provider.capture(makeInput({ type: 'knowledge' }));
    await provider.capture(makeInput({
      type: 'context-cache',
      title: 'Context cache for registry',
      summary: 'File context cache.',
      content: 'Cached content of registry.ts',
      symbols: ['cacheHelper'],
      source_files: ['src/cache.ts'],
    }));

    const knowledgeOnly = await provider.query({
      query: 'registry',
      type: 'knowledge',
    });
    expect(knowledgeOnly.results.every(r => r.type === 'knowledge')).toBe(true);

    const cacheOnly = await provider.query({
      query: 'registry',
      type: 'context-cache',
    });
    expect(cacheOnly.results.every(r => r.type === 'context-cache')).toBe(true);
  });

  it('stale entry excluded by default', async () => {
    await provider.capture(makeInput({
      type: 'context-cache',
      title: 'Context cache for registry init',
      content: 'Registry file content cached for context.',
      source_files: ['src/services/registry.ts'],
      content_hash: 'somehash',
      content_hash_type: 'git',
    }));

    await provider.invalidate(['src/services/registry.ts']);

    const result = await provider.query({
      query: 'registry',
    });
    expect(result.results).toHaveLength(0);

    const withStale = await provider.query({
      query: 'registry',
      include_stale: true,
    });
    expect(withStale.results.length).toBeGreaterThan(0);
  });

  it('superseded entry excluded by default', async () => {
    const first = await provider.capture(makeInput());

    // Capture an update to supersede the first entry
    const updated = makeInput({
      content: 'The registry now initializes eagerly at startup.',
    });
    await provider.capture(updated);

    const result = await provider.query({ query: 'registry' });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].id).not.toBe(first.id);
  });

  it('L2 expansion returns full content for top 5 only', async () => {
    const entries: string[] = [];
    for (let i = 0; i < 8; i++) {
      const { id } = await provider.capture(makeInput({
        title: `Entry number ${i} about registry patterns`,
        summary: `Summary ${i} about registry patterns and initialization.`,
        content: `Full detailed content for entry ${i}. `.repeat(20),
        symbols: [`func${i}`],
        source_files: [`src/file${i}.ts`],
      }));
      entries.push(id);
    }

    // L1 query
    const l1 = await provider.query({
      query: 'registry patterns',
      l1_only: true,
      limit: 20,
    });
    expect(l1.results.length).toBeGreaterThanOrEqual(5);

    // L2 expand top 5
    const top5Ids = l1.results.slice(0, 5).map(e => e.id);
    const l2 = await provider.query({ ids: top5Ids });
    expect(l2.results).toHaveLength(5);
    for (const entry of l2.results) {
      expect(entry.content.length).toBeGreaterThan(0);
    }
  });
});
