import { z } from 'zod';
import { getKBService } from '../services/knowledge/kb-service.js';

const L2_CONTENT_CAP = 3200;

export const kbQuerySchema = z.object({
  query: z.string().min(1).describe('Free-text search string'),
  type: z.enum(['context-cache', 'learning', 'knowledge', 'runbook']).optional()
    .describe('Filter by content type'),
  limit: z.number().optional().describe('Max L1 results (default 20)'),
  include_stale: z.boolean().optional().describe('Include stale and superseded entries (default false)'),
});

export type KbQueryInput = z.infer<typeof kbQuerySchema>;

export async function kbQuery(input: KbQueryInput): Promise<string> {
  const service = getKBService();
  const provider = service.getProvider();
  await provider.init();

  const l1 = await provider.query({
    query: input.query,
    type: input.type,
    limit: input.limit ?? 20,
    l1_only: true,
    include_stale: input.include_stale ?? false,
    include_superseded: input.include_stale ?? false,
  });

  const top5Ids = l1.results.slice(0, 5).map(e => e.id);
  let l2Results = l1.results.slice(0, 5);

  if (top5Ids.length > 0) {
    const l2 = await provider.query({ ids: top5Ids });
    l2Results = l2.results.map(e => ({
      ...e,
      content: e.content.length > L2_CONTENT_CAP
        ? e.content.slice(0, L2_CONTENT_CAP) + '...[truncated]'
        : e.content,
    }));
  }

  return JSON.stringify({
    l1_results: l1.results,
    l2_expanded: l2Results,
  });
}
