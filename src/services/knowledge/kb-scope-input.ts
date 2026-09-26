import { z } from 'zod';

// Single reusable zod fragment for the repo_remote_url input, spread into
// every kb_* tool schema that already takes repo_path. Keeping ONE definition
// avoids the kb_stats repo/repo_path divergence: zod strips unknown keys
// silently, so a misnamed or re-typed copy of this field would fail by
// reporting an empty KB rather than erroring.
export const kbScopeFields = {
  repo_remote_url: z.string().optional()
    .describe('Origin remote URL of the repo this call is about. Supply it when repo_path is a path on another host (a remote member work folder), where git cannot be shelled out. When omitted, scope is derived from repo_path as before.'),
};
