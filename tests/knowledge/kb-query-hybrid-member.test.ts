import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { addAgent } from '../../src/services/registry.js';
import { runWithSessionMember } from '../../src/services/tool-scope.js';
import {
  resetMemberBibleViews, setMemberViewEmbedderSourceForTests, setMemberViewCodeResolverFactory,
  type MemberViewCodeResolverFactory,
} from '../../src/services/knowledge/member-bible-view.js';
import { getKbProviders } from '../../src/services/knowledge/kb-providers.js';
import { getSelfReadKb } from '../../src/services/knowledge/kb-self.js';
import { importBibleEntries } from '../../src/services/knowledge/bible-import.js';
import type { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import type { EmbeddingProfile } from '../../src/services/knowledge/embedding/profiles.js';
import { FakeEmbedder, hashedBagOfWords } from '../helpers/fake-embedder.js';
import { kbCapture } from '../../src/tools/kb-capture.js';
import { kbQuery, kbQuerySchema } from '../../src/tools/kb-query.js';
import { makeTestLocalAgent, backupAndResetRegistry, restoreRegistry } from '../test-helpers.js';

// Hybrid kb_query inputs in a real MEMBER session (no kb-self stubs): the
// CONFIRMED-only read (member checkout bible view) and the member split read
// (CONFIRMED from the bible view + the member's own INFERRED captures) both
// accept files / symbols / error_text, pass them to every half, and keep the
// fixed bible-then-own merge order.
//
// Isolation: tests/setup.ts points APRA_FLEET_DATA_DIR at a per-run temp dir;
// the registry is backed up and restored; the checkout lives under one
// scratch root removed in afterAll.

const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const SCOPE_ERROR = 'Resource not accessible by integration';
const TITLE = 'Harbor ledger settlement order';
const SUMMARY = 'harbor ledger settles inbound before outbound';

let scratch: string;
let repo: string;
let member: string;
let ownErrorId: string;

const as = <T>(fn: () => Promise<T>): Promise<T> => runWithSessionMember(member, fn);
type Out = { l1_results: Array<{ id: string }>; l2_expanded: Array<{ id: string }> };
const memberQuery = async (args: Record<string, unknown>): Promise<Out> =>
  JSON.parse(await as(() => kbQuery(kbQuerySchema.parse(args))));
const ids = (o: Out) => o.l1_results.map(r => r.id);

function bibleEntry(id: string, file: string): Record<string, unknown> {
  return {
    id, type: 'knowledge', title: TITLE, summary: SUMMARY,
    symbols: [], source_files: [file], confidence: 'CONFIRMED', updated_at: '2026-09-01T00:00:00.000Z',
  };
}

beforeAll(async () => {
  backupAndResetRegistry();
  resetMemberBibleViews();
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-hybrid-member-'));
  repo = path.join(scratch, 'checkout');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  for (const f of ['m.ts', 'n.ts', 'o.ts']) fs.writeFileSync(path.join(repo, 'src', f), `export const v = '${f}';\n`);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', `https://example.test/kb-hybrid-member-${RUN}.git`], { cwd: repo });
  const agent = makeTestLocalAgent({ friendlyName: `kb-hybrid-${RUN}`, workFolder: repo });
  addAgent(agent);
  member = agent.id;

  // Target first in the bible, decoys after: equal text, different files.
  const entries = [
    bibleEntry('hm-target', 'src/m.ts'),
    bibleEntry('hm-decoy-1', 'src/n.ts'),
    bibleEntry('hm-decoy-2', 'src/n.ts'),
  ];
  fs.mkdirSync(path.join(repo, '.fleet'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.fleet', 'kb-canonical.json'), JSON.stringify({ version: 2, entries }), 'utf-8');

  // The member's own INFERRED capture explaining the scope error.
  const own = JSON.parse(await as(() => kbCapture({
    type: 'learning', title: 'Re-mint the VCS token with push+pr',
    summary: 'A push-only token cannot open pull requests; provision it again with push+pr access.',
    content: 'A push-only token cannot open pull requests; provision it again with push+pr access.',
    source_files: ['src/o.ts'], symbols: [], error_signatures: [SCOPE_ERROR],
  } as Parameters<typeof kbCapture>[0])));
  ownErrorId = own.id;
});

afterAll(() => {
  setMemberViewEmbedderSourceForTests(undefined);
  resetMemberBibleViews();
  restoreRegistry();
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('hybrid kb_query in a MEMBER session', () => {
  it('CONFIRMED-only read (bible view): files ranks the anchored entry first', async () => {
    const out = await memberQuery({ query: 'harbor ledger', files: ['src/m.ts'], limit: 10 });
    expect(ids(out)[0]).toBe('hm-target');
    expect(ids(out)).toEqual(expect.arrayContaining(['hm-decoy-1', 'hm-decoy-2']));
    const other = await memberQuery({ query: 'harbor ledger', files: ['src/n.ts'], limit: 10 });
    expect(ids(other)[0]).not.toBe('hm-target');
  });

  it('member split read accepts files, symbols and error_text; bible half first, own half after', async () => {
    const out = await memberQuery({
      query: 'harbor ledger', files: ['src/m.ts'], symbols: ['Nothing.here'], error_text: SCOPE_ERROR,
      confidence: ['CONFIRMED', 'INFERRED'], limit: 20,
    });
    const got = ids(out);
    // Bible half (CONFIRMED) in its own hybrid order: the anchored entry first.
    expect(got[0]).toBe('hm-target');
    // Own half: the INFERRED capture found through error_text, after the bible half.
    expect(got).toContain(ownErrorId);
    const lastBible = Math.max(...['hm-target', 'hm-decoy-1', 'hm-decoy-2'].map(id => got.indexOf(id)));
    expect(got.indexOf(ownErrorId)).toBeGreaterThan(lastBible);
  });

  it('member split read with only error_text (no query) returns the own capture', async () => {
    const out = await memberQuery({ error_text: SCOPE_ERROR, confidence: ['CONFIRMED', 'INFERRED'], limit: 5 });
    expect(ids(out)).toContain(ownErrorId);
  });
});

// Semantic list and code-link anchors for MEMBER reads (the member bible view
// gets the embedder and the code-link resolver a per-repo read has).
//
// ConceptEmbedder: a deterministic fake that maps synonyms onto one concept
// word before the hashed bag of words, so a paraphrase sharing NO keyword with
// an entry still lands close to it (what a real model does), while unrelated
// text stays far. Its profile carries a similarity floor, so the floor applies.
const SYNONYMS: Record<string, string> = {
  port: 'harbor', journal: 'ledger', reconcile: 'settles', arrivals: 'inbound', departures: 'outbound',
};
const STOP = new Set(['the', 'a', 'of', 'before', 'and']);
class ConceptEmbedder extends FakeEmbedder {
  readonly profile = { modelId: 'concept-fake', revision: 'r1', semanticFloor: 0.5 } as unknown as EmbeddingProfile;
  constructor() { super('concept-fake', 'r1', 64, 512); }
  override embed(text: string): Float32Array {
    const words = (text.toLowerCase().match(/[a-z0-9_]+/g) ?? []).map(w => SYNONYMS[w] ?? w).filter(w => !STOP.has(w));
    return hashedBagOfWords(words.join(' '), this.dims, this.modelId);
  }
}

describe('MEMBER session: semantic list and code anchors through the bible view', () => {
  const PARAPHRASE = 'port journal reconcile arrivals departures';
  const NONSENSE = 'zorbleflux quantimar plimbo';
  let semRepo: string;
  let semMember: string;
  let emb: ConceptEmbedder;
  let repoDb: SqliteProvider;
  let prevFactory: MemberViewCodeResolverFactory | null;
  const factoryCalls: string[] = [];
  const asSem = <T>(fn: () => Promise<T>): Promise<T> => runWithSessionMember(semMember, fn);
  const semQuery = async (args: Record<string, unknown>): Promise<Out> =>
    JSON.parse(await asSem(() => kbQuery(kbQuerySchema.parse(args))));
  const view = async (): Promise<SqliteProvider> =>
    (await asSem(() => getSelfReadKb())).providers.project as SqliteProvider;
  const fresh = async (): Promise<SqliteProvider> => {
    resetMemberBibleViews();
    await semQuery({ query: 'warm the view' });
    const v = await view();
    await v.waitForEmbeddings();
    await v.waitForCodeLinks();
    return v;
  };

  const target = {
    id: 'sem-target', type: 'knowledge', title: 'Harbor ledger settlement order',
    summary: 'harbor ledger settles inbound before outbound',
    symbols: ['LedgerBook.settle'], source_files: ['src/ledger.ts'], confidence: 'CONFIRMED', updated_at: '2026-09-01T00:00:00.000Z',
  };
  const other = {
    id: 'sem-other', type: 'knowledge', title: 'Gearbox sprocket lubrication cadence',
    summary: 'gearbox sprockets need grease every thousand turns',
    symbols: [], source_files: ['src/gear.ts'], confidence: 'CONFIRMED', updated_at: '2026-09-01T00:00:00.000Z',
  };
  // Only in this checkout's bible: the per-repo DB has no vectors for it.
  const fresher = {
    id: 'sem-new', type: 'knowledge', title: 'Kiln glaze firing curve',
    summary: 'kiln glaze ramps slowly through quartz inversion',
    symbols: [], source_files: ['src/kiln.ts'], confidence: 'CONFIRMED', updated_at: '2026-09-01T00:00:00.000Z',
  };

  beforeAll(async () => {
    semRepo = path.join(scratch, 'sem-checkout');
    fs.mkdirSync(path.join(semRepo, 'src'), { recursive: true });
    for (const f of ['ledger.ts', 'gear.ts', 'kiln.ts']) fs.writeFileSync(path.join(semRepo, 'src', f), `export const v = '${f}';\n`);
    execFileSync('git', ['init', '-q'], { cwd: semRepo });
    execFileSync('git', ['remote', 'add', 'origin', `https://example.test/kb-hybrid-member-sem-${RUN}.git`], { cwd: semRepo });
    const agent = makeTestLocalAgent({ friendlyName: `kb-hybrid-sem-${RUN}`, workFolder: semRepo });
    addAgent(agent);
    semMember = agent.id;
    fs.mkdirSync(path.join(semRepo, '.fleet'), { recursive: true });
    fs.writeFileSync(path.join(semRepo, '.fleet', 'kb-canonical.json'),
      JSON.stringify({ version: 2, entries: [target, other, fresher] }), 'utf-8');

    // The per-repo DB already holds (and has embedded) two of the three
    // bible entries under the same model, as after a kb_import on this host.
    emb = new ConceptEmbedder();
    repoDb = (await getKbProviders(semRepo)).project as SqliteProvider;
    repoDb.attachEmbedder(() => emb);
    await importBibleEntries(repoDb, [target, other], { verbatim: true });
    expect(await repoDb.waitForEmbeddings()).toBe(true);
    expect(repoDb.vectorStore.entryVectors('sem-target').length).toBeGreaterThan(0);

    prevFactory = setMemberViewCodeResolverFactory((folder) => {
      factoryCalls.push(folder);
      return async (items) => items.map(it => (it.kind === 'symbol' && it.ref === 'LedgerBook.settle'
        ? { ...it, resolved: true, neighbours: ['HarborClerk.post'] }
        : { ...it, resolved: it.kind === 'file' }));
    });
  });

  afterAll(() => {
    repoDb.attachEmbedder(null);
    setMemberViewCodeResolverFactory(prevFactory);
    setMemberViewEmbedderSourceForTests(undefined);
  });

  it('without an embedder the paraphrase finds nothing (no shared keyword)', async () => {
    setMemberViewEmbedderSourceForTests(null);
    await fresh();
    const out = await semQuery({ query: PARAPHRASE, limit: 10 });
    expect(ids(out)).not.toContain('sem-target');
  });

  it('a paraphrase with no shared keyword returns the bible entry first', async () => {
    setMemberViewEmbedderSourceForTests(() => emb);
    await fresh();
    const out = await semQuery({ query: PARAPHRASE, limit: 5 });
    expect(ids(out)[0]).toBe('sem-target');
  });

  it('building the view re-embeds only the entry the per-repo DB has no vectors for', async () => {
    setMemberViewEmbedderSourceForTests(() => emb);
    emb.calls = [];
    const v = await fresh();
    const embedded = emb.calls.flat();
    const newInputs = v.entryVectorInputs('sem-new', 512)!.map(i => i.embedText);
    expect(embedded.sort()).toEqual([...newInputs].sort());
    // Adopted vectors are the per-repo DB's (same chunks), and all three are live.
    expect(v.vectorStore.entryVectors('sem-target').map(x => x.textHash).sort())
      .toEqual(repoDb.vectorStore.entryVectors('sem-target').map(x => x.textHash).sort());
    expect(v.vectorIndexStatus().pending).toBe(0);
    expect(v.vectorStore.entryVectors('sem-new').length).toBeGreaterThan(0);
  });

  it('the similarity floor applies to member reads: a nonsense query returns 0 rows', async () => {
    setMemberViewEmbedderSourceForTests(() => emb);
    await fresh();
    const out = await semQuery({ query: NONSENSE, limit: 10 });
    expect(ids(out)).toEqual([]);
  });

  it('local member: code-link anchors (one graph hop) apply to member reads', async () => {
    setMemberViewEmbedderSourceForTests(null);
    factoryCalls.length = 0;
    const v = await fresh();
    expect(factoryCalls.length).toBeGreaterThan(0);
    expect(v.hasCodeResolver).toBe(true);
    expect(v.codeLinksOf('sem-target').some(l => l.kind === 'symbol' && l.resolved)).toBe(true);
    // HarborClerk.post is in no entry's symbols: only the code link reaches it.
    const out = await semQuery({ query: 'gearbox', symbols: ['HarborClerk.post'], limit: 10 });
    expect(ids(out)).toContain('sem-target');
  });
});
