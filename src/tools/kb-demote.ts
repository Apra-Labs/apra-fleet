import { z } from 'zod';
import { getKbProviders } from '../services/knowledge/kb-providers.js';
import { kbScopeFields } from '../services/knowledge/kb-scope-input.js';
import { requireSqliteProject } from '../services/knowledge/require-sqlite-project.js';

export const kbDemoteSchema = z.object({
  ...kbScopeFields,
  repo_path: z.string().optional()
    .describe('Path to the repo root this call is about. Selects WHICH project KB is read/written. When omitted, falls back to the calling process cwd, which is only correct for single-repo CLI use -- server-handled tool calls must pass it explicitly.'),
  id: z.string().min(1).describe('ID of the KB entry to demote'),
  reason: z.string().describe('Why this entry is now less certain (appended to content as a demotion note). Must state what you checked.'),
  evidence_files: z.array(z.string()).optional()
    .describe('Files that support the demotion (e.g. where the claim no longer holds). Optional -- omit or leave empty for a demotion with no new basis to cite. Paths must resolve and must not traverse outside the repo.'),
});

export type KbDemoteInput = z.infer<typeof kbDemoteSchema>;

// D1: unlike kb-promote.ts, this tool requires a real SqliteProvider project
// (as kb-feedback.ts does) so an HTTP-configured KB fails LOUDLY instead of
// silently writing to the local fallback DB.
export async function kbDemote(input: KbDemoteInput): Promise<string> {
  const providers = await getKbProviders(input.repo_path, input.repo_remote_url);
  const sqliteProvider = requireSqliteProject(providers.project, 'kb_demote');

  const result = await sqliteProvider.demote(input.id, input.reason, input.evidence_files);
  return JSON.stringify({
    id: result.id,
    previous_confidence: result.confidence_before,
    new_confidence: result.confidence_after,
  });
}
