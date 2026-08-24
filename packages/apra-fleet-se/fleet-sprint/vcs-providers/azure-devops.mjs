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
 * apra-fleet-5co8.1.1 adds the host/URL axis: matchesHost(),
 * capabilitiesForHost() and parseRepoRef(). All three are descriptor hooks
 * dispatched from shared code (./index.mjs's resolveVcsProviderForHost(),
 * vcs-module.mjs's capabilities()), so no Azure DevOps conditional leaks into
 * a shared file. capabilitiesForHost() reports canOpenPullRequest:false while
 * `builders` is null and flips true in the SAME change that adds them.
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
 * ASCII only.
 */

import { VCS_FAILURE_KINDS as K } from '../errors.mjs';

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
 *      azure-devops.mjs has no REST builders yet (`builders: null` below),
 *      but classifyFailure() is reachable standalone (see
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

/** Azure DevOps cannot open a pull request yet: `builders` is still null, so
 *  advertising the capability would let a caller (runner.js's Publish-PR gate)
 *  reach buildVcsCommand() only to get a typed "does not yet implement action"
 *  ERROR. This flips to true in the SAME change that adds the builders. */
function capabilitiesForHost(_host) {
    return { canOpenPullRequest: false };
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
    builders: null,
});

export default AzureDevOpsVCS;
