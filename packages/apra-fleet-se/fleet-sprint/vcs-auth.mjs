// VCS/LLM auth for fleet-sprint: credential provisioning, credential read-back,
// PR raising, and the reactive/proactive auth self-heal callbacks
// (apra-fleet-3swo.3.1). Moved verbatim out of runner.js -- runner.js re-exports
// every symbol it previously exported from this region, so existing importers of
// fleet-sprint/runner.js resolve unchanged. Behaviour was originally kept
// deliberately identical to the pre-move code (a move-only extraction), but
// apra-fleet-3swo.13 is exactly the "separately-reviewed behaviour PR" that
// note used to point at: it replaced the mojibake provision-result regexes'
// role as the source of truth with structuredContent.ok/.reason
// (provisionOutcome below), keeping the prose regexes only as a fallback for
// a result with no structuredContent at all.
import { ApraFleet } from '@apralabs/apra-fleet-client';
import { buildCreatePrCommand, resolveProvider, capabilities as vcsCapabilities, parseProviderRepoRef, getVcsProvider, resolveVcsAuthProviderForHost, isAuthBackend, VCS_NO_REGISTERED_PROVIDER, DEFAULT_VCS_PROVIDER } from './vcs-module.mjs';
import { getSeCommands } from './se-os-commands.mjs';
import { resolveMemberTarget } from './member-target.mjs';
import { resultText } from './mcp-result.mjs';

/**
 * Best-effort, GENERIC extraction of an "owner/repo" string from a git remote
 * URL (https, scp-like git@host:owner/repo(.git), or ssh://). Deliberately
 * target-agnostic: fleet-sprint develops many different repos, so the `repos`
 * argument passed to provision_vcs_auth must be DERIVED at runtime from the
 * member's own git remote, never hardcoded to a literal repo name. Returns
 * null on anything unrecognized so the caller can omit `repos` (optional
 * server-side) rather than guess.
 *
 * @param {string|null|undefined} url
 * @returns {string|null}
 */
export function parseOwnerRepoFromRemoteUrl(url) {
    const text = String(url == null ? '' : url).trim();
    if (!text) return null;
    let m = text.match(/^https?:\/\/[^/]+\/([^/]+)\/([^/]+?)(\.git)?\/?$/i);
    if (m) return `${m[1]}/${m[2]}`;
    m = text.match(/^ssh:\/\/[^@/]+@[^/]+\/([^/]+)\/([^/]+?)(\.git)?\/?$/i);
    if (m) return `${m[1]}/${m[2]}`;
    // scp-like syntax, e.g. git@github.com:owner/repo.git
    m = text.match(/^[\w.-]+@[^:]+:([^/]+)\/([^/]+?)(\.git)?\/?$/i);
    if (m) return `${m[1]}/${m[2]}`;
    return null;
}

/**
 * Resolve the `repos` scope for a member's git remote (apra-fleet-5co8.1.2).
 *
 * The two-line-generic parse above cannot express every provider's repository
 * identity: Azure DevOps' is org/project/repo behind a '_git' marker, which
 * the owner/repo regexes score as "unrecognized" (null) and therefore silently
 * drop the repos scope. So the URL is first offered to whichever registered
 * provider CLAIMS its host, via VCSModule.parseProviderRepoRef() -> that
 * provider's own parseRepoRef hook, and only falls back to the generic parse
 * when no provider claims the host or the claiming one has no hook. Every
 * provider-specific rule (legal URL shapes, coordinate names, remedy text)
 * stays in the provider file: this function -- and runner.js as a whole --
 * never names or branches on a provider.
 *
 * A host CLAIMED by a provider whose hook rejects the URL is a different
 * failure from an unrecognized one: the remote is malformed, and proceeding
 * with no scope would provision credentials against the wrong (or no) repo.
 * That case returns a typed `error` naming the shape the provider expects, for
 * the caller to raise as a PREFLIGHT failure -- not a stderr classification.
 *
 * `ref` carries the provider's full coordinate object when one was produced
 * (null otherwise), so a caller can hand it back to that same provider's other
 * hooks -- e.g. buildProvisionArgs, which derives an org URL from it
 * (apra-fleet-5co8.2.1) -- without re-parsing or interpreting it here.
 *
 * @param {string|null|undefined} url
 * @returns {{ repo: string|null, ref: object|null, error: string|null }}
 */
export function parseRepoScopeFromRemoteUrl(url) {
    const text = String(url == null ? '' : url).trim();
    if (!text) return { repo: null, ref: null, error: null };

    const providerRef = parseProviderRepoRef(text);
    if (providerRef && providerRef.error) return { repo: null, ref: null, error: providerRef.error };
    if (providerRef && providerRef.canonical) return { repo: providerRef.canonical, ref: providerRef.ref, error: null };

    return { repo: parseOwnerRepoFromRemoteUrl(text), ref: null, error: null };
}

/**
 * Read the credential-store entry NAMES (never values) currently registered on
 * the hub, for a provider hook that needs to fail fast when the secret it
 * intends to reference as a {{secret.NAME}} placeholder does not exist
 * (apra-fleet-5co8.2.1).
 *
 * Returns null -- not an empty list -- when the store cannot be read or its
 * response cannot be parsed, so a hook can tell "the store definitely lacks
 * this entry" apart from "unknown" and skip the check rather than emit a
 * false, sprint-stopping ERROR. A genuinely missing secret still fails loudly
 * hub-side when placeholder resolution runs.
 *
 * @param {object} fleetApi
 * @returns {Promise<string[]|null>}
 */
async function listCredentialStoreNames(fleetApi) {
    if (!fleetApi || typeof fleetApi.credentialStoreList !== 'function') return null;
    try {
        const parsed = JSON.parse(resultText(await fleetApi.credentialStoreList()));
        if (!Array.isArray(parsed)) return null;
        return parsed
            .map((entry) => (entry && typeof entry.name === 'string' ? entry.name : null))
            .filter((name) => name !== null);
    } catch {
        return null;
    }
}

/**
 * Build the provision_vcs_auth arguments for a member, dispatched through the
 * resolved provider's OPTIONAL buildProvisionArgs hook (apra-fleet-5co8.2.1).
 *
 * A provider with no hook gets `base` verbatim -- the GitHub-App-shaped
 * `git_access`/`repos` arguments this function has always sent -- so nothing
 * changes for GitHub or any other existing provider. A provider WITH a hook
 * owns its own argument shape entirely, including which credential-store entry
 * it references and what remedy text a missing one prints. No provider name,
 * no auth-mode knowledge and no raw credential value appears here.
 *
 * `remoteUrl` / `remoteReadError` are passed through so a hook can (a) bind
 * the credential to the host the member actually pushes to and (b) word an
 * underivable-org error by its real cause -- an unreadable remote is not a
 * malformed one. A hook may also return a `note`, logged verbatim: an
 * advisory the operator should see (e.g. an ssh remote the PAT cannot
 * serve) that is NOT a failure.
 *
 * apra-fleet-qeq1.9: a hook may also answer `{ skip: true }` -- "this
 * provider has nothing to provision for THIS request, proceed on the
 * credential already deployed". That is a third answer, distinct from both
 * `args` (dispatch these) and `error` (fail): a provider whose credential is
 * deployed out of band and carries no scope axis has no meaningful
 * just-in-time re-provision to run, and forcing a doomed one would abort the
 * very call it is supposed to enable. Reported to the caller as a `null`
 * return -- no provider ever legitimately produces null `args`, and the
 * no-hook path above returns `base`, so null is unambiguous. The skip is
 * never silent: a hook taking it should also return a `note`, logged below
 * exactly like any other advisory.
 *
 * @param {{ provider: string, base: object, repoRef: object|null, fleetApi: object,
 *           secretName?: string, remoteUrl?: string, remoteReadError?: string|null,
 *           log?: Function, logPrefix?: string }} ctx
 * @returns {Promise<object|null>} the arguments to send, or null to skip provisioning entirely
 */
async function buildProvisionArgsForProvider({ provider, base, repoRef, fleetApi, secretName, remoteUrl, remoteReadError, log = () => {}, logPrefix = '' }) {
    const impl = getVcsProvider(provider);
    if (!impl || typeof impl.buildProvisionArgs !== 'function') return base;

    const availableSecrets = await listCredentialStoreNames(fleetApi);
    const built = impl.buildProvisionArgs({ base, repoRef, availableSecrets, secretName, remoteUrl, remoteReadError });
    if (built && typeof built.error === 'string') throw new Error(built.error);
    const skipped = !!(built && built.skip === true);
    if (!built || (!skipped && (!built.args || typeof built.args !== 'object'))) {
        throw new Error(`ERROR: VCS provider '${provider}' returned no provision arguments for member '${base.member_name}'.`);
    }
    if (typeof built.note === 'string' && built.note.trim()) {
        log(`${logPrefix}: note: ${built.note.trim()}`);
    }
    return skipped ? null : built.args;
}

