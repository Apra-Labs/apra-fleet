import { z } from 'zod';
import { getKbProviders } from '../services/knowledge/kb-providers.js';
import { kbScopeFields } from '../services/knowledge/kb-scope-input.js';

const L2_CONTENT_CAP = 3200;

export const kbQuerySchema = z.object({
  ...kbScopeFields,
  repo_path: z.string().optional()
    .describe('Path to the repo root this call is about. Selects WHICH project KB is read/written. When omitted, falls back to the calling process cwd, which is only correct for single-repo CLI use -- server-handled tool calls must pass it explicitly.'),
  query: z.string().min(1).optional().describe('Free-text search string. Required unless flagged_only is true or tag is provided.'),
  type: z.enum(['context-cache', 'learning', 'knowledge', 'runbook']).optional()
    .describe('Filter by content type'),
  tag: z.string().optional().describe('Filter to entries whose tags array contains this value (exact match, ANDed alongside other filters -- not an FTS term). May be used alone (no query) to list all entries carrying the tag.'),
  limit: z.number().optional().describe('Max L1 results (default 20)'),
  include_stale: z.boolean().optional().describe('Include stale and superseded entries (default false)'),
  flagged_only: z.boolean().optional()
    .describe('Return all contradiction-flagged entries. When true, query is optional and full content is returned.'),
  // KB audit 2026-08-11: the first consumer of the KB's own graph. Opt-in and
  // default-off so every existing caller's result shape is byte-for-byte
  // unchanged; the sprint engine sets it, because a role about to act on an
  // entry is exactly who needs to know that entry has been refined or disputed.
  expand_related: z.boolean().optional()
    .describe('Append entries connected to the top hits by a refines or contradiction_of edge, as related_claims. These are the KB\'s own judgements about its contents -- "there is a newer framing of this" and "something disputes this" -- which a text match cannot surface. shares_file/shares_symbol edges are NOT traversed: FTS over the same fields already finds those. Default false, in which case related_claims is absent.'),
});

export type KbQueryInput = z.infer<typeof kbQuerySchema>;

export async function kbQuery(input: KbQueryInput): Promise<string> {
  // Tag-only calls are valid (HIGH-1 fix): the provider's plain (non-FTS)
  // branch supports a queryless listing, so `kb_query({ tag })` lists all
  // entries carrying the tag -- the KB Agent curator's Step 2 depends on it.
  if (!input.query && !input.flagged_only && !input.tag) {
    throw new Error('Provide query (free-text search), tag (exact-match tag listing), or flagged_only: true (list contradictions)');
  }

  const providers = await getKbProviders(input.repo_path, input.repo_remote_url);

  if (input.flagged_only) {
    const flaggedOpts = {
      query: input.query,
      tag: input.tag,
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
        : `${merged.length} flagged entries found. Contradiction pairs: one entry has flagged_for_review=true, its counterpart has contradiction_of set to the original ID -- resolve by calling kb_promote (keep), kb_capture (correct), or kb_invalidate (remove). EXCEPTION (F1/D1): a directive PROPOSAL (type=user-directive, tag directive:pending) is resolved ONLY by the human CLI (apra-fleet kb approve-directive <id> / reject-directive <id>) -- kb_promote refuses user-directive entries.`,
    });
  }

  const queryOpts = {
    query: input.query,
    type: input.type,
    tag: input.tag,
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

  // Graph expansion (opt-in). Keyed off the SAME top ids that were expanded to
  // L2 above -- the entries the caller is actually going to read -- so a related
  // claim always attaches to something present in the result. Non-fatal by the
  // same rule as every other KB read path: a graph miss degrades to no
  // related_claims, it never costs the caller its search results.
  let relatedClaims: Awaited<ReturnType<typeof providers.project.relatedClaims>> = [];
  if (input.expand_related && top5Ids.length > 0) {
    try {
      relatedClaims = await providers.project.relatedClaims(top5Ids);
    } catch {
      relatedClaims = [];
    }
  }

  return JSON.stringify({
    l1_results: mergedL1,
    l2_expanded: l2Results,
    ...(input.expand_related ? { related_claims: relatedClaims } : {}),
  });
}
