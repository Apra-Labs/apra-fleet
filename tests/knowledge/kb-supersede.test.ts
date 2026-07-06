import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';

// T1.3 / D2 (F2a): when AUDN decides 'update', the OLD entry must be marked
// BOTH superseded_at AND stale = 1. Previously only superseded_at was set, so
// the old row could still leak through query()/prime() paths that filter on
// stale independently of superseded_at.

function makeInput(overrides: Partial<KBEntryInput> = {}): KBEntryInput {
  return {
    type: 'knowledge',
    title: 'Registry initialization behavior',
    summary: 'How registry init works',
    content: 'The registry initializes lazily on first access via getOrCreate().',
    source_files: ['src/services/registry.ts'],
    symbols: ['initRegistry', 'getOrCreate'],
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

describe('AUDN update supersede marks old entry superseded_at AND stale', () => {
  it('sets superseded_at and stale=1 on the old entry, keeps the new one live', async () => {
    const first = await provider.capture(makeInput());
    expect(first.audn_decision).toBe('add');

    // Correcting entry: same type, same symbols AND files, similar title,
    // different content -> AUDN decides 'update'.
    const second = await provider.capture(makeInput({
      content: 'The registry now initializes eagerly at startup. Changed in v2.',
    }));
    expect(second.audn_decision).toBe('update');
    expect(second.id).not.toBe(first.id);

    // Old entry must carry BOTH superseded_at and stale = 1.
    const all = await provider.query({ include_superseded: true, include_stale: true });
    const old = all.results.find(e => e.id === first.id);
    expect(old).toBeDefined();
    expect(old!.superseded_at).toBeTruthy();
    expect(old!.stale).toBe(true);

    // content_hash left intact (empty here, but not corrupted).
    expect(old!.content_hash).toBe('');

    // New entry is live.
    const fresh = all.results.find(e => e.id === second.id);
    expect(fresh).toBeDefined();
    expect(fresh!.superseded_at).toBeFalsy();
    expect(fresh!.stale).toBe(false);
  });

  it('query() excludes the superseded/stale old entry by default', async () => {
    const first = await provider.capture(makeInput());
    const second = await provider.capture(makeInput({
      content: 'The registry now initializes eagerly at startup. Changed in v2.',
    }));

    const defaultResults = await provider.query({ query: 'Registry initialization behavior' });
    const ids = defaultResults.results.map(e => e.id);
    expect(ids).not.toContain(first.id);
    expect(ids).toContain(second.id);
  });
});
