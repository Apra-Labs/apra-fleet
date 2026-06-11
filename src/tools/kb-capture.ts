import { z } from 'zod';
import { getKBService, computeFileHash } from '../services/knowledge/kb-service.js';
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
});

export type KbCaptureInput = z.infer<typeof kbCaptureSchema>;

export async function kbCapture(input: KbCaptureInput): Promise<string> {
  if (input.source_files?.length) validateFilePaths(input.source_files);
  if (input.source_file) validateFilePaths([input.source_file]);

  const service = getKBService();
  const provider = service.getProvider();
  await provider.init();

  let content_hash = '';
  let content_hash_type: 'git' | 'sha256' = 'sha256';

  if (input.type === 'context-cache' && input.source_file) {
    const result = await computeFileHash(input.source_file);
    if (result) {
      content_hash = result.hash;
      content_hash_type = result.type;
    }
  }

  const { id, audn_decision } = await provider.capture({
    type: input.type,
    title: input.title,
    summary: input.summary,
    content: input.content,
    source_files: input.source_files ?? [],
    symbols: input.symbols ?? [],
    module: input.module,
    tags: input.tags ?? [],
    content_hash,
    content_hash_type,
    flagged_for_review: false,
    author: input.author ?? '',
    source: input.source ?? 'doer',
    confidence: input.confidence ?? 'INFERRED',
  });

  return JSON.stringify({ id, audn_decision });
}
