import { z } from 'zod';
import { computeFileHash } from '../services/knowledge/kb-service.js';
import { getKbProviders } from '../services/knowledge/kb-providers.js';
import { validateFilePaths } from '../services/knowledge/path-validation.js';
import type { Author, CaptureSource } from '../services/knowledge/types.js';

// D5 (T2.3): the full Author enum. Kept as a plain array (not a zod enum on
// the schema itself) so an invalid role hint degrades to 'unknown' at the
// handler rather than rejecting the whole capture call at the schema layer.
const AUTHOR_VALUES: readonly Author[] = ['doer', 'reviewer', 'planner', 'plan-reviewer', 'kb-agent', 'harvest', 'pm', 'user'];

// D5 (T2.3): validate the caller's role hint against the Author enum. Any
// value outside the enum -- including an absent hint -- stamps the literal
// 'unknown'. Never a free string is persisted as author.
function validateAuthor(role: string | undefined): Author | 'unknown' {
  if (role && (AUTHOR_VALUES as readonly string[]).includes(role)) {
    return role as Author;
  }
  return 'unknown';
}

export const kbCaptureSchema = z.object({
  type: z.enum(['context-cache', 'learning', 'knowledge', 'runbook', 'user-directive'])
    .describe('Content type: context-cache for file summaries, learning for session insights, knowledge for facts, runbook for procedures, user-directive for a standing user instruction/correction (highest trust: stored CONFIRMED, exempt from the clamp)'),
  title: z.string().min(1).describe('Short description (max ~80 chars)'),
  summary: z.string().min(1).describe('2-4 sentence overview'),
  content: z.string().min(1).describe('Full detail (will be truncated at 4000 chars)'),
  source_files: z.array(z.string()).optional().describe('Related file paths'),
  symbols: z.array(z.string()).optional().describe('Function/class names this entry covers'),
  module: z.string().optional().describe('Module name'),
  tags: z.array(z.string()).optional().describe('Labels for filtering'),
  source_file: z.string().optional().describe('File to hash (required when type=context-cache)'),
  role: z.string().optional()
    .describe('Role hint for provenance: doer/reviewer/planner/plan-reviewer/kb-agent/harvest/pm/user. Validated server-side against the Author enum; invalid or absent stamps "unknown". source is derived from the validated role/type and is never accepted from the caller.'),
  confidence: z.enum(['CONFIRMED', 'INFERRED', 'UNVERIFIED']).optional()
    .describe('Confidence level (default: INFERRED)'),
  scope: z.enum(['project', 'global']).optional()
    .describe('Scope: project (default) or global for team-wide conventions'),
});

export type KbCaptureInput = z.infer<typeof kbCaptureSchema>;

export async function kbCapture(input: KbCaptureInput): Promise<string> {
  if (input.source_files?.length) validateFilePaths(input.source_files);
  if (input.source_file) validateFilePaths([input.source_file]);

  const providers = await getKbProviders();

  let content_hash = '';
  let content_hash_type: 'git' | 'sha256' = 'sha256';

  if (input.type === 'context-cache' && input.source_file) {
    const result = await computeFileHash(input.source_file);
    if (result) {
      content_hash = result.hash;
      content_hash_type = result.type;
    }
  }

  // context-cache always goes to project; scope='global' goes to global; otherwise project
  const target = (input.type === 'context-cache' || input.scope !== 'global')
    ? providers.project
    : providers.global;

  // D1 gate (forward-only): kb_capture caps confidence at INFERRED. kb_promote
  // is the ONLY path that mints CONFIRMED. UNVERIFIED and INFERRED pass through
  // unchanged; an incoming CONFIRMED is downgraded to INFERRED. The clamp is
  // enforced here in the tool handler (server-side), not just in the zod schema,
  // so no caller can bypass it. The downgrade is made VISIBLE to the caller
  // (confidence_clamped flag + a bracketed content note) so it is never silently
  // misled. Existing direct-CONFIRMED rows are historical data and are NOT
  // migrated -- enforcement applies only to new captures from this point on.
  //
  // D6 (T3.1): entry type 'user-directive' is authoritative on capture and is
  // the SOLE exemption from the D1 clamp. Now that 'user-directive' is a real
  // ContentType member, the earlier T1.1 forward-compat raw-string guard is
  // replaced with this typed-union check. A user-directive is stamped
  // confidence='CONFIRMED' directly (highest trust tier) regardless of the
  // caller's confidence hint -- it does not climb the promote ladder. Every
  // other type is clamped: an incoming CONFIRMED is downgraded to INFERRED, made
  // visible via confidence_clamped + a bracketed content note (D6 semantic 4:
  // storing CONFIRMED is all that is needed for CONFIRMED-equivalent retrieval
  // ranking -- no extra ranking code).
  const isUserDirective = input.type === 'user-directive';
  const requestedConfidence = input.confidence ?? 'INFERRED';
  let confidence = requestedConfidence;
  let content = input.content;
  let confidence_clamped = false;
  if (isUserDirective) {
    confidence = 'CONFIRMED';
  } else if (requestedConfidence === 'CONFIRMED') {
    confidence = 'INFERRED';
    confidence_clamped = true;
    content = content + '\n\n[confidence clamped: CONFIRMED requires kb_promote]';
  }

  // D5 (T2.3) + D6 (T3.1): provenance is stamped by this handler, never
  // accepted as a free string from the caller. A user-directive is stamped
  // author='user' and source='user-directive' (the user is the authority, not
  // the invoking agent's role hint). Otherwise author is the validated role
  // hint (Author | 'unknown') and source is derived -- 'review' for a reviewer
  // capture, else 'session'.
  const author: Author | 'unknown' = isUserDirective ? 'user' : validateAuthor(input.role);
  const source: CaptureSource = isUserDirective
    ? 'user-directive'
    : author === 'reviewer'
      ? 'review'
      : 'session';

  const { id, audn_decision } = await target.capture({
    type: input.type,
    title: input.title,
    summary: input.summary,
    content,
    source_files: input.source_files ?? [],
    symbols: input.symbols ?? [],
    module: input.module,
    tags: input.tags ?? [],
    content_hash,
    content_hash_type,
    flagged_for_review: false,
    author,
    source,
    confidence,
    scope: input.scope ?? 'project',
  });

  return JSON.stringify({ id, audn_decision, confidence_clamped });
}
