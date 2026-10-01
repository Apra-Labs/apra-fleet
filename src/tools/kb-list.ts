import { z } from 'zod';
import { getSelfKbProviders, type KbAnchor } from '../services/knowledge/kb-self.js';
import { requireSqliteProject } from '../services/knowledge/require-sqlite-project.js';

// T3.3 (F8a, D8): kb_list -- a read-only audit view over the CONFIRMED (or any
// filtered) set. Distinct from kb_query: no FTS, no L2 expansion, and
// (CHOICE, see SqliteProvider.list) it does NOT bump use_count/last_accessed,
// since inspecting the KB's trust tiers is not "retrieval" for the purposes
// of that telemetry.
export const kbListSchema = z.object({
  confidence: z.array(z.enum(['CONFIRMED', 'INFERRED', 'UNVERIFIED'])).min(1).optional()
    .describe('Only return entries whose confidence tier is in this list (e.g. ["INFERRED","UNVERIFIED"]). Default when omitted: ["CONFIRMED"] -- INFERRED and UNVERIFIED entries are returned only when listed explicitly.'),
  type: z.enum(['context-cache', 'learning', 'knowledge', 'runbook', 'user-directive']).optional()
    .describe('Filter by content type'),
  module: z.string().optional().describe('Filter by exact module name'),
  symbol: z.string().optional().describe('Filter to entries whose symbols array contains this value'),
  tag: z.string().optional().describe('Filter to entries whose tags array contains this value (exact match)'),
  limit: z.number().optional().describe('Max entries to return (default: no limit)'),
});

const DEFAULT_CONFIDENCE: Array<'CONFIRMED' | 'INFERRED' | 'UNVERIFIED'> = ['CONFIRMED'];

export type KbListInput = z.infer<typeof kbListSchema>;

export async function kbList(input: KbListInput, anchor?: KbAnchor): Promise<string> {
  const providers = await getSelfKbProviders(anchor);
  const sqliteProvider = requireSqliteProject(providers.project, 'kb_list');

  const entries = await sqliteProvider.list({
    confidence: input.confidence?.length ? input.confidence : DEFAULT_CONFIDENCE,
    // Default read is CONFIRMED *and* undisputed; an explicit tier list opts out.
    exclude_disputed: !input.confidence?.length,
    type: input.type,
    module: input.module,
    symbol: input.symbol,
    tag: input.tag,
    limit: input.limit,
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
