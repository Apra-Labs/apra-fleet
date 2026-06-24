import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';

function makeInput(overrides: Partial<KBEntryInput> = {}): KBEntryInput {
  return {
    type: 'knowledge',
    title: 'Registry initialization behavior',
    summary: 'How registry init works',
    content: 'The registry initializes lazily on first access.',
    source_files: [],
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

describe('kb_query flagged_only', () => {
  it('returns empty when no flagged entries exist', async () => {
    await provider.capture(makeInput({ title: 'Normal entry A' }));
    await provider.capture(makeInput({ title: 'Normal entry B', symbols: ['foo'] }));

    const result = await provider.query({ flagged_only: true, include_stale: true });
    expect(result.results).toHaveLength(0);
  });

  it('returns entry with flagged_for_review=true', async () => {
    await provider.capture(makeInput({ title: 'Clean entry' }));
    const { id } = await provider.capture(makeInput({
      title: 'Flagged original',
      flagged_for_review: true,
    }));

    const result = await provider.query({ flagged_only: true, include_stale: true });
    expect(result.results.some(e => e.id === id)).toBe(true);
  });

  it('returns entry with contradiction_of set', async () => {
    const { id: originalId } = await provider.capture(makeInput({ title: 'Original claim' }));
    const { id: challengerId } = await provider.capture(makeInput({
      title: 'Contradicting claim',
      contradiction_of: originalId,
    }));

    const result = await provider.query({ flagged_only: true, include_stale: true });
    expect(result.results.some(e => e.id === challengerId)).toBe(true);
  });

  it('does not return normal entries when flagged_only=true', async () => {
    const { id: normalId } = await provider.capture(makeInput({ title: 'Normal knowledge', symbols: ['normalFn'] }));
    await provider.capture(makeInput({ title: 'Flagged entry', flagged_for_review: true }));

    const result = await provider.query({ flagged_only: true, include_stale: true });
    expect(result.results.every(e => e.id !== normalId)).toBe(true);
  });

  it('works alongside a search query to narrow flagged results', async () => {
    await provider.capture(makeInput({ title: 'Auth flow contradiction', flagged_for_review: true, symbols: ['authFlow'] }));
    await provider.capture(makeInput({ title: 'Registry contradiction', flagged_for_review: true, symbols: ['initRegistry'] }));

    const result = await provider.query({ query: 'auth', flagged_only: true, include_stale: true });
    expect(result.results.some(e => e.title.includes('Auth'))).toBe(true);
  });

  it('flagged_only returns both the original (flagged_for_review) and challenger (contradiction_of) entries', async () => {
    const { id: originalId } = await provider.capture(makeInput({
      title: 'Registry init claim A',
      flagged_for_review: true,
    }));
    const { id: challengerId } = await provider.capture(makeInput({
      title: 'Registry init claim B',
      contradiction_of: originalId,
      symbols: ['differentSymbol'],
    }));
    const { id: cleanId } = await provider.capture(makeInput({
      title: 'Unrelated clean entry',
      symbols: ['unrelated'],
    }));

    const result = await provider.query({ flagged_only: true, include_stale: true });
    const ids = result.results.map(e => e.id);
    expect(ids).toContain(originalId);
    expect(ids).toContain(challengerId);
    expect(ids).not.toContain(cleanId);
  });
});
