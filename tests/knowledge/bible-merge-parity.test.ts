/**
 * Three-way bible merges with tombstones on either or both sides give the
 * documented result -- for BOTH implementations of the rules:
 *   - src/services/knowledge/bible-merge.ts (engine of `apra-fleet kb merge-driver`)
 *   - packages/apra-fleet-se/scripts/merge-kb-canonical.mjs (standalone script)
 * Every scenario runs against both, so the two can never drift apart.
 * The rules are documented in packages/apra-fleet-se/docs/kb-canonical-merge.md.
 */
import { describe, it, expect } from 'vitest';
import { mergeBibleDocuments, serializeBible, MalformedBibleError } from '../../src/services/knowledge/bible-merge.js';
// @ts-expect-error -- plain .mjs script without type declarations
import { mergeKbCanonical, serializeDocument, MalformedInputError } from '../../packages/apra-fleet-se/scripts/merge-kb-canonical.mjs';
// @ts-expect-error -- plain .mjs script without type declarations
import { validateBibleText } from '../../scripts/check-kb-canonical.mjs';

type Doc = { version: number; provenance: Record<string, unknown>; entries: Array<Record<string, unknown>>; demotions?: Array<Record<string, unknown>> };

function entry(id: string, summary = `summary ${id}`): Record<string, unknown> {
  return { id, type: 'knowledge', title: `title ${id}`, summary, symbols: [], source_files: ['src/a.ts'], confidence: 'CONFIRMED' };
}
function demoted(id: string, at = '2026-01-01T00:00:00.000Z'): Record<string, unknown> {
  return { id, at, reason: 'demoted' };
}
function withdrawn(id: string, note = 'no longer holds after the refactor', at = '2026-01-02T00:00:00.000Z'): Record<string, unknown> {
  return { id, at, reason: 'withdrawn', note, evidence_files: ['src/a.ts'] };
}
function doc(entries: Array<Record<string, unknown>>, demotions: Array<Record<string, unknown>> = []): Doc {
  return { version: 3, provenance: { branch: 'main' }, entries, ...(demotions.length > 0 ? { demotions } : {}) };
}

interface Outcome { conflict: boolean; entries?: string[]; tombstones?: Array<[string, string]>; text?: string }

const IMPLEMENTATIONS: Array<[string, (b: Doc, o: Doc, t: Doc) => Outcome]> = [
  ['src bible-merge (merge driver)', (b, o, t) => {
    const r = mergeBibleDocuments(b, o, t);
    if (r.merged === null) return { conflict: true };
    return {
      conflict: false,
      entries: r.merged.entries.map((e) => String(e.id)),
      tombstones: (r.merged.demotions ?? []).map((d) => [String(d.id), String(d.reason)] as [string, string]),
      text: serializeBible(r.merged),
    };
  }],
  ['merge-kb-canonical.mjs', (b, o, t) => {
    const r = mergeKbCanonical(b, o, t);
    if (r.merged === null) return { conflict: true };
    return {
      conflict: false,
      entries: r.merged.entries.map((e: { id: string }) => e.id),
      tombstones: (r.merged.demotions ?? []).map((d: { id: string; reason: string }) => [d.id, d.reason] as [string, string]),
      text: serializeDocument(r.merged),
    };
  }],
];

interface Scenario { name: string; base: Doc; ours: Doc; theirs: Doc; expect: Outcome }

