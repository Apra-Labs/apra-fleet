import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { HttpKbProvider } from '../../src/services/knowledge/http-provider.js';
import type { CodeLinkResolver, ResolvedCodeLink } from '../../src/services/knowledge/code-links.js';
import { FakeEmbedder, hashedBagOfWords } from '../helpers/fake-embedder.js';

// Feature-level integration test for hybrid kb_query (design D2b), through
// the kb_query TOOL handler (src/tools/kb-query.ts) on a real temp
// SqliteProvider: file and symbol anchors, error_text recall, the semantic
// list via a deterministic fake embedder (no model download), the fallback
// when the embedder fails, the additive contract, and the HttpKbProvider
// path. Only session-scope resolution (kb-self.ts) is stubbed to hand the
// tool these providers; the member split read is covered against a real
// MEMBER session in kb-query-hybrid-member.test.ts.
//
// Falsifiability: each anchor test also runs the same read with the anchor
// list switched off (disable_lists ['anchor'], the internal switch the
// provider honours) and asserts the target is then NOT first -- so removing
// the anchor list from SqliteProvider.hybridRows fails the files-rank and
// symbols assertions. Dropping error_text, or the error list, fails the
// error_text test (its query text shares no word with the target).
//
// Isolation: every file lives under one mkdtemp dir removed in afterAll; the
// test asserts nothing else it names was left in the system temp dir.

const kbState = vi.hoisted(() => ({ project: undefined as unknown, global: undefined as unknown, repo: '' }));

vi.mock('../../src/services/tool-scope.js', () => ({
  getSessionMemberId: () => undefined,
  getSessionKbMaintainer: () => false,
  getSessionEngineOrigin: () => false,
}));
vi.mock('../../src/services/knowledge/kb-self.js', () => {
  const providers = () => ({ project: kbState.project, global: kbState.global, projectSlug: 'hybrid-int' });
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

const ALL_TIERS = ['CONFIRMED', 'INFERRED', 'UNVERIFIED'] as const;
const SCOPE_ERROR = 'Resource not accessible by integration';

/**
 * Fake embedder that understands paraphrase: words are mapped to a shared
 * concept before hashing, so 'automobile' and 'car' embed alike while sharing
 * no keyword. Deterministic, no download.
 */
const CONCEPTS: Record<string, string> = {
  car: 'c_vehicle', automobile: 'c_vehicle', vehicle: 'c_vehicle',
  engine: 'c_motor', motor: 'c_motor',
  fix: 'c_repair', repair: 'c_repair', mend: 'c_repair', mending: 'c_repair',
  stalls: 'c_stop', stalling: 'c_stop', dies: 'c_stop',
};
class ConceptEmbedder extends FakeEmbedder {
  embed(text: string): Float32Array {
    const mapped = (text.toLowerCase().match(/[a-z0-9_]+/g) ?? []).map(w => CONCEPTS[w] ?? w).join(' ');
    return hashedBagOfWords(mapped, this.dims, this.modelId);
  }
}

let tmp: string;
let repo: string;
let n = 0;
let p: SqliteProvider;
let tmpBefore: Set<string>;

beforeAll(() => {
  tmpBefore = new Set(fs.readdirSync(os.tmpdir()));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-hybrid-int-'));
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  for (const f of ['a.ts', 'b.ts', 'c.ts', 'd.ts']) fs.writeFileSync(path.join(repo, 'src', f), `export const x = '${f}';\n`);
  kbState.repo = repo;
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  const leaked = fs.readdirSync(os.tmpdir()).filter(e => !tmpBefore.has(e) && e.startsWith('kb-hybrid-int-'));
  expect(leaked).toEqual([]);
});
beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  p = new SqliteProvider(path.join(tmp, `kb-${n++}.sqlite`), repo);
  await p.init();
  kbState.project = p;
  kbState.global = p;
});
afterEach(() => {
  p.close();
  vi.restoreAllMocks();
});

const capture = async (args: Record<string, unknown>) =>
  JSON.parse(await kbCapture(kbCaptureSchema.parse({ type: 'learning', source_files: ['src/d.ts'], ...args }))) as { id: string };
type QueryResult = { l1_results: Array<{ id: string }>; l2_expanded: Array<{ id: string }>; [k: string]: unknown };
const query = async (args: Record<string, unknown>): Promise<QueryResult> =>
  JSON.parse(await kbQuery(kbQuerySchema.parse({ confidence: [...ALL_TIERS], ...args })));
