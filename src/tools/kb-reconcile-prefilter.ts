import { z } from 'zod';
import { getKbProviders } from '../services/knowledge/kb-providers.js';

// T3.1 (F5 step 3, D4 HARDENED, resolution R1): kb_reconcile_prefilter --
// mechanical resolution rung of the /pm kb-reconcile flow, run AFTER
// kb_import + kb_freshness_sweep and BEFORE the reconciler agent. For every
// flagged contradiction pair (SqliteProvider.flaggedPairs(), which includes
// stale members by design), re-hashes both sides' full source-file bases
// against the CURRENT worktree: exactly one side fully matching wins
// mechanically via resolveContradiction (evidence "hash-basis match on merged
// worktree", the SAME single write path kb_resolve_contradiction exposes to
// the reconciler agent). Both match, both mismatch, or either side has an
// empty/missing basis -> left untouched for the agent rung. Pairs involving
// an ACTIVE user-directive are never touched (no resolve, no supersede, no
// flag-clear) -- directives outrank mechanics.
export const kbReconcilePrefilterSchema = z.object({});

export type KbReconcilePrefilterInput = z.infer<typeof kbReconcilePrefilterSchema>;

export async function kbReconcilePrefilter(_input: KbReconcilePrefilterInput): Promise<string> {
  const providers = await getKbProviders();
  const result = await providers.project.reconcilePrefilter();
  return JSON.stringify(result);
}
