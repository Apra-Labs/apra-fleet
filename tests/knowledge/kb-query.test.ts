import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { kbQuery } from '../../src/tools/kb-query.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';
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

  it('tag filter returns only entries whose tags array contains the value (json_each)', async () => {
    await provider.capture(makeInput({
      title: 'Tagged registry entry', tags: ['sprint:kb-inflight-capture', 'phase:1'],
      symbols: ['symQueryTagged'],
    }));
    await provider.capture(makeInput({
      title: 'Untagged registry entry', tags: ['other-tag'],
      symbols: ['symQueryUntagged'],
    }));

    const result = await provider.query({ query: 'registry', tag: 'sprint:kb-inflight-capture' });
    expect(result.results.length).toBe(1);
    expect(result.results[0].title).toBe('Tagged registry entry');
  });

  it('no tag -> unchanged behavior (both entries returned)', async () => {
    await provider.capture(makeInput({ title: 'Registry entry alpha', tags: ['a'], symbols: ['symQueryAlpha'] }));
    await provider.capture(makeInput({ title: 'Registry entry beta', tags: ['b'], symbols: ['symQueryBeta'] }));

    const result = await provider.query({ query: 'registry' });
    const titles = result.results.map(r => r.title);
    expect(titles).toContain('Registry entry alpha');
    expect(titles).toContain('Registry entry beta');
  });

  it('tag + type filter compose (AND, not FTS)', async () => {
    await provider.capture(makeInput({
      title: 'Compose knowledge registry', type: 'knowledge', tags: ['sprint:z'],
      symbols: ['symQueryComposeK'],
    }));
    await provider.capture(makeInput({
      title: 'Compose cache registry', type: 'context-cache', tags: ['sprint:z'],
      symbols: ['symQueryComposeC'], source_files: ['src/cache2.ts'],
    }));
    await provider.capture(makeInput({
      title: 'Compose other tag registry', type: 'knowledge', tags: ['sprint:other'],
      symbols: ['symQueryComposeO'],
    }));

    const result = await provider.query({ query: 'registry', type: 'knowledge', tag: 'sprint:z' });
    expect(result.results.length).toBe(1);
    expect(result.results[0].title).toBe('Compose knowledge registry');
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

describe('kb_query tool', () => {
  beforeEach(() => {
    vi.spyOn(kbProvidersModule, 'getKbProviders').mockResolvedValue({
      project: provider,
      global: provider,
      projectSlug: 'test',
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('tag filter returns only tagged entries', async () => {
    await provider.capture(makeInput({
      title: 'Tool tagged registry entry', tags: ['sprint:kb-inflight-capture', 'phase:1'],
      symbols: ['symToolQueryTagged'],
    }));
    await provider.capture(makeInput({
      title: 'Tool untagged registry entry', tags: ['other'],
      symbols: ['symToolQueryUntagged'],
    }));

    const parsed = JSON.parse(await kbQuery({ query: 'registry', tag: 'sprint:kb-inflight-capture' }));
    const titles = parsed.l1_results.map((e: any) => e.title);
    expect(titles).toContain('Tool tagged registry entry');
    expect(titles).not.toContain('Tool untagged registry entry');
  });

  it('no tag -> unchanged behavior', async () => {
    await provider.capture(makeInput({ title: 'Tool no-tag alpha', symbols: ['symToolQueryAlpha'] }));

    const parsed = JSON.parse(await kbQuery({ query: 'registry' }));
    const titles = parsed.l1_results.map((e: any) => e.title);
    expect(titles).toContain('Tool no-tag alpha');
  });

  it('tag + type filter compose', async () => {
    await provider.capture(makeInput({
      title: 'Tool compose knowledge registry', type: 'knowledge', tags: ['sprint:z'],
      symbols: ['symToolQueryComposeK'],
    }));
    await provider.capture(makeInput({
      title: 'Tool compose other-tag knowledge registry', type: 'knowledge', tags: ['sprint:other'],
      symbols: ['symToolQueryComposeO'],
    }));

    const parsed = JSON.parse(await kbQuery({ query: 'registry', type: 'knowledge', tag: 'sprint:z' }));
    const titles = parsed.l1_results.map((e: any) => e.title);
    expect(titles).toContain('Tool compose knowledge registry');
    expect(titles).not.toContain('Tool compose other-tag knowledge registry');
  });

  it('tag-only call (no query) is accepted and returns only tagged entries', async () => {
    // HIGH-1: the KB Agent curator's Step 2 is kb_query({ tag: 'phase:<n>' })
    // with NO free-text query -- the tool guard must let it through to the
    // provider's plain (non-FTS) branch.
    await provider.capture(makeInput({
      title: 'Tag-only phase capture', tags: ['sprint:kb-inflight-capture', 'phase:1'],
      symbols: ['symTagOnlyA'],
    }));
    await provider.capture(makeInput({
      title: 'Tag-only unrelated entry', tags: ['other'],
      symbols: ['symTagOnlyB'],
    }));

    const parsed = JSON.parse(await kbQuery({ tag: 'phase:1' }));
    const titles = parsed.l1_results.map((e: any) => e.title);
    expect(titles).toContain('Tag-only phase capture');
    expect(titles).not.toContain('Tag-only unrelated entry');
    // Tags array must be present so the curator can intersect sprint + phase
    const entry = parsed.l1_results.find((e: any) => e.title === 'Tag-only phase capture');
    expect(entry.tags).toContain('sprint:kb-inflight-capture');
  });

  it('call with no query, no flagged_only, and no tag still errors as before', async () => {
    await expect(kbQuery({})).rejects.toThrow(/query|tag|flagged_only/);
  });
});
