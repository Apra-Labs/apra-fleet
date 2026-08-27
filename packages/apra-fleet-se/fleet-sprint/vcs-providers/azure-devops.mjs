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
 * provision_vcs_auth time, same as Bitbucket -- see ./bitbucket.mjs).
 * apra-fleet-lzfv.2 adds the REST create-pull-request/comment builders (see
 * buildAzureDevOpsCreatePrCommand/buildAzureDevOpsCommentCommand below);
 * capabilitiesForHost()'s canOpenPullRequest is now true (apra-fleet-lzfv.5),
 * once runner.js's publish path could actually dispatch them (see that
 * function's doc comment). Any action WITHOUT a builder still fails closed
 * with a clear ASCII
 * "ERROR: ... does not yet implement action ..." from buildVcsCommand()
 * instead of a silently wrong command. Declaring `defaultAuthMode` (even as
 * `null`) is what makes 'azure-devops' part of resolveProvider()'s known
 * vocabulary -- see ./index.mjs's isAuthBackend().
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
 * apra-fleet-5co8.1.1 adds the host/URL axis: matchesHost(),
 * capabilitiesForHost() and parseRepoRef(). All three are descriptor hooks
 * dispatched from shared code (./index.mjs's resolveVcsProviderForHost(),
 * vcs-module.mjs's capabilities()), so no Azure DevOps conditional leaks into
 * a shared file. capabilitiesForHost() now reports canOpenPullRequest:true
 * (apra-fleet-lzfv.5) -- runner.js's publish path (raiseVcsPrForMember) is
 * provider-aware now, resolving the member's own registered provider instead
 * of hardcoding 'github', so this host can actually reach `builders` above.
 *
 * apra-fleet-5co8.4.1 adds two more additive rules on top of the bare
 * TF401019 AUTH_DENIED rule above (which stays exactly as-is): a REST 401 /
 * TF400813 both mean the PAT itself is expired or revoked (AUTH_EXPIRED --
 * re-minting the token is the fix), while a REST 403 is a missing-scope
 * refusal (AUTH_DENIED -- widening the PAT's scopes is the fix, per
 * skills/fleet/auth-azdevops.md's role/scope table). See the AUTH_EXPIRED /
 * AUTH_DENIED doc comments below for the exact texts and why each is
 * additive only, with no verdict moved for the pre-existing TF401019 case.
 *
 * apra-fleet-5co8.4.2 declares `authRemedy` (see its own doc comment below):
 * an auth-classified failure here can never be fixed by the shared reactive
 * self-heal alone, because a PAT is stored/redeployed, never re-minted --
 * runner.js prints this provider's remedy text via that generic descriptor
 * field rather than a provider-name conditional of its own.
 *
 * ASCII only.
 */

import { VCS_FAILURE_KINDS as K } from '../errors.mjs';
import { shQuote, curlBinary, assertToken } from './shell-helpers.mjs';

/** Credential no longer good -- re-minting a PAT (skills/fleet/auth-azdevops.md
 *  "401 Unauthorized -> Create new PAT and re-deploy") is the remedy, so
 *  AUTH_EXPIRED, same split GenericGitVCS/GitHubVCS already use for a 401 vs a
 *  403.
 *
 *  apra-fleet-5co8.4.1: two independent signals both mean "the PAT itself is
 *  expired/revoked", not "wrong scope":
 *    - A bare trailing REST status line of '401'. VCSModule's curl builders
 *      append `-w '\n%{http_code}'` (see ./github.mjs's identical convention),
 *      so a REST call's own stdout ends in a status-code-only line; anchored
 *      to end-of-string/line so an inline "401" mentioned mid-sentence (which
 *      says nothing about THIS call's own outcome) is never matched.
 *      azure-devops.mjs's own REST builders (added apra-fleet-lzfv.2, below)
 *      append it too, and classifyFailure() is reachable standalone (see
 *      vcs-classify-failure.test.mjs AC1/'providers listed as known but
 *      unimplemented ... still classify'), and PAT validation elsewhere in
 *      the fleet already shells a curl+`-w '\n%{http_code}'` call against this
 *      same REST API (skills/fleet/auth-azdevops.md's own `curl -sf` Test
 *      section) whose failure text this rule must classify correctly today.
 *    - TF400813, whose text is a generic "resource not available" refusal
 *      that Azure DevOps also emits for an expired/revoked PAT (the org-URL
 *      misconfiguration case in the troubleshooting table above resolves
 *      through the SAME message; re-minting -- which also forces a fresh
 *      provision_vcs_auth pass where the org URL is re-checked -- is still the
 *      correct first remedy, per the design recorded on the parent
 *      apra-fleet-5co8.4 goal). */
const AUTH_EXPIRED = [
    /(?:^|\n)\s*401\s*$/,
    /TF400813/,
];

/** Identity understood, PAT itself still valid, access refused -- re-minting
 *  the SAME credential cannot fix either of these; the remedy is a broader
 *  scope (skills/fleet/auth-azdevops.md's role/scope table) or -- for
 *  TF401019 specifically -- the repo/permission grant itself. AUTH_DENIED.
 *
 *  apra-fleet-5co8.4.1:
 *    - A bare trailing REST status line of '403' (skills/fleet/auth-
 *      azdevops.md "403 Forbidden -> Create PAT with broader scopes"). Same
 *      anchored shape and same rationale as the 401 rule above -- mirrors it
 *      exactly, just the denied half of the 401/403 HTTP split.
 *    - TF401019 (unchanged from before this task -- see the module doc
 *      comment above and vcs-nongithub-auth-selfheal.test.mjs's real-bd
 *      end-to-end assertion through withGitSync, which this rule must keep
 *      passing verbatim): "does not exist, or you do not have permission" is
 *      Azure DevOps' deliberately ambiguous repo-not-found-or-no-access
 *      message; re-minting the identical PAT cannot fix either case. */
const AUTH_DENIED = [
    /(?:^|\n)\s*403\s*$/,
    /TF401019/,
];

/** Best-effort Azure DevOps TF-numbered error code, purely DIAGNOSTIC: never
 *  branch on it -- branch on `kind`. Falls back to a bare trailing REST status
 *  line (the `-w '\n%{http_code}'` convention -- see ./github.mjs's
 *  extractProviderCode for the same fallback), so a REST 401/403 with no
 *  TF-numbered code still surfaces its status for diagnostics. */
function extractProviderCode(raw) {
    const text = String(raw == null ? '' : raw);
    const tf = text.match(/\b(TF\d{6})\b/);
    if (tf) return tf[1];
    const trailing = text.match(/(?:^|\n)\s*(\d{3})\s*$/);
    return trailing ? trailing[1] : null;
}

/** The three Azure DevOps host forms, ANCHORED (never a substring test -- see
 *  the lookalike cases in test/vcs-azure-devops-repo-ref.test.mjs):
 *    - dev.azure.com          https remotes
 *    - ssh.dev.azure.com      the v3 ssh remotes
 *    - <org>.visualstudio.com the legacy host, plus bare visualstudio.com
 *  Contrast GitHubVCS.matchesHost(), which is deliberately a substring test
 *  because GitHub Enterprise Server hosts have no fixed domain; Azure DevOps
 *  is a hosted-only service with exactly these domains, so anchoring costs
 *  nothing and keeps `dev.azure.com.evil.example` from being claimed. */
const HOST_RE = /^(?:dev\.azure\.com|ssh\.dev\.azure\.com|(?:[a-z0-9-]+\.)*visualstudio\.com)$/i;

/** Host-recognition for VCSModule.capabilities() and
 *  resolveVcsProviderForHost() (see ./index.mjs). */
function matchesHost(host) {
    return typeof host === 'string' && HOST_RE.test(host.trim());
}

/** TRUE (apra-fleet-lzfv.5), now that `builders` (apra-fleet-lzfv.2) is
 *  reachable through a publish path that actually knows how to dispatch them
 *  -- honouring the lockstep rule in ./index.mjs's REQUIRED EXPORT SHAPE: a
 *  host never ADVERTISES a pull request it cannot actually deliver. Before
 *  this flip, Azure DevOps genuinely could not: runner.js's publish path
 *  (raiseVcsPrForMember) called buildCreatePrCommand with a HARDCODED
 *  `provider: 'github'` and a two-part 'owner/name' repo, so an Azure DevOps
 *  remote reaching it died inside GitHubVCS's assertRepo on the three-part
 *  org/project/repo canonical ("invalid repo ... expected \"owner/name\"")
 *  instead of building this file's command -- measured, not assumed:
 *  test/mock-sprint-azure-devops-vcs-preflight.test.mjs failed 2 of 3 with the
 *  flip alone and passed 3 of 3 without it. raiseVcsPrForMember now resolves
 *  the member's own registered provider (VCSModule.resolveProvider(), never
 *  hardcoded) and reads the provider-owned repoRef/response-mapping
 *  descriptors instead of a GitHub literal, which is what makes this flip
 *  safe. */
function capabilitiesForHost(_host) {
    return { canOpenPullRequest: true };
}

/** Percent-decode one path segment; an invalid escape (e.g. a bare '%') is
 *  left as-is rather than throwing, because parseRepoRef must never throw. */
function decodeSegment(segment) {
    try {
        return decodeURIComponent(segment);
    } catch {
        return segment;
    }
}

/** Split `path` into non-empty, percent-decoded segments with any trailing
 *  '.git' stripped off the LAST one. */
function pathSegments(path) {
    const raw = String(path).split('/').filter((part) => part !== '');
    if (raw.length === 0) return raw;
    raw[raw.length - 1] = raw[raw.length - 1].replace(/\.git$/i, '');
    return raw.map(decodeSegment);
}

/** Split a remote URL into { host, path } for BOTH shapes git speaks: a real
 *  scheme'd URL (https/ssh, with optional userinfo and port) and the scp-like
 *  shorthand `git@host:path` that `new URL()` cannot parse at all. */
function splitRemote(url) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
        let parsed;
        try {
            parsed = new URL(url);
        } catch {
            return null;
        }
        if (!parsed.hostname) return null;
        return { host: parsed.hostname.toLowerCase(), path: parsed.pathname };
    }
    const scp = /^(?:[^@\s/]+@)?([^:\s/]+):(.*)$/.exec(url);
    if (!scp) return null;
    return { host: scp[1].toLowerCase(), path: `/${scp[2]}` };
}

