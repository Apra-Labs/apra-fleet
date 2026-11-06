import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { SqliteProvider } from '../src/services/knowledge/sqlite-provider.js';
import { resolveProjectSlug } from '../src/services/knowledge/project-slug.js';
import { runWithSessionMember } from '../src/services/tool-scope.js';
import type { KBEntryInput } from '../src/services/knowledge/types.js';

// End-to-end for D6: a temp repo with a committed-shape bible and a host KB DB
// holding a DIFFERENT entry set; usage reported through kb_usage (pushed and
// cited ids, some older than 30 days); one engine-origin read. fleet_status
// must report the bible separately from the host DB and a cited / returned
// hit rate over in-window events only, which the engine-origin read leaves
// untouched.
//
// Isolation: every file lives under one mkdtemp sandbox (repo + knowledge
// root). kb-scopes is pointed at the sandbox's knowledge root and
// getKbProviders at a SqliteProvider on the sandbox DB, so neither the real
// data dir nor the real KB is touched. kb_stats (bible drift), kb_usage and
// kb_query run unmocked.

const sandbox = vi.hoisted(() => ({ knowledgeRoot: '', provider: null as unknown }));

vi.mock('../src/services/knowledge/kb-scopes.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/services/knowledge/kb-scopes.js')>();
  return { ...actual, knowledgeRootDir: () => sandbox.knowledgeRoot };
});
vi.mock('../src/services/knowledge/kb-providers.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/services/knowledge/kb-providers.js')>();
  return {
    ...actual,
    getKbProviders: async () => ({ project: sandbox.provider, global: sandbox.provider, projectSlug: 'sandbox' }),
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

import { fleetStatus } from '../src/tools/check-status.js';
import { kbUsage } from '../src/tools/kb-usage.js';
import { kbQuery } from '../src/tools/kb-query.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const SANDBOX_PREFIX = 'kb-d6-e2e-';

function input(title: string, summary: string): KBEntryInput {
  return {
    type: 'knowledge', title, summary, content: `${summary} body`,
    source_files: [`src/${title.replace(/ /g, '-').toLowerCase()}.ts`], symbols: [title.replace(/ /g, '')], tags: [], content_hash: '', content_hash_type: 'sha256',
    flagged_for_review: false, author: 'test-agent', source: 'doer', confidence: 'INFERRED',
  };
}

function sandboxDirs(): string[] {
  return fs.readdirSync(os.tmpdir()).filter(n => n.startsWith(SANDBOX_PREFIX));
}

let root: string;
let repo: string;
let slug: string;
let provider: SqliteProvider;
let hostIds: string[];
let tmpBefore: string[];

beforeEach(async () => {
  tmpBefore = sandboxDirs();
  backupAndResetRegistry();
  root = fs.mkdtempSync(path.join(os.tmpdir(), SANDBOX_PREFIX));
  repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, '.fleet'), { recursive: true });
  execFileSync('git', ['init', '--quiet'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', 'https://example.invalid/acme/kb-d6-e2e.git'], { cwd: repo });
  slug = resolveProjectSlug(repo);

  // The bible: two entries the host DB does not hold, last updated long ago.
  fs.writeFileSync(path.join(repo, '.fleet', 'kb-canonical.json'), JSON.stringify({
    version: 3,
    provenance: { branch: 'main', commit: 'deadbeef', entry_count: 2 },
    entries: [
      { id: 'bible-only-1', type: 'knowledge', title: 'Bible one', summary: 's', content: 'c', confidence: 'CONFIRMED', updated_at: '2026-01-01T00:00:00.000Z' },
      { id: 'bible-only-2', type: 'knowledge', title: 'Bible two', summary: 's', content: 'c', confidence: 'CONFIRMED', updated_at: '2026-01-02T00:00:00.000Z' },
    ],
  }));

  // The host DB: a different set -- three entries promoted to CONFIRMED after
  // the bible's newest updated_at (so drift = 3) plus one INFERRED.
  sandbox.knowledgeRoot = path.join(root, 'knowledge');
  provider = new SqliteProvider(path.join(sandbox.knowledgeRoot, slug, 'kb.sqlite'));
  await provider.init();
  sandbox.provider = provider;
  hostIds = [];
  for (const [title, summary] of [['Host alpha', 'quokka alpha'], ['Host beta', 'quokka beta'], ['Host gamma', 'quokka gamma']]) {
    const { id } = await provider.capture(input(title, summary));
    await provider.promote(id, 'e2e fixture: verified against the sandbox tree');
    await provider.promote(id, 'e2e fixture: verified against the sandbox tree');
    hostIds.push(id);
  }
  await provider.capture(input('Host delta', 'unrelated inferred note'));

  addAgent(makeTestAgent({ friendlyName: 'kb-d6-e2e-member' }));
});

afterEach(() => {
  vi.useRealTimers();
  provider.close();
  restoreRegistry();
  fs.rmSync(root, { recursive: true, force: true });
});

async function useCounts(): Promise<Record<string, number>> {
  const rows = await provider.list({ confidence: ['CONFIRMED', 'INFERRED', 'UNVERIFIED'] });
  return Object.fromEntries(rows.map(r => [r.id, r.use_count]));
}

describe('fleet_status D6 end to end: bible vs host DB, 30-day cited hit rate', () => {
  it('reports the bible separately from the host DB; hit rate counts in-window kb_usage events only; an engine-origin read moves nothing', async () => {
    const anchor = { folder: repo };

    // Events older than 30 days, reported through kb_usage at that time.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() - 40 * DAY_MS));
    expect(JSON.parse(await kbUsage({ pushed: ['bible-only-1', 'bible-only-2', hostIds[0]], cited: ['bible-only-1', 'bible-only-2', hostIds[0]] }, anchor)))
      .toEqual({ recorded: { returned: 3, cited: 3 } });
    vi.useRealTimers();

    // In-window events: 4 pushed (one a bible-only id), 1 cited.
    expect(JSON.parse(await kbUsage({ pushed: [...hostIds, 'bible-only-1'], cited: [hostIds[1]] }, anchor)))
      .toEqual({ recorded: { returned: 4, cited: 1 } });

    const before = JSON.parse(await fleetStatus({ format: 'json', repo_path: repo }));
    const compactBefore = await fleetStatus({ format: 'compact', repo_path: repo });
    const useBefore = await useCounts();

    // Bible item, separate from the host DB counts.
    expect(before.kbHealth.bible).toEqual({ repoPath: repo, scope: slug, present: true, entries: 2, drift: 3 });
    const host = before.kbHealth.scopes.find((s: { scope: string }) => s.scope === slug);
    expect(host.totals.total).toBe(4);
    expect(host.totals.by_confidence.CONFIRMED).toBe(3);
    // Hit rate: in-window only -- 1 cited / 4 returned. The older 3/3 would
    // have pulled it to 4/7 if counted.
    expect(host.usage).toEqual({ window_days: 30, returned: 4, cited: 1, cited_rate: 0.25 });
    expect(compactBefore).toContain(`kb bible[${slug}]: 2 entries | drift: 3 promotions behind`);
    expect(compactBefore).toContain(`kb[${slug}]: 4 entries (confirmed:3 stale:0 flagged:0) | hit-rate(30d):25% (1 cited/4 returned)`);

    // One engine-origin read (the engine's own knowledgeFor-style kb_query).
    const read = JSON.parse(await runWithSessionMember(undefined, () => kbQuery({ query: 'quokka' }, anchor), { engineOrigin: true }));
    expect(read.l1_results.length).toBeGreaterThan(0);

    const after = JSON.parse(await fleetStatus({ format: 'json', repo_path: repo }));
    expect(await useCounts()).toEqual(useBefore);
    expect(after.kbHealth.scopes.find((s: { scope: string }) => s.scope === slug).usage)
      .toEqual({ window_days: 30, returned: 4, cited: 1, cited_rate: 0.25 });
    expect(after.kbHealth.bible).toEqual(before.kbHealth.bible);
    expect(await fleetStatus({ format: 'compact', repo_path: repo })).toBe(compactBefore);

    // Control: the same read from an agent session does count.
    await kbQuery({ query: 'quokka' }, anchor);
    expect(provider.usageStats().returned).toBeGreaterThan(4);
  });

  it('leaves no files outside the test sandbox', async () => {
    await kbUsage({ pushed: [hostIds[0]], cited: [] }, { folder: repo });
    await fleetStatus({ format: 'json', repo_path: repo });
    const created = sandboxDirs().filter(n => !tmpBefore.includes(n));
    expect(created).toEqual([path.basename(root)]);
    // Everything the run wrote is under the sandbox: the host DB and the repo.
    expect(fs.existsSync(path.join(sandbox.knowledgeRoot, slug, 'kb.sqlite'))).toBe(true);
    expect(fs.readdirSync(sandbox.knowledgeRoot)).toEqual([slug]);
  });
});
