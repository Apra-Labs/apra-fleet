import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { cosine } from '../../src/services/knowledge/embedding/vector-store.js';
import type { CodeLinkResolver, ResolvedCodeLink } from '../../src/services/knowledge/code-links.js';
import { FakeEmbedder, until } from '../helpers/fake-embedder.js';

// Integration test for the vector-index half of hybrid search (design D2a):
// chunking, best-vector scoring, model isolation, non-blocking capture, a
// failed embedder, and code links, against a real SqliteProvider on a temp
// kb.sqlite with a deterministic fake embedder (hashed bag of words, no model
// download) through the embedder seam.
//
// Scope: kb_query has no vector path yet (the hybrid-fusion work adds it), so
// vector retrieval is checked through the provider's best-vector scoring
// helper (scoreVectors: brute-force cosine over the ACTIVE model's vectors).
// kb_capture, kb_query and kb_freshness_sweep run as the real tool handlers;
// only session-scope resolution is stubbed to hand them the temp provider.
//
// Falsifiability: removing the model-id filter from VectorStore.score (the
// "v.model_id = ?" predicate) makes the model-isolation test fail -- model A's
// rows then score under model B.
//
// Isolation: every file lives under one mkdtemp dir removed in afterAll; the
// test asserts nothing else was written to the system temp dir by name.

const kbState = vi.hoisted(() => ({ p: undefined as unknown, repo: '' }));

vi.mock('../../src/services/tool-scope.js', () => ({
  getSessionMemberId: () => undefined,
  getSessionKbMaintainer: () => false,
}));
vi.mock('../../src/services/knowledge/kb-self.js', () => {
  const providers = () => ({ project: kbState.p, global: kbState.p, projectSlug: 'vec-int' });
  return {
    getSelfKbProviders: async () => providers(),
    getSelfReadKb: async () => ({ providers: providers(), anchor: { folder: kbState.repo }, memberView: false }),
    getMemberSplitRead: async () => null, // not a member session
    mergeSplitById: (a: unknown[]) => a,
    memberOwnerTag: () => undefined,
  };
});

import { kbCapture, kbCaptureSchema } from '../../src/tools/kb-capture.js';
import { kbQuery, kbQuerySchema } from '../../src/tools/kb-query.js';
import { kbFreshnessSweep, kbFreshnessSweepSchema } from '../../src/tools/kb-freshness-sweep.js';

let tmp: string;
let repo: string;
let n = 0;
let p: SqliteProvider;
let tmpEntriesBefore: Set<string>;

beforeAll(() => {
  tmpEntriesBefore = new Set(fs.readdirSync(os.tmpdir()));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-vectors-int-'));
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  for (const f of ['a.ts', 'b.ts', 'c.ts']) fs.writeFileSync(path.join(repo, 'src', f), `export const x = '${f}';\n`);
  kbState.repo = repo;
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  const leaked = fs.readdirSync(os.tmpdir()).filter(e => !tmpEntriesBefore.has(e) && e.startsWith('kb-vectors-int-'));
  expect(leaked).toEqual([]);
});
beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  p = new SqliteProvider(path.join(tmp, `kb-${n++}.sqlite`), repo);
  await p.init();
  kbState.p = p;
});
afterEach(() => {
  p.close();
  vi.restoreAllMocks();
});

const capture = async (args: Record<string, unknown>) =>
  JSON.parse(await kbCapture(kbCaptureSchema.parse({ type: 'learning', source_files: ['src/a.ts'], ...args })));
const keywordQuery = async (q: string) =>
  JSON.parse(await kbQuery(kbQuerySchema.parse({ query: q, confidence: ['CONFIRMED', 'INFERRED', 'UNVERIFIED'] }))) as {
    l1_results: { id: string }[];
  };

/** Paragraph n: distinct words, so each chunk's bag of words differs. */
function paragraph(tag: string, words = 70): string {
  return Array.from({ length: words }, (_, i) => `${tag}w${i}`).join(' ') + '.';
}

