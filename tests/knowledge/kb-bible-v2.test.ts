import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { kbExport } from '../../src/tools/kb-export.js';
import { kbImport } from '../../src/tools/kb-import.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';

/**
 * Phase 3a of docs/superpowers/specs/2026-08-03-kb-trust-pipeline-design.md.
 *
 * The bible records the commit it was exported from, so a later audit can date
 * its entries against the tree they were verified on. That is a file-format
 * change, and compatibility is a hard requirement in BOTH directions:
 *
 *   - kb_import must accept a legacy bare array AND the v2 object.
 *   - a v2 bible fed to an older apra-fleet throws; acceptable, but it means
 *     the import side must ship before or with the export side, never after.
 *
 * The commit is recorded rather than a timestamp on purpose: entries are sorted
 * by id "so re-exports produce meaningful diffs", and a timestamp would defeat
 * that by producing a diff on every export even when nothing changed.
 */

let tmp: string;
let repo: string;
let provider: SqliteProvider;

function entry(over: Record<string, unknown> = {}) {
  return {
    type: 'knowledge' as const,
    title: 'A durable claim',
    summary: 'Something true about the repository.',
    content: 'Body text.',
    source_files: ['src/real.ts'],
    symbols: ['realSymbol'],
    tags: [],
    content_hash: '',
    content_hash_type: 'sha256' as const,
    flagged_for_review: false,
    author: 'test',
    source: 'session' as const,
    confidence: 'INFERRED' as const,
    ...over,
  };
}

const REASON = 'Verified against src/real.ts during the Phase 3a round-trip test.';

async function seedConfirmed(titles: string[]) {
  for (const title of titles) {
    const { id } = await provider.capture(entry({ title, symbols: [title.replace(/\s/g, '')] }));
    await provider.promote(id, REASON);
  }
}

function readBible(): any {
  return JSON.parse(fs.readFileSync(path.join(repo, '.fleet', 'kb-canonical.json'), 'utf-8'));
}

// The suite shells out to git twice per case (init + commit) and re-seeds a
// fresh in-memory SqliteProvider. Each op is sub-100ms in isolation, but under
// full-suite host contention on Windows this reliably blows past the 5000ms
// vitest default and the 10000ms default hook timeout -- see
// tests/register-member.test.ts / tests/task-wrapper.test.ts for the same
// per-test-timeout pattern applied to other git/subprocess-heavy suites.
beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-bible-v2-'));
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'real.ts'), 'export const real = 1;\n');
  execFileSync('git', ['init', '-q', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'seed'], { cwd: repo });

  provider = new SqliteProvider(':memory:', repo);
  await provider.init();
  vi.spyOn(kbProvidersModule, 'getKbProviders').mockResolvedValue({
    project: provider,
    global: provider,
    projectSlug: 'test',
  } as any);
}, 20000);

afterEach(() => {
  provider.close();
  vi.restoreAllMocks();
  // maxRetries/retryDelay let Node's own rmSync retry through the Windows
  // EBUSY window (antivirus/git holding a handle on .git files right after
  // the process exits) instead of throwing and cascading into the next
  // case's beforeEach hook timeout.
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}, 20000);

