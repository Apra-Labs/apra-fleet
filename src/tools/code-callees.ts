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

  return callGbrainTool('code_callees', { symbol: input.symbol });
}