// apra-fleet-3swo.13: provision_vcs_auth / provision_llm_auth used to be
// classified by matching a leading status emoji on the prose summary above
// (check mark = success, cross mark = failure, star = the LLM-auth
// local-member skip marker). The server retired those emoji -- src/tools/
// provision-auth.ts and src/tools/provision-vcs-auth.ts now emit ASCII
// [OK]/[FAIL]/[SKIP] prose -- and wrapTool() (src/services/tool-registry.ts)
// never sets `isError` on any path, so that prose/isError test had gone
// permanently false: a FAILED provision silently read as a success. Both
// tools now also return a `structuredContent` half (ProvisionAuthStructured
// / ProvisionVcsAuthStructured -- see packages/apra-fleet-client/src/client/
// api.mjs) with a machine-readable `ok`/`reason` pair that stays safe to
// branch on regardless of any future prose wording change. Read THAT when
// present; only fall back to the old prose/isError heuristic for a result
// that carries no structuredContent at all (e.g. a test double that mocks a
// bare `{ content }` shape).
function provisionOutcome(result, text) {
    const structured = result && result.structuredContent;
    if (structured && typeof structured.ok === 'boolean') {
        return { ok: structured.ok, reason: typeof structured.reason === 'string' ? structured.reason : null };
    }
    return {
        ok: !((result && result.isError) || /^\[FAIL\]/.test(String(text == null ? '' : text).trim())),
        reason: null,
    };
}

// Shared provisioning core used by BOTH the REACTIVE onAuthFailure self-heal
// (createVcsAuthSelfHealCallback) and the PROACTIVE preflight
// (createVcsAuthPreflightCallback) -- one call shape, one owner/repo
// derivation, one success/failure text-parsing rule, so the two paths can
// never drift on what "provisioned" means.
//
// Returns the newly-provisioned credential's `expiresAt` (a Date, or null
// when the response carries no expiry metadata -- PAT-mode credentials never
// expire) so a caller can cache it and skip a future redundant call.
//
// `gitAccess` defaults to DEFAULT_SYNC_GIT_ACCESS ('push') -- the shared
// self-heal/preflight callers below NEVER override it. The only callers
// permitted to pass a higher level ('push+pr') are the two PR-raising call
// sites (Publish PR, finalizeAbort), each via provisionPrCapableAuthForMember,
// invoked immediately before their PR-creation dispatch -- never at sprint
// setup, never from this shared self-heal/preflight path. See
// apra-fleet-tfx.8 and the just-in-time credential-scoping ADR
// (docs/adr-server-never-acts-on-repo.md) for the rogue-dispatch blast-radius
// rationale: widening this default would give every member standing
// pull_requests:write for the whole sprint.
//
// DEFAULT_SYNC_GIT_ACCESS is exported (not just a bare literal) so the Sync-
// step workflows-permission preflight below (apra-fleet-2wdc.6) can assert
// against the SAME value this function actually requests, rather than
// duplicating the 'push' literal and risking the two silently drifting apart.
export const DEFAULT_SYNC_GIT_ACCESS = 'push';

// GitHub App access levels that request the 'workflows' permission -- mirrors
// src/services/github-app.ts's mapAccessLevel() table (apra-fleet-2wdc.1):
// push, push+pr, admin and full carry it; read and issues do not. Duplicated
// here, not imported, because fleet-sprint is the GENERIC engine
// (docs/generic-engine-boundary.md) and a sprint run can target ANY fleet
// server, not necessarily one built from this same checkout.
//
// Being a hand-maintained copy, this set cannot by itself catch a regression
// in mapAccessLevel(): a change there would just leave this stale and silently
// wrong. The guard is therefore on the SERVER side, where both halves are
// readable at once -- tests/workflows-access-level-table-parity.test.ts parses
// this literal out of this file and asserts it matches mapAccessLevel()'s
// table exactly, so editing one without the other fails the server suite.
// That test is the reason this copy is safe to keep; do not delete it.
const GITHUB_ACCESS_LEVELS_WITH_WORKFLOWS = new Set(['push', 'push+pr', 'admin', 'full']);

/**
 * Pure lookup: does GitHub App access level `gitAccess` carry the 'workflows'
 * permission? See GITHUB_ACCESS_LEVELS_WITH_WORKFLOWS above for the table this
 * mirrors and why it is a local copy.
 * @param {string} gitAccess
 * @returns {boolean}
 */
export function accessLevelGrantsWorkflowsPermission(gitAccess) {
    return GITHUB_ACCESS_LEVELS_WITH_WORKFLOWS.has(gitAccess);
}

/**
 * @param {{ fleetApi: object, command: Function, member: string, log?: Function, logPrefix: string, gitAccess?: string, resolvedProvider?: { provider: string, authMode: string|null } }} opts
 * @returns {Promise<{ expiresAt: Date|null, repo: string|null }>}
 */
/**
 * Map a member's git remote URL onto the VCS provider that hosts it, using the
 * SAME registry that answers every other host question (vcs-module.mjs's
 * capabilities() for the host parse, then resolveVcsAuthProviderForHost() for
 * the claim). Returns the provider NAME, or null when the URL has no host or no
 * registered AUTH BACKEND claims it -- provisioning credentials against an
 * unclaimed host would be a guess, not a detection.
 *
 * Note which resolver this uses. resolveVcsAuthProviderForHost() (not the
 * capabilities-axis resolveVcsProviderForHost()) asks each provider its
 * ANCHORED auth matcher and never falls back to the 'generic-git' catch-all.
 * That distinction is the whole point here: the caller below mints a real push
 * credential from whatever this returns, and GitHub's capabilities-axis
 * matchesHost() is a deliberate substring test for GitHub Enterprise Server,
 * which would otherwise let 'mygithubmirror.attacker.io' claim the credential.
 * See vcs-providers/github.mjs's matchesHostForAuth().
 *
 * @param {unknown} remoteUrl
 * @returns {string|null}
 */
function detectVcsProviderFromRemote(remoteUrl) {
    const { host } = vcsCapabilities(remoteUrl);
    if (!host) return null;
    const impl = resolveVcsAuthProviderForHost(host);
    return (impl && impl.name) || null;
}

