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
// blob id is the git object id of the bible bytes (git hash-object semantics),
// so the id recorded for the maintainer's written file equals the HEAD:path
// blob id of the same bytes in any clone that checks it out.
//
// Every helper runs git with array args and no shell (same on every OS) and
// returns null rather than throwing when git cannot answer.

import { execFile } from 'node:child_process';

export const OWN_BIBLE_REL = '.fleet/kb-canonical.json';

function git(args: string[], cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', args, {
      cwd, windowsHide: true, timeout: 30_000, maxBuffer: 256 * 1024 * 1024, encoding: 'utf-8',
    }, (err, stdout) => resolve(err ? null : stdout));
  });
}

const OBJECT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * The committed own bible at HEAD: its blob id and its bytes, read as ONE
 * object (the id is resolved first and the bytes are read by that id, so a
 * HEAD that moves between the two reads cannot pair one bible's id with
 * another bible's bytes). `./` resolves the path against `folder`, which need
 * not be the repository top level. null when there is no committed copy
 * (unborn HEAD, bible not tracked, not a work tree, git missing).
 */
export async function readCommittedBibleBlob(folder: string): Promise<{ blobId: string; text: string } | null> {
  const id = (await git(['rev-parse', '--verify', '--quiet', 'HEAD:./' + OWN_BIBLE_REL], folder))?.trim() ?? '';
  if (!OBJECT_ID.test(id)) return null;
  const text = await git(['cat-file', 'blob', id], folder);
  return text === null ? null : { blobId: id, text };
}

/**
 * The blob id git would store for `file` if it were committed as the own
 * bible of the repository containing `folder` (`git hash-object
 * --path=./.fleet/kb-canonical.json`, so that path's clean filters, such as
 * autocrlf, apply exactly as on commit). Outside a work tree git still hashes
 * the bytes (no filters). null when git is missing or cannot read the file.
 */
export async function bibleFileBlobId(folder: string, file: string): Promise<string | null> {
  const id = (await git(['hash-object', '--path=./' + OWN_BIBLE_REL, '--', file], folder))?.trim() ?? '';
  return OBJECT_ID.test(id) ? id : null;
}
