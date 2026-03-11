import { z } from 'zod';
import { getAllAgents } from '../services/registry.js';
import { getStrategy } from '../services/strategy.js';
import { getOsCommands } from '../os/index.js';
import { getAgentOrFail, getAgentOS } from '../utils/agent-helpers.js';
import type { Agent } from '../types.js';

export const updateClaudeSchema = z.object({
  member_id: z.string().optional().describe('The UUID of the member to update. Omit to update ALL online members.'),
  install_if_missing: z.boolean().default(false).describe('Install Claude Code on the member if not already installed (default: false)'),
});

export type UpdateClaudeInput = z.infer<typeof updateClaudeSchema>;

interface UpdateResult {
  name: string;
  oldVersion: string;
  newVersion: string;
  success: boolean;
  installed?: boolean;
  error?: string;
}

async function updateSingleAgent(agent: Agent, installIfMissing: boolean): Promise<UpdateResult> {
  const cmds = getOsCommands(getAgentOS(agent));
  const strategy = getStrategy(agent);
  const result: UpdateResult = {
    name: agent.friendlyName,
    oldVersion: 'unknown',
    newVersion: 'unknown',
    success: false,
  };

  try {
    // Get current version
    const vBefore = await strategy.execCommand(cmds.claudeVersion(), 15000);
    const claudeFound = vBefore.code === 0 && vBefore.stdout.trim().length > 0;
    result.oldVersion = claudeFound ? vBefore.stdout.trim() : 'not installed';

    if (!claudeFound && !installIfMissing) {
      result.error = 'Claude CLI not found — use install_if_missing: true to install';
      return result;
    }

    if (!claudeFound && installIfMissing) {
      const installResult = await strategy.execCommand(cmds.installClaude(), 180000);
      if (installResult.code !== 0) {
        result.error = installResult.stderr || 'Install command failed';
        return result;
      }
      result.installed = true;
    } else {
      const updateResult = await strategy.execCommand(cmds.updateClaude(), 120000);
      if (updateResult.code !== 0) {
        result.error = updateResult.stderr || 'Update command failed';
      }
    }

    // Get new version
    const vAfter = await strategy.execCommand(cmds.claudeVersion(), 15000);
    result.newVersion = vAfter.stdout.trim() || 'unknown';
    result.success = true;

    if (!result.installed && result.oldVersion === result.newVersion) {
      result.error = 'Already up to date';
    }
  } catch (err: any) {
    result.error = err.message;
  }

  return result;
}

export async function updateClaude(input: UpdateClaudeInput): Promise<string> {
  let agents: Agent[];

  if (input.member_id) {
    const agentOrError = getAgentOrFail(input.member_id);
    if (typeof agentOrError === 'string') return agentOrError;
    agents = [agentOrError as Agent];
  } else {
    // Update all online agents
    const allAgents = getAllAgents();
    if (allAgents.length === 0) {
      return 'No members registered.';
    }

    // Filter to online members
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
      return 'No members are currently online.';
    }
  }

  // Update all selected members in parallel
  const results = await Promise.allSettled(agents.map(a => updateSingleAgent(a, input.install_if_missing)));

  let report = `Claude CLI Update Report\n${'='.repeat(40)}\n\n`;

  for (const r of results) {
    if (r.status === 'fulfilled') {
      const res = r.value;
      const icon = res.success ? '✅' : '❌';
      report += `${icon} ${res.name}\n`;
      if (res.installed) {
        report += `   Installed: ${res.newVersion}\n`;
      } else {
        report += `   ${res.oldVersion} → ${res.newVersion}\n`;
      }
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
