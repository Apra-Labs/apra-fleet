import { z } from 'zod';
import { KB_REMOVED_SCOPE_KEYS_SHAPE } from '../services/knowledge/kb-removed-scope-keys.js';
import {
  getSelfReadKb, getMemberSplitRead, mergeSplitById, type KbAnchor, type MemberSplitRead,
} from '../services/knowledge/kb-self.js';
import type { MemoryProvider } from '../services/knowledge/types.js';

const L2_CONTENT_CAP = 3200;

export const kbQuerySchema = z.object({
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
  // Retrieval-trust filters. Opt-in and default-off (absent = every tier, disputed
  // entries included -- the pre-existing behaviour). An allow-list rather than a
  // min_confidence threshold so the contract does not bake in a tier ordering and
  // matches kb_list's `confidence` naming.
  confidence: z.array(z.enum(['CONFIRMED', 'INFERRED', 'UNVERIFIED'])).min(1).optional()
    .describe('Only return entries whose confidence tier is in this list (e.g. ["CONFIRMED"]). Applies to l1_results, l2_expanded and related_claims alike. Default when omitted: ["CONFIRMED"] -- INFERRED and UNVERIFIED entries are returned only when listed explicitly. Ignored when flagged_only is true.'),
  exclude_disputed: z.boolean().optional()
    .describe('Drop entries on either side of an unresolved contradiction (flagged_for_review, or contradiction_of set). Applies to l1_results, l2_expanded and related_claims alike. Default true when confidence is omitted (CONFIRMED-undisputed default); default false when confidence is given explicitly. Ignored when flagged_only is true.'),
  // Removed pre-redesign scope keys: declared only so a caller still passing one
  // is refused with E-SCOPE-KEY-REMOVED instead of silently re-scoped.
  ...KB_REMOVED_SCOPE_KEYS_SHAPE,
});

export type KbQueryInput = z.infer<typeof kbQuerySchema>;

// Re-applies the trust filters to entries a provider returned. The sqlite
// provider already filters in SQL; this is the backstop for a provider that
// does not (a remote KB server predating the filter ignores unknown params),
// so the filter is a guarantee of this tool, not of whichever store answered.
function passesTrustFilter(
  e: { confidence?: string; flagged_for_review?: boolean; contradiction_of?: string | null; tags?: string[] },
  input: KbQueryInput,
  ownerTag?: string,
): boolean {
  if (ownerTag !== undefined && !(e.tags ?? []).includes(ownerTag)) return false;
  if (input.confidence?.length && !input.confidence.includes(e.confidence as NonNullable<KbQueryInput['confidence']>[number])) return false;
  if (input.exclude_disputed && (e.flagged_for_review || e.contradiction_of)) return false;
  return true;
}

// The flagged_only predicate (the same condition SqliteProvider.query applies
// in SQL): either half of a contradiction pair.
function isFlagged(e: { flagged_for_review?: boolean; contradiction_of?: string | null }): boolean {
  return Boolean(e.flagged_for_review || e.contradiction_of);
}

type L1Opts = Parameters<MemoryProvider['query']>[0] & { limit: number };
type Entry = Awaited<ReturnType<MemoryProvider['query']>>['results'][number];

// One provider's L1 page with the trust filter re-applied (see passesTrustFilter).
async function trustedL1(provider: MemoryProvider, queryOpts: L1Opts, input: KbQueryInput, ownerTag?: string): Promise<Entry[]> {
  const first = await provider.query(queryOpts);
  const filtering = Boolean(input.confidence?.length || input.exclude_disputed || ownerTag);
  if (!filtering) return first.results;
  let kept = first.results.filter(e => passesTrustFilter(e, input, ownerTag));
  // A provider that ignored the filter may have spent its whole limit on
  // entries just dropped here. A full page that filtered short is the only
  // signal of that (the sqlite provider filters in SQL, so it never trips
  // this); re-ask once with a wider window and trim back to the limit.
  if (kept.length < queryOpts.limit && first.results.length >= queryOpts.limit) {
    const wider = await provider.query({ ...queryOpts, limit: queryOpts.limit * 4 });
    kept = wider.results.filter(e => passesTrustFilter(e, input, ownerTag));
  }
  return kept.slice(0, queryOpts.limit);
}

function capL2Content<T extends { content: string }>(e: T): T {
  return {
    ...e,
    content: e.content.length > L2_CONTENT_CAP
      ? e.content.slice(0, L2_CONTENT_CAP) + '...[truncated]'
      : e.content,
  };
}

