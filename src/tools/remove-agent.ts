import { z } from 'zod';
import { getAgent, removeAgent as removeFromRegistry } from '../services/registry.js';
import { getStrategy } from '../services/strategy.js';

export const removeAgentSchema = z.object({
  agent_id: z.string().describe('The UUID of the agent to remove'),
});

export type RemoveAgentInput = z.infer<typeof removeAgentSchema>;

export async function removeAgent(input: RemoveAgentInput): Promise<string> {
  const agent = getAgent(input.agent_id);
  if (!agent) {
    return `Agent "${input.agent_id}" not found.`;
  }

  const strategy = getStrategy(agent);
  strategy.close();
  const removed = removeFromRegistry(input.agent_id);

  if (removed) {
    return `✅ Agent "${agent.friendlyName}" (${agent.id}) has been removed.`;
  }
  return `Failed to remove agent "${input.agent_id}".`;
}
