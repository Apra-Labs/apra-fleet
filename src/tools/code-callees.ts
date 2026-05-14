import { z } from 'zod';
import { memberIdentifier, resolveMember } from '../utils/resolve-member.js';
import { assertGbrainEnabled, callGbrainTool } from '../utils/gbrain-helpers.js';

export const codeCalleesSchema = z.object({
  ...memberIdentifier,
  symbol: z.string().describe('The function to find callees of'),
});

export type CodeCalleesInput = z.infer<typeof codeCalleesSchema>;

export async function codeCallees(input: CodeCalleesInput): Promise<string> {
  const agentOrError = resolveMember(input.member_id, input.member_name);
  if (typeof agentOrError === 'string') return agentOrError;

  const gbrainError = assertGbrainEnabled(agentOrError);
  if (gbrainError) return gbrainError;

  // gbrain exposes callees via the "query" tool with near_symbol anchor.
  return callGbrainTool('query', { query: `functions called by ${input.symbol}`, near_symbol: input.symbol, walk_depth: 1 });
}