async function provisionVcsAuthForMember({ fleetApi, command, member, log = () => {}, logPrefix, gitAccess = DEFAULT_SYNC_GIT_ACCESS, azdevopsPatSecretName, remoteUrlOverride, resolvedProvider }) {
    let repos;
    let derivedRepo = null;
    let derivedRef = null;
    // Reading the remote is best-effort (a failure here just means no explicit
    // repos scope), but PARSING it is not: a malformed remote on a host some
    // provider claims is a preflight ERROR that must escape this function
    // rather than be swallowed by the read's catch -- hence the parse sits
    // outside the try. See parseRepoScopeFromRemoteUrl (apra-fleet-5co8.1.2).
    let remoteUrl = '';
    let remoteReadFailed = false;
    let remoteReadError = null;
    // apra-fleet-8zr3-adjacent: a caller that already resolved the sprint's
    // origin remote via a real git-capable member (e.g. Publish PR's
    // publishGitMember) passes it here instead of making THIS function shell
    // out its own 'git remote get-url origin' to `member` -- which matters
    // when `member` is orchestratorMember and may be a git-less/shared member
    // with no checkout to read a remote from at all. Skips the read entirely,
    // never the parse below.
    if (remoteUrlOverride) {
        remoteUrl = String(remoteUrlOverride).trim();
    } else {
        try {
            const remoteRes = await command('git remote get-url origin', { member_name: member, silent: true, failSoft: true });
            remoteUrl = remoteRes && remoteRes.ok ? String(remoteRes.output || '').trim() : '';
            if (!remoteUrl) {
                // A non-ok / empty read is not a parse failure either: keep
                // the reason so a provider hook that needs the remote can
                // say "could not be read" instead of "not a recognized URL".
                const detail = remoteRes && !remoteRes.ok
                    ? String(remoteRes.error || remoteRes.output || 'git remote get-url origin failed').trim()
                    : 'git remote get-url origin printed nothing';
                remoteReadError = detail || 'git remote get-url origin printed nothing';
            }
        } catch (remoteErr) {
            remoteReadFailed = true;
            remoteReadError = remoteErr.message;
            log(`${logPrefix}: failed to read member '${member}' git remote to derive 'repos' (continuing without an explicit repos scope): ${remoteErr.message}`);
        }
    }
    if (!remoteReadFailed) {
        const scope = parseRepoScopeFromRemoteUrl(remoteUrl);
        if (scope.error) {
            throw new Error(`${logPrefix}: cannot provision VCS auth for member '${member}': ${scope.error}`);
        }
        derivedRef = scope.ref;
        if (scope.repo) {
            repos = [scope.repo];
            derivedRepo = scope.repo;
        } else {
            // remoteUrlOverride, when supplied, may belong to a DIFFERENT
            // member/repo than `member` -- see the caller-note above -- so
            // this log deliberately does not claim the URL is `member`'s own.
            const remoteSource = remoteUrlOverride ? 'the supplied remote URL' : `member '${member}' git remote`;
            log(`${logPrefix}: could not derive an owner/repo from ${remoteSource} (raw: '${remoteUrl}'); calling provision_vcs_auth without an explicit repos scope.`);
        }
    }

    // apra-fleet-647.1.2.1: provider and auth-mode are resolved from the
    // member's own persisted vcsProvider (VCSModule.resolveProvider), never
    // hardcoded here -- resolveProvider throws its own typed "ERROR:" for a
    // member with no registered provider rather than silently defaulting to
    // GitHub. `authMode` is provider-owned (github: 'github-app'; other
    // providers: null, no separate mode axis) and is only forwarded as
    // `<provider>_mode` when non-null, matching provision_vcs_auth's own
    // `github_mode` field name for the one provider that has one today.
    // apra-fleet-5co8.13: a caller that already resolved the provider (e.g.
    // the self-heal callback's authRemedy hint lookup) can thread it through
    // via `resolvedProvider`, saving a second member_detail round trip. Falls
    // back to this function's own lookup when not supplied.
    //
    // LAYER 2 -- dispatch-time self-heal. resolveProvider() throws for a member
    // registered with NO vcsProvider at all, which is exactly the state
    // register_member could leave a fully dispatch-capable member in before
    // registration-time detection landed. For every such member ALREADY
    // registered, that throw arrives reactively -- typically hours into an
    // unattended sprint, on the first push -- and no amount of retrying can heal
    // it, because the self-heal path itself dies on the same lookup.
    //
    // So: when the registry has nothing, fall back to `remoteUrl` -- the remote
    // this function already read/received above for the repos scope (never a
    // second dispatch). That URL is `member`'s own git remote ONLY when no
    // `remoteUrlOverride` was supplied; when it was, the detected provider is
    // still correct for provisioning `member` against that URL's host, but the
    // URL itself may not be `member`'s own remote. The host is mapped through
    // the SAME provider registry every other host decision goes through, so no
    // provider literal appears here, and a host claimed only by the generic-git
    // catch-all is deliberately NOT accepted.
    //
    // No separate persistence call is needed: fleetApi.provisionVcsAuth() below
    // already writes vcsProvider back to the member registry as an existing side
    // effect, so the very next lookup for this member resolves normally.
    //
    // An unreadable or unrecognized remote re-throws the ORIGINAL error -- that
    // is a real failure with nothing to detect, and must stay loud. So does
    // every OTHER way resolveProvider() can fail. Only the one failure that
    // carries VCS_NO_REGISTERED_PROVIDER is self-healable, and it is matched by
    // that stable code rather than by its message text.
    let provider;
    let authMode;
    try {
        ({ provider, authMode } = resolvedProvider || await resolveProvider(member, { fleetApi }));
    } catch (resolveErr) {
        if (!resolveErr || resolveErr.code !== VCS_NO_REGISTERED_PROVIDER) throw resolveErr;
        const detected = (!remoteReadFailed && remoteUrl)
            ? detectVcsProviderFromRemote(remoteUrl)
            : null;
        if (!detected) throw resolveErr;
        provider = detected;
        const impl = getVcsProvider(provider);
        authMode = isAuthBackend(impl) ? impl.defaultAuthMode : null;
        const remoteSource = remoteUrlOverride ? 'the supplied remote URL' : 'its git remote';
        log(`${logPrefix}: member '${member}' had no registered VCS provider; detected '${provider}' from ${remoteSource} and will provision it now`);
    }
    // apra-fleet-5co8.2.1: the argument shape itself is now provider-owned.
    // What follows is the DEFAULT (GitHub-App) shape; a provider that declares
    // a buildProvisionArgs hook replaces it wholesale -- see
    // buildProvisionArgsForProvider above.
    const provisionArgs = await buildProvisionArgsForProvider({
        provider,
        base: {
            member_name: member,
            provider,
            ...(authMode ? { [`${provider}_mode`]: authMode } : {}),
            git_access: gitAccess,
            ...(repos ? { repos } : {}),
        },
        repoRef: derivedRef,
        fleetApi,
        secretName: azdevopsPatSecretName,
        remoteUrl,
        remoteReadError,
        log,
        logPrefix,
    });
    // apra-fleet-qeq1.9: the hook answered "nothing to provision for this
    // request" (see buildProvisionArgsForProvider's own doc for the null
    // contract). Dispatch nothing, claim no new expiry -- the credential in
    // place is whatever it already was -- and still hand back the derived
    // repo, which is the other half of this function's return contract and is
    // what the PR-raising call sites need to build their command.
    if (provisionArgs === null) {
        log(`${logPrefix}: provider '${provider}' has nothing to re-provision for member '${member}'; continuing on its already-deployed credential without calling provision_vcs_auth.`);
        return { expiresAt: null, repo: derivedRepo };
    }
    const provisionRes = await fleetApi.provisionVcsAuth(provisionArgs);
    const provisionText = resultText(provisionRes);
    // provision_vcs_auth NEVER throws on failure -- it reports failure via
    // structuredContent.ok === false (apra-fleet-3swo.13; see
    // provisionOutcome above). A failed provision must never be allowed to
    // report success: doing so burns the one-shot self-heal and logs a lie.
    if (!provisionOutcome(provisionRes, provisionText).ok) {
        throw new Error(`provision_vcs_auth failed for member '${member}': ${provisionText || '(no detail)'}`);
    }

    // (apra-fleet-3swo.7.5) Credential expiry comes from the STRUCTURED half of
    // the provision result -- `structuredContent.expiresAt`, an ISO timestamp or
    // null (ProvisionVcsAuthFields in src/tools/provision-vcs-auth.ts) -- and is
    // no longer regex-scraped out of the prose summary by a dedicated prose
    // scraper -- that scraper was retired by the facade-pin removal task
    // (apra-fleet-3swo.7.15).
    //
    // Deliberately inlined rather than factored into a named helper: this
    // module's top-level declarations are pinned symbol-for-symbol by the facade
    // enumeration in test/vcs-auth-extraction-facade.test.mjs, so ADDING a
    // top-level name here turns that gate red exactly as removing one would --
    // and editing that enumeration belongs to the facade-pin task, not this one.
    //
    // The null semantics are preserved EXACTLY, because both the preflight
    // freshness cache and the server's own checkVcsTokenExpiry read null as "no
    // expiry tracked -> OK": an absent, non-string or unparseable value becomes
    // null, never a NaN Date. That last case is load-bearing -- a truthy NaN
    // Date would make every expiring-soon comparison false and silently disable
    // the preflight refresh, the same trap the retired scraper's Number.isNaN
    // guard existed to avoid.
    const rawExpiresAt = provisionRes && provisionRes.structuredContent
        ? provisionRes.structuredContent.expiresAt
        : null;
    const provisionedExpiry = typeof rawExpiresAt === 'string' && rawExpiresAt.trim() !== ''
        ? new Date(rawExpiresAt)
        : null;
    return {
        expiresAt: provisionedExpiry && !Number.isNaN(provisionedExpiry.getTime()) ? provisionedExpiry : null,
        repo: derivedRepo,
    };
}

// Narrowly-scoped, PR-capable provisioning. This is the ONLY call path in
// runner.js permitted to request git_access: 'push+pr' -- callers must be
// exactly the two PR-raising call sites (Publish PR, finalizeAbort), invoked
// immediately before their PR-creation dispatch, never at sprint setup and
// never from the shared self-heal/preflight path above (which always stays
// on 'push'). See the just-in-time credential-scoping rationale on
// provisionVcsAuthForMember above.
//
// Also returns the 'owner/repo' this call derived from the member's own git
// remote (same derivation provisionVcsAuthForMember already performs to
// scope the mint) -- reusing it here means the PR-raising call sites never
// need a SECOND `git remote get-url origin` dispatch of their own just to
// learn the repo VCSModule needs to build the PR-creation command.
/**
 * @param {{ fleetApi: object, command: Function, member: string, log?: Function, logPrefix: string }} opts
 * @returns {Promise<{ expiresAt: Date|null, repo: string|null }>}
 */
async function provisionPrCapableAuthForMember({ fleetApi, command, member, log = () => {}, logPrefix, remoteUrlOverride }) {
    return provisionVcsAuthForMember({ fleetApi, command, member, log, logPrefix, gitAccess: 'push+pr', remoteUrlOverride });
}

