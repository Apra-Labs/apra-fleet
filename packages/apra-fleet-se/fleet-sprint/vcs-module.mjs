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

/** Build a "comment on abort" command for the given provider. */
export function buildCommentCommand(params) {
    return buildVcsCommand('comment', params);
}

export const VCSModule = { buildCreatePrCommand, buildCommentCommand };

export default VCSModule;
