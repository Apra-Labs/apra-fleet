import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    GitHubVCS,
    AzureDevOpsVCS,
    registerVcsProvider,
    unregisterVcsProvider,
} from '../fleet-sprint/vcs-providers/index.mjs';

// =============================================================================
// apra-fleet-lzfv.4 -- provider-owned pull-request RESPONSE mapping.
//
// A create-pull-request 2xx body is as provider-specific as the request:
// GitHub answers with `number` + `html_url`, Azure DevOps with `pullRequestId`
// and NO browsable web-URL field at all (its `url` is the REST resource). Until
// this contract existed the GitHub dialect was read directly by the shared
// caller (runner.js's raiseVcsPrForMember: `respBody.html_url`), which is a
// provider literal in provider-agnostic code.
//
// Pins:
//   1. BOTH providers DECLARE their mapping on the descriptor (idField,
//      webUrlField, webUrlTemplate) -- the shape a consumer mirroring this
//      contract elsewhere restates;
//   2. a canned Azure DevOps 201 body maps to the pull request id plus a
//      CONSTRUCTED web URL, from the request-side org/project/repo;
//   3. a canned GitHub 201 body maps exactly as it does today, including
//      url: null when html_url is absent or not a string;
//   4. the mapping never throws, and never guesses a URL it cannot build;
//   5. registerVcsProvider() rejects a malformed pullRequestResponse at
//      registration time.
// =============================================================================

// Canned bodies, trimmed to the fields under test but keeping the neighbouring
// keys each API actually returns, so a mapping that grabbed the wrong one
// (Azure DevOps' REST `url`, GitHub's api `url`) would be visible here.
const GITHUB_201 = Object.freeze({
    id: 981723,
    number: 1347,
    url: 'https://api.github.com/repos/octocat/Hello-World/pulls/1347',
    html_url: 'https://github.com/octocat/Hello-World/pull/1347',
    state: 'open',
    title: 'Amazing new feature',
});

const AZURE_201 = Object.freeze({
    repository: { id: 'e1a2b3c4', name: 'fleet-e2e-toy', project: { name: 'e2e-fleet-testing' } },
    pullRequestId: 22,
    codeReviewId: 22,
    status: 'active',
    sourceRefName: 'refs/heads/auto-sprint/feat-x',
    targetRefName: 'refs/heads/main',
    title: 'Sprint PR',
    url: 'https://dev.azure.com/apralabs/_apis/git/repositories/e1a2b3c4/pullRequests/22',
});

const REPO_REF = Object.freeze({ org: 'apralabs', project: 'e2e-fleet-testing', repo: 'fleet-e2e-toy' });

// -----------------------------------------------------------------------------
// (1) Both descriptors declare the mapping.
// -----------------------------------------------------------------------------

test('pullRequestResponse: both providers declare their response mapping on the descriptor', () => {
    assert.equal(GitHubVCS.pullRequestResponse.idField, 'number');
    assert.equal(GitHubVCS.pullRequestResponse.webUrlField, 'html_url');
    assert.equal(GitHubVCS.pullRequestResponse.webUrlTemplate, null, 'GitHub READS its web URL, it never constructs one');
    assert.equal(typeof GitHubVCS.pullRequestResponse.map, 'function');

    assert.equal(AzureDevOpsVCS.pullRequestResponse.idField, 'pullRequestId');
    assert.equal(AzureDevOpsVCS.pullRequestResponse.webUrlField, null, 'the Azure DevOps body carries no browsable web-URL field');
    assert.equal(
        AzureDevOpsVCS.pullRequestResponse.webUrlTemplate,
        'https://dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{id}',
    );
    assert.equal(typeof AzureDevOpsVCS.pullRequestResponse.map, 'function');
});

// -----------------------------------------------------------------------------
// (2) Azure DevOps: id + constructed web URL.
// -----------------------------------------------------------------------------

test('azure-devops: a canned 201 body maps to the pull request id and a constructed web URL', () => {
    assert.deepEqual(
        AzureDevOpsVCS.pullRequestResponse.map(AZURE_201, { repoRef: REPO_REF }),
        { id: 22, url: 'https://dev.azure.com/apralabs/e2e-fleet-testing/_git/fleet-e2e-toy/pullrequest/22' },
    );
});

test('azure-devops: explicit org/project/repo coordinates work the same as a repoRef object', () => {
    assert.deepEqual(
        AzureDevOpsVCS.pullRequestResponse.map(AZURE_201, { ...REPO_REF }),
        { id: 22, url: 'https://dev.azure.com/apralabs/e2e-fleet-testing/_git/fleet-e2e-toy/pullrequest/22' },
    );
});

test('azure-devops: each coordinate is percent-encoded per segment (project names may contain spaces)', () => {
    const mapped = AzureDevOpsVCS.pullRequestResponse.map(AZURE_201, {
        repoRef: { org: 'apra labs', project: 'e2e fleet/testing', repo: 'fleet toy' },
    });
    assert.equal(mapped.url, 'https://dev.azure.com/apra%20labs/e2e%20fleet%2Ftesting/_git/fleet%20toy/pullrequest/22');
});

