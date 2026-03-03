import { z } from 'zod';
import { getStrategy } from '../services/strategy.js';
import { getOsCommands } from '../os/index.js';
import { getAgentOrFail, getAgentOS, touchAgent } from '../utils/agent-helpers.js';
import { getGitHubApp } from '../services/git-config.js';
import { loadPrivateKey, mapAccessLevel, mintGitToken } from '../services/github-app.js';
import type { Agent } from '../types.js';

export const provisionGitAuthSchema = z.object({
  agent_id: z.string().describe('The UUID of the target agent'),
  git_access: z.enum(['read', 'push', 'admin', 'issues', 'full']).optional().describe(
    'Access level override. Defaults to the agent\'s stored git_access setting.'
  ),
  repos: z.array(z.string()).optional().describe(
    'Repository list override (e.g. ["Apra-Labs/ApraPipes"]). Defaults to the agent\'s stored git_repos setting.'
  ),
});

export type ProvisionGitAuthInput = z.infer<typeof provisionGitAuthSchema>;

export async function provisionGitAuth(input: ProvisionGitAuthInput): Promise<string> {
  const agentOrError = getAgentOrFail(input.agent_id);
  if (typeof agentOrError === 'string') return agentOrError;
  const agent = agentOrError as Agent;

  // Load GitHub App config
  const ghApp = getGitHubApp();
  if (!ghApp) {
    return '❌ GitHub App not configured. Run setup_git_app first.';
  }

  // Resolve access level and repos (input overrides agent config)
  const accessLevel = input.git_access ?? agent.gitAccess;
  if (!accessLevel) {
    return `❌ No git_access level specified for "${agent.friendlyName}" and none provided in input.\n`
      + '  Set git_access on the agent (via update_agent) or pass it in the request.';
  }

  const repos = input.repos ?? agent.gitRepos;
  if (!repos || repos.length === 0) {
    return `❌ No git_repos specified for "${agent.friendlyName}" and none provided in input.\n`
      + '  Set git_repos on the agent (via update_agent) or pass them in the request.';
  }

  // Check connectivity
  const strategy = getStrategy(agent);
  const conn = await strategy.testConnection();
  if (!conn.ok) {
    return `❌ Agent "${agent.friendlyName}" is offline: ${conn.error}`;
  }

  // Load private key and mint token
  let privateKey: string;
  try {
    privateKey = loadPrivateKey(ghApp.privateKeyPath);
  } catch (err: any) {
    return `❌ Failed to load GitHub App private key: ${err.message}`;
  }

  const permissions = mapAccessLevel(accessLevel);

  let token: string;
  let expiresAt: string;
  try {
    const result = await mintGitToken(ghApp.appId, privateKey, ghApp.installationId, repos, permissions);
    token = result.token;
    expiresAt = result.expiresAt;
  } catch (err: any) {
    return `❌ Token mint failed: ${err.message}`;
  }

  // Deploy credential helper to agent
  const cmds = getOsCommands(getAgentOS(agent));
  try {
    const cmd = cmds.gitCredentialHelperWrite('github.com', 'x-access-token', token);
    const result = await strategy.execCommand(cmd, 15000);
    if (result.code !== 0 && result.stderr) {
      return `❌ Failed to deploy git credentials on "${agent.friendlyName}": ${result.stderr}`;
    }
  } catch (err: any) {
    return `❌ Failed to deploy git credentials on "${agent.friendlyName}": ${err.message}`;
  }

  // Verify with git ls-remote on the first repo
  const testRepo = repos[0] === '*' ? null : repos[0];
  let verified = false;
  if (testRepo) {
    try {
      const verifyCmd = `git ls-remote https://github.com/${testRepo}.git HEAD`;
      const result = await strategy.execCommand(verifyCmd, 15000);
      verified = result.code === 0;
    } catch {
      // verification is best-effort
    }
  }

  touchAgent(agent.id);

  const maskedToken = token.substring(0, 8) + '****';
  return `✅ Git credentials deployed to "${agent.friendlyName}"\n`
    + `  Access: ${accessLevel}\n`
    + `  Repos: ${repos.join(', ')}\n`
    + `  Token: ${maskedToken}\n`
    + `  Expires: ${expiresAt}\n`
    + `  Permissions: ${JSON.stringify(permissions)}\n`
    + `  Verification: ${verified ? 'git ls-remote succeeded' : testRepo ? 'could not verify (may still work)' : 'skipped (wildcard repos)'}`;
}
