import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs';
import { getKBService } from '../services/knowledge/kb-service.js';

export const kbInvalidateSchema = z.object({
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
  const service = getKBService();
  const provider = service.getProvider();
  await provider.init();

  const { invalidated } = await provider.invalidate(input.files);
  return JSON.stringify({ invalidated, files: input.files });
}
