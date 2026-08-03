/**
 * AzureDevOpsVCS -- the Azure DevOps provider entry (apra-fleet-647.1.5.1).
 *
 * Registered so Azure DevOps is a first-class member of the SAME registry
 * that drives classifyFailure(), resolveProvider() and buildVcsCommand() --
 * before this file existed, 'azure-devops' was only a name-keyed entry in
 * vcs-module.mjs's now-deleted BUILDERS/DEFAULT_AUTH_MODES tables, which a
 * new provider had to also edit.
 *
 * No auth-mode axis of its own (a single PAT token field at
 * provision_vcs_auth time, same as Bitbucket -- see ./bitbucket.mjs), and no
 * REST create-pull-request/comment builders implemented yet -- both are
 * DELIBERATELY absent (`builders: null`) rather than guessed at, so
 * buildVcsCommand() fails closed with a clear ASCII "ERROR: ... does not yet
 * implement action ..." instead of silently building a wrong command.
 * Declaring `defaultAuthMode` (even as `null`) is what makes 'azure-devops'
 * part of resolveProvider()'s known vocabulary -- see ./index.mjs's
 * isAuthBackend().
 *
 * Extends GenericGitVCS for stderr classification. Azure DevOps' own
 * TF-numbered error codes (e.g. TF401019) are NOT added as a dedicated
 * pattern here: the realistic full stderr for an expired/invalid Azure
 * DevOps credential over git-over-HTTPS still carries git's own generic
 * "fatal: Authentication failed for '<url>'" tail line, which GenericGitVCS
 * already classifies AUTH_EXPIRED (see
 * test/vcs-nongithub-auth-selfheal.test.mjs, apra-fleet-647.1.3.4). Adding a
 * TF401019-keyed pattern is real taxonomy-widening behavior and belongs in
 * its own bead with its own tests, not smuggled in here.
 *
 * ASCII only.
 */

export const AzureDevOpsVCS = Object.freeze({
    name: 'azure-devops',
    extends: 'generic-git',
    defaultAuthMode: null,
    builders: null,
});

export default AzureDevOpsVCS;
