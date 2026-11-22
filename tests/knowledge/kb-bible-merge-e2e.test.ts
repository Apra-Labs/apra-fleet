/**
 * End to end: two branches that each change the knowledge bible merge safely,
 * and the result validates and imports. Real git in a temp dir (never the
 * working checkout); the bible is written by the real writer (kb_bible_commit).
 *
 *   (1) Branch A adds an entry and a withdrawn tombstone, branch B adds a
 *       different entry and a demoted tombstone. A plain `git merge` with NO
 *       merge driver configured has no text conflict (the merge-friendly format).
 *   (2) In a clone set up by kb_setup, branches that touch the SAME id (one adds
 *       entry X, the other withdraws X) merge through the registered bible merge
 *       driver: the file is resolved, not conflicted, and the tombstone wins.
 *       A plain clone (no kb_setup) merges the same branches to a file holding X
 *       as both an entry and a tombstone, which the validator rejects -- so the
 *       resolved result in (2) is the driver's work.
 *   (3) The merged bible passes scripts/check-kb-canonical.mjs (exit 0) and
 *       kb_import of it into a fresh KB holds exactly the merged entry ids, with
 *       every tombstoned id absent.
 *
 * Reverting the format change makes (1) fail. Checked by temporarily replacing
 * both `provenance: bibleProvenance(input.baseBranch)` writes in
 * src/tools/kb-bible-commit.ts with the shape before the merge-friendly layout,
 * `{ branch, commit: input.baseCommit, entry_count: entries.length }`: branches
 * A and B are verified against different base commits and write different
 * entry counts, so both rewrite the same provenance lines and the plain merge
 * stops with "CONFLICT (content): Merge conflict in .fleet/kb-canonical.json"
 * (the CONFLICT assertion in (1) fails).
 *
 * The merge driver runs the BUILT CLI (dist/index.js): run `npm run build` first.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { kbBibleCommit } from '../../src/tools/kb-bible-commit.js';
import { kbImport } from '../../src/tools/kb-import.js';
import { kbSetup } from '../../src/tools/kb-setup.js';
import { _setKbInvalidateCommandOverride } from '../../src/tools/kb-invalidate.js';
import { serializeBible } from '../../src/services/knowledge/bible-merge.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';
import { releaseFileDataDir } from '../helpers/file-kb-data-dir.js';
import { isolateGitConfig } from './isolate-git-config.js';
// @ts-expect-error -- plain .mjs script without type declarations
import { validateBibleText } from '../../scripts/check-kb-canonical.mjs';

// This file's OWN fleet data dir (and so its own KB config, which kb_setup
// writes), claimed before any src module loads.
const fileDataDir = await vi.hoisted(async () =>
  (await import('../helpers/file-kb-data-dir.js')).claimFileDataDir('kb-bible-merge-e2e'));
afterAll(() => releaseFileDataDir(fileDataDir));

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DIST_INDEX = path.join(REPO_ROOT, 'dist', 'index.js');
const CHECK_SCRIPT = path.join(REPO_ROOT, 'scripts', 'check-kb-canonical.mjs');
const BIBLE_REL = '.fleet/kb-canonical.json';
const NOTE = 'the claim no longer holds against the cited source file';
const EVIDENCE = ['src/example.ts'];
// Distinct wording per claim, so the import's duplicate detection never folds two together.
const TOPICS = ['parser', 'scheduler', 'cache', 'socket', 'ledger', 'renderer', 'tokenizer', 'mailer', 'indexer', 'archiver'];

type Bible = { entries: { id: string }[]; demotions?: { id: string; reason: string }[] };

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function gitRun(dir: string, args: string[]): { status: number | null; out: string } {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf-8' });
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}
function readBible(dir: string): Bible {
  return JSON.parse(fs.readFileSync(path.join(dir, BIBLE_REL), 'utf-8'));
}

let root: string;
let repo: string;
let provider: SqliteProvider;
let restoreGitConfig: () => void;

function useProvider(p: SqliteProvider): void {
  vi.spyOn(kbProvidersModule, 'getKbProviders').mockResolvedValue({ project: p, global: p, projectSlug: 'test' } as never);
}

async function confirmed(n: number): Promise<string> {
  const topic = TOPICS[n];
  const { id } = await provider.capture({
    type: 'knowledge', title: `The ${topic} module owns its own retry policy`, summary: `Only the ${topic} decides when to retry ${topic} work.`,
    content: `Detail about the ${topic}.`, source_files: ['src/example.ts'], symbols: [`${topic}Retry`], tags: [],
    content_hash: '', content_hash_type: 'sha256', flagged_for_review: false, author: 'test', source: 'doer',
    confidence: 'INFERRED',
  });
  await provider.promote(id, 'test fixture: basis verified');
  return id;
}

beforeAll(() => {
  if (!fs.existsSync(DIST_INDEX)) throw new Error(`built CLI missing at ${DIST_INDEX}: run npm run build first`);
});

beforeEach(async () => {
  restoreGitConfig = isolateGitConfig();
  _setKbInvalidateCommandOverride([process.execPath, DIST_INDEX]);
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kb-bible-e2e-')));
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
  useProvider(provider);
});

afterEach(() => {
  provider.close();
  vi.restoreAllMocks();
  restoreGitConfig();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function clone(name: string): string {
  const dir = path.join(root, name);
  git(root, ['clone', '--quiet', repo, dir]);
  git(dir, ['config', 'user.name', 'test']);
  git(dir, ['config', 'user.email', 'test@example.invalid']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['checkout', '--quiet', '-b', 'branch-c', 'origin/branch-c']);
  return dir;
}

describe('two bible-changing branches merge safely, validate and import', () => {
  it('plain merge has no conflict; a same-id clash resolves through the driver; the result validates and imports', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push(await confirmed(i));
    const s = [...ids].sort();
    const head = () => git(repo, ['rev-parse', 'HEAD']);

    // Base: five entries and one withdrawn tombstone (s4), so the demotions
    // list already exists and each branch's tombstone lands in its own region.
    await kbBibleCommit({
      ids: [s[1], s[3], s[5], s[7], s[9]], baseBranch: 'main', baseCommit: head(),
      withdrawals: [{ id: s[4], note: NOTE, evidence_files: EVIDENCE }],
    }, { folder: repo });
    const baseCommitA = head();

    // Branch A: entry s2 and a withdrawn tombstone for s0.
    git(repo, ['checkout', '--quiet', '-b', 'branch-a']);
    const a = JSON.parse(await kbBibleCommit({
      ids: [s[2]], baseBranch: 'main', baseCommit: baseCommitA,
      withdrawals: [{ id: s[0], note: NOTE, evidence_files: EVIDENCE }],
    }, { folder: repo }));
    expect(a.committed).toBe(true);

    // The base branch moves on, so branch B is verified against another commit.
    git(repo, ['checkout', '--quiet', 'main']);
    fs.writeFileSync(path.join(repo, 'README.md'), 'unrelated\n');
    git(repo, ['add', 'README.md']);
    git(repo, ['commit', '--quiet', '--no-verify', '-m', 'unrelated base change']);
    const baseCommitB = head();

    // Branch B: entry s6 and a demoted tombstone for s7 (kb_demote, then demoted_ids).
    git(repo, ['checkout', '--quiet', '-b', 'branch-b']);
    await provider.demote(s[7], 'the claim was contradicted by a later change', EVIDENCE);
    const b = JSON.parse(await kbBibleCommit({
      ids: [s[6]], baseBranch: 'main', baseCommit: baseCommitB, demoted_ids: [s[7]],
    }, { folder: repo }));
    expect(b.demoted).toEqual([s[7]]);
    expect(b.committed).toBe(true);

    // (1) Plain text merge: no merge driver configured, no rerere.
    expect(gitRun(repo, ['check-attr', 'merge', '--', BIBLE_REL]).out.trim()).toBe(`${BIBLE_REL}: merge: unspecified`);
    git(repo, ['checkout', '--quiet', 'branch-a']);
    const plain = gitRun(repo, ['-c', 'rerere.enabled=false', 'merge', '--no-edit', '--no-ff', 'branch-b']);
    expect(plain.out).not.toMatch(/CONFLICT/);
    expect(plain.status).toBe(0);
    const merged1Raw = fs.readFileSync(path.join(repo, BIBLE_REL), 'utf-8');
    expect(merged1Raw).not.toMatch(/^(<<<<<<<|=======|>>>>>>>)/m);
    const merged1 = readBible(repo);
    expect(merged1.entries.map(e => e.id)).toEqual([s[1], s[2], s[3], s[5], s[6], s[9]]);
    expect((merged1.demotions ?? []).map(d => [d.id, d.reason])).toEqual([
      [s[0], 'withdrawn'], [s[4], 'withdrawn'], [s[7], 'demoted'],
    ]);
    const mergedCommit = head();

    // (2) Same-id clash: branch C adds entry s8, branch D withdraws s8.
    git(repo, ['checkout', '--quiet', '-b', 'branch-c', mergedCommit]);
    const c = JSON.parse(await kbBibleCommit({ ids: [s[8]], baseBranch: 'main', baseCommit: mergedCommit }, { folder: repo }));
    expect(c.merged).toEqual([s[8]]);
    git(repo, ['checkout', '--quiet', '-b', 'branch-d', mergedCommit]);
    const d = JSON.parse(await kbBibleCommit({
      ids: [], baseBranch: 'main', baseCommit: mergedCommit,
      withdrawals: [{ id: s[8], note: NOTE, evidence_files: EVIDENCE }],
    }, { folder: repo }));
    expect(d.committed).toBe(true);
    git(repo, ['checkout', '--quiet', 'main']);

    // Control: a plain clone merges C and D textually into a file holding s8
    // as both an entry and a tombstone (or a conflict) -- never a valid bible.
    const plainClone = clone('plain-clone');
    const control = gitRun(plainClone, ['-c', 'rerere.enabled=false', 'merge', '--no-edit', 'origin/branch-d']);
    const controlRaw = fs.readFileSync(path.join(plainClone, BIBLE_REL), 'utf-8');
    expect(control.status !== 0 || validateBibleText(controlRaw).some((p: { code: string }) => p.code === 'entry-and-tombstone')).toBe(true);

    // The kb_setup clone resolves it through the merge driver.
    const setupClone = clone('setup-clone');
    const setup = JSON.parse(await kbSetup({}, { folder: setupClone }));
    expect(setup.steps.some((step: string) => step.startsWith('Registered the knowledge bible merge driver'))).toBe(true);
    const driven = gitRun(setupClone, ['-c', 'rerere.enabled=false', 'merge', '--no-edit', 'origin/branch-d']);
    expect(driven.out).not.toMatch(/CONFLICT/);
    expect(driven.status).toBe(0);
    expect(git(setupClone, ['status', '--porcelain'])).toBe('');
    const merged2Raw = fs.readFileSync(path.join(setupClone, BIBLE_REL), 'utf-8');
    expect(merged2Raw).not.toMatch(/^(<<<<<<<|=======|>>>>>>>)/m);
    const merged2 = readBible(setupClone);
    // Documented winner: the tombstone. s8 is withdrawn and not an entry.
    expect(merged2.entries.map(e => e.id)).toEqual([s[1], s[2], s[3], s[5], s[6], s[9]]);
    expect((merged2.demotions ?? []).map(t => [t.id, t.reason])).toEqual([
      [s[0], 'withdrawn'], [s[4], 'withdrawn'], [s[7], 'demoted'], [s[8], 'withdrawn'],
    ]);
    expect(merged2Raw).toBe(serializeBible(merged2));

    // (3) The merged bible passes the validator...
    const check = spawnSync(process.execPath, [CHECK_SCRIPT, path.join(setupClone, BIBLE_REL)], { encoding: 'utf-8' });
    expect(check.stderr).toBe('');
    expect(check.status).toBe(0);

    // ...and imports into a fresh KB: every merged entry, no tombstoned id.
    const fresh = new SqliteProvider(':memory:', setupClone);
    await fresh.init();
    vi.restoreAllMocks();
    useProvider(fresh);
    try {
      const report = JSON.parse(await kbImport({ skip_sweep: true }, { folder: setupClone }));
      expect(report.rejected).toBe(0);
      expect(report.imported).toBe(6);
      const imported = (await fresh.list({ confidence: ['CONFIRMED', 'INFERRED', 'UNVERIFIED'] })).map(e => e.id).sort();
      expect(imported).toEqual([s[1], s[2], s[3], s[5], s[6], s[9]]);
      for (const gone of [s[0], s[4], s[7], s[8]]) expect(imported).not.toContain(gone);
    } finally {
      fresh.close();
    }
  }, 120000);
});
