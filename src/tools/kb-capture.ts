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
    .describe('Content type: context-cache for file summaries, learning for session insights, knowledge for facts, runbook for procedures, user-directive for a standing user instruction/correction. NOTE (F1/D1): a user-directive captured here is stored as a PENDING PROPOSAL (UNVERIFIED, flagged for review, scope forced to project) -- it is NOT an active directive and does NOT gain any trust semantics until a human approves it in their own terminal via "apra-fleet kb approve-directive <id>". MCP cannot mint an active directive.'),
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
  supersedes: z.string().optional()
    .describe('Id of an entry this capture REPLACES. Only honored when AUDN independently matches that same entry as a same-topic candidate (same type, overlapping symbols and source_files), so it cannot retire an arbitrary entry. Omit it unless you mean to retire something -- an ordinary refinement links to its predecessor and both stay live. The KB Agent sets this when resolving a flagged pair; doer/reviewer captures should not.'),
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

  const isUserDirective = input.type === 'user-directive';

  // M1 (F1, D1): force scope='project' for a directive proposal. A scope='global'
  // proposal would be routed to the global KB where the project CLI could never
  // list/approve/reject it (a dead-end audit trail) and the guard rekey would
  // not hold. Global directives, if ever needed, are a future
  // `add-directive --global` concern (out of scope). Every other type keeps its
  // requested scope.
  const scope = isUserDirective ? 'project' : (input.scope ?? 'project');

  // context-cache always goes to project; scope='global' goes to global; otherwise project
  const target = (input.type === 'context-cache' || scope !== 'global')
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
  // F1 (D1, closes yashr-9ha): the user-directive CONFIRMED clamp exemption is
  // REMOVED. A user-directive is no longer minted CONFIRMED here -- it is stored
  // as a PENDING PROPOSAL (confidence downgraded to UNVERIFIED, flagged, tagged
  // 'directive:pending') by the single choke point SqliteProvider.capture(), so
  // no MCP-reachable route (this handler OR the HTTP /api/kb/capture route) can
  // mint an active directive. It becomes ACTIVE only when a human approves it via
  // `apra-fleet kb approve-directive <id>` (the only unforgeable channel).
  // The general clamp below still downgrades an incoming CONFIRMED for EVERY
  // type, user-directive included.
  const requestedConfidence = input.confidence ?? 'INFERRED';
  let confidence = requestedConfidence;
  let content = input.content;
  let confidence_clamped = false;
  if (requestedConfidence === 'CONFIRMED') {
    confidence = 'INFERRED';
    confidence_clamped = true;
    content = content + '\n\n[confidence clamped: CONFIRMED requires kb_promote]';
  }

  // D5 (T2.3) + F1 (D1): provenance is stamped by this handler, never accepted
  // as a free string from the caller. author='user' is NO LONGER stamped on a
  // directive proposal -- MCP identity is forgeable, so a proposal records the
  // VALIDATED role hint (Author | 'unknown') instead. author='user' is stamped
  // ONLY by the CLI activation path (approveDirective / addDirective), the one
  // channel a human controls. source stays 'user-directive' for a directive
  // (it describes the channel/type, not identity); otherwise 'review' for a
  // reviewer capture, else 'session'.
  const author: Author | 'unknown' = validateAuthor(input.role);
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
    scope,
    supersedes: input.supersedes,
  });

  return JSON.stringify({ id, audn_decision, confidence_clamped });
}