// Default credential label provision_vcs_auth deploys under when no explicit
// `label` is passed (src/tools/provision-vcs-auth.ts: `label = input.label ??
// input.provider`) -- the PR-raising call sites never pass a label either, so
// the deployed git-credential-helper file is always
// $HOME/.fleet-git-credential-<DEFAULT_VCS_PROVIDER> on POSIX (src/os/linux.ts
// gitCredentialHelperWrite), and
// $env:USERPROFILE\.fleet-git-credential-<DEFAULT_VCS_PROVIDER>.bat on Windows
// (src/os/windows.ts:279-294).
//
// (apra-fleet-3swo.4.10) Kept as a named constant rather than a second
// independently-hardcoded 'github' string literal: derives from
// vcs-providers/index.mjs's DEFAULT_VCS_PROVIDER, the SAME single source of
// truth vcs-module.mjs's classifyFailure()/resolveVcsProviderForHost() fall
// back to -- so this label default and the rest of the codebase's "which
// provider when nothing else is known" answer can never independently drift.
// Value is unchanged ('github') -- this is a routing fix, not a behavior
// change.
//
// REACHABILITY (recorded here so a future reader does not have to redo this
// analysis): this fallback name is defensive, not normally live. Both call
// sites below (raiseVcsPrForMember) always resolve a real `provider` via
// resolveProvider() BEFORE ever consulting vcsCredentialLabelForProvider(),
// and that call only succeeds after provisionPrCapableAuthForMember() has
// already run to completion -- which either used an already-registered
// provider or self-healed by detecting one from the member's git remote and
// persisting it server-side (provisionVcsAuthForMember's VCS_NO_REGISTERED_
// PROVIDER branch; see its own comment). resolveProvider() itself NEVER
// returns a falsy provider on success -- it throws VCS_NO_REGISTERED_PROVIDER
// instead (vcs-module.mjs) -- so by the time vcsCredentialLabelForProvider()
// runs in this file's real call graph, `provider` is always a genuine,
// resolved name and this fallback never fires. It exists purely so a FUTURE
// caller (or a refactor that loosens resolveProvider()'s contract) degrades
// to a named, documented default instead of `undefined`/`'undefined'`.
const DEFAULT_VCS_CREDENTIAL_LABEL = DEFAULT_VCS_PROVIDER;

// The credential-helper label provision_vcs_auth deploys a member's VCS
// credential under, for the PR-raising call sites to read it back from:
// `label = input.label ?? input.provider` server-side, and no fleet-sprint
// caller (neither the shared GitHub-App-shaped arguments in
// provisionVcsAuthForMember nor a provider's buildProvisionArgs hook) ever
// sends an explicit `label`, so the label IS the provider name -- 'github'
// -> $HOME/.fleet-git-credential-github, 'azure-devops' ->
// $HOME/.fleet-git-credential-azure-devops, etc. A member with no resolvable
// provider keeps the historical default (DEFAULT_VCS_PROVIDER, 'github') --
// see the reachability note above for why this branch is defensive-only.
/**
 * @param {string|null|undefined} provider
 * @returns {string}
 */
export function vcsCredentialLabelForProvider(provider) {
    const name = typeof provider === 'string' ? provider.trim() : '';
    return name || DEFAULT_VCS_CREDENTIAL_LABEL;
}

// Typed marker returned by finalizeAbort() (and logged by the Publish PR step)
// when the callTool-absent graceful-degradation path is taken: PR creation was
// intentionally skipped because no MCP client was wired to mint the push+pr
// credential VCSModule needs, NOT because a PR-creation attempt failed. Callers
// (and tests) can discriminate this benign skip from a genuine PR failure by
// this exact reason string. See apra-fleet-tfx.8.1.
export const PR_SKIPPED_NO_MCP_CLIENT = 'pr-skipped-no-mcp-client';

// Builds the member-bound command that RUNS the deployed git-credential-helper
// and the human-readable descriptor used in this function's error messages
// (the descriptor must stay readable -- the Windows command itself is an
// opaque base64 blob).
//
// SHELL CONTRACT (confirmed, not assumed -- apra-fleet-ot2z.1):
//   execute_command hands the caller's string to
//   cmds.wrapPidCapture(cmds.wrapInWorkFolder(folder, cmd)) and then straight
//   to the strategy's execCommand (src/tools/execute-command.ts:273 ->
//   src/services/ssh.ts execCommand, which does NO shell branching of its
//   own). wrapInWorkFolder/wrapPidCapture (src/os/windows.ts:328-335) still
//   emit RAW PowerShell text (`Set-Location "<folder>"; ...`,
//   `Write-Output "FLEET_PID:$pid"; ...`), NOT shell-normalized/encoded --
//   they are NOT wrapped with -EncodedCommand, so on a Windows member whose
//   sshd default shell is cmd.exe (not PowerShell) that outer wrapping is
//   still garbage regardless of what this function returns. This function's
//   own return value (the inner payload wrapPidCapture/wrapInWorkFolder wrap
//   around) IS explicitly -EncodedCommand and is valid to launch from either
//   PowerShell or cmd.exe on its own -- but that only protects the inner
//   payload, not the outer Set-Location/Write-Output wrapper the codebase
//   composes around it. Correctness end-to-end still depends on the target
//   member's default shell being PowerShell.
//   TODO: normalize wrapInWorkFolder/wrapPidCapture (and
//   gitCredentialHelperWrite/gitCredentialHelperRemove/deploySSHPublicKey,
//   which have the same raw-PowerShell issue on the write side) through a
//   single shell-detecting wrapper so the whole composite string -- not just
//   this function's inner payload -- is shell-agnostic.
//
// WHY $env:USERPROFILE AND NOT A JS-RESOLVED HOME PATH: the WRITE side
// (src/os/windows.ts:289 gitCredentialHelperWrite) writes the helper to
// `"$env:USERPROFILE\.fleet-git-credential-<label>.bat"` -- expanded ON THE
// MEMBER at write time. The read must resolve the home directory the same way
// the write did, or an independently-probed home could point somewhere the
// file was never written. This mirrors member-home.ts probeCommandFor(), which
// likewise resolves the OS in JS and interpolates a shell-appropriate string
// that still contains $env:USERPROFILE.
// RUNNER-WIDE POSIX-EXPANSION SWEEP (apra-fleet-ot2z.1, WORK item 2): every
// runner.js string passed to command()/execute_command was audited for `$VAR`,
// `~/`, backticks, `$( )` and POSIX-only shell plumbing (`&&`/`||` chains,
// `2>/dev/null`, `test -f`, pipes). Result: the credential read below was the
// ONLY member-bound string carrying a shell expansion. The surviving `$`
// occurrences in this file are all justified in place --
//   - NOT_DONE_STATUSES (~line 278): quoting note about PowerShell's $OFS, a
//     comment, not an expansion in the dispatched string;
//   - the Windows branch below: deliberately PowerShell, base64-encoded (via
//     se-os-commands.mjs's SeWindowsCommands#wrapForMember) so no host shell
//     ever re-parses it;
//   - the POSIX branch below: `$HOME` expanded by the POSIX member's own
//     shell, matching what src/os/linux.ts wrote.
// Everything else dispatched to a member is plain `git`/`bd`/`node -e`
// argv-shaped text (see stageCommandBodyMemberSide ~line 2195 and the
// two-sequential-calls note at ~line 5685, which already document why they
// avoid `&&` and `$`), inert across POSIX, PowerShell and cmd.exe.
//
// `target` is whatever se-os-commands.mjs's getSeCommands() accepts: a bare
// OS string (back-compat -- resolves to the PowerShell implementation for
// 'windows', matching pre-shell-aware behavior) or a { os, shell } record
// (resolveMemberTarget's shape), so a Windows member whose shell is
// Git-for-Windows bash gets the bash-flavored credential-read command instead
// of a PowerShell one. Label validation and byte-identical string shapes are
// now owned by the SePosixCommands/SeWindowsCommands/SeWindowsGitbashCommands
// classes themselves -- see se-os-commands.mjs.
/**
 * @param {{ os?: string, shell?: string }|string} target
 * @param {string} label
 * @returns {{ command: string, descriptor: string }}
 */
export function buildCredentialReadCommand(target, label) {
    return getSeCommands(target).readCredentialHelper(label);
}

// Splits a VCSModule create-pull-request curl result's captured stdout into
// its HTTP status code and JSON body. VCSModule's buildCreatePrCommand always
// appends `-w '\n%{http_code}'`, so curl's own stdout is "<json body>\n<status>".
/**
 * @param {string} output
 * @returns {{ status: number|null, body: unknown }}
 */
function parseVcsCurlOutput(output) {
    const text = String(output || '');
    const lines = text.split('\n');
    const statusLine = lines.length ? lines[lines.length - 1].trim() : '';
    const status = /^\d+$/.test(statusLine) ? parseInt(statusLine, 10) : null;
    const bodyText = (status !== null ? lines.slice(0, -1) : lines).join('\n').trim();
    let body = null;
    if (bodyText) {
        try {
            body = JSON.parse(bodyText);
        } catch {
            body = null;
        }
    }
    return { status, body, bodyText };
}

const PR_AUTH_404_TEXT_RE = /not accessible by (this )?(integration|token|personal access token)|requires (authentication|additional scopes?)|insufficient (scope|permission)/i;

// A PR-creation response is REACTIVE-auth-classified (as opposed to a
// generic failure) when the token that raised it is stale/expired (401),
// lacks the scope/permission GitHub requires (403), or -- because GitHub
// sometimes answers a scope refusal with 404 instead of 403, to avoid
// leaking whether a private repo exists to a token that cannot see it -- a
// 404 whose body text itself names a scope/permission/authentication
// refusal. Anything else (422 already-exists, 5xx, malformed body, a bare
// 404 with no such text) is left exactly as it classified before this bead:
// a plain failure, never retried.
/**
 * @param {number|null} status
 * @param {string} errorText
 * @returns {boolean}
 */
function isPrAuthFailure(status, errorText) {
    if (status === 401 || status === 403) return true;
    if (status === 404 && PR_AUTH_404_TEXT_RE.test(String(errorText || ''))) return true;
    return false;
}

