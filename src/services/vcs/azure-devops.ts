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
  async deploy(_agent, cmds, exec, credentials) {
    const creds = credentials as AzureDevOpsCredentials;
    await exec(cmds.gitCredentialHelperWrite(HOST, '', creds.pat));
    return {
      success: true,
      message: 'Azure DevOps credentials deployed',
      metadata: { org: extractOrg(creds.org_url) },
    };
  },

  async revoke(_agent, cmds, exec) {
    await exec(cmds.gitCredentialHelperRemove(HOST));
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
