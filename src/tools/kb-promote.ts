import { z } from 'zod';
import { getKbProviders } from '../services/knowledge/kb-providers.js';
import { kbScopeFields } from '../services/knowledge/kb-scope-input.js';

export const kbPromoteSchema = z.object({
  ...kbScopeFields,
  repo_path: z.string().optional()
    .describe('Path to the repo root this call is about. Selects WHICH project KB is read/written. Required when the call is handled by the fleet server (MCP) unless repo_remote_url is given: a call with neither is refused with reason repo_scope_required -- the server never resolves a project from its own working directory. Only the in-shell CLI falls back to the current directory.'),
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
