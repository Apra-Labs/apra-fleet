import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { DatabaseSync } from 'node:sqlite';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { SqliteProvider } from '../src/services/knowledge/sqlite-provider.js';
import { Embedder, _setEmbedderForTest } from '../src/services/knowledge/embedding/embedder.js';
import { BUILTIN_EMBEDDING_PROFILES, DEFAULT_EMBEDDING_PROFILE } from '../src/services/knowledge/embedding/profiles.js';

// The KB section ends with the embedding-model line; pinned to the default
// profile, not yet loaded (fleet_status never loads a model).
const DEFAULT_PROFILE = BUILTIN_EMBEDDING_PROFILES[DEFAULT_EMBEDDING_PROFILE];
const EMBEDDING_IDLE_LINE =
  `  kb embedding: ${DEFAULT_PROFILE.modelId}@${DEFAULT_PROFILE.revision} not loaded yet (downloads and loads on first use)`;

// T2.2 (F5/F6, D4/D5 amended) + the cwd-independence fix: fleet_status KB
// health enumerates every KB scope on disk (never one derived from the fleet
// server's process.cwd()) and labels each by project slug.
//
// The knowledge root is redirected to a per-test temp dir via the kb-scopes
// mock below, so these tests never read or write this machine's real KB.
// kb-stats.js is mocked too: fleet_status only calls kbStats() for the bible
// drift of an explicitly supplied repo_path's scope.
const mockKbStats = vi.fn();
vi.mock('../src/tools/kb-stats.js', () => ({
  kbStats: (input: unknown, anchor?: unknown) => mockKbStats(input, anchor),
}));

const kbRoot = { dir: '', throwOnList: false };
vi.mock('../src/services/knowledge/kb-scopes.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/knowledge/kb-scopes.js')>();
  return {
    ...actual,
    knowledgeRootDir: () => kbRoot.dir,
    listKbScopes: (dir?: string) => {
      if (kbRoot.throwOnList) throw new Error('enumeration exploded');
      return actual.listKbScopes(dir);
    },
  };
});

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: vi.fn().mockResolvedValue({ stdout: 'idle', stderr: '', code: 0 }),
    testConnection: vi.fn().mockResolvedValue({ ok: true, latencyMs: 5 }),
    transferFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

interface SeedRow {
  confidence?: 'CONFIRMED' | 'INFERRED' | 'UNVERIFIED';
  stale?: 0 | 1;
  flagged?: 0 | 1;
  use_count?: number;
  promoted?: boolean;
}