function makeRef(org, project, repo) {
    if (!org || !project || !repo) return null;
    return {
        org,
        project,
        repo,
        canonical: `${org}/${project}/${repo}`,
    };
}

/**
 * Parse an Azure DevOps git remote URL into its { org, project, repo,
 * canonical } coordinates -- the identity every Azure DevOps REST call needs
 * (https://dev.azure.com/{org}/{project}/_apis/git/repositories/{repo}/...).
 *
 * Recognized shapes:
 *   https://[user@]dev.azure.com/ORG/PROJECT/_git/REPO[.git][/]
 *   https://[user@]dev.azure.com/ORG/_git/REPO            (project == repo)
 *   git@ssh.dev.azure.com:v3/ORG/PROJECT/REPO[.git]
 *   ssh://git@ssh.dev.azure.com[:22]/v3/ORG/PROJECT/REPO[.git]
 *   https://ORG.visualstudio.com/[DefaultCollection/]PROJECT/_git/REPO[.git]
 *   https://ORG.visualstudio.com/_git/REPO                (project == repo)
 *
 * The project-omitted shorthand is how Azure DevOps itself renders a repo
 * whose name equals its project's, so taking the repo name as the project is
 * the correct expansion, not a guess.
 *
 * Percent-encoded project names (the common case -- Azure DevOps allows
 * spaces in project names) are decoded in EVERY returned field, so `canonical`
 * is a display/identity key, not a URL fragment: re-encode per segment before
 * building a request URL from it.
 *
 * NEVER throws and NEVER partially guesses: anything that is not one of the
 * shapes above -- including a non-Azure host and a lookalike like
 * `dev.azure.com.evil.example` -- returns null, so the caller can raise its
 * own typed ERROR naming the expected shape (apra-fleet-5co8.1.2) instead of
 * proceeding with half-parsed coordinates.
 *
 * @param {unknown} remoteUrl
 * @returns {{ org: string, project: string, repo: string, canonical: string }|null}
 */
