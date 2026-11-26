import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { kbBibleCommit } from '../../src/tools/kb-bible-commit.js';
import { kbExport } from '../../src/tools/kb-export.js';
import { kbImport } from '../../src/tools/kb-import.js';
import { kbPromote } from '../../src/tools/kb-promote.js';
import { isToolInScope, memberToolScope } from '../../src/services/tool-scope.js';
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

function readBible(dir: string): { provenance: { branch: string; commit?: string; entry_count?: number }; entries: { id: string; title: string }[] } {
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
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
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
    // Branch only in the file: a per-file commit or entry count is a line two
    // bible-changing branches rewrite differently, so they would conflict.
    expect(bible.provenance).toEqual({ branch: 'release/9' });
    expect(bible.entries).toHaveLength(3);
    // The base commit is carried by the commit that wrote the file.
    expect(git(clone, ['log', '-1', '--format=%(trailers:key=Verified-Against,valueonly)']).trim()).toBe('abc123def');
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
    // The base is the bible committed at HEAD, so the unreadable one is committed.
    fs.mkdirSync(path.join(clone, '.fleet'), { recursive: true });
    fs.writeFileSync(path.join(clone, BIBLE_REL), '{ not json');
    git(clone, ['add', BIBLE_REL]);
    git(clone, ['commit', '-q', '-m', 'unreadable bible']);
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
    expect(bible.provenance).toEqual({ branch: 'main' });
    expect(git(clone, ['log', '-1', '--format=%(trailers:key=Verified-Against,valueonly)']).trim()).toBe(base);
    // The commit landed on the checked-out feature branch, locally only.
    expect(git(clone, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('feature/sprint-work');
    expect(originHead()).toBe(base);
  });

  it('kb_export with an explicit target branch writes that branch into provenance', async () => {
    const base = git(clone, ['rev-parse', 'HEAD']).trim();
    git(clone, ['checkout', '--quiet', '-b', 'feature/export-work']);
    await confirmed(provider, 'Alpha');
    const out = JSON.parse(await kbExport({ baseBranch: 'main', baseCommit: base }, { folder: clone }));
    const bible = readBible(clone);
    expect(bible.provenance).toEqual({ branch: 'main' });
    if (out.committed) {
      expect(git(clone, ['log', '-1', '--format=%(trailers:key=Verified-Against,valueonly)']).trim()).toBe(base);
    }
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
    // Admission reads cited files at HEAD, so the fixture files are committed.
    git(clone, ['add', 'src']);
    git(clone, ['commit', '--quiet', '-m', 'add b and c']);
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
    git(clone, ['commit', '--quiet', '-am', 'change c']);

    const result = JSON.parse(await kbExport({}, { folder: clone }));
    const ids = readBible(clone).entries.map(e => e.id);
    // `committed` is present because kb_bible_commit wrote it and the export is
    // additive -- the basis predicate never admitted it. kb_bible_commit applies
    // the same shared basis predicate on its own admission path.
    expect(ids).toContain(committed);
    expect(ids).toContain(unchanged);
    expect(ids).not.toContain(changed);
    expect(result.exported).toBe(ids.length);
  });

  // Bible format v3 decision: kb_import never takes a VERIFIED basis from this
  // checkout's files. The seeded bible here is v2 (no source_file_hashes), so
  // its entries get only a local freshness-only basis, which the bible
  // predicate reads as none, so it excludes them from
  // re-export until they are recaptured.
  it('kb_import of a v2 bible stores no verified basis for its entries (a local re-hash is freshness-only)', async () => {
    const report = JSON.parse(await kbImport({ skip_sweep: true }, { folder: clone }));
    expect(report.imported).toBe(2);
    const bases = provider.getSourceFileBases(['kb-existing-1', 'kb-existing-2']);
    for (const id of ['kb-existing-1', 'kb-existing-2']) {
      expect(bases.get(id)).toBeNull();
    }
  });
});

