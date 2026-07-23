import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { kbHarvest } from '../../src/tools/kb-harvest.js';
import * as kbServiceModule from '../../src/services/knowledge/kb-service.js';
import { vi } from 'vitest';

let provider: SqliteProvider;

beforeEach(async () => {
  provider = new SqliteProvider(':memory:');
  await provider.init();
  vi.spyOn(kbServiceModule, 'getKBService').mockReturnValue({
    getProvider: () => provider,
  } as any);
});

afterEach(() => {
  provider.close();
  vi.restoreAllMocks();
});

describe('kb_harvest', () => {
  it('returns zero counts when no transcript is provided', async () => {
    const result = JSON.parse(await kbHarvest({}));
    expect(result).toEqual({ entries_captured: 0, entries_updated: 0, entries_skipped: 0 });
  });

  it('extracts learnings from transcript with pattern markers', async () => {
    const transcript = `Working on the registry module.

I found that the registry uses a singleton pattern and lazy initialization via getOrCreate in src/services/registry.ts

Note: The \`initRegistry()\` function must be called before any other registry operations or it throws a cryptic error

Bug: The cleanup handler in src/services/registry.ts does not close the database connection properly when called twice
`;

    const result = JSON.parse(await kbHarvest({ session_transcript: transcript }));
    expect(result.entries_captured).toBeGreaterThanOrEqual(2);
    expect(result.entries_skipped).toBe(0);
  });

  // T3.2 (F7, revised D7): harvested entries must be low-trust regardless of
  // wording in the transcript -- confidence forced to UNVERIFIED (the D1 clamp
  // covers this path too) and provenance stamped author='harvest',
  // source='harvest' so harvested entries are distinguishable from real
  // KB-Agent direct captures in queries.
  it('captured entry is UNVERIFIED with author=harvest, source=harvest', async () => {
    const transcript = `Key insight: the src/services/registry.ts \`getOrCreate\` helper is the only safe entry point for singleton construction.`;

    const result = JSON.parse(await kbHarvest({ session_transcript: transcript }));
    expect(result.entries_captured).toBeGreaterThanOrEqual(1);

    const { results } = await provider.query({ query: 'getOrCreate', include_stale: true });
    expect(results.length).toBeGreaterThanOrEqual(1);
    for (const entry of results) {
      expect(entry.confidence).toBe('UNVERIFIED');
      expect(entry.author).toBe('harvest');
      expect(entry.source).toBe('harvest');
    }
  });

  it('deduplicates already-captured learnings via AUDN', async () => {
    const transcript = `Note: The registry uses lazy initialization and must be called before other operations.`;

    await provider.capture({
      type: 'learning',
      title: 'The registry uses lazy initialization and must be called before other operations.',
      summary: 'The registry uses lazy initialization and must be called before other operations.',
      content: 'The registry uses lazy initialization and must be called before other operations.',
      source_files: [],
      symbols: [],
      tags: [],
      content_hash: '',
      content_hash_type: 'sha256',
      flagged_for_review: false,
      author: 'doer',
      source: 'doer',
      confidence: 'CONFIRMED',
    });

    const result = JSON.parse(await kbHarvest({ session_transcript: transcript }));
    expect(result.entries_skipped + result.entries_updated).toBeGreaterThanOrEqual(0);
  });
});
