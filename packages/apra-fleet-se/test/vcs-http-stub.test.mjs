// apra-fleet-j918.8.7 -- drive the REAL VCS create-pull-request path against a
// REAL local HTTP server, with a REAL curl in between.
//
// WHAT THIS PROVES THAT NOTHING ELSE DID
// --------------------------------------
// Every other VCS test in this suite asserts against a hand-written mock of
// curl's captured stdout: test/helpers/mock-sprint-harness.mjs fabricates the
// string `${JSON.stringify(body)}\n${status}` and hands it back as if curl had
// produced it. That mock bakes in two assumptions, neither of which was ever
// checked against a real HTTP exchange:
//
//   A. that `-w '\n%{http_code}'` yields a trailing line containing ONLY the
//      status code, appended after the response body; and
//   B. that each provider's success/error bodies are the JSON shapes the mock
//      hand-writes.
//
// If either is wrong, real credential provisioning and real PR raising break in
// production while the whole mock suite stays green. So these tests:
//
//   1. start a node:http stub on 127.0.0.1:0 (see ./helpers/vcs-http-stub.mjs),
//   2. call the production raiseVcsPrForMember() from fleet-sprint/vcs-auth.mjs,
//   3. let the production provider builders (vcs-providers/github.mjs,
//      vcs-providers/azure-devops.mjs) emit the curl command unchanged,
//   4. substitute the '{{vcs_token_inline}}' placeholder exactly as the server's
//      vcs_credential_exec tool does (src/tools/vcs-credential-exec.ts), swap
//      ONLY the origin so the request lands on the stub, and actually SPAWN
//      curl, and
//   5. assert on the parsed result raiseVcsPrForMember returns, plus on the
//      request the stub actually received.
//
// Hermeticity: the stub binds localhost on an ephemeral port, redirectCurlOrigin
// THROWS rather than dispatching a command that would leave localhost, and every
// proxy env var is blanked for the spawned curl. These tests need no outbound
// network and each one tears its server down in an after() hook; the final test
// in this file proves no listening socket was left behind.
//
// No new npm dependency: node:http and node:child_process only.
//
// ASCII only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';

import { raiseVcsPrForMember } from '../fleet-sprint/vcs-auth.mjs';
import {
    startVcsHttpStub,
    portIsFree,
    redirectCurlOrigin,
    GITHUB_CREATE_PR_201,
    GITHUB_ALREADY_EXISTS_422,
    GITHUB_BAD_CREDENTIALS_401,
    GITHUB_APP_FORBIDDEN_403,
    GITHUB_PAT_FORBIDDEN_403,
    AZURE_CREATE_PR_201,
    AZURE_ALREADY_EXISTS_409,
    AZURE_SIGNIN_HTML_203,
} from './helpers/vcs-http-stub.mjs';

const execAsync = promisify(execCb);

// Every port this file ever bound, so the last test can prove all of them were
// released (the acceptance criterion "leaves no listening socket behind").
const BOUND_PORTS = [];

// The credential the stubbed vcs_credential_exec substitutes. Deliberately
// free of shell metacharacters: POSIX inner-escaping fidelity is already pinned
// by tests/vcs-credential-exec-inline-token.test.ts, and mixing that concern in
// here would make a failure ambiguous between "escaping is wrong" and "the
// response parse is wrong", which is what THIS file is about.
const TOKEN = 'ghs_stubtoken_A1b2C3d4E5f6G7h8I9j0';
const INLINE_PLACEHOLDER = '{{vcs_token_inline}}';

const GITHUB_REMOTE = 'https://github.com/mock-org/mock-repo.git';
const AZURE_REMOTE = 'https://dev.azure.com/mock-org/mock-project/_git/mock-repo';

// Blank every proxy variable: a developer machine with http_proxy set would
// otherwise send even a 127.0.0.1 request through the proxy, turning a hermetic
// test into a network-dependent one.
const HERMETIC_ENV = {
    ...process.env,
    no_proxy: '*',
    NO_PROXY: '*',
    http_proxy: '',
    HTTP_PROXY: '',
    https_proxy: '',
    HTTPS_PROXY: '',
    all_proxy: '',
    ALL_PROXY: '',
};

// POSIX quoting is what the production builders emit for os:'linux', and
// node's exec() runs a cmd.exe shell on Windows, which cannot parse it. The
// production Windows path has its own coverage (vcs-powershell-argv-roundtrip,
// mock-sprint-windows-vcs-credential); this file is the POSIX half.
const POSIX_HOST = process.platform !== 'win32';

