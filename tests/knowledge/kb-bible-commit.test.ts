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
import type { KBEntryInput } from '../../src/services/knowledge/types.js';

// kb_bible_commit (and kb_export provenance) against a REAL temp git setup: a
// bare origin plus a clone. The tool runs in the clone; the bare origin's refs
// prove nothing is pushed. Every temp repo lives under one root removed in
// afterEach.

const BIBLE_REL = '.fleet/kb-canonical.json';

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function gitIdentity(dir: string): void {
  git(dir, ['config', 'user.name', 'test']);
  git(dir, ['config', 'user.email', 'test@example.invalid']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
}

let root: string;
let origin: string;
let clone: string;
let provider: SqliteProvider;

function makeInput(overrides: Partial<KBEntryInput> = {}): KBEntryInput {
  return {
    type: 'knowledge',
    title: 'Default title',
    summary: 'Default summary',
    content: 'Default content body.',
    source_files: ['src/a.ts'],
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

async function confirmed(p: SqliteProvider, title: string): Promise<string> {
  const { id } = await p.capture(makeInput({ title, summary: 'Summary of ' + title, symbols: ['sym' + title] }));
  await p.promote(id, 'test fixture: verified');
  await p.promote(id, 'test fixture: verified');
  return id;
}

function readBible(dir: string): { provenance: { branch: string; commit: string; entry_count: number }; entries: { id: string; title: string }[] } {
  return JSON.parse(fs.readFileSync(path.join(dir, BIBLE_REL), 'utf-8'));
}

function seedBible(dir: string, entries: { id: string; title: string }[]): void {
  fs.mkdirSync(path.join(dir, '.fleet'), { recursive: true });
  const full = entries.map(e => ({
    id: e.id, type: 'knowledge', title: e.title, summary: 's', symbols: [], source_files: ['src/a.ts'],
    confidence: 'CONFIRMED', updated_at: '2026-01-01T00:00:00.000Z',
  }));
  fs.writeFileSync(path.join(dir, BIBLE_REL), JSON.stringify({
    version: 2, provenance: { commit: null, branch: null, entry_count: full.length }, entries: full,
  }, null, 2) + '\n');
}

function originHead(): string {
  return git(origin, ['rev-parse', 'refs/heads/main']).trim();
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-bible-commit-'));
  origin = path.join(root, 'origin.git');
  clone = path.join(root, 'clone');
  execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '--quiet', origin, clone], { stdio: ['ignore', 'pipe', 'pipe'] });
  gitIdentity(clone);
  git(clone, ['checkout', '--quiet', '-B', 'main']);
  fs.mkdirSync(path.join(clone, 'src'), { recursive: true });
  fs.writeFileSync(path.join(clone, 'src', 'a.ts'), 'export const a = 1;\n');
  seedBible(clone, [{ id: 'kb-existing-1', title: 'Existing one' }, { id: 'kb-existing-2', title: 'Existing two' }]);
  git(clone, ['add', '-A']);
  git(clone, ['commit', '--quiet', '-m', 'seed']);
  git(clone, ['push', '--quiet', 'origin', 'main']);

  provider = new SqliteProvider(path.join(root, 'kb.sqlite'), clone);
  await provider.init();
  vi.spyOn(kbProvidersModule, 'getKbProviders').mockResolvedValue({
    project: provider, global: provider, projectSlug: 'test',
  } as any);
});

