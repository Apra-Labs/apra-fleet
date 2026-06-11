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

describe('kb_capture AUDN decisions', () => {
  it('new entry returns audn_decision=add', async () => {
    const result = await provider.capture(makeInput());
    expect(result.audn_decision).toBe('add');
    expect(result.id).toBeTruthy();
  });

  it('duplicate capture (same title+symbols+files) returns audn_decision=none with existing id', async () => {
    const first = await provider.capture(makeInput());
    expect(first.audn_decision).toBe('add');

    const second = await provider.capture(makeInput());
    expect(second.audn_decision).toBe('none');
    expect(second.id).toBe(first.id);
  });

  it('updated fact returns audn_decision=update and old entry has superseded_at set', async () => {
    const first = await provider.capture(makeInput());
    expect(first.audn_decision).toBe('add');

    const updated = makeInput({
      content: 'The registry initializes eagerly at startup, not lazily. Changed in v2.',
    });
    const second = await provider.capture(updated);
    expect(second.audn_decision).toBe('update');
    expect(second.id).not.toBe(first.id);

    // Old entry must have superseded_at set
    const allResults = await provider.query({ include_superseded: true });
    const old = allResults.results.find(e => e.id === first.id);
    expect(old).toBeDefined();
    expect(old!.superseded_at).toBeTruthy();
  });

  it('contradicting fact returns audn_decision=flagged and existing entry is flagged_for_review', async () => {
    const first = await provider.capture(makeInput());
    expect(first.audn_decision).toBe('add');

    const contradicting = makeInput({
      content: 'Actually this was wrong: the registry does not use getOrCreate at all. Correction: it uses a simple map.',
    });
    const second = await provider.capture(contradicting);
    expect(second.audn_decision).toBe('flagged');
    expect(second.id).not.toBe(first.id);

    // Original entry must be flagged_for_review
    const allResults = await provider.query({ include_superseded: true });
    const original = allResults.results.find(e => e.id === first.id);
    expect(original).toBeDefined();
    expect(original!.flagged_for_review).toBe(true);

    // New entry has contradiction_of pointing to original
    const newEntry = allResults.results.find(e => e.id === second.id);
    expect(newEntry).toBeDefined();
    expect(newEntry!.contradiction_of).toBe(first.id);
    expect(newEntry!.confidence).toBe('UNVERIFIED');
  });
});
