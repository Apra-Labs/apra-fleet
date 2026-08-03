/**
 * VCSModule -- orchestrator-side (fleet-se), provider-dispatched command
 * builder for VCS actions raised against a hosted repo provider.
 *
 * Architectural context (apra-fleet-tfx, correction note 2026-08-02): this
 * module lives in the orchestrator (fleet-se, alongside runner.js and the
 * server-side src/services/vcs/ provider seam -- see that seam's
 * VcsProviderService in src/services/vcs/types.ts, which this module's shape
 * mirrors/extends rather than inventing a parallel one). It NEVER runs on the
 * member and NEVER performs network I/O itself. Its only job is: given a
 * provider name and the already-minted credential, deterministically build
 * the exact command (a curl(1) invocation over the provider's REST API) that
 * the member will run via execute_command, plus the metadata a caller needs
 * to interpret that command's output (success / already-exists / error).
 *
 * The member is a dumb executor: it holds no VCS-abstraction code and makes
 * no choice about how the PR gets raised. No vendor CLI (`gh`, `hub`, ...)
 * appears anywhere in the commands this module builds, and there is no
 * server-side fallback -- callers that get an unsupported provider get a
 * clear ASCII "ERROR:" failure, never a silently wrong command.
 *
 * Token-safety invariant (apra-fleet-tfx.7 AC3): the raw token is placed only
 * in the `command` string that is actually dispatched for execution (never
 * echoed by curl itself -- no -v/--trace flag is ever added). Every field
 * meant for logs (`logSafeCommand`) has the token replaced with a fixed
 * redaction marker. Callers must log/echo `logSafeCommand`, never `command`.
 */

import { VCS_FAILURE_KINDS, VCS_RETRYABLE_KINDS } from './errors.mjs';
import {
    DEFAULT_VCS_PROVIDER,
    registerVcsProvider,
    unregisterVcsProvider,
    isKnownVcsProvider,
    listVcsProviders,
    getVcsProvider,
    resolveVcsProviderChain,
} from './vcs-providers/index.mjs';

const GITHUB_API = 'https://api.github.com';
const REDACTED = '***REDACTED***';
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/** Single-quote a string for embedding in a POSIX shell command,
 *  closing/reopening the quote around any embedded single quotes. */
function shQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function assertRepo(repo) {
    const value = String(repo ?? '').trim();
    if (!REPO_RE.test(value)) {
        throw new Error(`ERROR: VCSModule: invalid repo "${repo}" -- expected "owner/name" (e.g. "Apra-Labs/apra-fleet").`);
    }
    return value;
}

function assertToken(token) {
    const value = String(token ?? '');
    if (!value) {
        throw new Error('ERROR: VCSModule: no token supplied -- caller must mint one via provision_vcs_auth before calling VCSModule.');
    }
    return value;
}

/** Build the GitHub REST "create pull request" curl command.
 *  POST /repos/{owner}/{repo}/pulls -- see
 *  https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request */
function buildGitHubCreatePrCommand({ repo, base, head, title, body, token }) {
    const safeRepo = assertRepo(repo);
    const safeToken = assertToken(token);
    if (!base) throw new Error('ERROR: VCSModule: "base" branch is required to build a create-pull-request command.');
    if (!head) throw new Error('ERROR: VCSModule: "head" branch is required to build a create-pull-request command.');
    if (!title) throw new Error('ERROR: VCSModule: "title" is required to build a create-pull-request command.');

    const payload = { title, head, base };
    if (body !== undefined) payload.body = body;
    const payloadJson = JSON.stringify(payload);
    const url = `${GITHUB_API}/repos/${safeRepo}/pulls`;

    const buildCurl = (authToken) => [
        'curl -sS -X POST',
        `-H ${shQuote(`Authorization: Bearer ${authToken}`)}`,
        `-H ${shQuote('Accept: application/vnd.github+json')}`,
        `-H ${shQuote('Content-Type: application/json')}`,
        `-H ${shQuote('X-GitHub-Api-Version: 2022-11-28')}`,
        `-d ${shQuote(payloadJson)}`,
        `-w ${shQuote('\n%{http_code}')}`,
        url,
    ].join(' ');

    return {
        provider: 'github',
        action: 'create-pull-request',
        command: buildCurl(safeToken),
        logSafeCommand: buildCurl(REDACTED),
        // Interpretation contract mirrors the reverted server-side tool
        // (src/tools/create-pull-request.ts) so callers migrating to
        // VCSModule keep the same success/already-exists/error semantics:
        //   - 2xx                          -> success; body has .number/.html_url
        //   - 422 + "already exists" text  -> idempotent success
        //   - anything else                -> error
        interpret: {
            successStatusRange: [200, 299],
            alreadyExistsStatus: 422,
            alreadyExistsPattern: 'already exists',
        },
    };
}