let seq = 0;
async function seedScope(root: string, slug: string, rows: SeedRow[]): Promise<void> {
  const dbPath = join(root, slug, 'kb.sqlite');
  mkdirSync(dirname(dbPath), { recursive: true });
  const provider = new SqliteProvider(dbPath);
  await provider.init();
  provider.close();
  const db = new DatabaseSync(dbPath);
  const insert = db.prepare(
    'INSERT INTO entries (id, type, title, summary, content, confidence, stale, flagged_for_review, use_count, created_at, promoted_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const now = new Date().toISOString();
  for (const r of rows) {
    seq += 1;
    insert.run(
      `e${seq}`, 'knowledge', `title ${seq}`, 'summary', 'content',
      r.confidence ?? 'INFERRED', r.stale ?? 0, r.flagged ?? 0, r.use_count ?? 0, now,
      r.promoted ? now : null,
    );
  }
  db.close();
}

function flatStats(overrides: Record<string, unknown> = {}) {
  return {
    totals: {
      by_confidence: { CONFIRMED: 10, INFERRED: 5, UNVERIFIED: 2 },
      by_type: { 'context-cache': 1, learning: 2, knowledge: 10, runbook: 2, 'user-directive': 2 },
      total: 17,
    },
    stale: 1,
    flagged: 2,
    superseded: 3,
    retrieval: { entries_retrieved: 8, total_uses: 40, hit_rate: 0.6543 },
    promote_ratio: 0.8,
    bible: { present: true, entries: 10, drift: 0 },
    ...overrides,
  };
}

describe('kbHealthCompactLine (single scope)', () => {
  it('renders totals/stale/flagged/hit-rate/promote-ratio without a drift fragment when drift is 0', async () => {
    const { kbHealthCompactLine } = await import('../src/tools/check-status.js');
    const line = kbHealthCompactLine(flatStats() as never);
    expect(line).toBe('kb: 17 entries (confirmed:10 stale:1 flagged:2) | hit-rate(30d):n/a (0 cited/0 returned) | retrieved:65% | promote-ratio:80%');
    expect(line).not.toContain('bible:');
  });

  it('labels the line with the scope when given', async () => {
    const { kbHealthCompactLine } = await import('../src/tools/check-status.js');
    expect(kbHealthCompactLine(flatStats() as never, 'githubcom-acme-widgets'))
      .toBe('kb[githubcom-acme-widgets]: 17 entries (confirmed:10 stale:1 flagged:2) | hit-rate(30d):n/a (0 cited/0 returned) | retrieved:65% | promote-ratio:80%');
  });

  it('renders the exact D5-amended anomaly wording when drift > 0', async () => {
    const { kbHealthCompactLine } = await import('../src/tools/check-status.js');
    const line = kbHealthCompactLine(flatStats({ bible: { present: true, entries: 5, drift: 3 } }) as never);
    expect(line).toContain('bible: 3 promotions behind (auto-commit may have failed -- run apra-fleet kb commit)');
  });

  it('renders n/a for null hit_rate and promote_ratio (empty KB)', async () => {
    const { kbHealthCompactLine } = await import('../src/tools/check-status.js');
    const line = kbHealthCompactLine(flatStats({
      retrieval: { entries_retrieved: 0, total_uses: 0, hit_rate: null },
      promote_ratio: null,
    }) as never);
    expect(line).toContain('hit-rate(30d):n/a');
    expect(line).toContain('retrieved:n/a');
    expect(line).toContain('promote-ratio:n/a');
  });

  it('bible not computable over a remote HTTP provider renders the reason, not undefined or a promotions count', async () => {
    const { kbHealthCompactLine } = await import('../src/tools/check-status.js');
    const line = kbHealthCompactLine(flatStats({
      bible: { computable: false, reason: 'bible drift is not computable over a remote HTTP provider' },
    }) as never);
    expect(line).toContain('bible drift is not computable over a remote HTTP provider');
    expect(line).not.toContain('undefined');
    expect(line).not.toContain('promotions behind');
  });

  it('expected not-computed states (no repo path, global) render no bible fragment', async () => {
    const { kbHealthCompactLine, KB_BIBLE_NO_REPO_REASON, KB_BIBLE_GLOBAL_REASON } = await import('../src/tools/check-status.js');
    for (const reason of [KB_BIBLE_NO_REPO_REASON, KB_BIBLE_GLOBAL_REASON]) {
      const line = kbHealthCompactLine(flatStats({ bible: { computable: false, reason } }) as never);
      expect(line).not.toContain('bible');
    }
  });
});

describe('listKbScopes', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'kb-scopes-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('returns [] for an absent knowledge dir', async () => {
    const actual = await vi.importActual<typeof import('../src/services/knowledge/kb-scopes.js')>('../src/services/knowledge/kb-scopes.js');
    expect(actual.listKbScopes(join(root, 'nope'))).toEqual([]);
  });

  it('lists only directories holding kb.sqlite, sorted, ignoring config/token files', async () => {
    const actual = await vi.importActual<typeof import('../src/services/knowledge/kb-scopes.js')>('../src/services/knowledge/kb-scopes.js');
    writeFileSync(join(root, 'config.json'), '{}');
    mkdirSync(join(root, 'no-db-here'));
    for (const slug of ['zeta', 'alpha', 'global']) {
      mkdirSync(join(root, slug));
      writeFileSync(join(root, slug, 'kb.sqlite'), '');
    }
    expect(actual.listKbScopes(root).map(s => s.slug)).toEqual(['alpha', 'global', 'zeta']);
  });
});

