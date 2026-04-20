import { z } from 'zod';
import { getStrategy } from '../services/strategy.js';
import { getOsCommands } from '../os/index.js';
import { getAgentOS, touchAgent, checkVcsTokenExpiry } from '../utils/agent-helpers.js';
import { memberIdentifier, resolveMember } from '../utils/resolve-member.js';
import { updateAgent } from '../services/registry.js';
import { credentialResolve } from '../services/credential-store.js';
import { githubProvider } from '../services/vcs/github.js';
import { bitbucketProvider } from '../services/vcs/bitbucket.js';
import { azureDevOpsProvider } from '../services/vcs/azure-devops.js';
import type { Agent } from '../types.js';
import type { VcsProviderService } from '../services/vcs/types.js';

const TOKEN_RE = /\{\{secure\.([a-zA-Z0-9_]{1,64})\}\}/g;

function resolveSecureField(value: string): { resolved: string } | { error: string } {
  const tokenNames = new Set<string>();
  let match: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((match = TOKEN_RE.exec(value)) !== null) tokenNames.add(match[1]);
  let resolved = value;
  for (const name of tokenNames) {
    const entry = credentialResolve(name);
    if (!entry) return { error: `Credential "${name}" not found. Run credential_store_set first.` };
    resolved = resolved.replaceAll(`{{secure.${name}}}`, entry.plaintext);
  }
  return { resolved };
}

const providers: Record<string, VcsProviderService> = {
  'github': githubProvider,
  'bitbucket': bitbucketProvider,
  'azure-devops': azureDevOpsProvider,
};

export const provisionVcsAuthSchema = z.object({
  ...memberIdentifier,
  provider: z.enum(['github', 'bitbucket', 'azure-devops']).describe('VCS provider to configure'),

  // GitHub fields
  github_mode: z.enum(['github-app', 'pat']).optional().describe('GitHub auth mode: github-app (mint via configured app) or pat (personal access token)'),
  token: z.string().optional().describe('Personal access token (GitHub PAT or Azure DevOps PAT)'),
  git_access: z.enum(['read', 'push', 'admin', 'issues', 'full']).optional().describe('GitHub App access level override'),
  repos: z.array(z.string()).optional().describe('GitHub App repository list override'),

  // Bitbucket fields
  email: z.string().optional().describe('Bitbucket account email'),
  api_token: z.string().optional().describe('Bitbucket API token'),
  workspace: z.string().optional().describe('Bitbucket workspace slug'),

  // Azure DevOps fields
  org_url: z.string().optional().describe('Azure DevOps organization URL (e.g. https://dev.azure.com/myorg)'),
  pat: z.string().optional().describe('Azure DevOps personal access token'),
});

export type ProvisionVcsAuthInput = z.infer<typeof provisionVcsAuthSchema>;

function buildCredentials(input: ProvisionVcsAuthInput): unknown | string {
  switch (input.provider) {
    case 'github': {
      const mode = input.github_mode ?? 'github-app';
      if (mode === 'pat') {
        if (!input.token) return 'GitHub PAT mode requires "token" field.';
        return { type: 'pat', token: input.token };
      }
      return { type: 'github-app', git_access: input.git_access, repos: input.repos };
    }
    case 'bitbucket': {
      if (!input.email || !input.api_token || !input.workspace) {
        return 'Bitbucket requires "email", "api_token", and "workspace" fields.';
      }
      return { email: input.email, api_token: input.api_token, workspace: input.workspace };
    }
    case 'azure-devops': {
      const azPat = input.pat ?? input.token;
      if (!input.org_url || !azPat) return 'Azure DevOps requires "org_url" and "pat" (or "token") fields.';
      return { org_url: input.org_url, pat: azPat };
    }
  }
}

export async function provisionVcsAuth(input: ProvisionVcsAuthInput): Promise<string> {
  const agentOrError = resolveMember(input.member_id, input.member_name);
  if (typeof agentOrError === 'string') return agentOrError;
  const agent = agentOrError as Agent;

  const service = providers[input.provider];

  // Resolve {{secure.NAME}} tokens in credential fields
  const resolvedInput = { ...input };
  for (const field of ['token', 'api_token', 'pat'] as const) {
    if (resolvedInput[field]) {
      const r = resolveSecureField(resolvedInput[field]!);
      if ('error' in r) return `❌ ${r.error}`;
      resolvedInput[field] = r.resolved;
    }
  }

  const creds = buildCredentials(resolvedInput);
  if (typeof creds === 'string') return `❌ ${creds}`;

  const strategy = getStrategy(agent);
  const conn = await strategy.testConnection();
  if (!conn.ok) return `❌ Member "${agent.friendlyName}" is offline: ${conn.error}`;

  const cmds = getOsCommands(getAgentOS(agent));
  const exec = async (cmd: string): Promise<string> => {
    const result = await strategy.execCommand(cmd, 15000);
    if (result.code !== 0 && result.stderr) throw new Error(result.stderr);
    return result.stdout;
  };

  let deployResult;
  try {
    deployResult = await service.deploy(agent, cmds, exec, creds);
  } catch (err: any) {
    return `❌ Failed to deploy ${input.provider} credentials on "${agent.friendlyName}": ${err.message}`;
  }

  if (!deployResult.success) return `❌ ${deployResult.message}`;

  // Persist VCS provider and token expiry in the agent registry
  updateAgent(agent.id, {
    vcsProvider: input.provider,
    vcsTokenExpiresAt: deployResult.metadata?.expiresAt,
  });

  // Best-effort connectivity test
  let connectivity;
  try {
    connectivity = await service.testConnectivity(agent, exec);
  } catch {
    connectivity = { success: false, message: 'connectivity test threw' };
  }

  touchAgent(agent.id);

  const meta = deployResult.metadata
    ? Object.entries(deployResult.metadata).map(([k, v]) => `  ${k}: ${v}`).join('\n')
    : '';

  // Check if the just-deployed token is already near expiry
  const expiryWarning = deployResult.metadata?.expiresAt
    ? checkVcsTokenExpiry({ ...agent, vcsTokenExpiresAt: deployResult.metadata.expiresAt })
    : null;

  return `✅ ${deployResult.message} on "${agent.friendlyName}"\n`
    + (meta ? meta + '\n' : '')
    + `  Verification: ${connectivity.success ? connectivity.message : `⚠️ ${connectivity.message}`}`
    + (expiryWarning ? `\n  ${expiryWarning}` : '');
}
