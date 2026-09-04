import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCreatePrCommand, buildCommentCommand, capabilities } from '../fleet-sprint/vcs-module.mjs';
import * as shellHelpers from '../fleet-sprint/vcs-providers/shell-helpers.mjs';

// =============================================================================
// apra-fleet-lzfv.3 -- Azure DevOps builder GOLDEN tests.
//
// Pins, with no network and no filesystem writes:
//   1. the EXACT curl command produced for create-pull-request and comment, in
//      both quoting dialects (POSIX sh and Windows PowerShell), as literal
//      expected strings -- never re-derived through shQuote()/curlBinary(), so
//      an endpoint, api-version, ref-shape or quoting drift goes red;
//   2. that the PAT reaches `command` ONLY: logSafeCommand carries the fixed
//      redaction marker, and no other field of the built object contains the
//      token;
//   3. the interpret contract applied to a 201, a generic 500, and a 409
//      carrying TF401179 (plus a 409 without it);
//   4. that VCSModule.capabilities() still reports UNCHANGED values for hosts
//      other than Azure DevOps'. Nothing here asserts an Azure DevOps
//      canOpenPullRequest value in either direction -- that flag flips later in
//      this sprint (the change that makes runner.js's publish path
//      provider-aware) and pinning it here would force that change to edit a
//      test file. Note the exclusion covers ALL Azure DevOps hosts, not just
//      dev.azure.com: capabilitiesForHost() ignores its argument, so
//      ssh.dev.azure.com and *.visualstudio.com move with the same flip;
//   5. a SOURCE-LEVEL guard that shQuote/assertToken stay in the shared
//      vcs-providers/shell-helpers.mjs module. apra-fleet-lzfv.1 first hoisted
//      them there and an unrelated commit (1188d2ab) then deleted the module
//      and re-inlined both privately into github.mjs, with nothing to catch it.
//      HISTORICAL, not current: at HEAD the module exists and both providers
//      import from it, so this guard is green on clean code and goes red only
//      if the clobber recurs.
//
// The builders are exercised through the EXPORTED buildCreatePrCommand /
// buildCommentCommand rather than AzureDevOpsVCS.builders[...] directly, so the
// registry dispatch in vcs-module.mjs is pinned along with the command text.
// =============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROVIDERS_DIR = path.join(__dirname, '../fleet-sprint/vcs-providers');

// The designated real integration-test repo:
// https://dev.azure.com/apralabs/e2e-fleet-testing/_git/fleet-e2e-toy
const REPO_REF = Object.freeze({ org: 'apralabs', project: 'e2e-fleet-testing', repo: 'fleet-e2e-toy' });
const TOKEN = 'PAT-TOKEN-abc123';
const REDACTED = '***REDACTED***';
const API_BASE = 'https://dev.azure.com/apralabs/e2e-fleet-testing/_apis/git/repositories/fleet-e2e-toy';

// -----------------------------------------------------------------------------
// (1) Exact command goldens.
//
// A title carrying an apostrophe is deliberate: it is the character whose
// escaping DIFFERS between the two shells (POSIX closes/reopens the quote as
// '\'' ; PowerShell doubles it as '') and the one that broke a live Publish-PR
// run before shQuote() grew its `os` branch.
// -----------------------------------------------------------------------------

const PR_PARAMS = Object.freeze({
    provider: 'azure-devops',
    repoRef: REPO_REF,
    base: 'main',
    head: 'auto-sprint/feat-x',
    title: "Sprint's PR",
    body: 'Body line',
    token: TOKEN,
});

const POSIX_CREATE_PR = "curl -sS -X POST"
    + " -u ':PAT-TOKEN-abc123'"
    + " -H 'Content-Type: application/json'"
    + " -H 'Accept: application/json'"
    + " -d '{\"sourceRefName\":\"refs/heads/auto-sprint/feat-x\",\"targetRefName\":\"refs/heads/main\",\"title\":\"Sprint'\\''s PR\",\"description\":\"Body line\"}'"
    + " -w '\n%{http_code}'"
    + ` ${API_BASE}/pullrequests?api-version=7.1`;

