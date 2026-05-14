import { z } from 'zod';
import { memberIdentifier, resolveMember } from '../utils/resolve-member.js';
import { assertGbrainEnabled, callGbrainTool } from '../utils/gbrain-helpers.js';

export const codeRefsSchema = z.object({
  ...memberIdentifier,
  symbol: z.string().describe('The symbol to find all references to'),
});

export type CodeRefsInput = z.infer<typeof codeRefsSchema>;

export async function codeRefs(input: CodeRefsInput): Promise<string> {
  const agentOrError = resolveMember(input.member_id, input.member_name);
  if (typeof agentOrError === 'string') return agentOrError;

  const gbrainError = assertGbrainEnabled(agentOrError);
  if (gbrainError) return gbrainError;

  // gbrain exposes cross-references via the "query" tool with near_symbol + walk.
  return callGbrainTool('query', { near_symbol: input.symbol, walk_depth: 2 });
}
