/**
 * Azure DevOps VCS provider — deploys PAT credentials via git credential helper.
 * Auth pattern: empty username + PAT as password (matches Azure DevOps docs).
 */

import type { VcsProviderService, VcsDeployResult, AzureDevOpsCredentials } from './types.js';
import { knownRepoRemoteUrl } from '../member-remote-url.js';

const HOST = 'dev.azure.com';

function extractOrg(orgUrl: string): string {
  // org_url is e.g. "https://dev.azure.com/myorg" — extract "myorg"
  const match = orgUrl.match(/dev\.azure\.com\/([^/]+)/);
  return match?.[1] ?? orgUrl;
}

// apra-fleet-5co8.5.2: a bare org/project scope (the provision default,
// "https://dev.azure.com/<org>") is not a clonable repo -- `git ls-remote`
// needs the full "<org>/<project>/_git/<repo>" path. Only treat scopeUrl as a
// usable repo when it already carries that "_git/" segment (i.e. the caller
// explicitly passed a repo-scoped `scope_url`); otherwise there is nothing to
// derive and the caller must fall back to the documented skip.
function repoUrlFromScopeUrl(scopeUrl?: string): string | undefined {
  return scopeUrl && scopeUrl.includes('_git/') ? scopeUrl : undefined;
}

export const azureDevOpsProvider: VcsProviderService = {
  // apra-fleet-5co8.3.2: moved VERBATIM out of the provider switch in
  // src/tools/provision-vcs-auth.ts -- same `pat ?? token` alias, same
  // required-field error text, same unparseable-expiry rejection and the same
  // returned shape (expires_at is always present, undefined when unset).
  // The pat_expires_at check stays defence in depth behind the zod refine in
  // the tool schema: tool-registry casts the MCP payload with `as any`, so a
  // caller can bypass zod, and an unparseable expiry is worse than none at all
  // (NaN silences every checkVcsTokenExpiry comparison and makes
  // scheduleCredentialCleanup fall back to its 55-minute default, auto-revoking
  // the PAT that was just deployed).
  buildCredentials(input) {
    const azPat = input.pat ?? input.token;
    if (!input.org_url || !azPat) return 'Azure DevOps requires "org_url" and "pat" (or "token") fields.';
    if (input.pat_expires_at !== undefined && Number.isNaN(Date.parse(input.pat_expires_at))) {
      return `Azure DevOps "pat_expires_at" is not a parseable date/time: ${input.pat_expires_at}`;
    }
    return { org_url: input.org_url, pat: azPat, expires_at: input.pat_expires_at };
  },

  // apra-fleet-5co8.3.2: the former
  // `if (provider === 'azure-devops' && pat === undefined && token === undefined)`
  // block, verbatim. Either field can carry the PAT, so the credential only
  // counts as missing when BOTH are absent; the collected secret lands in
  // `pat`, which is what buildCredentials prefers.
  missingCredential: {
    field: 'pat',
    isMissing: (input) => input.pat === undefined && input.token === undefined,
    promptFor: (memberName) => `Enter Azure DevOps personal access token for ${memberName}`,
  },

  async deploy(_agent, cmds, exec, credentials, label?, scopeUrl?) {
    const creds = credentials as AzureDevOpsCredentials;
    await exec(cmds.gitCredentialHelperWrite(HOST, '', creds.pat, label, scopeUrl));
    return {
      success: true,
      message: 'Azure DevOps credentials deployed',
      // apra-fleet-5co8.5.1: `expiresAt` (when the caller supplied one --
      // see AzureDevOpsCredentials.expires_at) is what feeds the EXISTING
      // vcsTokenExpiresAt / checkVcsTokenExpiry / scheduleCredentialCleanup
      // plumbing (see provision-vcs-auth.ts), same as GitHub App tokens
      // already do. Absent an expiry, metadata carries no `expiresAt` key at
      // all and that plumbing behaves exactly as it did before this task.
      metadata: {
        org: extractOrg(creds.org_url),
        ...(creds.expires_at ? { expiresAt: creds.expires_at } : {}),
      },
    };
  },

  async revoke(_agent, cmds, exec, label?, scopeUrl?) {
    await exec(cmds.gitCredentialHelperRemove(HOST, label, scopeUrl));
    return { success: true, message: 'Azure DevOps credentials revoked' };
  },

  // apra-fleet-5co8.5.2: replaces the unauthenticated curl-the-org-root stub
  // (it verified nothing -- an unreachable/misconfigured host would 200 just
  // the same as a valid one) with `git ls-remote` against a concrete repo,
  // matching src/services/vcs/github.ts's pattern. `git ls-remote` goes
  // through the git credential helper deploy() already wrote, so the PAT is
  // read from the credential store at exec time and never appears in the
  // command string or any log line. When no concrete repo is known (the
  // common case: gitRepos is an access list of bare identifiers, not a repo
  // URL -- see member-remote-url.ts), skip with a documented message instead
  // of reporting a false success.
  async testConnectivity(agent, exec, scopeUrl?) {
    const repoUrl = knownRepoRemoteUrl(agent) ?? repoUrlFromScopeUrl(scopeUrl);
    if (!repoUrl) {
      return { success: true, message: 'Skipped (no specific Azure DevOps repo known to test)' };
    }
    try {
      await exec(`git ls-remote ${repoUrl} HEAD`);
      return { success: true, message: `git ls-remote ${repoUrl} succeeded` };
    } catch {
      return { success: false, message: `git ls-remote ${repoUrl} failed` };
    }
  },
};
