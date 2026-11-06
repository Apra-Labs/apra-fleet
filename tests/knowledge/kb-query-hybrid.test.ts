import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import {
  RRF_K, hybridOrder, ranksFromOrder, ranksFromScores, reciprocalRankFusion, trustPrior,
} from '../../src/services/knowledge/hybrid-rank.js';
import { FakeEmbedder } from '../helpers/fake-embedder.js';

// Hybrid kb_query (design D2b): RRF of keyword, error-signature, semantic and
// anchor lists plus trust priors, through the real kb_query tool handler on a
// temp SqliteProvider. Only session-scope resolution is stubbed.
//
// Falsifiability: removing the anchor list from SqliteProvider.hybridRows
// (or passing disable_lists ['anchor']) makes the files-rank test fail --
// the two entries then tie on text and keep keyword order for both files
// arguments, so one of the two "ranked first" assertions fails. Removing the
// error list makes the error_text test fail (the query text alone matches
// nothing in the target).

const kbState = vi.hoisted(() => ({ p: undefined as unknown, repo: '' }));

vi.mock('../../src/services/tool-scope.js', () => ({
  getSessionMemberId: () => undefined,
  getSessionKbMaintainer: () => false,
  getSessionEngineOrigin: () => false,
}));
vi.mock('../../src/services/knowledge/kb-self.js', () => {
  const providers = () => ({ project: kbState.p, global: kbState.p, projectSlug: 'hybrid' });
  return {
    getSelfKbProviders: async () => providers(),
    getSelfReadKb: async () => ({ providers: providers(), anchor: { folder: kbState.repo }, memberView: false }),
    getMemberSplitRead: async () => null,
    mergeSplitById: (a: unknown[]) => a,
    memberOwnerTag: () => undefined,
  };
});

import { kbCapture, kbCaptureSchema } from '../../src/tools/kb-capture.js';
import { kbQuery, kbQuerySchema } from '../../src/tools/kb-query.js';

const ALL_TIERS = ['CONFIRMED', 'INFERRED', 'UNVERIFIED'];
let tmp: string;
let repo: string;
let n = 0;
let p: SqliteProvider;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-query-hybrid-'));
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  for (const f of ['a.ts', 'b.ts', 'c.ts']) fs.writeFileSync(path.join(repo, 'src', f), `export const x = '${f}';\n`);
  kbState.repo = repo;
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
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
  JSON.parse(await kbCapture(kbCaptureSchema.parse({ type: 'learning', source_files: ['src/c.ts'], ...args }))) as { id: string };
const query = async (args: Record<string, unknown>) =>
  JSON.parse(await kbQuery(kbQuerySchema.parse({ confidence: ALL_TIERS, ...args }))) as Record<string, unknown> & {
    l1_results: { id: string }[];
  };
const ids = (r: { l1_results: { id: string }[] }) => r.l1_results.map(e => e.id);

describe('hybrid-rank (pure)', () => {
  it('fuses by 1/(k+rank) and shares ranks on ties', () => {
    expect(RRF_K).toBe(60);
    const tied = ranksFromScores(new Map([['a', 2], ['b', 2], ['c', 1]]));
    expect([...tied.entries()]).toEqual([['a', 1], ['b', 1], ['c', 3]]);
    const fused = reciprocalRankFusion([
      { name: 'keyword', ranks: ranksFromOrder(['x', 'y']) },
      { name: 'anchor', ranks: ranksFromOrder(['y']) },
    ]);
    expect(fused.get('x')).toBeCloseTo(1 / 61, 12);
    expect(fused.get('y')).toBeCloseTo(1 / 62 + 1 / 61, 12);
    expect(hybridOrder(fused, () => 1)).toEqual(['y', 'x']);
  });

  it('trust priors: CONFIRMED up, stale down, use_count a small capped lift', () => {
    expect(trustPrior({ confidence: 'CONFIRMED' })).toBeGreaterThan(trustPrior({ confidence: 'INFERRED' }));
    expect(trustPrior({ confidence: 'INFERRED', stale: true })).toBeLessThan(trustPrior({ confidence: 'INFERRED' }));
    expect(trustPrior({ use_count: 10 })).toBeGreaterThan(1);
    expect(trustPrior({ use_count: 1e9 })).toBeLessThanOrEqual(1.05 + 1e-9);
    // CONFIRMED at rank 2 beats a non-CONFIRMED rank 1 of the same list.
    const fused = reciprocalRankFusion([{ name: 'keyword', ranks: ranksFromOrder(['inf', 'conf']) }]);
    const conf: Record<string, string> = { inf: 'INFERRED', conf: 'CONFIRMED' };
    expect(hybridOrder(fused, id => trustPrior({ confidence: conf[id] }))).toEqual(['conf', 'inf']);
  });
});

