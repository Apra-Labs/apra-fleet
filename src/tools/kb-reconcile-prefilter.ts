import { z } from 'zod';
import { KB_REMOVED_SCOPE_KEYS_SHAPE } from '../services/knowledge/kb-removed-scope-keys.js';
import { getSelfKbProviders, type KbAnchor } from '../services/knowledge/kb-self.js';
import { requireSqliteProject } from '../services/knowledge/require-sqlite-project.js';

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
export const kbReconcilePrefilterSchema = z.object({
  // Removed pre-redesign scope keys: declared only so a caller still passing one
  // is refused with E-SCOPE-KEY-REMOVED instead of silently re-scoped.
  ...KB_REMOVED_SCOPE_KEYS_SHAPE,
});

export type KbReconcilePrefilterInput = z.infer<typeof kbReconcilePrefilterSchema>;

export async function kbReconcilePrefilter(input: KbReconcilePrefilterInput, anchor?: KbAnchor): Promise<string> {
  const providers = await getSelfKbProviders(anchor);
  const sqliteProvider = requireSqliteProject(providers.project, 'kb_reconcile_prefilter');
  const result = await sqliteProvider.reconcilePrefilter();
  return JSON.stringify(result);
}
