import { z } from 'zod';
import { getKbProviders } from '../services/knowledge/kb-providers.js';
import { kbScopeFields } from '../services/knowledge/kb-scope-input.js';
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
  ...kbScopeFields,
  repo_path: z.string().optional()
    .describe('Path to the repo root this call is about. Selects WHICH project KB is read/written. Required when the call is handled by the fleet server (MCP) unless repo_remote_url is given: a call with neither is refused with reason repo_scope_required -- the server never resolves a project from its own working directory. Only the in-shell CLI falls back to the current directory.'),
});

export type KbReconcilePrefilterInput = z.infer<typeof kbReconcilePrefilterSchema>;

export async function kbReconcilePrefilter(input: KbReconcilePrefilterInput): Promise<string> {
  const providers = await getKbProviders(input.repo_path, input.repo_remote_url);
  const sqliteProvider = requireSqliteProject(providers.project, 'kb_reconcile_prefilter');
  const result = await sqliteProvider.reconcilePrefilter();
  return JSON.stringify(result);
}
