import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';

/**
 * KB audit 2026-08-11: the KB writes a graph and never reads it. 554 edges
 * across three live KBs -- shares_file, shares_symbol, refines -- plus the
 * contradiction_of pointer, and `getLinked()` has no caller outside the
 * provider interface. Retrieval is pure FTS.
 *
 * This wires the two edge types FTS cannot substitute for. shares_file and
 * shares_symbol (520 of the 554) largely duplicate an FTS match over the same
 * fields, but `refines` and `contradiction_of` record the KB's own JUDGEMENT
 * about its contents -- "this entry has a newer framing", "something disputes
 * this" -- which nothing else in the system knows.
 *
 * That is not academic. In the audited warehouse KB, chain A's INFERRED head
 * ("export let clock seams ARE injectable") is the WRONG entry and sits at a
 * HIGHER confidence tier than the two UNVERIFIED entries that correct it. An
 * agent trusting tier order gets the wrong answer, and the only thing that
 * says otherwise is the contradiction edge.
 */

function makeInput(overrides: Partial<KBEntryInput> = {}): KBEntryInput {
  return {
    type: 'knowledge',
    title: 'Clock seams are injectable',
    summary: 'Assigning to an exported let works under the test runner.',
    content: 'server/ compiles to CommonJS, so export let clock seams are test-injectable.',
    source_files: ['src/services/registry.ts'],
    symbols: ['nowSeam'],
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

describe('SqliteProvider.relatedClaims (refines + contradiction_of)', () => {
  it('returns the entry that refines a hit', async () => {
    const { id: original } = await provider.capture(makeInput());
    // Same type, overlapping symbol AND file, different content -> AUDN wires
    // a `refines` edge from the newer entry to the original.
    const { id: refinement } = await provider.capture(makeInput({
      title: 'Clock seams are NOT injectable',
      content: 'Assigning to an exported let silently no-ops under the tsx loader.',
    }));
    expect(refinement).not.toBe(original);

    const related = await provider.relatedClaims([original]);

    expect(related.map(e => e.id)).toContain(refinement);
  });

  it('is symmetric -- asking from either end of a refines edge finds the other', async () => {
    const { id: original } = await provider.capture(makeInput());
    const { id: refinement } = await provider.capture(makeInput({
      title: 'Clock seams are NOT injectable',
      content: 'Assigning to an exported let silently no-ops under the tsx loader.',
    }));

    expect((await provider.relatedClaims([refinement])).map(e => e.id)).toContain(original);
  });

  it('returns a challenger that contradicts a hit, and vice versa', async () => {
    const { id: original } = await provider.capture(makeInput());
    const { id: challenger } = await provider.capture(makeInput({
      title: 'Clock seams are not reassignable at all',
      content: 'Mock Date.now instead; the seam assignment throws nothing and does nothing.',
      contradiction_of: original,
    } as Partial<KBEntryInput>));

    expect((await provider.relatedClaims([original])).map(e => e.id)).toContain(challenger);
    expect((await provider.relatedClaims([challenger])).map(e => e.id)).toContain(original);
  });

  it('never returns an id it was asked about', async () => {
    const { id: original } = await provider.capture(makeInput());
    await provider.capture(makeInput({
      title: 'Clock seams are NOT injectable',
      content: 'Assigning to an exported let silently no-ops under the tsx loader.',
    }));

    const related = await provider.relatedClaims([original]);

    expect(related.map(e => e.id)).not.toContain(original);
  });

  it('does NOT traverse shares_file / shares_symbol -- FTS already covers those', async () => {
    const { id: a } = await provider.capture(makeInput());
    // Overlapping file/symbol but a DIFFERENT type, so AUDN records no
    // refinement -- wireLinks still writes shares_file/shares_symbol edges.
    await provider.capture(makeInput({
      type: 'runbook',
      title: 'How to run the clock seam tests',
      content: 'Run the suite with the tsx loader and a mocked Date.now.',
    }));

    expect(await provider.relatedClaims([a])).toEqual([]);
  });

  it('skips superseded entries and tolerates unknown ids', async () => {
    const { id } = await provider.capture(makeInput());
    expect(await provider.relatedClaims(['no-such-id'])).toEqual([]);
    expect(await provider.relatedClaims([])).toEqual([]);
    expect(await provider.relatedClaims([id])).toEqual([]);
  });

  it('caps what it returns', async () => {
    const { id: original } = await provider.capture(makeInput());
    for (let i = 0; i < 5; i++) {
      await provider.capture(makeInput({
        title: 'Challenger ' + i,
        content: 'A distinct disputing claim number ' + i + ' about the same seam.',
        contradiction_of: original,
      } as Partial<KBEntryInput>));
    }

    expect((await provider.relatedClaims([original], 2))).toHaveLength(2);
  });
});
