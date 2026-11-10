// Hybrid KB ranking (design D2b): reciprocal rank fusion of the keyword,
// error-signature, semantic and anchor lists, then trust priors.
//
// Pure functions only -- SqliteProvider.query builds the lists (SQL, vector
// scoring, code links) and hands them here, so the fusion maths is testable
// without a database.
//
// RRF: an entry's fused score is the sum over the lists that contain it of
// 1 / (k + rank). Ranks start at 1. Tied entries in one list share a rank
// (competition ranking: 1, 1, 3), so an anchor list where several entries
// touch the same file adds the same amount to each of them.
//
// Trust priors multiply the fused score: CONFIRMED entries get a boost large
// enough to lift them over a non-CONFIRMED entry ranked one or two places
// higher, the existing use counter (use_count, bumped on every retrieval) adds
// a small capped log boost, and a stale entry (only visible with
// include_stale) is pushed down.

export const RRF_K = 60;

/** Names of the ranked lists the hybrid search fuses. */
export type HybridListName = 'keyword' | 'error' | 'semantic' | 'anchor';

export interface RankedList {
  name: HybridListName;
  /** entry id -> rank (1 = best). */
  ranks: Map<string, number>;
}

/** Rank map from ids already in best-first order (distinct ranks). */
export function ranksFromOrder(ids: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const id of ids) if (!out.has(id)) out.set(id, out.size + 1);
  return out;
}

/**
 * Rank map from per-id scores, higher is better; equal scores share a rank
 * (competition ranking).
 */
