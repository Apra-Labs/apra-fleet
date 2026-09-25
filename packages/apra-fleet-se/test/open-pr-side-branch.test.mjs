import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    openSideBranchPullRequest,
    resolvePrInputs,
    main,
    USAGE,
} from '../bin/open-pr.mjs';
import { classifyFailure } from '../fleet-sprint/vcs-module.mjs';
import { VCS_FAILURE_KINDS as K } from '../fleet-sprint/errors.mjs';

// =============================================================================
// Coverage for the side-branch PR invocation (bin/open-pr.mjs, `fleet-se-pr`)
// and for the misleading GraphQL createPullRequest refusal it exists to make
// unnecessary (vcs-providers/github.mjs's CREATE_PR_GRAPHQL_REFUSAL).
//
// Everything here runs against a STUBBED dispatcher, modelled on the
// collaborator response shapes vcs-auth-raise-pr.test.mjs documents:
//   - fleetApi.memberDetail()       -> { content: [{ text: JSON.stringify(...) }] }
//   - fleetApi.provisionVcsAuth()   -> structuredContent.ok
//   - fleetApi.vcsCredentialExec()  -> structuredContent { ok, reason, exitCode,
//                                      stdout: "<json body>\n<http status>", stderr }
//
// No real network call, no api.github.com, no live credential, and no git,
// filesystem or sqlite work -- so no case here needs a per-case timeout of the
// kind the neighbouring slow specs carry.
// =============================================================================

function memberDetailResult() {
    return { content: [{ text: JSON.stringify({ vcsProvider: 'github', os: 'linux', shell: '' }) }] };
}

function credExecResult({ status, body }) {
    return {
        content: [{ text: '' }],
        structuredContent: {
            ok: true,
            reason: 'ok',
            exitCode: 0,
            stdout: `${JSON.stringify(body)}\n${status}`,
            stderr: '',
        },
    };
}

/** A stub fleet client that records every dispatched create-pull-request
 *  command instead of running it. */
function makeFleetApi({ responses }) {
    const dispatched = [];
    let call = 0;
    return {
        dispatched,
        async memberDetail() {
            return memberDetailResult();
        },
        async provisionVcsAuth() {
            return { content: [{ text: 'ok' }], structuredContent: { ok: true, expiresAt: null } };
        },
        async vcsCredentialExec(args) {
            dispatched.push(args);
            const response = responses[Math.min(call, responses.length - 1)];
            call += 1;
            return response;
        },
    };
}

// The member-bound dispatcher is never expected to run: every call below
// supplies `remoteUrl`, which is exactly what lets raiseVcsPrForMember skip
// its own 'git remote get-url origin' dispatch. Any call here is a bug.
function makeCommand(calls) {
    return async (cmd) => {
        calls.push(cmd);
        return { ok: true, output: '', error: null };
    };
}

