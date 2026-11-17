// A minimal, hermetic local HTTP stub for the VCS REST endpoints the fleet's
// create-pull-request path actually talks to (apra-fleet-j918.8.7).
//
// WHY THIS EXISTS
// ---------------
// Before this helper there was NO HTTP stub anywhere in the repo for a VCS
// REST API: every VCS test asserted against a hand-written mock of curl's
// captured stdout (see test/helpers/mock-sprint-harness.mjs, which fabricates
// `${JSON.stringify(body)}\n${status}` strings directly). Those mocks encode
// two assumptions that nothing verified:
//
//   1. that curl's `-w '\n%{http_code}'` trailer really is a LAST line
//      carrying only the status code, appended after the response body; and
//   2. that each provider's success/error bodies really are the JSON shapes
//      the mock hand-writes.
//
// A wrong assumption there is not a test-hygiene problem -- it silently breaks
// real credential provisioning and real PR raising in production. So this
// helper serves the response shapes over a REAL socket and lets the tests run
// a REAL curl against it, which is the only way those two assumptions can be
// checked rather than restated.
//
// CONSTRAINTS (all deliberate):
//   - node:http only. No new npm dependency (no nock, no msw).
//   - Binds 127.0.0.1 on an EPHEMERAL port (port 0), so the test needs no
//     outbound network and cannot collide with a concurrent test worker.
//   - close() fully awaits the server shutdown so a caller's after() hook
//     leaves no listening socket behind; portIsFree() lets a test PROVE that.
//
// ASCII only.

import http from 'node:http';
import net from 'node:net';

/**
 * Start a localhost HTTP stub.
 *
 * @param {(request: { method: string, url: string, headers: Record<string,string>, rawBody: string }) =>
 *          ({ status?: number, body?: string|object, headers?: Record<string,string> }|undefined)} handler
 *   Called once per request. Return `body` as a STRING to control the exact
 *   bytes on the wire (the whole point for the trailer-extraction tests:
 *   raw newlines and digits-only lines inside the body), or as an object to
 *   have it JSON.stringify'd.
 * @returns {Promise<{ port: number, origin: string, requests: Array<object>, close: () => Promise<void> }>}
 */
export async function startVcsHttpStub(handler) {
    if (typeof handler !== 'function') {
        throw new Error('startVcsHttpStub(handler): handler must be a function');
    }
    const requests = [];

    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const record = {
                method: req.method,
                url: req.url,
                headers: { ...req.headers },
                rawBody: Buffer.concat(chunks).toString('utf8'),
            };
            requests.push(record);

            let reply;
            try {
                reply = handler(record) || {};
            } catch (err) {
                // A throwing handler is a TEST bug; surface it as a 599 with
                // the message in the body rather than hanging the socket, so
                // the assertion that fails names the real cause.
                reply = { status: 599, body: `stub handler threw: ${err && err.message ? err.message : err}` };
            }

            const status = typeof reply.status === 'number' ? reply.status : 200;
            const body = typeof reply.body === 'string'
                ? reply.body
                : JSON.stringify(reply.body === undefined ? {} : reply.body);
            const headers = {
                'content-type': 'application/json',
                ...(reply.headers || {}),
                // content-length last: computed from the bytes actually sent,
                // never overridable by a caller's headers (a wrong length
                // would make curl hang or truncate, which reads as a flake).
                'content-length': String(Buffer.byteLength(body)),
            };
            res.writeHead(status, headers);
            res.end(body);
        });
    });

    await new Promise((resolve, reject) => {
        const onError = (err) => reject(err);
        server.once('error', onError);
        server.listen(0, '127.0.0.1', () => {
            server.removeListener('error', onError);
            resolve();
        });
    });

    const { port } = server.address();

    return {
        port,
        origin: `http://127.0.0.1:${port}`,
        requests,
        async close() {
            // closeAllConnections() first: server.close() only stops NEW
            // connections, so a keep-alive socket curl left open would make
            // the close callback -- and therefore the after() hook -- wait
            // for the idle timeout instead of returning promptly.
            if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
            await new Promise((resolve) => server.close(() => resolve()));
        },
    };
}

/**
 * True when nothing is listening on 127.0.0.1:port. Implemented by BINDING the
 * port rather than by connecting to it: a successful bind is positive proof the
 * port was released, whereas a refused connection can also mean a firewall or a
 * socket stuck in a half-closed state.
 *
 * @param {number} port
 * @returns {Promise<boolean>}
 */
export async function portIsFree(port) {
    return new Promise((resolve) => {
        const probe = net.createServer();
        probe.once('error', () => resolve(false));
        probe.listen(port, '127.0.0.1', () => {
            probe.close(() => resolve(true));
        });
    });
}

/**
 * Point a provider-built curl command at the local stub instead of the real
 * provider host, leaving EVERYTHING else about the command (flags, quoting,
 * headers, the `-w '\n%{http_code}'` trailer, the JSON payload) byte-identical
 * to what the production builder emitted.
 *
 * THROWS when no known origin is present. That is the hermeticity guard: a
 * builder change that emitted some other host would otherwise let a test
 * silently reach the real internet, which is exactly the failure mode this
 * whole helper exists to rule out.
 *
 * @param {string} command
 * @param {string} origin e.g. 'http://127.0.0.1:53211'
 * @returns {string}
 */