/** Build the GitHub REST "comment on an issue/PR" curl command, used to
 *  annotate an existing PR when a sprint aborts after the PR was already
 *  raised (rather than opening a second PR for the same head).
 *  POST /repos/{owner}/{repo}/issues/{issue_number}/comments -- see
 *  https://docs.github.com/en/rest/issues/comments#create-an-issue-comment */
function buildGitHubCommentCommand({ repo, issue_number: issueNumber, body, token }) {
    const safeRepo = assertRepo(repo);
    const safeToken = assertToken(token);
    if (!issueNumber) throw new Error('ERROR: VCSModule: "issue_number" is required to build a comment command.');
    if (!body) throw new Error('ERROR: VCSModule: "body" is required to build a comment command.');

    const payloadJson = JSON.stringify({ body });
    const url = `${GITHUB_API}/repos/${safeRepo}/issues/${issueNumber}/comments`;

    const buildCurl = (authToken) => [
        'curl -sS -X POST',
        `-H ${shQuote(`Authorization: Bearer ${authToken}`)}`,
        `-H ${shQuote('Accept: application/vnd.github+json')}`,
        `-H ${shQuote('Content-Type: application/json')}`,
        `-H ${shQuote('X-GitHub-Api-Version: 2022-11-28')}`,
        `-d ${shQuote(payloadJson)}`,
        `-w ${shQuote('\n%{http_code}')}`,
        url,
    ].join(' ');

    return {
        provider: 'github',
        action: 'comment',
        command: buildCurl(safeToken),
        logSafeCommand: buildCurl(REDACTED),
        interpret: {
            successStatusRange: [200, 299],
        },
    };
}

const BUILDERS = {
    github: {
        'create-pull-request': buildGitHubCreatePrCommand,
        comment: buildGitHubCommentCommand,
    },
    // bitbucket / azure-devops: not yet implemented. Listed explicitly (rather
    // than left absent) so the dispatch error below can name every provider
    // VCSModule is aware of vs. one it genuinely does not recognize.
    bitbucket: null,
    'azure-devops': null,
};

/**
 * Provider-dispatched command build step. `action` is one of
 * 'create-pull-request' | 'comment'; `params.provider` selects the REST
 * dispatch. Pure and deterministic -- no network I/O, no filesystem access,
 * no randomness (beyond whatever caller-supplied fields it is handed).
 *
 * Returns { provider, action, command, logSafeCommand, interpret }.
 * Throws an Error whose message starts with the ASCII marker "ERROR:" for an
 * unsupported/unknown provider or missing required fields, rather than
 * silently building a wrong command.
 */
function buildVcsCommand(action, params) {
    const provider = params && params.provider;
    const providerBuilders = Object.prototype.hasOwnProperty.call(BUILDERS, provider) ? BUILDERS[provider] : undefined;
    if (!providerBuilders) {
        const known = Object.keys(BUILDERS).join(', ');
        throw new Error(`ERROR: VCSModule: unsupported VCS provider "${provider}" -- known providers: ${known}.`);
    }
    const builder = providerBuilders[action];
    if (!builder) {
        throw new Error(`ERROR: VCSModule: provider "${provider}" does not yet implement action "${action}".`);
    }
    return builder(params);
}

