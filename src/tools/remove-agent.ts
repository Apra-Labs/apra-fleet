import { z } from 'zod';
import { removeAgent as removeFromRegistry } from '../services/registry.js';
import { getStrategy } from '../services/strategy.js';
import { getUnsetEnvCommand } from '../utils/platform.js';
import { getAgentOrFail, getAgentOS } from '../utils/agent-helpers.js';
import type { Agent } from '../types.js';

export const removeAgentSchema = z.object({
  agent_id: z.string().describe('The UUID of the agent to remove'),
});

export type RemoveAgentInput = z.infer<typeof removeAgentSchema>;

export async function removeAgent(input: RemoveAgentInput): Promise<string> {
  const agentOrError = getAgentOrFail(input.agent_id);
  if (typeof agentOrError === 'string') return agentOrError;
  const agent = agentOrError as Agent;

  const strategy = getStrategy(agent);
  const warnings: string[] = [];

  // Best-effort: clear auth credentials from the agent before removing
  try {
    const conn = await strategy.testConnection();
    if (conn.ok) {
      const os = getAgentOS(agent);

      // Remove credentials file
      const rmCredCmd = os === 'windows'
        ? 'del "%USERPROFILE%\\.claude\\.credentials.json" 2>nul'
        : 'rm -f ~/.claude/.credentials.json';
      await strategy.execCommand(rmCredCmd, 10000).catch(() => {});

      // Remove ANTHROPIC_API_KEY from shell profiles
      const commands = getUnsetEnvCommand(os, 'ANTHROPIC_API_KEY');
      for (const cmd of commands) {
        await strategy.execCommand(cmd, 10000).catch(() => {});
      }
    } else {
      warnings.push('Agent was offline — could not clear auth credentials');
    }
  } catch {
    warnings.push('Could not connect to agent — auth credentials may still be present');
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
