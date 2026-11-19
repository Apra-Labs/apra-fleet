/**
 * GitHub VCS provider — supports GitHub App (short-lived token minting) and PAT modes.
 */

import type { Agent } from '../../types.js';
import type { OsCommands } from '../../os/os-commands.js';
import type { VcsProviderService, VcsDeployResult, GitHubCredentials, GitHubAppCredentials, GitHubGhLogin } from './types.js';
import { getGitHubApp } from '../git-config.js';
import { loadPrivateKey, mapAccessLevel, mintGitToken } from '../github-app.js';
import { memberSharingHostUser } from '../member-host-user.js';

const HOST = 'github.com';
const USERNAME = 'x-access-token';

/**
 * Whether this deploy also logs the gh CLI in with the new token.
 *
 * gh keeps ONE login per OS user (its hosts.yml / keyring entry), unlike the
 * git credential helper, which is per member and per label. Logging in
 * replaces the token every other process of that OS user runs gh with: the
 * operator's own sessions on a local member, and every other member
 * registered on the same host user. A token minted for another label, access
 * level or repo set would then silently change (and possibly narrow) what all
 * of them can do. So by default gh is logged in only for the provider's own
 * label ('github') on a remote member no other registered member shares;
 * everywhere else the caller must ask for it (gh_login: true). gh_login:
 * false never logs in. The token of any label stays usable without gh's
 * login through vcs_credential_exec.
 */
export function ghLoginDecision(
  agent: Agent,
  label: string | undefined,
  requested: GitHubGhLogin,
): { login: boolean; skipped?: string } {
  if (requested === true) return { login: true };
  if (requested === false) return { login: false, skipped: 'gh_login was false' };
  if (label !== undefined && label !== 'github') {
    return { login: false, skipped: `label '${label}' is not the provider label 'github'` };
  }
  if (agent.agentType === 'local') {
    return { login: false, skipped: 'local member: gh login is shared with every session of this OS user' };
  }
  const sharer = memberSharingHostUser(agent);
  if (sharer) {
    return { login: false, skipped: `member '${sharer.friendlyName}' runs as the same user on this host` };
  }
  return { login: true };
}

/** The gh login step of a deploy; returns the ghCliAuth metadata value. */
async function maybeGhLogin(
  agent: Agent,
  cmds: OsCommands,
  exec: (cmd: string) => Promise<string>,
  token: string,
  label: string | undefined,
  requested: GitHubGhLogin,
): Promise<string> {
  const decision = ghLoginDecision(agent, label, requested);
  if (!decision.login) {
    return `skipped (${decision.skipped}; the host gh login was left unchanged -- pass gh_login: true to log gh in with this token)`;
  }
  // Best-effort: never fail the whole deploy over this -- git credential
  // access is the load-bearing part; gh auth is a bonus that needs the App's
  // own permission set to include 'discussions'/'issues' etc, an org-admin
  // action on github.com outside this codebase's reach.
  try {
    await exec(cmds.ghAuthLogin(token, HOST));
    return 'ok';
  } catch {
    return 'failed (see member logs -- gh CLI missing or login rejected)';
  }
}

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

  await exec(cmds.gitCredentialHelperWrite(HOST, USERNAME, token, label, scopeUrl, agent.id));

  // gh has its own auth store (never reads the git credential helper above),
  // so without a login git access can work while `gh` (PRs, issues,
  // Discussions GraphQL) stays unauthenticated -- but that store is shared by
  // the whole OS user (see ghLoginDecision).
  const ghCliAuth = await maybeGhLogin(agent, cmds, exec, token, label, creds.ghLogin);

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
      ghCliAuth,
    },
  };
}

async function deployPat(
  agent: Agent,
  cmds: OsCommands,
  exec: (cmd: string) => Promise<string>,
  token: string,
  label?: string,
  scopeUrl?: string,
  ghLogin?: GitHubGhLogin,
): Promise<VcsDeployResult> {
  await exec(cmds.gitCredentialHelperWrite(HOST, USERNAME, token, label, scopeUrl, agent.id));

  // gh CLI login -- see the matching comment in deployAppToken. A PAT's
  // scopes (including Discussions, via classic PAT `repo`/`write:discussion`
  // or a fine-grained PAT's own permission picker) are whatever the user granted it
  // when they created it, so this can succeed here even before an App's own
  // permission set is updated.
  const ghCliAuth = await maybeGhLogin(agent, cmds, exec, token, label, ghLogin);

  return {
    success: true,
    message: 'GitHub PAT credentials deployed',
    metadata: {
      mode: 'pat',
      token: token.substring(0, 4) + '****',
      ghCliAuth,
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
      return { type: 'pat', token: input.token, ghLogin: input.gh_login };
    }
    return { type: 'github-app', git_access: input.git_access, repos: input.repos, ghLogin: input.gh_login };
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
      : deployPat(agent, cmds, exec, creds.token, label, scopeUrl, creds.ghLogin);
  },

  async revoke(agent, cmds, exec, label?, scopeUrl?) {
    await exec(cmds.gitCredentialHelperRemove(HOST, label, scopeUrl, agent.id));
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