function parseRepoRef(remoteUrl) {
    if (typeof remoteUrl !== 'string') return null;
    const url = remoteUrl.trim();
    if (!url) return null;

    const split = splitRemote(url);
    if (!split || !matchesHost(split.host)) return null;

    const segments = pathSegments(split.path);
    if (segments.length === 0) return null;

    // ssh v3 form: exactly v3/ORG/PROJECT/REPO -- no _git marker, no
    // project-omitted shorthand (Azure DevOps always emits all three).
    if (segments[0].toLowerCase() === 'v3') {
        if (segments.length !== 4) return null;
        return makeRef(segments[1], segments[2], segments[3]);
    }

    // https forms: the '_git' marker separates the org/project prefix from
    // the single repo segment. Requiring the marker to be second-from-last is
    // what rejects both a missing repo and any extra trailing segment.
    const marker = segments.indexOf('_git');
    if (marker === -1 || marker !== segments.length - 2) return null;
    const repo = segments[segments.length - 1];
    let prefix = segments.slice(0, marker);

    const legacy = /visualstudio\.com$/i.test(split.host);
    if (legacy) {
        // Legacy host: the org is the HOSTNAME label, not a path segment, and
        // an explicit collection segment (historically 'DefaultCollection')
        // may precede the project.
        const org = split.host.split('.')[0];
        if (!org || org.toLowerCase() === 'visualstudio') return null;
        if (prefix.length > 0 && prefix[0].toLowerCase() === 'defaultcollection') prefix = prefix.slice(1);
        if (prefix.length > 1) return null;
        return makeRef(org, prefix[0] || repo, repo);
    }

    if (prefix.length < 1 || prefix.length > 2) return null;
    return makeRef(prefix[0], prefix[1] || repo, repo);
}

