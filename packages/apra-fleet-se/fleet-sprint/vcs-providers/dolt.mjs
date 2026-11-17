/**
 * DoltVCS -- the Dolt (beads-sync) provider for VCSModule.classifyFailure()
 * (apra-fleet-647.1.3.2).
 *
 * `extends: null` DELIBERATELY -- this does NOT extend GenericGitVCS or
 * GitHubVCS. classifyFailure()'s inheritance walk is ADDITIVE (a provider's
 * own rules are checked FIRST, but every ancestor's rules are still checked
 * too), so extending either would import git-flavored TRANSIENT texts
 * ('fetch failed', 'transport failure while executing command',
 * 'ssh_exchange_identification', ...) into Dolt's classification. Those
 * strings classify 'unknown' (never retried) for dolt today; silently
 * widening TRANSIENT would change that verdict, which apra-fleet-647.1.3.2
 * AC3 (no verdict change) forbids. Every table below is therefore dolt's OWN
 * copy, even where it duplicates a GenericGitVCS/GitHubVCS pattern verbatim
 * (the 8 shared auth literals) -- see generic-git.mjs's "DELIBERATELY NOT
 * FOLDED IN" note, which named this exact tradeoff in advance.
 *
 * PARITY CONSTRAINT: every regex table here is dolt-sync.mjs's own
 * DOLT_*_PATTERNS verbatim (apra-fleet-417.3.1's classifyDoltFailure), so
 * dolt-sync.mjs can delegate to VCSModule.classifyFailure(raw, {provider:
 * 'dolt'}) with NO verdict change.
 *
 * PRECEDENCE (apra-fleet-spp / apra-fleet-417.3.1): no-remote, empty-remote
 * and remote-unreachable are checked first (each is a distinct benign/fatal
 * non-error condition that must win over a looser downstream pattern), THEN
 * auth, THEN diverged, THEN transient -- auth is deliberately checked BEFORE
 * diverged here (the OPPOSITE of GenericGitVCS/GitHubVCS's default
 * DIVERGED-before-AUTH order): a live incident (2026-08-02, fleet-mac) had a
 * `could not read Username for` credential failure misclassified as data
 * divergence by a looser conflict pattern and hard-aborted an otherwise
 * healthy sprint, when the fix was simply to re-provision credentials. A
 * credential failure must never reach 'diverged' for dolt.
 *
 * PURITY: non-global regexes only -- see the note in ./generic-git.mjs.
 *
 * ASCII only.
 */

import { VCS_FAILURE_KINDS as K } from '../errors.mjs';

/** Verbatim DOLT_NO_REMOTE_PATTERNS. */
const NO_REMOTE = [
    /error 1105.*no remote/i,
    /\bno remote\b/i,
];

/** Verbatim DOLT_EMPTY_REMOTE_PATTERNS. */
const EMPTY_REMOTE = [
    /error 1105.*no branches found in remote/i,
    /no branches found in remote/i,
];

/** Verbatim DOLT_REMOTE_UNREACHABLE_PATTERNS.
 *
 *  The first two patterns are guarded with a leading `(?!.*fork\/exec)`
 *  lookahead (checked against the WHOLE remaining string, hence `[\s\S]*`
 *  rather than `.*`, so it also spans the multi-line raw output these
 *  errors come as): Dolt wraps a git subprocess-spawn failure (the OS
 *  refusing to even start git.exe, e.g. a transient Windows CreateProcess
 *  resource error) in this SAME generic "could not be accessed"/"failed to
 *  get remote db" wrapper text it uses for a genuinely dead/misconfigured
 *  remote. Confirmed live: a `fork/exec ... git.exe: Not enough memory
 *  resources` failure was misclassified as REMOTE_UNREACHABLE (permanent,
 *  "retrying cannot succeed") purely from that wrapper phrasing, even
 *  though the remote was correctly configured and reachable -- an
 *  unmodified retry of the identical command succeeded outright, repeatedly.
 *  A `fork/exec` line is Dolt's/Go's structural marker for "the OS refused
 *  to start the child process", as opposed to git actually running and
 *  reporting a real remote problem -- so its presence anywhere in the
 *  output means this ISN'T evidence of a dead remote, and the classifier
 *  must fall through to the TRANSIENT check below instead. A genuinely
 *  dead/misconfigured remote (no fork/exec line present) is unaffected and
 *  still classifies here exactly as before. */