const ids = (r: { l1_results: Array<{ id: string }> }) => r.l1_results.map(e => e.id);
/** The same provider read with the anchor list off (falsifiability counterfactual). */
const withoutAnchors = async (args: { query?: string; anchor_files?: string[]; anchor_symbols?: string[] }) =>
  (await p.query({ ...args, confidence: [...ALL_TIERS], l1_only: true, limit: 20, disable_lists: ['anchor'] })).results.map(e => e.id);

describe('hybrid kb_query (integration, tool handler)', () => {
  it('files: the entry whose source_files overlap ranks first among entries with comparable text', async () => {
    // Target captured FIRST, so with equal text the keyword order (newest
    // first) puts a decoy ahead of it unless the file anchor lifts it.
    const target = await capture({ title: 'Ledger rounding rule', summary: 'ledger totals round half to even', source_files: ['src/b.ts'] });
    const decoyA = await capture({ title: 'Ledger rounding rule', summary: 'ledger totals round half to even', source_files: ['src/a.ts'] });
    const decoyC = await capture({ title: 'Ledger rounding rule', summary: 'ledger totals round half to even', source_files: ['src/c.ts'] });

    const r = await query({ query: 'ledger rounding', files: ['src/b.ts'] });
    expect(ids(r)[0]).toBe(target.id);
    expect(ids(r)).toEqual(expect.arrayContaining([decoyA.id, decoyC.id]));
    // Counterfactual: without the anchor list the target is not first.
    expect((await withoutAnchors({ query: 'ledger rounding', anchor_files: ['src/b.ts'] }))[0]).not.toBe(target.id);
  });

  it('symbols: an entry linked one code-graph hop away is returned (fake resolver)', async () => {
    const graph: Record<string, string[]> = { 'Planner.schedule': ['Queue.push'] };
    const resolver: CodeLinkResolver = async (items) => items.map((it): ResolvedCodeLink => it.kind === 'file'
      ? { ...it, resolved: true }
      : graph[it.ref] ? { ...it, resolved: true, neighbours: [...graph[it.ref]] } : { ...it, resolved: false });
    p.attachCodeResolver(resolver);
    const target = await capture({ title: 'Batching notes', summary: 'work is batched per tick', symbols: ['Planner.schedule'] });
    await capture({ title: 'Batching notes', summary: 'work is batched per tick', symbols: ['Other.thing'] });
    expect(await p.waitForCodeLinks(5000)).toBe(true);

    // Queue.push is not named by the target, only linked one hop from it.
    const r = await query({ query: 'batching', symbols: ['Queue.push'] });
    expect(ids(r)[0]).toBe(target.id);
    // Symbols alone (no query text) also return it.
    expect(ids(await query({ symbols: ['Queue.push'] }))).toEqual([target.id]);
    expect((await withoutAnchors({ query: 'batching', anchor_symbols: ['Queue.push'] }))[0]).not.toBe(target.id);
  });

  it(`error_text '${SCOPE_ERROR}' returns the entry whose error_signatures carry it`, async () => {
    const target = await capture({
      title: 'Re-mint the VCS token with push+pr',
      summary: 'A push-only token cannot open pull requests; provision it again with push+pr access.',
      error_signatures: [SCOPE_ERROR],
    });
    await capture({ title: 'Token rotation cadence', summary: 'tokens rotate hourly' });
    // Query text shares no keyword with the target.
    const r = await query({ query: 'member session stuck while creating change', error_text: SCOPE_ERROR });
    expect(ids(r)[0]).toBe(target.id);
    expect(ids(await query({ query: 'member session stuck while creating change' }))).not.toContain(target.id);
  });

  it('semantic: a paraphrase with no shared keywords returns the target via the fake embedder vector', async () => {
    const fake = new ConceptEmbedder('acme/concept-model');
    p.attachEmbedder(() => fake);
    const target = await capture({ title: 'Car engine stalls', summary: 'fix the motor by reseating the sensor' });
    await capture({ title: 'Database backup rotation', summary: 'snapshots are pruned weekly' });
    expect(await p.waitForEmbeddings(5000)).toBe(true);

    const paraphrase = 'automobile dies mending';
    // No keyword overlap: the keyword list alone finds nothing.
    expect((await p.query({ query: paraphrase, confidence: [...ALL_TIERS], disable_lists: ['semantic'] })).results).toEqual([]);
    const r = await query({ query: paraphrase });
    expect(ids(r)[0]).toBe(target.id);
  });

  it('embedder failed: the same calls return keyword + anchor results, no error', async () => {
    const fake = new ConceptEmbedder('acme/concept-model');
    p.attachEmbedder(() => fake);
    const target = await capture({
      title: 'Flaky upload retry', summary: 'uploads retry with backoff',
      source_files: ['src/a.ts'], symbols: ['Uploader.send'], error_signatures: ['ECONNRESET during upload'],
    });
    const anchored = await capture({ title: 'Unrelated config', summary: 'nothing in common', source_files: ['src/b.ts'] });
    const paraphraseTarget = await capture({ title: 'Car engine stalls', summary: 'fix the motor' });
    expect(await p.waitForEmbeddings(5000)).toBe(true);
    // Sanity: semantic works before the failure.
    expect(ids(await query({ query: 'automobile dies mending' }))[0]).toBe(paraphraseTarget.id);

    fake.fail('model load failed');
    const r = await query({ query: 'flaky upload', files: ['src/b.ts'], symbols: ['Uploader.send'], error_text: 'ECONNRESET during upload' });
    expect(ids(r)[0]).toBe(target.id);
    expect(ids(r)).toContain(anchored.id);
    // The paraphrase now has no semantic list: empty, not an error.
    expect(ids(await query({ query: 'automobile dies mending' }))).toEqual([]);
  });

  it('additive contract: a legacy call keeps its keys; explicit limit respected with and without the new inputs', async () => {
    for (let i = 0; i < 7; i++) await capture({ title: `Retention probe ${i}`, summary: 'retention probe window', source_files: ['src/a.ts'] });
    const legacy = await query({ query: 'retention probe', limit: 4 });
    expect(Object.keys(legacy).sort()).toEqual(['l1_results', 'l2_expanded']);
    expect(legacy.l1_results).toHaveLength(4);
    const legacyDefault = JSON.parse(await kbQuery(kbQuerySchema.parse({ query: 'retention probe', confidence: [...ALL_TIERS] })));
    expect(Object.keys(legacyDefault).sort()).toEqual(['l1_results', 'l2_expanded']);
    expect(legacyDefault.l1_results).toHaveLength(7);

    const hybrid = await query({ query: 'retention probe', limit: 3, files: ['src/a.ts'], symbols: ['X.y'], error_text: 'probe failed' });
    expect(Object.keys(hybrid).sort()).toEqual(['l1_results', 'l2_expanded']);
    expect(hybrid.l1_results).toHaveLength(3);
    // Same row shape either way.
    expect(Object.keys(hybrid.l1_results[0]).sort()).toEqual(Object.keys(legacy.l1_results[0]).sort());
    const related = await query({ query: 'retention probe', files: ['src/a.ts'], expand_related: true });
    expect(Object.keys(related).sort()).toEqual(['l1_results', 'l2_expanded', 'related_claims']);
  });
});

