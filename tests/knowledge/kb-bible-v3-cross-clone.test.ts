import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { kbBibleCommit } from '../../src/tools/kb-bible-commit.js';
import { kbExport } from '../../src/tools/kb-export.js';
import { kbImport } from '../../src/tools/kb-import.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';
import { computeFileHashBatch } from '../../src/services/knowledge/file-hash.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';

// [test] Bible v3: the hash basis travels WITH the knowledge across clones.
//
// Real git work trees under one temp root (removed in afterEach):
//   - origin (bare) <- repo A pushes the cited file at commit C0.
//   - clone B: cloned at C0, then commits a DIFFERENT src/cited.ts.
//   - clone C: cloned at C0, cited file untouched (matches A).
//   - repo A captures + promotes an entry citing src/cited.ts; kb_bible_commit
//     writes the v3 bible (per-entry source_file_hashes) and commits it.
// B and C import A's bible by path (their own checkouts were cloned before the
// bible commit, so the entry is not already in their bible file), then run
// kb_export and kb_bible_commit for that id.
//
// Each work tree has its own KB (one SqliteProvider per repo, selected by the
// mocked getKbProviders from the repo path it is called with).
//
// REVERT GUARD: if the reader change is reverted (kb_import re-hashes the
// LOCAL cited file instead of storing the carried basis), the assertion
// "B stores A's carried hash, not its own" (the first expect on
// storedOnB in the differing-clone test) fails: B would store its own hash,
// the predicate would admit the entry and B would re-export and merge it.

const BIBLE_REL = '.fleet/kb-canonical.json';
const REASON = 'verified for test: the cited file was re-read';

let root: string;
let origin: string;
let repoA: string;
let cloneB: string;
let cloneC: string;
const providers = new Map<string, SqliteProvider>();

