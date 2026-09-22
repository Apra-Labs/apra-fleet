/**
 * BitbucketVCS -- the Bitbucket provider entry (apra-fleet-647.1.5.1).
 *
 * Registered so Bitbucket is a first-class member of the SAME registry that
 * drives classifyFailure(), resolveProvider() and buildVcsCommand() --
 * before this file existed, 'bitbucket' was only a name-keyed entry in
 * vcs-module.mjs's now-deleted BUILDERS/DEFAULT_AUTH_MODES tables, which a
 * new provider had to also edit.
 *
 * No auth-mode axis of its own (Bitbucket authenticates via a single app
 * password / token field at provision_vcs_auth time, same as Azure DevOps --
 * see ./azure-devops.mjs). Declaring `defaultAuthMode` (even as `null`) is
 * what makes 'bitbucket' part of resolveProvider()'s known vocabulary -- see
 * ./index.mjs's isAuthBackend().
 *
 * apra-fleet-qeq1.3: the create-pull-request builder + response dialect are
 * added below. apra-fleet-qeq1.4 adds capabilitiesForHost() returning
 * {canOpenPullRequest: true}, mirroring github.mjs and azure-devops.mjs, so
 * the Publish PR phase can now dispatch the builder (see ./index.mjs's
 * REQUIRED EXPORT SHAPE: a host never ADVERTISES a pull request it cannot
 * actually deliver).
 *
 * Extends GenericGitVCS for stderr classification (Bitbucket speaks plain
 * git-over-HTTPS/SSH; it had no vendor-specific auth literal in the parity
 * corpus before apra-fleet-417.6 -- see generic-git.mjs's own header note on
 * what belongs portable vs. vendor-specific).
 *
 * apra-fleet-417.6: 'remote: Invalid or expired app password.' is
 * Bitbucket's own literal for a dead/rotated app password, reached without
 * git's generic "fatal: Authentication failed" tail (e.g. over a transport
 * that does not append it). The text says "expired" outright, and
 * re-provisioning a fresh app password is exactly the fix, so AUTH_EXPIRED
 * (contrast Azure DevOps' TF401019, which is AUTH_DENIED -- see
 * ./azure-devops.mjs -- because re-minting the same credential there cannot
 * help).
 *
 * ASCII only.
 */

import { VCS_FAILURE_KINDS as K } from '../errors.mjs';
import { shQuote, shQuoteJson, curlBinary, assertToken } from './shell-helpers.mjs';

const AUTH_EXPIRED = [
    /Invalid or expired app password/i,
];

/** Bitbucket Cloud's own hosts, ANCHORED (never a substring test -- the same
 *  reasoning as ./azure-devops.mjs's HOST_RE, and unlike GitHub Enterprise
 *  Server which has no fixed domain):
 *    - bitbucket.org        https and ssh remotes
 *    - www.bitbucket.org    the www alias (bitbucket.org redirects it, and a
 *                           remote copy-pasted from a browser address bar can
 *                           carry it)
 *    - altssh.bitbucket.org the alternate-port ssh host
 *  A self-hosted Bitbucket Data Center install has an arbitrary domain and is
 *  deliberately left to GenericGitVCS's catch-all rather than guessed at.
 *
 *  apra-fleet-5oo: declaring this makes resolveVcsProviderForHost() name
 *  'bitbucket' for a Bitbucket remote, which is what lets runner.js's
 *  dispatch-time VCS-provider fallback detect it. VCSModule.capabilities()
 *  now reports canOpenPullRequest:true via this provider's capabilitiesForHost
 *  (apra-fleet-qeq1.4), allowing the Publish PR phase to dispatch the builder.
 *
 *  Kept character-for-character in step with
 *  src/utils/vcs-provider-detect.ts's BITBUCKET_HOST_RE -- the two halves of
 *  the same decision must never disagree about who owns a host. */
const HOST_RE = /^(?:www\.|altssh\.)?bitbucket\.org$/i;

function matchesHost(host) {
    return typeof host === 'string' && HOST_RE.test(host.trim());
}

/** Every host this provider matches can open a PR via the REST call
 *  buildBitbucketCreatePrCommand() builds -- bitbucket.org and its aliases
 *  all speak the same `/repositories/{workspace}/{repo}/pullrequests` shape. */