// Mints a just-in-time push+pr credential for `member`, builds the
// create-pull-request command through VCSModule (the orchestrator-side
// command builder, apra-fleet-tfx.7) with a '{{vcs_token_inline}}'
// placeholder where the credential belongs, and dispatches it through the
// SERVER-SIDE handoff `fleetApi.vcsCredentialExec()` (vcs_credential_exec),
// which reads the credential, substitutes it and redacts it without the
// plaintext ever reaching this process -- `member` is still a dumb executor
// of a command this function (and VCSModule) decided, never `gh`, never a
// server-side fallback that picks its own command. Returns the
// same shape both PR-raising call sites need: { ok, alreadyExists, prUrl,
// error, authFailure }, mirroring the interpretation contract the reverted
// server-side create-pull-request.ts tool used (2xx -> success; 422 "already
// exists" -> idempotent success; anything else -> error).
//
// REACTIVE auth self-heal (apra-fleet-647.1.1.1): on an auth-classified
// response (see isPrAuthFailure above), this re-provisions a push+pr
// credential via provisionPrCapableAuthForMember and retries the SAME
// PR-creation command exactly once -- bounded one-shot semantics mirroring
// runGitStep/runDoltStep's onAuthFailure loop. The retry needs no token
// re-read of its own any more: the command still carries the placeholder, so
// the retry's handoff call re-reads the freshly re-provisioned credential
// server-side. If the retry still fails, the failure (auth or not) is
// returned as-is; the raw token is never logged (and is never even held
// here), only `built.logSafeCommand`.
/**
 * @param {{ fleetApi: object, command: Function, member: string, base: string, head: string, title: string, body?: string, log?: Function, logPrefix: string }} opts
 * @returns {Promise<{ ok: boolean, alreadyExists: boolean, prUrl: string|null, error: string|null, authFailure: boolean }>}
 */
export async function raiseVcsPrForMember({ fleetApi, command, member, base, head, title, body, log = () => {}, logPrefix, remoteUrlOverride }) {
    let repo;
    try {
        ({ repo } = await provisionPrCapableAuthForMember({ fleetApi, command, member, log, logPrefix, remoteUrlOverride }));
    } catch (provisionErr) {
        // apra-fleet-5co8.15: provisionPrCapableAuthForMember has no failSoft
        // of its own (by design -- see its doc comment above), so a
        // provisioning failure that happens BEFORE any PR-creation attempt
        // (e.g. a missing Azure DevOps PAT credential-store entry) used to
        // escape here as the raw provision_vcs_auth failure text and abort
        // the whole sprint. Degrade it the same way the reactive
        // auth-self-heal retry below already degrades a mid-retry failure:
        // log the provider's own authRemedy hint (never a wording duplicated
        // here) and return authFailure:true instead of throwing, so a caller
        // (Publish PR, finalizeAbort) can report clean, actionable guidance
        // and keep going rather than aborting on this condition.
        let remedyHint = null;
        try {
            const { provider } = await resolveProvider(member, { fleetApi });
            const impl = getVcsProvider(provider);
            if (impl && impl.authRemedy && impl.authRemedy.hint) remedyHint = impl.authRemedy.hint;
        } catch (resolveErr) {
            log(`${logPrefix}: could not resolve member '${member}'s VCS provider to look up an auth remedy hint (falling back to the raw provisioning error): ${resolveErr.message}`);
        }
        // The provider's remedy text is generic ("PATs cannot be re-minted
        // server-side ..."); on its own it hid WHY provisioning failed --
        // an unreadable remote, a missing credential-store entry and a dead
        // PAT all printed the same paragraph. Keep the hint, but lead with
        // the actual cause so the operator fixes the right thing.
        const message = remedyHint
            ? `Could not provision a push+pr credential for member '${member}': ${provisionErr.message} -- ${remedyHint}`
            : provisionErr.message;
        log(`${logPrefix}: PR-capable credential provisioning failed for member '${member}'; degrading (not throwing): ${message}`);
        return { ok: false, alreadyExists: false, prUrl: null, error: message, authFailure: true };
    }
    if (!repo) {
        const remoteSource = remoteUrlOverride ? 'the supplied remote URL' : `member '${member}' git remote`;
        throw new Error(`Could not derive an owner/repo from ${remoteSource} -- cannot build a VCSModule create-pull-request command without one.`);
    }
    // apra-fleet-lzfv.5: resolve the member's OWN registered VCS provider
    // (VCSModule.resolveProvider(), never a hardcoded 'github' literal --
    // same rule provisionVcsAuthForMember already follows) so
    // buildCreatePrCommand dispatches to the right REST dialect for a
    // dev.azure.com (or any other) remote, not just GitHub.
    //
    // Resolved BEFORE the handoff below because the credential is keyed
    // by provider too: provision_vcs_auth deploys the credential helper
    // under `label = input.label ?? input.provider`
    // (src/tools/provision-vcs-auth.ts), and neither the shared
    // GitHub-App-shaped arguments nor a provider's buildProvisionArgs hook
    // sends an explicit label -- so the credential the handoff must read is
    // the one under $HOME/.fleet-git-credential-<provider>. Passing the
    // 'github' label unconditionally (the pre-fix default this path once
    // carried, back when it read the token itself) made every Azure DevOps
    // member's PR raise fail with "Failed to read VCS credential token ...
    // from '$HOME/.fleet-git-credential-github'" (or, worse, silently reuse a
    // stale GitHub token left over from an earlier provider and send it to
    // dev.azure.com). `credentialLabel` is threaded into every
    // vcsCredentialExec() call below for exactly that reason.
    const { provider } = await resolveProvider(member, { fleetApi });
    const credentialLabel = vcsCredentialLabelForProvider(provider);

    // apra-fleet-3swo.7.6: the orchestrator never learns the token at all now.
    // It passes the INLINE placeholder as the `token` parameter, so each
    // provider's builder emits its existing shQuote()'d shape with the
    // placeholder sitting inside its OWN quotes (github.mjs still emits
    // -H 'Authorization: Bearer {{vcs_token_inline}}', azure-devops.mjs still
    // emits -u ':{{vcs_token_inline}}' -- the authentication MECHANISM is
    // unchanged, only the substituted word), and the SERVER substitutes it
    // during the vcs_credential_exec dispatch below, escaped for the interior
    // of those quotes with no quotes of its own (VCS_TOKEN_INLINE_PLACEHOLDER,
    // src/tools/vcs-credential-exec.ts). Deliberately inlined here rather than
    // hoisted to a module constant: the facade suite enumerates this module's
    // top-level declarations symbol-for-symbol and a new const desyncs that
    // census.
    const token = '{{vcs_token_inline}}';
    // apra-fleet-qeq1.3: Bitbucket REST needs basic auth 'username:token'
    // (unlike Azure DevOps/GitHub, which pass an empty or no username at
    // all) -- see the PLANNER DECISION note on the epic apra-fleet-qeq1.
    // Passed the same INLINE-placeholder way as `token` above: a provider
    // that does not read `username` (github.mjs, azure-devops.mjs) simply
    // ignores it, so this is additive. Inlined here rather than hoisted to a
    // module constant for the SAME reason `token` is -- see the comment
    // above it.
    const username = '{{vcs_username_inline}}';
    // Both os AND shell feed the command builder: os picks the curl binary
    // token (curl.exe vs curl), shell picks the quoting dialect. A Windows
    // member whose registered shell is gitbash needs POSIX quoting, not
    // PowerShell doubled-quote escaping -- resolving only the OS here fed
    // shell-less params to shQuote and corrupted the curl -d JSON payload
    // (observed live: GitHub 400 "Problems parsing JSON" on the create-PR
    // endpoint for a windows+gitbash member).
    const { os, shell } = await resolveMemberTarget({ fleetApi, member, log });

    // The provider's own coordinate shape (e.g. Azure DevOps' org/project/repo
    // -- see VCSModule.parseProviderRepoRef()/that provider's parseRepoRef
    // hook) when one exists; null for a provider with no such hook (GitHub),
    // which keeps using the two-part `repo` string above unchanged. Only ONE
    // of `repo`/`repoRef` is ever sent below: passing both would let the
    // (possibly provider-specific, e.g. 3-part) canonical `repo` string
    // silently override repoRef's own coordinates and mis-encode the request
    // URL (see azure-devops.mjs's assertRepoCoords doc comment). Both real
    // call sites (Publish PR, [ABORTED] PR) already resolve and pass
    // `remoteUrlOverride` themselves (see their own comments), so this never
    // needs a git-remote read of its own; a caller that omits it simply gets
    // no repoRef (falls back to `repo`, unchanged from before this task).
    const providerRef = remoteUrlOverride ? parseProviderRepoRef(remoteUrlOverride) : null;
    if (providerRef && providerRef.error) {
        throw new Error(providerRef.error);
    }
    const repoRef = providerRef ? providerRef.ref : null;

    let authHealAttempted = false;
    // apra-fleet PR-body length fix: buildCreatePrCommand deterministically
    // truncates `body` to PR_DESCRIPTION_MAX_LENGTH and reports it back via
    // `descriptionTruncated` (see vcs-module.mjs -- that module stays pure/
    // I/O-free, so the warning is logged here). Guarded so a retry of the
    // SAME (already-truncated) body after an auth self-heal never re-logs it.
    let truncationWarned = false;
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const built = buildCreatePrCommand({
            provider,
            ...(repoRef ? { repoRef } : { repo }),
            base, head, title, body, token, username, os, shell,
        });

        if (built.descriptionTruncated && !truncationWarned) {
            truncationWarned = true;
            const { originalLength, maxLength } = built.descriptionTruncated;
            log(`${logPrefix}: WARNING: PR description for member '${member}' was ${originalLength} chars, exceeding the ${maxLength}-char limit; truncated to the first ${maxLength} chars before raising the PR.`);
        }

        // The server-side credential handoff, NOT command(): the placeholder
        // built into `built.command` above is substituted INSIDE the server,
        // the substituted command is dispatched from there, and the credential
        // is redacted out of the stdout/stderr this process reads back. No
        // plaintext token ever transits the orchestrator, so there is nothing
        // here for a captured result, a log line or a written file to leak.
        if (!fleetApi || typeof fleetApi.vcsCredentialExec !== 'function') {
            throw new Error(
                `Cannot raise a PR for member '${member}': this fleet client exposes no vcs_credential_exec tool, `
                + 'and the orchestrator no longer reads VCS credential tokens itself. Upgrade the fleet server/client '
                + 'to a version that provides the vcs_credential_exec tool.',
            );
        }
        const execRes = await fleetApi.vcsCredentialExec({
            member_name: member,
            label: credentialLabel,
            command: built.command,
        });
        const handoff = (execRes && execRes.structuredContent) || {};
        const handoffText = resultText(execRes);
        // A credential-side failure HARD-FAILS, exactly as reading the token
        // ourselves used to throw -- never an advisory warning that lets the
        // sprint carry on with no credential. 'dispatch_failed' is the one
        // non-ok reason that is a COMMAND failure rather than a credential
        // failure, so it degrades the same way a failed command() dispatch
        // did: returned, not thrown.
        if (!handoff.ok && handoff.reason !== 'dispatch_failed') {
            throw new Error(
                `Failed to read VCS credential token for member '${member}' from the `
                + `'${credentialLabel}'-labelled credential helper via vcs_credential_exec `
                + `(reason: ${handoff.reason || '(none)'}): ${handoffText || '(no detail)'}`,
            );
        }
        if (!handoff.ok || (typeof handoff.exitCode === 'number' && handoff.exitCode !== 0)) {
            const failText = handoff.stderr || handoffText || 'vcs_credential_exec failed';
            return { ok: false, alreadyExists: false, prUrl: null, error: failText, authFailure: false };
        }

        const { status, body: respBody, bodyText } = parseVcsCurlOutput(handoff.stdout);
        const [lo, hi] = built.interpret.successStatusRange;
        if (status !== null && status >= lo && status <= hi) {
            // apra-fleet-lzfv.5: read the created PR's id/url through the
            // provider's OWN pullRequestResponse.map hook (declared on its
            // descriptor -- see vcs-providers/github.mjs and
            // vcs-providers/azure-devops.mjs) instead of a GitHub-dialect
            // `html_url` field literal here. A provider with no mapping
            // (should not happen for an auth-backend provider, but never
            // throws) yields prUrl: null rather than crashing on an
            // otherwise-successful PR.
            const impl = getVcsProvider(provider);
            const mapped = (impl && impl.pullRequestResponse && typeof impl.pullRequestResponse.map === 'function')
                ? impl.pullRequestResponse.map(respBody, repoRef ? { repoRef } : { repo })
                : { id: null, url: null };
            return { ok: true, alreadyExists: false, prUrl: mapped.url, error: null, authFailure: false };
        }

        const errorMessages = [];
        if (respBody && typeof respBody.message === 'string') errorMessages.push(respBody.message);
        if (respBody && Array.isArray(respBody.errors)) {
            for (const e of respBody.errors) {
                if (e && typeof e.message === 'string') errorMessages.push(e.message);
            }
        }
        const errorText = errorMessages.join('; ') || bodyText || `HTTP ${status ?? '(unknown)'}`;

        if (status === built.interpret.alreadyExistsStatus && new RegExp(built.interpret.alreadyExistsPattern, 'i').test(errorText)) {
            const urlMatch = /https?:\/\/\S+/.exec(errorText);
            const existingUrl = urlMatch ? urlMatch[0].replace(/[.,)]+$/, '') : null;
            return { ok: true, alreadyExists: true, prUrl: existingUrl, error: null, authFailure: false };
        }

        if (isPrAuthFailure(status, errorText) && !authHealAttempted) {
            authHealAttempted = true;
            log(`${logPrefix}: PR creation returned an auth-classified failure (HTTP ${status ?? '(unknown)'}) for member '${member}'; re-provisioning a push+pr credential and retrying once (command: ${built.logSafeCommand}): ${errorText}`);
            try {
                const reprov = await provisionPrCapableAuthForMember({ fleetApi, command, member, log, logPrefix, remoteUrlOverride });
                if (reprov.repo) repo = reprov.repo;
                // No token re-read here any more: `built.command` still
                // carries the placeholder, so the retry's own
                // vcs_credential_exec dispatch re-reads the FRESHLY
                // re-provisioned credential server-side, once per call. The
                // bounded one-shot retry semantics are unchanged.
            } catch (healErr) {
                log(`${logPrefix}: PR auth self-heal failed for member '${member}'; not retrying further: ${healErr.message}`);
                return { ok: false, alreadyExists: false, prUrl: null, error: `HTTP ${status ?? '(unknown)'}: ${errorText}`, authFailure: true };
            }
            log(`${logPrefix}: PR auth self-heal completed for member '${member}'; retrying PR creation once.`);
            continue;
        }

        return { ok: false, alreadyExists: false, prUrl: null, error: `HTTP ${status ?? '(unknown)'}: ${errorText}`, authFailure: isPrAuthFailure(status, errorText) };
    }
}

