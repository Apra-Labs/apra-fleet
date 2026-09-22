import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCreatePrCommand, capabilities } from '../fleet-sprint/vcs-module.mjs';

// =============================================================================
// apra-fleet-qeq1.3 -- Bitbucket create-pull-request builder GOLDEN tests.
// Modelled on test/vcs-azure-devops-builders.test.mjs.
//
// Pins, with no network and no filesystem writes:
//   1. the EXACT curl command produced for create-pull-request, in both
//      quoting dialects (POSIX sh and Windows PowerShell), as literal
//      expected strings;
//   2. that BOTH the token and the username reach `command` ONLY:
//      logSafeCommand carries the fixed redaction marker for both, and no
//      other field of the built object contains either;
//   3. the interpret contract: 2xx success, everything else error -- no
//      already-exists mapping (unconfirmed against a real Bitbucket API
//      response this sprint -- see the epic apra-fleet-qeq1's recorded gap);
//   4. pullRequestResponse.map reads the flat `id` and the NESTED
//      `links.html.href`, and degrades to url:null (never throws) when that
//      nested path is missing;
//   5. capabilitiesForHost is now present (apra-fleet-qeq1.4), so
//      VCSModule.capabilities() reports canOpenPullRequest:true for every
//      bitbucket.org remote.
// =============================================================================

const REPO_REF = Object.freeze({ workspace: 'kumaakh', repo: 'apra-analytics' });
const TOKEN = 'BB-TOKEN-abc123';
const USERNAME = 'bituser@example.com';
const REDACTED = '***REDACTED***';
const API_BASE = 'https://api.bitbucket.org/2.0/repositories/kumaakh/apra-analytics';

// -----------------------------------------------------------------------------
// (1) Exact command goldens.
//
// A title carrying an apostrophe is deliberate: it is the character whose
// escaping DIFFERS between the two shells, same reasoning as the Azure DevOps
// golden tests.
// -----------------------------------------------------------------------------

const PR_PARAMS = Object.freeze({
    provider: 'bitbucket',
    repoRef: REPO_REF,
    base: 'main',
    head: 'auto-sprint/feat-x',
    title: "Sprint's PR",
    body: 'Body line',
    token: TOKEN,
    username: USERNAME,
});

const POSIX_CREATE_PR = "curl -sS -X POST"
    + ` -u '${USERNAME}:BB-TOKEN-abc123'`
    + " -H 'Content-Type: application/json'"
    + " -H 'Accept: application/json'"
    + " -d '{\"title\":\"Sprint'\\''s PR\",\"source\":{\"branch\":{\"name\":\"auto-sprint/feat-x\"}},\"destination\":{\"branch\":{\"name\":\"main\"}},\"description\":\"Body line\"}'"
    + " -w '\n%{http_code}'"
    + ` ${API_BASE}/pullrequests`;

const WINDOWS_CREATE_PR = "curl.exe -sS -X POST"
    + ` -u '${USERNAME}:BB-TOKEN-abc123'`
    + " -H 'Content-Type: application/json'"
    + " -H 'Accept: application/json'"
    + " -d '{\\\"title\\\":\\\"Sprint''s\\u0020PR\\\",\\\"source\\\":{\\\"branch\\\":{\\\"name\\\":\\\"auto-sprint/feat-x\\\"}},\\\"destination\\\":{\\\"branch\\\":{\\\"name\\\":\\\"main\\\"}},\\\"description\\\":\\\"Body\\u0020line\\\"}'"
    + " -w '\n%{http_code}'"
    + ` ${API_BASE}/pullrequests`;

test('bitbucket create-pull-request: exact POSIX curl command (endpoint, source/destination branch shape, basic auth with username:token)', () => {
    const built = buildCreatePrCommand({ ...PR_PARAMS, os: 'linux' });
    assert.equal(built.provider, 'bitbucket');
    assert.equal(built.action, 'create-pull-request');
    assert.equal(built.command, POSIX_CREATE_PR);
});

test('bitbucket create-pull-request: exact Windows curl.exe command (PowerShell doubles the apostrophe, JSON double quotes are CRT-escaped as \\")', () => {
    const built = buildCreatePrCommand({ ...PR_PARAMS, os: 'windows' });
    assert.equal(built.command, WINDOWS_CREATE_PR);
});