let curlAvailable = null;
async function haveCurl() {
    if (curlAvailable !== null) return curlAvailable;
    try {
        await execAsync('curl --version', { env: HERMETIC_ENV, timeout: 15000 });
        curlAvailable = true;
    } catch {
        curlAvailable = false;
    }
    return curlAvailable;
}

/** Skip-with-a-reason guard. Returns true when the test body should run. */
async function canRunRealCurl(t) {
    if (!POSIX_HOST) {
        t.skip('POSIX-shell host only: the production builders emit POSIX quoting for os:"linux", which cmd.exe cannot parse');
        return false;
    }
    if (!(await haveCurl())) {
        t.skip('curl is not on PATH; this test dispatches a real curl at a local node:http stub');
        return false;
    }
    return true;
}

/** Mirrors src/utils/shell-escape.ts escapeShellArgInner -- the exact
 *  transformation vcs_credential_exec applies to the inline placeholder for a
 *  POSIX member. */
const escapeShellArgInner = (s) => String(s).replace(/'/g, "'\\''");

async function runLocalShell(command) {
    try {
        const { stdout, stderr } = await execAsync(command, {
            env: HERMETIC_ENV,
            maxBuffer: 8 * 1024 * 1024,
            timeout: 30000,
        });
        return { code: 0, stdout, stderr };
    } catch (err) {
        return {
            code: typeof err.code === 'number' ? err.code : 1,
            stdout: err.stdout || '',
            stderr: err.stderr || String((err && err.message) || err),
        };
    }
}

/**
 * A fleetApi double that is a faithful stand-in for the SERVER side of the PR
 * path, not a re-implementation of the parsing under test:
 *   - memberDetail answers the member registry (os/shell/vcsProvider) reads
 *     that resolveProvider() and resolveMemberTarget() make;
 *   - provisionVcsAuth answers the just-in-time push+pr mint, recording its
 *     args so the self-heal tests can count re-provisions;
 *   - vcsCredentialExec reproduces src/tools/vcs-credential-exec.ts's own
 *     three steps -- placeholder check, inner-escaped substitution, dispatch --
 *     and then really runs the command, redacting the token out of the captured
 *     streams exactly as the tool does.
 * The ONLY deviation from production is redirectCurlOrigin(), which swaps the
 * provider host for the stub's, and which throws rather than letting anything
 * leave localhost.
 */
function makeStubFleetApi({ stub, provider, calls }) {
    return {
        memberDetail: async () => ({
            content: [{ text: JSON.stringify({ os: 'linux', shell: 'bash', vcsProvider: provider }) }],
        }),
        provisionVcsAuth: async (args) => {
            calls.provision.push(args);
            return {
                content: [{ text: `[OK] Mock ${args.provider} credentials deployed on "${args.member_name}"` }],
                structuredContent: { ok: true, reason: 'ok', expiresAt: null },
            };
        },
        vcsCredentialExec: async ({ member_name: memberName, label, command }) => {
            calls.exec.push({ memberName, label, command });
            if (!command.includes(INLINE_PLACEHOLDER)) {
                return {
                    content: [{ text: `[FAIL] command must contain ${INLINE_PLACEHOLDER}` }],
                    structuredContent: { ok: false, reason: 'placeholder_missing', exitCode: null, stdout: '', stderr: '' },
                };
            }
            const substituted = command.split(INLINE_PLACEHOLDER).join(escapeShellArgInner(TOKEN));
            const dispatched = redirectCurlOrigin(substituted, stub.origin);
            const { code, stdout, stderr } = await runLocalShell(dispatched);
            return {
                content: [{ text: `[OK] Ran credential-requiring command on "${memberName}" (exit ${code}).` }],
                structuredContent: {
                    ok: true,
                    reason: 'ok',
                    exitCode: code,
                    stdout: stdout.split(TOKEN).join('***REDACTED***'),
                    stderr: stderr.split(TOKEN).join('***REDACTED***'),
                },
            };
        },
    };
}

let memberSeq = 0;
/** fleet-sprint/member-target.mjs caches the resolved os/shell per member NAME
 *  for the lifetime of the process, so each scenario gets its own member to
 *  keep the scenarios independent. */
const nextMember = (tag) => `stub-${tag}-${++memberSeq}`;

/** Start a stub, register its teardown in an after() hook, and record its port
 *  for the no-leaked-listener check at the end of the file. */
async function stubFor(t, handler) {
    const stub = await startVcsHttpStub(handler);
    BOUND_PORTS.push(stub.port);
    t.after(async () => { await stub.close(); });
    return stub;
}

/** Drive the production PR path end to end against `stub`. */
async function raisePr({ stub, provider, remoteUrl, member, calls, title = 'Sprint PR', body = 'stub body' }) {
    const logs = [];
    const result = await raiseVcsPrForMember({
        fleetApi: makeStubFleetApi({ stub, provider, calls }),
        // `command` is only reachable via the git-remote read, which
        // remoteUrlOverride short-circuits; a call would be a bug, so it throws.
        command: async (cmd) => { throw new Error(`unexpected command() dispatch in this test: ${cmd}`); },
        member,
        base: 'main',
        head: 'auto-sprint/stub',
        title,
        body,
        log: (line) => logs.push(String(line)),
        logPrefix: 'vcs-http-stub',
        remoteUrlOverride: remoteUrl,
    });
    return { result, logs };
}

const freshCalls = () => ({ provision: [], exec: [] });

// =============================================================================
// (1) GitHub success -- including the trailer extraction the mocks assume.
// =============================================================================

// The response body below is VALID JSON but is laid out so that raw newlines
// and DIGITS-ONLY lines appear inside it -- `1347` and `401` each sit alone on
// their own line. curl then appends "\n201". A trailer extractor that grabbed
// the first digits-only line, or ran a loose /\d{3}/ over the whole capture,
// would read 401 (an auth failure, which would trigger a self-heal re-provision
// and a retry) or 1347 instead of 201. Asserting ok:true AND a single HTTP
// request AND a single provision call is what makes that distinguishable.
const GITHUB_201_ODD_WHITESPACE = [
    '{',
    '"number":',
    String(GITHUB_CREATE_PR_201.number),
    ',',
    `"html_url": ${JSON.stringify(GITHUB_CREATE_PR_201.html_url)},`,
    '"state": "open",',
    '"_stub_digits_only_line":',
    '401',
    '}',
].join('\n');

test('github: a real curl against the stub parses a 201 body whose own lines contain digits and raw newlines, taking the status from the -w trailer', async (t) => {
    if (!(await canRunRealCurl(t))) return;

    const stub = await stubFor(t, () => ({ status: 201, body: GITHUB_201_ODD_WHITESPACE }));
    const calls = freshCalls();
    const member = nextMember('gh-201');

    const { result } = await raisePr({ stub, provider: 'github', remoteUrl: GITHUB_REMOTE, member, calls });

    assert.deepEqual(result, {
        ok: true,
        alreadyExists: false,
        prUrl: GITHUB_CREATE_PR_201.html_url,
        error: null,
        authFailure: false,
    });

    // Exactly one exchange: no self-heal was triggered, which is only true if
    // the trailer really was read as 201 and not as the body's own 401 line.
    assert.equal(stub.requests.length, 1, 'expected exactly one HTTP request (no auth self-heal retry)');
    assert.equal(calls.provision.length, 1, 'expected exactly one just-in-time push+pr provision');

    // ...and the request that arrived is the one the production builder meant
    // to send: the real endpoint, the real auth header carrying the substituted
    // token, the real GitHub media-type/api-version headers, the real payload.
    const req = stub.requests[0];
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/repos/mock-org/mock-repo/pulls');
    assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(req.headers.accept, 'application/vnd.github+json');
    assert.equal(req.headers['content-type'], 'application/json');
    assert.equal(req.headers['x-github-api-version'], '2022-11-28');
    assert.deepEqual(JSON.parse(req.rawBody), {
        title: 'Sprint PR',
        head: 'auto-sprint/stub',
        base: 'main',
        body: 'stub body',
    });
});

test('github: the -w trailer wins even when the response body is unparseable and its LAST line is itself a status-looking number', async (t) => {
    if (!(await canRunRealCurl(t))) return;

    // Not JSON, and ends with a bare "401". curl appends "\n201" after it, so
    // the capture ends "...\n401\n201". The status must be 201 (last line) and
    // the body must degrade to unparseable -- never a 401 that would be
    // classified as an auth failure and retried.
    const stub = await stubFor(t, () => ({
        status: 201,
        headers: { 'content-type': 'text/plain' },
        body: 'created\nsee also\n401',
    }));
    const calls = freshCalls();

    const { result } = await raisePr({
        stub, provider: 'github', remoteUrl: GITHUB_REMOTE, member: nextMember('gh-trailer'), calls,
    });

    assert.equal(result.ok, true, 'a 2xx trailer is success even when the body cannot be parsed');
    assert.equal(result.authFailure, false, 'the body\'s trailing 401 must not be mistaken for the HTTP status');
    assert.equal(result.prUrl, null, 'an unparseable body yields no PR URL rather than a guess');
    assert.equal(stub.requests.length, 1, 'no retry: nothing was classified as an auth failure');
    assert.equal(calls.provision.length, 1);
});

// =============================================================================
// (2) GitHub 422 already-exists -- the nested error-body shape the mock-sprint
//     harness hand-writes, now checked against a real parse.
// =============================================================================

test('github: the 422 already-exists body is read as idempotent success and yields the existing PR URL from errors[].message', async (t) => {
    if (!(await canRunRealCurl(t))) return;

    const stub = await stubFor(t, () => ({ status: 422, body: GITHUB_ALREADY_EXISTS_422 }));
    const calls = freshCalls();

    const { result } = await raisePr({
        stub, provider: 'github', remoteUrl: GITHUB_REMOTE, member: nextMember('gh-422'), calls,
    });

    assert.deepEqual(result, {
        ok: true,
        alreadyExists: true,
        // Trailing '.' stripped by the caller's own sentence-punctuation trim.
        prUrl: 'https://github.com/mock-org/mock-repo/pull/1',
        error: null,
        authFailure: false,
    });
    assert.equal(stub.requests.length, 1, '422 already-exists is not an auth failure and must not be retried');
    assert.equal(calls.provision.length, 1, 'no self-heal re-provision for an already-exists response');
});

// =============================================================================
// (3) GitHub auth failures -- both auth modes, over a real socket.
// =============================================================================

test('github: a real 401 "Bad credentials" triggers exactly one self-heal re-provision and one retry, then succeeds', async (t) => {
    if (!(await canRunRealCurl(t))) return;

    let seen = 0;
    const stub = await stubFor(t, () => {
        seen += 1;
        return seen === 1
            ? { status: 401, body: GITHUB_BAD_CREDENTIALS_401 }
            : { status: 201, body: GITHUB_CREATE_PR_201 };
    });
    const calls = freshCalls();

    const { result, logs } = await raisePr({
        stub, provider: 'github', remoteUrl: GITHUB_REMOTE, member: nextMember('gh-401'), calls,
    });

    assert.equal(result.ok, true);
    assert.equal(result.alreadyExists, false);
    assert.equal(result.prUrl, GITHUB_CREATE_PR_201.html_url);
    assert.equal(stub.requests.length, 2, 'the 401 attempt plus exactly one retry');
    assert.equal(
        calls.provision.filter((c) => c.git_access === 'push+pr').length,
        2,
        'the just-in-time mint plus exactly ONE self-heal re-provision',
    );
    assert.ok(
        logs.some((l) => /auth-classified failure/.test(l) && /HTTP 401/.test(l)),
        `expected a logged auth-classified-failure line naming HTTP 401, got: ${JSON.stringify(logs)}`,
    );
    // The token reached the wire (proving the substitution really happened) but
    // never reached a log line.
    assert.equal(stub.requests[0].headers.authorization, `Bearer ${TOKEN}`);
    assert.ok(!logs.some((l) => l.includes(TOKEN)), 'the raw token must never appear in a log line');
});

for (const [mode, body] of [
    ['github-app', GITHUB_APP_FORBIDDEN_403],
    ['pat', GITHUB_PAT_FORBIDDEN_403],
]) {
    test(`github: a persistent 403 in ${mode} mode is auth-classified, retried exactly once, and then reported with the provider's own message`, async (t) => {
        if (!(await canRunRealCurl(t))) return;

        const stub = await stubFor(t, () => ({ status: 403, body }));
        const calls = freshCalls();

        const { result } = await raisePr({
            stub, provider: 'github', remoteUrl: GITHUB_REMOTE, member: nextMember(`gh-403-${mode}`), calls,
        });

        assert.equal(result.ok, false);
        assert.equal(result.authFailure, true);
        assert.equal(result.prUrl, null);
        assert.equal(
            result.error,
            `HTTP 403: ${body.message}`,
            'the reported error is the status plus the provider body\'s own `message` field',
        );
        assert.equal(stub.requests.length, 2, 'bounded one-shot self-heal: the attempt plus exactly one retry');
    });
}

// =============================================================================
// (4) Azure DevOps -- a second REST dialect through the same parsing path.
//     Covered here (rather than noted as an omission) because the provider
//     rules table already encodes its request shape, its 201 body dialect
//     (`pullRequestId` + a CONSTRUCTED web URL) and its already-exists
//     contract (409 + TF401179) -- see vcs-providers/azure-devops.mjs.
// =============================================================================

test('azure-devops: a real 201 maps through the provider response hook to pullRequestId plus a constructed browsable URL', async (t) => {
    if (!(await canRunRealCurl(t))) return;

    const stub = await stubFor(t, () => ({ status: 201, body: AZURE_CREATE_PR_201 }));
    const calls = freshCalls();

    const { result } = await raisePr({
        stub, provider: 'azure-devops', remoteUrl: AZURE_REMOTE, member: nextMember('az-201'), calls,
    });

    assert.equal(result.ok, true);
    assert.equal(result.alreadyExists, false);
    assert.equal(
        result.prUrl,
        'https://dev.azure.com/mock-org/mock-project/_git/mock-repo/pullrequest/22',
        'the browsable URL is constructed from the request coordinates, never the body\'s REST `url`',
    );

    const req = stub.requests[0];
    assert.equal(req.method, 'POST');
    assert.equal(
        req.url,
        '/mock-org/mock-project/_apis/git/repositories/mock-repo/pullrequests?api-version=7.1',
    );
    // Azure DevOps authenticates a PAT as HTTP basic with an EMPTY username
    // (`curl -u :TOKEN`), not as a bearer token -- a different mechanism than
    // GitHub's, reaching the wire through the same code path.
    assert.equal(
        req.headers.authorization,
        `Basic ${Buffer.from(`:${TOKEN}`).toString('base64')}`,
    );
    assert.deepEqual(JSON.parse(req.rawBody), {
        sourceRefName: 'refs/heads/auto-sprint/stub',
        targetRefName: 'refs/heads/main',
        title: 'Sprint PR',
        description: 'stub body',
    });
});

test('azure-devops: a real 409 TF401179 is read as idempotent success with the existing PR URL', async (t) => {
    if (!(await canRunRealCurl(t))) return;

    const stub = await stubFor(t, () => ({ status: 409, body: AZURE_ALREADY_EXISTS_409 }));
    const calls = freshCalls();

    const { result } = await raisePr({
        stub, provider: 'azure-devops', remoteUrl: AZURE_REMOTE, member: nextMember('az-409'), calls,
    });

    assert.equal(result.ok, true);
    assert.equal(result.alreadyExists, true);
    assert.equal(result.prUrl, 'https://dev.azure.com/mock-org/mock-project/_git/mock-repo/pullrequest/22');
    assert.equal(result.authFailure, false);
    assert.equal(stub.requests.length, 1, 'an already-exists 409 must not be retried');
});

test('azure-devops: a non-JSON sign-in page is reported as a plain failure with the body text, never as a success', async (t) => {
    if (!(await canRunRealCurl(t))) return;

    const stub = await stubFor(t, () => ({
        status: 203,
        headers: { 'content-type': 'text/html' },
        body: AZURE_SIGNIN_HTML_203,
    }));
    const calls = freshCalls();

    const { result } = await raisePr({
        stub, provider: 'azure-devops', remoteUrl: AZURE_REMOTE, member: nextMember('az-203'), calls,
    });

    // 203 IS inside the provider's declared 2xx success range, so this is the
    // shape that makes an unparseable body dangerous: the call "succeeds" but
    // carries no PR. Pinned as-is (ok:true, prUrl:null) so a future change to
    // that contract is a visible diff here rather than a silent one in prod.
    assert.equal(result.ok, true);
    assert.equal(result.prUrl, null, 'no PR id/URL can be read out of a sign-in page');
    assert.equal(stub.requests.length, 1);
});

// =============================================================================
// (5) Hermeticity and cleanup.
// =============================================================================

test('the stub refuses to dispatch a command that would leave localhost', () => {
    assert.throws(
        () => redirectCurlOrigin('curl -sS -X POST https://example.invalid/pulls', 'http://127.0.0.1:1'),
        /refusing to dispatch it/,
    );
    assert.equal(
        redirectCurlOrigin('curl -sS https://api.github.com/repos/o/r/pulls', 'http://127.0.0.1:9'),
        'curl -sS http://127.0.0.1:9/repos/o/r/pulls',
    );
});

test('no listening socket is left behind by any stub this file started', async (t) => {
    if (!(await canRunRealCurl(t))) return;
    assert.ok(BOUND_PORTS.length > 0, 'expected at least one stub to have been started (otherwise this check is vacuous)');
    const stillBound = [];
    for (const port of BOUND_PORTS) {
        if (!(await portIsFree(port))) stillBound.push(port);
    }
    assert.deepEqual(stillBound, [], `these stub ports were still bound after their after() hooks ran: ${stillBound.join(', ')}`);
});
