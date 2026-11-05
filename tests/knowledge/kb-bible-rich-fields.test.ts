import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { importBibleEntries } from '../../src/services/knowledge/bible-import.js';
import { toCanonicalEntry, bibleContentOf, BIBLE_CONTENT_MAX_LENGTH } from '../../src/tools/kb-export.js';
import type { KBEntry } from '../../src/services/knowledge/types.js';

// Design D9 bible half: a bible entry may carry content, recall_cues and
// error_signatures. Writers add them only when they carry something; readers
// take them when present and fall back exactly as before when absent or
// malformed.

const EXAMPLES_DIR = path.resolve(__dirname, '..', '..', 'memory-contract', 'v1', 'bible', 'examples');

function kbEntry(over: Partial<KBEntry>): KBEntry {
  return {
    id: 'e-0001', type: 'knowledge', title: 'T', summary: 'S.', content: 'S.',
    source_files: ['src/a.ts'], symbols: ['symA'], tags: [], content_hash: '', content_hash_type: 'sha256',
    stale: false, flagged_for_review: false, author: 'doer', source: 'promotion', confidence: 'CONFIRMED',
    created_at: '2026-01-01T00:00:00.000Z', promoted_at: '2026-01-02T00:00:00.000Z', use_count: 0,
    recall_cues: [], error_signatures: [],
    ...over,
  };
}

let provider: SqliteProvider;
beforeEach(async () => {
  provider = new SqliteProvider(':memory:');
  await provider.init();
});
afterEach(() => provider.close());

const stored = async (id: string) => (await provider.query({ ids: [id] })).results[0];

describe('bible writer: optional content, recall_cues, error_signatures', () => {
  it('writes all three for a rich entry, and a fresh KB import reproduces them exactly', async () => {
    const rich = kbEntry({
      id: 'rich-0001',
      content: 'Line one of the lesson.\nLine two: the fix was X.\n[Promoted: verified against the test -- doer]',
      recall_cues: ['why X fails', 'X workaround'],
      error_signatures: ['Error: X exploded'],
    });
    const out = toCanonicalEntry(rich, { 'src/a.ts': 'h1' });
    expect(out.content).toBe('Line one of the lesson.\nLine two: the fix was X.');
    expect(out.recall_cues).toEqual(['why X fails', 'X workaround']);
    expect(out.error_signatures).toEqual(['Error: X exploded']);

    // Through the file bytes, as a reader sees them.
    const parsed = JSON.parse(JSON.stringify({ version: 3, entries: [out] })).entries;
    const counts = await importBibleEntries(provider, parsed);
    expect(counts.imported).toBe(1);
    const e = await stored('rich-0001');
    expect(e.content).toBe('Line one of the lesson.\nLine two: the fix was X.');
    expect(e.recall_cues).toEqual(['why X fails', 'X workaround']);
    expect(e.error_signatures).toEqual(['Error: X exploded']);
    // Re-export of the imported row is the same entry (content round-trips).
    expect(toCanonicalEntry(e, { 'src/a.ts': 'h1' }, '2026-01-02T00:00:00.000Z')).toEqual(out);
  });

  it('an entry without new-field data serializes exactly as the pre-change writer did', () => {
    // Pre-change shape, written out literally: {id, type, title, summary,
    // symbols, source_files, confidence, updated_at[, source_file_hashes]}.
    const PRE_CHANGE = '{"id":"e-0001","type":"knowledge","title":"T","summary":"S.","symbols":["symA"],'
      + '"source_files":["src/a.ts"],"confidence":"CONFIRMED","updated_at":"2026-01-02T00:00:00.000Z",'
      + '"source_file_hashes":{"src/a.ts":"h1"}}';
    const variants: Array<Partial<KBEntry>> = [
      { content: 'S.' },
      { content: 'S.\n[Promoted -- doer]' },
      { content: 'S.\n[Promoted: checked the code path by hand -- reviewer]' },
      { content: 'S.\n\n[confidence clamped: CONFIRMED requires kb_promote]\n[Promoted -- doer]' },
      { content: 'S.\n[Promoted -- doer]\n[Demoted: no longer holds | evidence: src/a.ts -- doer]\n[Promoted -- doer]' },
      { content: 'S.\n\n[feedback 2026-01-03T00:00:00.000Z] doer: still right' },
      { content: 'S.\n\n[reconciled 2026-01-03T00:00:00.000Z] winner over x: evidence' },
      { content: '' },
      { recall_cues: undefined, error_signatures: undefined },
    ];
    for (const v of variants) {
      expect(JSON.stringify(toCanonicalEntry(kbEntry(v), { 'src/a.ts': 'h1' }))).toBe(PRE_CHANGE);
    }
  });

  it('never writes content over the cap: truncated to exactly the cap with a marker', () => {
    const long = 'L'.repeat(3999);
    const out = toCanonicalEntry(kbEntry({ content: long }));
    expect(out.content!.length).toBe(BIBLE_CONTENT_MAX_LENGTH);
    expect(BIBLE_CONTENT_MAX_LENGTH).toBe(2000);
    expect(out.content!.endsWith('...[truncated]')).toBe(true);
    expect(out.content!.startsWith('L'.repeat(1986))).toBe(true);
    // Exactly at the cap is written as-is.
    expect(bibleContentOf('M'.repeat(2000), 'S.')).toBe('M'.repeat(2000));
  });
});