/** The documented default credential-store entry holding an Azure DevOps PAT
 *  (skills/fleet/auth-azdevops.md, "Storing tokens for reuse":
 *  `credential_store_set name=azdevops_pat`).
 *  A per-sprint override is passed via runner.js args and threaded
 *  through buildProvisionArgs (apra-fleet-5co8.2.3); when unset, this
 *  default is used. */
const DEFAULT_PAT_SECRET = 'azdevops_pat';

/** The canonical remote shape parseRepoRef() expects, quoted into every
 *  operator-facing remedy this module produces (see `repoRefHint` below). */
const REPO_REF_HINT = 'https://dev.azure.com/ORG/PROJECT/_git/REPO';

/**
 * Build the provision_vcs_auth argument object for an Azure DevOps member
 * (apra-fleet-5co8.2.1).
 *
 * WHY A HOOK: the shared argument shape (`git_access` + a `repos` allowlist)
 * is GitHub-App vocabulary. Azure DevOps has no App/installation model at all
 * -- a PAT is minted by a human against an ORG, so what provision_vcs_auth
 * needs here is `org_url` plus the token, and `git_access`/`repos` are
 * meaningless. Expressing that as a descriptor hook keeps the difference in
 * this file instead of adding a provider branch to the shared caller.
 *
 * SECRET TRANSPORT: the PAT is passed as a `{{secure.NAME}}` PLACEHOLDER, never
 * a value. Resolution happens hub-side inside the fleet server; the orchestrator
 * process that calls this hook never holds, logs or transports the plaintext,
 * and a remote member (which has no secret store of its own) never has to.
 * That is also why a missing store entry is a TYPED ERROR rather than a prompt:
 * an unattended preflight/self-heal has no operator attached, and an
 * out-of-band prompt there would stall the sprint instead of failing it.
 *
 * @param {{ base: object, repoRef: ({ org: string }|null|undefined),
 *           availableSecrets: string[]|null, secretName?: string }} ctx
 *   `base` is the shared argument object the caller would otherwise send;
 *   `repoRef` is this provider's own parseRepoRef() output for the member's
 *   remote; `availableSecrets` is the credential-store entry names the caller
 *   observed (null when it could not be read -- then the check is skipped
 *   rather than guessed, and a genuinely missing secret still fails loudly
 *   server-side).
 * @returns {{ args: object }|{ error: string }}
 */
function buildProvisionArgs(ctx) {
    const { base = {}, repoRef, availableSecrets, secretName } = ctx || {};
    const org = repoRef && typeof repoRef.org === 'string' ? repoRef.org.trim() : '';
    if (!org) {
        return {
            error: `ERROR: cannot provision Azure DevOps auth for member '${base.member_name}': no organization could be derived from the member's git remote; expected a remote of the shape ${REPO_REF_HINT}`,
        };
    }

    const name = (typeof secretName === 'string' && secretName.trim()) ? secretName.trim() : DEFAULT_PAT_SECRET;
    if (Array.isArray(availableSecrets) && !availableSecrets.includes(name)) {
        return {
            error: `ERROR: cannot provision Azure DevOps auth for member '${base.member_name}': the credential store has no entry named '${name}'. Store the PAT first with: credential_store_set name=${name}`,
        };
    }

    return {
        args: {
            member_name: base.member_name,
            provider: base.provider,
            // Base org URL with no trailing path -- see auth-azdevops.md's
            // "Org URL must be base URL without trailing path" note and the
            // TF400813 troubleshooting row, which is what a wrong org URL
            // surfaces as.
            org_url: `https://dev.azure.com/${org}`,
            // Placeholder, NOT a value. See SECRET TRANSPORT above.
            pat: `{{secure.${name}}}`,
        },
    };
}

