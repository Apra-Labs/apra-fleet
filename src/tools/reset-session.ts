import { z } from 'zod';
import { resetSession as resetInRegistry } from '../services/registry.js';
import { getAgentOrFail } from '../utils/agent-helpers.js';
import type { Agent } from '../types.js';

export const resetSessionSchema = z.object({
  member_id: z.string().optional().describe('The UUID of the member to reset. Omit to reset ALL members.'),
});

export type ResetSessionInput = z.infer<typeof resetSessionSchema>;

export async function resetSession(input: ResetSessionInput): Promise<string> {
  if (input.member_id) {
    const agentOrError = getAgentOrFail(input.member_id);
    if (typeof agentOrError === 'string') return agentOrError;
    const agent = agentOrError as Agent;

    const count = resetInRegistry(input.member_id);
    if (count === 0) {
      return `Member "${agent.friendlyName}" had no active session to reset.`;
    }
    return `✅ Session reset for member "${agent.friendlyName}". Next prompt will start a fresh session.`;
  }

  // Reset all members
  const count = resetInRegistry();
  if (count === 0) {
    return 'No members had active sessions to reset.';
  }
  return `✅ Reset sessions for ${count} member(s). All next prompts will start fresh sessions.`;
}
