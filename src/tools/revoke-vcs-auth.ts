import { z } from 'zod';
import { getStrategy } from '../services/strategy.js';
import { getOsCommands } from '../os/index.js';
import { getAgentOS, getAgentShell, touchAgent } from '../utils/agent-helpers.js';
import { memberIdentifier, resolveMember } from '../utils/resolve-member.js';
import { githubProvider } from '../services/vcs/github.js';
import { bitbucketProvider } from '../services/vcs/bitbucket.js';
import { azureDevOpsProvider } from '../services/vcs/azure-devops.js';
import { PROVIDER_HOSTS } from '../services/vcs/constants.js';
import { logLine } from '../utils/log-helpers.js';
import { cancelCredentialCleanup } from '../services/credential-cleanup.js';
import { listVcsCredentials, forgetVcsCredential } from '../services/vcs-credential-record.js';
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
  label: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).optional().describe('Credential label to revoke (e.g. "work-github"). If omitted, revokes every credential label recorded for this provider on the member (or the default, provider-named credential when none is recorded).'),
  scope_url: z.string().optional().describe('Git credential scope URL used when the credential was provisioned (e.g. "https://github.com/my-org"). Defaults to the scope URL recorded for that label at provision time, else "https://<host>".'),
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

  const cmds = getOsCommands(getAgentOS(agent), getAgentShell(agent));
  const exec = async (cmd: string): Promise<string> => {
    const result = await strategy.execCommand(cmd, 15000);
    if (result.code !== 0 && result.stderr) throw new Error(result.stderr);
    return result.stdout;
  };

  // Which credentials to revoke:
  //  - explicit label: that label only, with the scope URL recorded for it at
  //    provision time (scope_url overrides; default https://<host>).
  //  - no label: every label recorded for this provider on the member; when
  //    none is recorded, the default provider-named credential, as before.
  // Each revoked label is dropped from the member record and its cleanup
  // timer is cancelled; other labels are untouched.
  const host = PROVIDER_HOSTS[input.provider];
  const recorded = listVcsCredentials(agent);
  const targets: Array<{ label: string | undefined; scopeUrl: string }> = [];
  if (input.label !== undefined) {
    const entry = recorded.find(e => e.label === input.label);
    targets.push({ label: input.label, scopeUrl: input.scope_url ?? entry?.scopeUrl ?? `https://${host}` });
  } else {
    for (const entry of recorded.filter(e => e.provider === input.provider && e.label !== undefined)) {
      targets.push({ label: entry.label, scopeUrl: input.scope_url ?? entry.scopeUrl ?? `https://${host}` });
    }
    if (targets.length === 0) targets.push({ label: input.provider, scopeUrl: input.scope_url ?? `https://${host}` });
  }

  const messages: string[] = [];
  for (const target of targets) {
    let result;
    try {
      result = await service.revoke(agent, cmds, exec, target.label, target.scopeUrl);
    } catch (err: any) {
      return `❌ Failed to revoke ${input.provider} credentials${target.label ? ` (label ${target.label})` : ''} on "${agent.friendlyName}": ${err.message}`;
    }
    if (!result.success) return `❌ ${result.message}`;
    cancelCredentialCleanup(agent.id, target.label);
    if (recorded.some(e => e.label === target.label)) forgetVcsCredential(agent.id, target.label);
    messages.push(target.label ? `${result.message} (label ${target.label})` : result.message);
  }

  touchAgent(agent.id);
  logLine('revoke_vcs_auth', `provider=${input.provider}`, agent);

  return `✅ ${messages.join('; ')} on "${agent.friendlyName}"`;
}
