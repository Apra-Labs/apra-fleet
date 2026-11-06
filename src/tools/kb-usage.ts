import { z } from 'zod';
import { KB_REMOVED_SCOPE_KEYS_SHAPE } from '../services/knowledge/kb-removed-scope-keys.js';
import { getSelfKbProviders, type KbAnchor } from '../services/knowledge/kb-self.js';
import { isSqliteProject } from '../services/knowledge/require-sqlite-project.js';

// kb_usage: the engine's write half of the cited-based hit rate (kb_stats.usage).
//
// Why a NEW tool rather than an optional input on an existing one: the only
// write-shaped candidate, kb_feedback, requires {id, reason}, marks the entry
// stale + flagged (a trust-mutating downvote) and refuses every member session;
// usage reporting is a batch, append-only telemetry write the engine makes
// through its own member session. Folding it into kb_feedback would have meant
// relaxing that tool's required inputs and giving one tool two unrelated
// side-effect classes. kb_usage is served to a member session only with the
// engine's kb_maintainer grant (member-tool-allowlist.ts), so agent sessions
// cannot inflate the numbers.
export const KB_USAGE_MAX_IDS = 1000;

export const kbUsageSchema = z.object({
  pushed: z.array(z.string().min(1)).max(KB_USAGE_MAX_IDS).optional()
    .describe('Ids of KB entries the engine delivered to a dispatch (the pushed KNOWLEDGE BANK block). Each is recorded as one returned event; duplicates in the list count once.'),
  cited: z.array(z.string().min(1)).max(KB_USAGE_MAX_IDS).optional()
    .describe('Ids of KB entries a role reported it actually used (kb_used). Each is recorded as one cited event; duplicates in the list count once.'),
  // Removed pre-redesign scope keys: declared only so a caller still passing one
  // is refused with E-SCOPE-KEY-REMOVED instead of silently re-scoped.
  ...KB_REMOVED_SCOPE_KEYS_SHAPE,
});

export type KbUsageInput = z.infer<typeof kbUsageSchema>;

export async function kbUsage(input: KbUsageInput, anchor?: KbAnchor): Promise<string> {
  // Always the per-repo DB (never a member's read-only bible view): the
  // events must land where kb_stats and fleet_status read them.
  const providers = await getSelfKbProviders(anchor);
  const project = providers.project;
  if (!isSqliteProject(project)) {
    return JSON.stringify({
      supported: false,
      reason: 'kb_usage is not supported over the remote HTTP KB provider',
      recorded: { returned: 0, cited: 0 },
    });
  }
  const recorded = project.recordUsage({ pushed: input.pushed, cited: input.cited });
  return JSON.stringify({ recorded });
}
