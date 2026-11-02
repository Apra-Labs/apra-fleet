/**
 * Bitbucket VCS provider -- deploys API token credentials via git credential helper.
 *
 * Auth model (owner decision 2026-11-02): a Bitbucket API token authenticates
 * git over HTTPS with the FIXED username TOKEN_USERNAME, and the REST API with
 * `Authorization: Bearer <token>`. The account email is never used for auth:
 * Bitbucket accepts an email only for REST basic auth, and writing it as the
 * git username (the 0.4.4 behaviour) made every git push/pull fail while the
 * old unauthenticated REST probe still reported success.
 */

import type { VcsProviderService, VcsDeployResult, BitbucketCredentials } from './types.js';
import type { Agent } from '../../types.js';
import { getOsCommands, GIT_LS_REMOTE_OK_MARKER } from '../../os/index.js';
import { getAgentOS, getAgentShell } from '../../utils/agent-helpers.js';
import { knownRepoRemoteUrl } from '../member-remote-url.js';

const HOST = 'bitbucket.org';

/** The git username Bitbucket requires next to an API token. A constant, not
 *  a parameter: no caller can supply a username (and so never an email). */
export const BITBUCKET_TOKEN_USERNAME = 'x-bitbucket-api-token-auth';

/** bitbucket.org and its SSH hosts -- kept in step with
 *  src/utils/vcs-provider-detect.ts's BITBUCKET_HOST_RE. */
const BITBUCKET_HOST_RE = /^(?:www\.|altssh\.|ssh\.)?bitbucket\.org$/i;

/** A workspace or repository slug. Restricting the alphabet keeps every
 *  value interpolated into a member command free of shell metacharacters. */
const SLUG_RE = /^[A-Za-z0-9._-]+$/;

export interface BitbucketRepoRef {
  workspace: string;
  repo: string;
}

/**
 * Parse a Bitbucket Cloud git remote (https, ssh:// or scp-like) into its
 * { workspace, repo } slugs. NEVER throws; null for anything that is not a
 * bitbucket.org two-segment repo path with safe slugs. Any user:password in
 * an https remote is discarded, never returned.
 */
export function parseBitbucketRemote(remoteUrl: unknown): BitbucketRepoRef | null {
  if (typeof remoteUrl !== 'string') return null;
  const url = remoteUrl.trim();
  if (!url) return null;
  let host: string;
  let path: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    host = parsed.hostname.toLowerCase();
    path = parsed.pathname;
  } else {
    const scp = /^(?:[^@\s/]+@)?([^:\s/]+):(.*)$/.exec(url);
    if (!scp) return null;
    host = scp[1].toLowerCase();
    path = scp[2];
  }
  if (!BITBUCKET_HOST_RE.test(host)) return null;
  const parts = path.split('/').filter((p) => p !== '');
  if (parts.length !== 2) return null;
  const workspace = parts[0];
  const repo = parts[1].replace(/\.git$/i, '');
  if (!SLUG_RE.test(workspace) || !SLUG_RE.test(repo)) return null;
  return { workspace, repo };
}

/** git's own messages for a credential that is missing or rejected. */
const GIT_AUTH_FAILURE_RE = /authentication failed|could not read (?:username|password)|terminal prompts disabled|invalid credentials|\b40[13]\b|access denied/i;

/** Every way a member's origin can be learned: its registration record
 *  first (no round-trip), else the work folder's own `origin` remote. */
async function resolveOriginRef(
  agent: Agent,
  exec: (cmd: string) => Promise<string>,
): Promise<BitbucketRepoRef | null> {
  const known = parseBitbucketRemote(knownRepoRemoteUrl(agent));
  if (known) return known;
  if (!agent.workFolder) return null;
  const cmds = getOsCommands(getAgentOS(agent), getAgentShell(agent));
  try {
    const out = await exec(cmds.gitRemoteOrigin(agent.workFolder));
    const line = out.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '');
    return parseBitbucketRemote(line);
  } catch {
    return null;
  }
}