// ---------------------------------------------------------------------------
// REST command builders (apra-fleet-lzfv.2)
// ---------------------------------------------------------------------------
//
// PARAMETER CONTRACT (the shape buildVcsCommand() hands a builder, and what
// apra-fleet-lzfv.3's golden tests and apra-fleet-lzfv.4's response mapping
// read as this provider's contract):
//
//   provider  'azure-devops'
//   repoRef   OPTIONAL { org, project, repo } -- parseRepoRef()'s own output,
//             passed straight through. Individual org/project/repo params
//             take PRECEDENCE over the matching repoRef field, so a caller can
//             override one coordinate without rebuilding the object.
//   org/project/repo  the three coordinates every Azure DevOps REST call
//             needs. All three are required after the repoRef merge; a missing
//             one is a typed ERROR naming the expected remote shape, never a
//             half-built URL.
//   base/head branch names, in GitHub's OWN vocabulary deliberately (`base` =
//             the branch merged INTO -> targetRefName, `head` = the branch
//             merged FROM -> sourceRefName). Keeping github.mjs's field names
//             is what lets runner.js stay provider-agnostic -- see
//             ./index.mjs's "NO OTHER FILE under fleet-sprint/ changes".
//   title/body  PR title and description.
//   pull_request_id  (comment only) the PR to annotate.
//   token     the PAT. REQUIRED -- assertToken() throws the shared typed ERROR.
//   os        resolveMemberOs()'s value, threaded into shQuote()/curlBinary().
//
// AUTH: Azure DevOps' REST API takes a PAT as HTTP Basic with an EMPTY
// username (`-u :PAT`), NOT a bearer token -- the exact form skills/fleet/
// auth-azdevops.md already documents for its connectivity Test call. The PAT
// therefore appears in `command` ONLY; `logSafeCommand` is built by the same
// closure with REDACTED substituted, so no field other than `command` can
// carry it.
//
// URL ENCODING: parseRepoRef() percent-DECODES every field it returns (Azure
// DevOps project names commonly contain spaces), so each coordinate is
// re-encoded per segment here -- see parseRepoRef's own doc note.

/** api-version pinned to 7.1, matching skills/fleet/auth-azdevops.md's own
 *  REST calls. Pinned, never floating: an unversioned Azure DevOps REST call
 *  is rejected outright. */
const API_VERSION = '7.1';

/** Same fixed marker github.mjs uses, so a log scrubber/assertion looking for
 *  a redacted VCS command matches identically across providers. */
const REDACTED = '***REDACTED***';

/** Merge a `repoRef` object with any explicit org/project/repo overrides and
 *  require all three. Throws the typed ERROR (quoting REPO_REF_HINT, the same
 *  remedy text repoRefHint publishes) rather than building a partial URL.
 *
 *  apra-fleet-5co8.11: an explicit param takes precedence over the matching
 *  repoRef field (see the PARAMETER CONTRACT doc block above), but a caller
 *  can hand this a three-part canonical (parseRepoRef()'s own
 *  `org/project/repo` string, or github.mjs's two-part `owner/name`) as a
 *  SINGLE coordinate -- most plausibly `repo` -- instead of splitting it
 *  first. repoApiBase() would then percent-encode the whole slash-bearing
 *  string into one URL segment, building a silently wrong URL (a 404 at
 *  request time) rather than failing at build time. Reject a '/' inside
 *  `org` or `repo` with the same typed ERROR raised for a missing
 *  coordinate, so the mistake surfaces immediately instead of round-tripping
 *  through a live REST call first. `project` is EXCLUDED from this check: an
 *  Azure DevOps project name is decoded free-form by parseRepoRef() and a
 *  literal '/' inside it is a legitimate value re-encoded per segment by
 *  repoApiBase() below (pinned by "each coordinate is percent-encoded per URL
 *  segment" in vcs-azure-devops-builders.test.mjs), not a coordinate-mixing
 *  mistake -- org and repo, by contrast, are never expected to contain one. */