// The PowerShell dialect carries THREE rewrites: the apostrophe is doubled
// ('') for PowerShell's own single-quoted-string parser; every JSON double
// quote is backslash-escaped (\") for the C-runtime argv parser of the
// native curl.exe child -- Windows PowerShell 5.1's legacy native-argument
// binder passes the string value through to the child's command line
// UNESCAPED, so a bare `"` is eaten there as a quote toggle and the JSON
// body arrives at curl.exe with every quote stripped (HTTP 400); and every
// literal space inside the JSON becomes its equivalent JSON backslash-u0020
// escape, because
// that same binder counts `\"` toward its quote parity and so would leave a
// whitespace-bearing value unwrapped for the CRT to split. Pinned as a
// literal here; test/vcs-powershell-argv-roundtrip.test.mjs proves the form
// against the documented binder + CRT rules and (on Windows) against a real
// powershell.exe.
const WINDOWS_CREATE_PR = "curl.exe -sS -X POST"
    + " -u ':PAT-TOKEN-abc123'"
    + " -H 'Content-Type: application/json'"
    + " -H 'Accept: application/json'"
    + " -d '{\\\"sourceRefName\\\":\\\"refs/heads/auto-sprint/feat-x\\\",\\\"targetRefName\\\":\\\"refs/heads/main\\\",\\\"title\\\":\\\"Sprint''s\\u0020PR\\\",\\\"description\\\":\\\"Body\\u0020line\\\"}'"
    + " -w '\n%{http_code}'"
    + ` ${API_BASE}/pullrequests?api-version=7.1`;

test('azure-devops create-pull-request: exact POSIX curl command (endpoint, api-version, full refs, basic auth with empty user)', () => {
    const built = buildCreatePrCommand({ ...PR_PARAMS, os: 'linux' });
    assert.equal(built.provider, 'azure-devops');
    assert.equal(built.action, 'create-pull-request');
    assert.equal(built.command, POSIX_CREATE_PR);
});

test('azure-devops create-pull-request: exact Windows curl.exe command (PowerShell doubles the apostrophe, JSON double quotes are CRT-escaped as \\")', () => {
    const built = buildCreatePrCommand({ ...PR_PARAMS, os: 'windows' });
    assert.equal(built.command, WINDOWS_CREATE_PR);
});

test('azure-devops create-pull-request: an omitted body emits NO description key at all', () => {
    const { body, ...noBody } = PR_PARAMS;
    assert.equal(body, 'Body line');
    const built = buildCreatePrCommand({ ...noBody, os: 'linux' });
    assert.equal(
        built.command,
        "curl -sS -X POST"
        + " -u ':PAT-TOKEN-abc123'"
        + " -H 'Content-Type: application/json'"
        + " -H 'Accept: application/json'"
        + " -d '{\"sourceRefName\":\"refs/heads/auto-sprint/feat-x\",\"targetRefName\":\"refs/heads/main\",\"title\":\"Sprint'\\''s PR\"}'"
        + " -w '\n%{http_code}'"
        + ` ${API_BASE}/pullrequests?api-version=7.1`,
    );
});

test('azure-devops create-pull-request: a branch already given as a full ref is not double-prefixed', () => {
    const built = buildCreatePrCommand({ ...PR_PARAMS, head: 'refs/heads/auto-sprint/feat-x', os: 'linux' });
    assert.ok(
        built.command.includes('"sourceRefName":"refs/heads/auto-sprint/feat-x"'),
        `expected a single refs/heads/ prefix, got: ${built.command}`,
    );
    assert.ok(!built.command.includes('refs/heads/refs/heads/'), 'a full ref must never be re-prefixed');
});

test('azure-devops create-pull-request: each coordinate is percent-encoded per URL segment (project names may contain spaces)', () => {
    const built = buildCreatePrCommand({
        ...PR_PARAMS,
        repoRef: { org: 'apra labs', project: 'e2e fleet/testing', repo: 'fleet toy' },
        os: 'linux',
    });
    assert.ok(
        built.command.endsWith('https://dev.azure.com/apra%20labs/e2e%20fleet%2Ftesting/_apis/git/repositories/fleet%20toy/pullrequests?api-version=7.1'),
        `unexpected URL: ${built.command}`,
    );
});

