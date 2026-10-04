import { z } from 'zod';
import { getKbProviders } from '../services/knowledge/kb-providers.js';
import { kbScopeFields } from '../services/knowledge/kb-scope-input.js';
import { requireSqliteProject } from '../services/knowledge/require-sqlite-project.js';

// T3.3 (F8a, D8): kb_list -- a read-only audit view over the CONFIRMED (or any
// filtered) set. Distinct from kb_query: no FTS, no L2 expansion, and
// (CHOICE, see SqliteProvider.list) it does NOT bump use_count/last_accessed,
// since inspecting the KB's trust tiers is not "retrieval" for the purposes
// of that telemetry.
export const kbListSchema = z.object({
  ...kbScopeFields,
  repo_path: z.string().optional()
    .describe('Path to the repo root this call is about. Selects WHICH project KB is read/written. When omitted, falls back to the calling process cwd, which is only correct for single-repo CLI use -- server-handled tool calls must pass it explicitly.'),
  confidence: z.enum(['CONFIRMED', 'INFERRED', 'UNVERIFIED']).optional()
    .describe('Filter by confidence tier'),
  type: z.enum(['context-cache', 'learning', 'knowledge', 'runbook', 'user-directive']).optional()
    .describe('Filter by content type'),
  module: z.string().optional().describe('Filter by exact module name'),
  symbol: z.string().optional().describe('Filter to entries whose symbols array contains this value'),
  tag: z.string().optional().describe('Filter to entries whose tags array contains this value (exact match)'),
  source_files: z.array(z.string()).optional()
    .describe('Filter to entries citing at least one of these basis files (exact match against the entry source_files array). Use this to scope a read to the files a change actually touched, instead of reading the whole KB and intersecting client-side. An empty array means no filter.'),
  limit: z.number().optional().describe('Max entries to return (default: no limit)'),
  exclude_unchanged_demotions: z.boolean().optional()
    .describe('Drop an entry that was demoted more recently than it was last promoted or captured, UNLESS at least one of its cited files now hashes differently from the snapshot taken at demotion time. Use this to avoid re-offering an entry for promotion when nothing about it has actually changed since it was demoted.'),
});

export type KbListInput = z.infer<typeof kbListSchema>;

export async function kbList(input: KbListInput): Promise<string> {
  const providers = await getKbProviders(input.repo_path, input.repo_remote_url);
  const sqliteProvider = requireSqliteProject(providers.project, 'kb_list');

  const entries = await sqliteProvider.list({
    confidence: input.confidence,
    type: input.type,
    module: input.module,
    symbol: input.symbol,
    tag: input.tag,
    sourceFiles: input.source_files,
    limit: input.limit,
    excludeUnchangedDemotions: input.exclude_unchanged_demotions,
  });

  const results = entries.map(e => ({
    id: e.id,
    type: e.type,
    confidence: e.confidence,
    title: e.title,
    summary: e.summary,
    symbols: e.symbols,
    source_files: e.source_files,
  }));

  return JSON.stringify({ results, total: results.length });
}
