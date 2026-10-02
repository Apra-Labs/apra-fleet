import { z } from 'zod';
import { getSelfKbProviders, memberOwnerTag, type KbAnchor } from '../services/knowledge/kb-self.js';
import { KbMemberViewError } from '../services/knowledge/member-bible-view.js';
import { requireSqliteProject } from '../services/knowledge/require-sqlite-project.js';
import type { Author } from '../services/knowledge/types.js';

// D5 (T2.3) pattern, DUPLICATED here rather than imported: src/tools/kb-capture.ts
// is touched ONLY by T1.1 per PLAN.md's shared-file sequencing, so this tool
// validates its own role hint against the same Author enum instead of
// exporting a shared helper out of a file this task must not modify.
const AUTHOR_VALUES: readonly Author[] = ['doer', 'reviewer', 'planner', 'plan-reviewer', 'kb-agent', 'kb-reconciler', 'harvest', 'pm', 'user'];

function validateAuthor(role: string | undefined): Author | 'unknown' {
  if (role && (AUTHOR_VALUES as readonly string[]).includes(role)) {
    return role as Author;
  }
  return 'unknown';
}

export const kbFeedbackSchema = z.object({
  id: z.string().min(1).describe('ID of the KB entry the feedback applies to'),
  reason: z.string().min(1).describe('What was wrong in practice -- appended to the entry content as an ASCII feedback note'),
  role: z.string().optional()
    .describe('Role hint for provenance: doer/reviewer/planner/plan-reviewer/kb-agent/harvest/pm/user. Validated server-side against the Author enum; invalid or absent stamps "unknown" in the note.'),
});

export type KbFeedbackInput = z.infer<typeof kbFeedbackSchema>;

// D7 (F8): downvote a KB entry that proved wrong in practice. Marks stale=1 +
// flagged_for_review=1 and appends an ASCII feedback note "[feedback <ISO>]
// <validated-role>: <reason>" (CONTENT_CAP respected, enforced inside
// SqliteProvider.feedback()). NEVER deletes and NEVER touches confidence -- a
// downvoted CONFIRMED entry stays CONFIRMED-but-stale-flagged; the human
// resolves it in kb-review. EXCEPTION: an ACTIVE user-directive is flagged for
// review only (never staled) because directives outrank agent experience and
// the human decides -- see SqliteProvider.feedback() for the exact guard.
export async function kbFeedback(input: KbFeedbackInput, anchor?: KbAnchor): Promise<string> {
  // A MEMBER session reads its checkout bible view, which is read-only: a
  // typed no-op that touches no store (checked before any provider is opened).
  if (memberOwnerTag(anchor) !== undefined) {
    throw new KbMemberViewError(
      'E-MEMBER-VIEW-READ-ONLY',
      '',
      `kb_feedback is not available in a member session: member KB reads come from the checkout bible, which is read-only; entry '${input.id}' was not changed.`,
      'Run kb_feedback from a FULL session (no member identity), or flag the entry for review through the maintainer.',
    );
  }
  const providers = await getSelfKbProviders(anchor);
  const sqliteProvider = requireSqliteProject(providers.project, 'kb_feedback');
  const author = validateAuthor(input.role);
  const entry = await sqliteProvider.feedback(input.id, input.reason, author);
  return JSON.stringify({
    id: entry.id,
    stale: entry.stale,
    flagged_for_review: entry.flagged_for_review,
    confidence: entry.confidence,
  });
}