describe('kb_export writes the v2 envelope with its export commit', () => {
  it('records version, commit, branch and entry_count', async () => {
    await seedConfirmed(['Alpha claim', 'Beta claim']);
    // HEAD *before* the export. Since the 2026-08-11 default flip, kb_export
    // auto-commits the bible, which moves HEAD -- and the recorded commit is
    // deliberately the tree the entries were VERIFIED against, not the commit
    // that stored them (see the note above nextEntriesJson in kb-export.ts).
    // Reading HEAD afterwards would assert the opposite of that contract.
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim();
    await kbExport({ repo_path: repo });

    const bible = readBible();

    expect(bible.version).toBe(2);
    expect(bible.provenance.commit).toBe(head);
    expect(bible.provenance.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(bible.provenance.entry_count).toBe(2);
    expect(bible.entries).toHaveLength(2);
    expect(typeof bible.provenance.branch).toBe('string');
  }, 20000);

  it('entry_count matches the entry array, making truncation visible in a diff', async () => {
    await seedConfirmed(['One claim', 'Two claim', 'Three claim']);
    await kbExport({ repo_path: repo });

    const bible = readBible();
    expect(bible.provenance.entry_count).toBe(bible.entries.length);
  }, 20000);

  it('degrades to a null commit rather than throwing when the repo has no git', async () => {
    fs.rmSync(path.join(repo, '.git'), { recursive: true, force: true });
    await seedConfirmed(['Gitless claim']);

    await kbExport({ repo_path: repo });

    const bible = readBible();
    expect(bible.version).toBe(2);
    expect(bible.provenance.commit).toBeNull();
    expect(bible.entries).toHaveLength(1);
  }, 20000);
});

describe('two exports at the same commit are byte-identical (the no-timestamp property)', () => {
  it('produces an identical file when nothing changed', async () => {
    await seedConfirmed(['Stable claim']);

    await kbExport({ repo_path: repo });
    const first = fs.readFileSync(path.join(repo, '.fleet', 'kb-canonical.json'), 'utf-8');
    await kbExport({ repo_path: repo });
    const second = fs.readFileSync(path.join(repo, '.fleet', 'kb-canonical.json'), 'utf-8');

    expect(second).toBe(first);
  }, 20000);

  it('changes only when the entry set changes', async () => {
    await seedConfirmed(['First claim']);
    await kbExport({ repo_path: repo });
    const before = fs.readFileSync(path.join(repo, '.fleet', 'kb-canonical.json'), 'utf-8');

    await seedConfirmed(['Second claim']);
    await kbExport({ repo_path: repo });
    const after = fs.readFileSync(path.join(repo, '.fleet', 'kb-canonical.json'), 'utf-8');

    expect(after).not.toBe(before);
    expect(JSON.parse(after).entries).toHaveLength(2);
  }, 20000);
});

describe('kb_import accepts BOTH bible shapes identically', () => {
  const ENTRIES = [
    {
      id: 'shape-a',
      type: 'knowledge',
      title: 'Shape A claim',
      summary: 'A claim carried by both bible shapes.',
      symbols: ['shapeA'],
      source_files: ['src/real.ts'],
      confidence: 'CONFIRMED',
      updated_at: '2026-07-07T00:00:00.000Z',
    },
    {
      id: 'shape-b',
      type: 'knowledge',
      title: 'Shape B claim',
      summary: 'A second claim carried by both bible shapes.',
      symbols: ['shapeB'],
      source_files: ['src/real.ts'],
      confidence: 'CONFIRMED',
      updated_at: '2026-07-07T00:00:00.000Z',
    },
  ];

  it('imports a legacy bare-array bible unchanged', async () => {
    const p = path.join(tmp, 'legacy.json');
    fs.writeFileSync(p, JSON.stringify(ENTRIES));

    const report = JSON.parse(await kbImport({ repo: repo, path: p }));

    expect(report.imported).toBe(2);
    expect(report.rejected).toBe(0);
  }, 20000);

  it('imports a v2 object bible', async () => {
    const p = path.join(tmp, 'v2.json');
    fs.writeFileSync(p, JSON.stringify({
      version: 2,
      provenance: { commit: 'a'.repeat(40), branch: 'main', entry_count: 2 },
      entries: ENTRIES,
    }));

    const report = JSON.parse(await kbImport({ repo: repo, path: p }));

    expect(report.imported).toBe(2);
    expect(report.rejected).toBe(0);
  }, 20000);

  it('both shapes produce the same stored entry set', async () => {
    const legacyPath = path.join(tmp, 'legacy2.json');
    fs.writeFileSync(legacyPath, JSON.stringify(ENTRIES));
    await kbImport({ repo: repo, path: legacyPath });
    const fromLegacy = (await provider.query({ ids: ['shape-a', 'shape-b'] })).results
      .map((e) => `${e.id}:${e.title}:${e.confidence}`).sort();

    // Fresh KB, same entries via the v2 envelope.
    provider.close();
    provider = new SqliteProvider(':memory:', repo);
    await provider.init();
    vi.spyOn(kbProvidersModule, 'getKbProviders').mockResolvedValue({
      project: provider, global: provider, projectSlug: 'test',
    } as any);

    const v2Path = path.join(tmp, 'v2b.json');
    fs.writeFileSync(v2Path, JSON.stringify({
      version: 2,
      provenance: { commit: 'b'.repeat(40), branch: 'main', entry_count: 2 },
      entries: ENTRIES,
    }));
    await kbImport({ repo: repo, path: v2Path });
    const fromV2 = (await provider.query({ ids: ['shape-a', 'shape-b'] })).results
      .map((e) => `${e.id}:${e.title}:${e.confidence}`).sort();

    expect(fromV2).toEqual(fromLegacy);
  }, 20000);

  it('still refuses a shape that is neither an array nor an entries object', async () => {
    const p = path.join(tmp, 'bogus.json');
    fs.writeFileSync(p, JSON.stringify({ version: 2, provenance: {} }));

    await expect(kbImport({ repo: repo, path: p })).rejects.toThrow(/not a JSON array of entries/);
  }, 20000);
});

describe('a v2 export round-trips back through import', () => {
  it('preserves the entry set across export -> import', async () => {
    await seedConfirmed(['Round trip claim', 'Second round trip claim']);
    await kbExport({ repo_path: repo });

    const exported = readBible();
    expect(exported.version).toBe(2);
    const exportedIds = exported.entries.map((e: any) => e.id).sort();

    // Re-import into a fresh KB and confirm the same ids land.
    provider.close();
    provider = new SqliteProvider(':memory:', repo);
    await provider.init();
    vi.spyOn(kbProvidersModule, 'getKbProviders').mockResolvedValue({
      project: provider, global: provider, projectSlug: 'test',
    } as any);

    const report = JSON.parse(await kbImport({ repo: repo }));
    expect(report.imported).toBe(exportedIds.length);
    expect(report.rejected).toBe(0);

    const stored = (await provider.query({ ids: exportedIds })).results.map((e) => e.id).sort();
    expect(stored).toEqual(exportedIds);
  }, 20000);
});

describe('every bible reader handles both shapes', () => {
  // kb_stats degrades quietly by design (it never throws over the bible file),
  // so a reader that understood only the legacy array would silently report
  // present:false and a drift of every live CONFIRMED entry against a valid v2
  // bible. Nothing would surface that. Hence an explicit test per shape.
  it('kb_stats reports a v2 bible as present with the right entry count', async () => {
    const { kbStats } = await import('../../src/tools/kb-stats.js');
    await seedConfirmed(['Stats claim one', 'Stats claim two']);
    await kbExport({ repo_path: repo });

    const stats = JSON.parse(await kbStats({ repo: repo } as any));

    expect(stats.bible.present).toBe(true);
    expect(stats.bible.entries).toBe(2);
  }, 20000);

  it('kb_stats still reports a legacy bare-array bible as present', async () => {
    const { kbStats } = await import('../../src/tools/kb-stats.js');
    fs.mkdirSync(path.join(repo, '.fleet'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.fleet', 'kb-canonical.json'), JSON.stringify([
      {
        id: 'legacy-1', type: 'knowledge', title: 'Legacy claim',
        summary: 'From a bare-array bible.', symbols: [], source_files: ['src/real.ts'],
        confidence: 'CONFIRMED', updated_at: '2026-07-07T00:00:00.000Z',
      },
    ]));

    const stats = JSON.parse(await kbStats({ repo: repo } as any));

    expect(stats.bible.present).toBe(true);
    expect(stats.bible.entries).toBe(1);
  }, 20000);
});
