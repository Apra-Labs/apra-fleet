import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { HttpKbProvider } from '../../src/services/knowledge/http-provider.js';
import { kbStats } from '../../src/tools/kb-stats.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';
import { vi } from 'vitest';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';
import { execFileSync } from 'node:child_process';
import { kbBibleCommit } from '../../src/tools/kb-bible-commit.js';
import { kbHealthCompactLine } from '../../src/tools/check-status.js';
import { commitWorkTree } from '../helpers/commit-work-tree.js';

function makeInput(overrides: Partial<KBEntryInput> = {}): KBEntryInput {
  return {
    type: 'knowledge',
    title: 'Default title',
    summary: 'Default summary',
    content: 'Default content body.',
    source_files: ['src/default.ts'],
    symbols: ['defaultSymbol'],
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

describe('SqliteProvider.stats (T2.1, F5, D4)', () => {
  it('empty KB reports zeroed totals, null hit_rate, null promote_ratio', async () => {
    const stats = await provider.stats();
    expect(stats.totals.total).toBe(0);
    expect(stats.totals.by_confidence).toEqual({ CONFIRMED: 0, INFERRED: 0, UNVERIFIED: 0 });
    expect(stats.totals.by_type).toEqual({
      'context-cache': 0, learning: 0, knowledge: 0, runbook: 0, 'user-directive': 0,
    });
    expect(stats.stale).toBe(0);
    expect(stats.flagged).toBe(0);
    expect(stats.superseded).toBe(0);
    expect(stats.retrieval).toEqual({ entries_retrieved: 0, total_uses: 0, hit_rate: null });
    expect(stats.promote_ratio).toBeNull();
  });

  it('totals by confidence and type reflect a mixed fixture (whole-table, not liveness-filtered)', async () => {
    await provider.capture(makeInput({ type: 'learning', confidence: 'UNVERIFIED', title: 'L1', symbols: ['s1'] }));
    const inferred = await provider.capture(makeInput({ type: 'knowledge', confidence: 'INFERRED', title: 'K1', symbols: ['s2'] }));
    await provider.promote(inferred.id, 'test fixture: verified against the seeded tree');
    await provider.capture(makeInput({ type: 'runbook', confidence: 'UNVERIFIED', title: 'R1', symbols: ['s3'], source_files: ['docs/r.md'] }));

    const stats = await provider.stats();
    expect(stats.totals.total).toBe(3);
    expect(stats.totals.by_confidence.CONFIRMED).toBe(1);
    expect(stats.totals.by_confidence.UNVERIFIED).toBe(2);
    expect(stats.totals.by_type.learning).toBe(1);
    expect(stats.totals.by_type.knowledge).toBe(1);
    expect(stats.totals.by_type.runbook).toBe(1);
  });

  it('stale/flagged/superseded counts', async () => {
    // stale: context-cache entry, then invalidated.
    await provider.capture(makeInput({
      type: 'context-cache', title: 'Cache', symbols: ['symCache'],
      source_files: ['src/cache.ts'], content_hash: 'h1', content_hash_type: 'git',
    }));
    await provider.invalidate(['src/cache.ts']);

    // flagged: a contradiction pair.
    await provider.capture(makeInput({
      title: 'X is broken', summary: 'X is broken', content: 'X is broken',
      symbols: ['symX'], source_files: ['src/x.ts'],
    }));
    await provider.capture(makeInput({
      title: 'X is broken', summary: 'X is fixed now', content: 'X is fixed now',
      symbols: ['symX'], source_files: ['src/x.ts'],
    }));

    // superseded: same-type update with an explicit supersedes (AUDN 'update'
    // decision). Supersede is opt-in -- without `supersedes` both rows stay live.
    const first = await provider.capture(makeInput({
      title: 'Superseded entry', summary: 'Original', symbols: ['symSup'], source_files: ['src/sup.ts'],
    }));
    const update = await provider.capture(makeInput({
      title: 'Superseded entry', summary: 'Original', symbols: ['symSup'], source_files: ['src/sup.ts'],
      content: 'Corrected content.',
      supersedes: first.id,
    }));
    expect(update.audn_decision).toBe('update');

    const stats = await provider.stats();
    // 2 stale rows: the invalidated context-cache entry AND the superseded
    // entry (evaluateAudn's 'update' path sets superseded_at AND stale=1
    // together on the matched row -- see sqlite-provider.ts's UPDATE for
    // decision.decision === 'update').
    expect(stats.stale).toBe(2);
    expect(stats.flagged).toBeGreaterThanOrEqual(1);
    expect(stats.superseded).toBe(1);
  });

  it('retrieval.hit_rate uses total LIVE entries as the denominator (resolution 6)', async () => {
    const a = await provider.capture(makeInput({ title: 'A', symbols: ['symA'] }));
    await provider.capture(makeInput({ title: 'B', symbols: ['symB'] }));
    // Retrieve A via query() (bumps use_count).
    await provider.query({ ids: [a.id] });

    const stats = await provider.stats();
    expect(stats.retrieval.entries_retrieved).toBe(1);
    expect(stats.retrieval.total_uses).toBe(1);
    expect(stats.retrieval.hit_rate).toBe(0.5); // 1 retrieved / 2 live
  });

  it('promote_ratio = promoted_at IS NOT NULL / CONFIRMED count', async () => {
    const a = await provider.capture(makeInput({ title: 'A', symbols: ['symA'] }));
    await provider.promote(a.id, 'test fixture: verified against the seeded tree'); // UNVERIFIED -> INFERRED (no promoted_at yet)
    await provider.promote(a.id, 'test fixture: verified against the seeded tree'); // INFERRED -> CONFIRMED (promoted_at set)
    await provider.capture(makeInput({ title: 'B', confidence: 'INFERRED', symbols: ['symB'] }));
    await provider.promote((await provider.capture(makeInput({ title: 'C', confidence: 'INFERRED', symbols: ['symC'] }))).id, 'test fixture: verified against the seeded tree');

    const stats = await provider.stats();
    // 2 CONFIRMED entries (A, C), both with promoted_at set.
    expect(stats.totals.by_confidence.CONFIRMED).toBe(2);
    expect(stats.promote_ratio).toBe(1);
  });

  it('coverage: exact match required, substring near-miss does not count', async () => {
    const a = await provider.capture(makeInput({ title: 'A', symbols: ['resolveRepoPath'] }));
    await provider.promote(a.id, 'test fixture: verified against the seeded tree');
    await provider.promote(a.id, 'test fixture: verified against the seeded tree');

    const stats = await provider.stats({ symbols: ['resolveRepoPath', 'resolveRepoPathExtra', 'totallyMissing'] });
    expect(stats.coverage).toEqual({
      fraction: 1 / 3,
      symbols: {
        resolveRepoPath: true,
        resolveRepoPathExtra: false,
        totallyMissing: false,
      },
    });
  });

  it('does NOT bump use_count or last_accessed', async () => {
    const { id } = await provider.capture(makeInput({ symbols: ['symNoBump'] }));

    await provider.stats();
    await provider.stats({ symbols: ['symNoBump'] });

    // query({ids}) returns the PRE-bump row then bumps use_count as a side
    // effect for the NEXT call to observe (same pattern as kb-list.test.ts).
    // Calling it twice in a row proves the two stats() calls above added
    // nothing: if they had bumped, the second query({ids}) call would report
    // more than exactly 1.
    await provider.query({ ids: [id] });
    const fetched = await provider.query({ ids: [id] });
    expect(fetched.results[0].use_count).toBe(1);
  });
});

describe('HttpKbProvider.stats (T2.1, D4: never throw)', () => {
  it('returns a documented not-supported result without making a network call', async () => {
    const httpProvider = new HttpKbProvider('http://127.0.0.1:1', 'unused-token');
    const stats = await httpProvider.stats();
    expect(stats.supported).toBe(false);
    expect(typeof stats.reason).toBe('string');
    expect(stats.totals.total).toBe(0);
    expect(stats.retrieval.hit_rate).toBeNull();
    expect(stats.promote_ratio).toBeNull();
    httpProvider.dispose();
  });
});

describe('kb_stats tool: bible drift (T2.1, D5)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-stats-test-'));
    vi.spyOn(kbProvidersModule, 'getKbProviders').mockResolvedValue({
      project: provider,
      global: provider,
      projectSlug: 'test',
    } as any);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('bible absent -> present false, drift = all live CONFIRMED entries', async () => {
    const a = await provider.capture(makeInput({ title: 'A', symbols: ['symA'] }));
    await provider.promote(a.id, 'test fixture: verified against the seeded tree');
    await provider.promote(a.id, 'test fixture: verified against the seeded tree');

    const result = JSON.parse(await kbStats({}, { folder: tmpDir }));
    expect(result.bible).toMatchObject({ present: false, entries: 0, drift: 1 });
  });

  it('bible present, current -> drift 0', async () => {
    const a = await provider.capture(makeInput({ title: 'A', symbols: ['symA'] }));
    await provider.promote(a.id, 'test fixture: verified against the seeded tree');
    await provider.promote(a.id, 'test fixture: verified against the seeded tree');
    const entry = (await provider.query({ ids: [a.id] })).results[0];

    const fleetDir = path.join(tmpDir, '.fleet');
    fs.mkdirSync(fleetDir, { recursive: true });
    fs.writeFileSync(
      path.join(fleetDir, 'kb-canonical.json'),
      JSON.stringify([{
        id: entry.id, type: entry.type, title: entry.title, summary: entry.summary,
        symbols: entry.symbols, source_files: entry.source_files, confidence: entry.confidence,
        updated_at: entry.promoted_at,
      }]),
    );

    const result = JSON.parse(await kbStats({}, { folder: tmpDir }));
    expect(result.bible).toMatchObject({ present: true, entries: 1, drift: 0 });
  });

  it('bible present with drift -> a newer live CONFIRMED entry not yet in the bible counts as drift', async () => {
    const a = await provider.capture(makeInput({ title: 'A', symbols: ['symA'] }));
    await provider.promote(a.id, 'test fixture: verified against the seeded tree');
    await provider.promote(a.id, 'test fixture: verified against the seeded tree');

    const fleetDir = path.join(tmpDir, '.fleet');
    fs.mkdirSync(fleetDir, { recursive: true });
    fs.writeFileSync(
      path.join(fleetDir, 'kb-canonical.json'),
      JSON.stringify([{
        id: 'old-entry', type: 'knowledge', title: 'Old', summary: 'Old',
        symbols: [], source_files: ['src/fixture.ts'], confidence: 'CONFIRMED',
        updated_at: '2020-01-01T00:00:00.000Z',
      }]),
    );

    const result = JSON.parse(await kbStats({}, { folder: tmpDir }));
    expect(result.bible.present).toBe(true);
    expect(result.bible.entries).toBe(1);
    expect(result.bible.drift).toBe(1);
  });

  it('malformed bible JSON degrades to the absent shape rather than throwing', async () => {
    const a = await provider.capture(makeInput({ title: 'A', symbols: ['symA'] }));
    await provider.promote(a.id, 'test fixture: verified against the seeded tree');
    await provider.promote(a.id, 'test fixture: verified against the seeded tree');

    const fleetDir = path.join(tmpDir, '.fleet');
    fs.mkdirSync(fleetDir, { recursive: true });
    fs.writeFileSync(path.join(fleetDir, 'kb-canonical.json'), 'not valid json{{{');

    const result = JSON.parse(await kbStats({}, { folder: tmpDir }));
    expect(result.bible).toMatchObject({ present: false, entries: 0, drift: 1 });
  });

  it('invalid repo path degrades to bible absent rather than throwing', async () => {
    const a = await provider.capture(makeInput({ title: 'A', symbols: ['symA'] }));
    await provider.promote(a.id, 'test fixture: verified against the seeded tree');
    await provider.promote(a.id, 'test fixture: verified against the seeded tree');

    const result = JSON.parse(await kbStats({}, { folder: path.join(tmpDir, 'does-not-exist') }));
    expect(result.bible).toMatchObject({ present: false, entries: 0, drift: 1 });
  });

  it('merges provider stats sections alongside bible', async () => {
    const result = JSON.parse(await kbStats({}, { folder: tmpDir }));
    expect(result).toHaveProperty('totals');
    expect(result).toHaveProperty('retrieval');
    expect(result).toHaveProperty('promote_ratio');
    expect(result).toHaveProperty('bible');
  });

  // my-beads-db-0cd.13: over an HttpKbProvider project, bible drift must be
  // reported as not computable, never as an ambiguous drift:0 (indistinguishable
  // from an up-to-date bible) and never by throwing.
  it('HttpKbProvider project -> bible reports not computable, never drift 0', async () => {
    const a = await provider.capture(makeInput({ title: 'A', symbols: ['symA'] }));
    await provider.promote(a.id, 'test fixture: verified against the seeded tree');
    await provider.promote(a.id, 'test fixture: verified against the seeded tree');

    const httpProvider = new HttpKbProvider('http://127.0.0.1:1', 'unused-token');
    vi.spyOn(kbProvidersModule, 'getKbProviders').mockResolvedValue({
      project: httpProvider,
      global: provider,
      projectSlug: 'test',
    } as any);

    const result = JSON.parse(await kbStats({}, { folder: tmpDir }));
    expect(result.bible).toEqual({
      computable: false,
      reason: 'bible drift is not computable over a remote HTTP provider',
    });
    expect(result.bible.drift).toBeUndefined();
    httpProvider.dispose();
  });
});

