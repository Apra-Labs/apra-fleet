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
 * git-over-HTTPS/SSH; it has no vendor-specific auth literal in the parity
 * corpus today -- see generic-git.mjs's own header note on what belongs
 * portable vs. vendor-specific).
 *
 * ASCII only.
 */

export const BitbucketVCS = Object.freeze({
    name: 'bitbucket',
    extends: 'generic-git',
    defaultAuthMode: null,
    builders: null,
});

export default BitbucketVCS;
