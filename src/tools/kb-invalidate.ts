import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs';
import { getSelfKbProviders, type KbAnchor } from '../services/knowledge/kb-self.js';
import { getSessionMemberId } from '../services/tool-scope.js';
import { validateFilePaths } from '../services/knowledge/path-validation.js';

export const kbInvalidateSchema = z.object({
  files: z.array(z.string()).min(1).optional().describe('File paths to invalidate (context-cache entries for these files will be marked stale)'),
  ids: z.array(z.string().min(1)).min(1).optional().describe('Entry ids to discard (sets superseded_at; the entry drops from all reads). Exactly one of files or ids.'),
});

export type KbInvalidateInput = z.infer<typeof kbInvalidateSchema>;

export const KB_POST_COMMIT_HOOK = `#!/bin/sh
# apra-fleet KB invalidation hook
# Marks context-cache entries stale for files changed in the last commit
git diff-tree --no-commit-id -r --name-only HEAD | while IFS= read -r f; do
  [ -n "$f" ] && node dist/index.js kb invalidate "$f" 2>/dev/null || true
done
`;

export function installKbPostCommitHook(repoPath: string): void {
  const hookDir = path.join(repoPath, '.git', 'hooks');
  if (!fs.existsSync(hookDir)) {
    fs.mkdirSync(hookDir, { recursive: true });
  }
  const hookPath = path.join(hookDir, 'post-commit');
  fs.writeFileSync(hookPath, KB_POST_COMMIT_HOOK, { mode: 0o755 });
}

export async function kbInvalidate(input: KbInvalidateInput, anchor?: KbAnchor): Promise<string> {
  if ((input.files === undefined) === (input.ids === undefined)) {
    throw new Error('Provide exactly one of files or ids');
  }
  if (input.ids) {
    const providers = await getSelfKbProviders(anchor);
    const memberId = getSessionMemberId();
    const result = await providers.project.discard(input.ids, memberId ? { ownerTag: `member:${memberId}` } : undefined);
    return JSON.stringify(result);
  }
  validateFilePaths(input.files!);

  const providers = await getSelfKbProviders(anchor);
  const { invalidated } = await providers.project.invalidate(input.files!);
  return JSON.stringify({ invalidated, files: input.files });
}