function capabilitiesForHost(_host) {
    return { canOpenPullRequest: true };
}

/** Split a remote URL into { host, path } for BOTH shapes git speaks: a real
 *  scheme'd URL (https, with optional userinfo and port) and the scp-like
 *  shorthand `git@host:path` that `new URL()` cannot parse at all. Mirrors
 *  ./azure-devops.mjs's splitRemote(). */
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

/** Split `path` into non-empty segments with any trailing '.git' stripped off
 *  the last one. Bitbucket workspace/repo slugs are not percent-encoded in
 *  practice (unlike Azure DevOps project names), so no decode step is needed
 *  here. */
function pathSegments(path) {
    const raw = String(path).split('/').filter((part) => part !== '');
    if (raw.length === 0) return raw;
    raw[raw.length - 1] = raw[raw.length - 1].replace(/\.git$/i, '');
    return raw;
}

function makeRef(workspace, repo) {
    if (!workspace || !repo) return null;
    return {
        workspace,
        repo,
        canonical: `${workspace}/${repo}`,
    };
}

/**
 * Parse a Bitbucket git remote URL into its { workspace, repo, canonical }
 * coordinates -- the identity every Bitbucket REST call needs
 * (https://api.bitbucket.org/2.0/repositories/{workspace}/{repo}/...).
 *
 * Recognized shapes:
 *   git@bitbucket.org:WORKSPACE/REPO[.git]
 *   https://[user@]bitbucket.org/WORKSPACE/REPO[.git][/]
 *   ssh://git@altssh.bitbucket.org[:22]/WORKSPACE/REPO[.git]
 *
 * NEVER throws and NEVER partially guesses: anything that is not one of the
 * shapes above -- including a non-Bitbucket host and a lookalike like
 * `bitbucket.org.evil.example` -- returns null, so the caller can raise its
 * own typed ERROR naming the expected shape (repoRefHint) instead of
 * proceeding with half-parsed coordinates.
 *
 * @param {unknown} remoteUrl
 * @returns {{ workspace: string, repo: string, canonical: string }|null}
 */
function parseRepoRef(remoteUrl) {
    if (typeof remoteUrl !== 'string') return null;
    const url = remoteUrl.trim();
    if (!url) return null;

    const split = splitRemote(url);
    if (!split || !matchesHost(split.host)) return null;

    const segments = pathSegments(split.path);
    if (segments.length !== 2) return null;

    return makeRef(segments[0], segments[1]);
}

/** The remote shape parseRepoRef() expects, quoted into every
 *  operator-facing remedy this module produces -- the modern form an
 *  operator copies out of Bitbucket's "Clone" dialog. */
const REPO_REF_HINT = 'git@bitbucket.org:WORKSPACE/REPO.git or https://bitbucket.org/WORKSPACE/REPO.git';

// ---------------------------------------------------------------------------
// REST command builder (apra-fleet-qeq1.3)
// ---------------------------------------------------------------------------
//
// PARAMETER CONTRACT (the shape buildVcsCommand() hands this builder, the
// same convention azure-devops.mjs documents for its own builders):
//
//   provider  'bitbucket'
//   repoRef   OPTIONAL { workspace, repo } -- parseRepoRef()'s own output.
//             Individual workspace/repo params take PRECEDENCE over the
//             matching repoRef field, same rule assertRepoCoords() below
//             applies.
//   workspace/repo  the two coordinates every Bitbucket REST call needs.
//             Both required after the repoRef merge; a missing one is a
//             typed ERROR naming the expected remote shape, never a
//             half-built URL.
//   base/head branch names, GitHub's own vocabulary (see azure-devops.mjs) --
//             Bitbucket's own payload names them source/destination, mapped
//             below.
//   title/body  PR title and description.
//   token     the app password / API token. REQUIRED -- assertToken() throws
//             the shared typed ERROR.
//   username  REQUIRED, unlike Azure DevOps/GitHub: Bitbucket's REST API
//             takes HTTP Basic as 'username:token' (a bare ':token' is
//             rejected), which is the entire reason the bb-cred lane
//             (src/tools/vcs-credential-exec.ts's {{vcs_username}}/
//             {{vcs_username_inline}} placeholder pair) exists -- see the
//             PLANNER DECISION note on the epic apra-fleet-qeq1.
//   os/shell  same meaning and same resolution as azure-devops.mjs documents.
//
// AUTH: `-u '<username>:<token>'`. Both halves appear in `command` ONLY;
// `logSafeCommand` is built by the SAME closure with REDACTED substituted for
// both, so no field other than `command` can carry either credential half.

