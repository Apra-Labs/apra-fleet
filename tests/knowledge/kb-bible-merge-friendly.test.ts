import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { kbBibleCommit } from '../../src/tools/kb-bible-commit.js';
import { asciiSafeStringify } from '../../src/tools/kb-export.js';
import { kbImport } from '../../src/tools/kb-import.js';
import { parseBibleDocument } from '../../src/services/knowledge/bible-import.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';
import { releaseFileDataDir } from '../helpers/file-kb-data-dir.js';

// This file's OWN fleet data dir, claimed before any src module loads: the
// per-run one is shared by every file, and so is the KB config in it.
const fileDataDir = await vi.hoisted(async () =>
  (await import('../helpers/file-kb-data-dir.js')).claimFileDataDir('kb-bible-merge-friendly'));
afterAll(() => releaseFileDataDir(fileDataDir));

// The bible is merged by plain git text merge (a hosted merge runs no custom
// merge driver). Two branches that each add different entries and tombstones
// must merge with NO conflict, so the file may hold no line both branches
// rewrite: no per-file commit, no entry count. This drives the REAL writer
// (kb_bible_commit) on two real branches and runs a real `git merge`.

const BIBLE_REL = '.fleet/kb-canonical.json';
const NOTE = 'the claim no longer holds against the cited source file';
const REPO_ROOT = path.resolve(__dirname, '..', '..');
// A commit on the base branch from before the merge-friendly layout: its
// merge tool is an older bible reader, run as shipped against the new file.
const PRE_CHANGE_COMMIT = '0b13b1ccc8993e056c90ef347492ea9208ebabe2';

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

let root: string;
let repo: string;
let provider: SqliteProvider;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-bible-merge-'));
  repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  git(root, ['init', '--quiet', '-b', 'main', repo]);
  git(repo, ['config', 'user.name', 'test']);
  git(repo, ['config', 'user.email', 'test@example.invalid']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(repo, 'src', 'example.ts'), 'export const example = 1;\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '--quiet', '--no-verify', '-m', 'seed']);
  provider = new SqliteProvider(':memory:', repo);
  await provider.init();
  vi.spyOn(kbProvidersModule, 'getKbProviders').mockResolvedValue({
    project: provider, global: provider, projectSlug: 'test',
  } as never);
});

