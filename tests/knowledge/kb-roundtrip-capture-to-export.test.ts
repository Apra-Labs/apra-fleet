import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { kbCapture } from '../../src/tools/kb-capture.js';
import { kbPromote } from '../../src/tools/kb-promote.js';
import { kbBibleCommit } from '../../src/tools/kb-bible-commit.js';
import { kbExport } from '../../src/tools/kb-export.js';
import { kbImport } from '../../src/tools/kb-import.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';

// End to end through the REAL tool handlers, on real git work trees, that every
// path creating or importing a KB entry stores a source_file_hashes basis --
// without one, the bible predicate (kb_export scope=project, kb_bible_commit)
// excludes every CONFIRMED entry. The sequence is the one a sprint runs:
//
//   kb_capture (a reviewer kb_captures entry applied on the kb_maintainer)
//     -> kb_promote -> kb_bible_commit (v3 bible, pushed)
//     -> kb_export on a branch whose bible lacks the entry
//     -> kb_import of the checkout bible on another clone (what kb-prime runs:
//        no path, the session's own folder, skip_sweep) -> kb_export there.
//
// Unchanged cited files: the entry is exported. A COMMITTED change to a cited
// file (admission reads HEAD, so an edit alone would not count): excluded.
// The importing clone stores the CARRIED hashes, never a re-hash of its own
// files, so an entry confirmed against other content gains no local basis.
//
// Layout under one temp root (removed in afterEach): a bare origin, the
// maintainer clone M, and a second clone P; one SqliteProvider per work tree.

const BIBLE_REL = '.fleet/kb-canonical.json';
const CITED = 'src/cited.ts';
const REASON = 'verified for test: re-read src/cited.ts at the branch HEAD';

let root: string;
let origin: string;
let maint: string;
let peer: string;
let c0: string;
const providers = new Map<string, SqliteProvider>();

function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.local', '-c', 'commit.gpgsign=false', ...args],
    { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}
const headOf = (dir: string) => git(dir, ['rev-parse', 'HEAD']).trim();
const blobAtHead = (dir: string, rel: string) => git(dir, ['rev-parse', 'HEAD:' + rel]).trim();

function commitFile(dir: string, rel: string, body: string, msg: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), body);
  git(dir, ['add', '--', rel]);
  git(dir, ['commit', '--quiet', '--no-verify', '-m', msg, '--', rel]);
}

function bibleEntries(dir: string): Array<{ id: string; source_file_hashes?: Record<string, string> }> {
  const p = path.join(dir, BIBLE_REL);
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, 'utf-8')).entries;
}

async function providerFor(dir: string): Promise<SqliteProvider> {
  const p = new SqliteProvider(path.join(root, path.basename(dir) + '.kb.sqlite'), dir);
  await p.init();
  providers.set(path.resolve(dir), p);
  return p;
}
const prov = (dir: string) => providers.get(path.resolve(dir))!;
const basisOf = (dir: string, id: string) => prov(dir).getSourceFileBases([id]).get(id);

/** The maintainer applies a reviewer capture and promotes it, both through the MCP tool handlers. */
async function captureAndPromote(title: string): Promise<string> {
  const cap = JSON.parse(await kbCapture({
    type: 'knowledge', title, summary: 'citedFn in src/cited.ts returns the constant one.',
    content: 'citedFn() returns 1; ' + title, source_files: [CITED], symbols: ['citedFn'], role: 'reviewer',
  }, { folder: maint }));
  const promoted = JSON.parse(await kbPromote({ id: cap.id, reason: REASON }, { folder: maint }));
  expect(promoted.new_confidence).toBe('CONFIRMED');
  return cap.id;
}

/** kb_bible_commit on the maintainer, then push (the engine's publish step). */
async function bibleCommitAndPush(ids: string[]): Promise<{ merged: string[]; skipped: unknown[] }> {
  const res = JSON.parse(await kbBibleCommit({ ids, baseBranch: 'main', baseCommit: headOf(maint) }, { folder: maint }));
  if (res.committed) git(maint, ['push', '--quiet', 'origin', 'main']);
  return res;
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-roundtrip-'));
  origin = path.join(root, 'origin.git');
  maint = path.join(root, 'maint');
  peer = path.join(root, 'peer');
  execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '--quiet', origin, maint], { stdio: ['ignore', 'pipe', 'pipe'] });
  git(maint, ['checkout', '--quiet', '-B', 'main']);
  commitFile(maint, CITED, 'export function citedFn() { return 1; }\n', 'C0: cited file');
  git(maint, ['push', '--quiet', 'origin', 'main']);
  c0 = headOf(maint);

  await providerFor(maint);
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