export function ranksFromScores(scores: Map<string, number>): Map<string, number> {
  const sorted = [...scores.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const out = new Map<string, number>();
  let prevScore: number | null = null;
  let prevRank = 0;
  sorted.forEach(([id, s], i) => {
    const rank = prevScore !== null && s === prevScore ? prevRank : i + 1;
    out.set(id, rank);
    prevScore = s;
    prevRank = rank;
  });
  return out;
}

/** Sum of 1/(k+rank) over every list that holds the id. */
export function reciprocalRankFusion(lists: RankedList[], k = RRF_K): Map<string, number> {
  const fused = new Map<string, number>();
  for (const list of lists) {
    for (const [id, rank] of list.ranks) fused.set(id, (fused.get(id) ?? 0) + 1 / (k + rank));
  }
  return fused;
}

export interface PriorInput {
  confidence?: string;
  use_count?: number;
  stale?: boolean;
}

export const CONFIRMED_PRIOR = 1.15;
export const STALE_PRIOR = 0.7;
/** Max multiplicative lift from use_count (reached at use_count ~ 1000). */
export const USE_PRIOR_MAX = 0.05;

/** Multiplicative trust prior of one entry. */
export function trustPrior(e: PriorInput): number {
  let p = 1;
  if (e.confidence === 'CONFIRMED') p *= CONFIRMED_PRIOR;
  const uses = Math.max(0, Number(e.use_count ?? 0));
  if (uses > 0) p *= 1 + USE_PRIOR_MAX * Math.min(1, Math.log10(1 + uses) / 3);
  if (e.stale) p *= STALE_PRIOR;
  return p;
}

/**
 * Final hybrid order: fused score times trust prior, best first. Ties keep
 * the order of `fallbackOrder` (ids first seen earlier win), then id.
 */
export function hybridOrder(
  fused: Map<string, number>,
  priorOf: (id: string) => number,
  fallbackOrder: string[] = [],
): string[] {
  const seen = new Map<string, number>();
  fallbackOrder.forEach((id, i) => { if (!seen.has(id)) seen.set(id, i); });
  const score = new Map<string, number>();
  for (const [id, s] of fused) score.set(id, s * priorOf(id));
  return [...score.keys()].sort((a, b) =>
    score.get(b)! - score.get(a)!
    || (seen.get(a) ?? Number.MAX_SAFE_INTEGER) - (seen.get(b) ?? Number.MAX_SAFE_INTEGER)
    || a.localeCompare(b));
}

// -- Relevance cutoff (kb_query relevant_only, the engine push path) ---------
//
// Without a cutoff a pushed block of 8 always fills to 8, and on the measured
// push-path set (24 real beads, the real bible, the default model) only about
// 2.3 of the 8 rows were relevant (docs/kb-recall-measurements.md,
// "Relevance cutoff on the push path"). The cutoff keeps a row only when its
// KEYWORD match is strong, both in absolute terms and against the best
// keyword match of the same query. Semantic similarity and file/symbol
// anchors still order the rows that are kept but never admit a row on their
// own: measured, neither separated relevant from irrelevant rows (similarity
// 0.55-0.75 for both with the default model). Being keyword-only, the cutoff
// does not depend on the model: with no model it keeps the same rows.

/** Minimum keyword relevance (see keywordRelevance) a kept row needs. */
export const RELEVANCE_MIN_KEYWORD_SCORE = 2.5;
/** A kept row's keyword score is at least this share of the query's best. */
export const RELEVANCE_TOP_RATIO = 0.5;
/** Rows the cutoff looks at before cutting back to the caller's limit. */
export const RELEVANCE_MIN_DEPTH = 30;

/**
 * Keyword relevance of a bm25 score (FTS5 bm25: negative, lower is better):
 * |score| / ln(docs), docs = rows in the keyword index. A term's idf grows
 * with ln(docs) for a term held by a fixed few entries, so the division keeps
 * the threshold meaning the same as the KB grows. 0 for an index of < 2 rows.
 */
export function keywordRelevance(score: number, docs: number): number {
  return docs >= 2 && Number.isFinite(score) ? -score / Math.log(docs) : 0;
}

/**
 * True when a row's keyword score clears the cutoff: keyword relevance of at
 * least RELEVANCE_MIN_KEYWORD_SCORE and at least RELEVANCE_TOP_RATIO of the
 * best score among the query's candidate rows. A row with no keyword score
 * (semantic or anchor only) never clears it.
 */
export function passesKeywordCutoff(score: number | undefined, best: number | undefined, docs: number): boolean {
  if (score === undefined || best === undefined || !(best < 0) || !(score < 0)) return false;
  return keywordRelevance(score, docs) >= RELEVANCE_MIN_KEYWORD_SCORE && score / best >= RELEVANCE_TOP_RATIO;
}

/** D2f additive rule: how many keyword-list head ids are guaranteed a place... */
export const KEYWORD_GUARD_KEEP = 5;
/** ...within this many leading positions of the final order (the pushed block size). */
export const KEYWORD_GUARD_WITHIN = 8;

/**
 * The guard window for a read returning `limit` rows: the keyword top
 * KEYWORD_GUARD_KEEP within the first min(KEYWORD_GUARD_WITHIN, limit). A
 * fixed window of 8 protected nothing a caller saw at a smaller limit: a
 * guarded id moved to position 7 or 8 was cut by the limit, so at the member
 * default limit 6, 112 of 182 eval queries lost a keyword top-5 hit (0 with
 * the window clamped). Measured trade (docs/kb-recall-measurements.md, limit
 * 6, default model): bare bible real MRR 0.8520 -> 0.8611 and real R@6
 * 0.9762 -> 1.0000, authored R@6 0.9424 -> 0.9281.
 */
export function keywordGuardFor(limit: number): { keep: number; within: number } {
  const within = Number.isFinite(limit) && limit > 0 ? Math.min(KEYWORD_GUARD_WITHIN, Math.floor(limit)) : KEYWORD_GUARD_WITHIN;
  return { keep: KEYWORD_GUARD_KEEP, within };
}

/**
 * Keyword top-N guard (D2f additive rule). Every id in the first `keep`
 * entries of `keywordTop` that is present in `order` is guaranteed a position
 * within the first `within` of the result. A guarded id sitting below that is
 * moved to the lowest position inside the window held by a non-guarded id; the
 * ids from there down shift one place. All other relative order is preserved,
 * and when every guarded id is already inside the window the input order is
 * returned unchanged. Pure; does not mutate its inputs.
 */
export function guardKeywordTop(
  order: string[],
  keywordTop: string[],
  keep = KEYWORD_GUARD_KEEP,
  within = KEYWORD_GUARD_WITHIN,
): string[] {
  const present = new Set(order);
  const guarded = new Set(keywordTop.slice(0, keep).filter(id => present.has(id)));
  if (guarded.size === 0) return order;
  const win = Math.min(within, order.length);
  const outside = order.slice(win).filter(id => guarded.has(id));
  if (outside.length === 0) return order;
  // Evict the lowest-ranked non-guarded ids of the window, one per outside id.
  const evict = new Set<string>();
  for (let i = win - 1; i >= 0 && evict.size < outside.length; i--) {
    if (!guarded.has(order[i])) evict.add(order[i]);
  }
  if (evict.size === 0) return order;
  const moved = outside.slice(0, evict.size);
  const movedSet = new Set(moved);
  const head = order.slice(0, win).filter(id => !evict.has(id));
  const rest = order.slice(win).filter(id => !movedSet.has(id));
  const evicted = order.slice(0, win).filter(id => evict.has(id));
  return [...head, ...moved, ...evicted, ...rest];
}
