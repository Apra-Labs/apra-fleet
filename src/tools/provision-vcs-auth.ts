import { z } from 'zod';
import { getStrategy } from '../services/strategy.js';
import { getOsCommands } from '../os/index.js';
import { getAgentOS, touchAgent, checkVcsTokenExpiry } from '../utils/agent-helpers.js';
import { memberIdentifier, resolveMember } from '../utils/resolve-member.js';
import { updateAgent } from '../services/registry.js';
import { credentialResolve } from '../services/credential-store.js';
import { collectOobApiKey } from '../services/auth-socket.js';
import { decryptPassword } from '../utils/crypto.js';
import { githubProvider } from '../services/vcs/github.js';
import { bitbucketProvider } from '../services/vcs/bitbucket.js';
import { azureDevOpsProvider } from '../services/vcs/azure-devops.js';
import { scheduleCredentialCleanup, cancelCredentialCleanup } from '../services/credential-cleanup.js';
import { PROVIDER_HOSTS } from '../services/vcs/constants.js';
import { logLine } from '../utils/log-helpers.js';
import type { Agent } from '../types.js';
import type { VcsProviderService } from '../services/vcs/types.js';

const TOKEN_RE = /\{\{secure\.([a-zA-Z0-9_]{1,64})\}\}/g;

function resolveSecureField(value: string, callingMember: string): { resolved: string } | { error: string } {
  const tokenNames = new Set<string>();
  let match: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((match = TOKEN_RE.exec(value)) !== null) tokenNames.add(match[1]);
  let resolved = value;
  for (const name of tokenNames) {
    const entry = credentialResolve(name, callingMember);
    if (!entry) return { error: `Credential "${name}" not found. Run credential_store_set first.` };
    if ('denied' in entry) return { error: entry.denied };
    if ('expired' in entry) return { error: entry.expired };
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
  label: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).optional().describe('Credential label (slug, e.g. "work-github"). Defaults to provider name. Enables multiple credentials per provider.'),
  scope_url: z.string().optional().describe('Git credential scope URL (e.g. "https://github.com/my-org"). Defaults to "https://<host>".'),

  // GitHub fields
  github_mode: z.enum(['github-app', 'pat']).optional().describe('GitHub auth mode: github-app (mint via configured app) or pat (personal access token)'),
  token: z.string().optional().describe('Personal access token (GitHub PAT or Azure DevOps PAT). Supports {{secure.NAME}} token — value is resolved from the credential store before use.'),
  git_access: z.enum(['read', 'push', 'admin', 'issues', 'full']).optional().describe('GitHub App access level override'),
  repos: z.array(z.string()).optional().describe('GitHub App repository list override'),

  // Bitbucket fields
  email: z.string().optional().describe('Bitbucket account email'),
  api_token: z.string().optional().describe('Bitbucket API token. Supports {{secure.NAME}} token — value is resolved from the credential store before use.'),
  workspace: z.string().optional().describe('Bitbucket workspace slug'),

  // Azure DevOps fields
  org_url: z.string().optional().describe('Azure DevOps organization URL (e.g. https://dev.azure.com/myorg)'),
  pat: z.string().optional().describe('Azure DevOps personal access token. Supports {{secure.NAME}} token — value is resolved from the credential store before use.'),
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
      const r = resolveSecureField(resolvedInput[field]!, agent.friendlyName);
      if ('error' in r) return `❌ ${r.error}`;
      resolvedInput[field] = r.resolved;
    }
  }

  // OOB fallback for absent credential fields
  if (resolvedInput.provider === 'github' && (resolvedInput.github_mode ?? 'github-app') === 'pat' && resolvedInput.token === undefined) {
    const oob = await collectOobApiKey(agent.friendlyName, 'provision_vcs_auth', {
      prompt: `Enter GitHub personal access token for ${agent.friendlyName}`,
    });
    if ('fallback' in oob) return oob.fallback ?? 'Error: OOB operation cancelled.';
    resolvedInput.token = decryptPassword(oob.password!);
  }
  if (resolvedInput.provider === 'bitbucket' && resolvedInput.api_token === undefined) {
    const oob = await collectOobApiKey(agent.friendlyName, 'provision_vcs_auth', {
      prompt: `Enter Bitbucket API token for ${agent.friendlyName}`,
    });
    if ('fallback' in oob) return oob.fallback ?? 'Error: OOB operation cancelled.';
    resolvedInput.api_token = decryptPassword(oob.password!);
  }
  if (resolvedInput.provider === 'azure-devops' && resolvedInput.pat === undefined && resolvedInput.token === undefined) {
    const oob = await collectOobApiKey(agent.friendlyName, 'provision_vcs_auth', {
      prompt: `Enter Azure DevOps personal access token for ${agent.friendlyName}`,
    });
    if ('fallback' in oob) return oob.fallback ?? 'Error: OOB operation cancelled.';
    resolvedInput.pat = decryptPassword(oob.password!);
  }

  const creds = buildCredentials(resolvedInput);
  if (typeof creds === 'string') return `❌ ${creds}`;

  const label = input.label ?? input.provider;
  const host = PROVIDER_HOSTS[input.provider];
  const scopeUrl = input.scope_url ?? `https://${host}`;

  // Cancel any existing credential cleanup timer before re-provisioning
  cancelCredentialCleanup(agent.id);

  const strategy = getStrategy(agent);
  const conn = await strategy.testConnection();
  if (!conn.ok) return `❌ Member "${agent.friendlyName}" is offline: ${conn.error}`;

  const cmds = getOsCommands(getAgentOS(agent));
  const exec = async (cmd: string): Promise<string> => {
    const result = await strategy.execCommand(cmd, 15000);
    if (result.code !== 0 && result.stderr) throw new Error(result.stderr);
    return result.stdout;
  };

  // Legacy migration: remove old single-file credential helpers
  try {
    await exec(cmds.gitCredentialHelperRemove(host));
  } catch { /* best-effort */ }

  let deployResult;
  try {
    deployResult = await service.deploy(agent, cmds, exec, creds, label, scopeUrl);
  } catch (err: any) {
    return `❌ Failed to deploy ${input.provider} credentials on "${agent.friendlyName}": ${err.message}`;
  }

  if (!deployResult.success) return `❌ ${deployResult.message}`;

  // Persist VCS provider and token expiry in the agent registry
  updateAgent(agent.id, {
    vcsProvider: input.provider,
    vcsTokenExpiresAt: deployResult.metadata?.expiresAt,
  });

  // Schedule auto-cleanup when token expires
  scheduleCredentialCleanup(agent.id, deployResult.metadata?.expiresAt);

  // Best-effort connectivity test
  let connectivity;
  try {
    connectivity = await service.testConnectivity(agent, exec);
  } catch {
    connectivity = { success: false, message: 'connectivity test threw' };
  }

  touchAgent(agent.id);
  logLine('provision_vcs_auth', `provider=${input.provider}`, agent);

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