afterEach(() => {
  provider.close();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function confirmed(n: number): Promise<string> {
  const { id } = await provider.capture({
    type: 'knowledge', title: 'Distinct claim number ' + n, summary: 'Summary of distinct claim ' + n,
    content: 'Content body of claim ' + n, source_files: ['src/example.ts'], symbols: ['sym' + n], tags: [],
    content_hash: '', content_hash_type: 'sha256', flagged_for_review: false, author: 'test', source: 'doer',
    confidence: 'INFERRED',
  });
  await provider.promote(id, 'test fixture: basis verified');
  return id;
}

function readBible(): { version: number; provenance: Record<string, unknown>; entries: { id: string }[]; demotions?: { id: string; reason: string }[] } {
  return JSON.parse(fs.readFileSync(path.join(repo, BIBLE_REL), 'utf-8'));
}

describe('bible text merge', () => {
  it('two branches that each add different entries and tombstones merge with no conflict', async () => {
    // Ten CONFIRMED ids, sorted, so each branch's additions land in a known gap
    // between two base items -- ids are random, positions are not.
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push(await confirmed(i));
    const s = [...ids].sort();

    // Base: five entries and one tombstone in the middle of the id order.
    const base = JSON.parse(await kbBibleCommit({
      ids: [s[1], s[3], s[5], s[7], s[9]], baseBranch: 'main', baseCommit: git(repo, ['rev-parse', 'HEAD']).trim(),
      withdrawals: [{ id: s[4], note: NOTE, evidence_files: ['src/example.ts'] }],
    }, { folder: repo }));
    expect(base.committed).toBe(true);
    const baseCommitA = git(repo, ['rev-parse', 'HEAD']).trim();

    // Branch A: verified against the base commit. Adds entry s2 (between s1 and
    // s3) and a tombstone for s0 (before s4).
    git(repo, ['checkout', '--quiet', '-b', 'branch-a']);
    const a = JSON.parse(await kbBibleCommit({
      ids: [s[2]], baseBranch: 'main', baseCommit: baseCommitA,
      withdrawals: [{ id: s[0], note: NOTE, evidence_files: ['src/example.ts'] }],
    }, { folder: repo }));
    expect(a.merged).toEqual([s[2]]);
    expect(a.committed).toBe(true);

    // The base branch moves on, so branch B is verified against a DIFFERENT
    // base commit -- the line a per-file commit field used to conflict on.
    git(repo, ['checkout', '--quiet', 'main']);
    fs.writeFileSync(path.join(repo, 'README.md'), 'unrelated\n');
    git(repo, ['add', 'README.md']);
    git(repo, ['commit', '--quiet', '--no-verify', '-m', 'unrelated base change']);
    const baseCommitB = git(repo, ['rev-parse', 'HEAD']).trim();
    expect(baseCommitB).not.toBe(baseCommitA);

    // Branch B: adds entry s6 (between s5 and s7) and a tombstone for s8 (after s4).
    git(repo, ['checkout', '--quiet', '-b', 'branch-b']);
    const b = JSON.parse(await kbBibleCommit({
      ids: [s[6]], baseBranch: 'main', baseCommit: baseCommitB,
      withdrawals: [{ id: s[8], note: NOTE, evidence_files: ['src/example.ts'] }],
    }, { folder: repo }));
    expect(b.merged).toEqual([s[6]]);
    expect(b.committed).toBe(true);
    expect(git(repo, ['log', '-1', '--format=%(trailers:key=Verified-Against,valueonly)']).trim()).toBe(baseCommitB);

    // A plain text merge: no merge driver, no rerere.
    git(repo, ['checkout', '--quiet', 'branch-a']);
    const merge = spawnSync('git', ['-c', 'rerere.enabled=false', 'merge', '--no-edit', '--no-ff', 'branch-b'], {
      cwd: repo, encoding: 'utf-8',
    });
    expect(merge.stdout + merge.stderr).not.toMatch(/CONFLICT/);
    expect(merge.status).toBe(0);

    const merged = readBible();
    expect(merged.provenance).toEqual({ branch: 'main' });
    expect(merged.entries.map(e => e.id)).toEqual([s[1], s[2], s[3], s[5], s[6], s[7], s[9]]);
    expect((merged.demotions ?? []).map(d => [d.id, d.reason])).toEqual([
      [s[0], 'withdrawn'], [s[4], 'withdrawn'], [s[8], 'withdrawn'],
    ]);
    // The merge result is itself in the exporter's exact serialization, so the
    // next writer round-trips it unchanged.
    const raw = fs.readFileSync(path.join(repo, BIBLE_REL), 'utf-8');
    expect(raw).toBe(asciiSafeStringify(merged) + '\n');
    const doc = parseBibleDocument(raw, BIBLE_REL, 'test');
    expect(doc.entries).toHaveLength(7);
    expect(doc.provenanceBranch).toBe('main');
  }, 60000);
});

describe('upgrade safety', () => {
  it('a bible with the legacy provenance (commit, entry_count) still imports', async () => {
    const example = JSON.parse(fs.readFileSync(
      path.join(REPO_ROOT, 'memory-contract', 'v1', 'bible', 'examples', 'v2-envelope.json'), 'utf-8'));
    expect(Object.keys(example.provenance).sort()).toEqual(['branch', 'commit', 'entry_count']);
    const entries = [0, 1].map(n => ({
      id: 'legacy-entry-' + n, type: 'knowledge', title: 'Legacy imported claim ' + n,
      summary: 'Summary of legacy claim ' + n, symbols: ['legacy' + n], source_files: ['src/example.ts'],
      confidence: 'CONFIRMED', updated_at: '2026-01-01T00:00:00.000Z',
    }));
    const imported: number[] = [];
    for (const version of [2, 3]) {
      fs.mkdirSync(path.join(repo, '.fleet'), { recursive: true });
      fs.writeFileSync(path.join(repo, BIBLE_REL), JSON.stringify({
        version, provenance: { commit: 'c'.repeat(40), branch: 'main', entry_count: entries.length }, entries,
      }, null, 2) + '\n');
      const report = JSON.parse(await kbImport({ skip_sweep: true }, { folder: repo }));
      expect(report.rejected).toBe(0);
      expect(report.imported + report.skipped + report.linked).toBe(entries.length);
      imported.push(report.imported);
    }
    // The v2 file imports both entries; the v3 file with the same ids adds nothing new.
    expect(imported).toEqual([2, 0]);
  }, 30000);

  it('an older reader (the merge tool as shipped before this layout) reads a new-format bible', async () => {
    const id = await confirmed(1);
    await kbBibleCommit({ ids: [id], baseBranch: 'main', baseCommit: git(repo, ['rev-parse', 'HEAD']).trim() }, { folder: repo });
    const current = readBible();
    expect(current.provenance).toEqual({ branch: 'main' });

    const has = spawnSync('git', ['cat-file', '-e', PRE_CHANGE_COMMIT + '^{commit}'], { cwd: REPO_ROOT });
    expect(has.status, 'the pre-change commit ' + PRE_CHANGE_COMMIT + ' must be in this clone (fetch full history)').toBe(0);
    const oldTool = git(REPO_ROOT, ['show', PRE_CHANGE_COMMIT + ':packages/apra-fleet-se/scripts/merge-kb-canonical.mjs']);
    expect(oldTool).toContain('entry_count');
    const oldPath = path.join(root, 'old-merge-kb-canonical.mjs');
    fs.writeFileSync(oldPath, oldTool);
    const old = await import(pathToFileURL(oldPath).href);
    const result = old.mergeKbCanonical(current, current, current);
    expect(result.conflicts).toEqual([]);
    expect(result.merged.entries.map((e: { id: string }) => e.id)).toEqual([id]);
  }, 30000);
});