function assertRepoCoords(params, action) {
    const ref = (params && typeof params.repoRef === 'object' && params.repoRef) ? params.repoRef : {};
    const pick = (key) => {
        const own = params && params[key] != null ? params[key] : ref[key];
        return String(own ?? '').trim();
    };
    const org = pick('org');
    const project = pick('project');
    const repo = pick('repo');
    const missing = [['org', org], ['project', project], ['repo', repo]].filter(([, v]) => !v).map(([k]) => k);
    if (missing.length > 0) {
        throw new Error(`ERROR: VCSModule: azure-devops "${action}" needs org, project and repo (missing: ${missing.join(', ')}) -- pass them explicitly or as the repoRef parsed from a remote of the shape ${REPO_REF_HINT}.`);
    }
    const slashed = [['org', org], ['repo', repo]].filter(([, v]) => v.includes('/'));
    if (slashed.length > 0) {
        throw new Error(`ERROR: VCSModule: azure-devops "${action}" got a '/' inside ${slashed.map(([k]) => k).join(', ')} -- pass the three org/project/repo coordinates SEPARATELY, not a combined "org/project/repo" string, per the remote shape ${REPO_REF_HINT}.`);
    }
    return { org, project, repo };
}

/** The org/project/repo REST prefix, each coordinate re-encoded per segment. */
function repoApiBase({ org, project, repo }) {
    return `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}`;
}

/** Azure DevOps' pullrequests endpoint takes FULL ref names
 *  ('refs/heads/main'), not the bare branch names GitHub's API takes, and
 *  rejects a bare name outright. An input that already carries a 'refs/'
 *  prefix is passed through untouched so a caller holding a real ref (e.g.
 *  'refs/heads/feat/x') is never double-prefixed. */
function toFullRef(branch) {
    const value = String(branch).trim();
    return /^refs\//i.test(value) ? value : `refs/heads/${value}`;
}

/**
 * Build the Azure DevOps REST "create pull request" curl command.
 * POST {org}/{project}/_apis/git/repositories/{repo}/pullrequests?api-version=7.1
 * -- see https://learn.microsoft.com/rest/api/azure/devops/git/pull-requests/create
 */
function buildAzureDevOpsCreatePrCommand(params) {
    const { base, head, title, body, token, os } = params || {};
    const coords = assertRepoCoords(params, 'create-pull-request');
    const safeToken = assertToken(token);
    if (!base) throw new Error('ERROR: VCSModule: "base" branch is required to build a create-pull-request command.');
    if (!head) throw new Error('ERROR: VCSModule: "head" branch is required to build a create-pull-request command.');
    if (!title) throw new Error('ERROR: VCSModule: "title" is required to build a create-pull-request command.');

    const payload = {
        sourceRefName: toFullRef(head),
        targetRefName: toFullRef(base),
        title,
    };
    if (body !== undefined) payload.description = body;
    const payloadJson = JSON.stringify(payload);
    const url = `${repoApiBase(coords)}/pullrequests?api-version=${API_VERSION}`;

    const buildCurl = (authToken) => [
        `${curlBinary(os)} -sS -X POST`,
        `-u ${shQuote(`:${authToken}`, os)}`,
        `-H ${shQuote('Content-Type: application/json', os)}`,
        `-H ${shQuote('Accept: application/json', os)}`,
        `-d ${shQuote(payloadJson, os)}`,
        `-w ${shQuote('\n%{http_code}', os)}`,
        url,
    ].join(' ');

    return {
        provider: 'azure-devops',
        action: 'create-pull-request',
        command: buildCurl(safeToken),
        logSafeCommand: buildCurl(REDACTED),
        // Interpretation contract, same field NAMES github.mjs uses so a
        // consumer reads it generically:
        //   - 2xx                   -> success; body has .pullRequestId
        //   - 409 + TF401179        -> an active PR for this source/target
        //                              pair already exists, which is the
        //                              idempotent re-run case, so success
        //   - anything else         -> error
        interpret: {
            successStatusRange: [200, 299],
            alreadyExistsStatus: 409,
            alreadyExistsPattern: 'TF401179',
        },
    };
}

/**
 * Build the Azure DevOps REST "comment on a pull request" curl command, used
 * to annotate an existing PR when a sprint aborts after the PR was already
 * raised (rather than opening a second PR for the same source branch).
 * POST .../pullrequests/{id}/threads?api-version=7.1 -- Azure DevOps has no
 * bare "PR comment" resource: a comment is one entry in a THREAD, so a single
 * text comment is posted as a new active thread carrying exactly one comment.
 * See https://learn.microsoft.com/rest/api/azure/devops/git/pull-request-threads/create
 */
