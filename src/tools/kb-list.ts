import { z } from 'zod';
import { getKbProviders } from '../services/knowledge/kb-providers.js';

// T3.3 (F8a, D8): kb_list -- a read-only audit view over the CONFIRMED (or any
// filtered) set. Distinct from kb_query: no FTS, no L2 expansion, and
// (CHOICE, see SqliteProvider.list) it does NOT bump use_count/last_accessed,
// since inspecting the KB's trust tiers is not "retrieval" for the purposes
// of that telemetry.
export const kbListSchema = z.object({
  confidence: z.enum(['CONFIRMED', 'INFERRED', 'UNVERIFIED']).optional()
    .describe('Filter by confidence tier'),
  type: z.enum(['context-cache', 'learning', 'knowledge', 'runbook', 'user-directive']).optional()
    .describe('Filter by content type'),
  module: z.string().optional().describe('Filter by exact module name'),
  symbol: z.string().optional().describe('Filter to entries whose symbols array contains this value'),
  tag: z.string().optional().describe('Filter to entries whose tags array contains this value (exact match)'),
  limit: z.number().optional().describe('Max entries to return (default: no limit)'),
});

export type KbListInput = z.infer<typeof kbListSchema>;

export async function kbList(input: KbListInput): Promise<string> {
  const providers = await getKbProviders();

  const entries = await providers.project.list({
    confidence: input.confidence,
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
