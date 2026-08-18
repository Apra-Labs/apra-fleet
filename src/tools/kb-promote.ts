import { z } from 'zod';
import { getKbProviders } from '../services/knowledge/kb-providers.js';
import { kbScopeFields } from '../services/knowledge/kb-scope-input.js';

export const kbPromoteSchema = z.object({
  ...kbScopeFields,
  repo_path: z.string().optional()
    .describe('Path to the repo root this call is about. Selects WHICH project KB is read/written. When omitted, falls back to the calling process cwd, which is only correct for single-repo CLI use -- server-handled tool calls must pass it explicitly.'),
  id: z.string().min(1).describe('ID of the KB entry to promote'),
  reason: z.string().optional().describe('Reason for promotion (appended to content as evidence trail)'),
});

export type KbPromoteInput = z.infer<typeof kbPromoteSchema>;

export async function kbPromote(input: KbPromoteInput): Promise<string> {
  const providers = await getKbProviders(input.repo_path, input.repo_remote_url);

  const result = await providers.project.promote(input.id, input.reason);
  return JSON.stringify({
    id: result.id,
    previous_confidence: result.confidence_before,
    new_confidence: result.confidence_after,
  });
}