describe('fleet-se-pr: the side-branch PR invocation (bin/open-pr.mjs)', () => {
    test('AC1: dispatches a POST to /repos/{owner}/{repo}/pulls carrying the caller-supplied base and head', async () => {
        const fleetApi = makeFleetApi({
            responses: [credExecResult({
                status: 201,
                body: { number: 7, html_url: 'https://example.invalid/acme/widgets/pull/7' },
            })],
        });
        const commandCalls = [];

        const res = await openSideBranchPullRequest({
            fleetApi,
            command: makeCommand(commandCalls),
            member: 'side-branch-pr-member',
            base: 'trunk',
            head: 'fix/some-side-branch',
            title: 'fix: handle key rotation timeout',
            body: 'Closes the rotation race.',
            remoteUrl: 'https://github.com/acme/widgets.git',
        });

        assert.equal(res.ok, true, 'a 201 must report success');
        assert.equal(res.alreadyExists, false);
        assert.equal(res.prUrl, 'https://example.invalid/acme/widgets/pull/7');
        assert.equal(res.error, null);

        assert.equal(fleetApi.dispatched.length, 1, 'exactly one PR-creation dispatch');
        const built = fleetApi.dispatched[0].command;

        // The REST route, with the caller's OWN owner/repo -- not a default.
        assert.ok(
            built.includes('https://api.github.com/repos/acme/widgets/pulls'),
            `expected the REST create-pull-request URL in the dispatched command, got: ${built}`,
        );
        assert.match(built, /-X POST/, 'must be a POST');

        // The caller's exact base/head reach the request payload.
        const payloadMatch = built.match(/-d '(\{.*?\})'/);
        assert.ok(payloadMatch, `expected a JSON -d payload in the dispatched command, got: ${built}`);
        const payload = JSON.parse(payloadMatch[1]);
        assert.equal(payload.base, 'trunk', 'the caller-supplied base must be sent verbatim');
        assert.equal(payload.head, 'fix/some-side-branch', 'the caller-supplied head must be sent verbatim');
        assert.equal(payload.title, 'fix: handle key rotation timeout');

        // No GraphQL, and no gh: this is the REST path or nothing.
        assert.ok(!/graphql/i.test(built), 'the dispatched command must never hit a GraphQL endpoint');
        assert.ok(!/(^|\s)gh\s/.test(built), 'the dispatched command must never shell out to gh');

        assert.deepEqual(commandCalls, [], 'a supplied remoteUrl must make a member-bound git dispatch unnecessary');
    });

    test('AC2: a non-2xx response surfaces the HTTP status and the response body, and reports failure', async () => {
        const fleetApi = makeFleetApi({
            responses: [credExecResult({
                status: 500,
                body: { message: 'Internal Server Error while creating the pull request' },
            })],
        });

        const res = await openSideBranchPullRequest({
            fleetApi,
            command: makeCommand([]),
            member: 'side-branch-pr-member',
            base: 'trunk',
            head: 'fix/some-side-branch',
            title: 't',
            remoteUrl: 'https://github.com/acme/widgets.git',
        });

        assert.equal(res.ok, false, 'a 500 must NOT be reported as success');
        assert.equal(res.prUrl, null, 'a failed create must never advertise a PR URL');
        assert.ok(typeof res.error === 'string' && res.error.length > 0, 'expected a non-empty error');
        assert.match(res.error, /500/, 'the HTTP status must be surfaced');
        assert.match(
            res.error,
            /Internal Server Error while creating the pull request/,
            'the response body must be surfaced, not swallowed',
        );
    });

    test('AC2: the CLI reports a non-2xx as a non-zero exit code with the status and body on stderr -- never an advisory success', async () => {
        const fleetApi = makeFleetApi({
            responses: [credExecResult({ status: 422, body: { message: 'Validation Failed: head is invalid' } })],
        });
        const out = [];
        const errs = [];

        const code = await main(
            ['--member', 'side-branch-pr-member', '--base', 'trunk', '--head', 'fix/x', '--title', 't', '--remote', 'https://github.com/acme/widgets.git', '--quiet'],
            {
                fleetApi,
                command: makeCommand([]),
                readRemote: async () => 'https://github.com/acme/widgets.git',
                log: (line) => out.push(line),
                error: (line) => errs.push(line),
            },
        );

        assert.equal(code, 2, 'a refused PR creation must exit non-zero');
        const stderr = errs.join('\n');
        assert.match(stderr, /422/, 'the HTTP status must reach stderr');
        assert.match(stderr, /Validation Failed: head is invalid/, 'the response body must reach stderr');
        assert.deepEqual(out, [], 'nothing may be printed to stdout as if the PR had been opened');
    });

    test('AC2 (success side): the CLI exits 0 and prints the PR URL', async () => {
        const fleetApi = makeFleetApi({
            responses: [credExecResult({ status: 201, body: { number: 7, html_url: 'https://example.invalid/acme/widgets/pull/7' } })],
        });
        const out = [];

        const code = await main(
            ['--member', 'm', '--base', 'trunk', '--head', 'fix/x', '--title', 't', '--remote', 'https://github.com/acme/widgets.git', '--quiet'],
            {
                fleetApi,
                command: makeCommand([]),
                readRemote: async () => 'https://github.com/acme/widgets.git',
                log: (line) => out.push(line),
                error: (line) => out.push(`STDERR: ${line}`),
            },
        );

        assert.equal(code, 0);
        assert.match(out.join('\n'), /https:\/\/example\.invalid\/acme\/widgets\/pull\/7/);
    });

    test('it needs no sprint: inputs come from arguments or the resolved remote, with no hardcoded owner/repo or base', async () => {
        // An explicit --remote wins outright and no checkout is consulted.
        const explicit = await resolvePrInputs(
            { member: 'm', base: 'trunk', head: 'h', title: 't', remote: 'https://github.com/other-org/other-repo.git' },
            { readRemote: async () => { throw new Error('must not be called when --remote is given'); } },
        );
        assert.equal(explicit.ok, true);
        assert.equal(explicit.resolved.remoteUrl, 'https://github.com/other-org/other-repo.git');
        assert.equal(explicit.resolved.repo, 'other-org/other-repo');

        // Otherwise the repository comes from the resolved 'origin' remote.
        const derived = await resolvePrInputs(
            { member: 'm', base: 'trunk', head: 'h', title: 't' },
            { readRemote: async () => 'git@github.com:derived-org/derived-repo.git' },
        );
        assert.equal(derived.ok, true);
        assert.equal(derived.resolved.repo, 'derived-org/derived-repo');
        assert.equal(derived.resolved.base, 'trunk', 'the base must come from the argument, never a built-in default');
        assert.equal(derived.resolved.head, 'h');

        // A remote whose dialect the portable two-part parse does not know is
        // NOT an error -- the provider layer parses its own coordinates. Only
        // the display label is left null.
        const providerDialect = await resolvePrInputs(
            { member: 'm', base: 'trunk', head: 'h', title: 't' },
            { readRemote: async () => 'https://dev.azure.com/an-org/a-project/_git/a-repo' },
        );
        assert.equal(providerDialect.ok, true, 'a provider-specific remote dialect must not be rejected here');
        assert.equal(providerDialect.resolved.remoteUrl, 'https://dev.azure.com/an-org/a-project/_git/a-repo');
        assert.equal(providerDialect.resolved.repo, null, 'the two-part display label is simply unavailable');

        // Nothing to resolve from is a loud usage error, never a guess.
        const guessless = await resolvePrInputs(
            { member: 'm', base: 'trunk', head: 'h', title: 't' },
            { readRemote: async () => '' },
        );
        assert.equal(guessless.ok, false);
        assert.match(guessless.error, /--remote/, 'the error must name the argument that fixes it');

        // Missing required arguments are named, not defaulted.
        const missing = await resolvePrInputs({ member: 'm' }, { readRemote: async () => '' });
        assert.equal(missing.ok, false);
        assert.match(missing.error, /--base/);
        assert.match(missing.error, /--head/);
        assert.match(missing.error, /--title/);
    });

    test('the repository the PR is opened on follows the remote, so no second competing repo input can be silently ignored', async () => {
        const fleetApi = makeFleetApi({
            responses: [credExecResult({ status: 201, body: { number: 1, html_url: 'https://example.invalid/p/1' } })],
        });
        const out = [];

        const code = await main(
            ['--member', 'm', '--base', 'trunk', '--head', 'fix/x', '--title', 't',
                '--remote', 'https://github.com/explicit-org/explicit-repo.git', '--quiet'],
            {
                fleetApi,
                command: makeCommand([]),
                readRemote: async () => 'https://github.com/a-different-org/a-different-repo.git',
                log: (line) => out.push(line),
                error: (line) => out.push(`STDERR: ${line}`),
            },
        );

        assert.equal(code, 0, out.join('\n'));
        const built = fleetApi.dispatched[0].command;
        assert.ok(
            built.includes('/repos/explicit-org/explicit-repo/pulls'),
            `the explicitly supplied remote must select the repository, got: ${built}`,
        );
        assert.ok(
            !built.includes('a-different-org'),
            'the checkout the command happens to run in must not leak into the request',
        );
    });

    test('its --help text documents the invocation with a copy-pasteable non-sprint example', async () => {
        const out = [];
        const code = await main(['--help'], { log: (line) => out.push(line), error: (line) => out.push(line) });
        assert.equal(code, 0);
        const help = out.join('\n');
        assert.ok(help.includes(USAGE), '--help must print the documented usage text');
        assert.match(help, /--base/);
        assert.match(help, /--head/);
        assert.match(help, /EXAMPLE/);
        assert.match(help, /fleet-se-pr --member/, 'the example must be a runnable invocation');
        assert.ok(!/[^\x00-\x7F]/.test(help), 'the help text must be ASCII only');
    });
});