/** Build a "raise a PR" command for the given provider. */
export function buildCreatePrCommand(params) {
    return buildVcsCommand('create-pull-request', params);
}

// ---------------------------------------------------------------------------
// Provider resolution (apra-fleet-647.1.2.1)
// ---------------------------------------------------------------------------
//
// Each provider owns its OWN default auth-mode vocabulary (GitHub: App vs.
// PAT; Bitbucket/Azure DevOps have no such axis -- they always authenticate
// via their own single token field) so a caller (runner.js) never has to
// hardcode a provider-specific mode literal alongside the provider name.
// `null` means "this provider has no separate auth-mode choice at
// provision_vcs_auth call time".
//
// GitHub defaults to 'github-app' (never 'pat') because that is the mode
// runner.js has always hardcoded -- resolveProvider() must reproduce that
// exact behavior for every already-github-provisioned member, not merely a
// plausible one (apra-fleet-647.1.2.1 AC: "Existing GitHub members behave
// exactly as before").
const DEFAULT_AUTH_MODES = Object.freeze({
    github: 'github-app',
    bitbucket: null,
    'azure-devops': null,
});

/**
 * Resolve `member`'s persisted VCS provider (and that provider's own default
 * auth mode) from the fleet member registry, via the injected `fleetApi`'s
 * `memberDetail()` (member_detail, the only MCP surface that currently
 * exposes Agent.vcsProvider -- src/tools/member-detail.ts). NO default, NO
 * guessing: an absent or unrecognized vcsProvider is a typed "ERROR:"
 * failure naming the member and the known providers, never a silent GitHub
 * assumption (apra-fleet-647.1.2's whole point).
 *
 * The known-provider vocabulary is BUILDERS' own key set (this module's
 * single manifest of providers it is aware of at all), so a provider added
 * there is automatically recognized here too -- no second list to keep in
 * sync.
 *
 * @param {string} member
 * @param {{ fleetApi: { memberDetail: (opts: { member_name: string, format?: string }) => Promise<any> } }} opts
 * @returns {Promise<{ provider: string, authMode: string|null }>}
 */
export async function resolveProvider(member, { fleetApi } = {}) {
    if (!fleetApi || typeof fleetApi.memberDetail !== 'function') {
        throw new Error(`ERROR: VCSModule: resolveProvider requires an injected fleetApi.memberDetail() -- cannot resolve a VCS provider for member '${member}' without one.`);
    }
    const known = Object.keys(BUILDERS);

    let res;
    try {
        res = await fleetApi.memberDetail({ member_name: member, format: 'json' });
    } catch (err) {
        throw new Error(`ERROR: VCSModule: resolveProvider could not read the member registry for member '${member}': ${err && err.message ? err.message : err}`);
    }
    const text = typeof res === 'string'
        ? res
        : (res && Array.isArray(res.content) && res.content[0] && typeof res.content[0].text === 'string')
            ? res.content[0].text
            : '';

    let parsed = null;
    try {
        parsed = JSON.parse(text);
    } catch {
        // member_detail returns a plain (non-JSON) string when the member
        // itself cannot be resolved (see resolveMember in
        // src/utils/resolve-member.ts) -- surface that text as-is rather
        // than a generic parse-error message, since it already names the
        // problem (e.g. "no member found matching ...").
        throw new Error(`ERROR: VCSModule: resolveProvider could not resolve member '${member}' from the registry: ${text || '(empty member_detail response)'}`);
    }

    const provider = parsed && typeof parsed.vcsProvider === 'string' ? parsed.vcsProvider : null;
    if (!provider || !known.includes(provider)) {
        throw new Error(`ERROR: VCSModule: resolveProvider: member '${member}' has no registered VCS provider (vcsProvider: ${provider ? `"${provider}"` : '(absent)'}) -- known providers: ${known.join(', ')}. Provision one via provision_vcs_auth with an explicit 'provider' before relying on resolveProvider.`);
    }

    return { provider, authMode: Object.prototype.hasOwnProperty.call(DEFAULT_AUTH_MODES, provider) ? DEFAULT_AUTH_MODES[provider] : null };
}

