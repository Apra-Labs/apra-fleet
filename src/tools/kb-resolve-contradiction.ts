import { z } from 'zod';
import { getKbProviders } from '../services/knowledge/kb-providers.js';

// T3.1 (F5 step 3, D4 HARDENED, resolution R7): kb_resolve_contradiction --
// thin wrapper over SqliteProvider.resolveContradiction(), the SINGLE write
// path for ALL reconcile resolutions. Both kb_reconcile_prefilter's
// mechanical hash-basis wins AND the T3.2 reconciler agent's code-decided
// wins call through this same tool/method -- never composed from
// kb_promote + kb_feedback, which cannot produce the required end state
// (promote()'s one-step ladder cannot lift an UNVERIFIED contradiction-born
// entry straight to CONFIRMED, and neither promote() nor feedback() clears
// flagged_for_review/contradiction_of).
//
// REFUSAL (R7, re-review MEDIUM-1): the tool refuses -- writing NOTHING --
// when either id is missing, when either entry is already superseded, when
// the two ids do NOT form a genuine linked contradiction pair (loser.
// contradiction_of === winnerId OR winner.contradiction_of === loserId), or
// when the pair involves an ACTIVE user-directive (type='user-directive' AND
// confidence='CONFIRMED') on either side -- directives outrank mechanics and
// stay flagged for a human via /pm kb-review. Refusal surfaces as a thrown
// error (propagated to the caller), consistent with this codebase's other
// refusal-on-invalid-state methods (kb_promote's directive refusal, kb_feedback's
// missing-entry error).
export const kbResolveContradictionSchema = z.object({
  winnerId: z.string().min(1).describe('ID of the KB entry the merged code (or trust tier) supports. Ends confidence=CONFIRMED with flags cleared; stale is cleared only if the D2 un-stale predicate holds post-flag-clear.'),
  loserId: z.string().min(1).describe('ID of the KB entry the merged code contradicts. Ends superseded_at=now, stale=1, flagged_for_review cleared. Never deleted.'),
  evidence: z.string().min(1).describe('Evidence note appended to the winner content, e.g. a file+symbol citation or the trust-tier rule applied. Verbatim "hash-basis match on merged worktree" when called by kb_reconcile_prefilter.'),
});

export type KbResolveContradictionInput = z.infer<typeof kbResolveContradictionSchema>;

export async function kbResolveContradiction(input: KbResolveContradictionInput): Promise<string> {
  const providers = await getKbProviders();
  const result = await providers.project.resolveContradiction(input.winnerId, input.loserId, input.evidence);
  return JSON.stringify(result);
}