// kb_promote stamps the source-file basis from the cited files at HEAD, and a
// promote of an already-CONFIRMED entry with a drifted basis re-stamps it
// (rebased), so a reviewer re-verification turns a basis_mismatch skip into a
// merge. A basis_mismatch skip names the files behind it (changed_files).
describe('kb_promote basis stamp at HEAD and kb_bible_commit changed_files', () => {
  const REASON = 'test fixture: re-read src/a.ts at HEAD and the claim holds';

  function headBlob(rel: string): string {
    return git(clone, ['rev-parse', 'HEAD:' + rel]).trim();
  }

  function commitFile(rel: string, body: string, msg: string): string {
    fs.writeFileSync(path.join(clone, rel), body);
    git(clone, ['add', rel]);
    git(clone, ['commit', '--quiet', '-m', msg]);
    return git(clone, ['rev-parse', 'HEAD']).trim();
  }

  it('promoting an entry whose cited file changed since capture stores the HEAD hash; kb_bible_commit then merges it', async () => {
    const { id } = await provider.capture(makeInput({ title: 'Stamped at promote', symbols: ['stampSym'] }));
    const captureBasis = provider.getSourceFileBases([id]).get(id);
    const head = commitFile('src/a.ts', 'export const a = 2;\n', 'change a after capture');
    expect(captureBasis?.['src/a.ts']).not.toBe(headBlob('src/a.ts'));

    const res = await provider.promote(id, REASON);
    expect(res.confidence_after).toBe('CONFIRMED');
    expect(res.basis_stamped).toBe(true);
    expect(res.previous_basis_files_changed).toEqual(['src/a.ts']);
    expect(provider.getSourceFileBases([id]).get(id)).toEqual({ 'src/a.ts': headBlob('src/a.ts') });

    const round = JSON.parse(await kbBibleCommit({ ids: [id], baseBranch: 'main', baseCommit: head }, { folder: clone }));
    expect(round.skipped).toEqual([]);
    expect(round.merged).toEqual([id]);
  });

  it('a drifted CONFIRMED entry is skipped with changed_files, re-verified via kb_promote (rebased), then merged', async () => {
    fs.writeFileSync(path.join(clone, 'src', 'b.ts'), 'export const b = 1;\n');
    commitFile('src/b.ts', 'export const b = 1;\n', 'add b');
    const id = await confirmed(provider, 'Drifter');
    const gone = (await provider.capture(makeInput({
      title: 'Cites a file deleted later', summary: 'Deleted file entry', symbols: ['goneSym'], source_files: ['src/b.ts'],
    }))).id;
    await provider.promote(gone, REASON);

    const head1 = commitFile('src/a.ts', 'export const a = 3;\n', 'change a after promote');
    git(clone, ['rm', '--quiet', 'src/b.ts']);
    git(clone, ['commit', '--quiet', '-m', 'delete b']);
    const head2 = git(clone, ['rev-parse', 'HEAD']).trim();
    expect(head2).not.toBe(head1);

    const first = JSON.parse(await kbBibleCommit({ ids: [id, gone], baseBranch: 'main', baseCommit: head2 }, { folder: clone }));
    expect(first.merged).toEqual([]);
    expect(first.skipped).toEqual(expect.arrayContaining([
      { id, reason: 'basis_mismatch', changed_files: [{ path: 'src/a.ts', reason: 'changed' }] },
      { id: gone, reason: 'basis_mismatch', changed_files: [{ path: 'src/b.ts', reason: 'absent' }] },
    ]));

    const re = JSON.parse(await kbPromote({ id, reason: REASON }, { folder: clone }));
    expect(re).toMatchObject({
      id, previous_confidence: 'CONFIRMED', new_confidence: 'CONFIRMED',
      basis_stamped: true, rebased: true, previous_basis_files_changed: ['src/a.ts'],
    });
    expect(provider.getSourceFileBases([id]).get(id)).toEqual({ 'src/a.ts': headBlob('src/a.ts') });
    const row = (await provider.query({ ids: [id] })).results[0];
    expect(row.content).toContain('[Re-verified at HEAD, basis re-stamped: ' + REASON);

    // A second re-verification against the same HEAD has nothing to re-stamp.
    const again = JSON.parse(await kbPromote({ id, reason: REASON }, { folder: clone }));
    expect(again).toMatchObject({ basis_stamped: false, rebased: false, previous_basis_files_changed: [] });

    // A file absent at HEAD cannot be re-stamped: it is reported and keeps its basis.
    fs.writeFileSync(path.join(clone, 'src', 'b.ts'), 'export const b = 1;\n'); // untracked again
    const goneBasis = provider.getSourceFileBases([gone]).get(gone);
    const goneRe = await provider.promote(gone, REASON);
    expect(goneRe).toMatchObject({ basis_stamped: false, rebased: false, unstamped_files: [{ path: 'src/b.ts', reason: 'absent_at_head' }] });
    expect(provider.getSourceFileBases([gone]).get(gone)).toEqual(goneBasis);
    fs.rmSync(path.join(clone, 'src', 'b.ts'));

    const second = JSON.parse(await kbBibleCommit({ ids: [id], baseBranch: 'main', baseCommit: head2 }, { folder: clone }));
    expect(second.skipped).toEqual([]);
    expect(second.merged).toEqual([id]);
  });

  it('a stale drifted CONFIRMED entry is revived by the re-stamp so the next kb_bible_commit merges it', async () => {
    const id = await confirmed(provider, 'StaleDrifter');
    const head = commitFile('src/a.ts', 'export const a = 4;\n', 'change a');
    await provider.freshnessSweep();
    expect((await provider.query({ ids: [id], include_stale: true })).results[0]?.stale).toBe(true);

    const re = await provider.promote(id, REASON);
    expect(re.rebased).toBe(true);
    const round = JSON.parse(await kbBibleCommit({ ids: [id], baseBranch: 'main', baseCommit: head }, { folder: clone }));
    expect(round.merged).toEqual([id]);
  });

  it('a re-stamp attempt without the kb_maintainer grant is refused and the basis is unchanged', async () => {
    const id = await confirmed(provider, 'Guarded');
    commitFile('src/a.ts', 'export const a = 5;\n', 'change a');
    const basisBefore = provider.getSourceFileBases([id]).get(id);
    const contentBefore = (await provider.query({ ids: [id] })).results[0].content;

    // A member session is served kb_promote only with the kb_maintainer grant.
    expect(isToolInScope('kb_promote', memberToolScope('m-1', false, true, false))).toBe(false);
    expect(isToolInScope('kb_promote', memberToolScope('m-1', false, true, true))).toBe(true);
    // And a member's own-scope promote of an entry it did not capture is the
    // same not-found as an unknown id, with nothing written.
    await expect(provider.promote(id, REASON, { ownerTag: 'member:someone-else' })).rejects.toThrow(/Entry not found/);

    expect(provider.getSourceFileBases([id]).get(id)).toEqual(basisBefore);
    expect(basisBefore?.['src/a.ts']).not.toBe(headBlob('src/a.ts'));
    expect((await provider.query({ ids: [id] })).results[0].content).toBe(contentBefore);
  });

  it('an uncommitted edit to the cited file does not affect the stamped basis', async () => {
    // Two cited files: b.ts is clean at HEAD (stamped), a.ts carries an
    // uncommitted edit (never stamped: its work-tree content stays out).
    commitFile('src/b.ts', 'export const b = 1;\n', 'add b');
    const { id } = await provider.capture(makeInput({ title: 'Dirty tree', symbols: ['dirtySym'], source_files: ['src/a.ts', 'src/b.ts'] }));
    const head = commitFile('src/b.ts', 'export const b = 2;\n', 'change b after capture');
    const aCommitted = headBlob('src/a.ts');
    fs.writeFileSync(path.join(clone, 'src', 'a.ts'), 'export const a = 999; // uncommitted\n');
    const aDisk = git(clone, ['hash-object', 'src/a.ts']).trim();
    expect(aDisk).not.toBe(aCommitted);

    const res = await provider.promote(id, REASON);
    expect(res.basis_stamped).toBe(true);
    expect(res.previous_basis_files_changed).toEqual(['src/b.ts']);
    expect(res.unstamped_files).toEqual([{ path: 'src/a.ts', reason: 'uncommitted_edit' }]);
    const basis = provider.getSourceFileBases([id]).get(id)!;
    expect(basis).toEqual({ 'src/a.ts': aCommitted, 'src/b.ts': headBlob('src/b.ts') });
    expect(basis['src/a.ts']).not.toBe(aDisk);

    // The stamped basis matches HEAD, so the bible admits it despite the dirty file.
    const round = JSON.parse(await kbBibleCommit({ ids: [id], baseBranch: 'main', baseCommit: head }, { folder: clone }));
    expect(round.merged).toEqual([id]);

    // A cited file that exists only on disk (never committed) is reported, not stamped.
    fs.writeFileSync(path.join(clone, 'src', 'new.ts'), 'export const n = 1;\n');
    const fresh = (await provider.capture(makeInput({
      title: 'Uncommitted file', summary: 'Cites a new file', symbols: ['newSym'], source_files: ['src/new.ts'],
    }))).id;
    const freshRes = await provider.promote(fresh, REASON);
    expect(freshRes).toMatchObject({ confidence_after: 'CONFIRMED', basis_stamped: false, unstamped_files: [{ path: 'src/new.ts', reason: 'absent_at_head' }] });
  });
});
