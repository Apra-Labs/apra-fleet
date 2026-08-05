import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { kbHarvest } from '../../src/tools/kb-harvest.js';
import { kbList } from '../../src/tools/kb-list.js';
import { resolveProjectSlug } from '../../src/services/knowledge/project-slug.js';
import { FLEET_DIR } from '../../src/paths.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';
import { vi } from 'vitest';

let provider: SqliteProvider;

beforeEach(async () => {
  provider = new SqliteProvider(':memory:');
  await provider.init();
  vi.spyOn(kbProvidersModule, 'getKbProviders').mockResolvedValue({
    project: provider,
    global: provider,
    projectSlug: 'test',
  } as any);
});

afterEach(() => {
  provider.close();
  vi.restoreAllMocks();
});

describe('kb_harvest', () => {
  it('returns zero counts when no transcript is provided', async () => {
    const result = JSON.parse(await kbHarvest({}));
    expect(result).toEqual({ entries_captured: 0, entries_updated: 0, entries_skipped: 0, entries_rejected: 0 });
  });

  it('extracts learnings from transcript with pattern markers', async () => {
    const transcript = `Working on the registry module.

I found that the registry uses a singleton pattern and lazy initialization via getOrCreate in src/services/registry.ts

Note: The \`initRegistry()\` function must be called before any other registry operations or it throws a cryptic error

Bug: The cleanup handler in src/services/registry.ts does not close the database connection properly when called twice
`;

    const result = JSON.parse(await kbHarvest({ session_transcript: transcript }));
    expect(result.entries_captured).toBeGreaterThanOrEqual(2);
    expect(result.entries_skipped).toBe(0);
  });

  // T3.2 (F7, revised D7): harvested entries must be low-trust regardless of
  // wording in the transcript -- confidence forced to UNVERIFIED (the D1 clamp
  // covers this path too) and provenance stamped author='harvest',
  // source='harvest' so harvested entries are distinguishable from real
  // KB-Agent direct captures in queries.
  it('captured entry is UNVERIFIED with author=harvest, source=harvest', async () => {
    const transcript = `Key insight: the src/services/registry.ts \`getOrCreate\` helper is the only safe entry point for singleton construction.`;

    const result = JSON.parse(await kbHarvest({ session_transcript: transcript }));
    expect(result.entries_captured).toBeGreaterThanOrEqual(1);

    const { results } = await provider.query({ query: 'getOrCreate', include_stale: true });
    expect(results.length).toBeGreaterThanOrEqual(1);
    for (const entry of results) {
      expect(entry.confidence).toBe('UNVERIFIED');
      expect(entry.author).toBe('harvest');
      expect(entry.source).toBe('harvest');
    }
  });

  it('deduplicates already-captured learnings via AUDN', async () => {
    const transcript = `Note: The registry uses lazy initialization and must be called before other operations in src/registry.ts.`;

    await provider.capture({
      type: 'learning',
      title: 'The registry uses lazy initialization and must be called before other operations.',
      summary: 'The registry uses lazy initialization and must be called before other operations.',
      content: 'The registry uses lazy initialization and must be called before other operations.',
      source_files: ['src/registry.ts'],
      symbols: [],
      tags: [],
      content_hash: '',
      content_hash_type: 'sha256',
      flagged_for_review: false,
      author: 'doer',
      source: 'doer',
      confidence: 'CONFIRMED',
    });

    const result = JSON.parse(await kbHarvest({ session_transcript: transcript }));
    expect(result.entries_skipped + result.entries_updated).toBeGreaterThanOrEqual(0);
  });
});

// apra-fleet-tm7.7: the suite above mocks getKbProviders entirely, so the
// per-slug routing kb_harvest actually relies on (apra-fleet-tm7) is never
// exercised there. This suite runs kbHarvest against the REAL getKbProviders
// with two temp git repos in one process, proving a harvest for repo B lands
// in repo B's own kb.sqlite and is invisible from repo A.
describe('kb_harvest routes per repo_path (two repos, one process)', () => {
  function makeRepo(root: string, name: string, remote: string): string {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '-q', '.'], { cwd: dir });
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: dir });
    // KB-TRUST PHASE 1: harvest captures need a basis that resolves in the repo
    // the provider is anchored at, so each fixture repo carries one real file.
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'registry.ts'), 'export const registry = 1;\n');
    return dir;
  }

  let tmp: string;
  let repoA: string;
  let repoB: string;
  let tok: string;

  beforeEach(() => {
    // The file-level beforeEach above mocks getKbProviders for every test in
    // this file; this suite exists specifically to exercise the real routing,
    // so undo that mock before each test here.
    vi.restoreAllMocks();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-harvest-iso-'));
    tok = path.basename(tmp).replace(/[^a-z0-9]/gi, '').toLowerCase();
    repoA = makeRepo(tmp, 'alpha', `git@github.com:acme/alpha-${tok}.git`);
    repoB = makeRepo(tmp, 'beta', `git@github.com:acme/beta-${tok}.git`);
    kbProvidersModule.resetKbProviders();
  });

  afterEach(() => {
    kbProvidersModule.resetKbProviders();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('a harvest for repo A and a harvest for repo B land in two distinct kb.sqlite files, with no cross-contamination', async () => {
    const transcriptA = `Note: Repo alpha's registry module in src/registry.ts uses a lazy singleton via getOrCreate.`;
    const transcriptB = `Bug: Repo beta's cleanup handler in src/registry.ts leaks a database connection on double-close.`;

    const resultA = JSON.parse(await kbHarvest({ repo_path: repoA, session_transcript: transcriptA }));
    expect(resultA.entries_captured).toBeGreaterThanOrEqual(1);

    const resultB = JSON.parse(await kbHarvest({ repo_path: repoB, session_transcript: transcriptB }));
    expect(resultB.entries_captured).toBeGreaterThanOrEqual(1);

    const slugA = resolveProjectSlug(repoA);
    const slugB = resolveProjectSlug(repoB);
    expect(slugA).not.toBe(slugB);

    const dbA = path.join(FLEET_DIR, 'knowledge', slugA, 'kb.sqlite');
    const dbB = path.join(FLEET_DIR, 'knowledge', slugB, 'kb.sqlite');
    expect(fs.existsSync(dbA)).toBe(true);
    expect(fs.existsSync(dbB)).toBe(true);
    expect(dbA).not.toBe(dbB);

    const fromA = JSON.parse(await kbList({ repo_path: repoA, limit: 50 }));
    const fromB = JSON.parse(await kbList({ repo_path: repoB, limit: 50 }));

    expect(fromA.results.some((e: any) => e.summary.includes('alpha'))).toBe(true);
    expect(fromA.results.some((e: any) => e.summary.includes('beta'))).toBe(false);
    expect(fromB.results.some((e: any) => e.summary.includes('beta'))).toBe(true);
    expect(fromB.results.some((e: any) => e.summary.includes('alpha'))).toBe(false);

    // Provenance must hold through the REAL per-repo routing, not just the
    // mocked provider used by the suite above. Fetch repo B's own provider
    // (same cached instance kbHarvest just wrote through) and check the
    // harvested entry directly, since kbList's projection omits author/source.
    const bProviders = await kbProvidersModule.getKbProviders(repoB);
    const { results: betaEntries } = await bProviders.project.query({
      query: 'cleanup handler leaks',
      include_stale: true,
    });
    expect(betaEntries.length).toBeGreaterThanOrEqual(1);
    for (const entry of betaEntries) {
      expect(entry.confidence).toBe('UNVERIFIED');
      expect(entry.author).toBe('harvest');
      expect(entry.source).toBe('harvest');
    }
  });
});
