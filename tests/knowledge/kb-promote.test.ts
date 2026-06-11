import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';

function makeInput(overrides: Partial<KBEntryInput> = {}): KBEntryInput {
  return {
    type: 'learning',
    title: 'Registry initialization behavior',
    summary: 'How registry init works',
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

describe('kb_promote', () => {
  it('promotes INFERRED -> CONFIRMED', async () => {
    const { id } = await provider.capture(makeInput({ confidence: 'INFERRED' }));
    const result = await provider.promote(id, 'verified by reviewer');
    expect(result.confidence_before).toBe('INFERRED');
    expect(result.confidence_after).toBe('CONFIRMED');

    const entry = (await provider.query({ ids: [id] })).results[0];
    expect(entry.confidence).toBe('CONFIRMED');
    expect(entry.promoted_at).toBeTruthy();
    expect(entry.content).toContain('[Promoted: verified by reviewer');
  });

  it('promotes UNVERIFIED -> INFERRED', async () => {
    const { id } = await provider.capture(makeInput({ confidence: 'UNVERIFIED' }));
    const result = await provider.promote(id);
    expect(result.confidence_before).toBe('UNVERIFIED');
    expect(result.confidence_after).toBe('INFERRED');
  });

  it('CONFIRMED is a no-op (returns same confidence)', async () => {
    const { id } = await provider.capture(makeInput({ confidence: 'CONFIRMED' }));
    const result = await provider.promote(id);
    expect(result.confidence_before).toBe('CONFIRMED');
    expect(result.confidence_after).toBe('CONFIRMED');
  });
});