/** Build a "comment on abort" command for the given provider. */
export function buildCommentCommand(params) {
    return buildVcsCommand('comment', params);
}

// ---------------------------------------------------------------------------
// Failure classification (apra-fleet-647.1.3.1)
// ---------------------------------------------------------------------------
//
// classifyFailure() is the ONE place VCS stderr is ever parsed. No other file
// may carry a regex over a git/dolt/provider error string: add a pattern to a
// provider file under ./vcs-providers/ instead. Downstream code branches on
// the neutral `kind` ALONE -- never on `providerCode`, never on `raw`.
//
// TAXONOMY (the neutral vocabulary; canonical definitions in errors.mjs
// VCS_FAILURE_KINDS)
//
//   kind                   | retryable | meaning                                  | remediation
//   -----------------------+-----------+------------------------------------------+---------------------------
//   AUTH_EXPIRED           | false     | credential missing/stale/invalid         | re-provision, then retry
//   AUTH_DENIED            | false     | identity refused; lacks access           | operator grants access
//   DIVERGED               | false     | non-FF / unmerged / conflicted           | never auto-resolve
//   TRANSIENT              | true      | network / server / lock blip             | retry, bounded
//   NO_REMOTE              | false     | no remote configured; nothing to sync    | none; benign no-op
//   UNSUPPORTED_OPERATION  | false     | action not implemented for this provider | fix the call/config
//   UNKNOWN                | false     | unrecognized -- must surface, not guess  | operator triage
//
// `retryable` is true ONLY for TRANSIENT, and means "safe to re-run the same
// command with NO remediation first". AUTH_EXPIRED is therefore false even
// though the self-heal path retries once -- that retry follows remediation.
//
// PRECEDENCE. Kinds are checked in KIND_PRECEDENCE order and the first match
// wins, so a stderr carrying several signals gets the most dangerous reading:
// DIVERGED before AUTH before TRANSIENT is exactly runner.js's
// classifyGitFailure ordering -- a diverged state must never be misread as a
// retryable blip because its message happens to contain a lock or credential
// word, and an auth failure must never be blindly retried. NO_REMOTE and
// UNSUPPORTED_OPERATION come last because their texts are the narrowest and
// the least dangerous to under-match. A provider may override the order with
// its own `precedence` array (dolt's classifier, for example, promotes
// no-remote to first) without any change here.

const KIND_PRECEDENCE = Object.freeze([
    VCS_FAILURE_KINDS.DIVERGED,
    VCS_FAILURE_KINDS.AUTH_EXPIRED,
    VCS_FAILURE_KINDS.AUTH_DENIED,
    VCS_FAILURE_KINDS.TRANSIENT,
    VCS_FAILURE_KINDS.NO_REMOTE,
    VCS_FAILURE_KINDS.UNSUPPORTED_OPERATION,
]);

