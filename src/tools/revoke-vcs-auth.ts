import { z } from 'zod';
import { getStrategy } from '../services/strategy.js';
import { getOsCommands } from '../os/index.js';
import { getAgentOrFail, getAgentOS, touchAgent } from '../utils/agent-helpers.js';
import { githubProvider } from '../services/vcs/github.js';
import { bitbucketProvider } from '../services/vcs/bitbucket.js';
import { azureDevOpsProvider } from '../services/vcs/azure-devops.js';
import type { Agent } from '../types.js';
import type { VcsProviderService } from '../services/vcs/types.js';

const providers: Record<string, VcsProviderService> = {
  'github': githubProvider,
  'bitbucket': bitbucketProvider,
  'azure-devops': azureDevOpsProvider,
};

export const revokeVcsAuthSchema = z.object({
  member_id: z.string().describe('The UUID of the member to revoke VCS credentials from'),
  provider: z.enum(['github', 'bitbucket', 'azure-devops']).describe('VCS provider whose credentials to revoke'),
});

export type RevokeVcsAuthInput = z.infer<typeof revokeVcsAuthSchema>;

export async function revokeVcsAuth(input: RevokeVcsAuthInput): Promise<string> {
  const agentOrError = getAgentOrFail(input.member_id);
  if (typeof agentOrError === 'string') return agentOrError;
  const agent = agentOrError as Agent;

  const service = providers[input.provider];

  const strategy = getStrategy(agent);
  const conn = await strategy.testConnection();
  if (!conn.ok) return `❌ Member "${agent.friendlyName}" is offline: ${conn.error}`;

  const cmds = getOsCommands(getAgentOS(agent));
  const exec = async (cmd: string): Promise<string> => {
    const result = await strategy.execCommand(cmd, 15000);
    if (result.code !== 0 && result.stderr) throw new Error(result.stderr);
    return result.stdout;
  };

  let result;
  try {
    result = await service.revoke(agent, cmds, exec);
  } catch (err: any) {
    return `❌ Failed to revoke ${input.provider} credentials on "${agent.friendlyName}": ${err.message}`;
  }

  touchAgent(agent.id);

  return result.success
    ? `✅ ${result.message} on "${agent.friendlyName}"`
    : `❌ ${result.message}`;
}
