import { z } from 'zod';
import { KB_REMOVED_SCOPE_KEYS_SHAPE } from '../services/knowledge/kb-removed-scope-keys.js';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { getSelfKbProviders, memberOwnerTag, type KbAnchor } from '../services/knowledge/kb-self.js';
import { requireSqliteProject } from '../services/knowledge/require-sqlite-project.js';
import { validateFilePaths } from '../services/knowledge/path-validation.js';
import { memberLacksKbMaintainer } from '../services/knowledge/kb-maintainer-grant.js';

export const kbInvalidateSchema = z.object({
  files: z.array(z.string()).min(1).optional().describe('File paths to invalidate (context-cache entries for these files will be marked stale)'),
  ids: z.array(z.string().min(1)).min(1).optional().describe('Entry ids to discard (sets superseded_at; the entry drops from all reads). Exactly one of files or ids.'),
  // Removed pre-redesign scope keys: declared only so a caller still passing one
  // is refused with E-SCOPE-KEY-REMOVED instead of silently re-scoped.
  ...KB_REMOVED_SCOPE_KEYS_SHAPE,
});

export type KbInvalidateInput = z.infer<typeof kbInvalidateSchema>;

// Identifies a post-commit hook fleet wrote; kb_setup only rewrites files carrying it.
export const KB_HOOK_MARKER = '# apra-fleet KB invalidation hook';

export const KB_POST_COMMIT_HOOK = `#!/bin/sh
${KB_HOOK_MARKER}
# Marks context-cache entries stale for files changed in the last commit
git diff-tree --no-commit-id -r --name-only HEAD | while IFS= read -r f; do
  [ -n "$f" ] && node dist/index.js kb invalidate "$f" 2>/dev/null || true
done
`;

export type KbHookInstallResult =
  | { installed: true; hookPath: string }
  | { installed: false; reason: string };

// Ask git for a path (`git rev-parse <args>`), made absolute against repoPath.
// Used for the hooks dir -- in a linked worktree .git is a file, and
// core.hooksPath may relocate it -- and the git common dir. Fails loud, naming repoPath.
function gitRevParsePath(repoPath: string, args: string[]): string {
  const command = `git rev-parse ${args.join(' ')}`;
  let out: string;
  try {
    out = execFileSync('git', ['rev-parse', ...args], {
      cwd: repoPath, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    }).trim().split(/\r?\n/)[0]?.trim() ?? '';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot resolve git path for ${repoPath} (${command}): ${msg}`);
  }
  if (!out) {
    throw new Error(`Cannot resolve git path for ${repoPath}: ${command} printed nothing`);
  }
  return path.isAbsolute(out) ? out : path.join(repoPath, out);
}

// Realpath of p, or of its nearest existing ancestor with the rest re-appended,
// so a not-yet-created dir compares in the same form as an existing one
// (Windows 8.3 short names, macOS /var -> /private/var).
function canonicalPath(p: string): string {
  const resolved = path.resolve(p);
  if (fs.existsSync(resolved)) return fs.realpathSync.native(resolved);
  const parent = path.dirname(resolved);
  if (parent === resolved) return resolved;
  return path.join(canonicalPath(parent), path.basename(resolved));
}

function isWithin(base: string, target: string): boolean {
  const rel = path.relative(base, target);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

// The hooks dir must sit under the worktree or the git common dir; a global
// core.hooksPath pointing elsewhere is shared by other repos and not ours to write.
function hookDirInsideRepo(repoPath: string, hookDir: string): boolean {
  const target = canonicalPath(hookDir);
  const commonDir = gitRevParsePath(repoPath, ['--git-common-dir']);
  return [repoPath, commonDir].some((base) => isWithin(canonicalPath(base), target));
}

// True when hookPath is absent, or is a regular file carrying KB_HOOK_MARKER.
// A symlink, directory or unmarked file belongs to someone else.
function hookIsOursOrAbsent(hookPath: string): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(hookPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true;
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot inspect existing post-commit hook at ${hookPath}: ${msg}`);
  }
  return stat.isFile() && fs.readFileSync(hookPath, 'utf8').includes(KB_HOOK_MARKER);
}

export function installKbPostCommitHook(repoPath: string): KbHookInstallResult {
  const hookDir = gitRevParsePath(repoPath, ['--git-path', 'hooks']);
  if (!hookDirInsideRepo(repoPath, hookDir)) {
    return { installed: false, reason: `hooks dir ${hookDir} is outside the repo and its git dir (core.hooksPath)` };
  }
  const hookPath = path.join(hookDir, 'post-commit');
  if (!hookIsOursOrAbsent(hookPath)) {
    return { installed: false, reason: `existing post-commit at ${hookPath} is not ours` };
  }
  fs.mkdirSync(hookDir, { recursive: true });
  fs.writeFileSync(hookPath, KB_POST_COMMIT_HOOK, { mode: 0o755 });
  return { installed: true, hookPath };
}

// A MEMBER session WITHOUT the kb_maintainer grant may not retire a CONFIRMED
// entry by either form: a discarded (ids) or file-invalidated (files) row is
// retired, and kb_bible_commit removes retired entries from the bible, so that
// would be a bible removal without the grant (the engine's own discards run in
// the kb_maintainer session and are unaffected). Such CONFIRMED ids are left
// untouched and reported in a `refused` list (E-RETIRE-NEEDS-KB-MAINTAINER, a
// response-field refusal); the rest of the call proceeds. `refused` is present
// exactly when the call came from such a session (it may be empty).
export async function kbInvalidate(input: KbInvalidateInput, anchor?: KbAnchor): Promise<string> {
  if ((input.files === undefined) === (input.ids === undefined)) {
    throw new Error('Provide exactly one of files or ids');
  }
  const keepConfirmed = memberLacksKbMaintainer(anchor);
  if (input.ids) {
    const providers = await getSelfKbProviders(anchor);
    const ownerTag = memberOwnerTag(anchor);
    const opts = {
      ...(ownerTag !== undefined ? { ownerTag } : {}),
      ...(keepConfirmed ? { keepConfirmed: true } : {}),
    };
    const result = await providers.project.discard(input.ids, Object.keys(opts).length > 0 ? opts : undefined);
    return JSON.stringify(result);
  }
  validateFilePaths(input.files!);

  const providers = await getSelfKbProviders(anchor);
  // MEMBER session: only the caller's own captures (member:<uuid>) for these
  // files are invalidated; other members' entries are left untouched.
  const ownerTag = memberOwnerTag(anchor);
  if (ownerTag !== undefined) {
    const { invalidated, refused } = await requireSqliteProject(providers.project, 'kb_invalidate')
      .invalidate(input.files!, { ownerTag, ...(keepConfirmed ? { keepConfirmed: true } : {}) });
    return JSON.stringify(refused !== undefined ? { invalidated, files: input.files, refused } : { invalidated, files: input.files });
  }
  const { invalidated } = await providers.project.invalidate(input.files!);
  return JSON.stringify({ invalidated, files: input.files });
}
