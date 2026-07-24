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

// ---------------------------------------------------------------------------
// T1.3 (F2/D2 HARDENED): bidirectional staleness + freshnessSweep(). The
// un-stale predicate (verbatim) is: stale=1 AND superseded_at IS NULL AND
// flagged_for_review=0 AND content_hash != 'invalidated' AND content NOT LIKE
// the anchored feedback marker AND full stored basis re-hash matches. FOUR
// actors set stale=1; only the freshness actor may revive. Each exclusion is
// tested individually.
// ---------------------------------------------------------------------------

describe('SqliteProvider.freshnessSweep + bidirectional staleness (T1.3, F2/D2)', () => {
  function rawRow(id: string): { stale: number; flagged_for_review: number; superseded_at: string | null; content_hash: string; content: string } {
    return (provider as any).getDb()
      .prepare('SELECT stale, flagged_for_review, superseded_at, content_hash, content FROM entries WHERE id = ?')
      .get(id);
  }

  it('CORE fail-then-pass: modify file -> staled by sweep; restore byte-identical -> revived by sweep, primed again', async () => {
    const filePath = path.join(tmpDir, 'core.ts');
    const original = 'export const core = true;';
    fs.writeFileSync(filePath, original);

    const { id } = await provider.capture(makeInput({
      title: 'reviveSymbol core revival entry',
      content: 'Behavior involving reviveSymbol.',
      symbols: ['reviveSymbol'],
      source_files: [filePath],
    }));

    // State B: file changed -> sweep marks it stale.
    fs.writeFileSync(filePath, 'export const core = false; // B');
    const staleSweep = await provider.freshnessSweep();
    expect(staleSweep.staled).toBeGreaterThanOrEqual(1);
    expect(rawRow(id).stale).toBe(1);
    // Prime cannot see a stale entry.
    const primedWhileStale = await provider.prime({ hint_symbols: ['reviveSymbol'] });
    expect(primedWhileStale.top_entries.some(e => e.id === id)).toBe(false);

    // State A restored byte-identical -> sweep revives it (THE un-stale path
    // that did not exist before T1.3).
    fs.writeFileSync(filePath, original);
    const reviveSweep = await provider.freshnessSweep();
    expect(reviveSweep.unstaled).toBeGreaterThanOrEqual(1);
    expect(rawRow(id).stale).toBe(0);
    // And a subsequent prime returns it again.
    const primedAfter = await provider.prime({ hint_symbols: ['reviveSymbol'] });
    expect(primedAfter.top_entries.some(e => e.id === id)).toBe(true);
  });

  it('EXCLUSION superseded: superseded_at set + matching basis stays stale=1 after sweep', async () => {
    const filePath = path.join(tmpDir, 'superseded.ts');
    fs.writeFileSync(filePath, 'export const s = 1;');
    const { id } = await provider.capture(makeInput({
      title: 'supersededSymbol entry',
      symbols: ['supersededSymbol'],
      source_files: [filePath],
    }));
    // Simulate a supersede: superseded_at + stale=1, basis untouched (matches).
    (provider as any).getDb()
      .prepare("UPDATE entries SET superseded_at = ?, stale = 1 WHERE id = ?")
      .run(new Date().toISOString(), id);

    const sweep = await provider.freshnessSweep();
    expect(sweep.unstaled).toBe(0);
    expect(rawRow(id).stale).toBe(1);
  });

  it('EXCLUSION feedback flag standing: downvoted entry (stale=1, flagged=1) + matching basis stays stale=1', async () => {
    const filePath = path.join(tmpDir, 'feedback.ts');
    fs.writeFileSync(filePath, 'export const f = 1;');
    const { id } = await provider.capture(makeInput({
      title: 'feedbackSymbol entry',
      symbols: ['feedbackSymbol'],
      source_files: [filePath],
    }));
    await provider.feedback(id, 'no longer holds', 'doer'); // stale=1, flagged=1, marker

    const sweep = await provider.freshnessSweep();
    expect(sweep.unstaled).toBe(0);
    const row = rawRow(id);
    expect(row.stale).toBe(1);
    expect(row.flagged_for_review).toBe(1);
  });

  it('EXCLUSION downvote marker (MEDIUM-2): flagged bit cleared but "[feedback " marker stays -> not revived', async () => {
    const filePath = path.join(tmpDir, 'marker.ts');
    fs.writeFileSync(filePath, 'export const m = 1;');
    const { id } = await provider.capture(makeInput({
      title: 'markerSymbol entry',
      symbols: ['markerSymbol'],
      source_files: [filePath],
    }));
    await provider.feedback(id, 'downvoted once', 'reviewer'); // adds marker + flag + stale
    // Simulate a later flow (e.g. T3.1 winner path) clearing ONLY the flag.
    (provider as any).getDb()
      .prepare('UPDATE entries SET flagged_for_review = 0 WHERE id = ?')
      .run(id);
    expect(rawRow(id).flagged_for_review).toBe(0); // flag cleared
    expect(rawRow(id).content).toMatch(/\n\n\[feedback \d{4}-/); // marker survives

    const sweep = await provider.freshnessSweep();
    expect(sweep.unstaled).toBe(0);
    expect(rawRow(id).stale).toBe(1); // durable downvote record keeps it retired
  });

  it('EXCLUSION invalidated (MEDIUM-1): content_hash=invalidated (flagged=0, superseded NULL) + matching basis stays stale=1', async () => {
    const filePath = path.join(tmpDir, 'invalidated.ts');
    fs.writeFileSync(filePath, 'export const iv = 1;');
    await provider.capture(makeInput({
      type: 'context-cache',
      title: 'invalidatedSymbol context entry',
      symbols: ['invalidatedSymbol'],
      source_file: filePath,
      source_files: [filePath],
    }));
    const inv = await provider.invalidate([filePath]);
    expect(inv.invalidated).toBeGreaterThanOrEqual(1);

    const db = (provider as any).getDb();
    const before = db.prepare("SELECT id, stale, content_hash, flagged_for_review, superseded_at FROM entries WHERE content_hash = 'invalidated'").get() as any;
    expect(before.stale).toBe(1);
    expect(before.flagged_for_review).toBe(0);
    expect(before.superseded_at).toBeNull();

    const sweep = await provider.freshnessSweep();
    expect(sweep.unstaled).toBe(0);
    const after = db.prepare('SELECT stale FROM entries WHERE id = ?').get(before.id) as any;
    expect(after.stale).toBe(1);
  });

  it('EXCLUSION partial basis: 2-file basis with only 1 file matching is NOT revived (FULL basis must match)', async () => {
    const fileA = path.join(tmpDir, 'partA.ts');
    const fileB = path.join(tmpDir, 'partB.ts');
    const origA = 'export const a = 1;';
    fs.writeFileSync(fileA, origA);
    fs.writeFileSync(fileB, 'export const b = 1;');
    const { id } = await provider.capture(makeInput({
      title: 'partialSymbol entry',
      symbols: ['partialSymbol'],
      source_files: [fileA, fileB],
    }));
    // Change both -> stale.
    fs.writeFileSync(fileA, 'export const a = 2;');
    fs.writeFileSync(fileB, 'export const b = 2;');
    await provider.freshnessSweep();
    expect(rawRow(id).stale).toBe(1);
    // Restore ONLY fileA; fileB still differs -> full basis does not match.
    fs.writeFileSync(fileA, origA);
    const sweep = await provider.freshnessSweep();
    expect(sweep.unstaled).toBe(0);
    expect(rawRow(id).stale).toBe(1);
  });

  it('empty/malformed basis: never staled, never revived, never counted in checked', async () => {
    const unrelated = path.join(tmpDir, 'unrelated-sweep.ts');
    fs.writeFileSync(unrelated, 'export const u = 1;');
    // Empty basis (no source_files).
    const { id: emptyId } = await provider.capture(makeInput({
      title: 'emptyBasisSymbol entry',
      symbols: ['emptyBasisSymbol'],
      source_files: [],
    }));
    // Malformed basis via direct SQL.
    const { id: badId } = await provider.capture(makeInput({
      title: 'malformedBasisSymbol entry',
      symbols: ['malformedBasisSymbol'],
      source_files: [],
    }));
    (provider as any).getDb()
      .prepare("UPDATE entries SET source_file_hashes = '{not valid json' WHERE id = ?")
      .run(badId);

    fs.writeFileSync(unrelated, 'export const u = 2; // changed');
    const sweep = await provider.freshnessSweep();
    expect(sweep.checked).toBe(0); // neither entry has a usable basis
    expect(sweep.staled).toBe(0);
    expect(sweep.unstaled).toBe(0);
    expect(rawRow(emptyId).stale).toBe(0);
    expect(rawRow(badId).stale).toBe(0);
  });

  it('freshnessSweep returns the {checked, staled, unstaled} shape', async () => {
    const filePath = path.join(tmpDir, 'shape.ts');
    fs.writeFileSync(filePath, 'export const sh = 1;');
    await provider.capture(makeInput({
      title: 'shapeSymbol entry',
      symbols: ['shapeSymbol'],
      source_files: [filePath],
    }));
    const sweep = await provider.freshnessSweep();
    expect(sweep).toEqual(
      expect.objectContaining({
        checked: expect.any(Number),
        staled: expect.any(Number),
        unstaled: expect.any(Number),
      })
    );
    expect(sweep.checked).toBeGreaterThanOrEqual(1);
  });
});
