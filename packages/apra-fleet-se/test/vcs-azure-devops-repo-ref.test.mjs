import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    AzureDevOpsVCS,
    GenericGitVCS,
    registerVcsProvider,
    unregisterVcsProvider,
    resolveVcsProviderForHost,
} from '../fleet-sprint/vcs-providers/index.mjs';
import { capabilities } from '../fleet-sprint/vcs-module.mjs';

// =============================================================================
// apra-fleet-5co8.1.1 -- Azure DevOps remote-URL parsing and host recognition
// via the provider descriptor hooks.
//
// Pins:
//   1. matchesHost() claims the three Azure DevOps host forms (dev.azure.com,
//      ssh.dev.azure.com, any *.visualstudio.com) and nothing else -- notably
//      NOT a lookalike host that merely contains one of those strings;
//   2. resolveVcsProviderForHost() therefore returns the Azure DevOps
//      descriptor for all three, and generic-git for everything unclaimed;
//   3. parseRepoRef() returns { org, project, repo, canonical } for every
//      documented URL shape (https incl. userinfo/percent-encoded project/.git
//      suffix, the two-segment project-omitted shorthand, the scp-like and
//      scheme'd ssh v3 forms, and the legacy visualstudio.com host with and
//      without DefaultCollection) and null -- never a throw -- for garbage;
//   4. capabilitiesForHost() reports canOpenPullRequest:false until the
//      builders land, so VCSModule.capabilities() never advertises an action
//      this provider cannot build.
//
// The canonical fixture is the designated real integration-test repo:
// https://dev.azure.com/apralabs/e2e-fleet-testing/_git/fleet-e2e-toy
// (org apralabs, project e2e-fleet-testing, repo fleet-e2e-toy).
// =============================================================================

const CANONICAL = { org: 'apralabs', project: 'e2e-fleet-testing', repo: 'fleet-e2e-toy', canonical: 'apralabs/e2e-fleet-testing/fleet-e2e-toy' };

// -----------------------------------------------------------------------------
// (1) matchesHost
// -----------------------------------------------------------------------------

test('azure-devops matchesHost: claims dev.azure.com, ssh.dev.azure.com and any visualstudio.com subdomain', () => {
    for (const host of ['dev.azure.com', 'DEV.AZURE.COM', 'ssh.dev.azure.com', 'apralabs.visualstudio.com', 'visualstudio.com']) {
        assert.equal(AzureDevOpsVCS.matchesHost(host), true, `expected ${host} to be claimed`);
    }
});

test('azure-devops matchesHost: does NOT claim lookalike or unrelated hosts (anchored, not substring)', () => {
    for (const host of [
        'dev.azure.com.evil.example',
        'visualstudio.com.evil.example',
        'notvisualstudio.com.attacker.test',
        'github.com',
        'gitlab.com',
        'azure.com',
        '',
        null,
        undefined,
        42,
    ]) {
        assert.equal(AzureDevOpsVCS.matchesHost(host), false, `expected ${String(host)} NOT to be claimed`);
    }
});

// -----------------------------------------------------------------------------
// (2) registry dispatch
// -----------------------------------------------------------------------------

test('resolveVcsProviderForHost: all three Azure DevOps host forms resolve to the azure-devops provider', () => {
    for (const host of ['dev.azure.com', 'ssh.dev.azure.com', 'apralabs.visualstudio.com']) {
        assert.equal(resolveVcsProviderForHost(host).name, 'azure-devops', `unexpected provider for ${host}`);
    }
});

test('resolveVcsProviderForHost: a non-Azure host still falls back to generic-git', () => {
    for (const host of ['gitlab.com', 'git.example.internal', 'dev.azure.com.evil.example', null]) {
        assert.equal(resolveVcsProviderForHost(host).name, 'generic-git', `unexpected provider for ${String(host)}`);
    }
    // github.com is claimed by GitHubVCS, not by azure-devops -- guards
    // against a widened Azure matcher stealing another provider's host.
    assert.equal(resolveVcsProviderForHost('github.com').name, 'github');
});

test('registerVcsProvider still accepts the azure-devops descriptor, and rejects a non-function hook', () => {
    assert.equal(registerVcsProvider(AzureDevOpsVCS), 'azure-devops');
    for (const hook of ['matchesHost', 'capabilitiesForHost', 'parseRepoRef']) {
        assert.throws(
            () => registerVcsProvider({ name: 'synth-bad-hook', [hook]: 'nope' }),
            new RegExp(`non-function \`${hook}\``),
        );
    }
    unregisterVcsProvider('synth-bad-hook');
    // A provider that declares none of the hooks is still registrable.
    assert.equal(registerVcsProvider({ name: 'synth-no-hooks' }), 'synth-no-hooks');
    unregisterVcsProvider('synth-no-hooks');
    // The built-in azure-devops entry must survive this suite intact.
    assert.equal(resolveVcsProviderForHost('dev.azure.com').name, 'azure-devops');
    assert.equal(typeof GenericGitVCS.matchesHost, 'function');
});

// -----------------------------------------------------------------------------
// (3) parseRepoRef
// -----------------------------------------------------------------------------

