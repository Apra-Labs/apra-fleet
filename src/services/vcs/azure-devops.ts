/**
 * Azure DevOps VCS provider — deploys PAT credentials via git credential helper.
 * Auth pattern: empty username + PAT as password (matches Azure DevOps docs).
 */

import type { VcsProviderService, VcsDeployResult, AzureDevOpsCredentials } from './types.js';

const HOST = 'dev.azure.com';

function extractOrg(orgUrl: string): string {
  // org_url is e.g. "https://dev.azure.com/myorg" — extract "myorg"
  const match = orgUrl.match(/dev\.azure\.com\/([^/]+)/);
  return match?.[1] ?? orgUrl;
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

  async testConnectivity(_agent, exec) {
    // Use the Projects API as a lightweight connectivity check.
    // The credential helper provides auth automatically for git operations,
    // but for curl we rely on the deployed git credential being available.
    try {
      await exec(`curl -sf https://${HOST}/ -o /dev/null`);
      return { success: true, message: 'Azure DevOps connectivity verified' };
    } catch {
      return { success: false, message: 'Azure DevOps connectivity check failed' };
    }
  },
};
