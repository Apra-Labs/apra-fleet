/**
 * GenericGitVCS -- the portable base provider for VCSModule.classifyFailure().
 *
 * Owns ONLY the texts any git/OpenSSH client emits regardless of who hosts the
 * remote. Anything with a vendor's name, product literal or error code in it
 * belongs in that vendor's provider file (see ./github.mjs), never here.
 *
 * Every provider file has this exact shape, and adding a provider means adding
 * one more file like it (plus one registration line in ./index.mjs) -- never a
 * change to classifyFailure's dispatch contract:
 *
 *   {
 *     name:       string                  // the `provider` value callers pass
 *     extends:    string|null             // provider whose rules are inherited
 *     rules:      { [VCS_FAILURE_KIND]: RegExp[] }
 *     precedence: string[]|undefined      // optional kind-check order override
 *     extractProviderCode: (raw) => string|null
 *   }
 *
 * PURITY: every regex here is non-global on purpose. A module-level /g regex
 * retains `lastIndex` between calls, which would make classifyFailure return
 * different answers for the same input on successive calls.
 *
 * PARITY CONSTRAINT (apra-fleet-647.1.3.1 AC2): the DIVERGED and TRANSIENT
 * tables below are runner.js's GIT_DIVERGED_PATTERNS / GIT_TRANSIENT_PATTERNS
 * verbatim, and the AUTH tables are the six PORTABLE members of
 * GIT_AUTH_PATTERNS / DOLT_AUTH_PATTERNS (those two lists are identical; their
 * two remaining members are GitHub literals and live in ./github.mjs). This is
 * what lets apra-fleet-647.1.3.2 delete those tables and delegate with no
 * verdict change.
 *
 * DELIBERATELY NOT FOLDED IN: dolt-sync.mjs's DOLT_TRANSIENT_PATTERNS is
 * BROADER than the git set (bare /lock/i, /database is locked/i, /dial tcp/i,
 * /connection refused/i, /server (is )?(starting|not ready|unavailable)/i,
 * /unable to (access|connect)/i), and dolt has two extra classes with no
 * neutral kind yet (empty-remote, remote-unreachable). Folding dolt's wider
 * transient set in here would silently widen GIT classification -- a git stderr
 * merely containing "lock" is 'unknown' (never retried) today and would start
 * being retried. A dolt delegation must add its own provider file and the two
 * missing kinds; it must not widen this one.
 *
 * ASCII only.
 */

import { VCS_FAILURE_KINDS as K } from '../errors.mjs';

/** Non-fast-forward / unmerged / conflicted. Verbatim GIT_DIVERGED_PATTERNS. */
const DIVERGED = [
    /not possible to fast-forward/i,
    /non-fast-forward/i,
    /fast-forwards? are not allowed/i,
    /\[rejected\]/i,
    /failed to push some refs/i,
    /updates were rejected/i,
    /unmerged/i,
    /needs merge/i,
    /would be overwritten/i,
    /^conflict/im,
    /automatic merge failed/i,
    /have diverged/i,
];

/** Credential missing / stale / rejected as invalid -- re-provisioning can fix
 *  it. git and OpenSSH emit all of these with no vendor involvement: the first
 *  three are git's credential-helper prompts (or their suppression), and the
 *  last is git's own refusal text for basic-auth-over-HTTPS. */
const AUTH_EXPIRED = [
    /could not read Username for/i,
    /could not read Password for/i,
    /terminal prompts disabled/i,
    /Authentication failed/i,
    /support for password authentication was removed/i,
];

/** Identity understood, access refused. OpenSSH offered a key and the server
 *  rejected it: minting the same credential again cannot help. */
const AUTH_DENIED = [
    /Permission denied \(publickey\)/i,
];

/** Network / lock blips a plain retry can clear. Verbatim
 *  GIT_TRANSIENT_PATTERNS -- including the two dispatch-channel texts, which
 *  are a transient failure of the fleet transport rather than of git, and must
 *  be retried rather than left 'unknown' (which is sprint-fatal). */
const TRANSIENT = [
    /could not resolve host/i,
    /unable to access/i,
    /connection (timed out|reset|refused)/i,
    /operation timed out/i,
    /\btimed out\b/i,
    /\btimeout\b/i,
    /temporary failure/i,
    /early eof/i,
    /rpc failed/i,
    /the remote end hung up/i,
    /index\.lock/i,
    /unable to create '.*lock'/i,
    /cannot lock ref/i,
    /ssh_exchange_identification/i,
    /transport failure while executing command/i,
    /fetch failed/i,
];

/** No remote configured at all -- nothing to push or pull. Kept narrow on
 *  purpose: these must never swallow a real failure that merely mentions the
 *  word "remote". */
const NO_REMOTE = [
    /error 1105.*no remote/i,
    /\bno remote\b/i,
    /no such remote/i,
];

/** VCSModule's OWN refusal texts (vcs-module.mjs buildVcsCommand). Kept to
 *  exactly those two literals -- a broad /not supported/i would capture
 *  unrelated remote chatter. */
const UNSUPPORTED_OPERATION = [
    /unsupported VCS provider/i,
    /does not yet implement action/i,
];

export const GenericGitVCS = Object.freeze({
    name: 'generic-git',
    extends: null,
    rules: Object.freeze({
        [K.DIVERGED]: DIVERGED,
        [K.AUTH_EXPIRED]: AUTH_EXPIRED,
        [K.AUTH_DENIED]: AUTH_DENIED,
        [K.TRANSIENT]: TRANSIENT,
        [K.NO_REMOTE]: NO_REMOTE,
        [K.UNSUPPORTED_OPERATION]: UNSUPPORTED_OPERATION,
    }),
    /** Portable git stderr carries no vendor error code. */
    extractProviderCode() {
        return null;
    },
    /** Catch-all for VCSModule.capabilities() host dispatch (apra-fleet-
     *  647.1.4.1): every resolvable host matches SOME provider, and this is
     *  the fallback when no more specific provider (e.g. GitHubVCS) claims
     *  it, so resolveVcsProviderForHost() never returns nothing. */
    matchesHost() {
        return true;
    },
    /** No REST create-pull-request implementation exists for a generic/
     *  unrecognized host (Azure DevOps, GitLab, or anything else VCSModule
     *  has no provider for yet) -- fails closed, never guesses a vendor. */
    capabilitiesForHost() {
        return { canOpenPullRequest: false };
    },
});

export default GenericGitVCS;