/** Same fixed marker github.mjs/azure-devops.mjs use, so a log scrubber/
 *  assertion looking for a redacted VCS command matches identically across
 *  providers. */
const REDACTED = '***REDACTED***';

/** Merge a `repoRef` object with any explicit workspace/repo overrides and
 *  require both. Throws the typed ERROR (quoting REPO_REF_HINT) rather than
 *  building a partial URL -- mirrors azure-devops.mjs's assertRepoCoords(). */
function assertRepoCoords(params, action) {
    const ref = (params && typeof params.repoRef === 'object' && params.repoRef) ? params.repoRef : {};
    const pick = (key) => {
        const own = params && params[key] != null ? params[key] : ref[key];
        return String(own ?? '').trim();
    };
    const workspace = pick('workspace');
    const repo = pick('repo');
    const missing = [['workspace', workspace], ['repo', repo]].filter(([, v]) => !v).map(([k]) => k);
    if (missing.length > 0) {
        throw new Error(`ERROR: VCSModule: bitbucket "${action}" needs workspace and repo (missing: ${missing.join(', ')}) -- pass them explicitly or as the repoRef parsed from a remote of the shape ${REPO_REF_HINT}.`);
    }
    const slashed = [['workspace', workspace], ['repo', repo]].filter(([, v]) => v.includes('/'));
    if (slashed.length > 0) {
        throw new Error(`ERROR: VCSModule: bitbucket "${action}" got a '/' inside ${slashed.map(([k]) => k).join(', ')} -- pass the workspace/repo coordinates SEPARATELY, not a combined "workspace/repo" string, per the remote shape ${REPO_REF_HINT}.`);
    }
    return { workspace, repo };
}

/** The workspace/repo REST prefix, each coordinate percent-encoded per
 *  segment (same convention azure-devops.mjs's repoApiBase() follows). */
function repoApiBase({ workspace, repo }) {
    return `https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo)}`;
}

/** Require a non-empty username for HTTP Basic auth -- a bare ':token' Basic
 *  header is silently rejected by Bitbucket's API rather than raising a
 *  clear error, so this must fail at BUILD time, never send that half-built
 *  form. Mirrors assertToken()'s shape/wording, scoped to this provider
 *  since Bitbucket is the only one that requires a username. */
function assertUsername(username, action) {
    const value = String(username ?? '').trim();
    if (!value) {
        throw new Error(`ERROR: VCSModule: bitbucket "${action}" needs a username for HTTP Basic auth (-u '<username>:<token>') -- pass the member's provisioned Bitbucket username/email.`);
    }
    return value;
}

/**
 * Build the Bitbucket REST "create pull request" curl command.
 * POST https://api.bitbucket.org/2.0/repositories/{workspace}/{repo}/pullrequests
 * -- see https://developer.atlassian.com/cloud/bitbucket/rest/api-group-pullrequests/#api-repositories-workspace-repo-slug-pullrequests-post
 */