describe('kbHealthSummary (multi-scope, degraded-safe)', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kb-health-'));
    kbRoot.dir = root;
    kbRoot.throwOnList = false;
    mockKbStats.mockReset();
    _setEmbedderForTest(new Embedder({ choice: { kind: 'enabled', profile: DEFAULT_PROFILE } }));
  });
  afterEach(() => {
    _setEmbedderForTest(null);
    rmSync(root, { recursive: true, force: true });
  });

  it('absent knowledge dir degrades to an empty summary with an explicit "none yet" line', async () => {
    const { kbHealthSummary, kbHealthCompactLines } = await import('../src/tools/check-status.js');
    const health = await kbHealthSummary({ knowledgeDir: join(root, 'absent') });
    expect(health).not.toBeNull();
    expect(health!.scopes).toEqual([]);
    expect(health!.global).toBeNull();
    const text = kbHealthCompactLines(health!);
    expect(text).toBe(`kb: no knowledge bases found yet (none captured on this server)\n${EMBEDDING_IDLE_LINE}`);
    expect(text).not.toContain('kb: 0 entries');
  });

  it('reports every project scope labeled by slug, global separately, and collapses empty scopes', async () => {
    await seedScope(root, 'githubcom-acme-widgets', [
      { confidence: 'CONFIRMED', use_count: 2, promoted: true },
      { confidence: 'CONFIRMED' },
      { stale: 1 },
    ]);
    await seedScope(root, 'githubcom-acme-gadgets', [{ flagged: 1 }, {}]);
    await seedScope(root, 'global', [{ confidence: 'CONFIRMED' }]);
    await seedScope(root, 'default', []);

    const { kbHealthSummary, kbHealthCompactLines } = await import('../src/tools/check-status.js');
    const health = (await kbHealthSummary())!;
    expect(health.scopes.map(s => s.scope)).toEqual(['default', 'githubcom-acme-gadgets', 'githubcom-acme-widgets']);
    expect(health.global?.totals.total).toBe(1);
    expect(health.totalEntries).toBe(6);
    const widgets = health.scopes.find(s => s.scope === 'githubcom-acme-widgets')!;
    expect(widgets.totals.total).toBe(3);
    expect(widgets.stale).toBe(1);
    expect(widgets.promote_ratio).toBe(0.5);
    expect(widgets.bible).toMatchObject({ computable: false });
    expect(mockKbStats).not.toHaveBeenCalled();

    const text = kbHealthCompactLines(health);
    expect(text.split('\n')).toEqual([
      'kb: 6 entries across 2 project scope(s) + global',
      '  kb[githubcom-acme-gadgets]: 2 entries (confirmed:0 stale:0 flagged:1) | hit-rate(30d):n/a (0 cited/0 returned) | retrieved:0% | promote-ratio:n/a',
      '  kb[githubcom-acme-widgets]: 3 entries (confirmed:2 stale:1 flagged:0) | hit-rate(30d):n/a (0 cited/0 returned) | retrieved:50% | promote-ratio:50%',
      '  kb[global]: 1 entries (confirmed:1 stale:0 flagged:0) | hit-rate(30d):n/a (0 cited/0 returned) | retrieved:0% | promote-ratio:0%',
      '  kb: empty scope(s): default',
      EMBEDDING_IDLE_LINE,
    ]);
  });

  it('an unreadable scope is listed as an error and never throws or hides the others', async () => {
    await seedScope(root, 'githubcom-acme-widgets', [{}]);
    mkdirSync(join(root, 'broken'));
    writeFileSync(join(root, 'broken', 'kb.sqlite'), 'this is not a sqlite database at all, just text padding it out');

    const { kbHealthSummary, kbHealthCompactLines } = await import('../src/tools/check-status.js');
    const health = (await kbHealthSummary())!;
    expect(health.scopes.map(s => s.scope)).toEqual(['githubcom-acme-widgets']);
    expect(health.errors.map(e => e.scope)).toEqual(['broken']);
    expect(kbHealthCompactLines(health)).toContain('kb[broken]: unreadable');
  });

  it('computes bible drift only for the scope of an explicitly supplied repo_path', async () => {
    // A non-git dir resolves to the `default` scope slug, so no git is needed.
    const repo = mkdtempSync(join(tmpdir(), 'kb-health-repo-'));
    try {
      await seedScope(root, 'default', [{ confidence: 'CONFIRMED' }]);
      await seedScope(root, 'githubcom-acme-widgets', [{}]);
      mockKbStats.mockResolvedValue(JSON.stringify({ ...flatStats(), bible: { present: true, entries: 1, drift: 4 } }));

      const { kbHealthSummary, kbHealthCompactLines } = await import('../src/tools/check-status.js');
      const health = (await kbHealthSummary({ repoPath: repo }))!;
      expect(mockKbStats).toHaveBeenCalledWith({}, { folder: repo });
      expect(health.scopes.find(s => s.scope === 'default')!.bible).toEqual({ present: true, entries: 1, drift: 4 });
      expect(health.scopes.find(s => s.scope === 'githubcom-acme-widgets')!.bible).toMatchObject({ computable: false });
      const text = kbHealthCompactLines(health);
      // The bible is its own line; the host-DB line no longer carries it.
      expect(text).toContain('kb[default]: 1 entries (confirmed:1 stale:0 flagged:0) | hit-rate(30d):n/a (0 cited/0 returned) | retrieved:0% | promote-ratio:0%\n');
      expect(text).toContain('kb bible[default]: no bible file | drift: 4 promotions behind');
      expect(health.bible).toMatchObject({ repoPath: repo, scope: 'default', present: false, entries: 0, drift: 4 });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('returns null (never throws) when enumeration itself fails', async () => {
    kbRoot.throwOnList = true;
    const { kbHealthSummary } = await import('../src/tools/check-status.js');
    await expect(kbHealthSummary()).resolves.toBeNull();
  });
});

describe('fleetStatus() KB + code-intel sections are independent of process.cwd()', () => {
  let root: string;
  let otherCwd: string;
  const originalCwd = process.cwd();

  beforeEach(async () => {
    vi.resetModules();
    backupAndResetRegistry();
    vi.clearAllMocks();
    mockKbStats.mockReset();
    root = mkdtempSync(join(tmpdir(), 'kb-health-fs-'));
    otherCwd = mkdtempSync(join(tmpdir(), 'kb-health-cwd-'));
    kbRoot.dir = root;
    kbRoot.throwOnList = false;
    await seedScope(root, 'githubcom-acme-widgets', [{ confidence: 'CONFIRMED' }, {}, {}]);
    await seedScope(root, 'githubcom-acme-gadgets', [{}]);
    await seedScope(root, 'default', []);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    restoreRegistry();
    rmSync(root, { recursive: true, force: true });
    rmSync(otherCwd, { recursive: true, force: true });
  });

  it('compact and json output are identical whether the server cwd is a repo or a random non-repo dir', async () => {
    const { fleetStatus } = await import('../src/tools/check-status.js');
    addAgent(makeTestAgent({ friendlyName: 'cwd-member' }));

    // A cwd that LOOKS like an indexed repo (has .gitnexus/meta.json): the
    // pre-fix code read the code-intel index from process.cwd(), so this
    // comparison fails against it.
    const indexedCwd = mkdtempSync(join(tmpdir(), 'kb-health-indexed-cwd-'));
    mkdirSync(join(indexedCwd, '.gitnexus'));
    writeFileSync(join(indexedCwd, '.gitnexus', 'meta.json'), JSON.stringify({
      indexedAt: '2026-07-01T00:00:00.000Z', stats: { files: 9, nodes: 9, edges: 9 },
    }));
    process.chdir(indexedCwd);
    const compactInRepo = await fleetStatus({ format: 'compact' });
    const jsonInRepo = await fleetStatus({ format: 'json' });
    process.chdir(otherCwd);
    const compactElsewhere = await fleetStatus({ format: 'compact' });
    const jsonElsewhere = await fleetStatus({ format: 'json' });
    process.chdir(originalCwd);
    rmSync(indexedCwd, { recursive: true, force: true });

    expect(compactElsewhere).toBe(compactInRepo);
    expect(jsonElsewhere).toBe(jsonInRepo);

    expect(compactElsewhere).toContain('kb: 4 entries across 2 project scope(s)');
    expect(compactElsewhere).toContain('kb[githubcom-acme-widgets]: 3 entries');
    expect(compactElsewhere).toContain('kb[githubcom-acme-gadgets]: 1 entries');
    expect(compactElsewhere).toContain('kb: empty scope(s): default');
    expect(compactElsewhere).not.toMatch(/^kb: 0 entries/m);
    expect(compactElsewhere).toContain('code-intel: per-repo index; pass repo_path');

    const parsed = JSON.parse(jsonElsewhere);
    expect(parsed.kbHealth.scopes.map((s: { scope: string }) => s.scope))
      .toEqual(['default', 'githubcom-acme-gadgets', 'githubcom-acme-widgets']);
    expect(parsed.codeIntelligence).toMatchObject({ present: false, computable: false });
  });

  it('with repo_path, reports that repo\'s code-intel index regardless of cwd', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'kb-health-ci-'));
    try {
      mkdirSync(join(repo, '.gitnexus'));
      writeFileSync(join(repo, '.gitnexus', 'meta.json'), JSON.stringify({
        indexedAt: '2026-07-01T00:00:00.000Z', lastCommit: 'abc1234', stats: { files: 1, nodes: 2, edges: 3 },
      }));
      mockKbStats.mockResolvedValue(JSON.stringify(flatStats()));
      const { fleetStatus } = await import('../src/tools/check-status.js');
      addAgent(makeTestAgent({ friendlyName: 'ci-member' }));
      process.chdir(otherCwd);
      const json = JSON.parse(await fleetStatus({ format: 'json', repo_path: repo }));
      expect(json.codeIntelligence).toMatchObject({ present: true, nodes: 2, edges: 3, files: 1, repoPath: repo });
    } finally {
      process.chdir(originalCwd);
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('a repo_path that does not exist is named, not silently replaced by cwd', async () => {
    const { fleetStatus } = await import('../src/tools/check-status.js');
    addAgent(makeTestAgent({ friendlyName: 'missing-repo-member' }));
    const missing = join(otherCwd, 'does-not-exist');
    const compact = await fleetStatus({ format: 'compact', repo_path: missing });
    expect(compact).toContain(`code-intel: repo_path not found: ${missing}`);
  });

  it('omits the KB section entirely (compact + json) and still succeeds when the KB summary fails', async () => {
    kbRoot.throwOnList = true;
    const { fleetStatus } = await import('../src/tools/check-status.js');
    addAgent(makeTestAgent({ friendlyName: 'kb-error-member' }));

    const compact = await fleetStatus({ format: 'compact' });
    expect(compact).not.toContain('kb:');
    expect(compact).toContain('kb-error-member');

    const json = JSON.parse(await fleetStatus({ format: 'json' }));
    expect(json.kbHealth).toBeUndefined();
    expect(json.summary.total).toBe(1);
    expect(json.codeIntelligence).toBeDefined();
  });

  it('bible not computable over a remote HTTP provider: never renders undefined or claims promotions behind', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'kb-health-http-'));
    try {
      await seedScope(root, 'default', [{}]);
      const reason = 'bible drift is not computable over a remote HTTP provider';
      mockKbStats.mockResolvedValue(JSON.stringify(flatStats({ bible: { computable: false, reason } })));
      const { fleetStatus } = await import('../src/tools/check-status.js');
      addAgent(makeTestAgent({ friendlyName: 'kb-remote-bible-member' }));

      const compact = await fleetStatus({ format: 'compact', repo_path: repo });
      expect(compact).toContain('kb[default]: 1 entries');
      expect(compact).toContain(`drift: n/a (${reason})`);
      expect(compact).not.toContain('undefined');
      expect(compact).not.toContain('promotions behind');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

// D6: the bible is its own item, separate from the host database, and the
// hit rate shown is cited / returned usage events over the last 30 days.
describe('fleet_status KB: bible item separate from the host DB, cited-based 30-day hit rate (D6)', () => {
  let root: string;
  let repo: string;
  const DAY_MS = 24 * 60 * 60 * 1000;

  beforeEach(async () => {
    vi.resetModules();
    backupAndResetRegistry();
    vi.clearAllMocks();
    mockKbStats.mockReset();
    root = mkdtempSync(join(tmpdir(), 'kb-health-d6-'));
    // A non-git dir resolves to the `default` scope slug.
    repo = mkdtempSync(join(tmpdir(), 'kb-health-d6-repo-'));
    kbRoot.dir = root;
    kbRoot.throwOnList = false;
  });

  afterEach(() => {
    restoreRegistry();
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  function writeBible(entryCount: number): void {
    mkdirSync(join(repo, '.fleet'), { recursive: true });
    const entries = Array.from({ length: entryCount }, (_, i) => ({ id: `b${i}`, updated_at: '2026-01-01T00:00:00.000Z' }));
    writeFileSync(join(repo, '.fleet', 'kb-canonical.json'), JSON.stringify({ version: 3, provenance: {}, entries }));
  }

  async function recordUsage(slug: string, pushed: string[], cited: string[], at?: string): Promise<void> {
    const provider = new SqliteProvider(join(root, slug, 'kb.sqlite'));
    await provider.init();
    provider.recordUsage({ pushed, cited }, at);
    provider.close();
  }

  it('with repo_path: a bible item (entries, drift) and separate host-DB counts, in compact text and JSON; hit rate = in-window cited/returned', async () => {
    // Host DB holds a different entry set (5 entries) than the bible (3).
    await seedScope(root, 'default', [{ confidence: 'CONFIRMED' }, { confidence: 'CONFIRMED' }, {}, {}, {}]);
    writeBible(3);
    mockKbStats.mockResolvedValue(JSON.stringify({ ...flatStats(), bible: { present: true, entries: 3, drift: 2 } }));
    // In window: 4 returned, 1 cited -> 25%. Older than 30 days: must not move it.
    await recordUsage('default', ['a', 'b', 'c', 'd'], ['a'], new Date(Date.now() - 2 * DAY_MS).toISOString());
    await recordUsage('default', ['x', 'y'], ['x', 'y'], new Date(Date.now() - 31 * DAY_MS).toISOString());

    const { fleetStatus } = await import('../src/tools/check-status.js');
    addAgent(makeTestAgent({ friendlyName: 'kb-d6-member' }));

    const json = JSON.parse(await fleetStatus({ format: 'json', repo_path: repo }));
    expect(json.kbHealth.bible).toEqual({ repoPath: repo, scope: 'default', present: true, entries: 3, drift: 2 });
    const host = json.kbHealth.scopes.find((s: { scope: string }) => s.scope === 'default');
    expect(host.totals.total).toBe(5);
    expect(host.usage).toEqual({ window_days: 30, returned: 4, cited: 1, cited_rate: 0.25 });

    const compact = await fleetStatus({ format: 'compact', repo_path: repo });
    expect(compact).toContain('kb bible[default]: 3 entries | drift: 2 promotions behind');
    expect(compact).toContain('kb[default]: 5 entries (confirmed:2 stale:0 flagged:0) | hit-rate(30d):25% (1 cited/4 returned)');
    // The host-DB line does not repeat the bible.
    const hostLine = compact.split('\n').find(l => l.includes('kb[default]:'))!;
    expect(hostLine).not.toContain('bible');
  });

  it('no returned events in the window: hit rate is n/a, never 0% or a division error', async () => {
    await seedScope(root, 'default', [{ confidence: 'CONFIRMED' }]);
    await recordUsage('default', [], ['orphan-cite']);
    writeBible(1);
    mockKbStats.mockResolvedValue(JSON.stringify({ ...flatStats(), bible: { present: true, entries: 1, drift: 0 } }));
    const { fleetStatus } = await import('../src/tools/check-status.js');
    addAgent(makeTestAgent({ friendlyName: 'kb-d6-empty-member' }));

    const compact = await fleetStatus({ format: 'compact', repo_path: repo });
    expect(compact).toContain('hit-rate(30d):n/a (1 cited/0 returned)');
    expect(compact).not.toMatch(/hit-rate\(30d\):(0%|NaN|Infinity)/);
    expect(compact).toContain('kb bible[default]: 1 entries | drift: 0');
    const json = JSON.parse(await fleetStatus({ format: 'json', repo_path: repo }));
    expect(json.kbHealth.scopes[0].usage.cited_rate).toBeNull();
  });

  it('without repo_path the bible item carries KB_BIBLE_NO_REPO_REASON and the compact output shows no bible line', async () => {
    await seedScope(root, 'default', [{}]);
    const { fleetStatus, KB_BIBLE_NO_REPO_REASON } = await import('../src/tools/check-status.js');
    addAgent(makeTestAgent({ friendlyName: 'kb-d6-norepo-member' }));
    const json = JSON.parse(await fleetStatus({ format: 'json' }));
    expect(json.kbHealth.bible).toMatchObject({ repoPath: null, entries: null, drift: null, driftReason: KB_BIBLE_NO_REPO_REASON });
    expect(await fleetStatus({ format: 'compact' })).not.toContain('kb bible');
    expect(mockKbStats).not.toHaveBeenCalled();
  });

  it('degraded per half: a malformed bible file nulls only the bible entries; the host-DB line is still reported', async () => {
    await seedScope(root, 'default', [{ confidence: 'CONFIRMED' }, {}]);
    mkdirSync(join(repo, '.fleet'), { recursive: true });
    writeFileSync(join(repo, '.fleet', 'kb-canonical.json'), '{ not json');
    mockKbStats.mockResolvedValue(JSON.stringify({ ...flatStats(), bible: { present: false, entries: 0, drift: 1 } }));
    const { fleetStatus } = await import('../src/tools/check-status.js');
    addAgent(makeTestAgent({ friendlyName: 'kb-d6-badbible-member' }));

    const json = JSON.parse(await fleetStatus({ format: 'json', repo_path: repo }));
    expect(json.kbHealth.bible.entries).toBeNull();
    expect(json.kbHealth.bible.entriesError).toMatch(/^bible unreadable: /);
    expect(json.kbHealth.scopes.find((s: { scope: string }) => s.scope === 'default').totals.total).toBe(2);
    const compact = await fleetStatus({ format: 'compact', repo_path: repo });
    expect(compact).toContain('kb bible[default]: bible unreadable: ');
    expect(compact).toContain('kb[default]: 2 entries');
  });

  it('degraded per half: an unreadable host DB nulls only the drift; the bible entries are still reported', async () => {
    mkdirSync(join(root, 'default'), { recursive: true });
    writeFileSync(join(root, 'default', 'kb.sqlite'), 'this is not a sqlite database at all, just text padding it out');
    writeBible(4);
    const { fleetStatus, KB_BIBLE_DRIFT_UNAVAILABLE_REASON } = await import('../src/tools/check-status.js');
    addAgent(makeTestAgent({ friendlyName: 'kb-d6-baddb-member' }));

    const json = JSON.parse(await fleetStatus({ format: 'json', repo_path: repo }));
    expect(json.kbHealth.bible).toMatchObject({ present: true, entries: 4, drift: null, driftReason: KB_BIBLE_DRIFT_UNAVAILABLE_REASON });
    expect(json.kbHealth.errors.map((e: { scope: string }) => e.scope)).toEqual(['default']);
    const compact = await fleetStatus({ format: 'compact', repo_path: repo });
    expect(compact).toContain(`kb bible[default]: 4 entries | drift: n/a (${KB_BIBLE_DRIFT_UNAVAILABLE_REASON})`);
    expect(compact).toContain('kb[default]: unreadable');
    expect(mockKbStats).not.toHaveBeenCalled();
  });
});