const SCENARIOS: Scenario[] = [
  {
    name: 'each side adds a different entry and a different tombstone (union, sorted by id)',
    base: doc([entry('b'), entry('d')]),
    ours: doc([entry('b'), entry('d'), entry('e')], [withdrawn('x')]),
    theirs: doc([entry('a'), entry('b'), entry('d')], [demoted('w')]),
    expect: { conflict: false, entries: ['a', 'b', 'd', 'e'], tombstones: [['w', 'demoted'], ['x', 'withdrawn']] },
  },
  {
    name: 'ours tombstones a base entry (entry removed, tombstone added); theirs untouched',
    base: doc([entry('a'), entry('b')]),
    ours: doc([entry('b')], [demoted('a')]),
    theirs: doc([entry('a'), entry('b')]),
    expect: { conflict: false, entries: ['b'], tombstones: [['a', 'demoted']] },
  },
  {
    name: 'theirs withdraws a base entry that ours edited: the tombstone wins',
    base: doc([entry('a'), entry('b')]),
    ours: doc([entry('a', 'edited by ours'), entry('b')]),
    theirs: doc([entry('b')], [withdrawn('a')]),
    expect: { conflict: false, entries: ['b'], tombstones: [['a', 'withdrawn']] },
  },
  {
    name: 'a tombstone wins over a same-id entry added on the other side',
    base: doc([entry('b')]),
    ours: doc([entry('a'), entry('b')]),
    theirs: doc([entry('b')], [withdrawn('a')]),
    expect: { conflict: false, entries: ['b'], tombstones: [['a', 'withdrawn']] },
  },
  {
    name: 'both sides add the identical tombstone: one copy',
    base: doc([entry('a'), entry('b')]),
    ours: doc([entry('b')], [demoted('a')]),
    theirs: doc([entry('b')], [demoted('a')]),
    expect: { conflict: false, entries: ['b'], tombstones: [['a', 'demoted']] },
  },
  {
    name: 'both sides add a tombstone for one id with different content: conflict',
    base: doc([entry('a'), entry('b')]),
    ours: doc([entry('b')], [demoted('a')]),
    theirs: doc([entry('b')], [withdrawn('a')]),
    expect: { conflict: true },
  },
  {
    name: 'one side changes a base tombstone (demoted -> withdrawn): taken, note and evidence kept',
    base: doc([entry('b')], [demoted('a')]),
    ours: doc([entry('b')], [withdrawn('a')]),
    theirs: doc([entry('b')], [demoted('a')]),
    expect: { conflict: false, entries: ['b'], tombstones: [['a', 'withdrawn']] },
  },
  {
    name: 'both sides change a base tombstone differently: conflict',
    base: doc([entry('b')], [withdrawn('a', 'first note on this entry')]),
    ours: doc([entry('b')], [withdrawn('a', 'ours rewrote the note')]),
    theirs: doc([entry('b')], [withdrawn('a', 'theirs rewrote the note')]),
    expect: { conflict: true },
  },
  {
    name: 'ours re-promotes (tombstone cleared, entry back); theirs untouched: entry restored, no tombstone',
    base: doc([entry('b')], [demoted('a')]),
    ours: doc([entry('a'), entry('b')]),
    theirs: doc([entry('b')], [demoted('a')]),
    expect: { conflict: false, entries: ['a', 'b'], tombstones: [] },
  },
  {
    name: 'ours clears a base tombstone that theirs changed: conflict',
    base: doc([entry('b')], [demoted('a')]),
    ours: doc([entry('a'), entry('b')]),
    theirs: doc([entry('b')], [withdrawn('a')]),
    expect: { conflict: true },
  },
  {
    name: 'both sides clear a base tombstone: removed',
    base: doc([entry('b')], [demoted('a')]),
    ours: doc([entry('b')]),
    theirs: doc([entry('b')]),
    expect: { conflict: false, entries: ['b'], tombstones: [] },
  },
  {
    name: 'a duplicate tombstone id inside one input: conflict',
    base: doc([entry('b')]),
    ours: doc([entry('b')], [demoted('a'), demoted('a', '2026-02-01T00:00:00.000Z')]),
    theirs: doc([entry('b')]),
    expect: { conflict: true },
  },
];

describe.each(IMPLEMENTATIONS)('bible three-way merge with tombstones: %s', (_name, run) => {
  it.each(SCENARIOS.map((s) => [s.name, s] as const))('%s', (_n, s) => {
    const got = run(structuredClone(s.base), structuredClone(s.ours), structuredClone(s.theirs));
    expect(got.conflict).toBe(s.expect.conflict);
    if (s.expect.conflict) return;
    expect(got.entries).toEqual(s.expect.entries);
    expect(got.tombstones).toEqual(s.expect.tombstones);
    // The merged file is one every writer could have produced: the validator accepts it.
    expect(validateBibleText(got.text)).toEqual([]);
  });
});

describe('the two implementations agree byte for byte', () => {
  it.each(SCENARIOS.filter((s) => !s.expect.conflict).map((s) => [s.name, s] as const))('%s', (_n, s) => {
    const [a, b] = IMPLEMENTATIONS.map(([, run]) => run(structuredClone(s.base), structuredClone(s.ours), structuredClone(s.theirs)));
    expect(a.text).toBe(b.text);
  });

  it('non-ASCII text is escaped like the exporter writes it', () => {
    const base = doc([entry('a')]);
    const ours = doc([entry('a'), entry('b', 'caf\u00e9 \u2014 r\u00e9sum\u00e9')]);
    const [a, b] = IMPLEMENTATIONS.map(([, run]) => run(base, ours, structuredClone(base)));
    expect(a.text).toBe(b.text);
    expect(a.text).toContain('caf\\u00e9 \\u2014');
    expect(/[^\x00-\x7f]/.test(a.text!)).toBe(false);
  });
});

describe('malformed tombstones are malformed input', () => {
  it('a tombstone without an id', () => {
    const bad = doc([entry('b')], [{ at: '2026-01-01T00:00:00.000Z', reason: 'demoted' }]);
    expect(() => mergeBibleDocuments(doc([entry('b')]), bad, doc([entry('b')]))).toThrow(MalformedBibleError);
    expect(() => mergeKbCanonical(doc([entry('b')]), bad, doc([entry('b')]))).toThrow(MalformedInputError);
  });
  it('a demotions value that is not an array', () => {
    const bad = { ...doc([entry('b')]), demotions: { id: 'a' } } as unknown as Doc;
    expect(() => mergeBibleDocuments(doc([entry('b')]), bad, doc([entry('b')]))).toThrow(MalformedBibleError);
    expect(() => mergeKbCanonical(doc([entry('b')]), bad, doc([entry('b')]))).toThrow(MalformedInputError);
  });
});