describe('hybrid kb_query against HttpKbProvider', () => {
  let server: http.Server;
  let url: string;
  const token = randomUUID();
  const queryUrls: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      if ((req.url ?? '').startsWith('/api/kb/query')) {
        queryUrls.push(req.url!);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          results: [{
            id: 'remote-1', type: 'knowledge', title: 'Remote entry', summary: 'from the remote KB', content: '',
            source_files: [], symbols: [], tags: [], confidence: 'CONFIRMED', flagged_for_review: false, contradiction_of: null,
          }],
          total: 1, l1_only: true,
        }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>(r => server.close(() => r()));
  });

  it('answers a kb_query carrying files, symbols and error_text; the inputs are not forwarded', async () => {
    const remote = new HttpKbProvider(url, token, p);
    await remote.init();
    kbState.project = remote;
    try {
      const r = await query({ query: 'remote', files: ['src/a.ts'], symbols: ['A.b'], error_text: SCOPE_ERROR });
      expect(Object.keys(r).sort()).toEqual(['l1_results', 'l2_expanded']);
      expect(ids(r)).toContain('remote-1');
      expect(queryUrls.length).toBeGreaterThan(0);
      const all = queryUrls.map(u => new URL(u, 'http://h').searchParams);
      for (const params of all) {
        for (const k of ['files', 'symbols', 'error_text', 'anchor_files', 'anchor_symbols']) expect(params.has(k)).toBe(false);
      }
      // The L1 read carried the query (the L2 read is an id lookup).
      expect(all.some(params => params.get('query') === 'remote')).toBe(true);
    } finally {
      remote.dispose();
    }
  });
});
