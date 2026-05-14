import { z } from 'zod';
import { memberIdentifier, resolveMember } from '../utils/resolve-member.js';
import { assertGbrainEnabled, callGbrainTool } from '../utils/gbrain-helpers.js';

export const brainQuerySchema = z.object({
  ...memberIdentifier,
  query: z.string().describe('The question or query to ask the brain'),
  collection: z.string().optional().describe('Optional brain collection or namespace to query'),
});

export type BrainQueryInput = z.infer<typeof brainQuerySchema>;

export async function brainQuery(input: BrainQueryInput): Promise<string> {
  const agentOrError = resolveMember(input.member_id, input.member_name);
  if (typeof agentOrError === 'string') return agentOrError;

  const gbrainError = assertGbrainEnabled(agentOrError);
  if (gbrainError) return gbrainError;

  // gbrain exposes keyword-only full-text search as "search".
  // The collection filter is not natively supported; pass as part of the query.
  const q = input.collection ? `${input.query} tags:${input.collection}` : input.query;
  return callGbrainTool('search', { query: q });
}
