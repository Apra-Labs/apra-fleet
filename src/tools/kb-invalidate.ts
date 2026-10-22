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

export const KB_POST_COMMIT_HOOK = `#!/bin/sh
# apra-fleet KB invalidation hook
# Marks context-cache entries stale for files changed in the last commit
git diff-tree --no-commit-id -r --name-only HEAD | while IFS= read -r f; do
  [ -n "$f" ] && node dist/index.js kb invalidate "$f" 2>/dev/null || true
done
`;

// Ask git for the hooks dir: in a linked worktree .git is a file, and
// core.hooksPath may relocate the dir. Fails loud, naming repoPath.
function resolveGitHooksDir(repoPath: string): string {
  let out: string;
  try {
    out = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], {
      cwd: repoPath, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    }).trim().split(/\r?\n/)[0]?.trim() ?? '';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot resolve git hooks dir for ${repoPath}: ${msg}`);
  }
  if (!out) {
    throw new Error(`Cannot resolve git hooks dir for ${repoPath}: git rev-parse --git-path hooks printed nothing`);
  }
  return path.isAbsolute(out) ? out : path.join(repoPath, out);
}

export function installKbPostCommitHook(repoPath: string): void {
  const hookDir = resolveGitHooksDir(repoPath);
  fs.mkdirSync(hookDir, { recursive: true });
  const hookPath = path.join(hookDir, 'post-commit');
  fs.writeFileSync(hookPath, KB_POST_COMMIT_HOOK, { mode: 0o755 });
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
