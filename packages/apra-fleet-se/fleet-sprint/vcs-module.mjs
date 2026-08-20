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
    listVcsAuthProviders,
    getVcsProvider,
    resolveVcsProviderChain,
    resolveVcsProviderForHost,
} from './vcs-providers/index.mjs';

/**
 * Provider-dispatched command build step. `action` is one of
 * 'create-pull-request' | 'comment'; `params.provider` selects the REST
 * dispatch. Pure and deterministic -- no network I/O, no filesystem access,
 * no randomness (beyond whatever caller-supplied fields it is handed).
 *
 * apra-fleet-647.1.5.1: dispatches through the vcs-providers/ registry --
 * each provider's own command builders live as a `builders` field on its
 * descriptor (see ./vcs-providers/github.mjs) rather than in a second
 * provider-name-keyed table here. Adding a provider's builders is therefore
 * one file under vcs-providers/, never a change to this function.
 *
 * Returns { provider, action, command, logSafeCommand, interpret }.
 * Throws an Error whose message starts with the ASCII marker "ERROR:" for an
 * unsupported/unknown provider or missing required fields, rather than
 * silently building a wrong command.
 */
function buildVcsCommand(action, params) {
    const provider = params && params.provider;
    const impl = getVcsProvider(provider);
    if (!impl) {
        const known = listVcsAuthProviders().join(', ');
        throw new Error(`ERROR: VCSModule: unsupported VCS provider "${provider}" -- known providers: ${known}.`);
    }
    const builder = impl.builders && impl.builders[action];
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
// Provider resolution (apra-fleet-647.1.2.1; refolded onto the registry
// apra-fleet-647.1.5.1)
// ---------------------------------------------------------------------------
//
// Each provider owns its OWN default auth-mode vocabulary (GitHub: App vs.
// PAT; Bitbucket/Azure DevOps have no such axis -- they always authenticate
// via their own single token field) so a caller (runner.js) never has to
// hardcode a provider-specific mode literal alongside the provider name.
// `null` means "this provider has no separate auth-mode choice at
// provision_vcs_auth call time". That per-provider default now lives as the
// `defaultAuthMode` field on the provider's OWN descriptor (see
// ./vcs-providers/github.mjs, ./vcs-providers/bitbucket.mjs,
// ./vcs-providers/azure-devops.mjs) rather than in a second provider-name-
// keyed table here.
//
// GitHub defaults to 'github-app' (never 'pat') because that is the mode
// runner.js has always hardcoded -- resolveProvider() must reproduce that
// exact behavior for every already-github-provisioned member, not merely a
// plausible one (apra-fleet-647.1.2.1 AC: "Existing GitHub members behave
// exactly as before").

/**
 * Resolve `member`'s persisted VCS provider (and that provider's own default
 * auth mode) from the fleet member registry, via the injected `fleetApi`'s
 * `memberDetail()` (member_detail, the only MCP surface that currently
 * exposes Agent.vcsProvider -- src/tools/member-detail.ts). NO default, NO
 * guessing: an absent or unrecognized vcsProvider is a typed "ERROR:"
 * failure naming the member and the known providers, never a silent GitHub
 * assumption (apra-fleet-647.1.2's whole point).
 *
 * The known-provider vocabulary is listVcsAuthProviders() -- every registered
 * vcs-providers/ descriptor that declares its own `defaultAuthMode` (this
 * module's single manifest of member-facing VCS auth backends it is aware of
 * at all; see ./vcs-providers/index.mjs's isAuthBackend()) -- so a provider
 * added there is automatically recognized here too, no second list to keep
 * in sync.
 *
 * @param {string} member
 * @param {{ fleetApi: { memberDetail: (opts: { member_name: string, format?: string }) => Promise<any> } }} opts
 * @returns {Promise<{ provider: string, authMode: string|null }>}
 */
export async function resolveProvider(member, { fleetApi } = {}) {
    if (!fleetApi || typeof fleetApi.memberDetail !== 'function') {
        throw new Error(`ERROR: VCSModule: resolveProvider requires an injected fleetApi.memberDetail() -- cannot resolve a VCS provider for member '${member}' without one.`);
    }
    const known = listVcsAuthProviders();

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

    const impl = getVcsProvider(provider);
    return { provider, authMode: impl && Object.prototype.hasOwnProperty.call(impl, 'defaultAuthMode') ? impl.defaultAuthMode : null };
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

/**
 * Adapter from the neutral taxonomy to dolt-sync.mjs's legacy classifyDoltFailure
 * verdict vocabulary (apra-fleet-647.1.3.2), so classifyDoltFailure can delegate
 * to classifyFailure(raw, { provider: 'dolt' }) with NO verdict change. The
 * companion of toGitVerdict() above -- same collapsing rules, but preserves the
 * three dolt-only benign/fatal kinds (NO_REMOTE, EMPTY_REMOTE,
 * REMOTE_UNREACHABLE) that git has no equivalent of, instead of folding them
 * into 'unknown'.
 *
 * Both AUTH kinds collapse to 'auth' -- classifyDoltFailure has never
 * distinguished them (DoltVCS's own AUTH_EXPIRED table already carries every
 * dolt auth literal, including the publickey-refusal one; see dolt.mjs).
 *
 * @param {string} kind - a VCS_FAILURE_KINDS member
 * @returns {'no-remote'|'empty-remote'|'remote-unreachable'|'auth'|'diverged'|'transient'|'unknown'}
 */
export function toDoltVerdict(kind) {
    switch (kind) {
        case VCS_FAILURE_KINDS.NO_REMOTE: return 'no-remote';
        case VCS_FAILURE_KINDS.EMPTY_REMOTE: return 'empty-remote';
        case VCS_FAILURE_KINDS.REMOTE_UNREACHABLE: return 'remote-unreachable';
        case VCS_FAILURE_KINDS.DIVERGED: return 'diverged';
        case VCS_FAILURE_KINDS.AUTH_EXPIRED:
        case VCS_FAILURE_KINDS.AUTH_DENIED: return 'auth';
        case VCS_FAILURE_KINDS.TRANSIENT: return 'transient';
        default: return 'unknown';
    }
}

// ---------------------------------------------------------------------------
// capabilities(remoteUrl) (apra-fleet-647.1.4.1)
// ---------------------------------------------------------------------------
//
// The ONE place a git remote URL is parsed into a host and classified for PR
// capability -- replaces runner.js's isHostedGithubRemote(), whose regex
// hardcoded 'github.com' literally and treated every other host (Azure
// DevOps, GitLab, GitHub Enterprise, ...) as "non-hosted" by default. Here
// the URL is parsed into a bare host and the decision is delegated to
// whichever registered provider's matchesHost() claims it (see
// resolveVcsProviderForHost() in ./vcs-providers/index.mjs) -- so a provider
// added later (e.g. a real Azure DevOps/GitLab implementation) gains
// capability recognition for free, with zero change here.

/**
 * Parse a git remote URL into its scheme and bare lowercase host, or null for
 * anything unresolvable (missing/empty/malformed). Accepts the three shapes
 * runner.js's PR-gate call sites can see:
 *   - a normal URL with a scheme:    https://[user@]host/owner/repo(.git)
 *                                     ssh://[user@]host/owner/repo
 *                                     file:///path/to/bare.git
 *   - scp-like SSH shorthand with NO scheme: user@host:owner/repo(.git)
 * @param {unknown} remoteUrl
 * @returns {{ scheme: string, host: string|null } | null}
 */
function parseRemote(remoteUrl) {
    const url = String(remoteUrl ?? '').trim();
    if (!url) return null;

    // scp-like shorthand (e.g. git@github.com:owner/repo.git) has no
    // `scheme://` prefix at all, which `new URL()` cannot parse -- detect and
    // extract the host directly. Guarded by the scheme-prefix test so an
    // actual `ssh://user@host/...` URL (which DOES have a scheme) falls
    // through to the URL branch below instead.
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
        const scpMatch = /^[^@\s/]+@([^:\s/]+):/.exec(url);
        if (scpMatch) return { scheme: 'ssh', host: scpMatch[1].toLowerCase() };
        return null;
    }

    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }
    const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
    if (scheme === 'file') return { scheme: 'file', host: null };
    const host = parsed.hostname ? parsed.hostname.toLowerCase() : null;
    if (!host) return null;
    return { scheme, host };
}