function buildAzureDevOpsCommentCommand(params) {
    const { pull_request_id: pullRequestId, body, token, os } = params || {};
    const coords = assertRepoCoords(params, 'comment');
    const safeToken = assertToken(token);
    if (!pullRequestId) throw new Error('ERROR: VCSModule: "pull_request_id" is required to build an azure-devops comment command.');
    if (!body) throw new Error('ERROR: VCSModule: "body" is required to build a comment command.');

    const payloadJson = JSON.stringify({
        comments: [{ parentCommentId: 0, content: body, commentType: 'text' }],
        status: 'active',
    });
    const url = `${repoApiBase(coords)}/pullrequests/${encodeURIComponent(String(pullRequestId))}/threads?api-version=${API_VERSION}`;

    const buildCurl = (authToken) => [
        `${curlBinary(os)} -sS -X POST`,
        `-u ${shQuote(`:${authToken}`, os)}`,
        `-H ${shQuote('Content-Type: application/json', os)}`,
        `-H ${shQuote('Accept: application/json', os)}`,
        `-d ${shQuote(payloadJson, os)}`,
        `-w ${shQuote('\n%{http_code}', os)}`,
        url,
    ].join(' ');

    return {
        provider: 'azure-devops',
        action: 'comment',
        command: buildCurl(safeToken),
        logSafeCommand: buildCurl(REDACTED),
        interpret: {
            successStatusRange: [200, 299],
        },
    };
}

// ---------------------------------------------------------------------------
// Pull-request RESPONSE mapping (apra-fleet-lzfv.4)
// ---------------------------------------------------------------------------
//
// Azure DevOps' create-pull-request 2xx body speaks a DIFFERENT dialect than
// GitHub's: the identifier is `pullRequestId` (not `number`), and the body
// carries NO browsable web URL at all -- its `url` field is the REST resource
// (.../_apis/git/repositories/{id}/pullRequests/{id}), which is not a page an
// operator can open. The browsable URL therefore has to be CONSTRUCTED from
// the same org/project/repo coordinates the request was built from plus the
// returned id. Declaring both here (rather than teaching the caller either
// dialect) is the whole point of the contract -- see ./index.mjs and
// ./github.mjs's mirror-image declaration.

const PR_ID_FIELD = 'pullRequestId';

/** The browsable pull request page Azure DevOps renders for a PR -- the shape
 *  the web UI itself uses:
 *  https://dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{id}
 *  (the same org/project/_git/repo prefix as the clone URL REPO_REF_HINT
 *  quotes). Published as a template string so a consumer that must mirror this
 *  contract elsewhere (canonical VCS types / fleet client) can restate it
 *  without re-deriving it. */
const PR_WEB_URL_TEMPLATE = 'https://dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{id}';

/** Soft coordinate pick for the response mapping: unlike assertRepoCoords()
 *  (which is building a request URL and MUST fail loudly), a response mapping
 *  never throws -- a missing coordinate simply yields `url: null`, so a caller
 *  reporting an otherwise successful PR is never turned into a crash. */
function softRepoCoords(ctx) {
    const source = (ctx && typeof ctx === 'object') ? ctx : {};
    const ref = (source.repoRef && typeof source.repoRef === 'object') ? source.repoRef : {};
    const pick = (key) => String((source[key] != null ? source[key] : ref[key]) ?? '').trim();
    return { org: pick('org'), project: pick('project'), repo: pick('repo') };
}

/** Map an Azure DevOps create-pull-request response body to { id, url }.
 *  Reads the DECLARED id field above, and builds the web URL from `ctx`'s
 *  org/project/repo (each segment re-encoded, same reason repoApiBase() does).
 *  `ctx` accepts either explicit org/project/repo or a `repoRef` object -- the
 *  same shape the builders take. */
function mapPullRequestResponse(body, ctx) {
    const source = (body && typeof body === 'object') ? body : {};
    const rawId = source[PR_ID_FIELD];
    let id = null;
    if (typeof rawId === 'number' && Number.isFinite(rawId)) id = rawId;
    else if (typeof rawId === 'string' && /^\d+$/.test(rawId.trim())) id = Number(rawId.trim());
    if (id === null) return { id: null, url: null };

    const { org, project, repo } = softRepoCoords(ctx);
    if (!org || !project || !repo) return { id, url: null };
    const url = `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repo)}/pullrequest/${encodeURIComponent(String(id))}`;
    return { id, url };
}

