import { z } from 'zod';
import { KB_REMOVED_SCOPE_KEYS_SHAPE } from '../services/knowledge/kb-removed-scope-keys.js';
import { getSelfKbProviders, memberOwnerTag, type KbAnchor } from '../services/knowledge/kb-self.js';

export const kbPromoteSchema = z.object({
  id: z.string().min(1).describe('ID of the KB entry to promote'),
  reason: z.string().optional().describe('Reason for promotion: the evidence you checked (appended to content as evidence trail). Promoting an already-CONFIRMED entry is an explicit re-verification: when its stored basis no longer matches the cited files at HEAD, the basis is re-stamped at HEAD and the result reports rebased: true.'),
  // Removed pre-redesign scope keys: declared only so a caller still passing one
  // is refused with E-SCOPE-KEY-REMOVED instead of silently re-scoped.
  ...KB_REMOVED_SCOPE_KEYS_SHAPE,
});

export type KbPromoteInput = z.infer<typeof kbPromoteSchema>;

export async function kbPromote(input: KbPromoteInput, anchor?: KbAnchor): Promise<string> {
  const providers = await getSelfKbProviders(anchor);

  // MEMBER session over SQLite: only the caller's own captures (member:<uuid>)
  // can be promoted; any other id is the same not-found as an unknown id.
  // Over http fleet does NOT tag-check: the promote is sent by id and the KB
  // server enforces which ids the caller may promote (its project scope and
  // any per-caller scope it keeps), refusing the rest itself.
  const ownerTag = memberOwnerTag(anchor);
  const result = ownerTag !== undefined
    ? await providers.project.promote(input.id, input.reason, { ownerTag })
    : await providers.project.promote(input.id, input.reason);
  // Basis fields (see PromoteResult): the promote stamps the basis from the
  // cited files at HEAD; an already-CONFIRMED entry whose basis drifted is
  // re-stamped (rebased). Optional keys are emitted only when the provider set
  // them, so the three confidence keys stay the stable core of the reply.
  return JSON.stringify({
    id: result.id,
    previous_confidence: result.confidence_before,
    new_confidence: result.confidence_after,
    ...(result.basis_stamped !== undefined ? { basis_stamped: result.basis_stamped } : {}),
    ...(result.rebased !== undefined ? { rebased: result.rebased } : {}),
    ...(result.previous_basis_files_changed !== undefined ? { previous_basis_files_changed: result.previous_basis_files_changed } : {}),
    ...(result.unstamped_files !== undefined ? { unstamped_files: result.unstamped_files } : {}),
    ...(result.basis_stamp_unsupported !== undefined ? { basis_stamp_unsupported: result.basis_stamp_unsupported } : {}),
  });
}
