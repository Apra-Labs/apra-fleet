import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';

function makeInput(overrides: Partial<KBEntryInput> = {}): KBEntryInput {
  return {
    type: 'knowledge',
    title: 'Some concept',
    summary: 'A concept with no file link',
    content: 'This is a concept-level entry.',
    source_files: [],
    symbols: ['someSymbol'],
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

// Directly access private method for test isolation
function runDecay(p: SqliteProvider, days: number): void {
  // Access via prime() with decay_after_days=0 to force immediate decay,
  // or test via the public prime() interface
  (p as any).decayConceptEntries((p as any).getDb(), days);
}

describe('confidence decay', () => {
  it('demotes INFERRED -> UNVERIFIED for old concept entries', async () => {
    const { id } = await provider.capture(makeInput({ confidence: 'INFERRED' }));

    // Force last_accessed to be 60 days ago
    const old = new Date(Date.now() - 60 * 86400 * 1000).toISOString();
    (provider as any).getDb().prepare('UPDATE entries SET last_accessed = ? WHERE id = ?').run(old, id);

    runDecay(provider, 30);

    const entry = (await provider.query({ ids: [id] })).results[0];
    expect(entry.confidence).toBe('UNVERIFIED');
  });

  it('does not demote entries with last_accessed within the decay window', async () => {
    const { id } = await provider.capture(makeInput({ confidence: 'INFERRED' }));

    // Set last_accessed to 10 days ago (within 30-day window)
    const recent = new Date(Date.now() - 10 * 86400 * 1000).toISOString();
    (provider as any).getDb().prepare('UPDATE entries SET last_accessed = ? WHERE id = ?').run(recent, id);

    runDecay(provider, 30);

    const entry = (await provider.query({ ids: [id] })).results[0];
    expect(entry.confidence).toBe('INFERRED');
  });

  it('does not demote CONFIRMED entries', async () => {
    const { id } = await provider.capture(makeInput({ confidence: 'CONFIRMED' }));

    const old = new Date(Date.now() - 60 * 86400 * 1000).toISOString();
    (provider as any).getDb().prepare('UPDATE entries SET last_accessed = ? WHERE id = ?').run(old, id);

    runDecay(provider, 30);

    const entry = (await provider.query({ ids: [id] })).results[0];
    expect(entry.confidence).toBe('CONFIRMED');
  });

  it('does not demote entries with source_files set (file-linked)', async () => {
    const { id } = await provider.capture(makeInput({
      confidence: 'INFERRED',
      source_files: ['src/registry.ts'],
    }));

    const old = new Date(Date.now() - 60 * 86400 * 1000).toISOString();
    (provider as any).getDb().prepare('UPDATE entries SET last_accessed = ? WHERE id = ?').run(old, id);

    runDecay(provider, 30);

    const entry = (await provider.query({ ids: [id] })).results[0];
    expect(entry.confidence).toBe('INFERRED');
  });

  it('does not demote UNVERIFIED entries (already at lowest)', async () => {
    const { id } = await provider.capture(makeInput({ confidence: 'UNVERIFIED' }));

    const old = new Date(Date.now() - 60 * 86400 * 1000).toISOString();
    (provider as any).getDb().prepare('UPDATE entries SET last_accessed = ? WHERE id = ?').run(old, id);

    runDecay(provider, 30);

    const entry = (await provider.query({ ids: [id] })).results[0];
    // Still UNVERIFIED -- no lower tier to demote to, no change
    expect(entry.confidence).toBe('UNVERIFIED');
  });

  it('does not demote recently promoted entries even if never accessed', async () => {
    const { id } = await provider.capture(makeInput({ confidence: 'INFERRED' }));

    // Recent promotion, no last_accessed
    const recentPromo = new Date(Date.now() - 5 * 86400 * 1000).toISOString();
    (provider as any).getDb().prepare('UPDATE entries SET promoted_at = ? WHERE id = ?').run(recentPromo, id);

    runDecay(provider, 30);

    const entry = (await provider.query({ ids: [id] })).results[0];
    expect(entry.confidence).toBe('INFERRED');
  });

  it('prime() triggers decay with decay_after_days option', async () => {
    const { id } = await provider.capture(makeInput({ confidence: 'INFERRED' }));

    const old = new Date(Date.now() - 60 * 86400 * 1000).toISOString();
    (provider as any).getDb().prepare('UPDATE entries SET last_accessed = ? WHERE id = ?').run(old, id);

    // prime() with decay_after_days=30 should trigger decay
    await provider.prime({ decay_after_days: 30 });

    const entry = (await provider.query({ ids: [id] })).results[0];
    expect(entry.confidence).toBe('UNVERIFIED');
  });

  it('prime() without decay_after_days defaults to 30-day window', async () => {
    const { id } = await provider.capture(makeInput({ confidence: 'INFERRED' }));

    // 60 days ago -- beyond default 30-day window
    const old = new Date(Date.now() - 60 * 86400 * 1000).toISOString();
    (provider as any).getDb().prepare('UPDATE entries SET last_accessed = ? WHERE id = ?').run(old, id);

    await provider.prime({});

    const entry = (await provider.query({ ids: [id] })).results[0];
    expect(entry.confidence).toBe('UNVERIFIED');
  });
});
