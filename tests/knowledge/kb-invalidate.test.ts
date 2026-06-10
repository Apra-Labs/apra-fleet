import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';

function makeContextCacheInput(file: string, overrides: Partial<KBEntryInput> = {}): KBEntryInput {
  return {
    type: 'context-cache',
    title: `Summary of ${file}`,
    summary: 'File summary',
    content: 'File content details.',
    source_files: [file],
    symbols: ['someSymbol'],
    tags: [],
    content_hash: 'abc123hash',
    content_hash_type: 'git',
    flagged_for_review: false,
    author: 'test-agent',
    source: 'doer',
    confidence: 'INFERRED',
    ...overrides,
  };
}

function makeLearningInput(overrides: Partial<KBEntryInput> = {}): KBEntryInput {
  return {
    type: 'learning',
    title: 'Some learning about registry',
    summary: 'A learning',
    content: 'Learned something useful.',
    source_files: ['src/registry.ts'],
    symbols: ['registry'],
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

describe('kb_invalidate', () => {
  it('marks context-cache entries stale for the given file', async () => {
    const filePath = 'src/services/registry.ts';
    await provider.capture(makeContextCacheInput(filePath));

    const result = await provider.invalidate([filePath]);
    expect(result.invalidated).toBe(1);

    // Entry should have content_hash='invalidated'
    const { results } = await provider.query({ type: 'context-cache' });
    expect(results[0].content_hash).toBe('invalidated');
    expect(results[0].stale).toBe(true);
  });

  it('does not invalidate entries for different files', async () => {
    const fileA = 'src/services/registry.ts';
    const fileB = 'src/services/auth.ts';
    await provider.capture(makeContextCacheInput(fileA));
    await provider.capture(makeContextCacheInput(fileB));

    const result = await provider.invalidate([fileA]);
    expect(result.invalidated).toBe(1);

    const { results } = await provider.query({ type: 'context-cache' });
    const entryB = results.find(e => e.source_files.includes(fileB));
    expect(entryB).toBeDefined();
    expect(entryB!.content_hash).toBe('abc123hash');
  });

  it('does not invalidate non-context-cache entries', async () => {
    const filePath = 'src/services/registry.ts';
    // Add both a context-cache and a learning for the same file
    await provider.capture(makeContextCacheInput(filePath));
    await provider.capture(makeLearningInput({ source_files: [filePath] }));

    const result = await provider.invalidate([filePath]);
    expect(result.invalidated).toBe(1); // only context-cache entry

    const { results } = await provider.query({ type: 'learning' });
    expect(results[0].content_hash).toBe(''); // learning unchanged
  });

  it('returns invalidated=0 when no matching context-cache entries exist', async () => {
    const result = await provider.invalidate(['src/nonexistent.ts']);
    expect(result.invalidated).toBe(0);
  });
});