afterEach(() => {
  provider.close();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('kb_bible_commit', () => {
  it('merges exactly the given ids into the existing bible, commits locally, and does not push', async () => {
    const a = await confirmed(provider, 'Alpha');
    const b = await confirmed(provider, 'Beta');
    const notGiven = await confirmed(provider, 'Gamma');
    const before = originHead();
    const headBefore = git(clone, ['rev-parse', 'HEAD']).trim();

    const result = JSON.parse(await kbBibleCommit(
      { ids: [a, b], baseBranch: 'main', baseCommit: headBefore }, { folder: clone },
    ));
    expect(result.committed).toBe(true);
    expect(result.merged.sort()).toEqual([a, b].sort());
    expect(result.skipped).toEqual([]);

    const ids = readBible(clone).entries.map(e => e.id);
    expect(ids).toEqual(['kb-existing-1', 'kb-existing-2', a, b].sort());
    expect(ids).not.toContain(notGiven);

    // Exactly one new local commit, touching only the bible, with pm-kb identity.
    expect(git(clone, ['rev-list', '--count', headBefore + '..HEAD']).trim()).toBe('1');
    expect(git(clone, ['show', '--name-only', '--format=', 'HEAD']).trim()).toBe(BIBLE_REL);
    expect(git(clone, ['log', '-1', '--format=%an|%ae']).trim()).toBe('pm-kb|kb@pm.local');
    // Nothing pushed: origin's ref is unchanged.
    expect(originHead()).toBe(before);
  });

  it('writes provenance from the inputs', async () => {
    const a = await confirmed(provider, 'Alpha');
    await kbBibleCommit({ ids: [a], baseBranch: 'release/9', baseCommit: 'abc123def' }, { folder: clone });
    const bible = readBible(clone);
    expect(bible.provenance.branch).toBe('release/9');
    expect(bible.provenance.commit).toBe('abc123def');
    expect(bible.provenance.entry_count).toBe(3);
  });

  it('an empty id list makes no commit and writes nothing', async () => {
    const headBefore = git(clone, ['rev-parse', 'HEAD']).trim();
    const result = JSON.parse(await kbBibleCommit({ ids: [], baseBranch: 'main', baseCommit: headBefore }, { folder: clone }));
    expect(result.committed).toBe(false);
    expect(git(clone, ['rev-parse', 'HEAD']).trim()).toBe(headBefore);
    expect(git(clone, ['status', '--porcelain']).trim()).toBe('');
  });

  it('skips unknown and non-CONFIRMED ids without committing when nothing is mergeable', async () => {
    const { id: inferred } = await provider.capture(makeInput({ title: 'Inferred only' }));
    const headBefore = git(clone, ['rev-parse', 'HEAD']).trim();
    const result = JSON.parse(await kbBibleCommit(
      { ids: ['kb-does-not-exist', inferred], baseBranch: 'main', baseCommit: headBefore }, { folder: clone },
    ));
    expect(result.committed).toBe(false);
    expect(result.merged).toEqual([]);
    expect(result.skipped.map((s: { id: string }) => s.id).sort()).toEqual(['kb-does-not-exist', inferred].sort());
    expect(git(clone, ['rev-parse', 'HEAD']).trim()).toBe(headBefore);
  });

  it('re-running with the same ids is a no-op (no second commit)', async () => {
    const a = await confirmed(provider, 'Alpha');
    await kbBibleCommit({ ids: [a], baseBranch: 'main', baseCommit: 'c1' }, { folder: clone });
    const head = git(clone, ['rev-parse', 'HEAD']).trim();
    const again = JSON.parse(await kbBibleCommit({ ids: [a], baseBranch: 'main', baseCommit: 'c2' }, { folder: clone }));
    expect(again.committed).toBe(false);
    expect(git(clone, ['rev-parse', 'HEAD']).trim()).toBe(head);
  });

  it('refuses to overwrite an unreadable bible', async () => {
    const a = await confirmed(provider, 'Alpha');
    fs.writeFileSync(path.join(clone, BIBLE_REL), '{ not json');
    await expect(kbBibleCommit({ ids: [a], baseBranch: 'main', baseCommit: 'c' }, { folder: clone }))
      .rejects.toThrow(/refusing to overwrite/);
    expect(fs.readFileSync(path.join(clone, BIBLE_REL), 'utf-8')).toBe('{ not json');
  });
});

describe('kb_bible_commit: concurrent change, retried after a rejected rebase', () => {
  it('after rebase --abort, dropping the local bible commit, pulling and re-running with the same ids, the bible holds both clones\' entries', async () => {
    // Clone 1 commits its round locally (not pushed yet).
    const mine = await confirmed(provider, 'Mine');
    const first = JSON.parse(await kbBibleCommit(
      { ids: [mine], baseBranch: 'main', baseCommit: 'base-commit-clone-1' }, { folder: clone },
    ));
    expect(first.committed).toBe(true);

    // Clone 2, with its own KB, commits and pushes a different entry first.
    const clone2 = path.join(root, 'clone2');
    execFileSync('git', ['clone', '--quiet', origin, clone2], { stdio: ['ignore', 'pipe', 'pipe'] });
    gitIdentity(clone2);
    const provider2 = new SqliteProvider(path.join(root, 'kb2.sqlite'), clone2);
    await provider2.init();
    try {
      const theirs = await confirmed(provider2, 'Theirs');
      vi.mocked(kbProvidersModule.getKbProviders).mockResolvedValueOnce({
        project: provider2, global: provider2, projectSlug: 'test',
      } as any);
      const second = JSON.parse(await kbBibleCommit(
        { ids: [theirs], baseBranch: 'main', baseCommit: 'base-commit-clone-2' }, { folder: clone2 },
      ));
      expect(second.committed).toBe(true);
      git(clone2, ['push', '--quiet', 'origin', 'main']);

      // Clone 1 cannot simply rebase its bible commit onto the new remote HEAD.
      expect(() => git(clone, ['pull', '--rebase', '--quiet', 'origin', 'main'])).toThrow();
      git(clone, ['rebase', '--abort']);

      // Retry: drop the local bible commit, take the remote, re-run with the SAME ids.
      git(clone, ['reset', '--hard', '--quiet', 'HEAD~1']);
      git(clone, ['pull', '--ff-only', '--quiet', 'origin', 'main']);
      const retry = JSON.parse(await kbBibleCommit(
        { ids: [mine], baseBranch: 'main', baseCommit: 'base-commit-clone-1' }, { folder: clone },
      ));
      expect(retry.committed).toBe(true);

      const ids = readBible(clone).entries.map(e => e.id);
      expect(ids).toEqual(['kb-existing-1', 'kb-existing-2', mine, theirs].sort());
      // No manual merge needed: the retried commit fast-forwards origin.
      git(clone, ['push', '--quiet', 'origin', 'main']);
      expect(originHead()).toBe(git(clone, ['rev-parse', 'HEAD']).trim());
    } finally {
      provider2.close();
    }
  });
});

describe('bible provenance names the target base branch, not HEAD', () => {
  it('kb_bible_commit writes the given baseBranch/baseCommit even when HEAD is on a different branch', async () => {
    const base = git(clone, ['rev-parse', 'HEAD']).trim();
    git(clone, ['checkout', '--quiet', '-b', 'feature/sprint-work']);
    const a = await confirmed(provider, 'Alpha');
    const result = JSON.parse(await kbBibleCommit({ ids: [a], baseBranch: 'main', baseCommit: base }, { folder: clone }));
    expect(result.committed).toBe(true);
    const bible = readBible(clone);
    expect(bible.provenance.branch).toBe('main');
    expect(bible.provenance.commit).toBe(base);
    // The commit landed on the checked-out feature branch, locally only.
    expect(git(clone, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('feature/sprint-work');
    expect(originHead()).toBe(base);
  });

  it('kb_export with an explicit target branch writes that branch into provenance', async () => {
    const base = git(clone, ['rev-parse', 'HEAD']).trim();
    git(clone, ['checkout', '--quiet', '-b', 'feature/export-work']);
    await confirmed(provider, 'Alpha');
    await kbExport({ baseBranch: 'main', baseCommit: base }, { folder: clone });
    const bible = readBible(clone);
    expect(bible.provenance.branch).toBe('main');
    expect(bible.provenance.commit).toBe(base);
  });
});

// The project kb_export basis filter reads the per-file hash basis
// (source_file_hashes) that capture writes. Every KB-branch path that mints or
// imports an entry goes through SqliteProvider.capture, so the basis must be
// populated end to end: a capture -> promote -> bible commit -> export round
// trip exports a CONFIRMED entry whose cited files are unchanged and leaves
// out one whose cited file changed after capture.
describe('capture -> promote -> bible commit -> export round trip (basis filter)', () => {
  async function confirmedCiting(title: string, file: string): Promise<string> {
    const { id } = await provider.capture(makeInput({
      title, summary: 'Summary of ' + title, symbols: ['sym' + title], source_files: [file],
    }));
    await provider.promote(id, 'test fixture: verified');
    await provider.promote(id, 'test fixture: verified');
    return id;
  }

  it('exports the unchanged entry, excludes the changed one, keeps the committed round', async () => {
    fs.writeFileSync(path.join(clone, 'src', 'b.ts'), 'export const b = 1;\n');
    fs.writeFileSync(path.join(clone, 'src', 'c.ts'), 'export const c = 1;\n');
    const head = git(clone, ['rev-parse', 'HEAD']).trim();

    // Round 1: the maintainer's bible commit of one confirmed entry.
    const committed = await confirmedCiting('Committed', 'src/a.ts');
    const round = JSON.parse(await kbBibleCommit({ ids: [committed], baseBranch: 'main', baseCommit: head }, { folder: clone }));
    expect(round.committed).toBe(true);

    // Two more confirmed entries; one cited file changes after capture.
    const unchanged = await confirmedCiting('Unchanged', 'src/b.ts');
    const changed = await confirmedCiting('Changed', 'src/c.ts');
    const bases = provider.getSourceFileBases([committed, unchanged, changed]);
    for (const id of [committed, unchanged, changed]) {
      expect(bases.get(id)).not.toBeNull();
    }
    fs.writeFileSync(path.join(clone, 'src', 'c.ts'), 'export const c = 2;\n');

    const result = JSON.parse(await kbExport({}, { folder: clone }));
    const ids = readBible(clone).entries.map(e => e.id);
    expect(ids).toContain(committed);
    expect(ids).toContain(unchanged);
    expect(ids).not.toContain(changed);
    expect(result.exported).toBe(ids.length);
  });

  it('kb_import of a bible populates the basis of each imported entry', async () => {
    const report = JSON.parse(await kbImport({ skip_sweep: true }, { folder: clone }));
    expect(report.imported).toBe(2);
    const bases = provider.getSourceFileBases(['kb-existing-1', 'kb-existing-2']);
    for (const id of ['kb-existing-1', 'kb-existing-2']) {
      const basis = bases.get(id);
      expect(basis).not.toBeNull();
      expect(Object.keys(basis as Record<string, string>)).toEqual(['src/a.ts']);
    }
  });
});