/**
 * Answer what a git 'origin' remote supports, dispatched through the
 * resolved provider implementation -- NOT a literal host list. Used by
 * runner.js's Publish-PR non-hosted-remote gate and finalizeAbort's
 * abort-PR gate; both replace their former isHostedGithubRemote() call with
 * this.
 *
 * Behavior preserved from isHostedGithubRemote() (apra-fleet-647.1.4 AC):
 *   - a `file://` remote:                  hasRemote:true, canOpenPullRequest:false
 *   - missing/empty/unresolvable URL:      hasRemote:false, canOpenPullRequest:false (fails closed)
 *   - a `github.com` remote (any of the 3 URL shapes isHostedGithubRemote
 *     recognized): canOpenPullRequest:true, same as before.
 * NEW behavior (the whole point of apra-fleet-647.1.4): a GitHub Enterprise
 * host, or any other resolvable host, is classified by asking its provider
 * rather than being bucketed into "non-hosted" purely for not being
 * literally 'github.com'.
 *
 * @param {unknown} remoteUrl
 * @returns {{ hasRemote: boolean, canOpenPullRequest: boolean, host: string|null }}
 */
export function capabilities(remoteUrl) {
    const parsed = parseRemote(remoteUrl);
    if (!parsed) return { hasRemote: false, canOpenPullRequest: false, host: null };
    if (parsed.scheme === 'file') return { hasRemote: true, canOpenPullRequest: false, host: null };

    const provider = resolveVcsProviderForHost(parsed.host);
    const providerCaps = (provider && typeof provider.capabilitiesForHost === 'function')
        ? provider.capabilitiesForHost(parsed.host)
        : { canOpenPullRequest: false };
    return { hasRemote: true, canOpenPullRequest: !!providerCaps.canOpenPullRequest, host: parsed.host };
}