const COMMENT_PARAMS = Object.freeze({
    provider: 'azure-devops',
    repoRef: REPO_REF,
    pull_request_id: 42,
    body: "Aborted: agent's run failed",
    token: TOKEN,
});

const POSIX_COMMENT = "curl -sS -X POST"
    + " -u ':PAT-TOKEN-abc123'"
    + " -H 'Content-Type: application/json'"
    + " -H 'Accept: application/json'"
    + " -d '{\"comments\":[{\"parentCommentId\":0,\"content\":\"Aborted: agent'\\''s run failed\",\"commentType\":\"text\"}],\"status\":\"active\"}'"
    + " -w '\n%{http_code}'"
    + ` ${API_BASE}/pullrequests/42/threads?api-version=7.1`;

const WINDOWS_COMMENT = "curl.exe -sS -X POST"
    + " -u ':PAT-TOKEN-abc123'"
    + " -H 'Content-Type: application/json'"
    + " -H 'Accept: application/json'"
    + " -d '{\\\"comments\\\":[{\\\"parentCommentId\\\":0,\\\"content\\\":\\\"Aborted:\\u0020agent''s\\u0020run\\u0020failed\\\",\\\"commentType\\\":\\\"text\\\"}],\\\"status\\\":\\\"active\\\"}'"
    + " -w '\n%{http_code}'"
    + ` ${API_BASE}/pullrequests/42/threads?api-version=7.1`;

test('azure-devops comment: exact POSIX curl command (a single active thread carrying one text comment)', () => {
    const built = buildCommentCommand({ ...COMMENT_PARAMS, os: 'linux' });
    assert.equal(built.provider, 'azure-devops');
    assert.equal(built.action, 'comment');
    assert.equal(built.command, POSIX_COMMENT);
});

test('azure-devops comment: exact Windows curl.exe command', () => {
    const built = buildCommentCommand({ ...COMMENT_PARAMS, os: 'windows' });
    assert.equal(built.command, WINDOWS_COMMENT);
});

test('azure-devops builders: both commands keep the -w trailing-status-line convention this provider\'s own classifier depends on', () => {
    for (const built of [
        buildCreatePrCommand({ ...PR_PARAMS, os: 'linux' }),
        buildCommentCommand({ ...COMMENT_PARAMS, os: 'linux' }),
    ]) {
        assert.ok(built.command.includes("-w '\n%{http_code}'"), `missing the -w status-line flag: ${built.command}`);
    }
});

// -----------------------------------------------------------------------------
// (2) Redaction: the PAT is in `command` and NOWHERE else.
// -----------------------------------------------------------------------------

for (const [label, build, params] of [
    ['create-pull-request', buildCreatePrCommand, PR_PARAMS],
    ['comment', buildCommentCommand, COMMENT_PARAMS],
]) {
    test(`azure-devops ${label}: logSafeCommand carries the redaction marker and no field other than command holds the token`, () => {
        for (const os of ['linux', 'windows']) {
            const built = build({ ...params, os });
            assert.ok(built.command.includes(TOKEN), 'the dispatched command must carry the real token');
            assert.ok(built.logSafeCommand.includes(REDACTED), `logSafeCommand must carry ${REDACTED}`);
            assert.ok(!built.logSafeCommand.includes(TOKEN), 'logSafeCommand must not contain the token');
            // Everything EXCEPT command, serialized whole: catches a token
            // smuggled into any present or future field.
            const withoutCommand = JSON.stringify({ ...built, command: undefined });
            assert.ok(
                !withoutCommand.includes(TOKEN),
                `the token leaked into a non-command field: ${withoutCommand}`,
            );
            // The two commands differ ONLY by the token/marker substitution.
            assert.equal(built.command.replace(TOKEN, REDACTED), built.logSafeCommand);
        }
    });
}

test('azure-devops builders: a missing token is a typed ERROR, never a command built with an empty credential', () => {
    for (const [build, params] of [[buildCreatePrCommand, PR_PARAMS], [buildCommentCommand, COMMENT_PARAMS]]) {
        assert.throws(
            () => build({ ...params, token: '' }),
            (err) => /^ERROR: VCSModule: no token supplied/.test(err.message),
        );
    }
});

