import { test, describe } from 'node:test';
import assert from 'node:assert';
import { parseRepoScopeFromRemoteUrl, parseOwnerRepoFromRemoteUrl } from '../fleet-sprint/runner.js';
import { parseProviderRepoRef } from '../fleet-sprint/vcs-module.mjs';

// apra-fleet-5co8.1.2 -- the runner's remote-URL parse dispatched through the
// provider registry. Pure/deterministic: no I/O, no member, no bd.
//
// The exhaustive Azure DevOps URL-shape table lives with the provider hook
// itself (test/vcs-azure-devops-repo-ref.test.mjs); what is pinned here is the
// DISPATCH: that a claimed host reaches its provider's hook, that a
// claimed-but-malformed remote becomes a typed preflight ERROR naming the
// expected shape, and that every non-Azure remote still parses byte-identically
// to the pre-existing generic owner/repo parse.

describe('parseRepoScopeFromRemoteUrl (apra-fleet-5co8.1.2)', () => {
    test('an Azure DevOps remote resolves to org/project/repo instead of null', () => {
        assert.equal(parseOwnerRepoFromRemoteUrl('https://dev.azure.com/apralabs/e2e-fleet-testing/_git/fleet-e2e-toy'), null);
        const scope = parseRepoScopeFromRemoteUrl('https://dev.azure.com/apralabs/e2e-fleet-testing/_git/fleet-e2e-toy');
        assert.equal(scope.error, null);
        assert.equal(scope.repo, 'apralabs/e2e-fleet-testing/fleet-e2e-toy');
    });

    test('the ssh v3 Azure DevOps shorthand resolves through the same hook', () => {
        const scope = parseRepoScopeFromRemoteUrl('git@ssh.dev.azure.com:v3/apralabs/e2e-fleet-testing/fleet-e2e-toy');
        assert.equal(scope.error, null);
        assert.equal(scope.repo, 'apralabs/e2e-fleet-testing/fleet-e2e-toy');
    });

    test('a malformed Azure DevOps remote returns a typed ERROR naming the expected shape', () => {
        const scope = parseRepoScopeFromRemoteUrl('https://dev.azure.com/apralabs/no-git-marker-here');
        assert.equal(scope.repo, null);
        assert.match(scope.error, /^ERROR: /);
        assert.match(scope.error, /https:\/\/dev\.azure\.com\/ORG\/PROJECT\/_git\/REPO/);
        assert.match(scope.error, /azure-devops/);
    });

    test('GitHub and generic remotes parse exactly as the generic parse did', () => {
        for (const url of [
            'https://github.com/acme/widgets.git',
            'https://github.com/acme/widgets',
            'git@github.com:acme/widgets.git',
            'ssh://git@github.com/acme/widgets.git',
            'https://gitlab.example.com/some-org/some-repo.git',
            'git@bitbucket.org:other-org/other-repo.git',
        ]) {
            const scope = parseRepoScopeFromRemoteUrl(url);
            assert.equal(scope.error, null, `unexpected error for ${url}`);
            assert.equal(scope.repo, parseOwnerRepoFromRemoteUrl(url), `scope diverged from the generic parse for ${url}`);
        }
    });

    test('unrecognized/empty remotes stay a soft null, never an ERROR', () => {
        for (const url of ['', null, undefined, 'not a url']) {
            const scope = parseRepoScopeFromRemoteUrl(url);
            assert.equal(scope.error, null, `unexpected error for ${String(url)}`);
            assert.equal(scope.repo, null);
        }
    });
});

describe('parseProviderRepoRef (apra-fleet-5co8.1.2)', () => {
    test('returns null when no provider claims the host with a parseRepoRef hook', () => {
        assert.equal(parseProviderRepoRef('https://github.com/acme/widgets.git'), null);
        assert.equal(parseProviderRepoRef('https://gitlab.example.com/org/repo.git'), null);
        assert.equal(parseProviderRepoRef(''), null);
        assert.equal(parseProviderRepoRef('file:///srv/bare.git'), null);
    });

    test('returns the provider name and full coordinates for a recognized remote', () => {
        const res = parseProviderRepoRef('https://dev.azure.com/apralabs/e2e-fleet-testing/_git/fleet-e2e-toy.git');
        assert.equal(res.provider, 'azure-devops');
        assert.equal(res.canonical, 'apralabs/e2e-fleet-testing/fleet-e2e-toy');
        assert.deepEqual(
            { org: res.ref.org, project: res.ref.project, repo: res.ref.repo },
            { org: 'apralabs', project: 'e2e-fleet-testing', repo: 'fleet-e2e-toy' },
        );
    });

    test('a lookalike host is not claimed, so it falls through rather than erroring', () => {
        assert.equal(parseProviderRepoRef('https://dev.azure.com.evil.example/org/project/_git/repo'), null);
    });
});