// =============================================================================
// The misleading GraphQL createPullRequest refusal
// (vcs-providers/github.mjs, permissionScope).
// =============================================================================

const GRAPHQL_CREATE_PR_REFUSAL =
    'failed to create pull request: GraphQL: Resource not accessible by integration (createPullRequest)';

const GITHUB_APP_WORKFLOW_REFUSAL =
    '! [remote rejected]        feat/x -> feat/x (refusing to allow a GitHub App to create or update workflow .github/workflows/ci.yml without workflows permission)\n'
    + "error: failed to push some refs to 'https://example.invalid/acme/widgets.git'";

// A GENUINE REST 403: the token really does lack pull_requests write. Same
// message text, no GraphQL mutation context -- must NOT be reclassified.
const REST_403_MISSING_PULL_REQUESTS = `${JSON.stringify({
    message: 'Resource not accessible by integration',
    documentation_url: 'https://docs.github.com/rest/pulls/pulls#create-a-pull-request',
    status: '403',
})}\n403`;

describe('the misleading createPullRequest refusal describes itself', () => {
    test('AC3: it names the REST route and the invocation, and explicitly denies a missing pull_requests permission', () => {
        const result = classifyFailure(GRAPHQL_CREATE_PR_REFUSAL, { provider: 'github' });

        assert.equal(result.kind, K.AUTH_DENIED, 'the identity was understood; the principal was refused');
        assert.equal(result.permissionScope, true, 're-minting the same credential cannot help, so this is permission-scope');
        assert.equal(result.retryable, false, 'a permission-scope refusal must never be retryable');

        const referral = result.operatorReferral;
        assert.ok(typeof referral === 'string' && referral.length > 0, 'expected a non-empty operator referral');

        // Substring assertions, never full-message equality, so wording tweaks
        // do not make this spec brittle.
        assert.match(referral, /NOT a missing pull_requests permission/i, 'must deny the missing-permission reading outright');
        assert.match(referral, /installation token/i, 'must name the credential as an App installation token');
        assert.match(referral, /GraphQL/, 'must name the GraphQL mutation restriction');
        assert.match(referral, /POST \/repos\/\{owner\}\/\{repo\}\/pulls/, 'must name the supported REST route');
        assert.match(referral, /fleet-se-pr/, 'must name the invocation to use instead');
        assert.ok(!/[^\x00-\x7F]/.test(referral), 'the referral must be ASCII only');
    });

    test('AC4: the workflow-file permission refusal still classifies and describes exactly as before', () => {
        const result = classifyFailure(GITHUB_APP_WORKFLOW_REFUSAL, { provider: 'github' });

        assert.equal(result.kind, K.AUTH_DENIED);
        assert.equal(result.permissionScope, true);
        assert.equal(result.retryable, false);
        assert.match(result.operatorReferral, /\.github\/workflows\/ci\.yml/, 'still names the refused workflow path');
        assert.match(result.operatorReferral, /workflows.{0,40}permission/is, "still names the missing 'workflows' permission");
        assert.match(result.operatorReferral, /no self-heal/i, 'still states that no self-heal is attempted');

        // The new family must not have leaked into the old one's description.
        assert.ok(
            !/fleet-se-pr/.test(result.operatorReferral),
            'the workflow refusal must not inherit the createPullRequest remedy',
        );
    });

    test('AC4: a genuine REST 403 with the same message is NOT swallowed or reclassified', () => {
        const result = classifyFailure(REST_403_MISSING_PULL_REQUESTS, { provider: 'github' });

        assert.equal(
            result.permissionScope,
            false,
            'a bare "Resource not accessible by integration" with no GraphQL mutation context must not be claimed',
        );
        assert.equal(result.kind, K.UNKNOWN, 'its classification is unchanged from before the createPullRequest rule existed');
        assert.equal(result.operatorReferral, null, 'and it must not be told to "use REST instead" -- it already is REST');
    });

    test('AC4: the bare "failed to push some refs" trailer still classifies DIVERGED', () => {
        const trailerOnly = "error: failed to push some refs to 'https://example.invalid/acme/widgets.git'";
        assert.equal(classifyFailure(trailerOnly, { provider: 'github' }).kind, K.DIVERGED);
    });

    test('AC5: the describe function is pure -- the same input returns the identical string twice', () => {
        for (const raw of [GRAPHQL_CREATE_PR_REFUSAL, GITHUB_APP_WORKFLOW_REFUSAL]) {
            const first = classifyFailure(raw, { provider: 'github' }).operatorReferral;
            const second = classifyFailure(raw, { provider: 'github' }).operatorReferral;
            const third = classifyFailure(raw, { provider: 'github' }).operatorReferral;
            assert.equal(typeof first, 'string');
            assert.equal(
                second,
                first,
                'a hoisted /g regex would carry lastIndex between calls and make the second call describe differently',
            );
            assert.equal(third, first);
        }
    });
});