test('azure-devops builders: missing org/project/repo raises a typed ERROR naming the expected remote shape', () => {
    assert.throws(
        () => buildCreatePrCommand({ ...PR_PARAMS, repoRef: { org: 'apralabs' } }),
        (err) => /^ERROR: VCSModule: azure-devops "create-pull-request" needs org, project and repo \(missing: project, repo\)/.test(err.message)
            && err.message.includes('https://dev.azure.com/ORG/PROJECT/_git/REPO'),
    );
});

// apra-fleet-5co8.11: a three-part canonical (parseRepoRef()'s own
// `org/project/repo`, the exact shape github.mjs's builders accept as
// `repo`) passed as a SINGLE coordinate must be rejected with a typed ERROR
// at build time, never percent-encoded whole into a silently wrong URL that
// would only 404 at request time.
test('azure-devops builders: a three-part org/project/repo canonical passed as the single "repo" param is rejected, not URL-encoded whole', () => {
    assert.throws(
        () => buildCreatePrCommand({
            ...PR_PARAMS,
            repoRef: { org: 'apralabs', project: 'e2e-fleet-testing', repo: 'apralabs/e2e-fleet-testing/fleet-e2e-toy' },
        }),
        (err) => /^ERROR: VCSModule: azure-devops "create-pull-request" got a '\/' inside repo/.test(err.message)
            && err.message.includes('https://dev.azure.com/ORG/PROJECT/_git/REPO'),
    );
});

test('azure-devops builders: a stray slash in org or repo is rejected the same way (project is exempt -- a literal slash there is a legitimate, percent-encoded project name, see the test above)', () => {
    for (const [key, value] of [['org', 'apralabs/extra'], ['repo', 'fleet-e2e-toy/extra']]) {
        assert.throws(
            () => buildCommentCommand({ ...COMMENT_PARAMS, repoRef: { ...REPO_REF, [key]: value } }),
            (err) => err.message.startsWith(`ERROR: VCSModule: azure-devops "comment" got a '/' inside ${key}`),
            `expected a typed ERROR for a stray slash in ${key}`,
        );
    }
});

// -----------------------------------------------------------------------------
// (3) interpret contract.
//
// `interpret` is DATA -- the production consumer that applies it is
// runner.js's raiseVcsPrForMember (the success-range check and the
// alreadyExistsStatus + alreadyExistsPattern check around its parseVcsCurlOutput
// call). The whole object is deepEqual'd first, so removing the already-exists
// mapping fails outright; applyInterpret below then mirrors that consumer's
// shape and reads ONLY the built object's own fields -- it hardcodes no status
// and no pattern of its own.
// -----------------------------------------------------------------------------

function applyInterpret(interpret, status, bodyText) {
    const [lo, hi] = interpret.successStatusRange;
    if (status >= lo && status <= hi) return 'success';
    if (interpret.alreadyExistsStatus != null
        && status === interpret.alreadyExistsStatus
        && new RegExp(interpret.alreadyExistsPattern, 'i').test(bodyText)) {
        return 'already-exists';
    }
    return 'error';
}

test('azure-devops create-pull-request: interpret declares 2xx success and 409 + TF401179 already-exists', () => {
    const built = buildCreatePrCommand({ ...PR_PARAMS, os: 'linux' });
    assert.deepEqual(built.interpret, {
        successStatusRange: [200, 299],
        alreadyExistsStatus: 409,
        alreadyExistsPattern: 'TF401179',
    });
});

test('azure-devops create-pull-request: 201 -> success, 500 -> error, 409+TF401179 -> already-exists, bare 409 -> error', () => {
    const { interpret } = buildCreatePrCommand({ ...PR_PARAMS, os: 'linux' });
    assert.equal(applyInterpret(interpret, 201, '{"pullRequestId":7}'), 'success');
    assert.equal(applyInterpret(interpret, 500, 'Internal Server Error'), 'error');
    assert.equal(
        applyInterpret(interpret, 409, 'TF401179: An active pull request for the source and target branch already exists.'),
        'already-exists',
    );
    assert.equal(applyInterpret(interpret, 409, 'TF401398: The pull request is abandoned.'), 'error');
});