function buildBitbucketCreatePrCommand(params) {
    const { base, head, title, body, token, username, os, shell } = params || {};
    const coords = assertRepoCoords(params, 'create-pull-request');
    const safeToken = assertToken(token);
    const safeUsername = assertUsername(username, 'create-pull-request');
    if (!base) throw new Error('ERROR: VCSModule: "base" branch is required to build a create-pull-request command.');
    if (!head) throw new Error('ERROR: VCSModule: "head" branch is required to build a create-pull-request command.');
    if (!title) throw new Error('ERROR: VCSModule: "title" is required to build a create-pull-request command.');

    const payload = {
        title,
        source: { branch: { name: head } },
        destination: { branch: { name: base } },
    };
    if (body !== undefined) payload.description = body;
    const payloadJson = JSON.stringify(payload);
    const url = `${repoApiBase(coords)}/pullrequests`;

    const buildCurl = (authUsername, authToken) => [
        `${curlBinary(os)} -sS -X POST`,
        `-u ${shQuote(`${authUsername}:${authToken}`, os, shell)}`,
        `-H ${shQuote('Content-Type: application/json', os, shell)}`,
        `-H ${shQuote('Accept: application/json', os, shell)}`,
        `-d ${shQuoteJson(payloadJson, os, shell)}`,
        `-w ${shQuote('\n%{http_code}', os, shell)}`,
        url,
    ].join(' ');

    return {
        provider: 'bitbucket',
        action: 'create-pull-request',
        command: buildCurl(safeUsername, safeToken),
        logSafeCommand: buildCurl(REDACTED, REDACTED),
        // Interpretation contract, same field NAMES github.mjs/
        // azure-devops.mjs use so a consumer reads it generically:
        //   - 2xx           -> success
        //   - anything else -> error
        // NO already-exists mapping: apra-fleet-qeq1.3 could not CONFIRM
        // Bitbucket's status/body for a duplicate source/destination pull
        // request against a real API response this sprint (this module's
        // stated convention is that an unverified dialect stays ABSENT
        // rather than guessed -- a wrong field would silently swallow a
        // real failure as success, while an absent field only degrades to
        // "treat as an error", which is recoverable). The gap is recorded on
        // the epic apra-fleet-qeq1.
        interpret: {
            successStatusRange: [200, 299],
        },
    };
}

// ---------------------------------------------------------------------------
// Pull-request RESPONSE mapping (apra-fleet-qeq1.3)
// ---------------------------------------------------------------------------
//
// Bitbucket's create-pull-request 2xx body speaks a THIRD dialect: the
// numeric id is flat at `id` (like Azure DevOps' `pullRequestId` is flat, but
// named differently), while the browsable web URL is NESTED at
// `links.html.href` -- contrast github.mjs, which reads a flat `html_url`.

const PR_ID_FIELD = 'id';

/** Map a Bitbucket create-pull-request response body to { id, url }. Reads
 *  the DECLARED id field above and walks the nested links.html.href path;
 *  either a missing id or a missing/malformed nested path degrades to `null`
 *  rather than throwing, so an otherwise successful PR is never turned into
 *  a crash. `ctx` is unused -- Bitbucket's body already carries the
 *  browsable URL, so there is nothing to construct (contrast
 *  azure-devops.mjs). */
function mapPullRequestResponse(body, _ctx) {
    const source = (body && typeof body === 'object') ? body : {};
    const rawId = source[PR_ID_FIELD];
    let id = null;
    if (typeof rawId === 'number' && Number.isFinite(rawId)) id = rawId;
    else if (typeof rawId === 'string' && /^\d+$/.test(rawId.trim())) id = Number(rawId.trim());
    const rawUrl = source.links && typeof source.links === 'object'
        && source.links.html && typeof source.links.html === 'object'
        ? source.links.html.href
        : null;
    return { id, url: typeof rawUrl === 'string' ? rawUrl : null };
}

const pullRequestResponse = Object.freeze({
    idField: PR_ID_FIELD,
    // The web URL is NESTED, not a flat field -- see the header note above.
    webUrlField: 'links.html.href',
    // Read from the body, never constructed -- contrast azure-devops.mjs.
    webUrlTemplate: null,
    map: mapPullRequestResponse,
});

export const BitbucketVCS = Object.freeze({
    name: 'bitbucket',
    extends: 'generic-git',
    rules: Object.freeze({
        [K.AUTH_EXPIRED]: AUTH_EXPIRED,
    }),
    matchesHost,
    capabilitiesForHost,
    // remote-URL -> { workspace, repo, canonical }, mirroring
    // ./azure-devops.mjs's own parseRepoRef axis (apra-fleet-qeq1.2).
    parseRepoRef,
    repoRefHint: REPO_REF_HINT,
    defaultAuthMode: null,
    // apra-fleet-qeq1.3: the create-pull-request builder. capabilitiesForHost
    // is now available (apra-fleet-qeq1.4), so the Publish PR phase can
    // dispatch the builder via VCSModule.capabilities().
    builders: Object.freeze({
        'create-pull-request': buildBitbucketCreatePrCommand,
    }),
    pullRequestResponse,
});

export default BitbucketVCS;