/**
 * apra-fleet-417.7: builds the `resolveMemberProvider(member)` callback
 * threaded through syncMemberBefore/syncMemberAfter/finalizeAbort into
 * runGitStep, so classifyGitFailure() classifies a git failure via the
 * member's OWN resolved VCS provider chain (VCSModule.resolveProvider())
 * instead of always falling back to the default 'github' chain -- this is
 * what makes azure-devops.mjs's TF401019 -> AUTH_DENIED and bitbucket.mjs's
 * app-password -> AUTH_EXPIRED rules reachable at runtime, not just from a
 * caller that names the provider directly against classifyFailure().
 *
 * The resolution is cached per member for the lifetime of the returned
 * callback (a member's registered VCS provider does not change mid-sprint),
 * so a member whose provider fails to resolve (fleet unreachable, no
 * registered provider) is not re-queried on every subsequent git failure --
 * it fails closed to `undefined` (today's default chain) exactly once per
 * member, then reuses that cached `undefined`.
 *
 * `callTool` is injected (the caller's MCP client), so this stays
 * transport-agnostic and unit-testable without a live fleet server.
 *
 * @param {{ callTool: (name: string, args: object) => Promise<any>, log?: Function }} opts
 * @returns {(member: string) => Promise<string|undefined>}
 */
export function createMemberVcsProviderResolver(opts = {}) {
    const { callTool, log = () => {} } = opts;
    const fleetApi = new ApraFleet({ callTool });
    /** @type {Map<string, string|undefined>} member -> resolved provider (or undefined if unresolvable). */
    const cache = new Map();

    return async function resolveMemberProvider(member) {
        if (cache.has(member)) return cache.get(member);
        try {
            const { provider } = await resolveProvider(member, { fleetApi });
            cache.set(member, provider);
            return provider;
        } catch (err) {
            log(`[Sync] could not resolve member '${member}'s VCS provider for git-failure classification (falling back to the default provider chain, no verdict change for GitHub members): ${err.message}`);
            cache.set(member, undefined);
            return undefined;
        }
    };
}

/**
 * Builds the REACTIVE `onAuthFailure` self-heal callback runGitStep and
 * runDoltStep invoke on an 'auth' classification: re-provisions the failing
 * member's VCS credentials via provisionVcsAuthForMember (whose owner/repo is
 * derived from the member's own git remote, never hardcoded). Logs both the
 * attempt and its outcome, so a self-heal is never silent. Any failure
 * propagates as a thrown error, which is how runGitStep/runDoltStep recognize
 * "self-heal failed" and stop retrying.
 *
 * `callTool` is injected (the caller's MCP client), so this stays
 * transport-agnostic and unit-testable without a live fleet server.
 *
 * @param {{ callTool: (name: string, args: object) => Promise<any>, command: Function, log?: Function }} opts
 * @returns {(info: { member: string, label: string, cmd?: string, error: string, kind: 'git'|'dolt' }) => Promise<void>}
 */
