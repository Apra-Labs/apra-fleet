import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import {
  BibleBlobIntegrityError, OWN_BIBLE_REL, bibleBytesBlobId, blobBytesMatchId, gitBlobId, isSafeBibleRef, readCommittedBibleBlob,
} from '../../src/services/knowledge/bible-blob-id.js';

// The kb_import trust anchor binds a trusted git blob id to the bytes that
// are imported. These tests pin the in-process git object hash (sha1 and
// sha256 object formats) and the refusal of bytes that do not hash to the id
// they were read by, however the member's object store was arranged.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, args: string[], input?: Buffer): string {
  return execFileSync('git', args, { cwd, input, encoding: 'utf-8', stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] }).trim();
}

/** A repo (object format `fmt`) with the bible committed; null when this git cannot create it. */
function repoWithBible(fmt: 'sha1' | 'sha256', body: string): string | null {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bible-blob-id-${fmt}-`));
  dirs.push(dir);
  try {
    git(dir, ['init', '--quiet', `--object-format=${fmt}`]);
  } catch {
    return null;
  }
  git(dir, ['config', 'core.autocrlf', 'false']);
  fs.mkdirSync(path.join(dir, '.fleet'));
  fs.writeFileSync(path.join(dir, OWN_BIBLE_REL), body);
  git(dir, ['add', '--', OWN_BIBLE_REL]);
  git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '-m', 'bible']);
  return dir;
}

const BODY = JSON.stringify([{ id: 'genuine-0001', confidence: 'CONFIRMED' }]) + '\n';
const FORGED = Buffer.from(JSON.stringify([{ id: 'forged-0001', confidence: 'CONFIRMED' }]) + '\n', 'utf-8');

function overwriteLoose(dir: string, id: string, bytes: Buffer): void {
  const obj = path.join(dir, '.git', 'objects', id.slice(0, 2), id.slice(2));
  fs.chmodSync(obj, 0o644);
  fs.writeFileSync(obj, zlib.deflateSync(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`, 'utf-8'), bytes])));
}

describe('gitBlobId / blobBytesMatchId', () => {
  it('equals git hash-object for sha1 (and the empty blob constant)', () => {
    expect(gitBlobId(Buffer.alloc(0), 'sha1')).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bible-blob-id-hash-'));
    dirs.push(dir);
    const bytes = Buffer.from(BODY, 'utf-8');
    expect(gitBlobId(bytes, 'sha1')).toBe(git(dir, ['hash-object', '--no-filters', '--stdin'], bytes));
  });

  it('matches by id length (40 sha1, 64 sha256) and refuses any mismatch', () => {
    const bytes = Buffer.from(BODY, 'utf-8');
    const s1 = gitBlobId(bytes, 'sha1');
    const s256 = gitBlobId(bytes, 'sha256');
    expect(s1).toHaveLength(40);
    expect(s256).toHaveLength(64);
    expect(blobBytesMatchId(s1, bytes)).toBe(true);
    expect(blobBytesMatchId(s256, bytes)).toBe(true);
    expect(blobBytesMatchId(s1, FORGED)).toBe(false);
    expect(blobBytesMatchId(s256, FORGED)).toBe(false);
    expect(blobBytesMatchId('not-an-id', bytes)).toBe(false);
  });
});

describe('isSafeBibleRef', () => {
  it('accepts plain ref names, refuses options and rev expressions', () => {
    for (const ok of ['HEAD', 'main', 'refs/remotes/origin/main', 'refs/remotes/origin/feat/x-1.2']) expect(isSafeBibleRef(ok), ok).toBe(true);
    for (const bad of ['-c', '--output=x', 'HEAD~1', 'HEAD^', 'HEAD:x', 'a..b', 'main@{1}', 'a b', '', 'x/', 'x.lock']) expect(isSafeBibleRef(bad), bad).toBe(false);
  });
});

describe.each(['sha1', 'sha256'] as const)('readCommittedBibleBlob (%s object format)', (fmt) => {
  it('reads the committed bible with its verified blob id; bibleBytesBlobId agrees', async (ctx) => {
    const dir = repoWithBible(fmt, BODY);
    if (dir === null) { ctx.skip(); return; }
    const head = git(dir, ['rev-parse', 'HEAD:./' + OWN_BIBLE_REL]);
    expect(head).toHaveLength(fmt === 'sha1' ? 40 : 64);
    const r = await readCommittedBibleBlob(dir);
    expect(r).toEqual({ blobId: head, text: BODY });
    expect(await bibleBytesBlobId(dir, Buffer.from(BODY, 'utf-8'))).toBe(head);
  });

  it('a replace ref does not substitute the bytes (--no-replace-objects)', async (ctx) => {
    const dir = repoWithBible(fmt, BODY);
    if (dir === null) { ctx.skip(); return; }
    const head = git(dir, ['rev-parse', 'HEAD:./' + OWN_BIBLE_REL]);
    const forged = git(dir, ['hash-object', '-w', '--stdin'], FORGED);
    git(dir, ['replace', head, forged]);
    expect(git(dir, ['cat-file', 'blob', head])).toContain('forged-0001');
    expect(await readCommittedBibleBlob(dir)).toEqual({ blobId: head, text: BODY });
  });

  it('an overwritten loose object is refused with BibleBlobIntegrityError', async (ctx) => {
    const dir = repoWithBible(fmt, BODY);
    if (dir === null) { ctx.skip(); return; }
    const head = git(dir, ['rev-parse', 'HEAD:./' + OWN_BIBLE_REL]);
    overwriteLoose(dir, head, FORGED);
    await expect(readCommittedBibleBlob(dir)).rejects.toBeInstanceOf(BibleBlobIntegrityError);
  });

  it('an unresolvable ref or an unsafe ref reads nothing', async (ctx) => {
    const dir = repoWithBible(fmt, BODY);
    if (dir === null) { ctx.skip(); return; }
    expect(await readCommittedBibleBlob(dir, 'refs/remotes/origin/none')).toBeNull();
    expect(await readCommittedBibleBlob(dir, '--all')).toBeNull();
  });
});
