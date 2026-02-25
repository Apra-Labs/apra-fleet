import { z } from 'zod';
import { getAgent, removeAgent as removeFromRegistry } from '../services/registry.js';
import { getStrategy } from '../services/strategy.js';
import { getUnsetEnvCommand } from '../utils/platform.js';

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
  const warnings: string[] = [];

  // Best-effort: clear the OAuth token from the agent before removing
  try {
    const conn = await strategy.testConnection();
    if (conn.ok) {
      const os = agent.os ?? 'linux';
      const commands = getUnsetEnvCommand(os, 'CLAUDE_CODE_OAUTH_TOKEN');
      for (const cmd of commands) {
        try {
          await strategy.execCommand(cmd, 10000);
        } catch {
          // Individual command failures are expected (e.g. file doesn't exist)
        }
      }
    } else {
      warnings.push('Agent was offline — could not clear OAuth token from shell profiles');
    }
  } catch {
    warnings.push('Could not connect to agent — OAuth token may still be present in shell profiles');
  }

  strategy.close();
  const removed = removeFromRegistry(input.agent_id);

  if (removed) {
    let result = `✅ Agent "${agent.friendlyName}" (${agent.id}) has been removed.`;
    if (warnings.length > 0) {
      result += `\n\n⚠️ Warnings:\n`;
      for (const w of warnings) {
        result += `  - ${w}\n`;
      }
    }
    return result;
  }
  return `Failed to remove agent "${input.agent_id}".`;
}
