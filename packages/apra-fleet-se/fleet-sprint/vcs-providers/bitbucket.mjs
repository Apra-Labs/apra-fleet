/**
 * BitbucketVCS -- the Bitbucket provider entry (apra-fleet-647.1.5.1).
 *
 * Registered so Bitbucket is a first-class member of the SAME registry that
 * drives classifyFailure(), resolveProvider() and buildVcsCommand() --
 * before this file existed, 'bitbucket' was only a name-keyed entry in
 * vcs-module.mjs's now-deleted BUILDERS/DEFAULT_AUTH_MODES tables, which a
 * new provider had to also edit.
 *
 * No auth-mode axis of its own (Bitbucket authenticates via a single app
 * password / token field at provision_vcs_auth time, same as Azure DevOps --
 * see ./azure-devops.mjs), and no REST create-pull-request/comment builders
 * implemented yet -- both are DELIBERATELY absent (`builders: null`) rather
 * than guessed at, so buildVcsCommand() fails closed with a clear ASCII
 * "ERROR: ... does not yet implement action ..." instead of silently
 * building a wrong command. Declaring `defaultAuthMode` (even as `null`) is
 * what makes 'bitbucket' part of resolveProvider()'s known vocabulary -- see
 * ./index.mjs's isAuthBackend().
 *
 * Extends GenericGitVCS for stderr classification (Bitbucket speaks plain
 * git-over-HTTPS/SSH; it had no vendor-specific auth literal in the parity
 * corpus before apra-fleet-417.6 -- see generic-git.mjs's own header note on
 * what belongs portable vs. vendor-specific).
 *
 * apra-fleet-417.6: 'remote: Invalid or expired app password.' is
 * Bitbucket's own literal for a dead/rotated app password, reached without
 * git's generic "fatal: Authentication failed" tail (e.g. over a transport
 * that does not append it). The text says "expired" outright, and
 * re-provisioning a fresh app password is exactly the fix, so AUTH_EXPIRED
 * (contrast Azure DevOps' TF401019, which is AUTH_DENIED -- see
 * ./azure-devops.mjs -- because re-minting the same credential there cannot
 * help).
 *
 * ASCII only.
 */

import { VCS_FAILURE_KINDS as K } from '../errors.mjs';

const AUTH_EXPIRED = [
    /Invalid or expired app password/i,
];

export const BitbucketVCS = Object.freeze({
    name: 'bitbucket',
    extends: 'generic-git',
    rules: Object.freeze({
        [K.AUTH_EXPIRED]: AUTH_EXPIRED,
    }),
    defaultAuthMode: null,
    builders: null,
});

export default BitbucketVCS;