test('bitbucket create-pull-request: an omitted body emits NO description key at all', () => {
    const { body, ...noBody } = PR_PARAMS;
    assert.equal(body, 'Body line');
    const built = buildCreatePrCommand({ ...noBody, os: 'linux' });
    assert.equal(
        built.command,
        "curl -sS -X POST"
        + ` -u '${USERNAME}:BB-TOKEN-abc123'`
        + " -H 'Content-Type: application/json'"
        + " -H 'Accept: application/json'"
        + " -d '{\"title\":\"Sprint'\\''s PR\",\"source\":{\"branch\":{\"name\":\"auto-sprint/feat-x\"}},\"destination\":{\"branch\":{\"name\":\"main\"}}}'"
        + " -w '\n%{http_code}'"
        + ` ${API_BASE}/pullrequests`,
    );
});

test('bitbucket create-pull-request: each coordinate is percent-encoded per URL segment (a space in either slug)', () => {
    const built = buildCreatePrCommand({
        ...PR_PARAMS,
        repoRef: { workspace: 'kuma akh', repo: 'apra analytics' },
        os: 'linux',
    });
    assert.ok(
        built.command.endsWith('https://api.bitbucket.org/2.0/repositories/kuma%20akh/apra%20analytics/pullrequests'),
        `unexpected URL: ${built.command}`,
    );
});

test('bitbucket builders: the command keeps the -w trailing-status-line convention', () => {
    const built = buildCreatePrCommand({ ...PR_PARAMS, os: 'linux' });
    assert.ok(built.command.includes("-w '\n%{http_code}'"), `missing the -w status-line flag: ${built.command}`);
});

// -----------------------------------------------------------------------------
// (2) Redaction: BOTH the token and the username are in `command` and
// NOWHERE else.
// -----------------------------------------------------------------------------

test('bitbucket create-pull-request: logSafeCommand carries the redaction marker for both credential halves; no field other than command holds either', () => {
    for (const os of ['linux', 'windows']) {
        const built = buildCreatePrCommand({ ...PR_PARAMS, os });
        assert.ok(built.command.includes(TOKEN), 'the dispatched command must carry the real token');
        assert.ok(built.command.includes(USERNAME), 'the dispatched command must carry the real username');
        assert.ok(built.logSafeCommand.includes(REDACTED), `logSafeCommand must carry ${REDACTED}`);
        assert.ok(!built.logSafeCommand.includes(TOKEN), 'logSafeCommand must not contain the token');
        assert.ok(!built.logSafeCommand.includes(USERNAME), 'logSafeCommand must not contain the username');
        // Everything EXCEPT command, serialized whole: catches either
        // credential half smuggled into any present or future field.
        const withoutCommand = JSON.stringify({ ...built, command: undefined });
        assert.ok(!withoutCommand.includes(TOKEN), `the token leaked into a non-command field: ${withoutCommand}`);
        assert.ok(!withoutCommand.includes(USERNAME), `the username leaked into a non-command field: ${withoutCommand}`);
    }
});

test('bitbucket create-pull-request: a missing token is a typed ERROR, never a command built with an empty credential', () => {
    assert.throws(
        () => buildCreatePrCommand({ ...PR_PARAMS, token: '' }),
        (err) => /^ERROR: VCSModule: no token supplied/.test(err.message),
    );
});

test('bitbucket create-pull-request: a missing username is a typed ERROR, never a silently empty -u argument', () => {
    for (const username of ['', undefined, null, '   ']) {
        assert.throws(
            () => buildCreatePrCommand({ ...PR_PARAMS, username }),
            (err) => /^ERROR: VCSModule: bitbucket "create-pull-request" needs a username/.test(err.message),
        );
    }
});

test('bitbucket create-pull-request: missing base/head/title each raise a typed ERROR naming the field', () => {
    for (const [key, re] of [['base', /"base" branch is required/], ['head', /"head" branch is required/], ['title', /"title" is required/]]) {
        const { [key]: _drop, ...rest } = PR_PARAMS;
        assert.throws(() => buildCreatePrCommand({ ...rest, os: 'linux' }), re, `expected error for missing ${key}`);
    }
});

