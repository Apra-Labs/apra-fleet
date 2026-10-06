import { z } from 'zod';
import { KB_REMOVED_SCOPE_KEYS_SHAPE } from '../services/knowledge/kb-removed-scope-keys.js';
import { getSelfKbProviders, memberOwnerTag, type KbAnchor } from '../services/knowledge/kb-self.js';
import { requireSqliteProject } from '../services/knowledge/require-sqlite-project.js';

export const kbDemoteSchema = z.object({
  id: z.string().min(1).describe('ID of the KB entry to demote'),
  reason: z.string().min(1)
    .describe('Why trust is being withdrawn -- at least 20 characters after newlines are collapsed to spaces and the result trimmed. Appended to the entry content as the audit trail; a reason made only of whitespace or newlines is refused.'),
  evidence_files: z.array(z.string()).optional()
    .describe('Optional repo-relative files backing the demotion. Each must resolve to a real file inside the calling session\'s repo; a path that does not resolve, names a directory, or contains a ".." segment is refused with E-DEMOTE-EVIDENCE-UNRESOLVED and nothing is written.'),
  // Removed pre-redesign scope keys: declared only so a caller still passing one
  // is refused with E-SCOPE-KEY-REMOVED instead of silently re-scoped.
  ...KB_REMOVED_SCOPE_KEYS_SHAPE,
});

export type KbDemoteInput = z.infer<typeof kbDemoteSchema>;

// The inverse of kb_promote: lower a CONFIRMED entry back to INFERRED when it
// turned out to be LESS CERTAIN than its CONFIRMED grade claims -- not when it
// turned out to be WRONG (that is kb_feedback / kb_resolve_contradiction).
//
// Mirrors kb-promote.ts exactly on scoping: in a MEMBER session only the
// caller's own captures (member:<uuid>) are reachable, and any other id is the
// same not-found an unknown id gets, so an entry's existence is never
// disclosed. The provider enforces that; this layer only supplies the tag.
export async function kbDemote(input: KbDemoteInput, anchor?: KbAnchor): Promise<string> {
  const providers = await getSelfKbProviders(anchor);

  const ownerTag = memberOwnerTag(anchor);
  const result = ownerTag !== undefined
    ? await requireSqliteProject(providers.project, 'kb_demote').demote(input.id, input.reason, input.evidence_files, { ownerTag })
    : await providers.project.demote(input.id, input.reason, input.evidence_files);
  return JSON.stringify({
    id: result.id,
    previous_confidence: result.confidence_before,
    new_confidence: result.confidence_after,
  });
}
