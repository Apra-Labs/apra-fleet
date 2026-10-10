// Git blob ids of the own bible (.fleet/kb-canonical.json), for the kb_import
// trust anchor.
//
// A member session without the kb_maintainer grant imports only the committed
// bible at HEAD. The member controls its own .git, so "committed" alone proves
// nothing: it can commit a hand-made bible locally, import it, and reset the
// commit away. The trust decision is therefore taken against a record OUTSIDE
// the checkout: the per-repo KB database on the hub, where the maintainer side
// (kb_bible_commit and FULL / kb_maintainer kb_import) records the blob id of
// every bible it writes or imports (SqliteProvider.recordTrustedBibleBlob). A
// blob id is the git object id of the bible bytes ("blob <len>\0<bytes>",
// hashed with the repository's object format), so the id recorded for bytes
// the maintainer wrote equals the HEAD:path blob id of the same bytes in any
// clone that checks them out.
//
// ID-TO-BYTES BINDING: the object store is member-writable too. A replace ref
// (git replace <trusted> <forged>), an overwritten loose object, an alternates
// entry or a crafted pack can all make `git cat-file blob <trusted id>` return
// bytes that are NOT the trusted blob. So the bytes read for an id are hashed
// IN-PROCESS and refused unless they hash to exactly that id; git is asked
// with --no-replace-objects as well (belt and braces). Ids are likewise
// computed in-process from the exact bytes written or parsed, never by
// `git hash-object` on a path (that would re-read the file and run the
// checkout's member-configured clean filters).
//
// Every helper runs git with array args and no shell (same on every OS) and
// returns null rather than throwing when git cannot answer.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';

export const OWN_BIBLE_REL = '.fleet/kb-canonical.json';

function gitBuffer(args: string[], cwd: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    execFile('git', ['--no-replace-objects', ...args], {
      cwd, windowsHide: true, timeout: 30_000, maxBuffer: 256 * 1024 * 1024, encoding: 'buffer',
    }, (err, stdout) => resolve(err ? null : stdout));
  });
}

async function git(args: string[], cwd: string): Promise<string | null> {
  const out = await gitBuffer(args, cwd);
  return out === null ? null : out.toString('utf-8');
}

const OBJECT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * Bytes read from the object store do not hash to the blob id they were read
 * by (replace ref, alternates, overwritten loose object, crafted pack). The
 * caller must import nothing.
 */
export class BibleBlobIntegrityError extends Error {
  constructor(readonly blobId: string, readonly source: string) {
    super(`the git object store returned bytes for ${source} (blob ${blobId}) that do not hash to that blob id -- a replace ref, an alternates entry, an overwritten loose object or a crafted pack is substituting the bible; nothing was imported`);
    this.name = 'BibleBlobIntegrityError';
  }
}

/** The git blob id of `bytes` in the given object format (40-hex sha1, 64-hex sha256). */
export function gitBlobId(bytes: Buffer, format: 'sha1' | 'sha256'): string {
  return createHash(format)
    .update(Buffer.from('blob ' + bytes.length + '\0', 'utf-8'))
    .update(bytes)
    .digest('hex');
}

/** True when `bytes` are exactly the blob `id` (format chosen by the id length). */
export function blobBytesMatchId(id: string, bytes: Buffer): boolean {
  if (!OBJECT_ID.test(id)) return false;
  return gitBlobId(bytes, id.length === 64 ? 'sha256' : 'sha1') === id;
}

/**
 * A git rev the caller may name for the own bible (kb_import `ref`): a ref
 * name or HEAD, never an option (leading '-') and never a rev expression
 * (no ':', '..', '@{', '^', '~', whitespace).
 */
export function isSafeBibleRef(ref: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(ref) && !ref.includes('..') && !ref.endsWith('/') && !ref.endsWith('.lock');
}

/**
 * The bible at `rel` (default the own bible, a path relative to `folder`) as
 * committed at `ref` (default HEAD): its blob id and its bytes, read as ONE
 * object (the id is resolved first and the bytes are read by that id, then
 * hashed in-process against it -- see the header). `./` resolves the path
 * against `folder`, which need not be the repository top level. null when
 * there is no committed copy (unresolvable or unsafe ref, unborn HEAD,
 * bible not tracked at that ref, not a work tree, git missing). Throws
 * BibleBlobIntegrityError when the bytes do not hash to the id.
 */
export async function readCommittedBibleBlob(
  folder: string, ref = 'HEAD', rel = OWN_BIBLE_REL,
): Promise<{ blobId: string; text: string } | null> {
  if (!isSafeBibleRef(ref)) return null;
  const id = (await git(['rev-parse', '--verify', '--quiet', ref + ':./' + rel], folder))?.trim() ?? '';
  if (!OBJECT_ID.test(id)) return null;
  const bytes = await gitBuffer(['cat-file', 'blob', id], folder);
  if (bytes === null) return null;
  if (!blobBytesMatchId(id, bytes)) throw new BibleBlobIntegrityError(id, ref + ':' + rel);
  return { blobId: id, text: bytes.toString('utf-8') };
}

/**
 * The blob id git would store for `bytes` committed unfiltered in the
 * repository containing `folder`, computed in-process (`git hash-object
 * --no-filters` semantics; the object format comes from the repository,
 * sha1 outside one or when git is too old to report it -- such a git reads
 * only sha1 repositories).
 */
export async function bibleBytesBlobId(folder: string, bytes: Buffer): Promise<string> {
  const fmt = (await git(['rev-parse', '--show-object-format'], folder))?.trim();
  return gitBlobId(bytes, fmt === 'sha256' ? 'sha256' : 'sha1');
}
