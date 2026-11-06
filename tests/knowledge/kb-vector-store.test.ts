import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import {
  buildVectorInputs,
  chunkSizing,
  errorSignatureQualifies,
  entryHeader,
  splitTriedSections,
  TRIED_LABEL,
} from '../../src/services/knowledge/embedding/chunker.js';
import {
  decodeFloat16,
  encodeFloat16,
  float16BitsToFloat32,
  float32ToFloat16Bits,
  type VectorModel,
} from '../../src/services/knowledge/embedding/vector-store.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';

// Chunker, float16 storage and best-vector scoring of the KB vector store
// (design D2a vector half). Store tests run against a real SqliteProvider on a
// temp kb.sqlite; every file lives under one mkdtemp dir removed in afterAll.

const TITLE = 'Retry loop in the member sync';

function paragraph(seed: number, words = 60): string {
  return Array.from({ length: words }, (_, i) => `word${seed}x${i}`).join(' ') + '.';
}

describe('chunker', () => {
  it('splits long content into multiple overlapping chunks, each starting with the title', () => {
    const content = [1, 2, 3, 4, 5, 6, 7, 8].map(n => paragraph(n)).join('\n\n');
    const inputs = buildVectorInputs({ title: TITLE, summary: 'short summary', content }, 512);
    const chunks = inputs.filter(i => i.kind === 'chunk');
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) expect(c.text.startsWith(TITLE + '\n')).toBe(true);
    // Overlap: each chunk after the first starts with words the previous chunk ended with.
    for (let i = 1; i < chunks.length; i++) {
      const prevWords = chunks[i - 1].text.split(/\s+/);
      const firstBodyWord = chunks[i].text.slice(TITLE.length + 1).split(/\s+/)[0];
      expect(prevWords).toContain(firstBodyWord);
    }
    // Ordinals are 0..n-1 in order.
    expect(chunks.map(c => c.ordinal)).toEqual(chunks.map((_, i) => i));
    // Every chunk stays inside the target (230 tokens ~ 920 chars) plus the title.
    const { targetTokens } = chunkSizing(512);
    expect(targetTokens).toBeGreaterThanOrEqual(200);
    expect(targetTokens).toBeLessThanOrEqual(250);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(targetTokens * 4 + TITLE.length + 1 + 4 * 40);
  });

  it('turns a Tried (failed) section into its own labelled chunk, cut out of the normal chunks', () => {
    const content = [
      'The sync loop retried forever when the remote was gone.',
      '',
      '**Tried (failed):** raising the retry budget to 50 just delayed the hang.',
      'Increasing the backoff also failed.',
      '',
      'Fix: bound the loop by wall clock.',
    ].join('\n');
    const { rest, tried } = splitTriedSections(content);
    expect(tried).toHaveLength(1);
    expect(tried[0]).toContain('raising the retry budget');
    expect(tried[0]).toContain('Increasing the backoff');
    expect(tried[0]).not.toContain('bound the loop');
    expect(rest).not.toContain('raising the retry budget');
    expect(rest).toContain('Fix: bound the loop');

    const inputs = buildVectorInputs({ title: TITLE, summary: 's', content }, 512);
    const triedInputs = inputs.filter(i => i.kind === 'tried');
    expect(triedInputs).toHaveLength(1);
    expect(triedInputs[0].text.startsWith(`${TITLE}\n${TRIED_LABEL}: `)).toBe(true);
    expect(inputs.filter(i => i.kind === 'chunk').some(c => c.text.includes('retry budget'))).toBe(false);
  });

  it('skips short error signatures and keeps meaningful ones', () => {
    expect(errorSignatureQualifies('ENOENT')).toBe(false);
    expect(errorSignatureQualifies('timeout')).toBe(false);
    expect(errorSignatureQualifies('EPIPE write failed')).toBe(true); // 3 words
    expect(errorSignatureQualifies('SqliteError:database')).toBe(true); // 20 chars
    const inputs = buildVectorInputs({
      title: TITLE, summary: 's', error_signatures: ['ENOENT', 'database is locked (SQLITE_BUSY)'],
    }, 512);
    const errors = inputs.filter(i => i.kind === 'error');
    expect(errors.map(e => e.text)).toEqual(['database is locked (SQLITE_BUSY)']);
  });

  it('builds one title_summary and one input per recall cue, with the header line in front', () => {
    const inputs = buildVectorInputs({
      title: TITLE, summary: 'the summary', recall_cues: ['sync hangs forever', 'retry storm'],
      module: 'fleet-sprint', trigger: 'bug-fix',
    }, 512);
    expect(inputs.filter(i => i.kind === 'title_summary').map(i => i.text)).toEqual([`${TITLE}\nthe summary`]);
    expect(inputs.filter(i => i.kind === 'cue').map(i => i.text)).toEqual(['sync hangs forever', 'retry storm']);
    for (const i of inputs) expect(i.embedText).toBe(`[fleet-sprint] trigger: bug-fix\n${i.text}`);
    expect(entryHeader({ title: 't', summary: 's', source_files: ['src/a/b.ts'], type: 'learning' }))
      .toBe('[src/a] trigger: learning');
  });

  it('grows the chunk size with a larger profile token limit', () => {
    const content = Array.from({ length: 30 }, (_, n) => paragraph(n)).join('\n\n');
    const small = buildVectorInputs({ title: TITLE, summary: 's', content }, 512).filter(i => i.kind === 'chunk');
    const large = buildVectorInputs({ title: TITLE, summary: 's', content }, 8192).filter(i => i.kind === 'chunk');
    expect(chunkSizing(8192).targetTokens).toBeGreaterThan(chunkSizing(512).targetTokens);
    expect(large.length).toBeLessThan(small.length);
    const maxLen = (xs: { text: string }[]) => Math.max(...xs.map(x => x.text.length));
    expect(maxLen(large)).toBeGreaterThan(maxLen(small));
  });
});

