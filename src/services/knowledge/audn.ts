import type { KBEntry, KBEntryInput, AudnDecision } from './types.js';

export const CONTRADICTION_KEYWORDS = ['was wrong', 'actually', 'correction', 'not true', 'incorrect', 'no longer', 'is fixed', 'now works'];

export function hasContradictionKeywords(content: string): boolean {
  const lower = content.toLowerCase();
  return CONTRADICTION_KEYWORDS.some(kw => lower.includes(kw));
}

// Conservative opposite-polarity antonym pairs. A contradiction is signalled
// when one side of a symbol-overlapping pair reads as negative-polarity (broken/
// absent/failing) and the other reads as positive-polarity (works/fixed/exists).
// Kept deliberately narrow so ordinary refinements (which carry no polarity
// words) are NOT flagged. Phrases avoid substring collisions between the lists.
const POLARITY_NEGATIVE = [
  'does not exist', "doesn't exist", 'does not work', "doesn't work",
  'is broken', 'broken', 'no longer works', 'not working', 'is missing',
];
const POLARITY_POSITIVE = [
  'now works', 'works now', 'is fixed', 'fixed', 'now exists',
  'is available', 'resolved',
];

// F3 (D3, T1.5, KB 4cdf2a5d): word-boundary matching, not substring. The
// former String.includes() check matched these phrases as bare substrings,
// so words that merely CONTAIN a polarity phrase (e.g. "prefixed"/
// "suffixed" contain "fixed"; "unresolved" contains "resolved") falsely
// carried that phrase's polarity though they have nothing to do with
// fix/break semantics. \b is anchored at the very start and end of each
// (possibly multi-word, possibly apostrophe-containing) phrase rather than
// per inner word, so "doesn't work" / "does not exist" style phrases still
// match correctly -- the apostrophe sits inside the phrase, not at a
// boundary we depend on. Case-insensitivity is now carried by the regex 'i'
// flag rather than a pre-lowercase pass (equivalent behavior).
function escapeRegExpLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toWordBoundaryPattern(phrase: string): RegExp {
  return new RegExp('\\b' + escapeRegExpLiteral(phrase) + '\\b', 'i');
}

const NEGATIVE_PATTERNS = POLARITY_NEGATIVE.map(toWordBoundaryPattern);
const POSITIVE_PATTERNS = POLARITY_POSITIVE.map(toWordBoundaryPattern);

/**
 * Light opposite-polarity check between two texts: true when one carries
 * negative polarity and the other positive polarity. Pure and case-insensitive.
 */
export function hasOppositePolarity(a: string, b: string): boolean {
  const aNeg = NEGATIVE_PATTERNS.some(p => p.test(a));
  const aPos = POSITIVE_PATTERNS.some(p => p.test(a));
  const bNeg = NEGATIVE_PATTERNS.some(p => p.test(b));
  const bPos = POSITIVE_PATTERNS.some(p => p.test(b));
  return (aNeg && bPos) || (aPos && bNeg);
}

export function symbolsOverlap(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  return a.some(s => b.includes(s));
}

export function filesOverlap(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  return a.some(f => b.includes(f));
}

// Turn a single search term into an FTS5-safe query fragment, or null when
// nothing usable remains. Each alphanumeric/underscore token is wrapped as a
// quoted phrase so FTS-hostile characters (quotes, parens, colons, hyphens,
// slashes, dots) and reserved operators (AND/OR/NOT/NEAR) cannot break the
// query. Tokens WITHIN one term stay space-joined (AND semantics within a
// single term, e.g. a multi-word symbol); orJoinFtsTerms OR-joins ACROSS
// terms. Shared by every FTS query-building site: findAudnCandidates (via
// makeFtsQuery), prime (via QueryOptions.fts_terms), and query() itself
// (free text). query() previously passed the caller's raw string to MATCH,
// which threw on '.', '-', '(', ')', '/' -- 61% of real agent queries.
export function ftsSafeTerm(term: string): string | null {
  const tokens = term.match(/[A-Za-z0-9_]+/g);
  if (!tokens || tokens.length === 0) return null;
  return tokens.map(t => `"${t}"`).join(' ');
}

// Shared OR-join helper (D4, closes yashr-5n2, yashr-17i): sanitizes each term
// via ftsSafeTerm and joins the results with ' OR ' so FTS5 MATCH surfaces
// entries containing ANY term rather than requiring ALL terms (the previous
// implicit-AND behavior of a plain join(' ')). A term that sanitizes to
// nothing (e.g. all punctuation) is dropped rather than breaking the whole
// query. Ranking (bm25/ORDER BY rank) is unaffected -- more relevant entries
// still surface first even under OR semantics. Single-term callers get
// unchanged behavior (no ' OR ' to join).
export function orJoinFtsTerms(terms: string[]): string {
  return terms
    .map(ftsSafeTerm)
    .filter((t): t is string => t !== null)
    .join(' OR ');
}

