import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs';
import { getKbProviders } from '../services/knowledge/kb-providers.js';
import { validateFilePaths } from '../services/knowledge/path-validation.js';
import { kbScopeFields } from '../services/knowledge/kb-scope-input.js';

export const kbInvalidateSchema = z.object({
  ...kbScopeFields,
  repo_path: z.string().optional()
    .describe('Path to the repo root this call is about. Selects WHICH project KB is read/written. Required when the call is handled by the fleet server (MCP) unless repo_remote_url is given: a call with neither is refused with reason repo_scope_required -- the server never resolves a project from its own working directory. Only the in-shell CLI falls back to the current directory.'),
  files: z.array(z.string()).min(1).describe('File paths to invalidate (context-cache entries for these files will be marked stale)'),
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

export async function kbInvalidate(input: KbInvalidateInput): Promise<string> {
  validateFilePaths(input.files);

  const providers = await getKbProviders(input.repo_path, input.repo_remote_url);
  const { invalidated } = await providers.project.invalidate(input.files);
  return JSON.stringify({ invalidated, files: input.files });
}
