import type { KBEntry, KBEntryInput, AudnDecision } from './types.js';

export const CONTRADICTION_KEYWORDS = ['was wrong', 'actually', 'correction', 'not true', 'incorrect'];

export function hasContradictionKeywords(content: string): boolean {
  const lower = content.toLowerCase();
  return CONTRADICTION_KEYWORDS.some(kw => lower.includes(kw));
}

export function symbolsOverlap(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  return a.some(s => b.includes(s));
}

export function filesOverlap(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  return a.some(f => b.includes(f));
}

export function makeFtsQuery(title: string): string {
  const tokens = title.match(/\b[a-zA-Z0-9_]{3,}\b/g) ?? [];
  return tokens.join(' ');
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
 * AND-logic: symbol overlap AND file overlap are both required for a merge
 * decision. A single-field match is insufficient.
 */
export function makeAudnDecision(
  input: KBEntryInput,
  candidates: KBEntry[],
  newContent: string
): AudnResult | null {
  for (const candidate of candidates) {
    const symMatch = symbolsOverlap(input.symbols ?? [], candidate.symbols);
    const fileMatch = filesOverlap(input.source_files ?? [], candidate.source_files);

    // AND-logic: title similarity (via FTS) + symbol overlap + file overlap
    if (!symMatch || !fileMatch) continue;

    if (hasContradictionKeywords(input.content)) {
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