describe('float16', () => {
  it('round-trips unit vectors within 1e-3 of the float32 input', () => {
    let seed = 7;
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5; };
    for (let n = 0; n < 50; n++) {
      const v = new Float32Array(384).map(() => rand());
      const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
      for (let i = 0; i < v.length; i++) v[i] /= norm;
      const back = decodeFloat16(encodeFloat16(v));
      expect(back.length).toBe(v.length);
      for (let i = 0; i < v.length; i++) expect(Math.abs(back[i] - v[i])).toBeLessThan(1e-3);
    }
  });

  it('encodes the special values', () => {
    expect(float16BitsToFloat32(float32ToFloat16Bits(1))).toBe(1);
    expect(float16BitsToFloat32(float32ToFloat16Bits(-0.5))).toBe(-0.5);
    expect(float16BitsToFloat32(float32ToFloat16Bits(0))).toBe(0);
    expect(float16BitsToFloat32(float32ToFloat16Bits(1e6))).toBe(Infinity);
    expect(Number.isNaN(float16BitsToFloat32(float32ToFloat16Bits(NaN)))).toBe(true);
    expect(float16BitsToFloat32(float32ToFloat16Bits(1e-6))).toBeCloseTo(1e-6, 7);
  });
});

describe('vector store scoring', () => {
  let tmp: string;
  let p: SqliteProvider;
  const A: VectorModel = { modelId: 'acme/model-a', revision: 'r1', dims: 4 };
  const B: VectorModel = { modelId: 'acme/model-b', revision: 'r1', dims: 4 };

  function input(over: Partial<KBEntryInput>): KBEntryInput {
    return {
      type: 'knowledge', title: 't', summary: 's', content: 'c', source_files: ['src/a.ts'], symbols: [], tags: [],
      content_hash: '', content_hash_type: 'sha256', flagged_for_review: false, author: 'vec-test', source: 'doer',
      confidence: 'INFERRED', ...over,
    };
  }
  const v = (...xs: number[]) => Float32Array.from(xs);

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-vector-store-'));
    fs.mkdirSync(path.join(tmp, 'repo', 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'repo', 'src', 'a.ts'), 'export const a = 1;\n');
    p = new SqliteProvider(path.join(tmp, 'kb.sqlite'), path.join(tmp, 'repo'));
    await p.init();
  });
  afterAll(() => {
    p.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('scores under model B without ever reading model A rows', async () => {
    const { id } = await p.capture(input({ title: 'iso entry', summary: 'isolation', symbols: ['Iso'] }));
    // Model A: a vector identical to the query. Model B: an orthogonal one.
    p.vectorStore.replaceEntryVectors(id, A, [{ kind: 'title_summary', ordinal: 0, textHash: 'a', vector: v(1, 0, 0, 0) }]);
    p.vectorStore.replaceEntryVectors(id, B, [{ kind: 'title_summary', ordinal: 0, textHash: 'b', vector: v(0, 1, 0, 0) }]);
    const underB = p.scoreVectorsForModel(v(1, 0, 0, 0), B, { entryIds: [id] });
    expect(underB).toHaveLength(1);
    expect(underB[0].score).toBeCloseTo(0, 5); // had A been read, the best score would be 1
    const underA = p.scoreVectorsForModel(v(1, 0, 0, 0), A, { entryIds: [id] });
    expect(underA[0].score).toBeCloseTo(1, 3);
    // Same id, other revision or dims: also never mixed in.
    expect(p.scoreVectorsForModel(v(1, 0, 0, 0), { ...A, revision: 'r2' }, { entryIds: [id] })).toEqual([]);
  });

  it('scores an entry by its best chunk, not by its unrelated chunks', async () => {
    const strong = await p.capture(input({ title: 'one strong chunk', summary: 'best-chunk entry', symbols: ['Strong'] }));
    const flat = await p.capture(input({ title: 'uniformly weak', summary: 'average entry', symbols: ['Weak'] }));
    const q = v(0, 0, 1, 0);
    p.vectorStore.replaceEntryVectors(strong.id, A, [
      { kind: 'chunk', ordinal: 0, textHash: 'x', vector: v(1, 0, 0, 0) },
      { kind: 'chunk', ordinal: 1, textHash: 'x', vector: v(0, 1, 0, 0) },
      { kind: 'chunk', ordinal: 2, textHash: 'x', vector: v(0, 0, 0.96, 0.28) },
      { kind: 'chunk', ordinal: 3, textHash: 'x', vector: v(0, 0, 0, 1) },
    ]);
    p.vectorStore.replaceEntryVectors(flat.id, A, [
      { kind: 'chunk', ordinal: 0, textHash: 'x', vector: v(0.5, 0.5, 0.5, 0.5) },
      { kind: 'chunk', ordinal: 1, textHash: 'x', vector: v(0.5, 0.5, 0.5, 0.5) },
    ]);
    const scores = p.scoreVectorsForModel(q, A, { entryIds: [strong.id, flat.id] });
    expect(scores.map(s => s.entry_id)).toEqual([strong.id, flat.id]);
    expect(scores[0].kind).toBe('chunk');
    expect(scores[0].ordinal).toBe(2);
    expect(scores[0].score).toBeCloseTo(0.96, 2);
  });

  it('removes vectors when an entry is retired or deleted', async () => {
    const { id } = await p.capture(input({ title: 'to retire', summary: 'retire me', symbols: ['Retire'] }));
    p.vectorStore.replaceEntryVectors(id, A, [{ kind: 'title_summary', ordinal: 0, textHash: 'r', vector: v(1, 0, 0, 0) }]);
    expect(p.vectorStore.entryVectors(id)).toHaveLength(1);
    await p.discard([id]);
    expect(p.vectorStore.entryVectors(id)).toHaveLength(0);
  });
});