export function createVcsAuthSelfHealCallback(opts = {}) {
    const { callTool, command, log = () => {}, azdevopsPatSecretName } = opts;
    const fleetApi = new ApraFleet({ callTool });

    return async function onAuthFailure({ member, label, error }) {
        log(`[Sync] self-heal: auth failure detected for member '${member}' (${label}); calling provision_vcs_auth to re-provision credentials: ${error}`);

        // apra-fleet-5co8.4.2: some providers (e.g. Azure DevOps PATs) can
        // never be fixed by this reactive re-provisioning call alone -- it
        // only redeploys the SAME stored secret, it never mints a new one.
        // Print that provider's own remedy hint via the generic
        // `authRemedy` descriptor field (no provider-name conditional here,
        // see vcs-providers/index.mjs) BEFORE attempting the self-heal below,
        // so the operator has the real remedy even if that attempt also
        // fails. A provider that declares no `authRemedy` (or
        // `serverSideReMintable: true`, e.g. GitHub's App-minted token) prints
        // nothing extra here -- unchanged from before this task.
        // apra-fleet-5co8.13: resolve the provider ONCE here and thread it into
        // provisionVcsAuthForMember below via `resolvedProvider`, so a single
        // self-heal attempt makes exactly one member_detail round trip instead
        // of two. A resolution failure here must NOT short-circuit the
        // self-heal attempt -- `resolved` simply stays undefined and
        // provisionVcsAuthForMember falls back to its own lookup.
        let resolved;
        try {
            resolved = await resolveProvider(member, { fleetApi });
            const { provider } = resolved;
            const impl = getVcsProvider(provider);
            if (impl && impl.authRemedy && impl.authRemedy.serverSideReMintable === false) {
                log(`[Sync] self-heal: member '${member}' (${label}) uses '${provider}', whose credentials cannot be re-minted server-side. ${impl.authRemedy.hint}`);
            }
        } catch (resolveErr) {
            log(`[Sync] self-heal: could not resolve member '${member}' (${label})'s VCS provider to check for an auth remedy hint (continuing with the self-heal attempt): ${resolveErr.message}`);
        }

        await provisionVcsAuthForMember({ fleetApi, command, member, log, logPrefix: '[Sync] self-heal', azdevopsPatSecretName, resolvedProvider: resolved });

        log(`[Sync] self-heal: provision_vcs_auth succeeded for member '${member}' (${label}); the failed command will be retried once.`);
    };
}

// How far ahead of a credential's known expiry the preflight treats it as
// "expiring soon" and re-provisions early, rather than letting it lapse
// mid-dispatch. Mirrors the server's own EXPIRY_WARNING_MS threshold
// (checkVcsTokenExpiry) so the two "about to expire?" judgments never
// disagree.
const VCS_AUTH_EXPIRY_PREFLIGHT_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Proactive VCS-auth PREFLIGHT. Unlike createVcsAuthSelfHealCallback above,
 * which is REACTIVE (it fires only after a git/dolt command has already failed
 * with an 'auth' classification), this runs BEFORE a dispatch's git commands
 * and calls provision_vcs_auth only when this member's last-known credential
 * is missing, unknown, or expiring within VCS_AUTH_EXPIRY_PREFLIGHT_MS. It
 * closes the gap a reactive self-heal alone leaves: a credential that lapses
 * BETWEEN dispatches is refreshed before the next dispatch instead of after a
 * command fails.
 *
 * The freshness cache is scoped to the callback instance returned here, so
 * each member's first call always provisions (no cache entry yet) and later
 * calls are skipped until the cached expiry approaches. A response carrying no
 * expiry (PAT mode, which never expires) is cached as "known-good, never needs
 * refresh".
 *
 * NEVER throws: a preflight failure (fleet unreachable, provision_vcs_auth
 * itself failing) is logged and swallowed so it can never abort a dispatch
 * that would have succeeded on its still-valid existing credential. The
 * reactive self-heal remains the actual safety net if the credential is
 * genuinely stale.
 *
 * @param {{ callTool: (name: string, args: object) => Promise<any>, command: Function, log?: Function, now?: () => number }} opts
 * @returns {(member: string) => Promise<void>}
 */
export function createVcsAuthPreflightCallback(opts = {}) {
    const { callTool, command, log = () => {}, now = () => Date.now(), azdevopsPatSecretName } = opts;
    const fleetApi = new ApraFleet({ callTool });
    /** @type {Map<string, Date|null>} member -> last-known expiresAt (null = no expiry tracked, e.g. PAT mode). */
    const knownGoodUntil = new Map();

    return async function ensureVcsAuthFresh(member) {
        if (knownGoodUntil.has(member)) {
            const expiresAt = knownGoodUntil.get(member);
            if (expiresAt === null || expiresAt.getTime() - now() > VCS_AUTH_EXPIRY_PREFLIGHT_MS) {
                // Still fresh (or a no-expiry credential type) -- skip, so
                // this is not an unconditional provisioning call on every
                // dispatch.
                return;
            }
        }
        log(`[Sync] preflight: ensuring member '${member}' has a fresh VCS credential before dispatch; calling provision_vcs_auth.`);
        try {
            const { expiresAt } = await provisionVcsAuthForMember({ fleetApi, command, member, log, logPrefix: '[Sync] preflight', azdevopsPatSecretName });
            knownGoodUntil.set(member, expiresAt);
            log(`[Sync] preflight: provision_vcs_auth succeeded for member '${member}'${expiresAt ? ` (expires ${expiresAt.toISOString()})` : ''}.`);
        } catch (err) {
            log(`[Sync] preflight: provision_vcs_auth failed for member '${member}' (continuing -- the existing credential may still be valid; the reactive self-heal will fire if a git/dolt command actually fails): ${err.message}`);
        }
    };
}

/**
 * Sync-step "will this push be rejected for missing the 'workflows'
 * permission?" preflight (apra-fleet-2wdc.6). Distinct from
 * createVcsAuthPreflightCallback above: that one keeps a member's credential
 * FRESH; this one warns, BEFORE dispatch, when the credential that preflight
 * ensures is fresh was never going to carry a permission this specific push
 * needs -- so an operator sees a clear, named referral instead of a raw
 * GitHub 422 (or a misclassified rejection) surfacing mid-dispatch. See the
 * parent bug apra-fleet-2wdc: the App installation grants 'workflows', but a
 * minted token that never REQUESTED it gets rejected pushing any
 * .github/workflows/** change, on every git_access level that lacks it.
 *
 * NEVER mints a token to find out: resolves the member's VCS provider via the
 * same read-only resolveProvider() lookup provisionVcsAuthForMember itself
 * uses, then reads the access level that member is actually REGISTERED at off
 * the same tool (readRegisteredGitAccess below) -- both read-only member_detail
 * calls, no POST /access_tokens -- and checks that level against
 * accessLevelGrantsWorkflowsPermission()'s local table.
 *
 * WHICH level is checked matters, and is the whole point of apra-fleet-rp7a.4.
 * This used to test `gitAccess` -- an option no caller ever passes, defaulting
 * to DEFAULT_SYNC_GIT_ACCESS ('push'), which apra-fleet-2wdc.1 made a level
 * that DOES carry 'workflows'. That made the check a constant `true` and the
 * referral unreachable in every configuration the engine can produce: inert
 * defence, not working defence. The level now comes from the member registry
 * (member_detail's `gitAccess`, set by register_member/update_member's
 * git_access), so the members genuinely at risk -- registered 'read' or
 * 'issues', or holding a credential minted before apra-fleet-2wdc.1 and not
 * yet re-provisioned -- are the ones that get warned. `opts.gitAccess` is kept
 * ONLY as the fallback for a member whose record carries no explicit level, in
 * which case the provisioning default really is what will be requested.
 *
 * Cost/safety:
 *   - Reads resolve per MEMBER, not per dispatch: any outcome that
 *     proves this member can never produce a warning (non-GitHub, PAT mode, or
 *     a level that carries 'workflows') is cached in `silentMembers` and the
 *     member is skipped outright from then on -- so the steady state for a
 *     healthy fleet is zero reads. The provider lookup also short-circuits
 *     before the level read for any non-GitHub-App member, so no member ever
 *     pays for a level it cannot be judged on. An AT-RISK outcome is
 *     deliberately NOT cached -- re-provisioning the member at a carrying
 *     level is exactly the remediation the referral asks for, and a cached
 *     verdict would keep crying wolf after the operator did it.
 *   - The diff check, when reached, is purely LOCAL: `git rev-list --count`
 *     then `git diff --name-only`, both against refs already present on
 *     `member`'s checkout (the sprint branch `syncMemberBefore` just synced,
 *     and `origin/<baseBranch>` from this sprint's own branch setup) -- no
 *     extra `git fetch`, so no added per-round remote round trip.
 *   - Skipped entirely (no diff command run at all) when `branch` has no
 *     commits ahead of `baseBranch`.
 *   - NEVER throws: any failure (git command error, provider-resolution
 *     failure, malformed output) is logged and swallowed, exactly like
 *     createVcsAuthPreflightCallback above -- a preflight hiccup must never
 *     abort a dispatch that would otherwise succeed.
 *   - Non-GitHub providers are silently skipped -- never warn.
 *
 * @param {{ callTool: (name: string, args: object) => Promise<any>, command: Function, log?: Function, gitAccess?: string }} opts
 * @returns {(member: string, branch: string, baseBranch: string) => Promise<void>}
 */