function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.local', '-c', 'commit.gpgsign=false', ...args],
    { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function makeInput(overrides: Partial<KBEntryInput> = {}): KBEntryInput {
  return {
    type: 'knowledge',
    title: 'citedFn returns one',
    summary: 'citedFn in src/cited.ts returns the constant one.',
    content: 'citedFn() returns 1.',
    source_files: ['src/cited.ts'],
    symbols: ['citedFn'],
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

function readBible(dir: string): { version: number; entries: Array<{ id: string; source_file_hashes?: Record<string, string> }> } {
  return JSON.parse(fs.readFileSync(path.join(dir, BIBLE_REL), 'utf-8'));
}

function headOf(dir: string): string {
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

async function providerFor(dir: string): Promise<SqliteProvider> {
  const p = new SqliteProvider(path.join(root, path.basename(dir) + '.kb.sqlite'), dir);
  await p.init();
  providers.set(path.resolve(dir), p);
  return p;
}

/** Repo A captures + promotes an entry and commits it to a v3 bible. Returns the id and A's bible path. */
async function seedBibleInA(): Promise<{ id: string; biblePath: string; carried: Record<string, string> }> {
  const pa = providers.get(path.resolve(repoA))!;
  const { id } = await pa.capture(makeInput());
  await pa.promote(id, REASON);
  const res = JSON.parse(await kbBibleCommit({ ids: [id], baseBranch: 'main', baseCommit: headOf(repoA) }, { folder: repoA }));
  expect(res.merged).toEqual([id]);
  expect(res.committed).toBe(true);
  const bible = readBible(repoA);
  expect(bible.version).toBe(3);
  const carried = bible.entries.find(e => e.id === id)!.source_file_hashes!;
  expect(carried).toEqual(pa.getSourceFileBases([id]).get(id));
  return { id, biblePath: path.join(repoA, BIBLE_REL), carried };
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-bible-v3-cross-clone-'));
  origin = path.join(root, 'origin.git');
  repoA = path.join(root, 'repo-a');
  cloneB = path.join(root, 'clone-b');
  cloneC = path.join(root, 'clone-c');

  execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '--quiet', origin, repoA], { stdio: ['ignore', 'pipe', 'pipe'] });
  git(repoA, ['checkout', '--quiet', '-B', 'main']);
  fs.mkdirSync(path.join(repoA, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoA, 'src', 'cited.ts'), 'export function citedFn() { return 1; }\n');
  git(repoA, ['add', '-A']);
  git(repoA, ['commit', '--quiet', '-m', 'C0: cited file']);
  git(repoA, ['push', '--quiet', 'origin', 'main']);

  // Both clones are taken at C0, BEFORE A's bible commit.
  for (const dir of [cloneB, cloneC]) {
    execFileSync('git', ['clone', '--quiet', origin, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  }
  // B's cited file diverges and is committed differently.
  fs.writeFileSync(path.join(cloneB, 'src', 'cited.ts'), 'export function citedFn() { return 2; }\n');
  git(cloneB, ['commit', '--quiet', '-am', 'B: cited file diverges']);

  for (const dir of [repoA, cloneB, cloneC]) await providerFor(dir);
  vi.spyOn(kbProvidersModule, 'getKbProviders').mockImplementation(async (repoPath: string) => {
    const p = providers.get(path.resolve(repoPath));
    if (!p) throw new Error('test: no provider for ' + repoPath);
    return { project: p, global: p, projectSlug: path.basename(repoPath) } as any;
  });
});

afterEach(() => {
  for (const p of providers.values()) p.close();
  providers.clear();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('bible v3 basis across clones', () => {
  it('clone B with a differing cited file stores A\'s carried hash and neither re-exports nor merges the entry', async () => {
    const { id, biblePath, carried } = await seedBibleInA();
    const pb = providers.get(path.resolve(cloneB))!;

    // skip_sweep keeps the entry live CONFIRMED so the bible predicate (not the
    // freshness sweep) is what keeps it out of B's bible.
    const report = JSON.parse(await kbImport({ path: biblePath, skip_sweep: true }, { folder: cloneB }));
    expect(report.imported).toBe(1);

    const storedOnB = pb.getSourceFileBases([id]).get(id);
    // REVERT GUARD (see header): fails if kb_import re-hashes B's own file.
    expect(storedOnB).toEqual(carried);
    const bOwnHash = (await computeFileHashBatch(['src/cited.ts'], { cwd: cloneB }))['src/cited.ts']!.hash;
    expect(storedOnB!['src/cited.ts']).not.toBe(bOwnHash);

    const exportRes = JSON.parse(await kbExport({ scope: 'project' }, { folder: cloneB }));
    expect(exportRes.committed).toBe(false);
    expect(fs.existsSync(path.join(cloneB, BIBLE_REL))).toBe(false);

    const commitRes = JSON.parse(await kbBibleCommit({ ids: [id], baseBranch: 'main', baseCommit: headOf(cloneB) }, { folder: cloneB }));
    expect(commitRes.merged).toEqual([]);
    expect(commitRes.skipped).toEqual([{ id, reason: 'basis_mismatch' }]);
    expect(commitRes.committed).toBe(false);
    expect(fs.existsSync(path.join(cloneB, BIBLE_REL))).toBe(false);
  });

  it('clone C whose cited file matches re-exports the entry with the same source_file_hashes it arrived with', async () => {
    const { id, biblePath, carried } = await seedBibleInA();

    const report = JSON.parse(await kbImport({ path: biblePath }, { folder: cloneC }));
    expect(report.imported).toBe(1);
    expect(report.sweep.staled).toBe(0);

    const exportRes = JSON.parse(await kbExport({ scope: 'project' }, { folder: cloneC }));
    expect(exportRes.exported).toBe(1);
    const bibleC = readBible(cloneC);
    expect(bibleC.version).toBe(3);
    expect(bibleC.entries.map(e => e.id)).toEqual([id]);
    expect(bibleC.entries[0].source_file_hashes).toEqual(carried);
  });

  it('a v2 bible imported on B yields basis-less entries that are excluded from re-export', async () => {
    const { id } = await seedBibleInA();
    // A's bible rewritten as a v2 file: same entries, no per-entry hashes.
    const v3 = readBible(repoA);
    const v2Entries = v3.entries.map(({ source_file_hashes: _h, ...rest }) => rest);
    const v2Path = path.join(root, 'bible-v2.json');
    fs.writeFileSync(v2Path, JSON.stringify({ version: 2, provenance: { commit: null, branch: 'main', entry_count: v2Entries.length }, entries: v2Entries }, null, 2) + '\n');

    const pb = providers.get(path.resolve(cloneB))!;
    const report = JSON.parse(await kbImport({ path: v2Path, skip_sweep: true }, { folder: cloneB }));
    expect(report.imported).toBe(1);
    expect(pb.getSourceFileBases([id]).get(id)).toBeNull();

    // Even on clone C, where the cited file matches, a basis-less entry is not re-exported.
    const pc = providers.get(path.resolve(cloneC))!;
    await kbImport({ path: v2Path, skip_sweep: true }, { folder: cloneC });
    expect(pc.getSourceFileBases([id]).get(id)).toBeNull();
    for (const dir of [cloneB, cloneC]) {
      const res = JSON.parse(await kbExport({ scope: 'project' }, { folder: dir }));
      expect(res.exported).toBe(0);
      expect(fs.existsSync(path.join(dir, BIBLE_REL))).toBe(false);
    }
  });
});