describe('capture -> promote -> bible commit -> export round trip', () => {
  it('cited file unchanged: every step carries the basis and the CONFIRMED entry is exported, also from an importing clone', async () => {
    const id = await captureAndPromote('Round trip unchanged');
    // kb_capture stored a basis: the cited file's blob at HEAD.
    const basis = basisOf(maint, id);
    expect(basis).toEqual({ [CITED]: blobAtHead(maint, CITED) });

    const res = await bibleCommitAndPush([id]);
    expect(res.merged).toEqual([id]);
    expect(res.skipped).toEqual([]);
    // The v3 bible carries the same basis the maintainer stored.
    expect(bibleEntries(maint).find(e => e.id === id)?.source_file_hashes).toEqual(basis);

    // kb_export on a KB branch whose bible does not hold the entry yet.
    git(maint, ['checkout', '--quiet', '-b', 'kb-branch', c0]);
    expect(bibleEntries(maint)).toEqual([]);
    await kbExport({}, { folder: maint });
    expect(bibleEntries(maint).map(e => e.id)).toEqual([id]);
    expect(bibleEntries(maint)[0].source_file_hashes).toEqual(basis);

    // kb-prime on another clone: kb_import of its own checkout bible.
    execFileSync('git', ['clone', '--quiet', origin, peer], { stdio: ['ignore', 'pipe', 'pipe'] });
    await providerFor(peer);
    const imported = JSON.parse(await kbImport({ skip_sweep: true }, { folder: peer }));
    expect(imported.imported).toBe(1);
    expect(basisOf(peer, id)).toEqual(basis);
    // Re-exported from the importing clone onto a bible-less branch.
    git(peer, ['checkout', '--quiet', '-b', 'kb-branch', c0]);
    await kbExport({}, { folder: peer });
    expect(bibleEntries(peer).map(e => e.id)).toEqual([id]);
    expect(bibleEntries(peer)[0].source_file_hashes).toEqual(basis);
  });

  it('a committed change to the cited file excludes the entry from kb_bible_commit and kb_export', async () => {
    const id = await captureAndPromote('Round trip changed');
    const basis = basisOf(maint, id);
    expect(basis).toEqual({ [CITED]: blobAtHead(maint, CITED) });

    // An uncommitted edit does not count; a commit does.
    commitFile(maint, CITED, 'export function citedFn() { return 2; }\n', 'change cited file');
    const res = await bibleCommitAndPush([id]);
    expect(res.merged).toEqual([]);
    expect(res.skipped).toEqual([{ id, reason: 'basis_mismatch' }]);
    await kbExport({}, { folder: maint });
    expect(bibleEntries(maint).map(e => e.id)).not.toContain(id);
    // The stored basis is not refreshed behind the evidence's back.
    expect(basisOf(maint, id)).toEqual(basis);
  });

  it('an entry imported from a bible confirmed on another branch keeps the carried basis, not a local re-hash, and is not re-exported', async () => {
    // The peer clone diverges on the cited file BEFORE the maintainer's bible lands.
    execFileSync('git', ['clone', '--quiet', origin, peer], { stdio: ['ignore', 'pipe', 'pipe'] });
    commitFile(peer, CITED, 'export function citedFn() { return 3; }\n', 'peer: cited file diverges');
    await providerFor(peer);

    const id = await captureAndPromote('Confirmed on another branch');
    const carried = basisOf(maint, id)!;
    expect((await bibleCommitAndPush([id])).merged).toEqual([id]);

    // Bring the maintainer's bible file onto the peer branch, then kb-prime it.
    git(peer, ['fetch', '--quiet', 'origin']);
    git(peer, ['checkout', 'origin/main', '--', BIBLE_REL]);
    git(peer, ['commit', '--quiet', '--no-verify', '-m', 'take bible', '--', BIBLE_REL]);
    const peerBlob = blobAtHead(peer, CITED);
    expect(peerBlob).not.toBe(carried[CITED]);

    const imported = JSON.parse(await kbImport({ skip_sweep: true }, { folder: peer }));
    expect(imported.imported).toBe(1);
    const stored = basisOf(peer, id);
    expect(stored).toEqual(carried);
    expect(stored![CITED]).not.toBe(peerBlob);

    // The peer cannot publish it: its HEAD content is not what was verified.
    const peerCommit = JSON.parse(await kbBibleCommit({ ids: [id], baseBranch: 'main', baseCommit: headOf(peer) }, { folder: peer }));
    expect(peerCommit.merged).toEqual([]);
    expect(peerCommit.skipped).toEqual([{ id, reason: 'basis_mismatch' }]);
    git(peer, ['checkout', '--quiet', '-b', 'kb-branch', c0]);
    commitFile(peer, CITED, 'export function citedFn() { return 3; }\n', 'peer branch: diverged cited file');
    await kbExport({}, { folder: peer });
    expect(bibleEntries(peer).map(e => e.id)).not.toContain(id);
  });
});
