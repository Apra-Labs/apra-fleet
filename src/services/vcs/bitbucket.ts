/**
 * Bitbucket VCS provider — deploys API token credentials via git credential helper.
 */

import type { VcsProviderService, VcsDeployResult, BitbucketCredentials } from './types.js';

const HOST = 'bitbucket.org';

export const bitbucketProvider: VcsProviderService = {
  async deploy(_agent, cmds, exec, credentials, label?, scopeUrl?) {
    const creds = credentials as BitbucketCredentials;
    await exec(cmds.gitCredentialHelperWrite(HOST, creds.email, creds.api_token, label, scopeUrl));
    return {
      success: true,
      message: 'Bitbucket credentials deployed',
      metadata: { workspace: creds.workspace, email: creds.email },
    };
  },

  async revoke(_agent, cmds, exec, label?, scopeUrl?) {
    await exec(cmds.gitCredentialHelperRemove(HOST, label, scopeUrl));
    return { success: true, message: 'Bitbucket credentials revoked' };
  },

  async testConnectivity(_agent, exec) {
    // We need the workspace from the credentials, but testConnectivity only gets the agent.
    // Use a generic Bitbucket API check — the user endpoint works with any valid token.
    try {
      await exec('curl -sf https://api.bitbucket.org/2.0/user');
      return { success: true, message: 'Bitbucket API connectivity verified' };
    } catch {
      return { success: false, message: 'Bitbucket API connectivity check failed' };
    }
  },
};
