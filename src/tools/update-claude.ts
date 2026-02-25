import { z } from 'zod';
import { getAllAgents } from '../services/registry.js';
import { getStrategy } from '../services/strategy.js';
import { getClaudeVersionCommand, getUpdateClaudeCommand } from '../utils/platform.js';
import { getAgentOrFail, getAgentOS } from '../utils/agent-helpers.js';
import type { Agent } from '../types.js';

export const updateClaudeSchema = z.object({
  agent_id: z.string().optional().describe('The UUID of the agent to update. Omit to update ALL online agents.'),
});

export type UpdateClaudeInput = z.infer<typeof updateClaudeSchema>;

interface UpdateResult {
  name: string;
  oldVersion: string;
  newVersion: string;
  success: boolean;
  error?: string;
}

async function updateSingleAgent(agent: Agent): Promise<UpdateResult> {
  const os = getAgentOS(agent);
  const strategy = getStrategy(agent);
  const result: UpdateResult = {
    name: agent.friendlyName,
    oldVersion: 'unknown',
    newVersion: 'unknown',
    success: false,
  };

  try {
    // Get current version
    const vBefore = await strategy.execCommand(getClaudeVersionCommand(os), 15000);
    result.oldVersion = vBefore.stdout.trim();

    // Run update
    const updateResult = await strategy.execCommand(getUpdateClaudeCommand(os), 120000);
    if (updateResult.code !== 0) {
      result.error = updateResult.stderr || 'Update command failed';
      // Still check version — update might have partially succeeded
    }

    // Get new version
    const vAfter = await strategy.execCommand(getClaudeVersionCommand(os), 15000);
    result.newVersion = vAfter.stdout.trim();
    result.success = true;

    if (result.oldVersion === result.newVersion) {
      result.error = 'Already up to date';
    }
  } catch (err: any) {
    result.error = err.message;
  }

  return result;
}

export async function updateClaude(input: UpdateClaudeInput): Promise<string> {
  let agents: Agent[];

  if (input.agent_id) {
    const agentOrError = getAgentOrFail(input.agent_id);
    if (typeof agentOrError === 'string') return agentOrError;
    agents = [agentOrError as Agent];
  } else {
    // Update all online agents
    const allAgents = getAllAgents();
    if (allAgents.length === 0) {
      return 'No agents registered.';
    }

    // Filter to online agents
    const onlineChecks = await Promise.allSettled(
      allAgents.map(async a => {
        const strategy = getStrategy(a);
        const conn = await strategy.testConnection();
        return { agent: a, online: conn.ok };
      })
    );

    agents = onlineChecks
      .filter(r => r.status === 'fulfilled' && r.value.online)
      .map(r => (r as PromiseFulfilledResult<any>).value.agent);

    if (agents.length === 0) {
      return 'No agents are currently online.';
    }
  }

  // Update all selected agents in parallel
  const results = await Promise.allSettled(agents.map(a => updateSingleAgent(a)));

  let report = `Claude CLI Update Report\n${'='.repeat(40)}\n\n`;

  for (const r of results) {
    if (r.status === 'fulfilled') {
      const res = r.value;
      const icon = res.success ? '✅' : '❌';
      report += `${icon} ${res.name}\n`;
      report += `   ${res.oldVersion} → ${res.newVersion}\n`;
      if (res.error) {
        report += `   Note: ${res.error}\n`;
      }
      report += '\n';
    } else {
      report += `❌ Error: ${r.reason}\n\n`;
    }
  }

  return report;
}
