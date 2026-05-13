import { z } from 'zod';
import { memberIdentifier, resolveMember } from '../utils/resolve-member.js';
import { assertGbrainEnabled, callGbrainTool } from '../utils/gbrain-helpers.js';

export const codeCallersSchema = z.object({
  ...memberIdentifier,
  symbol: z.string().describe('The function to find callers of'),
});

export type CodeCallersInput = z.infer<typeof codeCallersSchema>;

export async function codeCallers(input: CodeCallersInput): Promise<string> {
  const agentOrError = resolveMember(input.member_id, input.member_name);
  if (typeof agentOrError === 'string') return agentOrError;

  const gbrainError = assertGbrainEnabled(agentOrError);
  if (gbrainError) return gbrainError;

  return callGbrainTool('code_callers', { symbol: input.symbol });
}