test('bitbucket create-pull-request: missing workspace/repo raises a typed ERROR naming the expected remote shape', () => {
    assert.throws(
        () => buildCreatePrCommand({ ...PR_PARAMS, repoRef: { workspace: 'kumaakh' } }),
        (err) => /^ERROR: VCSModule: bitbucket "create-pull-request" needs workspace and repo \(missing: repo\)/.test(err.message)
            && err.message.includes('git@bitbucket.org:WORKSPACE/REPO.git'),
    );
});

test('bitbucket create-pull-request: a stray slash in workspace or repo is rejected, not URL-encoded whole', () => {
    for (const [key, value] of [['workspace', 'kumaakh/extra'], ['repo', 'apra-analytics/extra']]) {
        assert.throws(
            () => buildCreatePrCommand({ ...PR_PARAMS, repoRef: { ...REPO_REF, [key]: value } }),
            (err) => err.message.startsWith(`ERROR: VCSModule: bitbucket "create-pull-request" got a '/' inside ${key}`),
            `expected a typed ERROR for a stray slash in ${key}`,
        );
    }
});

// -----------------------------------------------------------------------------
// (3) interpret contract -- no already-exists mapping.
// -----------------------------------------------------------------------------

test('bitbucket create-pull-request: interpret declares ONLY 2xx success -- no already-exists mapping (unconfirmed dialect, see the epic)', () => {
    const built = buildCreatePrCommand({ ...PR_PARAMS, os: 'linux' });
    assert.deepEqual(built.interpret, { successStatusRange: [200, 299] });
});

function applyInterpret(interpret, status) {
    const [lo, hi] = interpret.successStatusRange;
    return (status >= lo && status <= hi) ? 'success' : 'error';
}

test('bitbucket create-pull-request: 201 -> success, 500 -> error, and a duplicate-PR-shaped 400 also -> error (not guessed as already-exists)', () => {
    const { interpret } = buildCreatePrCommand({ ...PR_PARAMS, os: 'linux' });
    assert.equal(applyInterpret(interpret, 201), 'success');
    assert.equal(applyInterpret(interpret, 500), 'error');
    assert.equal(applyInterpret(interpret, 400), 'error');
});

// -----------------------------------------------------------------------------
// (4) pullRequestResponse.map -- flat id, NESTED links.html.href.
// -----------------------------------------------------------------------------

test('bitbucket pullRequestResponse.map: reads the flat id and the nested links.html.href from a real-shaped response body', async () => {
    const { BitbucketVCS } = await import('../fleet-sprint/vcs-providers/bitbucket.mjs');
    const body = {
        id: 7,
        links: { html: { href: 'https://bitbucket.org/kumaakh/apra-analytics/pull-requests/7' } },
    };
    assert.deepEqual(BitbucketVCS.pullRequestResponse.map(body), {
        id: 7,
        url: 'https://bitbucket.org/kumaakh/apra-analytics/pull-requests/7',
    });
    assert.equal(BitbucketVCS.pullRequestResponse.idField, 'id');
    assert.equal(BitbucketVCS.pullRequestResponse.webUrlField, 'links.html.href');
});

test('bitbucket pullRequestResponse.map: a missing nested links.html.href degrades to url:null, never throws', async () => {
    const { BitbucketVCS } = await import('../fleet-sprint/vcs-providers/bitbucket.mjs');
    for (const body of [{ id: 7 }, { id: 7, links: {} }, { id: 7, links: { html: {} } }, {}, null, undefined]) {
        assert.doesNotThrow(() => BitbucketVCS.pullRequestResponse.map(body));
        const mapped = BitbucketVCS.pullRequestResponse.map(body);
        assert.equal(mapped.url, null, `expected url:null for ${JSON.stringify(body)}`);
    }
});

// -----------------------------------------------------------------------------
// (5) capabilities() -- canOpenPullRequest is now true; capabilitiesForHost
// is now available (apra-fleet-qeq1.4).
// -----------------------------------------------------------------------------

test('capabilities: a bitbucket.org remote now reports canOpenPullRequest:true (capabilitiesForHost available)', () => {
    for (const url of ['https://bitbucket.org/kumaakh/apra-analytics.git', 'git@bitbucket.org:kumaakh/apra-analytics.git']) {
        assert.deepEqual(capabilities(url), { hasRemote: true, canOpenPullRequest: true, host: 'bitbucket.org' }, url);
    }
});