test('azure-devops: the REST `url` field is never mistaken for the browsable page', () => {
    const mapped = AzureDevOpsVCS.pullRequestResponse.map(AZURE_201, { repoRef: REPO_REF });
    assert.notEqual(mapped.url, AZURE_201.url);
    assert.ok(!mapped.url.includes('_apis'), `a browsable URL must not be the REST resource: ${mapped.url}`);
});

// -----------------------------------------------------------------------------
// (3) GitHub: exactly as today.
// -----------------------------------------------------------------------------

test('github: a canned 201 body maps to the PR number and html_url, exactly as the caller read it before', () => {
    assert.deepEqual(
        GitHubVCS.pullRequestResponse.map(GITHUB_201, {}),
        { id: 1347, url: 'https://github.com/octocat/Hello-World/pull/1347' },
    );
});

test('github: an absent or non-string html_url yields url:null (the historical runner behavior), never a guess', () => {
    const { html_url: _omitted, ...noUrl } = GITHUB_201;
    assert.deepEqual(GitHubVCS.pullRequestResponse.map(noUrl, {}), { id: 1347, url: null });
    assert.deepEqual(GitHubVCS.pullRequestResponse.map({ ...GITHUB_201, html_url: 12 }, {}), { id: 1347, url: null });
});

// -----------------------------------------------------------------------------
// (4) Neither dialect leaks into the other; the mapping never throws.
// -----------------------------------------------------------------------------

test('each provider reads ONLY its own declared id field -- the other dialect maps to id:null', () => {
    assert.equal(GitHubVCS.pullRequestResponse.map(AZURE_201, { repoRef: REPO_REF }).id, null);
    assert.equal(AzureDevOpsVCS.pullRequestResponse.map(GITHUB_201, { repoRef: REPO_REF }).id, null);
});

test('the mapping never throws and never guesses: unreadable body or missing coordinates yield nulls', () => {
    for (const body of [null, undefined, 'not json', 42, {}, { pullRequestId: 'nope' }, { number: {} }]) {
        for (const provider of [GitHubVCS, AzureDevOpsVCS]) {
            const mapped = provider.pullRequestResponse.map(body, { repoRef: REPO_REF });
            assert.equal(mapped.id, null, `${provider.name} for body ${JSON.stringify(body)}`);
            assert.equal(mapped.url, null);
        }
    }
    // A readable id with incomplete coordinates: the id still surfaces, the
    // URL does not -- a successful PR must never be turned into a crash or a
    // half-built link by its own reporting step.
    for (const ctx of [undefined, {}, { repoRef: { org: 'apralabs' } }, { org: 'apralabs', project: 'e2e-fleet-testing' }]) {
        assert.deepEqual(AzureDevOpsVCS.pullRequestResponse.map(AZURE_201, ctx), { id: 22, url: null });
    }
});

test('a numeric-string id is accepted (some JSON parsers/proxies stringify it)', () => {
    assert.equal(AzureDevOpsVCS.pullRequestResponse.map({ pullRequestId: '22' }, { repoRef: REPO_REF }).id, 22);
    assert.equal(GitHubVCS.pullRequestResponse.map({ number: '1347' }, {}).id, 1347);
});

// -----------------------------------------------------------------------------
// (5) Registration-time validation.
// -----------------------------------------------------------------------------

test('registerVcsProvider: a malformed pullRequestResponse fails at registration, not while reporting a created PR', () => {
    const cases = [
        [{ pullRequestResponse: 'nope' }, /non-object `pullRequestResponse`/],
        [{ pullRequestResponse: { map: () => ({}) } }, /no non-empty string `idField`/],
        [{ pullRequestResponse: { idField: 'x' } }, /non-function `map`/],
        [{ pullRequestResponse: { idField: 'x', map: () => ({}), webUrlField: 7 } }, /non-string, non-null `webUrlField`/],
        [{ pullRequestResponse: { idField: 'x', map: () => ({}), webUrlTemplate: 7 } }, /non-string, non-null `webUrlTemplate`/],
    ];
    for (const [extra, pattern] of cases) {
        assert.throws(
            () => registerVcsProvider({ name: 'throwaway-pr-response', extends: 'generic-git', ...extra }),
            (err) => err.message.startsWith('ERROR: VCSModule:') && pattern.test(err.message),
            `expected ${pattern} for ${JSON.stringify(Object.keys(extra))}`,
        );
    }
    // A well-formed one registers cleanly; unregister so it cannot leak into
    // another case or another test file.
    registerVcsProvider({
        name: 'throwaway-pr-response',
        extends: 'generic-git',
        pullRequestResponse: { idField: 'x', webUrlField: null, webUrlTemplate: null, map: () => ({ id: null, url: null }) },
    });
    assert.equal(unregisterVcsProvider('throwaway-pr-response'), true);
});
