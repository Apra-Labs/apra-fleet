/**
 * GitHubVCS -- the GitHub provider for VCSModule.classifyFailure().
 *
 * Owns ONLY GitHub's own literals and inherits everything portable from
 * GenericGitVCS via `extends` (a GitHub push still fails with plain git and
 * OpenSSH texts, so those must not be duplicated here). Inherited patterns are
 * checked too; this file's patterns are checked FIRST within each kind, so a
 * provider can always sharpen a base verdict without editing the base.
 *
 * PARITY NOTE (apra-fleet-647.1.3.1 AC2): the two members of runner.js's
 * GIT_AUTH_PATTERNS / DOLT_AUTH_PATTERNS that are GitHub-specific live here.
 * Together with GenericGitVCS's six, `provider: 'github'` reproduces those
 * lists EXACTLY -- which is why 'github' is classifyFailure's default provider
 * (see vcs-module.mjs): runner.js applies the full eight unconditionally today,
 * so anything less would be a verdict regression for apra-fleet-647.1.3.2.
 *
 * PURITY: non-global regexes only -- see the note in ./generic-git.mjs.
 *
 * ASCII only.
 */

import { VCS_FAILURE_KINDS as K } from '../errors.mjs';

/** GitHub's credential-rejection literals. "remote: Invalid username or
 *  token/password" is what a git push over HTTPS gets back from GitHub with a
 *  dead PAT; "Bad credentials" is the REST API's equivalent, which reaches us
 *  through the curl commands VCSModule builds. Both mean the token itself is
 *  no longer good -- re-provisioning is the remedy, so AUTH_EXPIRED. */
const AUTH_EXPIRED = [
    /remote: Invalid username or (token|password)/i,
    /Bad credentials/i,
];

// DELIBERATELY ABSENT, and not an oversight: GitHub texts that are NOT in
// runner.js's pattern tables today -- scope/permission refusals ("Resource not
// accessible by integration", the vague "remote: Repository not found" for a
// private repo) and throttling ("API rate limit exceeded", "secondary rate
// limit"). Each classifies as 'unknown' today, so adding it here would CHANGE
// the verdict apra-fleet-647.1.3.2 must preserve: a rate-limit text would newly
// become retryable, a permission refusal would newly trigger the auth
// self-heal. Widening the taxonomy is a real behavior change and belongs in its
// own bead with its own tests, not smuggled in under a no-verdict-change
// consolidation.

/** Best-effort GitHub provider code, purely DIAGNOSTIC: never branch on it --
 *  branch on `kind`. Returns the HTTP status git/curl surfaced (e.g. '403'
 *  from git's "The requested URL returned error: 403", or the trailing status
 *  code the VCSModule curl commands append via -w '\n%{http_code}'), else null.
 *
 * Constructed in-function rather than hoisted: these are exec/match calls on
 * patterns that must never carry `lastIndex` state between classifyFailure
 * calls (AC3 purity).
 */
function extractProviderCode(raw) {
    const text = String(raw == null ? '' : raw);
    const urlError = text.match(/requested URL returned error:\s*(\d{3})/i);
    if (urlError) return urlError[1];
    const httpStatus = text.match(/\bHTTP(?:\/[\d.]+)?\s+(\d{3})\b/);
    if (httpStatus) return httpStatus[1];
    const trailing = text.match(/(?:^|\n)\s*(\d{3})\s*$/);
    if (trailing) return trailing[1];
    return null;
}

export const GitHubVCS = Object.freeze({
    name: 'github',
    extends: 'generic-git',
    rules: Object.freeze({
        [K.AUTH_EXPIRED]: AUTH_EXPIRED,
    }),
    extractProviderCode,
});

export default GitHubVCS;