// MEMBER mixed-tier query (kb-self.ts getMemberSplitRead). Each half is
// queried with only its own tiers and owner tag: the CONFIRMED half (bible
// view + global, untagged) exactly as a CONFIRMED-only member read, the own
// half (every requested tier, CONFIRMED included) from the per-repo DB +
// global with the member's owner tag.
//
// Ranking: provider ranks (FTS bm25) are not comparable across two databases,
// so the merged order is fixed: the bible half in its own rank order, then the
// own half in its rank order. The limit is applied per side AFTER that merge
// (project side = bible view + per-repo DB, global side = both global halves),
// mirroring the per-provider limit of the unsplit read, so the CONFIRMED-only
// result is always a prefix of each side and the mixed result a superset of it.
async function splitQuery(split: MemberSplitRead, raw: KbQueryInput): Promise<string> {
  const input: KbQueryInput = { ...raw, exclude_disputed: raw.exclude_disputed ?? false };
  const limit = input.limit ?? 20;
  const baseOpts = {
    query: input.query,
    type: input.type,
    tag: input.tag,
    limit,
    l1_only: true,
    include_stale: input.include_stale ?? false,
    include_superseded: input.include_stale ?? false,
    exclude_disputed: input.exclude_disputed,
  };
  const bibleInput: KbQueryInput = { ...input, confidence: split.bible.tiers };
  const ownInput: KbQueryInput = { ...input, confidence: split.own.tiers };
  const bibleOpts = { ...baseOpts, confidence: split.bible.tiers };
  const ownOpts = { ...baseOpts, confidence: split.own.tiers, owner_tag: split.own.ownerTag };
  const { ownerTag } = split.own;

  const viewL1 = await trustedL1(split.bible.project, bibleOpts, bibleInput);
  const repoL1 = await trustedL1(split.own.project, ownOpts, ownInput, ownerTag);
  const globalConfirmedL1 = await trustedL1(split.bible.global, bibleOpts, bibleInput);
  const globalOwnL1 = await trustedL1(split.own.global, ownOpts, ownInput, ownerTag);

  const projectL1 = mergeSplitById(viewL1, repoL1, { limit });
  const globalL1 = mergeSplitById(globalConfirmedL1, globalOwnL1, { limit });

  // Which store owns each id, so its L2 copy is fetched from that store.
  const viewIds = new Set(viewL1.map(e => e.id));
  const repoIds = new Set(repoL1.map(e => e.id));

  const seenTitles = new Set(projectL1.map(e => e.title));
  const mergedL1 = [...projectL1, ...globalL1.filter(e => !seenTitles.has(e.title))];

  const top5Ids = mergedL1.slice(0, 5).map(e => e.id);
  let l2Results: Entry[] = mergedL1.slice(0, 5);
  if (top5Ids.length > 0) {
    const fromView = top5Ids.filter(id => viewIds.has(id));
    const fromRepo = top5Ids.filter(id => !viewIds.has(id) && repoIds.has(id));
    const fromGlobal = top5Ids.filter(id => !viewIds.has(id) && !repoIds.has(id));
    const fetched = new Map<string, Entry>();
    if (fromView.length) for (const e of (await split.bible.project.query({ ids: fromView })).results) fetched.set(e.id, e);
    if (fromRepo.length) for (const e of (await split.own.project.query({ ids: fromRepo })).results) fetched.set(e.id, e);
    if (fromGlobal.length) for (const e of (await split.bible.global.query({ ids: fromGlobal })).results) fetched.set(e.id, e);
    l2Results = top5Ids.flatMap(id => (fetched.has(id) ? [capL2Content(fetched.get(id)!)] : []));
  }

  let relatedClaims: Entry[] = [];
  if (input.expand_related && top5Ids.length > 0) {
    try {
      const fromBible = (await split.bible.project.relatedClaims(top5Ids, undefined, {
        confidence: split.bible.tiers,
        exclude_disputed: input.exclude_disputed,
      })).filter(e => passesTrustFilter(e, bibleInput));
      // The per-repo half stays owner-tag filtered.
      const fromOwn = (await split.own.project.relatedClaims(top5Ids, undefined, {
        confidence: split.own.tiers,
        exclude_disputed: input.exclude_disputed,
        owner_tag: ownerTag,
      })).filter(e => passesTrustFilter(e, ownInput, ownerTag));
      relatedClaims = mergeSplitById(fromBible, fromOwn);
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

export async function kbQuery(input: KbQueryInput, anchor?: KbAnchor): Promise<string> {
  // Tag-only calls are valid (HIGH-1 fix): the provider's plain (non-FTS)
  // branch supports a queryless listing, so `kb_query({ tag })` lists all
  // entries carrying the tag -- the KB Agent curator's Step 2 depends on it.
  if (!input.query && !input.flagged_only && !input.tag) {
    throw new Error('Provide query (free-text search), tag (exact-match tag listing), or flagged_only: true (list contradictions)');
  }

  // A MEMBER request naming CONFIRMED plus another tier is split: CONFIRMED
  // from the checkout bible view, plus the per-repo DB at every requested
  // tier, own captures only (kb-self.ts getMemberSplitRead). flagged_only
  // never splits. Under an http project provider (serverRecall) the split
  // steps aside (returns null) and the server answers below.
  if (!input.flagged_only) {
    const split = await getMemberSplitRead(anchor, input.confidence, 'kb_query', { serverRecall: true });
    if (split) return splitQuery(split, input);
  }

  // A MEMBER session reads its checkout bible view unless it explicitly asks
  // for INFERRED/UNVERIFIED (kb-self.ts getSelfReadKb); flagged_only ignores
  // the confidence filter, so it is answered from the view too.
  // A request naming only INFERRED/UNVERIFIED in a MEMBER session goes to the
  // per-repo DB and sees only the caller's own captures (ownerTag).
  // Under an http project provider (serverRecall) a MEMBER read of any tier
  // goes to the server; ownerTag is enforced the same way, fleet-side.
  // A flagged_only read never takes serverRecall: a MEMBER flagged read is
  // answered from the checkout bible view (plus the global KB) under either
  // provider, exactly as over SQLite. The KB server holds every member's
  // captures at every tier, and a flagged listing carries no owner tag, so
  // sending it there would show the member other members' entries.
  const { providers, ownerTag } = await getSelfReadKb(
    anchor,
    input.flagged_only ? undefined : input.confidence,
    { serverRecall: !input.flagged_only },
  );

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

    // isFlagged re-applies the flagged filter to what a provider returned: the
    // sqlite provider filters in SQL, a remote KB server predating the
    // flagged_only parameter ignores it and answers with a plain listing.
    const projectFlagged = (await providers.project.query(flaggedOpts)).results.filter(isFlagged);
    const globalFlagged = (await providers.global.query(flaggedOpts)).results.filter(isFlagged);

    const seen = new Set(projectFlagged.map(e => e.id));
    const merged = [
      ...projectFlagged,
      ...globalFlagged.filter(e => !seen.has(e.id)),
    ];

    return JSON.stringify({
      flagged_entries: merged,
      total: merged.length,
      note: merged.length === 0
        ? 'No flagged contradictions found -- KB is clean.'
        : `${merged.length} flagged entries found. Contradiction pairs: one entry has flagged_for_review=true, its counterpart has contradiction_of set to the original ID -- resolve by calling kb_promote (keep), kb_capture (correct), or kb_invalidate (remove). EXCEPTION (F1/D1): a directive PROPOSAL (type=user-directive, tag directive:pending) is resolved ONLY by the human CLI (apra-fleet kb approve-directive <id> / reject-directive <id>) -- kb_promote refuses user-directive entries.`,
    });
  }

  // Default-trusted reads: with no confidence filter only CONFIRMED, undisputed
  // entries come back. An explicit confidence list opts into other tiers, and
  // then disputed entries are only dropped if exclude_disputed says so.
  input = {
    ...input,
    confidence: input.confidence?.length ? input.confidence : ['CONFIRMED'],
    exclude_disputed: input.exclude_disputed ?? !input.confidence?.length,
  };

  const queryOpts = {
    query: input.query,
    type: input.type,
    tag: input.tag,
    limit: input.limit ?? 20,
    l1_only: true,
    include_stale: input.include_stale ?? false,
    include_superseded: input.include_stale ?? false,
    confidence: input.confidence,
    exclude_disputed: input.exclude_disputed,
    owner_tag: ownerTag,
  };

  // The trust filter runs PER PROVIDER, before the title de-dup below: filtering
  // after the merge would let an excluded project entry shadow an admissible
  // global entry of the same title and then vanish, taking both with it.
  const projectL1 = await trustedL1(providers.project, queryOpts, input, ownerTag);
  const globalL1 = await trustedL1(providers.global, queryOpts, input, ownerTag);

  // Merge project first, deduplicate global entries by title
  const seen = new Set(projectL1.map(e => e.title));
  const mergedL1 = [
    ...projectL1,
    ...globalL1.filter(e => !seen.has(e.title)),
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
      relatedClaims = (await providers.project.relatedClaims(top5Ids, undefined, {
        confidence: input.confidence,
        exclude_disputed: input.exclude_disputed,
        owner_tag: ownerTag,
      })).filter(e => passesTrustFilter(e, input, ownerTag));
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