/**
 * Classify a failed VCS command's raw stderr/stdout into the neutral taxonomy.
 *
 * PURE: no I/O, no clock, no randomness, no module-level mutable state, and no
 * global (/g) regexes -- calling it twice with the same input always returns a
 * deeply-equal result.
 *
 * NON-THROWING, including for an unknown/absent provider, which falls back to
 * the default provider's chain. This is a DELIBERATE asymmetry with
 * buildVcsCommand() above, which DOES throw "ERROR:" on an unsupported
 * provider: building a wrong command silently would corrupt a repo, whereas a
 * classifier that throws would convert a recoverable sync failure into a crash
 * -- and would do it precisely when something is already going wrong. An
 * unmatched stderr returns UNKNOWN, which is never retried and never
 * self-healed, so a mis-fallback degrades to "surface it", not to a guess.
 *
 * @param {string} rawStderr - the raw stderr/stdout of the failed command
 * @param {{ provider?: string }} [opts] - provider selects the rule chain;
 *   defaults to DEFAULT_VCS_PROVIDER ('github'), which reproduces runner.js's
 *   full auth pattern set exactly.
 * @returns {{ kind: string, providerCode: string|null, retryable: boolean, raw: string }}
 *   `kind` is the ONLY field control flow may branch on. `providerCode` is the
 *   provider-specific token (e.g. an HTTP status, or an Azure DevOps
 *   'TF401019') carried as a DIAGNOSTIC detail. `raw` is the input, normalized
 *   to a string, so a caller can log the evidence behind the verdict.
 */
export function classifyFailure(rawStderr, opts = {}) {
    const raw = String(rawStderr == null ? '' : rawStderr);
    const providerName = (opts && opts.provider) || DEFAULT_VCS_PROVIDER;
    const chain = resolveVcsProviderChain(providerName);

    const precedence = chain.find((p) => Array.isArray(p.precedence))?.precedence || KIND_PRECEDENCE;

    let kind = VCS_FAILURE_KINDS.UNKNOWN;
    outer:
    for (const candidate of precedence) {
        // Most-derived provider first within each kind, so a provider can
        // sharpen a base verdict without editing the base.
        for (const provider of chain) {
            const patterns = (provider.rules && provider.rules[candidate]) || [];
            for (const re of patterns) {
                if (re.test(raw)) {
                    kind = candidate;
                    break outer;
                }
            }
        }
    }

    let providerCode = null;
    for (const provider of chain) {
        if (typeof provider.extractProviderCode === 'function') {
            providerCode = provider.extractProviderCode(raw) ?? null;
            if (providerCode !== null) break;
        }
    }

    return { kind, providerCode, retryable: VCS_RETRYABLE_KINDS.has(kind), raw };
}

/**
 * Adapter from the neutral taxonomy to runner.js's legacy git verdict
 * vocabulary, so apra-fleet-647.1.3.2 can delete GIT_*_PATTERNS and delegate
 * classifyGitFailure() to classifyFailure() with NO verdict change.
 *
 * Both AUTH kinds collapse to 'auth' (today's classifier does not distinguish
 * them). NO_REMOTE and UNSUPPORTED_OPERATION collapse to 'unknown' because git
 * has no such verdict today and 'unknown' is what those texts classify as --
 * preserving parity, not inventing behavior.
 *
 * @param {string} kind - a VCS_FAILURE_KINDS member
 * @returns {'diverged'|'auth'|'transient'|'unknown'}
 */
export function toGitVerdict(kind) {
    switch (kind) {
        case VCS_FAILURE_KINDS.DIVERGED: return 'diverged';
        case VCS_FAILURE_KINDS.AUTH_EXPIRED:
        case VCS_FAILURE_KINDS.AUTH_DENIED: return 'auth';
        case VCS_FAILURE_KINDS.TRANSIENT: return 'transient';
        default: return 'unknown';
    }
}

export const VCSModule = {
    buildCreatePrCommand,
    buildCommentCommand,
    classifyFailure,
    toGitVerdict,
    resolveProvider,
    registerVcsProvider,
    unregisterVcsProvider,
    isKnownVcsProvider,
    listVcsProviders,
    getVcsProvider,
    DEFAULT_VCS_PROVIDER,
};

export {
    VCS_FAILURE_KINDS,
    DEFAULT_VCS_PROVIDER,
    registerVcsProvider,
    unregisterVcsProvider,
    isKnownVcsProvider,
    listVcsProviders,
    getVcsProvider,
};

export default VCSModule;