describe('kb_query hybrid inputs', () => {
  it('files: the entry whose source_files overlap ranks above an otherwise-equal entry', async () => {
    const a = await capture({ title: 'Widget cache eviction policy', summary: 'How the widget cache evicts entries', source_files: ['src/a.ts'] });
    const b = await capture({ title: 'Widget cache eviction policy', summary: 'How the widget cache evicts entries', source_files: ['src/b.ts'] });
    const forA = await query({ query: 'widget cache eviction', files: ['src/a.ts'] });
    const forB = await query({ query: 'widget cache eviction', files: ['./src/b.ts'] });
    expect(ids(forA)[0]).toBe(a.id);
    expect(ids(forB)[0]).toBe(b.id);
    expect(ids(forA)).toContain(b.id);
  });

  it('symbols: an entry naming the symbol ranks first', async () => {
    // Target captured FIRST: equal text then ranks the newer decoy first
    // unless the symbol anchor lifts the target.
    const target = await capture({ title: 'Parser recovery notes', summary: 'parser recovers after a bad token', symbols: ['Qux.alpha'] });
    await capture({ title: 'Parser recovery notes', summary: 'parser recovers after a bad token', symbols: ['Qux.beta'] });
    const r = await query({ query: 'parser recovery', symbols: ['Qux.alpha'] });
    expect(ids(r)[0]).toBe(target.id);
  });

  it('error_text: returns the entry whose error_signatures carry the error', async () => {
    const target = await capture({
      title: 'Mint the VCS token with push+pr to open PRs',
      summary: 'A push-only token cannot create pull requests or dispatch workflows',
      error_signatures: ['Resource not accessible by integration'],
    });
    await capture({ title: 'Unrelated build note', summary: 'the build caches node modules' });
    const withError = await query({ query: 'deployment broke overnight', error_text: 'Resource not accessible by integration' });
    expect(ids(withError)[0]).toBe(target.id);
    // Falsifiable: the same call without error_text does not find it.
    const without = await query({ query: 'deployment broke overnight' });
    expect(ids(without)).not.toContain(target.id);
    // error_text alone (no query) is a valid call.
    const alone = await query({ error_text: 'Resource not accessible by integration' });
    expect(ids(alone)[0]).toBe(target.id);
  });

  it('semantic: with a ready embedder a keyword-free paraphrase finds the entry', async () => {
    const fake = new FakeEmbedder('acme/fake-model');
    p.attachEmbedder(() => fake);
    const target = await capture({ title: 'zebra quokka narwhal', summary: 'ocelot lemur' });
    await capture({ title: 'Different topic', summary: 'nothing in common here' });
    expect(await p.waitForEmbeddings(5000)).toBe(true);
    // Fake vectors are hashed bags of words, so the semantic list is checked
    // with the keyword list switched off: the hit can only come from vectors.
    const rows = await p.query({ query: 'zebra quokka narwhal ocelot lemur', confidence: ['INFERRED'], disable_lists: ['keyword'], l1_only: true });
    expect(rows.results[0].id).toBe(target.id);
  });

  it('embedder failed: all three inputs return keyword + anchor results, no error', async () => {
    const fake = new FakeEmbedder('acme/fake-model');
    p.attachEmbedder(() => fake);
    const target = await capture({
      title: 'Retry the flaky upload', summary: 'upload retries with backoff',
      source_files: ['src/a.ts'], symbols: ['Uploader.send'], error_signatures: ['ECONNRESET during upload'],
    });
    const anchorOnly = await capture({ title: 'Something else', summary: 'unrelated', source_files: ['src/b.ts'] });
    expect(await p.waitForEmbeddings(5000)).toBe(true);
    fake.fail('model load failed');
    const r = await query({
      query: 'flaky upload', files: ['src/b.ts'], symbols: ['Uploader.send'], error_text: 'ECONNRESET during upload',
    });
    expect(ids(r)[0]).toBe(target.id);
    expect(ids(r)).toContain(anchorOnly.id);
  });

  it('explicit limit is respected and a call without the new inputs keeps its keys', async () => {
    for (let i = 0; i < 6; i++) {
      await capture({ title: `Limit probe entry ${i}`, summary: 'limit probe summary', source_files: ['src/a.ts'] });
    }
    const legacy = await query({ query: 'limit probe', limit: 3 });
    expect(Object.keys(legacy).sort()).toEqual(['l1_results', 'l2_expanded']);
    expect(legacy.l1_results).toHaveLength(3);
    const hybrid = await query({ query: 'limit probe', limit: 2, files: ['src/a.ts'], error_text: 'probe failure' });
    expect(Object.keys(hybrid).sort()).toEqual(['l1_results', 'l2_expanded']);
    expect(hybrid.l1_results).toHaveLength(2);
  });

  it('filters still apply to anchor-only hits (type filter)', async () => {
    const runbook = await capture({ type: 'runbook', title: 'Rotate keys', summary: 'key rotation steps', source_files: ['src/a.ts'] });
    const learning = await capture({ type: 'learning', title: 'Key rotation gotcha', summary: 'old keys linger', source_files: ['src/a.ts'] });
    const r = await query({ files: ['src/a.ts'], type: 'runbook' });
    expect(ids(r)).toContain(runbook.id);
    expect(ids(r)).not.toContain(learning.id);
  });
});
