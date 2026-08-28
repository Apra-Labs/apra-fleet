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

// apra-fleet-5co8.5.2 (review round 2): a candidate repo URL is only usable
// when it is a well-formed Azure DevOps repo URL -- "https://dev.azure.com/
// <org>/<project>/_git/<repo>" with each segment restricted to characters
// that can never be interpreted as shell metacharacters. This single check
// closes two review defects at once: (1) knownRepoRemoteUrl is host-agnostic
// (see member-remote-url.ts), so without this a cross-host gitRepos entry
// (e.g. a github.com URL) could be ls-remote'd and reported as an Azure
// DevOps connectivity result -- a false success on the wrong host; (2) the
// derived URL is interpolated into a command string executed on the member
// (see below), so an unvalidated value is a command-injection vector. A bare
// org/project scope (the provision default, "https://dev.azure.com/<org>")
// deliberately fails this check -- it is not a clonable repo.
const AZURE_REPO_URL_RE = /^https:\/\/dev\.azure\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/_git\/[A-Za-z0-9._-]+$/;

function isValidAzureRepoUrl(url: string): boolean {
  return AZURE_REPO_URL_RE.test(url);
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
  // command string or any log line. When no concrete, validated repo is
  // known (the common case: gitRepos is an access list of bare identifiers,
  // not a repo URL -- see member-remote-url.ts), skip with a documented
  // message instead of reporting a false success.
  //
  // (review round 2) `scope_url` is what deploy() actually scoped the
  // credential to (gitCredentialHelperWrite writes credential.<scopeUrl>.helper
  // -- see src/os/linux.ts) so a repo-scoped scope_url is preferred over the
  // host-agnostic, access-list-derived gitRepos value; gitRepos is only
  // consulted when scope_url isn't itself a usable repo URL. Both candidates
  // are validated by isValidAzureRepoUrl before use -- see its comment for
  // why an unvalidated candidate is unsafe here.
  async testConnectivity(agent, exec, scopeUrl?) {
    const candidate =
      scopeUrl && isValidAzureRepoUrl(scopeUrl) ? scopeUrl : knownRepoRemoteUrl(agent);
    const repoUrl = candidate && isValidAzureRepoUrl(candidate) ? candidate : undefined;
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
