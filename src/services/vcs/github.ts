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

  // Best-effort: also log the `gh` CLI itself in, using the same minted token.
  // gh has its own auth store (never reads the git credential helper above),
  // so without this, git access can work while `gh` (PRs, issues, Discussions
  // GraphQL) stays unauthenticated. Never fail the whole deploy over this --
  // git credential access is the load-bearing part; gh auth is a bonus that
  // needs the App's own permission set to include 'discussions'/'issues' etc,
  // an org-admin action on github.com outside this codebase's reach.
  let ghAuthOk = true;
  try {
    await exec(cmds.ghAuthLogin(token, HOST));
  } catch {
    ghAuthOk = false;
  }

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
      ghCliAuth: ghAuthOk ? 'ok' : 'failed (see member logs -- gh CLI missing or login rejected)',
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

  // Best-effort gh CLI login -- see the matching comment in deployAppToken.
  // A PAT's scopes (including Discussions, via classic PAT `repo`/`write:discussion`
  // or a fine-grained PAT's own permission picker) are whatever the user granted it
  // when they created it, so this can succeed here even before an App's own
  // permission set is updated.
  let ghAuthOk = true;
  try {
    await exec(cmds.ghAuthLogin(token, HOST));
  } catch {
    ghAuthOk = false;
  }

  return {
    success: true,
    message: 'GitHub PAT credentials deployed',
    metadata: {
      mode: 'pat',
      token: token.substring(0, 4) + '****',
      ghCliAuth: ghAuthOk ? 'ok' : 'failed (see member logs -- gh CLI missing or login rejected)',
    },
  };
}

export const githubProvider: VcsProviderService = {
  // apra-fleet-5co8.3.1: moved VERBATIM out of the provider switch in
  // src/tools/provision-vcs-auth.ts -- same default mode ('github-app'), same
  // required-field check and same error text, so no behaviour moves with it.
  // GitHub is the one provider with an auth-MODE axis; keeping that knowledge
  // here is the whole point of the seam.
  buildCredentials(input) {
    const mode = input.github_mode ?? 'github-app';
    if (mode === 'pat') {
      if (!input.token) return 'GitHub PAT mode requires "token" field.';
      return { type: 'pat', token: input.token };
    }
    return { type: 'github-app', git_access: input.git_access, repos: input.repos };
  },

  // apra-fleet-5co8.3.1: the former
  // `if (provider === 'github' && (github_mode ?? 'github-app') === 'pat' &&
  //     token === undefined)` block, verbatim. github-app mode mints its own
  // token server-side and must NEVER prompt, which is exactly what the mode
  // check in isMissing preserves.
  missingCredential: {
    field: 'token',
    isMissing: (input) => (input.github_mode ?? 'github-app') === 'pat' && input.token === undefined,
    promptFor: (memberName) => `Enter GitHub personal access token for ${memberName}`,
  },

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