// D4 (T2.1): CHANGED to OR-join. makeFtsQuery feeds findAudnCandidates, which
// in turn feeds makeAudnDecision's contradiction path -- an AND-join here
// made cross-type contradiction discovery unreachable end-to-end (a "code_graph
// now works" title would need the OLD "broken" entry to also contain every
// token of the new title). OR-joining the title's tokens makes the old entry
// a candidate whenever it shares ANY token, e.g. "code_graph".
export function makeFtsQuery(title: string): string {
  const tokens = title.match(/\b[a-zA-Z0-9_]{3,}\b/g) ?? [];
  return orJoinFtsTerms(tokens);
}

export interface AudnResult {
  decision: AudnDecision;
  matchedId: string;
  shouldFlagExisting?: boolean;
  shouldSupersede?: boolean;
  newEntryOverrides?: Partial<KBEntryInput>;
}

/**
 * Pure AUDN decision logic: given a list of FTS-matched candidates and the
 * incoming entry input, returns the AUDN decision or null if no match.
 *
 * Two distinct gates (D2):
 * - CONTRADICTION (flagged): symbol overlap AND a contradiction signal is
 *   sufficient -- file overlap is NOT required and the candidate may be a
 *   DIFFERENT entry type. This catches corrections across files/types (e.g. a
 *   "code_graph is broken" knowledge entry contradicted by a later "code_graph
 *   now works" entry that touches a different file). A contradiction signal is
 *   an explicit CONTRADICTION_KEYWORDS hit OR opposite-polarity content/title.
 * - DEDUP ('none') / UPDATE: same-topic refinement of an existing entry. These
 *   remain SAME-TYPE only and still require symbol AND file overlap. Because
 *   findAudnCandidates no longer filters by type (HALF B), the type gate is
 *   re-imposed here so only the contradiction path is cross-type.
 */
export function makeAudnDecision(
  input: KBEntryInput,
  candidates: KBEntry[],
  newContent: string
): AudnResult | null {
  for (const candidate of candidates) {
    const symMatch = symbolsOverlap(input.symbols ?? [], candidate.symbols);
    if (!symMatch) continue;

    // CONTRADICTION path: symbol overlap + a contradiction signal, regardless of
    // file overlap and regardless of type (cross-type discovery via HALF B).
    const inputText = newContent + ' ' + (input.title ?? '');
    const candidateText = candidate.content + ' ' + (candidate.title ?? '');
    const contradictionSignal =
      hasContradictionKeywords(newContent) ||
      hasOppositePolarity(inputText, candidateText);
    if (contradictionSignal) {
      return {
        decision: 'flagged',
        matchedId: candidate.id,
        shouldFlagExisting: true,
        newEntryOverrides: {
          confidence: 'UNVERIFIED',
          contradiction_of: candidate.id,
          flagged_for_review: false,
        },
      };
    }

    // F1 (D1, closes yashr-9ha) ACTIVE-directive supersede guard (kept here in
    // the pure decision function so it is directly unit-testable): an ACTIVE
    // directive (type='user-directive' AND confidence='CONFIRMED') can NEVER be
    // superseded or updated by ANY capture() path. Every MCP directive capture
    // is now a PROPOSAL (UNVERIFIED, per SqliteProvider.capture()), so the old
    // both-directives-supersede rule would let an agent proposal replace an
    // active directive -- re-opening the forge-a-directive attack. Superseding an
    // active directive is a human act (approve-new + reject-old via the CLI).
    // When the candidate is an active directive the update/supersede path is
    // FORBIDDEN: we `continue`, so this candidate degrades to 'flagged' if a
    // contradiction signal was present (handled above) or the new entry falls
    // through to 'add'. Evaluated before the general same-type gate so the
    // directive rule is the explicit reason. A non-active (pending/rejected)
    // directive candidate is not protected here -- proposal-vs-proposal dedup
    // follows the normal same-type path below.
    if (candidate.type === 'user-directive' && candidate.confidence === 'CONFIRMED') continue;

    // DEDUP / UPDATE path: same-type refinements only, symbol AND file overlap.
    if (candidate.type !== input.type) continue;
    const fileMatch = filesOverlap(input.source_files ?? [], candidate.source_files);
    if (!fileMatch) continue;

    if (newContent === candidate.content) {
      return { decision: 'none', matchedId: candidate.id };
    }

    return {
      decision: 'update',
      matchedId: candidate.id,
      shouldSupersede: true,
    };
  }

  return null;
}
