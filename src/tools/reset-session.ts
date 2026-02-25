import { z } from 'zod';
import { getAgent, resetSession as resetInRegistry } from '../services/registry.js';

export const resetSessionSchema = z.object({
  agent_id: z.string().optional().describe('The UUID of the agent to reset. Omit to reset ALL agents.'),
});

export type ResetSessionInput = z.infer<typeof resetSessionSchema>;

export async function resetSession(input: ResetSessionInput): Promise<string> {
  if (input.agent_id) {
    const agent = getAgent(input.agent_id);
    if (!agent) {
      return `Agent "${input.agent_id}" not found.`;
    }

    const count = resetInRegistry(input.agent_id);
    if (count === 0) {
      return `Agent "${agent.friendlyName}" had no active session to reset.`;
    }
    return `✅ Session reset for agent "${agent.friendlyName}". Next prompt will start a fresh session.`;
  }

  // Reset all agents
  const count = resetInRegistry();
  if (count === 0) {
    return 'No agents had active sessions to reset.';
  }
  return `✅ Reset sessions for ${count} agent(s). All next prompts will start fresh sessions.`;
}
