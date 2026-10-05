import { z } from 'zod';
import { KB_REMOVED_SCOPE_KEYS_SHAPE } from '../services/knowledge/kb-removed-scope-keys.js';
import { getSelfReadKb, type KbAnchor } from '../services/knowledge/kb-self.js';
import { requireSqliteProject } from '../services/knowledge/require-sqlite-project.js';

// T3.3 (F8a, D8): kb_list -- a read-only audit view over the CONFIRMED (or any
// filtered) set. Distinct from kb_query: no FTS, no L2 expansion, and
// (CHOICE, see SqliteProvider.list) it does NOT bump use_count/last_accessed,
// since inspecting the KB's trust tiers is not "retrieval" for the purposes
// of that telemetry.
export const kbListSchema = z.object({
  // Pre-redesign kb_list took ONE tier as a bare string; the redesign made it
  // a list. Both forms are accepted so an existing caller keeps working: a
  // string is exactly the one-element list (normaliseConfidence).
  confidence: z.union([
    z.enum(['CONFIRMED', 'INFERRED', 'UNVERIFIED']),
    z.array(z.enum(['CONFIRMED', 'INFERRED', 'UNVERIFIED'])).min(1),
  ]).optional()
    .describe('Only return entries whose confidence tier is in this list (e.g. ["INFERRED","UNVERIFIED"]); a single tier string (e.g. "INFERRED") is accepted as a one-element list. Default when omitted: ["CONFIRMED"] -- INFERRED and UNVERIFIED entries are returned only when listed explicitly.'),
  type: z.enum(['context-cache', 'learning', 'knowledge', 'runbook', 'user-directive']).optional()
    .describe('Filter by content type'),
  module: z.string().optional().describe('Filter by exact module name'),
  symbol: z.string().optional().describe('Filter to entries whose symbols array contains this value'),
  tag: z.string().optional().describe('Filter to entries whose tags array contains this value (exact match)'),
  limit: z.number().optional().describe('Max entries to return (default: no limit)'),
  // Removed pre-redesign scope keys: declared only so a caller still passing one
  // is refused with E-SCOPE-KEY-REMOVED instead of silently re-scoped.
  ...KB_REMOVED_SCOPE_KEYS_SHAPE,
});

const DEFAULT_CONFIDENCE: Array<'CONFIRMED' | 'INFERRED' | 'UNVERIFIED'> = ['CONFIRMED'];

export type KbListInput = z.infer<typeof kbListSchema>;
type Tier = 'CONFIRMED' | 'INFERRED' | 'UNVERIFIED';

/** The legacy single-tier string form is the one-element list. */
function normaliseConfidence(confidence: KbListInput['confidence']): Tier[] | undefined {
  if (confidence === undefined) return undefined;
  return typeof confidence === 'string' ? [confidence] : confidence;
}

export async function kbList(input: KbListInput, anchor?: KbAnchor): Promise<string> {
  const confidence = normaliseConfidence(input.confidence);
  // MEMBER session -> the checkout bible view (kb-self.ts getSelfReadKb).
  // An explicit INFERRED/UNVERIFIED request goes to the per-repo DB, own
  // captures only (ownerTag).
  const { providers, ownerTag } = await getSelfReadKb(anchor, confidence);
  const sqliteProvider = requireSqliteProject(providers.project, 'kb_list');

  const entries = await sqliteProvider.list({
    confidence: confidence?.length ? confidence : DEFAULT_CONFIDENCE,
    // Default read is CONFIRMED *and* undisputed; an explicit tier list opts out.
    exclude_disputed: !confidence?.length,
    type: input.type,
    module: input.module,
    symbol: input.symbol,
    tag: input.tag,
    owner_tag: ownerTag,
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
