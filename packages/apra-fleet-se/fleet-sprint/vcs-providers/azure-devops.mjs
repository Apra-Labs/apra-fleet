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
 * TF-numbered error codes (e.g. TF401019) previously were NOT added as a
 * dedicated pattern here, on the reasoning that the realistic full stderr for
 * an expired/invalid Azure DevOps credential over git-over-HTTPS still
 * carries git's own generic "fatal: Authentication failed for '<url>'" tail
 * line, which GenericGitVCS already classifies AUTH_EXPIRED (see
 * test/vcs-nongithub-auth-selfheal.test.mjs, apra-fleet-647.1.3.4).
 *
 * apra-fleet-417.6 (BLOCKS apra-fleet-647.1.3.4's own AC that no non-GitHub
 * provider signal is recognized without that tail): a bare 'remote:
 * TF401019: ...' line -- e.g. a REST/API path, or any transport that does not
 * append git's own tail -- reached classifyFailure() as UNKNOWN before this
 * pattern existed. TF401019's own text ("does not exist, or you do not have
 * permission to perform this operation") is Azure DevOps' deliberately
 * ambiguous repo-not-found-or-no-access message; re-minting the identical PAT
 * cannot fix either case (a missing repo needs creating, a real permission
 * gap needs granting), so this is AUTH_DENIED, not AUTH_EXPIRED -- consistent
 * with vcs-classify-failure.test.mjs's own AC1 example provider, which models
 * TF401019 the same way.
 *
 * ASCII only.
 */

import { VCS_FAILURE_KINDS as K } from '../errors.mjs';

const AUTH_DENIED = [
    /TF401019/,
];

/** Best-effort Azure DevOps TF-numbered error code, purely DIAGNOSTIC: never
 *  branch on it -- branch on `kind`. */
function extractProviderCode(raw) {
    const text = String(raw == null ? '' : raw);
    const match = text.match(/\b(TF\d{6})\b/);
    return match ? match[1] : null;
}

export const AzureDevOpsVCS = Object.freeze({
    name: 'azure-devops',
    extends: 'generic-git',
    rules: Object.freeze({
        [K.AUTH_DENIED]: AUTH_DENIED,
    }),
    extractProviderCode,
    defaultAuthMode: null,
    builders: null,
});

export default AzureDevOpsVCS;