const REMOTE_UNREACHABLE = [
    /^(?![\s\S]*fork\/exec)[\s\S]*could not be accessed/i,
    /^(?![\s\S]*fork\/exec)[\s\S]*failed to get remote db/i,
    /stat [^:]+: no such file or directory/i,
];

/** Verbatim DOLT_AUTH_PATTERNS. dolt-sync.mjs's classifyDoltFailure returns a
 *  single undifferentiated 'auth' (no AUTH_EXPIRED/AUTH_DENIED split), so
 *  every one of these -- including the publickey-refusal literal -- lands in
 *  AUTH_EXPIRED here; toDoltVerdict() collapses both AUTH_* kinds back to
 *  'auth' regardless, so this bucketing is verdict-neutral. */
const AUTH_EXPIRED = [
    /could not read Username for/i,
    /could not read Password for/i,
    /Authentication failed/i,
    /Permission denied \(publickey\)/i,
    /remote: Invalid username or (token|password)/i,
    /terminal prompts disabled/i,
    /support for password authentication was removed/i,
    /Bad credentials/i,
];

/** Verbatim DOLT_DIVERGED_PATTERNS. */
const DIVERGED = [
    /conflict/i,
    /would (be )?overwrit/i,
    /cannot fast[- ]forward/i,
    /not possible to fast[- ]forward/i,
    /non-fast-forward/i,
    /\[rejected\]/i,
    /failed to push/i,
    /updates were rejected/i,
    /remote (is )?ahead/i,
    /behind the remote/i,
    /not up[- ]to[- ]date/i,
    /have diverged/i,
    /merge (is )?required/i,
    /working set (is )?not clean/i,
];

/** Verbatim DOLT_TRANSIENT_PATTERNS.
 *
 *  fork/exec: the OS refused to start git.exe itself (e.g. a transient
 *  Windows CreateProcess resource error) -- see the REMOTE_UNREACHABLE
 *  guard above, which this pattern is the other half of. Deliberately
 *  broad (any fork/exec line, not just the "Not enough memory resources"
 *  wording observed live) since any process-spawn-refusal is the same
 *  class of transient, retry-worthy failure regardless of the OS's exact
 *  phrasing for why it refused. */
const TRANSIENT = [
    /fork\/exec /i,
    /could not resolve host/i,
    /unable to (access|connect)/i,
    /connection (timed out|reset|refused)/i,
    /operation timed out/i,
    /\btimed out\b/i,
    /\btimeout\b/i,
    /temporary failure/i,
    /early eof/i,
    /rpc failed/i,
    /the remote end hung up/i,
    /server (is )?(starting|not ready|unavailable)/i,
    /connection refused/i,
    /dial tcp/i,
    /i\/o timeout/i,
    /database is locked/i,
    /lock/i,
];

const PRECEDENCE = Object.freeze([
    K.NO_REMOTE,
    K.EMPTY_REMOTE,
    K.REMOTE_UNREACHABLE,
    K.AUTH_EXPIRED,
    K.AUTH_DENIED,
    K.DIVERGED,
    K.TRANSIENT,
]);

export const DoltVCS = Object.freeze({
    name: 'dolt',
    extends: null,
    precedence: PRECEDENCE,
    rules: Object.freeze({
        [K.NO_REMOTE]: NO_REMOTE,
        [K.EMPTY_REMOTE]: EMPTY_REMOTE,
        [K.REMOTE_UNREACHABLE]: REMOTE_UNREACHABLE,
        [K.AUTH_EXPIRED]: AUTH_EXPIRED,
        [K.DIVERGED]: DIVERGED,
        [K.TRANSIENT]: TRANSIENT,
    }),
    /** Dolt stderr carries no vendor error code today. */
    extractProviderCode() {
        return null;
    },
    // Deliberately NO matchesHost/capabilitiesForHost: Dolt is a beads-sync
    // backend, not a git-remote PR-hosting provider, so it must never be a
    // candidate in VCSModule.capabilities()'s host dispatch
    // (resolveVcsProviderForHost skips any provider with no matchesHost).
});

export default DoltVCS;
