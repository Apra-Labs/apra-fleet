/**
 * GitHub VCS provider — supports GitHub App (short-lived token minting) and PAT modes.
 */

import type { Agent } from '../../types.js';
import type { OsCommands } from '../../os/os-commands.js';
import type { VcsProviderService, VcsDeployResult, GitHubCredentials, GitHubAppCredentials } from './types.js';
import { getGitHubApp } from '../git-config.js';
import { loadPrivateKey, mapAccessLevel, mintGitToken } from '../github-app.js';

const HOST = 'github.com';
const USERNAME = 'x-access-token';

async function deployAppToken(
  agent: Agent,
  cmds: OsCommands,
  exec: (cmd: string) => Promise<string>,
  creds: GitHubAppCredentials,
  label?: string,
  scopeUrl?: string,
): Promise<VcsDeployResult> {
  const ghApp = getGitHubApp();
  if (!ghApp) return { success: false, message: 'GitHub App not configured. Run setup_git_app first.' };

  const accessLevel = creds.git_access ?? agent.gitAccess;
  if (!accessLevel) return { success: false, message: 'No git_access level specified and none on agent config.' };

  const repos = creds.repos ?? agent.gitRepos;
  if (!repos?.length) return { success: false, message: 'No repos specified and none on agent config.' };

  let privateKey: string;
  try {
    privateKey = loadPrivateKey(ghApp.privateKeyPath);
  } catch (err: any) {
    return { success: false, message: `Failed to load GitHub App private key: ${err.message}` };
  }

  const permissions = mapAccessLevel(accessLevel);
  let token: string, expiresAt: string;
  try {
    const result = await mintGitToken(ghApp.appId, privateKey, ghApp.installationId, repos, permissions);
    token = result.token;
    expiresAt = result.expiresAt;
  } catch (err: any) {
    return { success: false, message: `Token mint failed: ${err.message}` };
  }

  await exec(cmds.gitCredentialHelperWrite(HOST, USERNAME, token, label, scopeUrl));

  return {
    success: true,
    message: `GitHub App credentials deployed (expires ${expiresAt})`,
    metadata: {
      mode: 'github-app',
      access: accessLevel,
      repos: repos.join(', '),
      token: token.substring(0, 4) + '****',
      expiresAt,
      permissions: JSON.stringify(permissions),
    },
  };
}

async function deployPat(
  cmds: OsCommands,
  exec: (cmd: string) => Promise<string>,
  token: string,
  label?: string,
  scopeUrl?: string,
): Promise<VcsDeployResult> {
  await exec(cmds.gitCredentialHelperWrite(HOST, USERNAME, token, label, scopeUrl));
  return {
    success: true,
    message: 'GitHub PAT credentials deployed',
    metadata: { mode: 'pat', token: token.substring(0, 4) + '****' },
  };
}

export const githubProvider: VcsProviderService = {
  async deploy(agent, cmds, exec, credentials, label?, scopeUrl?) {
    const creds = credentials as GitHubCredentials;
    return creds.type === 'github-app'
      ? deployAppToken(agent, cmds, exec, creds, label, scopeUrl)
      : deployPat(cmds, exec, creds.token, label, scopeUrl);
  },

  async revoke(_agent, cmds, exec, label?, scopeUrl?) {
    await exec(cmds.gitCredentialHelperRemove(HOST, label, scopeUrl));
    return { success: true, message: 'GitHub credentials revoked' };
  },

  async testConnectivity(agent, exec) {
    const repo = agent.gitRepos?.find(r => r !== '*');
    if (!repo) return { success: true, message: 'Skipped (no specific repo to test)' };

    try {
      await exec(`git ls-remote https://github.com/${repo}.git HEAD`);
      return { success: true, message: `git ls-remote ${repo} succeeded` };
    } catch {
      return { success: false, message: `git ls-remote ${repo} failed` };
    }
  },
};
