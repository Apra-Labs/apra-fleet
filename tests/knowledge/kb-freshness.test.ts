import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// T2.2 / F3 (revised D3): auto-staleness at prime, keyed off source_files with
// a per-file hash basis persisted at capture time. Mock computeFileHashBatch
// so one test can force it to throw (the error-degradation path) while every
// other test uses the real implementation.

const mockComputeFileHashBatch = vi.hoisted(() => vi.fn());

vi.mock('../../src/services/knowledge/file-hash.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/knowledge/file-hash.js')>();
  mockComputeFileHashBatch.mockImplementation(actual.computeFileHashBatch);
  return { ...actual, computeFileHashBatch: mockComputeFileHashBatch };
});

import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';

function makeInput(overrides: Partial<KBEntryInput> = {}): KBEntryInput {
  // The symbol name is embedded in title+content too (not just the symbols
  // array) because entries_fts only indexes title/summary/content/tags --
  // prime()'s hint_symbols search is an FTS MATCH over those text columns,
  // not the symbols JSON column.
  return {
    type: 'learning',
    title: 'freshnessSymbol test entry',
    summary: 'Tracks a real file for staleness',
    content: 'Behavior involving freshnessSymbol.',
    source_files: [],
    symbols: ['freshnessSymbol'],
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
let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-freshness-test-'));
  mockComputeFileHashBatch.mockClear();
  provider = new SqliteProvider(':memory:');
  await provider.init();
});

afterEach(() => {
  provider.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('SqliteProvider staleness at prime (T2.2 / F3, revised D3)', () => {
  it('entry with a modified source file is marked stale=1 and dropped from prime', async () => {
    const filePath = path.join(tmpDir, 'tracked.ts');
    fs.writeFileSync(filePath, 'export const original = true;');

    const { id } = await provider.capture(makeInput({
      title: 'freshnessSymbol tracked file entry',
      source_files: [filePath],
    }));

    // Surfaces initially (basis matches current file content).
    const before = await provider.prime({ hint_symbols: ['freshnessSymbol'] });
    expect(before.top_entries.some(e => e.id === id)).toBe(true);

    fs.writeFileSync(filePath, 'export const original = false; // changed');

    const after = await provider.prime({ hint_symbols: ['freshnessSymbol'] });
    expect(after.top_entries.some(e => e.id === id)).toBe(false);

    const row = await provider.query({ ids: [id] });
    expect(row.results[0].stale).toBe(true);
  });

  it('hash batch throwing degrades prime to todays output (no crash, no false stale)', async () => {
    const filePath = path.join(tmpDir, 'tracked2.ts');
    fs.writeFileSync(filePath, 'export const original = true;');

    const { id } = await provider.capture(makeInput({
      title: 'freshnessSymbol2 tracked file entry two',
      content: 'Behavior involving freshnessSymbol2.',
      symbols: ['freshnessSymbol2'],
      source_files: [filePath],
    }));

    mockComputeFileHashBatch.mockImplementationOnce(() => {
      throw new Error('hash batch boom');
    });

    const result = await provider.prime({ hint_symbols: ['freshnessSymbol2'] });
    expect(result.top_entries.some(e => e.id === id)).toBe(true);

    const row = await provider.query({ ids: [id] });
    expect(row.results[0].stale).toBe(false);
  });

  it('entry with no source_files (empty basis) is untouched even when unrelated files change', async () => {
    const unrelated = path.join(tmpDir, 'unrelated.ts');
    fs.writeFileSync(unrelated, 'export const unrelated = true;');

    const { id } = await provider.capture(makeInput({
      title: 'freshnessSymbol3 no basis entry',
      content: 'Behavior involving freshnessSymbol3.',
      symbols: ['freshnessSymbol3'],
      source_files: [],
    }));

    fs.writeFileSync(unrelated, 'export const unrelated = false; // changed');

    const result = await provider.prime({ hint_symbols: ['freshnessSymbol3'] });
    expect(result.top_entries.some(e => e.id === id)).toBe(true);

    const row = await provider.query({ ids: [id] });
    expect(row.results[0].stale).toBe(false);
  });

  it('capture stores a per-file hash basis on source_file_hashes for all types', async () => {
    const filePath = path.join(tmpDir, 'basis.ts');
    fs.writeFileSync(filePath, 'export const basis = 1;');

    await provider.capture(makeInput({
      type: 'knowledge',
      title: 'basisSymbol basis-storing entry',
      content: 'Behavior involving basisSymbol.',
      symbols: ['basisSymbol'],
      source_files: [filePath],
    }));

    // Re-prime after a change proves a basis was actually persisted (the
    // freshness check has something to compare against).
    fs.writeFileSync(filePath, 'export const basis = 2; // changed');
    const result = await provider.prime({ hint_symbols: ['basisSymbol'] });
    expect(result.top_entries).toHaveLength(0);
  });
});