/**
 * Resolve a git remote URL into the repository coordinates its OWN provider
 * defines, by dispatching to that provider's optional parseRepoRef() hook
 * (apra-fleet-5co8.1.2). This is the shared half of the remote-URL axis: the
 * host is parsed here, the provider is chosen by the registry, and every
 * provider-specific rule -- which URL shapes are legal, what the coordinates
 * are called, what shape to tell the operator to use -- lives in the provider
 * file, so no caller (runner.js in particular) needs a provider conditional.
 *
 * Three outcomes, deliberately distinct so a caller can tell "not my business"
 * apart from "your remote is wrong":
 *   - null            no provider claims this host, or the claiming provider
 *                     has no parseRepoRef hook. The caller keeps its own
 *                     generic owner/repo parse -- behavior unchanged for
 *                     GitHub and every other provider.
 *   - { canonical, ref, provider }
 *                     the provider recognized the remote; `canonical` is its
 *                     display/identity key (e.g. org/project/repo for Azure
 *                     DevOps) and `ref` the full coordinate object.
 *   - { error }       the provider CLAIMS this host but does not recognize the
 *                     URL -- a malformed remote, not an unknown one. A typed
 *                     'ERROR: ' string naming the shape the provider expects
 *                     (its optional `repoRefHint`), for the caller to surface
 *                     as a preflight failure rather than proceeding with
 *                     half-parsed coordinates.
 *
 * @param {unknown} remoteUrl
 * @returns {{ canonical: string, ref: object, provider: string }|{ error: string }|null}
 */
export function parseProviderRepoRef(remoteUrl) {
    const url = String(remoteUrl ?? '').trim();
    const parsed = parseRemote(url);
    if (!parsed || !parsed.host) return null;

    const provider = resolveVcsProviderForHost(parsed.host);
    if (!provider || typeof provider.parseRepoRef !== 'function') return null;

    const ref = provider.parseRepoRef(url);
    if (ref && typeof ref.canonical === 'string' && ref.canonical) {
        return { canonical: ref.canonical, ref, provider: provider.name };
    }

    const hint = (typeof provider.repoRefHint === 'string' && provider.repoRefHint.trim())
        ? provider.repoRefHint.trim()
        : '(this provider documents no expected remote shape)';
    return {
        error: `ERROR: git remote '${url}' is claimed by VCS provider '${provider.name}' but is not a repository URL it recognizes; expected the shape ${hint}`,
    };
}

export const VCSModule = {
    buildCreatePrCommand,
    parseProviderRepoRef,
    buildCommentCommand,
    classifyFailure,
    toGitVerdict,
    toDoltVerdict,
    resolveProvider,
    capabilities,
    registerVcsProvider,
    unregisterVcsProvider,
    isKnownVcsProvider,
    listVcsProviders,
    listVcsAuthProviders,
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
    listVcsAuthProviders,
    getVcsProvider,
};

export default VCSModule;
