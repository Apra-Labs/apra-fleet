import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    BitbucketVCS,
    GenericGitVCS,
    registerVcsProvider,
    unregisterVcsProvider,
    resolveVcsProviderForHost,
} from '../fleet-sprint/vcs-providers/index.mjs';
import { capabilities } from '../fleet-sprint/vcs-module.mjs';

// =============================================================================
// apra-fleet-qeq1.2 -- Bitbucket remote-URL parsing and host recognition via
// the provider descriptor hooks. Modelled on
// test/vcs-azure-devops-repo-ref.test.mjs.
//
// Pins:
//   1. matchesHost() claims bitbucket.org and its www./altssh. aliases and
//      nothing else -- notably NOT a lookalike host that merely contains one
//      of those strings;
//   2. resolveVcsProviderForHost() therefore returns the Bitbucket descriptor
//      for all three, and generic-git for everything unclaimed;
//   3. parseRepoRef() returns { workspace, repo, canonical } for both the ssh
//      scp-like and https remote shapes, and null -- never a throw -- for
//      garbage;
//   4. capabilitiesForHost() is now present (apra-fleet-qeq1.4), so
//      VCSModule.capabilities() advertises canOpenPullRequest:true.
// =============================================================================

const CANONICAL = { workspace: 'kumaakh', repo: 'apra-analytics', canonical: 'kumaakh/apra-analytics' };

// -----------------------------------------------------------------------------
// (1) matchesHost
// -----------------------------------------------------------------------------

test('bitbucket matchesHost: claims bitbucket.org, www.bitbucket.org and altssh.bitbucket.org', () => {
    for (const host of ['bitbucket.org', 'BITBUCKET.ORG', 'www.bitbucket.org', 'altssh.bitbucket.org']) {
        assert.equal(BitbucketVCS.matchesHost(host), true, `expected ${host} to be claimed`);
    }
});

test('bitbucket matchesHost: does NOT claim lookalike or unrelated hosts (anchored, not substring)', () => {
    for (const host of [
        'bitbucket.org.evil.example',
        'notbitbucket.org.attacker.test',
        'github.com',
        'gitlab.com',
        'dev.azure.com',
        '',
        null,
        undefined,
        42,
    ]) {
        assert.equal(BitbucketVCS.matchesHost(host), false, `expected ${String(host)} NOT to be claimed`);
    }
});

// -----------------------------------------------------------------------------
// (2) registry dispatch
// -----------------------------------------------------------------------------

test('resolveVcsProviderForHost: bitbucket.org and its aliases resolve to the bitbucket provider', () => {
    for (const host of ['bitbucket.org', 'www.bitbucket.org', 'altssh.bitbucket.org']) {
        assert.equal(resolveVcsProviderForHost(host).name, 'bitbucket', `unexpected provider for ${host}`);
    }
});

test('resolveVcsProviderForHost: a non-Bitbucket host still falls back to generic-git', () => {
    for (const host of ['gitlab.com', 'git.example.internal', 'bitbucket.org.evil.example', null]) {
        assert.equal(resolveVcsProviderForHost(host).name, 'generic-git', `unexpected provider for ${String(host)}`);
    }
    // github.com is claimed by GitHubVCS, not by bitbucket -- guards against a
    // widened Bitbucket matcher stealing another provider's host.
    assert.equal(resolveVcsProviderForHost('github.com').name, 'github');
});

test('registerVcsProvider still accepts the bitbucket descriptor', () => {
    assert.equal(registerVcsProvider(BitbucketVCS), 'bitbucket');
    // A provider that declares none of the hooks is still registrable.
    assert.equal(registerVcsProvider({ name: 'synth-no-hooks' }), 'synth-no-hooks');
    unregisterVcsProvider('synth-no-hooks');
    // The built-in bitbucket entry must survive this suite intact.
    assert.equal(resolveVcsProviderForHost('bitbucket.org').name, 'bitbucket');
    assert.equal(typeof GenericGitVCS.matchesHost, 'function');
});

// -----------------------------------------------------------------------------
// (3) parseRepoRef
// -----------------------------------------------------------------------------

test('parseRepoRef: the ssh scp-like shorthand', () => {
    for (const url of [
        'git@bitbucket.org:kumaakh/apra-analytics.git',
        'git@bitbucket.org:kumaakh/apra-analytics',
    ]) {
        assert.deepEqual(BitbucketVCS.parseRepoRef(url), CANONICAL, `unexpected parse for ${url}`);
    }
});

test('parseRepoRef: the https form (and its userinfo / .git / trailing-slash variants)', () => {
    for (const url of [
        'https://bitbucket.org/kumaakh/apra-analytics.git',
        'https://bitbucket.org/kumaakh/apra-analytics',
        'https://bitbucket.org/kumaakh/apra-analytics.git/',
        'https://kumaakh@bitbucket.org/kumaakh/apra-analytics.git',
        '  https://bitbucket.org/kumaakh/apra-analytics.git  ',
    ]) {
        assert.deepEqual(BitbucketVCS.parseRepoRef(url), CANONICAL, `unexpected parse for ${url}`);
    }
});

test('parseRepoRef: the altssh host and a scheme\'d ssh:// form', () => {
    for (const url of [
        'ssh://git@altssh.bitbucket.org:22/kumaakh/apra-analytics.git',
        'ssh://git@bitbucket.org/kumaakh/apra-analytics.git',
    ]) {
        assert.deepEqual(BitbucketVCS.parseRepoRef(url), CANONICAL, `unexpected parse for ${url}`);
    }
});

test('repoRefHint names the ssh and https remote shapes', () => {
    assert.match(BitbucketVCS.repoRefHint, /git@bitbucket\.org:WORKSPACE\/REPO/);
    assert.match(BitbucketVCS.repoRefHint, /https:\/\/bitbucket\.org\/WORKSPACE\/REPO/);
});

test('parseRepoRef: unparseable, non-Bitbucket or lookalike input returns null and never throws', () => {
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
        'https://bitbucket.org',
        'https://bitbucket.org/kumaakh',
        'https://bitbucket.org/kumaakh/apra-analytics/extra',
        'git@bitbucket.org:kumaakh',
        'git@bitbucket.org:kumaakh/apra-analytics/extra',
        'https://bitbucket.org.evil.example/kumaakh/apra-analytics.git',
    ]) {
        assert.equal(BitbucketVCS.parseRepoRef(url), null, `expected null for ${String(url)}`);
    }
});

// -----------------------------------------------------------------------------
// (4) capabilities
// -----------------------------------------------------------------------------

// capabilitiesForHost now available (apra-fleet-qeq1.4): this provider can
// open a pull request and advertises it via VCSModule.capabilities().
test('capabilities: a bitbucket.org remote is recognized (host + hasRemote) and IS PR-capable', () => {
    for (const [url, host] of [
        ['https://bitbucket.org/kumaakh/apra-analytics.git', 'bitbucket.org'],
        ['git@bitbucket.org:kumaakh/apra-analytics.git', 'bitbucket.org'],
    ]) {
        const caps = capabilities(url);
        assert.equal(caps.hasRemote, true, url);
        assert.equal(caps.host, host);
        assert.equal(caps.canOpenPullRequest, true, 'Bitbucket provider now has capabilitiesForHost and is PR-capable');
    }
});
