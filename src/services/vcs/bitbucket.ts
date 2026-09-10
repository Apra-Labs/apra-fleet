/**
 * Bitbucket VCS provider — deploys API token credentials via git credential helper.
 */

import type { VcsProviderService, VcsDeployResult, BitbucketCredentials } from './types.js';

const HOST = 'bitbucket.org';

export const bitbucketProvider: VcsProviderService = {
  // apra-fleet-5co8.3.1: moved VERBATIM out of the provider switch in
  // src/tools/provision-vcs-auth.ts -- same three required fields, same error
  // text, same returned shape. No auth-mode axis (one API-token form only).
  buildCredentials(input) {
    if (!input.email || !input.api_token || !input.workspace) {
      return 'Bitbucket requires "email", "api_token", and "workspace" fields.';
    }
    return { email: input.email, api_token: input.api_token, workspace: input.workspace };
  },

  // apra-fleet-5co8.3.1: the former
  // `if (provider === 'bitbucket' && api_token === undefined)` block, verbatim.
  missingCredential: {
    field: 'api_token',
    isMissing: (input) => input.api_token === undefined,
    promptFor: (memberName) => `Enter Bitbucket API token for ${memberName}`,
  },

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
