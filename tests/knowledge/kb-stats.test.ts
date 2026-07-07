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
    await provider.promote(inferred.id, 'test');
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

    // superseded: same-type update (AUDN 'update' decision).
    const first = await provider.capture(makeInput({
      title: 'Superseded entry', summary: 'Original', symbols: ['symSup'], source_files: ['src/sup.ts'],
    }));
    const update = await provider.capture(makeInput({
      title: 'Superseded entry', summary: 'Original', symbols: ['symSup'], source_files: ['src/sup.ts'],
      content: 'Corrected content.',
    }));
    expect(update.audn_decision).toBe('update');
    void first;

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
    await provider.promote(a.id, 'test'); // UNVERIFIED -> INFERRED (no promoted_at yet)
    await provider.promote(a.id, 'test'); // INFERRED -> CONFIRMED (promoted_at set)
    await provider.capture(makeInput({ title: 'B', confidence: 'INFERRED', symbols: ['symB'] }));
    await provider.promote((await provider.capture(makeInput({ title: 'C', confidence: 'INFERRED', symbols: ['symC'] }))).id, 'test');

    const stats = await provider.stats();
    // 2 CONFIRMED entries (A, C), both with promoted_at set.
    expect(stats.totals.by_confidence.CONFIRMED).toBe(2);
    expect(stats.promote_ratio).toBe(1);
  });

  it('coverage: exact match required, substring near-miss does not count', async () => {
    const a = await provider.capture(makeInput({ title: 'A', symbols: ['resolveRepoPath'] }));
    await provider.promote(a.id, 'test');
    await provider.promote(a.id, 'test');

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
    const httpProvider = new HttpKbProvider('http://127.0.0.1:1', 'unused-token', provider);
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
    await provider.promote(a.id, 'test');
    await provider.promote(a.id, 'test');

    const result = JSON.parse(await kbStats({ repo: tmpDir }));
    expect(result.bible).toEqual({ present: false, entries: 0, drift: 1 });
  });

  it('bible present, current -> drift 0', async () => {
    const a = await provider.capture(makeInput({ title: 'A', symbols: ['symA'] }));
    await provider.promote(a.id, 'test');
    await provider.promote(a.id, 'test');
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

    const result = JSON.parse(await kbStats({ repo: tmpDir }));
    expect(result.bible).toEqual({ present: true, entries: 1, drift: 0 });
  });

  it('bible present with drift -> a newer live CONFIRMED entry not yet in the bible counts as drift', async () => {
    const a = await provider.capture(makeInput({ title: 'A', symbols: ['symA'] }));
    await provider.promote(a.id, 'test');
    await provider.promote(a.id, 'test');

    const fleetDir = path.join(tmpDir, '.fleet');
    fs.mkdirSync(fleetDir, { recursive: true });
    fs.writeFileSync(
      path.join(fleetDir, 'kb-canonical.json'),
      JSON.stringify([{
        id: 'old-entry', type: 'knowledge', title: 'Old', summary: 'Old',
        symbols: [], source_files: [], confidence: 'CONFIRMED',
        updated_at: '2020-01-01T00:00:00.000Z',
      }]),
    );

    const result = JSON.parse(await kbStats({ repo: tmpDir }));
    expect(result.bible.present).toBe(true);
    expect(result.bible.entries).toBe(1);
    expect(result.bible.drift).toBe(1);
  });

  it('malformed bible JSON degrades to the absent shape rather than throwing', async () => {
    const a = await provider.capture(makeInput({ title: 'A', symbols: ['symA'] }));
    await provider.promote(a.id, 'test');
    await provider.promote(a.id, 'test');

    const fleetDir = path.join(tmpDir, '.fleet');
    fs.mkdirSync(fleetDir, { recursive: true });
    fs.writeFileSync(path.join(fleetDir, 'kb-canonical.json'), 'not valid json{{{');

    const result = JSON.parse(await kbStats({ repo: tmpDir }));
    expect(result.bible).toEqual({ present: false, entries: 0, drift: 1 });
  });

  it('invalid repo path degrades to bible absent rather than throwing', async () => {
    const a = await provider.capture(makeInput({ title: 'A', symbols: ['symA'] }));
    await provider.promote(a.id, 'test');
    await provider.promote(a.id, 'test');

    const result = JSON.parse(await kbStats({ repo: path.join(tmpDir, 'does-not-exist') }));
    expect(result.bible).toEqual({ present: false, entries: 0, drift: 1 });
  });

  it('merges provider stats sections alongside bible', async () => {
    const result = JSON.parse(await kbStats({ repo: tmpDir }));
    expect(result).toHaveProperty('totals');
    expect(result).toHaveProperty('retrieval');
    expect(result).toHaveProperty('promote_ratio');
    expect(result).toHaveProperty('bible');
  });
});