export const bitbucketProvider: VcsProviderService = {
  // Required: api_token and workspace. email is OPTIONAL and ignored for auth;
  // it is carried through only so deploy() can keep it as metadata.
  buildCredentials(input) {
    if (!input.api_token || !input.workspace) {
      return 'Bitbucket requires "api_token" and "workspace" fields.';
    }
    const creds: BitbucketCredentials = { api_token: input.api_token, workspace: input.workspace };
    if (input.email) creds.email = input.email;
    return creds;
  },

  validateNonSecretFields(input) {
    return input.workspace ? null : 'Bitbucket requires the "workspace" field.';
  },

  missingCredential: {
    field: 'api_token',
    isMissing: (input) => input.api_token === undefined,
    promptFor: (memberName) => `Enter Bitbucket API token for ${memberName}`,
  },

  async deploy(_agent, cmds, exec, credentials, label?, scopeUrl?) {
    const creds = credentials as BitbucketCredentials;
    // Always the fixed token username. A member provisioned by 0.4.4 carries
    // username=<email> in this same helper file; the write below replaces the
    // whole file, so a re-provision upgrades it, and nothing reads the old line.
    await exec(cmds.gitCredentialHelperWrite(HOST, BITBUCKET_TOKEN_USERNAME, creds.api_token, label, scopeUrl));
    return {
      success: true,
      message: 'Bitbucket credentials deployed',
      metadata: {
        workspace: creds.workspace,
        ...(creds.email ? { email: creds.email } : {}),
      },
    };
  },

  async revoke(_agent, cmds, exec, label?, scopeUrl?) {
    await exec(cmds.gitCredentialHelperRemove(HOST, label, scopeUrl));
    return { success: true, message: 'Bitbucket credentials revoked' };
  },

  // Two channels, both required for `verified`:
  //   1. REST: authenticated GET /2.0/repositories/<workspace>/<repo> with
  //      Authorization: Bearer <token> -- a 401/403 is rest_unauthorized,
  //      anything else non-2xx (or no answer) is rest_failed.
  //   2. git: ls-remote against the member's origin (as its https form, so the
  //      just-deployed helper is what authenticates) with prompts disabled --
  //      git_auth_failed for a rejected/missing credential, git_failed else.
  // Commands are built for the member's own OS/shell. The token only ever
  // lives in the executed command; no message or reason carries it.
  async testConnectivity(agent, exec, _scopeUrl?, credentials?) {
    const creds = credentials as Partial<BitbucketCredentials> | undefined;
    if (!creds?.api_token || !creds.workspace || !SLUG_RE.test(creds.workspace)) {
      return {
        success: true,
        skipped: true,
        message: 'Skipped (no Bitbucket API token and valid workspace to verify with)',
      };
    }
    const origin = await resolveOriginRef(agent, exec);
    if (!origin) {
      return {
        success: true,
        skipped: true,
        message: 'Skipped (no Bitbucket origin remote known for this member)',
      };
    }
    const cmds = getOsCommands(getAgentOS(agent), getAgentShell(agent));
    const target = `${creds.workspace}/${origin.repo}`;

    const restUrl = `https://api.${HOST}/2.0/repositories/${creds.workspace}/${origin.repo}`;
    let status = '';
    try {
      const out = await exec(cmds.httpGetStatusWithBearer(restUrl, creds.api_token));
      status = out.trim().split(/\s+/).pop() ?? '';
    } catch {
      status = '';
    }
    if (status === '401' || status === '403') {
      return fail('rest_unauthorized', `REST GET repositories/${target} was rejected (HTTP ${status})`);
    }
    if (!/^2\d\d$/.test(status)) {
      const why = /^\d{3}$/.test(status) ? `HTTP ${status}` : 'no HTTP response';
      return fail('rest_failed', `REST GET repositories/${target} failed (${why})`);
    }

    const gitUrl = `https://${HOST}/${origin.workspace}/${origin.repo}.git`;
    try {
      const out = await exec(cmds.gitLsRemoteNonInteractive(gitUrl));
      if (!out.includes(GIT_LS_REMOTE_OK_MARKER)) {
        return fail('git_failed', `git ls-remote ${gitUrl} did not complete`);
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      return GIT_AUTH_FAILURE_RE.test(text)
        ? fail('git_auth_failed', `git ls-remote ${gitUrl} was refused (authentication failed)`)
        : fail('git_failed', `git ls-remote ${gitUrl} failed`);
    }

    return {
      success: true,
      reason: 'ok',
      message: `Bitbucket verified: REST repositories/${target} and git ls-remote ${gitUrl} succeeded`,
    };
  },
};

function fail(reason: string, detail: string): VcsDeployResult {
  return { success: false, reason, message: `Bitbucket verification failed: ${reason} -- ${detail}` };
}
