import { z } from 'zod';
import { KB_REMOVED_SCOPE_KEYS_SHAPE } from '../services/knowledge/kb-removed-scope-keys.js';
import { getSelfKbProviders, memberOwnerTag, type KbAnchor } from '../services/knowledge/kb-self.js';
import { requireSqliteProject } from '../services/knowledge/require-sqlite-project.js';

export const kbPromoteSchema = z.object({
  id: z.string().min(1).describe('ID of the KB entry to promote'),
  reason: z.string().optional().describe('Reason for promotion (appended to content as evidence trail)'),
  // Removed pre-redesign scope keys: declared only so a caller still passing one
  // is refused with E-SCOPE-KEY-REMOVED instead of silently re-scoped.
  ...KB_REMOVED_SCOPE_KEYS_SHAPE,
});

export type KbPromoteInput = z.infer<typeof kbPromoteSchema>;

export async function kbPromote(input: KbPromoteInput, anchor?: KbAnchor): Promise<string> {
  const providers = await getSelfKbProviders(anchor);

  // MEMBER session: only the caller's own captures (member:<uuid>) can be
  // promoted; any other id is the same not-found as an unknown id.
  const ownerTag = memberOwnerTag(anchor);
  const result = ownerTag !== undefined
    ? await requireSqliteProject(providers.project, 'kb_promote').promote(input.id, input.reason, { ownerTag })
    : await providers.project.promote(input.id, input.reason);
  return JSON.stringify({
    id: result.id,
    previous_confidence: result.confidence_before,
    new_confidence: result.confidence_after,
  });
}