test('azure-devops comment: interpret declares 2xx success with no already-exists mapping', () => {
    const built = buildCommentCommand({ ...COMMENT_PARAMS, os: 'linux' });
    assert.deepEqual(built.interpret, { successStatusRange: [200, 299] });
    assert.equal(applyInterpret(built.interpret, 200, '{}'), 'success');
    assert.equal(applyInterpret(built.interpret, 500, 'boom'), 'error');
});

// -----------------------------------------------------------------------------
// (4) capabilities() is UNCHANGED for every host other than Azure DevOps'.
// -----------------------------------------------------------------------------

test('capabilities: non-Azure-DevOps hosts report exactly the values they did before the Azure DevOps builders landed', () => {
    for (const url of ['https://github.com/o/r', 'https://github.com/o/r.git', 'git@github.com:o/r.git', 'ssh://git@github.com/o/r']) {
        assert.deepEqual(capabilities(url), { hasRemote: true, canOpenPullRequest: true, host: 'github.com' }, url);
    }
    assert.deepEqual(
        capabilities('https://github.acme-corp.internal/o/r.git'),
        { hasRemote: true, canOpenPullRequest: true, host: 'github.acme-corp.internal' },
    );
    assert.deepEqual(capabilities('https://gitlab.com/o/r.git'), { hasRemote: true, canOpenPullRequest: false, host: 'gitlab.com' });
    assert.deepEqual(capabilities('https://bitbucket.org/o/r.git'), { hasRemote: true, canOpenPullRequest: false, host: 'bitbucket.org' });
    assert.deepEqual(capabilities('file:///path/to/bare.git'), { hasRemote: true, canOpenPullRequest: false, host: null });
    assert.deepEqual(capabilities(''), { hasRemote: false, canOpenPullRequest: false, host: null });
    assert.deepEqual(capabilities(null), { hasRemote: false, canOpenPullRequest: false, host: null });
});

test('capabilities: an Azure DevOps remote is recognized (host + hasRemote) -- its canOpenPullRequest value is deliberately unpinned here', () => {
    for (const [url, host] of [
        ['https://dev.azure.com/apralabs/e2e-fleet-testing/_git/fleet-e2e-toy', 'dev.azure.com'],
        ['git@ssh.dev.azure.com:v3/apralabs/e2e-fleet-testing/fleet-e2e-toy', 'ssh.dev.azure.com'],
        ['https://apralabs.visualstudio.com/e2e-fleet-testing/_git/fleet-e2e-toy', 'apralabs.visualstudio.com'],
    ]) {
        const caps = capabilities(url);
        assert.equal(caps.hasRemote, true, url);
        assert.equal(caps.host, host);
        assert.equal(typeof caps.canOpenPullRequest, 'boolean');
    }
});

// -----------------------------------------------------------------------------
// (5) Shared-helper guard.
// -----------------------------------------------------------------------------

/** Matches a LOCAL declaration only (function/const/let/var at the start of a
 *  line), never an import binding or a mention inside a comment -- both files
 *  legitimately import these names and name them in doc comments. */
function declaresLocally(source, name) {
    return new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:async\\s+)?(?:function|const|let|var)\\s+${name}\\b`).test(source);
}

test('shell-helpers: the shared module exports shQuote and assertToken (deleting it or dropping either export fails here)', () => {
    assert.equal(typeof shellHelpers.shQuote, 'function', 'shell-helpers.mjs must export shQuote');
    assert.equal(typeof shellHelpers.assertToken, 'function', 'shell-helpers.mjs must export assertToken');
});

test('shell-helpers: neither github.mjs nor azure-devops.mjs re-inlines a local shQuote/assertToken', () => {
    for (const file of ['github.mjs', 'azure-devops.mjs']) {
        const src = fs.readFileSync(path.join(PROVIDERS_DIR, file), 'utf8');
        assert.match(
            src,
            /import \{[^}]*\} from '\.\/shell-helpers\.mjs';/,
            `${file} must import its shell helpers from the shared ./shell-helpers.mjs module`,
        );
        for (const name of ['shQuote', 'assertToken']) {
            assert.equal(
                declaresLocally(src, name),
                false,
                `${file} declares its own ${name}() -- it must use the shared vcs-providers/shell-helpers.mjs export instead (this is the clobber apra-fleet-lzfv.1's hoist was reverted by once already)`,
            );
        }
    }
});
