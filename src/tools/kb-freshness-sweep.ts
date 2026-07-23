import { z } from 'zod';
import { getKbProviders } from '../services/knowledge/kb-providers.js';

// T1.3 (F2/D2 HARDENED, resolution R2): kb_freshness_sweep -- a bounded,
// full-KB BIDIRECTIONAL freshness sweep. Re-hashes the stored per-file basis of
// every entry that has one against the CURRENT worktree: a basis mismatch marks
// a fresh entry stale=1; a full basis match revives a stale entry that passes
// the D2 un-stale predicate (superseded, feedback-downvoted, and invalidated
// entries stay retired). This is the revival surface that kb_session_prime
// cannot be -- prime's candidate set excludes stale entries, so branch-switch
// revival requires a sweep, not just a prime. Invoked standalone by the PM
// reconcile flow and internally by kb_import.
export const kbFreshnessSweepSchema = z.object({});

export type KbFreshnessSweepInput = z.infer<typeof kbFreshnessSweepSchema>;

export async function kbFreshnessSweep(_input: KbFreshnessSweepInput): Promise<string> {
  const providers = await getKbProviders();
  const result = await providers.project.freshnessSweep();
  return JSON.stringify(result);
}