const pullRequestResponse = Object.freeze({
    idField: PR_ID_FIELD,
    // No web-URL field exists in the body -- it is constructed, see above.
    webUrlField: null,
    webUrlTemplate: PR_WEB_URL_TEMPLATE,
    map: mapPullRequestResponse,
});

// ---------------------------------------------------------------------------
// Auth self-heal remedy (apra-fleet-5co8.4.2)
// ---------------------------------------------------------------------------
//
// Unlike a GitHub App installation token (minted fresh, server-side, on every
// provision_vcs_auth call), an Azure DevOps PAT is a long-lived secret the
// fleet only ever STORES and REDEPLOYS -- it never mints one. The Azure
// DevOps PAT lifecycle management API requires an Entra (Azure AD) OAuth
// token with admin consent the fleet does not hold (skills/fleet/
// auth-azdevops.md's "PAT Lifetime and Expiry" section). So when the
// REACTIVE self-heal (runner.js's createVcsAuthSelfHealCallback) fires on an
// auth-classified failure, calling provision_vcs_auth again just redeploys
// the SAME dead secret and is expected to fail again -- serverSideReMintable
// is false, and `hint` is the exact operator-facing remedy runner.js prints
// alongside the (still-attempted, still-logged) self-heal call, covering
// both AUTH_EXPIRED (401/TF400813 -- the PAT itself is dead) and AUTH_DENIED
// (403 -- the PAT is valid but scoped too narrowly; TF401019 is a
// repo/permission grant, not a scope, and has no PAT-rotation remedy) since
// the self-heal callback is never told which kind fired -- see
// ./index.mjs's authRemedy doc.
const AUTH_REMEDY_HINT =
    'Azure DevOps PATs cannot be re-minted server-side. If the PAT expired or ' +
    'was revoked: create a new PAT at https://dev.azure.com/ORG/_settings/tokens, ' +
    'then credential_store_set the fleet secret and re-run provision_vcs_auth. ' +
    'If access was denied for insufficient scope: create a PAT with broader ' +
    'scopes per the role/scope table in skills/fleet/auth-azdevops.md, then ' +
    'credential_store_set the fleet secret and re-run provision_vcs_auth.';

const authRemedy = Object.freeze({
    serverSideReMintable: false,
    hint: AUTH_REMEDY_HINT,
});

export const AzureDevOpsVCS = Object.freeze({
    name: 'azure-devops',
    extends: 'generic-git',
    rules: Object.freeze({
        [K.AUTH_EXPIRED]: AUTH_EXPIRED,
        [K.AUTH_DENIED]: AUTH_DENIED,
    }),
    extractProviderCode,
    matchesHost,
    capabilitiesForHost,
    // apra-fleet-5co8.1.1: remote-URL -> { org, project, repo, canonical }.
    // An OPTIONAL descriptor hook (see ./index.mjs's REQUIRED EXPORT SHAPE):
    // only providers whose REST identity is not the portable "owner/name"
    // pair need it, which is why it lives here rather than in shared code.
    parseRepoRef,
    // apra-fleet-5co8.1.2: the remedy text for a remote this provider claims
    // but parseRepoRef() rejects. Lives here, not in the caller, so runner.js
    // can raise a provider-specific preflight ERROR with no Azure DevOps
    // literal (or conditional) of its own. The canonical https shape is the
    // one an operator copies out of the Azure DevOps "Clone" dialog; the ssh
    // and legacy visualstudio.com shapes parseRepoRef also accepts are
    // deliberately NOT listed, to keep the remedy a single copyable form.
    repoRefHint: REPO_REF_HINT,
    // apra-fleet-5co8.2.1: OPTIONAL descriptor hook -- see ./index.mjs.
    buildProvisionArgs,
    defaultAuthMode: null,
    // apra-fleet-lzfv.4: this provider's create-pull-request response dialect
    // (pullRequestId + a CONSTRUCTED web URL) -- see above.
    pullRequestResponse,
    // apra-fleet-5co8.4.2: PATs are never re-minted server-side -- see above.
    authRemedy,
    // apra-fleet-lzfv.2: the REST builders. capabilitiesForHost() above now
    // reports canOpenPullRequest:true (apra-fleet-lzfv.5) -- the publish path
    // can dispatch them. Any action not listed here still fails closed with
    // buildVcsCommand()'s typed ERROR.
    builders: Object.freeze({
        'create-pull-request': buildAzureDevOpsCreatePrCommand,
        comment: buildAzureDevOpsCommentCommand,
    }),
});

export default AzureDevOpsVCS;