test('parseRepoRef: the canonical https form (and its userinfo / .git / trailing-slash variants)', () => {
    for (const url of [
        'https://dev.azure.com/apralabs/e2e-fleet-testing/_git/fleet-e2e-toy',
        'https://dev.azure.com/apralabs/e2e-fleet-testing/_git/fleet-e2e-toy/',
        'https://dev.azure.com/apralabs/e2e-fleet-testing/_git/fleet-e2e-toy.git',
        'https://apralabs@dev.azure.com/apralabs/e2e-fleet-testing/_git/fleet-e2e-toy',
        '  https://dev.azure.com/apralabs/e2e-fleet-testing/_git/fleet-e2e-toy  ',
    ]) {
        assert.deepEqual(AzureDevOpsVCS.parseRepoRef(url), CANONICAL, `unexpected parse for ${url}`);
    }
});

test('parseRepoRef: a percent-encoded project name is decoded in every field', () => {
    const ref = AzureDevOpsVCS.parseRepoRef('https://dev.azure.com/apralabs/My%20Project/_git/fleet-e2e-toy');
    assert.deepEqual(ref, {
        org: 'apralabs',
        project: 'My Project',
        repo: 'fleet-e2e-toy',
        canonical: 'apralabs/My Project/fleet-e2e-toy',
    });
});

test('parseRepoRef: the project-omitted two-segment shorthand takes the repo name as the project', () => {
    assert.deepEqual(AzureDevOpsVCS.parseRepoRef('https://dev.azure.com/apralabs/_git/fleet-e2e-toy'), {
        org: 'apralabs',
        project: 'fleet-e2e-toy',
        repo: 'fleet-e2e-toy',
        canonical: 'apralabs/fleet-e2e-toy/fleet-e2e-toy',
    });
});

test('parseRepoRef: the ssh v3 forms (scp-like shorthand and scheme\'d ssh://)', () => {
    for (const url of [
        'git@ssh.dev.azure.com:v3/apralabs/e2e-fleet-testing/fleet-e2e-toy',
        'ssh://git@ssh.dev.azure.com:22/v3/apralabs/e2e-fleet-testing/fleet-e2e-toy',
        'ssh://git@ssh.dev.azure.com/v3/apralabs/e2e-fleet-testing/fleet-e2e-toy',
        'git@ssh.dev.azure.com:v3/apralabs/e2e-fleet-testing/fleet-e2e-toy.git',
    ]) {
        assert.deepEqual(AzureDevOpsVCS.parseRepoRef(url), CANONICAL, `unexpected parse for ${url}`);
    }
});

test('parseRepoRef: the legacy visualstudio.com host takes org from the HOSTNAME, not the path', () => {
    for (const url of [
        'https://apralabs.visualstudio.com/e2e-fleet-testing/_git/fleet-e2e-toy',
        'https://apralabs.visualstudio.com/DefaultCollection/e2e-fleet-testing/_git/fleet-e2e-toy',
        'https://apralabs.visualstudio.com/defaultcollection/e2e-fleet-testing/_git/fleet-e2e-toy.git',
    ]) {
        assert.deepEqual(AzureDevOpsVCS.parseRepoRef(url), CANONICAL, `unexpected parse for ${url}`);
    }
    // project omitted on the legacy host too
    assert.deepEqual(AzureDevOpsVCS.parseRepoRef('https://apralabs.visualstudio.com/_git/fleet-e2e-toy'), {
        org: 'apralabs',
        project: 'fleet-e2e-toy',
        repo: 'fleet-e2e-toy',
        canonical: 'apralabs/fleet-e2e-toy/fleet-e2e-toy',
    });
});

test('parseRepoRef: unparseable or non-Azure input returns null and never throws', () => {
    for (const url of [
        null,
        undefined,
        '',
        '   ',
        'not a url at all',
        42,
        'https://github.com/Apra-Labs/apra-fleet.git',
        'git@github.com:Apra-Labs/apra-fleet.git',
        'file:///tmp/bare.git',
        'https://dev.azure.com',
        'https://dev.azure.com/apralabs',
        'https://dev.azure.com/apralabs/e2e-fleet-testing',
        'https://dev.azure.com/apralabs/e2e-fleet-testing/_git',
        'https://dev.azure.com/apralabs/team/e2e-fleet-testing/_git/extra/fleet-e2e-toy',
        'https://dev.azure.com/a/b/c/_git/d',
        'git@ssh.dev.azure.com:v3/apralabs/e2e-fleet-testing',
        'git@ssh.dev.azure.com:v3/apralabs/e2e-fleet-testing/fleet-e2e-toy/extra',
        'https://dev.azure.com.evil.example/apralabs/e2e-fleet-testing/_git/fleet-e2e-toy',
    ]) {
        assert.equal(AzureDevOpsVCS.parseRepoRef(url), null, `expected null for ${String(url)}`);
    }
});

// -----------------------------------------------------------------------------
// (4) capabilities
// -----------------------------------------------------------------------------

test('capabilitiesForHost: PR capability stays false until the Azure DevOps builders land', () => {
    assert.deepEqual(AzureDevOpsVCS.capabilitiesForHost('dev.azure.com'), { canOpenPullRequest: false });
    assert.equal(AzureDevOpsVCS.builders, null, 'capability and builders must flip together');
    const caps = capabilities('https://dev.azure.com/apralabs/e2e-fleet-testing/_git/fleet-e2e-toy');
    assert.deepEqual(caps, { hasRemote: true, canOpenPullRequest: false, host: 'dev.azure.com' });
});
