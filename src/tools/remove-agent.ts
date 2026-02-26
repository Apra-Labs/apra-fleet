import { z } from 'zod';
import fs from 'node:fs';
import { removeAgent as removeFromRegistry } from '../services/registry.js';
import { getStrategy } from '../services/strategy.js';
import { getOsCommands } from '../os/index.js';
import { getAgentOrFail, getAgentOS } from '../utils/agent-helpers.js';
import { removeKnownHost } from '../services/known-hosts.js';
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
  // Skip for local agents — their credentials belong to the host machine
  if (agent.agentType === 'remote') {
    try {
      const conn = await strategy.testConnection();
      if (conn.ok) {
        const cmds = getOsCommands(getAgentOS(agent));

        // Remove credentials file
        await strategy.execCommand(cmds.credentialFileRemove(), 10000).catch(() => {});

        // Remove ANTHROPIC_API_KEY from shell profiles
        for (const cmd of cmds.unsetEnv('ANTHROPIC_API_KEY')) {
          await strategy.execCommand(cmd, 10000).catch(() => {});
        }
      } else {
        warnings.push('Agent was offline — could not clear auth credentials');
      }
    } catch {
      warnings.push('Could not connect to agent — auth credentials may still be present');
    }
  }

  strategy.close();

  // Clean up local key files (before registry removal loses the reference)
  if (agent.keyPath) {
    try { fs.unlinkSync(agent.keyPath); } catch {}
    try { fs.unlinkSync(`${agent.keyPath}.pub`); } catch {}
  }

  // Clean up known_hosts entry
  if (agent.host && agent.port) {
    removeKnownHost(agent.host, agent.port);
  }

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
