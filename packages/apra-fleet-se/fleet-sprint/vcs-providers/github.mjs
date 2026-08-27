/**
 * GitHubVCS -- the GitHub provider for VCSModule.classifyFailure(), and (apra-
 * fleet-647.1.5.1) THE manifest entry for everything else GitHub-specific:
 * its default auth mode and its create-pull-request/comment command builders.
 * Before 647.1.5.1 those lived in two separate provider-name-keyed tables in
 * vcs-module.mjs (BUILDERS, DEFAULT_AUTH_MODES) that a new provider had to
 * also edit; now they are fields on THIS descriptor, so adding a provider is
 * one file here, nothing in vcs-module.mjs.
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

const GITHUB_API = 'https://api.github.com';
const REDACTED = '***REDACTED***';
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/** Single-quote a string for embedding in a shell command. The built curl
 *  command is dispatched through the member's own COMMAND SHELL, so the
 *  quoting dialect must follow that shell -- NOT the bare OS:
 *    - POSIX sh/bash (and Git-for-Windows bash on a Windows member) closes/
 *      reopens the quote around an embedded single quote ('\'').
 *    - Windows PowerShell (see wrapPowerShellEncoded()/isWindows in
 *      src/tools/remove-member.ts) escapes an embedded single quote inside a
 *      single-quoted string by DOUBLING it (''), not by backslash-closing.
 *  Using the POSIX form on a PowerShell member breaks the quoting outright
 *  (observed live: Publish PR crashing on any title/body containing an
 *  apostrophe) -- and, the mirror defect, using the PowerShell form on a
 *  Windows member whose registered shell is gitbash corrupts the curl -d
 *  JSON payload (observed live: GitHub's create-PR endpoint answering
 *  "HTTP 400: Problems parsing JSON"), because bash reads '' as
 *  close-then-reopen, not as an escaped quote.
 *
 *  `os` is one of resolveMemberOs()'s return values ('windows'/'linux'/
 *  'darwin'); `shell` is the member's registered shell as resolved by
 *  runner.js's resolveMemberTarget() -- 'gitbash' | 'pwsh7' | 'powershell5'
 *  | '' (empty when the registry recorded none). Resolution, mirroring
 *  se-os-commands.mjs's getSeCommands() matrix:
 *    - shell 'gitbash'                 -> POSIX quoting, even on Windows
 *    - shell 'pwsh7'/'powershell5'     -> PowerShell doubling
 *    - unresolved shell ('') + windows -> PowerShell doubling (the historical
 *      default: every Windows member was assumed PowerShell before shells
 *      were recorded -- the fallback stays byte-identical)
 *    - any non-Windows os              -> POSIX quoting, byte-identical to
 *      before this parameter existed. */
function usesPowerShellQuoting(os, shell) {
    if (shell === 'gitbash') return false;
    if (shell === 'pwsh7' || shell === 'powershell5') return true;
    return os === 'windows';
}

function shQuote(value, os, shell) {
    if (usesPowerShellQuoting(os, shell)) {
        return `'${String(value).replace(/'/g, "''")}'`;
    }
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Which curl binary token to emit for a given member OS. On Windows the bare
 *  word `curl` is a built-in PowerShell alias for Invoke-WebRequest, NOT the
 *  real curl -- Invoke-WebRequest's -Headers parameter wants a hashtable, not
 *  curl's repeatable `-H 'k: v'` string syntax, so a bare `curl -H ...`
 *  command sent to a Windows/PowerShell member fails with a parameter-bind
 *  error (observed live on the Publish PR step). The real curl.exe binary has
 *  shipped in %SystemRoot%\System32 since Windows 10 1803 and is resolvable
 *  from PowerShell's default PATH (verified locally: `where curl.exe` and
 *  `Get-Command curl.exe` both resolve on a live Windows box), so emitting
 *  the explicit `curl.exe` token sidesteps the alias entirely without
 *  needing a different request mechanism. Non-Windows os values keep the
 *  bare `curl` token byte-identical to before this branch existed.
 *  Deliberately OS-keyed (not shell-keyed like shQuote above): curl.exe is
 *  equally resolvable from Git-for-Windows bash, so a windows+gitbash member
 *  keeps the same binary token. */
