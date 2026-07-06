import { z } from 'zod';
import { computeFileHash } from '../services/knowledge/kb-service.js';
import { getKbProviders } from '../services/knowledge/kb-providers.js';
import { validateFilePaths } from '../services/knowledge/path-validation.js';

export const kbCaptureSchema = z.object({
  type: z.enum(['context-cache', 'learning', 'knowledge', 'runbook'])
    .describe('Content type: context-cache for file summaries, learning for session insights, knowledge for facts, runbook for procedures'),
  title: z.string().min(1).describe('Short description (max ~80 chars)'),
  summary: z.string().min(1).describe('2-4 sentence overview'),
  content: z.string().min(1).describe('Full detail (will be truncated at 4000 chars)'),
  source_files: z.array(z.string()).optional().describe('Related file paths'),
  symbols: z.array(z.string()).optional().describe('Function/class names this entry covers'),
  module: z.string().optional().describe('Module name'),
  tags: z.array(z.string()).optional().describe('Labels for filtering'),
  source_file: z.string().optional().describe('File to hash (required when type=context-cache)'),
  source: z.enum(['doer', 'reviewer', 'user_interrupt', 'kb_agent_harvest']).optional()
    .describe('Who captured this (default: doer)'),
  confidence: z.enum(['CONFIRMED', 'INFERRED', 'UNVERIFIED']).optional()
    .describe('Confidence level (default: INFERRED)'),
  author: z.string().optional().describe('Agent or user that captured this'),
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
  // D6 forward-compat exemption: entry type 'user-directive' is authoritative on
  // capture and bypasses the clamp. That type is not part of the ContentType
  // union yet, so compare the raw string here.
  // TODO(T3.1): replace this raw-string check with the typed 'user-directive'
  // ContentType member once it lands, and stamp author/source accordingly.
  const isUserDirective = (input.type as string) === 'user-directive';
  const requestedConfidence = input.confidence ?? 'INFERRED';
  let confidence = requestedConfidence;
  let content = input.content;
  let confidence_clamped = false;
  if (requestedConfidence === 'CONFIRMED' && !isUserDirective) {
    confidence = 'INFERRED';
    confidence_clamped = true;
    content = content + '\n\n[confidence clamped: CONFIRMED requires kb_promote]';
  }

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
    author: input.author ?? '',
    source: input.source ?? 'doer',
    confidence,
    scope: input.scope ?? 'project',
  });

  return JSON.stringify({ id, audn_decision, confidence_clamped });
}