describe('bible reader', () => {
  it('a v3 bible without the new fields imports with the pre-change content, confidence and basis', async () => {
    const raw = fs.readFileSync(path.join(EXAMPLES_DIR, 'v3-envelope.json'), 'utf-8');
    const counts = await importBibleEntries(provider, JSON.parse(raw).entries);
    expect(counts.imported).toBe(2);
    // Pre-change expectations, written out literally (not re-derived): content
    // is the summary, confidence the bible's, the carried basis stored exactly
    // and an entry without one has no verified basis.
    const one = await stored('0b4c3e1a-1111-4a6b-9c1d-000000000001');
    expect(one.content).toBe('exampleFn in src/example.ts is a trivial increment helper (carried over from a v2 bible: no basis).');
    expect(one.confidence).toBe('CONFIRMED');
    expect(one.recall_cues).toEqual([]);
    expect(one.error_signatures).toEqual([]);
    const two = await stored('0b4c3e1a-2222-4a6b-9c1d-000000000002');
    expect(two.content).toBe("helperBar in src/helper.ts does nothing yet; it is called from exampleFn's tests.");
    expect(two.confidence).toBe('CONFIRMED');
    const bases = provider.getSourceFileBases([one.id, two.id]);
    expect(bases.get(one.id)).toBeNull();
    expect(bases.get(two.id)).toEqual({
      'src/example.ts': '3f7a1c0e9b2d4f6a8c1e3b5d7f9a2c4e6b8d0f1a3c5e7b9d1f3a5c7e9b1d3f5a',
      'src/helper.ts': '9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c8b7a6f5e4d3c2b1a0f9e8d',
    });
  });

  it('tolerates malformed new fields by dropping the field, never the entry', async () => {
    const base = { type: 'knowledge', summary: 'Malformed summary.', confidence: 'CONFIRMED', symbols: [], source_files: [] as string[] };
    const entries = [
      { ...base, id: 'bad-content-type', title: 'a', content: 42 },
      { ...base, id: 'bad-content-long', title: 'b', content: 'z'.repeat(2001) },
      { ...base, id: 'bad-content-empty', title: 'c', content: '' },
      { ...base, id: 'bad-arrays', title: 'd', recall_cues: 'nope', error_signatures: ['ok', 3, null] },
    ];
    // An entry citing no source file is refused by the capture basis gate, so
    // each cites a relative file (uncheckable without a repo anchor, accepted).
    for (const e of entries) e.source_files = ['src/x.ts'];
    const counts = await importBibleEntries(provider, entries);
    expect(counts).toMatchObject({ imported: 4, skipped: 0, rejected: 0 });
    for (const id of ['bad-content-type', 'bad-content-long', 'bad-content-empty']) {
      expect((await stored(id)).content).toBe('Malformed summary.');
    }
    const arrays = await stored('bad-arrays');
    expect(arrays.recall_cues).toEqual([]);
    expect(arrays.error_signatures).toEqual(['ok']);
  });
});