describe('KB vectors (integration)', () => {
  it('chunks long content and scores the entry by its best chunk (the third)', async () => {
    const fake = new FakeEmbedder('acme/model-a');
    p.attachEmbedder(() => fake);
    const content = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'].map(t => paragraph(t)).join('\n\n');
    const { id } = await capture({ title: 'Long chunked entry', summary: 'many chunks', content, symbols: ['LongChunked'] });
    const other = await capture({ title: 'Unrelated short entry', summary: 'nothing in common', symbols: ['OtherThing'], source_files: ['src/b.ts'] });
    expect(await p.waitForEmbeddings(5000)).toBe(true);

    const inputs = p.entryVectorInputs(id, fake.tokenLimit)!;
    const chunks = inputs.filter(i => i.kind === 'chunk');
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const c of chunks) expect(c.text.startsWith('Long chunked entry\n')).toBe(true);

    // A query vector that matches only the third chunk.
    const third = chunks[2];
    const query = fake.embed(third.embedText);
    const scores = p.scoreVectors(query);
    expect(scores[0].entry_id).toBe(id);
    expect(scores[0].kind).toBe('chunk');
    expect(scores[0].ordinal).toBe(2);
    const stored = p.vectorStore.entryVectors(id).find(v => v.kind === 'chunk' && v.ordinal === 2)!;
    expect(scores[0].score).toBeCloseTo(cosine(query, stored.vector), 6);
    // Every other vector of the entry is a worse match than the third chunk.
    for (const v of p.vectorStore.entryVectors(id)) {
      if (!(v.kind === 'chunk' && v.ordinal === 2)) expect(cosine(query, v.vector)).toBeLessThan(scores[0].score);
    }
    const otherScore = scores.find(s => s.entry_id === other.id);
    expect(otherScore === undefined || otherScore.score < scores[0].score).toBe(true);
  });

  it('never compares vectors of different models: B ignores A rows until the rebuild re-embeds under B', async () => {
    const a = new FakeEmbedder('acme/model-a');
    p.attachEmbedder(() => a);
    const { id } = await capture({ title: 'Isolation entry', summary: 'model isolation matters', symbols: ['ModelIsolation'] });
    expect(await p.waitForEmbeddings(5000)).toBe(true);
    const modelA = { modelId: 'acme/model-a', revision: 'r1', dims: 64 };
    expect(p.vectorStore.count(modelA)).toBeGreaterThan(0);
    const inputs = p.entryVectorInputs(id, a.tokenLimit)!;
    expect(p.scoreVectors(a.embed(inputs[0].embedText))[0].entry_id).toBe(id);

    // Switch the active profile to model B; hold its embedding open.
    const b = new FakeEmbedder('acme/model-b');
    const release = b.hold();
    p.attachEmbedder(() => b);
    await until(() => b.calls.length > 0);
    // A's rows are still stored, same revision and dims -- and never read under B.
    expect(p.vectorStore.count(modelA)).toBeGreaterThan(0);
    expect(p.scoreVectors(b.embed(inputs[0].embedText))).toEqual([]);
    // Even a query equal to A's own vector does not reach A's rows under B.
    expect(p.scoreVectors(a.embed(inputs[0].embedText))).toEqual([]);

    release();
    expect(await p.waitForEmbeddings(5000)).toBe(true);
    const underB = p.scoreVectors(b.embed(inputs[0].embedText));
    expect(underB[0].entry_id).toBe(id);
    expect(underB[0].score).toBeGreaterThan(0.99);
    expect(p.vectorStore.count(modelA)).toBe(0);
  });

  it('kb_capture resolves before its embedding; the entry is keyword-queryable; vectors appear after release', async () => {
    const fake = new FakeEmbedder('acme/model-a');
    p.attachEmbedder(() => fake);
    await p.waitForEmbeddings();
    const release = fake.hold();
    const pending = capture({ title: 'Held capture entry', summary: 'zephyr gateway drops frames', symbols: ['ZephyrGateway'] });
    let timer: NodeJS.Timeout | undefined;
    const raced = await Promise.race([
      pending.then(() => 'captured'),
      new Promise<string>(r => { timer = setTimeout(() => r('still waiting'), 1500); }),
    ]);
    clearTimeout(timer);
    expect(raced).toBe('captured');
    const { id } = await pending;
    await until(() => fake.calls.length > 0);
    expect((await keywordQuery('zephyr gateway')).l1_results.map(e => e.id)).toContain(id);
    expect(p.vectorStore.entryVectors(id)).toEqual([]);
    release();
    expect(await p.waitForEmbeddings(5000)).toBe(true);
    expect(p.vectorStore.entryVectors(id).length).toBeGreaterThan(0);
  });

  it('with the embedder failed, kb_capture and keyword kb_query still succeed', async () => {
    const fake = new FakeEmbedder('acme/model-a');
    fake.fail('model download failed: HTTP 503');
    p.attachEmbedder(() => fake);
    const { id } = await capture({ title: 'Failed embedder entry', summary: 'quokka parser rejects tabs', symbols: ['QuokkaParser'] });
    expect(id).toBeTruthy();
    expect(await p.waitForEmbeddings(5000)).toBe(true);
    expect((await keywordQuery('quokka parser')).l1_results.map(e => e.id)).toContain(id);
    expect(p.vectorStore.entryVectors(id)).toEqual([]);
    expect(p.scoreVectors(fake.embed('quokka parser'))).toEqual([]);
  });

  it('code links: capture stores them, the freshness sweep re-resolves, lookupAnchors finds file and one-hop entries', async () => {
    const graph: Record<string, string[]> = { applyPatch: ['readPatch'], loadConfig: ['parseYaml'] };
    const resolver: CodeLinkResolver = async (items) => items.map((it): ResolvedCodeLink => it.kind === 'file'
      ? { ...it, resolved: true }
      : graph[it.ref] ? { ...it, resolved: true, neighbours: [...graph[it.ref]] } : { ...it, resolved: false });
    p.attachCodeResolver(resolver);

    const fileEntry = await capture({ title: 'Config loader entry', summary: 'config loading', symbols: ['loadConfig'], source_files: ['src/b.ts'] });
    const symEntry = await capture({ title: 'Patch apply entry', summary: 'patch application', symbols: ['applyPatch', 'GhostSymbol'], source_files: ['src/c.ts'] });
    expect(await p.waitForCodeLinks(5000)).toBe(true);
    expect(p.codeLinksOf(symEntry.id)).toEqual([
      { kind: 'file', ref: 'src/c.ts', resolved: true, neighbours: [] },
      { kind: 'symbol', ref: 'GhostSymbol', resolved: false, neighbours: [] },
      { kind: 'symbol', ref: 'applyPatch', resolved: true, neighbours: ['readPatch'] },
    ]);

    // The sweep re-resolves: the graph moved on.
    graph.applyPatch = ['validateHunk'];
    JSON.parse(await kbFreshnessSweep(kbFreshnessSweepSchema.parse({})));
    expect(await p.waitForCodeLinks(5000)).toBe(true);
    expect(p.codeLinksOf(symEntry.id).find(l => l.ref === 'applyPatch')?.neighbours).toEqual(['validateHunk']);

    expect(p.lookupAnchors(['src/b.ts'], [])).toEqual([fileEntry.id]);
    expect(p.lookupAnchors([], ['validateHunk'])).toEqual([symEntry.id]);
    expect(p.lookupAnchors([], ['readPatch'])).toEqual([]); // stale neighbour gone
    expect(p.lookupAnchors(['src/zzz.ts'], ['somethingElse'])).toEqual([]);
  });
});