function curlBinary(os) {
    return os === 'windows' ? 'curl.exe' : 'curl';
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
function buildGitHubCreatePrCommand({ repo, base, head, title, body, token, os, shell }) {
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
        `${curlBinary(os)} -sS -X POST`,
        `-H ${shQuote(`Authorization: Bearer ${authToken}`, os, shell)}`,
        `-H ${shQuote('Accept: application/vnd.github+json', os, shell)}`,
        `-H ${shQuote('Content-Type: application/json', os, shell)}`,
        `-H ${shQuote('X-GitHub-Api-Version: 2022-11-28', os, shell)}`,
        `-d ${shQuote(payloadJson, os, shell)}`,
        `-w ${shQuote('\n%{http_code}', os, shell)}`,
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
function buildGitHubCommentCommand({ repo, issue_number: issueNumber, body, token, os, shell }) {
    const safeRepo = assertRepo(repo);
    const safeToken = assertToken(token);
    if (!issueNumber) throw new Error('ERROR: VCSModule: "issue_number" is required to build a comment command.');
    if (!body) throw new Error('ERROR: VCSModule: "body" is required to build a comment command.');

    const payloadJson = JSON.stringify({ body });
    const url = `${GITHUB_API}/repos/${safeRepo}/issues/${issueNumber}/comments`;

    const buildCurl = (authToken) => [
        `${curlBinary(os)} -sS -X POST`,
        `-H ${shQuote(`Authorization: Bearer ${authToken}`, os, shell)}`,
        `-H ${shQuote('Accept: application/vnd.github+json', os, shell)}`,
        `-H ${shQuote('Content-Type: application/json', os, shell)}`,
        `-H ${shQuote('X-GitHub-Api-Version: 2022-11-28', os, shell)}`,
        `-d ${shQuote(payloadJson, os, shell)}`,
        `-w ${shQuote('\n%{http_code}', os, shell)}`,
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

/** Host-recognition for VCSModule.capabilities() (apra-fleet-647.1.4.1).
 *  `github.com` itself plus GitHub Enterprise Server hosts, which have no
 *  fixed domain -- an operator names theirs anything ("github.mycompany.com",
 *  "ghe.internal", ...) -- so there is no closed literal list to match
 *  against. The portable signal every such host shares is the vendor name
 *  itself appearing in the hostname; a host with no "github" substring (Azure
 *  DevOps' dev.azure.com, GitLab's gitlab.com or a self-hosted
 *  gitlab.example.com, ...) is deliberately left to GenericGitVCS's
 *  catch-all rather than guessed at here. */
function matchesHost(host) {
    return typeof host === 'string' && /github/i.test(host);
}

/** Every host this provider matches can open a PR via the REST call
 *  buildGitHubCreatePrCommand() builds -- github.com and GitHub Enterprise
 *  Server alike speak the same `/repos/{owner}/{repo}/pulls` shape. */
function capabilitiesForHost(_host) {
    return { canOpenPullRequest: true };
}

export const GitHubVCS = Object.freeze({
    name: 'github',
    extends: 'generic-git',
    rules: Object.freeze({
        [K.AUTH_EXPIRED]: AUTH_EXPIRED,
    }),
    extractProviderCode,
    matchesHost,
    capabilitiesForHost,
    // apra-fleet-647.1.5.1: GitHub's own default auth mode (App, never PAT --
    // see vcs-module.mjs resolveProvider()'s header note on why this must stay
    // 'github-app') and its command builders. A provider descriptor need not
    // declare `defaultAuthMode`/`builders` at all (see ./generic-git.mjs,
    // ./dolt.mjs -- classification-only providers that are not a member-facing
    // VCS auth backend); declaring `defaultAuthMode` (even as `null`) is what
    // makes a provider part of resolveProvider()'s/buildVcsCommand()'s known
    // vocabulary -- see ./index.mjs's isAuthBackend().
    defaultAuthMode: 'github-app',
    builders: Object.freeze({
        'create-pull-request': buildGitHubCreatePrCommand,
        comment: buildGitHubCommentCommand,
    }),
});

export default GitHubVCS;
