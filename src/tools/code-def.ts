import { z } from 'zod';
import { memberIdentifier, resolveMember } from '../utils/resolve-member.js';
import { assertGbrainEnabled, callGbrainTool } from '../utils/gbrain-helpers.js';

export const codeDefSchema = z.object({
  ...memberIdentifier,
  symbol: z.string().describe('The symbol (function, class, variable, etc.) to find the definition of'),
});

export type CodeDefInput = z.infer<typeof codeDefSchema>;

export async function codeDef(input: CodeDefInput): Promise<string> {
  const agentOrError = resolveMember(input.member_id, input.member_name);
  if (typeof agentOrError === 'string') return agentOrError;

  const gbrainError = assertGbrainEnabled(agentOrError);
  if (gbrainError) return gbrainError;

  // gbrain exposes symbol lookup via the "query" tool with near_symbol anchor.
  return callGbrainTool('query', { near_symbol: input.symbol, walk_depth: 1, detail: 'high' });
}
