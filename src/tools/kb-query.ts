import { z } from 'zod';
import { getKbProviders } from '../services/knowledge/kb-providers.js';

const L2_CONTENT_CAP = 3200;

export const kbQuerySchema = z.object({
  query: z.string().min(1).optional().describe('Free-text search string. Required unless flagged_only is true.'),
  type: z.enum(['context-cache', 'learning', 'knowledge', 'runbook']).optional()
    .describe('Filter by content type'),
  limit: z.number().optional().describe('Max L1 results (default 20)'),
  include_stale: z.boolean().optional().describe('Include stale and superseded entries (default false)'),
  flagged_only: z.boolean().optional()
    .describe('Return all contradiction-flagged entries. When true, query is optional and full content is returned.'),
});

export type KbQueryInput = z.infer<typeof kbQuerySchema>;

export async function kbQuery(input: KbQueryInput): Promise<string> {
  if (!input.query && !input.flagged_only) {
    throw new Error('Provide either query (free-text search) or flagged_only: true (list contradictions)');
  }

  const providers = await getKbProviders();

  if (input.flagged_only) {
    const flaggedOpts = {
      query: input.query,
      flagged_only: true,
      include_stale: true,
      include_superseded: false,
      limit: input.limit ?? 100,
      l1_only: false,
    };

    const projectFlagged = await providers.project.query(flaggedOpts);
    const globalFlagged = await providers.global.query(flaggedOpts);

    const seen = new Set(projectFlagged.results.map(e => e.id));
    const merged = [
      ...projectFlagged.results,
      ...globalFlagged.results.filter(e => !seen.has(e.id)),
    ];

    return JSON.stringify({
      flagged_entries: merged,
      total: merged.length,
      note: merged.length === 0
        ? 'No flagged contradictions found -- KB is clean.'
        : `${merged.length} flagged entry pairs found. Each pair: one entry has flagged_for_review=true, its counterpart has contradiction_of set to the original ID. Resolve by calling kb_promote (keep), kb_capture (correct), or kb_invalidate (remove).`,
    });
  }

  const queryOpts = {
    query: input.query,
    type: input.type,
    limit: input.limit ?? 20,
    l1_only: true,
    include_stale: input.include_stale ?? false,
    include_superseded: input.include_stale ?? false,
  };

  const projectL1 = await providers.project.query(queryOpts);
  const globalL1 = await providers.global.query(queryOpts);

  // Merge project first, deduplicate global entries by title
  const seen = new Set(projectL1.results.map(e => e.title));
  const mergedL1 = [
    ...projectL1.results,
    ...globalL1.results.filter(e => !seen.has(e.title)),
  ];

  const top5Ids = mergedL1.slice(0, 5).map(e => e.id);
  let l2Results = mergedL1.slice(0, 5);

  if (top5Ids.length > 0) {
    // L2 fetch: check project first, then global for IDs not found in project
    const projectL2 = await providers.project.query({ ids: top5Ids });
    const projectL2Ids = new Set(projectL2.results.map(e => e.id));
    const missingIds = top5Ids.filter(id => !projectL2Ids.has(id));
    const globalL2Results = missingIds.length > 0
      ? (await providers.global.query({ ids: missingIds })).results
      : [];

    l2Results = [...projectL2.results, ...globalL2Results].map(e => ({
      ...e,
      content: e.content.length > L2_CONTENT_CAP
        ? e.content.slice(0, L2_CONTENT_CAP) + '...[truncated]'
        : e.content,
    }));
  }

  return JSON.stringify({
    l1_results: mergedL1,
    l2_expanded: l2Results,
  });
}
