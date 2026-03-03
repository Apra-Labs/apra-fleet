import { z } from 'zod';
import { getStrategy } from '../services/strategy.js';
import { getOsCommands } from '../os/index.js';
import { getAgentOrFail, getAgentOS, touchAgent } from '../utils/agent-helpers.js';
import type { Agent } from '../types.js';

export const revokeGitAuthSchema = z.object({
  agent_id: z.string().describe('The UUID of the agent to revoke git credentials from'),
});

export type RevokeGitAuthInput = z.infer<typeof revokeGitAuthSchema>;

export async function revokeGitAuth(input: RevokeGitAuthInput): Promise<string> {
  const agentOrError = getAgentOrFail(input.agent_id);
  if (typeof agentOrError === 'string') return agentOrError;
  const agent = agentOrError as Agent;

  const strategy = getStrategy(agent);
  const conn = await strategy.testConnection();
  if (!conn.ok) {
    return `❌ Agent "${agent.friendlyName}" is offline: ${conn.error}`;
  }

  const cmds = getOsCommands(getAgentOS(agent));
  try {
    const result = await strategy.execCommand(cmds.gitCredentialHelperRemove(), 15000);
    if (result.code !== 0 && result.stderr) {
      return `⚠️ Credential removal completed with warnings on "${agent.friendlyName}": ${result.stderr}`;
    }
  } catch (err: any) {
    return `❌ Failed to remove git credentials on "${agent.friendlyName}": ${err.message}`;
  }

  touchAgent(agent.id);

  return `✅ Git credentials revoked on "${agent.friendlyName}"\n`
    + `  Credential helper file removed\n`
    + `  Git credential.helper config unset`;
}