export function redirectCurlOrigin(command, origin) {
    const KNOWN_ORIGINS = ['https://api.github.com', 'https://dev.azure.com'];
    for (const known of KNOWN_ORIGINS) {
        if (command.includes(known)) return command.split(known).join(origin);
    }
    throw new Error(
        `redirectCurlOrigin: command targets none of the known provider origins (${KNOWN_ORIGINS.join(', ')}) `
        + `-- refusing to dispatch it, since it would leave localhost. Command: ${command}`,
    );
}

// ---------------------------------------------------------------------------
// Canned response shapes
// ---------------------------------------------------------------------------
//
// These are the bodies the providers' real APIs return for the outcomes the
// fleet's create-pull-request path branches on. They are kept here (not inline
// in one test) so a second consumer asserts against the SAME shape rather than
// re-deriving a slightly different one -- the drift that made the hand-written
// mock-sprint mocks unverifiable in the first place.
//
// GitHub's SUCCESS body is auth-mode-independent: a GitHub App installation
// token and a classic/fine-grained PAT hit the identical endpoint and get the
// identical 201 shape. The two modes differ only in how a REFUSAL reads, which
// is why there are two distinct 403 bodies below and one shared 201.

/** GitHub POST /repos/{owner}/{repo}/pulls -- 201 Created. */
export const GITHUB_CREATE_PR_201 = Object.freeze({
    id: 981723,
    number: 1347,
    url: 'https://api.github.com/repos/mock-org/mock-repo/pulls/1347',
    html_url: 'https://github.com/mock-org/mock-repo/pull/1347',
    state: 'open',
    title: 'Sprint PR',
});

/** GitHub 422 -- a PR for this head already exists. The idempotent re-run
 *  case: the fleet treats it as success and scrapes the existing PR URL out
 *  of the nested errors[].message text. */
export const GITHUB_ALREADY_EXISTS_422 = Object.freeze({
    message: 'Validation Failed',
    errors: [{
        resource: 'PullRequest',
        code: 'custom',
        message: 'A pull request already exists for mock-org:auto-sprint/stub. https://github.com/mock-org/mock-repo/pull/1.',
    }],
    documentation_url: 'https://docs.github.com/rest/pulls/pulls#create-a-pull-request',
});

/** GitHub 401 -- the token itself is dead. Identical wording for an expired
 *  GitHub App installation token and for a revoked PAT. */
export const GITHUB_BAD_CREDENTIALS_401 = Object.freeze({
    message: 'Bad credentials',
    documentation_url: 'https://docs.github.com/rest',
    status: '401',
});

/** GitHub 403, GitHub App mode -- the App installation lacks the
 *  pull_requests:write permission. */
export const GITHUB_APP_FORBIDDEN_403 = Object.freeze({
    message: 'Resource not accessible by integration',
    documentation_url: 'https://docs.github.com/rest/pulls/pulls#create-a-pull-request',
    status: '403',
});

/** GitHub 403, PAT mode -- the fine-grained PAT lacks the Pull requests
 *  write permission. Same status, DIFFERENT message than App mode. */
export const GITHUB_PAT_FORBIDDEN_403 = Object.freeze({
    message: 'Resource not accessible by personal access token',
    documentation_url: 'https://docs.github.com/rest/pulls/pulls#create-a-pull-request',
    status: '403',
});

/** Azure DevOps POST .../pullrequests?api-version=7.1 -- 201 Created. Note
 *  `pullRequestId` (not `number`) and a `url` that is the REST resource, not
 *  a browsable page: the browsable URL has to be constructed. */
export const AZURE_CREATE_PR_201 = Object.freeze({
    repository: { id: 'e1a2b3c4', name: 'mock-repo', project: { name: 'mock-project' } },
    pullRequestId: 22,
    codeReviewId: 22,
    status: 'active',
    sourceRefName: 'refs/heads/auto-sprint/stub',
    targetRefName: 'refs/heads/main',
    title: 'Sprint PR',
    url: 'https://dev.azure.com/mock-org/_apis/git/repositories/e1a2b3c4/pullRequests/22',
});

/** Azure DevOps 409 -- TF401179, an active PR for this source/target pair
 *  already exists. The Azure DevOps spelling of GitHub's 422 above. */
export const AZURE_ALREADY_EXISTS_409 = Object.freeze({
    $id: '1',
    innerException: null,
    message: 'TF401179: An active pull request for the source and target branch already exists. https://dev.azure.com/mock-org/mock-project/_git/mock-repo/pullrequest/22',
    typeName: 'Microsoft.TeamFoundation.Git.Server.GitPullRequestExistsException',
    typeKey: 'GitPullRequestExistsException',
    errorCode: 0,
    eventId: 3000,
});

/** Azure DevOps 203 Non-Authoritative Information -- what dev.azure.com
 *  actually answers with (an HTML sign-in page) when the PAT is bad, instead
 *  of a 401. Kept as a literal STRING because the bytes matter: it is not
 *  JSON, so it exercises the unparseable-body branch. */
export const AZURE_SIGNIN_HTML_203 = '<html><head><title>Azure DevOps Services | Sign In</title></head><body>203</body></html>';