// 6ejt.8 / l0y9: drift counts only export-qualifying entries; hash_drifted
// measures committed bible vs code at HEAD. Real git repo + real predicate.
describe('kb_stats tool: export-qualifying drift and hash drift (real git repo)', () => {
  let root: string;
  let repo: string;
  const BASE = { baseBranch: 'main', baseCommit: 'a'.repeat(40) };
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

  function write(rel: string, body: string): void {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), body);
  }

  async function confirmed(title: string, files: string[]): Promise<string> {
    const { id } = await provider.capture(makeInput({ title, summary: 'S ' + title, symbols: ['sym' + title], source_files: files }));
    await provider.promote(id, 'test fixture: verified');
    await provider.promote(id, 'test fixture: verified');
    return id;
  }

  async function stats(): Promise<any> {
    return JSON.parse(await kbStats({}, { folder: repo })).bible;
  }

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-stats-git-'));
    repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: repo });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo });
    write('README.md', 'seed\n');
    commitWorkTree(repo, 'seed');
    provider.close();
    provider = new SqliteProvider(path.join(root, 'kb.sqlite'), repo);
    await provider.init();
    vi.spyOn(kbProvidersModule, 'getKbProviders').mockResolvedValue({
      project: provider, global: provider, projectSlug: 'test',
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // the outer afterEach closes `provider` (the replacement instance)
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  async function setupCommittedThenNonExportable(): Promise<{ good: string }> {
    write('src/a.ts', 'a1\n');
    write('src/b.ts', 'b1\n');
    const good = await confirmed('Good', ['src/a.ts']);
    commitWorkTree(repo);
    const r = JSON.parse(await kbBibleCommit({ ids: [good], ...BASE }, { folder: repo }));
    expect(r.merged).toEqual([good]);
    await sleep(10);
    // mismatched: cited file edited and committed after capture
    await confirmed('Mismatched', ['src/b.ts']);
    // missing basis: stored basis removed
    const noBasis = await confirmed('NoBasis', ['src/a.ts']);
    (provider as any).getDb().prepare("UPDATE entries SET source_file_hashes = '{}' WHERE id = ?").run(noBasis);
    write('src/b.ts', 'b2\n');
    commitWorkTree(repo);
    return { good };
  }

  it('after kb commit, only non-exportable CONFIRMED entries remain: drift 0 and not_exportable counts them; fleet_status does not advise kb commit', async () => {
    await setupCommittedThenNonExportable();
    const bible = await stats();
    expect(bible.present).toBe(true);
    expect(bible.drift).toBe(0);
    expect(bible.not_exportable.count).toBe(2);
    expect(bible.not_exportable.reasons.basis_missing).toBe(1);
    expect(bible.not_exportable.reasons.basis_mismatched).toBe(1);

    const line = kbHealthCompactLine({
      scope: 'test', totals: { total: 3, by_confidence: { CONFIRMED: 3 } }, stale: 0, flagged: 0, superseded: 0,
      retrieval: { entries_retrieved: 0, total_uses: 0, hit_rate: null }, promote_ratio: null, bible,
    } as never);
    expect(line).not.toContain('kb commit');
    expect(line).toContain('2 CONFIRMED entries not exportable');
  });

  it('a qualifying CONFIRMED entry absent from the bible counts as drift 1 and fleet_status advises kb commit', async () => {
    const { good } = await setupCommittedThenNonExportable();
    await sleep(10);
    write('src/c.ts', 'c1\n');
    const fresh = await confirmed('Fresh', ['src/c.ts']);
    commitWorkTree(repo);
    expect(fresh).not.toBe(good);

    const bible = await stats();
    expect(bible.drift).toBe(1);
    const line = kbHealthCompactLine({
      scope: 'test', totals: { total: 4, by_confidence: { CONFIRMED: 4 } }, stale: 0, flagged: 0, superseded: 0,
      retrieval: { entries_retrieved: 0, total_uses: 0, hit_rate: null }, promote_ratio: null, bible,
    } as never);
    expect(line).toContain('run apra-fleet kb commit');
  });

  async function commitBible3(): Promise<string[]> {
    write('src/a.ts', 'a1\n');
    write('src/b.ts', 'b1\n');
    const ids = [
      await confirmed('A1', ['src/a.ts']),
      await confirmed('A2', ['src/a.ts']),
      await confirmed('B1', ['src/b.ts']),
    ];
    commitWorkTree(repo);
    const r = JSON.parse(await kbBibleCommit({ ids, ...BASE }, { folder: repo }));
    expect(r.merged.length).toBe(3);
    return ids;
  }

  it('hash_drifted counts bible entries whose cited file changed at HEAD, not entries on unchanged files', async () => {
    const ids = await commitBible3();
    write('src/a.ts', 'a2\n');
    commitWorkTree(repo);
    const bible = await stats();
    expect(bible.hash_drifted.count).toBe(2);
    expect([...bible.hash_drifted.ids].sort()).toEqual([ids[0], ids[1]].sort());
  });

  it('an uncommitted edit to a cited file does not change hash_drifted', async () => {
    await commitBible3();
    write('src/a.ts', 'uncommitted\n');
    expect((await stats()).hash_drifted.count).toBe(0);
  });

  it('all bible entries matching HEAD -> hash_drifted 0', async () => {
    await commitBible3();
    const bible = await stats();
    expect(bible.hash_drifted).toEqual({ count: 0, ids: [], unhashed: 0 });
  });
});
