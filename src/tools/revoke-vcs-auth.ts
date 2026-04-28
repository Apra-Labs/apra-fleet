import { z } from 'zod';
import { getStrategy } from '../services/strategy.js';
import { getOsCommands } from '../os/index.js';
import { getAgentOS, touchAgent } from '../utils/agent-helpers.js';
import { memberIdentifier, resolveMember } from '../utils/resolve-member.js';
import { githubProvider } from '../services/vcs/github.js';
import { bitbucketProvider } from '../services/vcs/bitbucket.js';
import { azureDevOpsProvider } from '../services/vcs/azure-devops.js';
import { PROVIDER_HOSTS } from '../services/vcs/constants.js';
import { logLine } from '../utils/log-helpers.js';
import type { Agent } from '../types.js';
import type { VcsProviderService } from '../services/vcs/types.js';

const providers: Record<string, VcsProviderService> = {
  'github': githubProvider,
  'bitbucket': bitbucketProvider,
  'azure-devops': azureDevOpsProvider,
};

export const revokeVcsAuthSchema = z.object({
  ...memberIdentifier,
  provider: z.enum(['github', 'bitbucket', 'azure-devops']).describe('VCS provider whose credentials to revoke'),
  label: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).optional().describe('Credential label to revoke (e.g. "work-github"). If omitted, revokes the default (provider-named) credential.'),
  scope_url: z.string().optional().describe('Git credential scope URL used when the credential was provisioned (e.g. "https://github.com/my-org"). Defaults to "https://<host>".'),
});

export type RevokeVcsAuthInput = z.infer<typeof revokeVcsAuthSchema>;

export async function revokeVcsAuth(input: RevokeVcsAuthInput): Promise<string> {
  const agentOrError = resolveMember(input.member_id, input.member_name);
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

  const label = input.label ?? input.provider;
  const host = PROVIDER_HOSTS[input.provider];
  const scopeUrl = input.scope_url ?? `https://${host}`;

  let result;
  try {
    result = await service.revoke(agent, cmds, exec, label, scopeUrl);
  } catch (err: any) {
    return `❌ Failed to revoke ${input.provider} credentials on "${agent.friendlyName}": ${err.message}`;
  }

  touchAgent(agent.id);
  logLine('revoke_vcs_auth', `provider=${input.provider}`, agent.id, agent.friendlyName);

  return result.success
    ? `✅ ${result.message} on "${agent.friendlyName}"`
    : `❌ ${result.message}`;
}