/**
 * The git access level `member` is REGISTERED at, straight off member_detail
 * (register_member/update_member's git_access, surfaced as `gitAccess` --
 * src/tools/member-detail.ts). Returns null when the member record names no
 * level, or when the response is anything this cannot read as JSON.
 *
 * Deliberately a separate read from resolveProvider()'s, even though both come
 * off the same tool: resolveProvider()'s return shape is a pinned contract
 * several suites assert field-for-field, and widening it to carry a field only
 * this preflight wants would make every one of those callers pay for a
 * concern none of them have. The cost is one extra member_detail call per
 * GitHub-App member per sprint (the caller caches its verdict; see
 * createWorkflowsPermissionPreflightCallback's silentMembers).
 *
 * Best-effort by design -- an absent/unparseable level is NOT an error here,
 * it just means the caller falls back to its provisioning default. A genuinely
 * failing memberDetail() call still rejects, and the caller's catch turns that
 * into the same swallowed degraded-check log as any other preflight hiccup.
 *
 * @param {string} member
 * @param {{ memberDetail: (opts: { member_name: string, format?: string }) => Promise<any> }} fleetApi
 * @returns {Promise<string|null>}
 */
async function readRegisteredGitAccess(member, fleetApi) {
    const res = await fleetApi.memberDetail({ member_name: member, format: 'json' });
    let parsed;
    try {
        parsed = JSON.parse(resultText(res));
    } catch {
        // member_detail answers with plain prose (not JSON) when the member
        // cannot be resolved at all -- but that case has already surfaced as a
        // typed throw from resolveProvider() before this is ever reached, so
        // there is nothing left to report here.
        return null;
    }
    const level = parsed && typeof parsed.gitAccess === 'string' ? parsed.gitAccess.trim() : '';
    return level || null;
}

export function createWorkflowsPermissionPreflightCallback(opts = {}) {
    const { callTool, command, log = () => {}, gitAccess: fallbackGitAccess = DEFAULT_SYNC_GIT_ACCESS } = opts;
    const fleetApi = new ApraFleet({ callTool });

    /**
     * Members already proven incapable of producing this warning (wrong
     * provider, wrong auth mode, or an access level that carries 'workflows').
     * Skipping them avoids re-reading member_detail on every single dispatch;
     * see the cost note above for why at-risk members are NOT cached here.
     * @type {Set<string>}
     */
    const silentMembers = new Set();

    return async function warnIfWorkflowsPermissionMissing(member, branch, baseBranch) {
        try {
            if (!branch || !baseBranch || branch === baseBranch) return;
            if (silentMembers.has(member)) return;

            const { provider, authMode } = await resolveProvider(member, { fleetApi });
            if (provider !== 'github') {
                silentMembers.add(member);
                return;
            }
            if (authMode !== 'github-app') {
                // PAT mode, DELIBERATELY out of scope (apra-fleet-rp7a.4 item
                // 3 -- recorded here rather than left silent). A PAT missing
                // the 'workflow' scope is rejected by exactly the same GitHub
                // rule, so the failure mode is real; what is missing is any
                // way to PREDICT it from here. A PAT's granted scopes are not
                // derivable from anything the fleet registry holds: `git_access`
                // is a GitHub-App-only mapping onto installation-token
                // permissions (src/services/github-app.ts mapAccessLevel), and
                // the PAT itself is an opaque operator-supplied secret whose
                // scopes are only observable by calling GitHub with it and
                // reading the X-OAuth-Scopes response header -- a network call
                // this advisory, never-throwing, never-blocking preflight must
                // not make on every dispatch, and which would need the secret
                // VALUE, which the engine never handles. Warning off the
                // registered level anyway would be a fabricated verdict (the
                // level says nothing about a PAT), and warning unconditionally
                // would cry wolf at every correctly-scoped PAT member. So: no
                // warning. PAT members find out from the push rejection, which
                // classifyFailure() already recognizes and reports. Revisit
                // only if the registry ever records a PAT's scopes at
                // provisioning time -- then check them here the same way.
                silentMembers.add(member);
                return;
            }

            // The level this member's credential is ACTUALLY minted at, per the
            // registry; the caller-supplied default applies only when the
            // member record names no level of its own.
            const registeredGitAccess = await readRegisteredGitAccess(member, fleetApi);
            const effectiveGitAccess = registeredGitAccess || fallbackGitAccess;
            const levelSource = registeredGitAccess ? 'registered' : 'default';
            if (accessLevelGrantsWorkflowsPermission(effectiveGitAccess)) {
                silentMembers.add(member);
                return;
            }

            const countRes = await command(`git rev-list --count origin/${baseBranch}..${branch}`, { member_name: member, silent: true, failSoft: true });
            const aheadCount = countRes && countRes.ok ? parseInt(String(countRes.output || '').trim(), 10) : NaN;
            if (!Number.isFinite(aheadCount) || aheadCount <= 0) return;

            const diffRes = await command(`git diff --name-only origin/${baseBranch}...${branch} -- .github/workflows`, { member_name: member, silent: true, failSoft: true });
            if (!diffRes || !diffRes.ok) return;
            const touchedPaths = String(diffRes.output || '').split('\n').map((line) => line.trim()).filter(Boolean);
            if (touchedPaths.length === 0) return;

            log(
                `[Sync] OPERATOR REFERRAL: branch '${branch}' touches workflow file(s) [${touchedPaths.join(', ')}] but member ` +
                `'${member}''s minted credential (git_access '${effectiveGitAccess}', ${levelSource}) was not requested with the 'workflows' permission -- ` +
                `GitHub WILL reject this push ("refusing to allow a GitHub App to create or update workflow ... without ` +
                `workflows permission"). Re-provision '${member}' with an access level that carries 'workflows' ` +
                // Listed from the table itself, never spelled out again by
                // hand: a remedy naming levels that no longer carry the
                // permission is worse than no remedy at all.
                `(${[...GITHUB_ACCESS_LEVELS_WITH_WORKFLOWS].join(', ')}) before this dispatch publishes.`,
            );
        } catch (err) {
            log(`[Sync] preflight: workflows-permission check failed for member '${member}' on branch '${branch}' (continuing -- advisory only, never blocks dispatch): ${err.message}`);
        }
    };
}

/**
 * LLM-auth counterpart to createVcsAuthSelfHealCallback, invoked by a
 * dispatch-site catch handler on an auth dispatch error: re-provisions LLM
 * credentials for the failing member via provision_llm_auth, after which the
 * caller retries its own dispatch once. Never throws -- every failure path
 * returns false ("do not retry"). A local member returns false without
 * retrying, because provision_llm_auth is a no-op for local members: they
 * share the operator's host credentials, and only an interactive `/login` on
 * that machine can fix an expired local session.
 *
 * @param {{ callTool: (name: string, args: object) => Promise<any>, log?: Function }} opts
 * @returns {(info: { member: string, label: string, error: string }) => Promise<boolean>} resolves true if healed (retry), false if not (do not retry)
 */
export function createLlmAuthSelfHealCallback(opts = {}) {
    const { callTool, log = () => {} } = opts;
    const fleetApi = new ApraFleet({ callTool });

    return async function onLlmAuthFailure({ member, label, error }) {
        log(`[Dispatch] self-heal: LLM auth failure detected for member '${member}' (${label}); calling provision_llm_auth to re-provision credentials: ${error}`);

        let provisionRes;
        try {
            provisionRes = await fleetApi.provisionLlmAuth({ member_name: member });
        } catch (callErr) {
            log(`[Dispatch] self-heal: provision_llm_auth call failed for member '${member}': ${callErr.message}. Not retrying -- fix credentials manually and re-run.`);
            return false;
        }

        const text = resultText(provisionRes).trim();
        const outcome = provisionOutcome(provisionRes, text);

        // apra-fleet-3swo.13: src/tools/provision-auth.ts's OK_REASONS
        // classifies 'skipped_local_member' as ok:true (it IS a well-formed,
        // non-erroring outcome), so this check must run BEFORE the generic
        // ok/fail branch below -- otherwise a local member's skip would be
        // misread as a genuine credential refresh and the (pointless) retry
        // would fire anyway. The 'outcome.reason === null' half of the OR
        // only matters for the legacy prose fallback (no structuredContent
        // on the result at all), where the skip marker must still be read
        // off the text since there is no structured reason to check.
        if (outcome.reason === 'skipped_local_member' || (outcome.reason === null && /^\[SKIP\]/.test(text))) {
            // Skip marker (local member): provision_llm_auth is a no-op here,
            // so retrying would just reproduce the same failure.
            log(`[Dispatch] self-heal: provision_llm_auth skipped for local member '${member}': ${text || '(no detail)'}. This member's credentials can only be refreshed via an interactive /login on this machine.`);
            return false;
        }

        if (!outcome.ok) {
            log(`[Dispatch] self-heal: provision_llm_auth failed for member '${member}': ${text || '(no detail)'}. Not retrying.`);
            return false;
        }

        log(`[Dispatch] self-heal: provision_llm_auth succeeded for member '${member}' (${label}); the failed dispatch will be retried once.`);
        return true;
    };
}
